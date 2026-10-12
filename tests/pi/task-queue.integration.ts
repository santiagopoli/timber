import {env,exports} from "cloudflare:workers";
import {abortAllDurableObjects,evictDurableObject,runDurableObjectAlarm,runInDurableObject} from "cloudflare:test";
import {expect,it} from "vitest";
import type {Bot,Task,Run,Message} from "@botspace/contracts";
import type {Env} from "../../apps/api/src/env";
import {inferenceFixtureControl} from "./worker";
const bindings=env as unknown as Env;
async function api<T>(path:string,input?:unknown){const r=await exports.default.fetch(`https://timber.test${path}`,{method:input===undefined?"GET":"POST",headers:{authorization:"Bearer test-only-botspace-owner-token-000000","content-type":"application/json"},...(input===undefined?{}:{body:JSON.stringify(input)})});expect(r.ok).toBe(true);return r.json<T>();}
it("ordinary task-contention receipts wake through real Pi Lifecycle after eviction without a UI read and never steal task ownership",async()=>{
 const {bot}=await api<{bot:Bot}>("/v1/bots",{name:"Task queue real Pi"});
 const {task}=await api<{task:Task}>("/v1/tasks",{operationId:crypto.randomUUID(),title:"Computer owner",description:"request-exec task queue approval",botId:bot.id});
 const registry=bindings.WORKSPACE.get(bindings.WORKSPACE.idFromName("owner"));
 for(let n=0;n<300;n++){const {activeRuns}=await api<{activeRuns:Run[]}>(`/v1/tasks/${task.id}/runs`);if(activeRuns.some(r=>r.status==="waiting_approval"))break;await new Promise(resolve=>setTimeout(resolve,10));}
 const op=crypto.randomUUID(),input={operationId:op,text:"Durably saved while the task holds this computer"};
 const first=await api<{run:Run}>(`/v1/bots/${bot.id}/messages`,input),duplicate=await api<{run:Run}>(`/v1/bots/${bot.id}/messages`,input);expect(first.run.status).toBe("queued");expect(duplicate.run.id).toBe(first.run.id);
 await runInDurableObject(registry,(_,state)=>expect(state.storage.sql.exec<{task_id:string}>("SELECT task_id FROM task_slots WHERE bot_id=?",bot.id).one().task_id).toBe(task.id));
 let stub=bindings.BOT.get(bindings.BOT.idFromName(`owner:${bot.id}`));
 await runInDurableObject(stub,(_,state)=>{expect(state.storage.sql.exec<{admitted:number}>("SELECT admitted FROM submissions WHERE operation_id=?",op).one().admitted).toBe(0);expect(state.storage.sql.exec("SELECT 1 FROM admission_retries WHERE operation_id=?",op).toArray()).toHaveLength(0);expect(state.storage.sql.exec("SELECT 1 FROM execution_claims WHERE operation_id=?",op).toArray()).toHaveLength(0);});
 await api(`/v1/tasks/${task.id}/cancel`,{});await runDurableObjectAlarm(registry);
 await abortAllDurableObjects();stub=bindings.BOT.get(bindings.BOT.idFromName(`owner:${bot.id}`));await new Promise(resolve=>setTimeout(resolve,1100));await runDurableObjectAlarm(stub);
 // SQL-only observers cannot trigger HTTP's opportunistic native recovery.
 const read=()=>runInDurableObject(stub,(_,state)=>JSON.parse(state.storage.sql.exec<{data:string}>("SELECT data FROM runs WHERE id=?",first.run.id).one().data) as Run);
 let saved=await read();for(let n=0;n<300&&saved.status!=="completed";n++){await new Promise(resolve=>setTimeout(resolve,10));saved=await read();}expect(saved.status).toBe("completed");expect(saved.operationId).toBe(op);
 const {messages}=await api<{messages:Message[]}>(`/v1/bots/${bot.id}/messages`);expect(messages.filter(m=>m.role==="user")).toEqual([expect.objectContaining({text:input.text,runId:first.run.id})]);expect(messages.filter(m=>m.role==="assistant")).toHaveLength(1);
});
it('task-enabled ordinary chat stays responsive without taking a running task computer lease, including after eviction',async()=>{
 const {bot}=await api<{bot:Bot}>('/v1/bots',{name:'Responsive coordinator',allowTaskCreation:true});
 const {task}=await api<{task:Task}>('/v1/tasks',{operationId:crypto.randomUUID(),title:'Working task',description:'request-exec task computer must remain isolated',botId:bot.id});
 await expect.poll(async()=> (await api<{activeRuns:Run[]}>(`/v1/tasks/${task.id}/runs`)).activeRuns.some(run=>run.status==='waiting_approval')).toBe(true);
 const registry=bindings.WORKSPACE.get(bindings.WORKSPACE.idFromName('owner'));
 const lease=()=>runInDurableObject(registry,(_,state)=>state.storage.sql.exec<{task_id:string;token:string;generation:number}>('SELECT task_id,token,generation FROM task_slots WHERE bot_id=?',bot.id).one());
 const original=await lease(),op=crypto.randomUUID();
 const first=await api<{run:Run}>(`/v1/bots/${bot.id}/messages`,{operationId:op,text:'Hello, tell me what you are working on.'});
 await expect.poll(async()=> (await api<{run:Run}>(`/v1/bots/${bot.id}/runs/${first.run.id}`)).run.status).toBe('completed');
 expect((await api<{run:Run}>(`/v1/bots/${bot.id}/runs/${first.run.id}`)).run.coordinatorMode).toBe(true);expect(await lease()).toEqual(original);
 const replay=await api<{run:Run}>(`/v1/bots/${bot.id}/messages`,{operationId:op,text:'Hello, tell me what you are working on.'});expect(replay.run.id).toBe(first.run.id);
 await evictDurableObject(bindings.BOT.get(bindings.BOT.idFromName(`owner:${bot.id}`)));
 const second=await api<{run:Run}>(`/v1/bots/${bot.id}/messages`,{operationId:crypto.randomUUID(),text:'Another plain response after eviction'});
 await expect.poll(async()=> (await api<{run:Run}>(`/v1/bots/${bot.id}/runs/${second.run.id}`)).run.status).toBe('completed');expect(await lease()).toEqual(original);
 expect((await api<{activeRuns:Run[]}>(`/v1/tasks/${task.id}/runs`)).activeRuns.some(run=>run.status==='waiting_approval')).toBe(true);
});
it('coordinator computer and provider tools are rejected before effects while new persistent work queues independently',async()=>{
 const {bot}=await api<{bot:Bot}>('/v1/bots',{name:'Coordinator boundaries',allowTaskCreation:true});
 const {task}=await api<{task:Task}>('/v1/tasks',{operationId:crypto.randomUUID(),title:'First task owns computer',description:'request-exec pending approval',botId:bot.id});
 await expect.poll(async()=> (await api<{activeRuns:Run[]}>(`/v1/tasks/${task.id}/runs`)).activeRuns.some(run=>run.status==='waiting_approval')).toBe(true);
 const execution=await api<{run:Run}>(`/v1/bots/${bot.id}/messages`,{operationId:crypto.randomUUID(),text:'request-exec try computer in coordinator'});
 await expect.poll(async()=> (await api<{run:Run}>(`/v1/bots/${bot.id}/runs/${execution.run.id}`)).run.status).toBe('completed');
 const stub=bindings.BOT.get(bindings.BOT.idFromName(`owner:${bot.id}`));
 await runInDurableObject(stub,(_,state)=>{expect(state.storage.sql.exec('SELECT operation_id FROM computer_operations').toArray()).toHaveLength(0);expect(state.storage.sql.exec('SELECT id FROM approvals').toArray()).toHaveLength(0);});
 const next=await api<{run:Run}>(`/v1/bots/${bot.id}/messages`,{operationId:crypto.randomUUID(),text:'request-task-handoff more independent work'});
 await expect.poll(async()=> (await api<{run:Run}>(`/v1/bots/${bot.id}/runs/${next.run.id}`)).run.status).toBe('completed');
 const {tasks}=await api<{tasks:Task[]}>('/v1/tasks');expect(tasks.find(record=>record.sourceRunId===next.run.id)).toMatchObject({status:'queued',botId:bot.id});
 const registry=bindings.WORKSPACE.get(bindings.WORKSPACE.idFromName('owner'));
 await runInDurableObject(registry,(_,state)=>expect(state.storage.sql.exec<{task_id:string}>('SELECT task_id FROM task_slots WHERE bot_id=?',bot.id).one().task_id).toBe(task.id));
 const source=await api<{run:Run}>(`/v1/bots/${bot.id}/messages`,{operationId:crypto.randomUUID(),text:'request-host prohibited-provider-mutation'});
 await expect.poll(async()=> (await api<{run:Run}>(`/v1/bots/${bot.id}/runs/${source.run.id}`)).run.status).toBe('completed');
 await runInDurableObject(stub,(_,state)=>expect(state.storage.sql.exec('SELECT id FROM connections').toArray()).toHaveLength(0));
});
it('a live coordinator neither blocks the next task nor stops its independent run',async()=>{
 const {bot}=await api<{bot:Bot}>('/v1/bots',{name:'Independent task scheduling',allowTaskCreation:true});
 const {task}=await api<{task:Task}>('/v1/tasks',{operationId:crypto.randomUUID(),title:'First task',description:'request-exec first-task approval',botId:bot.id});
 await expect.poll(async()=> (await api<{activeRuns:Run[]}>(`/v1/tasks/${task.id}/runs`)).activeRuns.some(run=>run.status==='waiting_approval')).toBe(true);
 let release!:()=>void;inferenceFixtureControl.matches='coordinator-withheld';inferenceFixtureControl.gate=new Promise<void>(resolve=>{release=resolve;});
 try {
  const chat=await api<{run:Run}>(`/v1/bots/${bot.id}/messages`,{operationId:crypto.randomUUID(),text:'coordinator-withheld simple conversation'});
  await expect.poll(async()=> (await api<{run:Run}>(`/v1/bots/${bot.id}/runs/${chat.run.id}`)).run.status).toBe('running');
  const main=bindings.BOT.get(bindings.BOT.idFromName(`owner:${bot.id}`));
  await runInDurableObject(main,(instance)=>expect((instance as unknown as {summary():{executionRuns:number}}).summary().executionRuns).toBe(0));
  const {task:next}=await api<{task:Task}>('/v1/tasks',{operationId:crypto.randomUUID(),title:'Next task',description:'request-exec second-task approval',botId:bot.id});expect(next.status).toBe('queued');
  const {approvals}=await api<{approvals:Array<{id:string}>}>(`/v1/tasks/${task.id}/approvals`);
  await api(`/v1/tasks/${task.id}/approvals/${approvals[0]!.id}`,{decision:'approve'});
  await expect.poll(async()=> (await api<{activeRuns:Run[]}>(`/v1/tasks/${task.id}/runs`)).activeRuns.length).toBe(0);
  const registry=bindings.WORKSPACE.get(bindings.WORKSPACE.idFromName('owner'));expect(await runDurableObjectAlarm(registry)).toBe(true);
  await expect.poll(async()=> (await api<{activeRuns:Run[]}>(`/v1/tasks/${next.id}/runs`)).activeRuns.some(run=>run.status==='waiting_approval')).toBe(true);
  const stopped=api(`/v1/bots/${bot.id}/runs/${chat.run.id}/cancel`,{});release();await stopped;
  expect((await api<{activeRuns:Run[]}>(`/v1/tasks/${next.id}/runs`)).activeRuns.some(run=>run.status==='waiting_approval')).toBe(true);
  await runInDurableObject(registry,(_,state)=>expect(state.storage.sql.exec<{task_id:string}>('SELECT task_id FROM task_slots WHERE bot_id=?',bot.id).one().task_id).toBe(next.id));
 }finally{release();delete inferenceFixtureControl.gate;delete inferenceFixtureControl.matches;}
});
