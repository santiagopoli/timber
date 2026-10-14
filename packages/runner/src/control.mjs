import {createServer,createConnection} from 'node:net';
import {join} from 'node:path';
import {lstat,unlink,chmod} from 'node:fs/promises';
import {RunnerError} from './errors.mjs';
export async function control(stateDir,command){
 const path=join(stateDir,'runner.sock');try{const stat=await lstat(path);if(!stat.isSocket()||(stat.mode&0o077)!==0||process.getuid&&stat.uid!==process.getuid())throw new RunnerError('unsafe_control','The runner control socket is not private.');}catch(error){if(error.code==='ENOENT')return null;throw error;}
 return new Promise((resolve,reject)=>{const socket=createConnection(path);let response='';socket.setTimeout(3000,()=>{socket.destroy();resolve(null);});socket.on('connect',()=>socket.end(`${command}\n`));socket.on('data',chunk=>{response+=chunk.toString();if(response.length>4096)socket.destroy();});socket.on('error',error=>['ECONNREFUSED','ENOENT'].includes(error.code)?resolve(null):reject(new RunnerError('control_failed','Could not reach the local runner.')));socket.on('end',()=>{try{resolve(JSON.parse(response));}catch{resolve(null);}});});
}
export async function serveControl(stateDir,{status,stop}){
 const path=join(stateDir,'runner.sock');if(await control(stateDir,'status'))throw new RunnerError('runner_active','A runner is already active for this device.');
 await unlink(path).catch(error=>{if(error.code!=='ENOENT')throw error;});
 const server=createServer(socket=>{let input='';socket.on('data',chunk=>{input+=chunk.toString();if(input.length>128)socket.destroy();});socket.on('end',()=>{if(input.trim()==='stop'){stop();socket.end(JSON.stringify({stopping:true}));}else if(input.trim()==='status')socket.end(JSON.stringify(status()));else socket.end(JSON.stringify({error:'unknown_command'}));});});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(path,resolve);});await chmod(path,0o600);
 return async()=>{await new Promise(resolve=>server.close(resolve));await unlink(path).catch(()=>{});};
}
