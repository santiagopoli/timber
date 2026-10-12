import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {SecureDeployCoordinator,memorySecureDeployJournal,createCloudSecureWorkerDeployProvider,secureDeployCanonical} from '../../packages/computer/src/secure-deploy.ts';

const botId='00000000-0000-4000-8000-000000000002',runId='00000000-0000-4000-8000-000000000003',secretId='00000000-0000-4000-8000-000000000004',planId='00000000-0000-4000-8000-000000000005';
const value='synthetic-only-deploy-canary';
const request=(operationId='deploy-1')=>({operationId,ownerId:'owner',botId,runId,expectedRevision:1,refs:[{id:secretId,revision:7}],pin:{repository:'acme/widget',commit:'a'.repeat(40),artifactDigest:`sha256:${'b'.repeat(64)}`,artifactPath:'dist/worker.js',accountId:'a'.repeat(32),workerName:'widget-prod',destination:`https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}/workers/scripts/widget-prod`,planId,planRevision:1}});
const authorization=r=>({version:1,ownerId:'owner',botId,runId,nativeOperationId:'native-run-op',operationId:r.operationId,pin:r.pin,planId,planRevision:1,refs:[{id:secretId,revision:7,permissionEpoch:'epoch-canary',binding:'opaque-binding'}],expiresAt:Date.now()+60_000,signature:'synthetic-hmac-signature'});
const credentials=[{refId:secretId,revision:7,header:'Authorization',prefix:'Bearer ',value}];
const caps={secureDeploy:true,isolationVersion:'uid-ptrace-v1',privateCredentialChannel:true,noShellEnv:true,noBuildCredentialInheritance:true,outputRedaction:true,canaryVersion:'cross-uid-proc-env-v1',cliVersion:'4.147.0',cliBuildId:'wrangler-4.147.0-timber-no-retry-v1',cliDigest:'sha256:07f2d4392dbaa8944bd2a73dc1bcbef481840fddb65b6e6bd5c697e000163511',noAutomaticRetry:true};
const fingerprint=async canonical=>createHmac('sha256','unit-test-only-deploy-fingerprint-key').update(canonical).digest('hex');
function fakeHost(overrides={}){const calls={capabilities:0,dispatch:[],cancel:[]};return{calls,host:{capabilities:async()=>{calls.capabilities++;return caps},dispatchTrusted:async x=>{calls.dispatch.push(x);return{operationId:x.operationId,status:'completed',code:'deploy_accepted'}},cancel:async id=>{calls.cancel.push(id);return'cancelled'},...overrides}}}
function authority(check=async()=>{}){return{assertCurrent:check,async withAuthorization(r,dispatch){await check(r);return dispatch(authorization(r),credentials,()=>{})}}}
const coordinator=(host,journal=memorySecureDeployJournal(),auth=authority(),max=1)=>new SecureDeployCoordinator(host,auth,journal,max,fingerprint);

test('private ComputerProvider capability probe returns actual canary schema without any credentials',async()=>{
 const calls=[];const binding={idFromName:id=>id,get:id=>({async fetch(req){calls.push({id,path:new URL(req.url).pathname,method:req.method,headers:[...req.headers]});return Response.json(caps)}})};
 const p=createCloudSecureWorkerDeployProvider(binding);assert.deepEqual(await p.capabilities(botId),caps);assert.deepEqual(calls.map(x=>[x.id,x.path,x.method]),[[botId,'/secure-deploy/capabilities','GET']]);assert.equal(JSON.stringify(calls).includes(value),false);
});
test('successful dispatch sends only owner-pinned metadata and ephemeral refs to the dedicated private API',async()=>{
 const f=fakeHost(),journal=memorySecureDeployJournal(),r=await coordinator(f.host,journal).deploy(request());assert.equal(r.state,'completed');assert.deepEqual(f.calls.dispatch[0].credentials,credentials);assert.deepEqual(f.calls.dispatch[0].refs,authorization(request()).refs);assert.equal(f.calls.dispatch[0].pin.artifactPath,'dist/worker.js');assert.equal('output'in r,false);assert.equal(JSON.stringify(await journal.get('deploy-1')).includes(value),false);
});
test('no readiness capability means no credential resolution or dispatch',async()=>{
 const f=fakeHost({capabilities:async()=>({...caps,secureDeploy:false})}),used={n:0},auth={assertCurrent:async()=>{},withAuthorization:async()=>{used.n++;throw Error('must not resolve')}};const r=await coordinator(f.host,memorySecureDeployJournal(),auth).deploy(request());assert.equal(r.state,'failed');assert.equal(r.errorCode,'secure_deploy_host_unsupported');assert.equal(used.n,0);assert.equal(f.calls.dispatch.length,0);
});
test('missing or mismatched CLI integrity/no-retry capabilities reject before credential resolution',async()=>{
 for(const [key,wrong] of [['cliVersion','4.146.0'],['cliBuildId','unpatched-build'],['cliDigest',`sha256:${'0'.repeat(64)}`],['noAutomaticRetry',false]]) {
  for(const missing of [true,false]) {
   const reported={...caps};if(missing)delete reported[key];else reported[key]=wrong;
   const f=fakeHost({capabilities:async()=>reported}),used={n:0},auth={assertCurrent:async()=>{},withAuthorization:async()=>{used.n++;throw Error('must not resolve')}};
   const result=await coordinator(f.host,memorySecureDeployJournal(),auth).deploy(request());
   assert.equal(result.state,'failed',`${key} ${missing?'missing':'mismatched'}`);assert.equal(result.errorCode,'secure_deploy_host_unsupported');assert.equal(used.n,0);assert.equal(f.calls.dispatch.length,0);
  }
 }
});
test('permission/Stop fence after a capability await prevents dispatch',async()=>{
 const f=fakeHost();let checks=0;const auth=authority(async()=>{if(++checks===3)throw Object.assign(Error('stopped'),{code:'deploy_authorization_changed'})});const r=await coordinator(f.host,memorySecureDeployJournal(),auth).deploy(request());assert.equal(r.state,'failed');assert.equal(f.calls.dispatch.length,0);
});
test('transport uncertainty never retries and never journals credential/provider output',async()=>{
 const f=fakeHost({dispatchTrusted:async x=>{f.calls.dispatch.push(x);throw Error(`private=${value}`)}}),journal=memorySecureDeployJournal(),c=coordinator(f.host,journal);const first=await c.deploy(request()),second=await c.deploy(request());assert.equal(first.state,'uncertain');assert.equal(second.state,'uncertain');assert.equal(f.calls.dispatch.length,1);assert.equal(JSON.stringify(await journal.get('deploy-1')).includes(value),false);
});
test('duplicate operation with different immutable pin conflicts without another dispatch',async()=>{
 const f=fakeHost(),c=coordinator(f.host,memorySecureDeployJournal());await c.deploy(request());const secondPin={...request().pin,workerName:'other',destination:`https://api.cloudflare.com/client/v4/accounts/${request().pin.accountId}/workers/scripts/other`};const second=await c.deploy({...request(),pin:secondPin});assert.equal(second.errorCode,'deploy_idempotency_conflict');assert.equal(f.calls.dispatch.length,1);
});
test('bounded synchronous admission rejects concurrent work and cancellation prevents a later dispatch',async()=>{
 let release;const gate=new Promise(resolve=>release=resolve),f=fakeHost({capabilities:async()=>{await gate;return caps}}),c=coordinator(f.host,memorySecureDeployJournal(),authority(),1),first=c.deploy(request());await new Promise(resolve=>setImmediate(resolve));await assert.rejects(c.deploy(request('deploy-2')),e=>e.code==='deploy_admission_full');assert.equal(await c.cancel('deploy-1'),'cancelled');release();assert.equal((await first).state,'cancelled');assert.equal(f.calls.dispatch.length,0);
});
test('dedicated Computer route is exact, strips signal from JSON and returns only fixed receipt',async()=>{
 const calls=[];const binding={idFromName:id=>id,get:id=>({async fetch(req){const body=req.method==='POST'?await req.json():undefined;calls.push({id,path:new URL(req.url).pathname,method:req.method,body,redirect:req.redirect});return Response.json({operationId:'deploy-1',status:'completed',code:'deploy_accepted'})}})};const p=createCloudSecureWorkerDeployProvider(binding),input={operationId:'deploy-1',authorization:authorization(request()),pin:request().pin,refs:authorization(request()).refs,credentials,signal:new AbortController().signal};const receipt=await p.dispatch(botId,input);assert.deepEqual(receipt,{operationId:'deploy-1',status:'completed',code:'deploy_accepted'});assert.deepEqual(calls.map(x=>x.path),['/secure-deploy']);assert.equal('signal'in calls[0].body,false);assert.equal(calls[0].body.credentials[0].value,value);assert.equal(calls[0].redirect,'manual');
});
test('invalid paths/targets fail before transport and canonical fingerprint binds artifact path',async()=>{
 const f=fakeHost(),c=coordinator(f.host);for(const pin of [{...request().pin,artifactPath:'../worker.js'},{...request().pin,artifactPath:'/tmp/worker.js'},{...request().pin,destination:'https://attacker.invalid'}])await assert.rejects(c.deploy({...request(),pin}),e=>e.code==='deploy_invalid_pin');assert.equal(f.calls.dispatch.length,0);assert.notEqual(secureDeployCanonical(request()),secureDeployCanonical({...request(),pin:{...request().pin,artifactPath:'release/worker.js'}}));
});


test('durable reservation across coordinator instances prevents concurrent duplicate dispatch',async()=>{
 let release;const gate=new Promise(resolve=>release=resolve),f=fakeHost({capabilities:async()=>{await gate;return caps}}),journal=memorySecureDeployJournal(),a=coordinator(f.host,journal),b=coordinator(f.host,journal);const first=a.deploy(request());await new Promise(resolve=>setImmediate(resolve));const second=await b.deploy(request());assert.equal(second.state,'uncertain');release();assert.equal((await first).state,'completed');assert.equal(f.calls.dispatch.length,1);
});
test('frozen owner plan cannot be retargeted by caller mutation after an await',async()=>{
 let release;const gate=new Promise(resolve=>release=resolve),f=fakeHost({capabilities:async()=>{await gate;return caps}}),input=request(),c=coordinator(f.host);const pending=c.deploy(input);await new Promise(resolve=>setImmediate(resolve));input.pin.artifactPath='attacker.js';input.pin.workerName='stolen';input.refs[0].id='00000000-0000-4000-8000-000000000099';release();const result=await pending;assert.equal(result.state,'completed');assert.equal(f.calls.dispatch[0].pin.artifactPath,'dist/worker.js');assert.equal(f.calls.dispatch[0].pin.workerName,'widget-prod');assert.equal(f.calls.dispatch[0].refs[0].id,secretId);
});
test('recovery of in-flight journal reservation returns uncertain and does not redispatch',async()=>{
 const f=fakeHost(),journal=memorySecureDeployJournal(),first=coordinator(f.host,journal);await first.deploy(request());const before=f.calls.dispatch.length;
 const lost=request('lost-op'),fp=await fingerprint(secureDeployCanonical(lost));
 await journal.reserve('lost-op',fp);await journal.put({operationId:'lost-op',fingerprint:fp,state:'dispatching',pin:lost.pin});const recovery=coordinator(f.host,journal);const result=await recovery.deploy(lost);assert.equal(result.state,'uncertain');assert.equal(f.calls.dispatch.length,before);
});
test('final owner authorization callback fence is immediately before dispatch',async()=>{
 const f=fakeHost();let checked=false;const auth={assertCurrent:async()=>{},withAuthorization:async(r,dispatch)=>dispatch(authorization(r),credentials,()=>{checked=true;throw Object.assign(Error('stopped at final fence'),{code:'deploy_authorization_changed'})})};const result=await coordinator(f.host,memorySecureDeployJournal(),auth).deploy(request());assert.equal(checked,true);assert.equal(result.state,'failed');assert.equal(result.errorCode,'deploy_authorization_changed');assert.equal(f.calls.dispatch.length,0);
});
test('malicious host stdout/extra fields never appear in response or durable journal',async()=>{
 const journal=memorySecureDeployJournal(),f=fakeHost({dispatchTrusted:async x=>{f.calls.dispatch.push(x);return{operationId:x.operationId,status:'completed',code:'deploy_accepted',output:value,stderr:value,credential:value}}}),result=await coordinator(f.host,journal).deploy(request());assert.equal(result.state,'completed');assert.equal('output'in result,false);assert.equal(JSON.stringify(result).includes(value),false);assert.equal(JSON.stringify(await journal.get('deploy-1')).includes(value),false);
});
test('cancellation after dispatch asks Computer to terminate and reports uncertain without replay',async()=>{
 let release;const gate=new Promise(resolve=>release=resolve),f=fakeHost({dispatchTrusted:async x=>{f.calls.dispatch.push(x);await gate;return{operationId:x.operationId,status:'completed',code:'deploy_accepted'}}}),journal=memorySecureDeployJournal(),c=coordinator(f.host,journal);const pending=c.deploy(request());for(let i=0;i<100&&f.calls.dispatch.length===0;i++)await new Promise(resolve=>setImmediate(resolve));assert.equal(await c.cancel('deploy-1'),'cancelled');release();assert.equal((await pending).state,'uncertain');assert.deepEqual(f.calls.cancel,['deploy-1']);assert.equal((await c.deploy(request())).state,'uncertain');assert.equal(f.calls.dispatch.length,1);
});
