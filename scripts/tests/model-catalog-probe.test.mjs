import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import worker,{projection} from '../model-catalog-probe-worker.mjs';
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
