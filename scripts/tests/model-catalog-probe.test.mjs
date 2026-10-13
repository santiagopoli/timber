import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import worker,{projection,queueProjection} from '../model-catalog-probe-worker.mjs';
import {requestProbe} from '../probe-model-catalog.mjs';
const token='a'.repeat(64),hash=createHash('sha256').update(token).digest('hex');

test('probe fails closed before accessing the owner connection',async()=>{
  const env={PROBE_TOKEN_SHA256:hash,CHATGPT:{get(){throw new Error('must not reach owner');}}};
  for(const authorization of [undefined,`Bearer ${'b'.repeat(64)}`,'Bearer short']){
    const result=await worker.fetch(new Request('https://probe.test/catalog',{headers:authorization?{authorization}:{}}),env);
    assert.equal(result.status,401);assert.equal(await result.text(),'');
  }
});
test('probe reads only the fixed owner status and model catalogue and never exposes account metadata',async()=>{
  const calls=[];
  const env={PROBE_TOKEN_SHA256:hash,CHATGPT:{idFromName(name){assert.equal(name,'owner');return name;},get(){return {async fetch(url){calls.push(url);return Response.json(url.endsWith('/models')?{connected:true,models:[{slug:'private-model',secret:'private-canary'}]}:{status:'verified',account:{email:'private-canary'},hostId:'private-canary'});}};}}};
  const result=await worker.fetch(new Request('https://probe.test/catalog',{headers:{authorization:`Bearer ${token}`}}),env);
  assert.equal(result.headers.get('cache-control'),'no-store');assert.deepEqual(await result.json(),{connection:'verified',connected:true,models:1,failure:null});
  assert.deepEqual(calls,['https://chatgpt/','https://chatgpt/models']);
  assert.equal((await worker.fetch(new Request('https://probe.test/other',{headers:{authorization:`Bearer ${token}`}}),env)).status,404);
});
test('probe projects fixed failure labels and suppresses unknown provider prose and thrown exceptions',async()=>{
  assert.deepEqual(projection({status:'private-canary'},{connected:true,models:[],error:'private-canary'}),{connection:'unknown',connected:true,models:0,failure:'catalog_failure_unclassified'});
  assert.equal(projection({status:'verified'},{error:'ChatGPT token renewal failed. The connection was retained; try again later.'}).failure,'chatgpt_refresh_failed');
  const result=await worker.fetch(new Request('https://probe.test/catalog',{headers:{authorization:`Bearer ${token}`}}),{PROBE_TOKEN_SHA256:hash,CHATGPT:{idFromName(){throw new Error('private-canary');}}});
  assert.equal(result.status,502);assert.equal(await result.text(),'{"failure":"catalog_probe_failed"}');
});
test('probe tolerates route propagation but does not retry an authorization rejection',async()=>{
  const statuses=[404,503,200],waits=[],calls=[];
  const response=await requestProbe('https://probe.test/catalog',token,async(url,options)=>{calls.push(options);return new Response(null,{status:statuses.shift()});},async ms=>{waits.push(ms);});
  assert.equal(response.status,200);assert.deepEqual(waits,[2000,2000]);assert.equal(calls.length,3);
  for(const call of calls){assert.equal(call.redirect,'error');assert.equal(call.headers.authorization,`Bearer ${token}`);}
  await assert.rejects(requestProbe('https://probe.test/catalog',token,async()=>new Response(null,{status:401}),()=>{throw new Error('must not retry');}),/probe_http_401/);
});
test('queue projections distinguish model admission failures from computer holders without exposing messages',()=>{
  const value=queueProjection('12345678-1234-1234-1234-123456789012',{activeProcesses:1,pendingCancellations:0,lastMessage:'private-canary'},
    {activeRuns:[{status:'queued',errorCode:'model_catalog_unavailable',error:'private-canary',text:'private-canary'},{status:'private-canary',errorCode:'private-canary'}]},
    {holder:'@direct:private-canary'});
  assert.deepEqual(value,{bot:'12345678',activeProcesses:1,pendingCancellations:0,lease:'owner_action',runs:[{status:'queued',error:'model_catalog_unavailable',coordinator:false},{status:'unknown',error:'other',coordinator:false}]});
  assert.doesNotMatch(JSON.stringify(value),/private-canary/);
});
