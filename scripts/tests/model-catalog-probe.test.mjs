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
  assert.deepEqual(projection({status:'verified'},{connected:true,models:[],error:'ChatGPT model catalogue unavailable (HTTP 403; model_access_denied). private-canary'}),{connection:'verified',connected:true,models:0,failure:'model_access_denied',upstreamStatus:403});
  assert.deepEqual(projection({status:'verified'},{connected:true,models:[{}],warning:'Using cached ChatGPT model catalogue (HTTP 520; model_provider_unavailable).'}),{connection:'verified',connected:true,models:1,failure:'model_provider_unavailable',cached:true,upstreamStatus:520});
  const result=await worker.fetch(new Request('https://probe.test/catalog',{headers:{authorization:`Bearer ${token}`}}),{PROBE_TOKEN_SHA256:hash,CHATGPT:{idFromName(){throw new Error('private-canary');}}});
  assert.equal(result.status,502);assert.equal(await result.text(),'{"failure":"catalog_probe_failed"}');
});
test('optional inference verification uses only the fixed plan verification route and hides model and provider prose',async()=>{
  const env={PROBE_TOKEN_SHA256:hash,CHATGPT:{idFromName(name){assert.equal(name,'owner');return name;},get(){return {async fetch(url,options){assert.equal(url,'https://chatgpt/verify');assert.equal(options.method,'POST');return Response.json({ok:true,model:'private-canary'});}};}}};
  const result=await worker.fetch(new Request('https://probe.test/verify',{method:'POST',headers:{authorization:`Bearer ${token}`}}),env);
  assert.deepEqual(await result.json(),{ok:true,status:200,failure:null});
  assert.equal((await worker.fetch(new Request('https://probe.test/verify',{headers:{authorization:`Bearer ${token}`}}),env)).status,404);
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
test('queue probe uses passive registry and bot routes with scheduler headers',async()=>{
  const id='12345678-1234-1234-1234-123456789012',calls=[];
  const workspace={async fetch(url){calls.push(url);if(url==='https://workspace/')return Response.json({bots:[{id,instructions:'private-canary'}]});assert.equal(url,`https://workspace/tasks/bot-slot/${id}`);return Response.json({holder:'@bot'});}};
  const env={PROBE_TOKEN_SHA256:hash,WORKSPACE:{idFromName(name){assert.equal(name,'owner');return name;},get(){return workspace;}},BOT:{idFromName(name){assert.equal(name,`owner:${id}`);return name;},get(){return {async fetch(request){assert.equal(request.method,'GET');assert.equal(request.headers.get('x-timber-internal'),'scheduler');calls.push(request.url);return Response.json(request.url.endsWith('/summary')?{summary:{activeProcesses:0,pendingCancellations:0,lastMessage:'private-canary'}}:{activeRuns:[{status:'queued',errorCode:'model_catalog_unavailable',text:'private-canary'}]});}};}}};
  const result=await worker.fetch(new Request('https://probe.test/queue',{headers:{authorization:`Bearer ${token}`}}),env);
  assert.equal(result.status,200);assert.deepEqual(await result.json(),{bots:[{bot:'12345678',activeProcesses:0,pendingCancellations:0,lease:'bot',runs:[{status:'queued',error:'model_catalog_unavailable',coordinator:false}]}]});
  assert.deepEqual(calls,['https://workspace/','https://bot/summary','https://bot/runs',`https://workspace/tasks/bot-slot/${id}`]);
});
test('queue probe inspects the exact holding task without copying its title or conversation',async()=>{
  const id='12345678-1234-1234-1234-123456789012',taskId='87654321-1234-1234-1234-123456789012',calls=[];
  const env={PROBE_TOKEN_SHA256:hash,WORKSPACE:{idFromName(){return 'owner';},get(){return {async fetch(url){
    if(url==='https://workspace/')return Response.json({bots:[{id,allowTaskCreation:true,instructions:'private-canary'}]});
    if(url.includes('/tasks/bot-slot/'))return Response.json({holder:taskId});
    assert.equal(url,`https://workspace/tasks/${taskId}`);return Response.json({task:{id:taskId,botId:id,status:'completed',title:'private-canary',computerMode:'shared'}});
  }};}},BOT:{idFromName(name){calls.push(name);return name;},get(name){return {async fetch(request){
    if(name.includes('task:'))assert.equal(request.headers.get('x-timber-task-id'),taskId);
    return Response.json(request.url.endsWith('/summary')?{summary:{activeProcesses:name.includes('task:')?1:0,pendingCancellations:0}}:{activeRuns:[]});
  }};}}};
  const result=await worker.fetch(new Request('https://probe.test/queue',{headers:{authorization:`Bearer ${token}`}}),env);
  const value=await result.json();
  assert.deepEqual(value.bots[0].holdingTask,{status:'completed',computer:'shared',activeProcesses:1,pendingCancellations:0,runs:[]});
  assert.equal(value.bots[0].coordinatorEnabled,true);
  assert.deepEqual(calls,[`owner:${id}`,`owner:task:${taskId}`]);assert.doesNotMatch(JSON.stringify(value),/private-canary/);
});
