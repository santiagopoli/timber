import {env,exports} from 'cloudflare:workers';
import {evictDurableObject,runDurableObjectAlarm,runInDurableObject} from 'cloudflare:test';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import type {Bot,Task,Run,Approval} from '@botspace/contracts';
import type {Env} from '../apps/api/src/env';
import {computerName,computerHeaders} from '@botspace/computer';
import {computerFixtureControl} from './fixtures/worker';
const bindings=env as unknown as Env&{REAL_COMPUTER:DurableObjectNamespace};
async function api<T>(path:string,input?:unknown){
 const response=await exports.default.fetch(`https://timber.test${path}`,{method:input===undefined?'GET':'POST',headers:{authorization:'Bearer test-only-botspace-owner-token-000000','content-type':'application/json'},...(input===undefined?{}:{body:JSON.stringify(input)})});
 const data=await response.json<T>();expect(response.ok).toBe(true);return data;
}
const registry=()=>bindings.WORKSPACE.get(bindings.WORKSPACE.idFromName('owner'));
const conversation=(id:string)=>bindings.BOT.get(bindings.BOT.idFromName(`owner:task:${id}`));
async function bot(){return (await api<{bot:Bot}>('/v1/bots',{name:'Parallel worker',allowTaskCreation:true})).bot;}
async function task(owner:Bot,startImmediately=true,description='fixture:approval'){return (await api<{task:Task}>('/v1/tasks',{operationId:crypto.randomUUID(),title:'Independent work',description,botId:owner.id,startImmediately})).task;}
async function settled(id:string,status:string){await expect.poll(async()=> (await api<{runs:Run[]}>(`/v1/tasks/${id}/runs`)).runs.some(run=>run.status===status)).toBe(true);}
async function tick(){expect(await runDurableObjectAlarm(registry())).toBe(true);}
beforeEach(()=>{computerFixtureControl.isolatedTasks=true;});
afterEach(()=>{delete computerFixtureControl.isolatedTasks;delete computerFixtureControl.execSession;});
describe('independent persistent task computers',()=>{
 it('releases an idle legacy bot lease and starts its queued task while avatar inference is held',async()=>{
  delete computerFixtureControl.isolatedTasks;
  const owner=await bot(),queued=await task(owner,false);
  await runInDurableObject(registry(),async(instance,state)=>{
   const saved=state.storage.sql.exec<{data:string}>('SELECT data FROM tasks WHERE id=?',queued.id).one();
   const value=JSON.parse(saved.data);value.status='queued';value.startImmediately=true;
   state.storage.sql.exec('UPDATE tasks SET data=? WHERE id=?',JSON.stringify(value),queued.id);
   state.storage.sql.exec("INSERT INTO task_slots(bot_id,task_id,token,generation,updated_at) VALUES(?,'@bot',?,1,0)",owner.id,crypto.randomUUID());
   const avatars=(instance as unknown as {avatars:{alarm():Promise<void>}}).avatars;
   const original=avatars.alarm.bind(avatars);
   let release!:()=>void;
   let avatarDispatches=0;
   const held=new Promise<void>(resolve=>{release=resolve;});avatars.alarm=()=>{avatarDispatches++;return held;};
   try {
    const returned=await Promise.race([Promise.resolve(instance.alarm!()).then(()=>true),new Promise<boolean>(resolve=>setTimeout(()=>resolve(false),1000))]);
    expect(returned).toBe(true);
    expect(state.storage.sql.exec<{task_id:string}>('SELECT task_id FROM task_slots WHERE bot_id=?',owner.id).one().task_id).toBe(queued.id);
    await Promise.resolve(instance.alarm!());
    expect(avatarDispatches).toBe(1);
   } finally {release();avatars.alarm=original;}
  });
  await settled(queued.id,'waiting_approval');
 },60000);
 it('runs two tasks alongside their named bot and cancels only the selected task process',async()=>{
  const owner=await bot();
  const main=await api<{run:Run}>(`/v1/bots/${owner.id}/messages`,{operationId:crypto.randomUUID(),text:'fixture:approval'});
  const first=await task(owner),second=await task(owner);
  expect(first.computerMode).toBe('isolated');expect(second.computerMode).toBe('isolated');
  await settled(first.id,'waiting_approval');await settled(second.id,'waiting_approval');
  await runInDurableObject(registry(),(_,state)=>{
   expect(state.storage.sql.exec<{bot_id:string}>('SELECT bot_id FROM task_slots WHERE task_id IN (?,?)',first.id,second.id).toArray().map(row=>row.bot_id).sort()).toEqual([computerName(owner.id,first.id),computerName(owner.id,second.id)].sort());
   expect(state.storage.sql.exec<{task_id:string}>('SELECT task_id FROM task_slots WHERE bot_id=?',owner.id).one().task_id).toBe('@bot');
  });
  const {approvals}=await api<{approvals:Approval[]}>(`/v1/tasks/${first.id}/approvals`);
  computerFixtureControl.execSession={pollsBeforeComplete:100};
  await api(`/v1/tasks/${first.id}/approvals/${approvals[0].id}`,{decision:'approve'});
  await settled(first.id,'completed');await api(`/v1/tasks/${first.id}/cancel`,{});await tick();
  expect((await api<{run:Run}>(`/v1/bots/${owner.id}/runs/${main.run.id}`)).run.status).toBe('waiting_approval');
  await settled(second.id,'waiting_approval');
  const scope=bindings.COMPUTER.get(bindings.COMPUTER.idFromName(computerName(owner.id,first.id)));
  await runInDurableObject(scope,(_,state)=>expect(state.storage.sql.exec("SELECT 1 FROM exec_sessions WHERE json_extract(result,'$.status')='running'").toArray()).toHaveLength(0));
  await runInDurableObject(bindings.COMPUTER.get(bindings.COMPUTER.idFromName(owner.id)),(_,state)=>expect(state.storage.sql.exec('SELECT 1 FROM effects').toArray()).toHaveLength(0));
  expect((await api<{task:Task}>(`/v1/tasks/${second.id}`)).task.status).toBe('waiting_approval');
 },60000);
 it('migrates never-started queued work, retains its inbox, and keeps the running legacy task on its computer',async()=>{
  delete computerFixtureControl.isolatedTasks;
  const owner=await bot(),legacy=await task(owner),queued=await task(owner);
  await settled(legacy.id,'waiting_approval');expect(queued.status).toBe('queued');
  const message=crypto.randomUUID();await api(`/v1/tasks/${queued.id}/messages`,{operationId:message,text:'Additional queued instructions'});
  computerFixtureControl.isolatedTasks=true;await evictDurableObject(conversation(queued.id));await evictDurableObject(registry());await tick();
  await settled(queued.id,'waiting_approval');
  expect((await api<{task:Task}>(`/v1/tasks/${queued.id}`)).task.computerMode).toBe('isolated');
  expect((await api<{task:Task}>(`/v1/tasks/${legacy.id}`)).task.computerMode).toBe('shared');
  await runInDurableObject(registry(),(_,state)=>{
   expect(state.storage.sql.exec<{task_id:string}>('SELECT task_id FROM task_slots WHERE bot_id=?',owner.id).one().task_id).toBe(legacy.id);
   expect(state.storage.sql.exec<{task_id:string}>('SELECT task_id FROM task_slots WHERE bot_id=?',computerName(owner.id,queued.id)).one().task_id).toBe(queued.id);
  });
  expect((await api<{messages:Array<{text:string}>}>(`/v1/tasks/${queued.id}/messages`)).messages.some(m=>m.text==='Additional queued instructions')).toBe(true);
 },60000);
 it('recovers a lost isolation preparation receipt without admitting shared work',async()=>{
  delete computerFixtureControl.isolatedTasks;
  const owner=await bot(),legacy=await task(owner),queued=await task(owner);
  await settled(legacy.id,'waiting_approval');
  const prepared=await conversation(queued.id).fetch('https://task/task-isolate',{method:'POST',headers:{'x-timber-internal':'scheduler','x-timber-task-id':queued.id,'x-botspace-config':encodeURIComponent(JSON.stringify(owner))}});
  expect(await prepared.json()).toEqual({isolated:true});
  await runInDurableObject(registry(),(instance,state)=>{
   state.storage.sql.exec('INSERT INTO task_isolation_migrations(task_id,bot_id) VALUES(?,?)',queued.id,owner.id);
   expect(()=> (instance as unknown as {beginComputerAdmission(botId:string,taskId:string,op:string):string}).beginComputerAdmission(owner.id,queued.id,`task-start:${queued.id}`)).toThrow();
  });
  computerFixtureControl.isolatedTasks=true;
  await evictDurableObject(conversation(queued.id));await evictDurableObject(registry());await tick();
  await settled(queued.id,'waiting_approval');await settled(legacy.id,'waiting_approval');
  expect((await api<{runs:Run[]}>(`/v1/tasks/${queued.id}/runs`)).runs).toHaveLength(1);
  expect((await api<{task:Task}>(`/v1/tasks/${queued.id}`)).task.computerMode).toBe('isolated');
  await runInDurableObject(registry(),(_,state)=>expect(state.storage.sql.exec('SELECT 1 FROM task_isolation_migrations WHERE task_id=?',queued.id).toArray()).toHaveLength(0));
 },60000);
 it('recovers a lost start receipt in one task without changing its sibling lease',async()=>{
  const owner=await bot(),first=await task(owner),next=await task(owner,false);
  await settled(first.id,'waiting_approval');
  const claim=await registry().fetch(`https://workspace/tasks/${next.id}/claim`,{method:'POST'});expect(claim.ok).toBe(true);await claim.text();
  await runInDurableObject(registry(),(instance,state)=>{
   const record=JSON.parse(state.storage.sql.exec<{data:string}>('SELECT data FROM tasks WHERE id=?',next.id).one().data);record.status='queued';record.startImmediately=true;
   state.storage.sql.exec('UPDATE tasks SET data=? WHERE id=?',JSON.stringify(record),next.id);
   (instance as unknown as {beginComputerAdmission(botId:string,taskId:string,op:string):string}).beginComputerAdmission(owner.id,next.id,`task-start:${next.id}`);
   state.storage.sql.exec('UPDATE computer_admissions SET created_at=? WHERE task_id=?',Date.now()-61000,next.id);
  });
  await evictDurableObject(registry());await tick();await settled(next.id,'waiting_approval');
  const runs=(await api<{runs:Run[]}>(`/v1/tasks/${next.id}/runs`)).runs;expect(runs).toHaveLength(1);expect(runs[0].operationId).toBe(`task-start:${next.id}:1`);
  await settled(first.id,'waiting_approval');
 },60000);
 it('keeps desktop tickets inside their task computer and rejects sibling or root routing',async()=>{
  const owner=await bot(),first=await task(owner,false),second=await task(owner,false);
  const left=bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(computerName(owner.id,first.id))),right=bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(computerName(owner.id,second.id)));
  const req=(taskId:string,path:string,body?:unknown)=>new Request(`https://computer.internal${path}`,{method:body===undefined?'GET':'POST',headers:computerHeaders(owner.id,taskId),...(body===undefined?{}:{body:JSON.stringify(body)})});
  const session=await runInDurableObject(left,async(instance)=>{
   Object.defineProperty(instance,'initializeWorkspace',{value:async()=>({ok:true,desktop:true,capabilities:['workspace','liveDesktop']})});
   const created=await instance.fetch(req(first.id,'/desktop',{mode:'view'}));expect(created.ok).toBe(true);
   return created.json<{sessionId:string;protocols:string[]}>();
  });
  const stolen=req(second.id,'/desktop-ws');stolen.headers.set('Upgrade','websocket');stolen.headers.set('sec-websocket-protocol',session.protocols.join(','));
  const wrong=await left.fetch(stolen.clone());expect(wrong.status).toBe(403);await wrong.text();
  const other=await right.fetch(stolen);expect(other.status).toBe(401);await other.text();
  const released=await left.fetch(new Request(`https://computer.internal/desktop/${session.sessionId}`,{method:'DELETE',headers:computerHeaders(owner.id,first.id)}));expect(released.ok).toBe(true);await released.text();
 },60000);
 it('deleting a named bot drains its isolated task computers and preserves another bot',async()=>{
  const owner=await bot(),other=await bot(),first=await task(owner),second=await task(owner);
  await settled(first.id,'waiting_approval');await settled(second.id,'waiting_approval');
  await runInDurableObject(registry(),(_,state)=>state.storage.sql.exec('INSERT INTO task_isolation_migrations(task_id,bot_id) VALUES(?,?)',first.id,owner.id));
  const response=await exports.default.fetch(`https://timber.test/v1/bots/${owner.id}`,{method:'DELETE',headers:{authorization:'Bearer test-only-botspace-owner-token-000000'}});expect([200,202]).toContain(response.status);await response.text();
  await expect.poll(async()=>{
   await tick();
   return await runInDurableObject(bindings.COMPUTER.get(bindings.COMPUTER.idFromName(computerName(owner.id,second.id))),(_,state)=>state.storage.sql.exec('SELECT 1 FROM deletion').toArray().length);
  }).toBe(1);
  for(const current of [first,second])await runInDurableObject(bindings.COMPUTER.get(bindings.COMPUTER.idFromName(computerName(owner.id,current.id))),(_,state)=>expect(state.storage.sql.exec('SELECT 1 FROM deletion').toArray()).toHaveLength(1));
  await runInDurableObject(registry(),(_,state)=>expect(state.storage.sql.exec('SELECT 1 FROM task_isolation_migrations WHERE task_id=?',first.id).toArray()).toHaveLength(0));
  expect((await api<{bot:Bot}>(`/v1/bots/${other.id}`)).bot.id).toBe(other.id);
  await runInDurableObject(bindings.COMPUTER.get(bindings.COMPUTER.idFromName(other.id)),(_,state)=>expect(state.storage.sql.exec('SELECT 1 FROM deletion').toArray()).toHaveLength(0));
 },60000);
 it('copies a source checkpoint into independent durable objects and refuses a wrong computer scope',async()=>{
  const owner=await bot(),first=await task(owner,false),second=await task(owner,false);
  const bytes=new TextEncoder().encode('immutable checkpoint fixture'),checksum=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
  const id=crypto.randomUUID(),key=`bots/${owner.id}/checkpoints/${id}.tar.gz`;
  await bindings.FILES.put(key,bytes,{sha256:checksum});
  const source=bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(owner.id));
  await runInDurableObject(source,(_,state)=>state.storage.put({botId:owner.id,lastCheckpoint:{id,key,size:bytes.length,sha256:checksum,createdAt:new Date().toISOString()}}));
  const copies:string[]=[];
  for(const current of [first,second]){
   const scope=bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(computerName(owner.id,current.id)));
   const response=await scope.fetch('https://computer/status',{method:'POST',headers:computerHeaders(owner.id,current.id),body:JSON.stringify({botId:owner.id})});expect(response.ok).toBe(true);await response.text();
   copies.push(await runInDurableObject(scope,async(_,state)=>(await state.storage.get<{key:string}>('lastCheckpoint'))!.key));
  }
  // Simulate upload succeeded but metadata commit was lost. Recovery must not
  // depend on a source snapshot that can be removed independently.
  const lost=bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(computerName(owner.id,second.id)));
  await runInDurableObject(lost,async(_,state)=>{await state.storage.delete(['taskScopeInitialized','lastCheckpoint']);});
  await runInDurableObject(source,async(_,state)=>{await state.storage.delete('lastCheckpoint');});
  await evictDurableObject(lost);
  const recovered=await lost.fetch('https://computer/status',{method:'POST',headers:computerHeaders(owner.id,second.id),body:JSON.stringify({botId:owner.id})});expect(recovered.ok).toBe(true);await recovered.text();
  expect(await runInDurableObject(lost,async(_,state)=>(await state.storage.get<{key:string}>('lastCheckpoint'))!.key)).toBe(copies[1]);
  expect(new Set([key,...copies]).size).toBe(3);await bindings.FILES.delete(key);
  for(const copy of copies)expect(await (await bindings.FILES.get(copy))!.text()).toBe('immutable checkpoint fixture');
  const target=bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(computerName(owner.id,first.id)));
  await evictDurableObject(target);
  const wrong=await target.fetch('https://computer/status',{method:'POST',headers:computerHeaders(owner.id,second.id),body:JSON.stringify({botId:owner.id})});expect(wrong.status).toBe(403);await wrong.text();
  const own=await target.fetch('https://computer/status',{method:'POST',headers:computerHeaders(owner.id,first.id),body:JSON.stringify({botId:owner.id})});expect(own.ok).toBe(true);await own.text();
 },60000);
});
