import {env,exports} from 'cloudflare:workers';
import {runInDurableObject,evictDurableObject} from 'cloudflare:test';
import {expect,it} from 'vitest';
import type {Bot,Task,Run} from '@botspace/contracts';
import type {Env} from '../apps/api/src/env';
const bindings=env as unknown as Env;
const auth={authorization:'Bearer test-only-botspace-owner-token-000000','content-type':'application/json'};
async function api(path:string,input?:unknown){const r=await exports.default.fetch(`https://test${path}`,{headers:auth,method:input===undefined?'GET':'POST',...(input===undefined?{}:{body:JSON.stringify(input)})});return {status:r.status,data:await r.json<any>()};}
const legacy='model_request_failed: The model request failed before an answer completed. Your conversation and recorded tool results are preserved.';
async function setup(detail=legacy){
 const {data:{bot}}=await api('/v1/bots',{name:'Legacy recovery',computerApprovalMode:'automatic'});
 const {data:{task}}=await api('/v1/tasks',{botId:bot.id,title:'Existing authorized goal',description:'fixture:model-error-late',operationId:crypto.randomUUID()});
 let source:Run|undefined;
 await expect.poll(async()=>{const {data}=await api(`/v1/tasks/${task.id}/runs`);source=data.runs.find((r:Run)=>!r.subagentId);return source?.status;}).toBe('failed');
 const stub=bindings.BOT.get(bindings.BOT.idFromName(`owner:task:${task.id}`));
 await runInDurableObject(stub,(_,state)=>{
  state.storage.sql.exec('CREATE TABLE pi_tasks(id INTEGER,status TEXT,record TEXT)');
  state.storage.sql.exec('CREATE TABLE pi_submissions(id INTEGER,request_id TEXT,status TEXT,record TEXT)');
  state.storage.sql.exec('CREATE TABLE pi_entries(id INTEGER,record TEXT)');
  const row=state.storage.sql.exec<{native_operation_id:string}>('SELECT native_operation_id FROM runs WHERE id=?',source!.id).one();
  state.storage.sql.exec('INSERT INTO pi_submissions VALUES(1,?,?,?)',JSON.stringify(row.native_operation_id),'unanswered',JSON.stringify({type:'input',reason:'model_error',detail}));
 });
 return {bot:bot as Bot,task:task as Task,source:source!,stub};
}
async function recover(value:Awaited<ReturnType<typeof setup>>,marked=true){const response=await value.stub.fetch('https://task/_recover-legacy-provider',{method:'POST',headers:{'x-botspace-config':encodeURIComponent(JSON.stringify(value.bot)),'x-timber-task-id':value.task.id,...(marked?{'x-timber-internal':'scheduler'}:{})}});return {status:response.status,data:await response.json()};}
it('recovers the old exact provider failure once in the same conversation and preserves the failed receipt',async()=>{
 const value=await setup();
 expect((await recover(value,false)).status).toBe(403);
 expect((await api(`/v1/tasks/${value.task.id}/_recover-legacy-provider`,{})).status).toBe(404);
 expect((await recover(value)).data).toEqual({recovered:true});
 await expect.poll(async()=>{const {data}=await api(`/v1/tasks/${value.task.id}/runs`);return data.runs.find((r:Run)=>r.operationId===`inference-recovery:${value.source.id}`)?.status;}).toBe('completed');
 await evictDurableObject(value.stub);
 expect((await recover(value)).data).toEqual({recovered:false});
 await runInDurableObject(value.stub,(_,state)=>{
  expect(state.storage.sql.exec('SELECT id FROM runs').toArray()).toHaveLength(2);
  expect(JSON.parse(state.storage.sql.exec<{data:string}>('SELECT data FROM runs WHERE id=?',value.source.id).one().data).status).toBe('failed');
  expect(state.storage.sql.exec('SELECT operation_id FROM computer_operations').toArray()).toHaveLength(0);
  expect(state.storage.sql.exec('SELECT source_id FROM legacy_provider_recoveries').toArray()).toHaveLength(1);
 });
});
it.each([`model_request_failed: Provider returned error. ${legacy}`, 'chatgpt_allowance_exhausted: Account quota exceeded.'])('does not reopen a current or permanent failure: %s',async detail=>{
 const value=await setup(detail);expect((await recover(value)).data).toEqual({recovered:false});
 await runInDurableObject(value.stub,(_,state)=>expect(state.storage.sql.exec('SELECT id FROM runs').toArray()).toHaveLength(1));
});
it('does not recover a stopped task',async()=>{
 const value=await setup();expect((await api(`/v1/tasks/${value.task.id}/cancel`,{})).status).toBe(200);
 expect((await recover(value)).data).toEqual({recovered:false});
});
it('a newer accepted user input fences recovery across the settings await',async()=>{
 const value=await setup();
 type Held={currentBot:(refresh?:boolean)=>Promise<Bot>;recoverLegacyProviderFailure:()=>Promise<{recovered:boolean}>;entered:boolean;release:()=>void};
 await runInDurableObject(value.stub,instance=>{
  const target=instance as unknown as Held;const hold=new Promise<void>(r=>{target.release=r;});let first=true;
  target.currentBot=async()=>{if(first){first=false;target.entered=true;await hold;}return value.bot;};
 });
 const pending=runInDurableObject(value.stub,instance=>(instance as unknown as Held).recoverLegacyProviderFailure());
 try{
  await expect.poll(()=>runInDurableObject(value.stub,instance=>(instance as unknown as Held).entered)).toBe(true);
  expect((await api(`/v1/tasks/${value.task.id}/messages`,{operationId:crypto.randomUUID(),text:'A newer accepted goal'})).status).toBe(202);
 }finally{await runInDurableObject(value.stub,instance=>(instance as unknown as Held).release());}
 expect(await pending).toEqual({recovered:false});
 await runInDurableObject(value.stub,(_,state)=>expect(state.storage.sql.exec('SELECT id FROM runs').toArray()).toHaveLength(2));
});
it('does not reopen an old user failure after a later collaborator turn completed the task',async()=>{
 const value=await setup();const next=await api(`/v1/tasks/${value.task.id}/messages`,{operationId:crypto.randomUUID(),text:'The delivered result is verified'});
 await expect.poll(async()=>{const r=await api(`/v1/tasks/${value.task.id}/runs/${next.data.run.id}`);return r.data.run.status;}).toBe('completed');
 await runInDurableObject(value.stub,(_,state)=>state.storage.sql.exec("UPDATE admission_sources SET kind='internal' WHERE run_id=?",next.data.run.id));
 expect((await recover(value)).data).toEqual({recovered:false});
});
