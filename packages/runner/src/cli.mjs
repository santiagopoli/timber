import {homedir,hostname,platform} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {realpathSync} from 'node:fs';
import {credentialStore,newDeviceKey,secureDirectory} from './credentials.mjs';
import {saveConfig,loadConfig} from './config.mjs';
import {workspace} from './workspaces.mjs';
import {DeviceClient} from './device-client.mjs';
import {Runner} from './worker.mjs';
import {control,serveControl} from './control.mjs';
import {RunnerError,publicError} from './errors.mjs';
export const VERSION='0.1.0';
const permissions=['diagnostics','files.read','files.write','host.shell','agent.run'];
function options(argv){const result={};for(let i=0;i<argv.length;i++){if(!argv[i].startsWith('--')||!argv[i+1]||argv[i+1].startsWith('--'))throw new RunnerError('invalid_arguments','Options require a value. See timber-runner help.');const key=argv[i].slice(2);if(!['url','workspace','workspace-id','grant','approval','approvals','name','state-dir'].includes(key))throw new RunnerError('invalid_arguments','Unknown runner option.');result[key]=argv[++i];}return result;}
function grants(value){const requested=value?value.split(','):['diagnostics','files.read'];if(!requested.length||requested.some(item=>!permissions.includes(item)))throw new RunnerError('invalid_grants','Choose diagnostics, files.read, files.write, host.shell or agent.run.');return [...new Set(requested)];}
async function connected(stateDir){const config=await loadConfig(stateDir);if(!config.deviceId||config.disconnected)throw new RunnerError('not_connected','Pair this device before starting the runner.');const key=await credentialStore(stateDir).load(config.keyId);return {config,client:new DeviceClient({url:config.url,id:config.deviceId,privateKey:key})};}
async function run(stateDir,signal){const {config,client}=await connected(stateDir),runner=new Runner({stateDir,config,client});const close=await serveControl(stateDir,{status:()=>({running:true,deviceId:config.deviceId,...runner.journal.stats()}),stop:()=>signal.controller.abort()});
 try{console.log('Timber runner connected. Press Ctrl+C to stop local execution.');await runner.run({signal:signal.controller.signal});}finally{await runner.stop();await close();runner.journal.close();}
}
export async function main(argv=process.argv.slice(2)){
 if(Number(process.versions.node.split('.')[0])<24)throw new RunnerError('node_required','Timber runner requires Node.js 24 or newer.');
 const command=argv[0]??'help',args=options(argv.slice(1)),stateDir=resolve(args['state-dir']??join(homedir(),'.local','share','timber-runner'));await secureDirectory(stateDir);
 if(command==='help'){console.log('timber-runner connect --url https://your-timber-host --workspace /path/to/project [--grant diagnostics,files.read,files.write,host.shell,agent.run] [--approval ask|automatic]\ntimber-runner run | status | disconnect\nNode.js 24+, macOS or Linux. host.shell runs with your full user privileges, without sudo.');return;}
 const controller=new AbortController(),onStop=()=>controller.abort();process.once('SIGINT',onStop);process.once('SIGTERM',onStop);
 try {
  if(command==='connect'){
   if(await control(stateDir,'status'))throw new RunnerError('runner_active','Stop the current runner before pairing another device.');
   const prior=await loadConfig(stateDir).catch(error=>{if(error.code==='not_connected')return null;throw error;});
   if(prior?.deviceId&&!prior.disconnected)throw new RunnerError('already_connected','Use run for this paired device, or disconnect before pairing again.');
   if(!args.url||!args.workspace)throw new RunnerError('invalid_arguments','connect requires --url and --workspace.');
   const caps=grants(args.grant),approvalMode=args.approval??args.approvals??'ask';if(!['automatic','ask'].includes(approvalMode))throw new RunnerError('invalid_approval_mode','Choose automatic or ask approvals.');
   const root={...await workspace(args.workspace,args['workspace-id']??'workspace'),capabilities:caps};
   if(caps.includes('host.shell'))console.log('host.shell permits approved commands with your full user privileges. It is not a folder sandbox and does not invoke sudo.');
   const store=credentialStore(stateDir),keyId=randomUUID(),keys=await newDeviceKey();await store.save(keyId,keys.privateKey);
   const endpoint=new DeviceClient({url:args.url,id:keyId,privateKey:keys.privateKey});
   const response=await fetch(`${endpoint.origin}/v1/device-connect/pairings`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({publicKey:keys.publicKey,name:args.name??hostname(),platform:platform(),version:VERSION,workspaces:[root]}),signal:controller.signal,redirect:'error'});
   if(!response.ok){await response.body?.cancel();await store.remove(keyId);throw new RunnerError('pairing_failed','Timber could not create a device pairing.');}
   const pairing=await response.json();endpoint.id=pairing.pairingId;
   console.log(`Open ${endpoint.origin}/console/#devices and approve pairing code ${pairing.code}. No account key is needed in this terminal.`);
   const config={url:endpoint.origin,keyId,version:VERSION,permissions:caps,approvalMode,workspaces:[root],pairingId:pairing.pairingId};await saveConfig(stateDir,config);
   while(!controller.signal.aborted&&Date.now()<Date.parse(pairing.expiresAt)){
    const poll=await endpoint.request(`/v1/device-connect/pairings/${pairing.pairingId}/poll`,{},{signal:controller.signal});
    if(poll.status==='approved'&&poll.deviceId){config.deviceId=poll.deviceId;delete config.pairingId;await saveConfig(stateDir,config);await run(stateDir,{controller});return;}
    await new Promise(resolve=>setTimeout(resolve,1000));
   }
   throw new RunnerError(controller.signal.aborted?'pairing_cancelled':'pairing_expired',controller.signal.aborted?'Pairing was cancelled.':'Pairing expired; run connect again.');
  }
  if(command==='run'){await run(stateDir,{controller});return;}
  if(command==='status'){const config=await loadConfig(stateDir),live=await control(stateDir,'status');console.log(JSON.stringify({connected:Boolean(config.deviceId&&!config.disconnected),running:Boolean(live?.running),permissions:config.permissions,workspaceIds:config.workspaces.map(item=>item.id),...(live?{activeProcesses:live.processes,unreportedReceipts:live.unreported}:{})}));return;}
  if(command==='disconnect'){
   const {config,client}=await connected(stateDir);await control(stateDir,'stop');let cloud=true;
   try{await client.request(`/v1/device-connect/${config.deviceId}/disconnect`);}catch{cloud=false;}
   await credentialStore(stateDir).remove(config.keyId);config.disconnected=true;await saveConfig(stateDir,config);
   console.log(cloud?'Device disconnected and revoked in Timber.':'Disconnected locally. Timber was unreachable; revoke this device in Devices when online.');return;
  }
  throw new RunnerError('invalid_command','Choose connect, run, status or disconnect.');
 }finally{process.removeListener('SIGINT',onStop);process.removeListener('SIGTERM',onStop);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(realpathSync(process.argv[1])).href){process.umask(0o077);main().catch(error=>{const safe=publicError(error);console.error(`${safe.code}: ${safe.message}`);process.exitCode=1;});}
