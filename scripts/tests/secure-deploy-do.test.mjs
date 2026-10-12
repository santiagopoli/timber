import test from 'node:test';
import assert from 'node:assert/strict';
import {secureDeployComputerRoute} from '../../packages/computer/src/secure-deploy-do.ts';

const botId='00000000-0000-4000-8000-000000000002',runId='00000000-0000-4000-8000-000000000003',secretId='00000000-0000-4000-8000-000000000004',planId='00000000-0000-4000-8000-000000000005';
const secretValue='synthetic-private-canary-value';
const capabilities={secureDeploy:true,isolationVersion:'uid-ptrace-v1',privateCredentialChannel:true,noShellEnv:true,noBuildCredentialInheritance:true,outputRedaction:true,canaryVersion:'cross-uid-proc-env-v1',cliVersion:'4.147.0',cliBuildId:'wrangler-4.147.0-timber-no-retry-v1',cliDigest:'sha256:07f2d4392dbaa8944bd2a73dc1bcbef481840fddb65b6e6bd5c697e000163511',noAutomaticRetry:true};
const pin={repository:'acme/widget',commit:'a'.repeat(40),artifactDigest:`sha256:${'b'.repeat(64)}`,artifactPath:'dist/worker.js',accountId:'c'.repeat(32),workerName:'widget-prod',destination:`https://api.cloudflare.com/client/v4/accounts/${'c'.repeat(32)}/workers/scripts/widget-prod`};
const operationId='deploy-route-1';
function authorization(extra={}){return{version:1,ownerId:'owner',botId,runId,nativeOperationId:'native-op-1',operationId,pin:{...pin,planId,planRevision:1},planId,planRevision:1,refs:[{id:secretId,revision:7,permissionEpoch:'permission-epoch',binding:'opaque-binding-value-long-enough'}],expiresAt:Date.now()+50_000,signature:'synthetic-signature-value-long-enough',...extra}}
function deployBody(overrides={}){const auth=authorization();return{operationId,authorization:auth,pin:{...pin},refs:auth.refs,credentials:[{refId:secretId,revision:7,header:'Authorization',prefix:'Bearer ',value:secretValue}],...overrides}}
function makeComputer({registered=true,verifierStatus=200,ensureError=false,onVerify=()=>{},running:initiallyRunning=false,reportedCapabilities=capabilities}={}){
 const state=new Map(),events=[],paths=[],received=[];let running=initiallyRunning;
 const storage={async get(k){return state.get(k)},async put(k,v){state.set(k,v)},async transaction(fn){return fn({get:async k=>state.get(k),put:async(k,v)=>state.set(k,v)})}};
 const workspace={idFromName:name=>name,get:()=>({async fetch(request){const url=new URL(request.url);events.push(url.pathname==='/'+botId?'registry':'verify');if(url.pathname!=='/'+botId)onVerify();if(url.pathname==='/'+botId)return registered?Response.json({bot:{id:botId}}):new Response('',{status:404});return new Response(verifierStatus===200?'{}':'', {status:verifierStatus});}})};
 const computer={ctx:{storage},env:{WORKSPACE:workspace},container:{get running(){return running}},active(){},async ensureReady(id){events.push('ensure-start');assert.equal(id,botId);if(ensureError)throw new Error('startup failed');running=true;events.push('ensure-ready')},async call(path,init={}){paths.push(path);events.push(path);if(path==='/secure-deploy/capabilities'){assert.equal(running,true);return Response.json(reportedCapabilities)}if(path==='/secure-deploy'){const body=JSON.parse(init.body);received.push(body);return Response.json({operationId:body.operationId,status:'completed',code:'deploy_accepted'})}if(path==='/secure-deploy/cancel'){return Response.json({operationId:JSON.parse(init.body).operationId,result:'cancelled'})}throw new Error('unexpected private path')}};
 return{computer,state,events,paths,received,get running(){return running}};
}
function request(path,body,method=body===undefined?'GET':'POST'){return new Request(`https://computer.internal${path}`,{method,headers:{'x-timber-bot-id':botId,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})})}

test('cold capability probe verifies owner registry, restores scoped workspace, then runs private canary before any credentials exist',async()=>{
 const f=makeComputer();const response=await secureDeployComputerRoute(f.computer,request('/secure-deploy/capabilities'),'/secure-deploy/capabilities');const result=await response.json();
 assert.equal(result.secureDeploy,true);assert.deepEqual(f.events,['registry','ensure-start','ensure-ready','registry','/secure-deploy/capabilities']);assert.equal(f.state.get('botId'),botId);assert.deepEqual(f.paths,['/secure-deploy/capabilities']);assert.equal(JSON.stringify(result).includes(secretValue),false);
});
test('cold capability refuses missing or mismatched CLI pins and no-retry proof without private dispatch',async()=>{
 for(const [key,wrong] of [['cliVersion','4.146.0'],['cliBuildId','unpatched-build'],['cliDigest',`sha256:${'0'.repeat(64)}`],['noAutomaticRetry',false]]) {
  for(const missing of [true,false]) {
   const reportedCapabilities={...capabilities};if(missing)delete reportedCapabilities[key];else reportedCapabilities[key]=wrong;
   const f=makeComputer({reportedCapabilities});const response=await secureDeployComputerRoute(f.computer,request('/secure-deploy/capabilities'),'/secure-deploy/capabilities');
   assert.equal((await response.json()).secureDeploy,false,`${key} ${missing?'missing':'mismatched'}`);assert.deepEqual(f.paths,['/secure-deploy/capabilities']);assert.deepEqual(f.received,[]);
  }
 }
});
test('cold capability fails closed without an owner-registry bot and does not start arbitrary ComputerDO',async()=>{
 const f=makeComputer({registered:false});const response=await secureDeployComputerRoute(f.computer,request('/secure-deploy/capabilities'),'/secure-deploy/capabilities');assert.equal((await response.json()).secureDeploy,false);assert.deepEqual(f.events,['registry']);assert.equal(f.state.has('botId'),false);assert.deepEqual(f.paths,[]);
});
test('cold capability fails closed when workspace service binding is absent',async()=>{
 const f=makeComputer();delete f.computer.env.WORKSPACE;const response=await secureDeployComputerRoute(f.computer,request('/secure-deploy/capabilities'),'/secure-deploy/capabilities');assert.equal((await response.json()).secureDeploy,false);assert.equal(f.events.length,0);assert.equal(f.state.has('botId'),false);
});
test('saved ComputerDO ownership mismatch is rejected before cold startup',async()=>{
 const f=makeComputer();f.state.set('botId','another-bot');const response=await secureDeployComputerRoute(f.computer,request('/secure-deploy/capabilities'),'/secure-deploy/capabilities');assert.equal((await response.json()).secureDeploy,false);assert.deepEqual(f.events,['registry']);assert.deepEqual(f.paths,[]);
});
test('private dispatch waits for restored workspace and fresh owner/run/reference verifier before one private call',async()=>{
 const f=makeComputer();await secureDeployComputerRoute(f.computer,request('/secure-deploy/capabilities'),'/secure-deploy/capabilities');f.events.length=0;
 const response=await secureDeployComputerRoute(f.computer,request('/secure-deploy',deployBody()),'/secure-deploy');const receipt=await response.json();assert.deepEqual(receipt,{operationId,status:'completed',code:'deploy_accepted'});assert.deepEqual(f.events,['ensure-start','ensure-ready','verify','/secure-deploy']);assert.equal(f.received.length,1);assert.equal(f.received[0].credentials[0].value,secretValue);assert.deepEqual(f.paths,['/secure-deploy/capabilities','/secure-deploy']);assert.equal(f.paths.includes('/actions'),false);
});
test('authorization expiry is checked both before awaits and at the final verifier fence',async()=>{
 const expired=makeComputer(),stale=deployBody();expired.state.set('botId',botId);stale.authorization.expiresAt=Date.now()-1;const expiredResponse=await secureDeployComputerRoute(expired.computer,request('/secure-deploy',stale),'/secure-deploy');assert.equal((await expiredResponse.json()).code,'invalid_authorization');assert.deepEqual(expired.paths,[]);assert.deepEqual(expired.events,[]);
 let now=1_000_000;const originalNow=Date.now;Date.now=()=>now;try{const body=deployBody();body.authorization.expiresAt=now+100;const afterAwait=makeComputer({onVerify:()=>{now=body.authorization.expiresAt+1}});afterAwait.state.set('botId',botId);const response=await secureDeployComputerRoute(afterAwait.computer,request('/secure-deploy',body),'/secure-deploy');assert.equal((await response.json()).code,'invalid_authorization');assert.deepEqual(afterAwait.events,['ensure-start','ensure-ready','verify']);assert.deepEqual(afterAwait.paths,[]);assert.deepEqual(afterAwait.received,[])}finally{Date.now=originalNow}
});
test('Stop, permission revocation and signature mismatch from awaited verifier never reach private runner',async()=>{
 for(const label of ['stop','permission-revoked','signature-mismatch']){const f=makeComputer({verifierStatus:409});await secureDeployComputerRoute(f.computer,request('/secure-deploy/capabilities'),'/secure-deploy/capabilities');f.events.length=0;const response=await secureDeployComputerRoute(f.computer,request('/secure-deploy',deployBody()),'/secure-deploy');const receipt=await response.json();assert.equal(receipt.status,'rejected',label);assert.equal(receipt.code,'invalid_authorization',label);assert.deepEqual(f.events,['ensure-start','ensure-ready','verify'],label);assert.deepEqual(f.paths,['/secure-deploy/capabilities'],label);assert.deepEqual(f.received,[],label)}
});
test('invalid destination/path schema is rejected before startup or private invocation',async()=>{
 const f=makeComputer(),body=deployBody();f.state.set('botId',botId);body.pin.destination='https://attacker.invalid/write';const response=await secureDeployComputerRoute(f.computer,request('/secure-deploy',body),'/secure-deploy');assert.equal((await response.json()).code,'invalid_pin');assert.deepEqual(f.events,[]);assert.deepEqual(f.paths,[]);
});
test('cancel is scoped to operation ID and returns only a fixed result without generic actions',async()=>{
 const f=makeComputer({running:true});f.state.set('botId',botId);const response=await secureDeployComputerRoute(f.computer,request('/secure-deploy/cancel',{operationId}),'/secure-deploy/cancel');assert.deepEqual(await response.json(),{operationId,result:'cancelled'});assert.deepEqual(f.paths,['/secure-deploy/cancel']);assert.equal(f.paths.includes('/actions'),false);
});
