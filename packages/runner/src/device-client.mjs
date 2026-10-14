import {deviceProofHeaders} from '../../contracts/src/devices.ts';
import {RunnerError} from './errors.mjs';
export class DeviceClient {
 constructor({url,id,privateKey,fetchImpl=fetch}){const endpoint=new URL(url);if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password||endpoint.search||endpoint.hash)throw new RunnerError('invalid_endpoint','Device connections require an HTTPS URL without credentials or query parameters.');this.origin=endpoint.origin;this.id=id;this.privateKey=privateKey;this.fetch=fetchImpl;}
 async request(path,body={},options={}){
  if(!path.startsWith('/v1/device-connect/')||path.includes('..'))throw new RunnerError('invalid_route','The runner only calls device-scoped service routes.');
  const encoded=JSON.stringify(body),headers=await deviceProofHeaders(this.privateKey,{method:'POST',path,id:this.id,body:encoded});
  const signal=options.signal??AbortSignal.timeout(options.timeoutMs??(options.raw?1800000:60000));
  let response;try{response=await this.fetch(`${this.origin}${path}`,{method:'POST',headers:{...headers,'content-type':'application/json'},body:encoded,signal,redirect:'error'});}catch{throw new RunnerError('offline','The runner could not reach Timber. Recorded work is retained locally.');}
  if(!response.ok){let code;try{code=(await response.json()).error?.code;}catch{}
   throw new RunnerError(response.status===403?(code==='device_grant_revoked'?'permission_denied':'device_revoked'):'service_unavailable',response.status===403?'Device access was denied or revoked.':'Timber could not accept this device request.');}
  return options.raw?response:response.json();
 }
}
