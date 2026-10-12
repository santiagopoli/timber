import {env,exports} from "cloudflare:workers";
import {evictDurableObject,runDurableObjectAlarm,runInDurableObject} from "cloudflare:test";
import {describe,expect,it} from "vitest";
import type {Approval,Bot,Run,Task} from "@botspace/contracts";
import type {Env} from "../apps/api/src/env";
import {computerFixtureControl} from "./fixtures/worker";
import type {AgentRuntime} from "../packages/runtime/src/types";
const bindings=env as unknown as Env;
const api=async(path:string,input?:unknown,method=input===undefined?"GET":"POST")=>{
 const response=await exports.default.fetch(`https://timber.test${path}`,{method,headers:{authorization:"Bearer test-only-botspace-owner-token-000000","content-type":"application/json"},...(input===undefined?{}:{body:JSON.stringify(input)})});
 // Finish each HTTP read like the console client before simulating eviction.
 // A retained DO response stream is a live request, not persisted scheduler work.
 const payload=await response.arrayBuffer();
 return new Response([204,205,304].includes(response.status)?null:payload,{status:response.status,headers:response.headers});
};
const registry=()=>bindings.WORKSPACE.get(bindings.WORKSPACE.idFromName("owner"));
const taskDO=(id:string)=>bindings.BOT.get(bindings.BOT.idFromName(`owner:task:${id}`));
async function bot(){const response=await api("/v1/bots",{name:"Scheduler bot",allowTaskCreation:true});expect(response.status).toBe(201);return (await response.json<{bot:Bot}>()).bot;}
async function task(owner:Bot,description="fixture:approval",startImmediately=true){const response=await api("/v1/tasks",{operationId:crypto.randomUUID(),title:"Scheduled task",description,botId:owner.id,startImmediately});expect(response.status).toBe(201);return (await response.json<{task:Task}>()).task;}
async function tick(){expect(await runDurableObjectAlarm(registry())).toBe(true);}
async function ageSlot(id:string){await runInDurableObject(registry(),(_instance,state)=>{state.storage.sql.exec("UPDATE task_slots SET updated_at=? WHERE bot_id=?",Date.now()-6000,id);});}
async function taskRuns(id:string){return (await (await api(`/v1/tasks/${id}/runs`)).json<{runs:Run[];activeRuns:Run[]}>());}
async function settled(id:string,status:string){for(let i=0;i<100;i++){const result=await taskRuns(id);if(result.runs[0]?.status===status)return result.runs[0];await new Promise(resolve=>setTimeout(resolve,5));}throw new Error(`Task run did not become ${status}`);}
async function slot(id:string){return runInDurableObject(registry(),(_instance,state)=>state.storage.sql.exec<{task_id:string;token:string;generation:number;updated_at:number}>("SELECT task_id,token,generation,updated_at FROM task_slots WHERE bot_id=?",id).toArray()[0]);}
describe("durable task computer scheduler",()=>{
 it("receipts messages to a queued task, preserves them across eviction and starts the original work first",async()=>{
  const owner=await bot(),held=await task(owner),queued=await task(owner);
  await settled(held.id,"waiting_approval");expect(queued.status).toBe("queued");
  const input={operationId:crypto.randomUUID(),text:"Additional instructions while waiting"};
  const first=await api(`/v1/tasks/${queued.id}/messages`,input);expect(first.status).toBe(202);
  const saved=(await first.json<{run:Run}>()).run;expect(saved.status).toBe("queued");
  expect((await (await api(`/v1/tasks/${queued.id}/messages`,input)).json<{run:Run}>()).run.id).toBe(saved.id);
  expect((await api(`/v1/tasks/${queued.id}/messages`,{...input,text:"Changed"})).status).toBe(409);
  await runInDurableObject(taskDO(queued.id),async(_,state)=>{
   expect(state.storage.sql.exec<{admitted:number}>("SELECT admitted FROM submissions WHERE operation_id=?",input.operationId).one().admitted).toBe(0);
   expect(state.storage.sql.exec("SELECT 1 FROM admission_retries WHERE operation_id=?",input.operationId).toArray()).toHaveLength(0);
   expect(await state.storage.get(`fixture-runtime:${input.operationId}`)).toBeUndefined();
  });
  await evictDurableObject(taskDO(queued.id));await evictDurableObject(registry());
  await api(`/v1/tasks/${held.id}/cancel`,{},"POST");await tick();
  expect((await slot(owner.id))?.task_id).toBe(queued.id);
  const runs=(await taskRuns(queued.id)).runs;expect(runs.some(r=>r.operationId===`task-start:${queued.id}`)).toBe(true);
  await runInDurableObject(taskDO(queued.id),async(instance,state)=>{
   expect(await state.storage.get(`fixture-runtime:task-start:${queued.id}`)).toBeDefined();
   await (instance as unknown as {admit(op:string):Promise<void>}).admit(input.operationId);
   expect(state.storage.sql.exec<{admitted:number}>("SELECT admitted FROM submissions WHERE operation_id=?",input.operationId).one().admitted).toBe(1);
  });
  await api(`/v1/tasks/${queued.id}/cancel`,{},"POST");
  expect((await api(`/v1/tasks/${queued.id}/messages`,{operationId:crypto.randomUUID(),text:"Too late"})).status).toBe(409);
 },60000);
 it("keeps reads passive and wakes FIFO after an ordinary bot finishes, across registry eviction",async()=>{
  const owner=await bot();const response=await api(`/v1/bots/${owner.id}/messages`,{operationId:crypto.randomUUID(),text:"fixture:approval"});expect(response.status).toBe(202);const {run}=await response.json<{run:Run}>();
  const first=await task(owner),second=await task(owner);expect(first.status).toBe("queued");expect(second.status).toBe("queued");
  for(let i=0;i<3;i++){await api("/v1/tasks");await api(`/v1/tasks/${first.id}`);}expect((await taskRuns(first.id)).runs).toHaveLength(0);
  await tick();expect((await slot(owner.id))?.task_id).toBe("@bot");expect((await taskRuns(first.id)).runs).toHaveLength(0);
  expect((await api(`/v1/bots/${owner.id}/runs/${run.id}/cancel`,{},"POST")).status).toBe(200);await ageSlot(owner.id);await evictDurableObject(registry());await tick();
  expect((await slot(owner.id))?.task_id).toBe(first.id);await settled(first.id,"waiting_approval");expect((await taskRuns(second.id)).runs).toHaveLength(0);
  expect((await api(`/v1/tasks/${first.id}/cancel`,{},"POST")).status).toBe(200);await tick();expect((await slot(owner.id))?.task_id).toBe(second.id);expect((await taskRuns(second.id)).runs).toHaveLength(1);
 },60000);
 it("recovers an unaccepted lost task-start dispatch with a new fenced attempt after eviction",async()=>{
  const owner=await bot(),record=await task(owner,"fixture:approval",false),oldOperation=`task-start:${record.id}`;
  const claim=await registry().fetch(`https://workspace/tasks/${record.id}/claim`,{method:"POST"});expect(claim.status).toBe(200);await claim.text();
  await runInDurableObject(registry(),(instance,state)=>{
   const saved=JSON.parse(state.storage.sql.exec<{data:string}>("SELECT data FROM tasks WHERE id=?",record.id).one().data);saved.status="queued";saved.startImmediately=true;
   state.storage.sql.exec("UPDATE tasks SET data=? WHERE id=?",JSON.stringify(saved),record.id);
   (instance as unknown as {beginComputerAdmission:(botId:string,taskId:string,operationId:string,queued:boolean)=>string}).beginComputerAdmission(owner.id,record.id,oldOperation,true);
   state.storage.sql.exec("UPDATE computer_admissions SET created_at=? WHERE bot_id=?",Date.now()-61000,owner.id);
  });
  await evictDurableObject(registry());await tick();const page=await taskRuns(record.id);expect(page.runs).toHaveLength(1);expect(page.runs[0].operationId).toBe(`${oldOperation}:1`);
  const late=await taskDO(record.id).fetch("https://task/messages",{method:"POST",headers:{"content-type":"application/json","x-botspace-config":encodeURIComponent(JSON.stringify(owner)),"x-timber-task-id":record.id},body:JSON.stringify({operationId:oldOperation,text:"fixture:approval"})});
  expect(late.status).toBe(409);expect((await taskRuns(record.id)).runs).toHaveLength(1);
 },60000);
 it("never fences or replaces a task-start input that already has a durable receipt",async()=>{
  const owner=await bot(),record=await task(owner);await settled(record.id,"waiting_approval");
  const result=await taskDO(record.id).fetch(`https://task/admission-fence/task-start:${record.id}`,{method:"POST",headers:{"x-botspace-config":encodeURIComponent(JSON.stringify(owner)),"x-timber-task-id":record.id,"x-timber-internal":"scheduler"}});
  expect(await result.json()).toEqual({fenced:false,accepted:true});
  expect(await runInDurableObject(taskDO(record.id),(_instance,state)=>state.storage.sql.exec("SELECT 1 FROM admission_fences WHERE operation_id=?",`task-start:${record.id}`).toArray().length)).toBe(0);
 },60000);
 it("does not release an idle-looking slot while its durable admission is unresolved",async()=>{
  const owner=await bot();const op=crypto.randomUUID();const response=await registry().fetch(`https://workspace/tasks/bot-slot/${owner.id}/admissions`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({operationId:op})});expect(response.status).toBe(200);const {token}=await response.json<{token:string}>();const queued=await task(owner);await ageSlot(owner.id);await tick();expect((await taskRuns(queued.id)).runs).toHaveLength(0);
  await registry().fetch(`https://workspace/tasks/bot-slot/${owner.id}/admissions/${token}`,{method:"DELETE"});await ageSlot(owner.id);await tick();expect((await slot(owner.id))?.task_id).toBe(queued.id);
 },60000);
 it("fences a stale terminal observation when a newer task input replaces the lease",async()=>{
  const owner=await bot(),record=await task(owner);await settled(record.id,"waiting_approval");const old=await slot(owner.id);expect(old).toBeDefined();
  const response=await api(`/v1/tasks/${record.id}/messages`,{operationId:crypto.randomUUID(),text:"fixture:approval"});expect(response.status).toBe(202);const current=await slot(owner.id);expect(current?.token).not.toBe(old?.token);
  await runInDurableObject(registry(),instance=>(instance as unknown as {finalizeTask:(snapshot:unknown,status:string)=>void}).finalizeTask({bot_id:owner.id,...old},"completed"));
  expect((await slot(owner.id))?.token).toBe(current?.token);expect((await (await api(`/v1/tasks/${record.id}`)).json<{task:Task}>()).task.status).not.toBe("completed");
 },60000);
 it("uses task-scoped approvals and never exposes task runs through the ordinary bot",async()=>{
  const owner=await bot(),record=await task(owner);const run=await settled(record.id,"waiting_approval");await tick();expect((await (await api(`/v1/tasks/${record.id}`)).json<{task:Task}>()).task.status).toBe("waiting_approval");
  const {approvals}=await (await api(`/v1/tasks/${record.id}/approvals`)).json<{approvals:Approval[]}>();expect(approvals).toHaveLength(1);expect((await api(`/v1/bots/${owner.id}/runs/${run.id}`)).status).toBe(404);
  const main=await (await api(`/v1/bots/${owner.id}/approvals`)).json<{approvals:Approval[]}>();expect(main.approvals).toHaveLength(0);
  const approved=await api(`/v1/tasks/${record.id}/approvals/${approvals[0].id}`,{decision:"approve"});expect(approved.status).toBe(200);await settled(record.id,"completed");await tick();expect((await (await api(`/v1/tasks/${record.id}`)).json<{task:Task}>()).task.status).toBe("completed");
 },60000);
 it("persists cancellation for all task admissions and blocks stale approvals after eviction",async()=>{
  const owner=await bot(),record=await task(owner);await settled(record.id,"waiting_approval");const {approvals}=await (await api(`/v1/tasks/${record.id}/approvals`)).json<{approvals:Approval[]}>();expect((await api(`/v1/tasks/${record.id}/cancel`,{},"POST")).status).toBe(200);await evictDurableObject(taskDO(record.id));
  const headers={"content-type":"application/json","x-botspace-config":encodeURIComponent(JSON.stringify(owner)),"x-timber-task-id":record.id};
  const late=await taskDO(record.id).fetch("https://task/messages",{method:"POST",headers,body:JSON.stringify({operationId:crypto.randomUUID(),text:"Late work"})});expect(late.status).toBe(409);
  const effect=await api(`/v1/tasks/${record.id}/approvals/${approvals[0].id}`,{decision:"approve"});expect(effect.status).toBe(409);await tick();expect((await (await api(`/v1/tasks/${record.id}`)).json<{task:Task}>()).task.status).toBe("cancelled");
 },60000);
 it("retains a cancelling task lease until native cancellation is acknowledged",async()=>{
  const owner=await bot(),record=await task(owner);await settled(record.id,"waiting_approval");
  type Target={runtime:AgentRuntime;testCancel?:AgentRuntime["cancel"];flushRunCancellations():Promise<void>};
  await runInDurableObject(taskDO(record.id),instance=>{
   const target=instance as unknown as Target;target.testCancel=target.runtime.cancel;
   target.runtime.cancel=async()=>{throw new Error("Native cancellation is unavailable");};
  });
  try {
   expect((await api(`/v1/tasks/${record.id}/cancel`,{},"POST")).status).toBe(200);
   await tick();expect((await slot(owner.id))?.task_id).toBe(record.id);
   const current=await (await api(`/v1/tasks/${record.id}`)).json<{task:Task}>();expect(current.task.status).toBe("cancelling");
   const next=await task(owner);expect(next.status).toBe("queued");expect((await taskRuns(next.id)).runs).toHaveLength(0);
   await runInDurableObject(taskDO(record.id),async(instance,state)=>{
    const target=instance as unknown as Target;target.runtime.cancel=target.testCancel!;delete target.testCancel;
    state.storage.sql.exec("UPDATE pending_run_cancellations SET next_at=0");await target.flushRunCancellations();
    expect(state.storage.sql.exec("SELECT 1 FROM pending_run_cancellations").toArray()).toHaveLength(0);
   });
   await tick();expect((await slot(owner.id))?.task_id).toBe(next.id);
   expect((await (await api(`/v1/tasks/${record.id}`)).json<{task:Task}>()).task.status).toBe("cancelled");
  } finally {await runInDurableObject(taskDO(record.id),instance=>{const target=instance as unknown as Target;if(target.testCancel){target.runtime.cancel=target.testCancel;delete target.testCancel;}});}
 },60000);
 it("retains a task lease after a final answer while its managed process is alive",async()=>{
  const owner=await bot();await api(`/v1/bots/${owner.id}`,{computerApprovalMode:"automatic"},"PATCH");computerFixtureControl.execSession={pollsBeforeComplete:100};
  try{const record=await task(owner,"fixture:approval");await settled(record.id,"completed");await tick();expect((await slot(owner.id))?.task_id).toBe(record.id);const next=await task(owner);expect(next.status).toBe("queued");expect((await api(`/v1/tasks/${record.id}/cancel`,{},"POST")).status).toBe(200);await tick();expect((await slot(owner.id))?.task_id).toBe(next.id);}finally{delete computerFixtureControl.execSession;}
 },60000);
 it("keeps an orphan direct process fenced until its missing-session cancellation is acknowledged",async()=>{
  const owner=await bot(),operationId=`orphan:${crypto.randomUUID()}`,root=bindings.BOT.get(bindings.BOT.idFromName(`owner:${owner.id}`));
  computerFixtureControl.execSession={pollsBeforeComplete:100};
  try {
   expect((await api(`/v1/bots/${owner.id}/computer/actions`,{operationId,action:{type:"exec",command:"printf orphan"}})).status).toBe(200);
   const queued=await task(owner);
   await runInDurableObject(bindings.COMPUTER.get(bindings.COMPUTER.idFromName(owner.id)),(_instance,state)=>{state.storage.sql.exec("DELETE FROM exec_sessions WHERE id=?",operationId);});
   await runInDurableObject(root,instance=>{const target=instance as unknown as {computer:{cancel:(botId:string,processId:string)=>Promise<unknown>};testOriginalCancel:(botId:string,processId:string)=>Promise<unknown>};target.testOriginalCancel=target.computer.cancel;target.computer.cancel=async()=>{throw new Error("fixture cancellation outage")};});
   const poll=await api(`/v1/bots/${owner.id}/computer/actions`,{operationId:crypto.randomUUID(),action:{type:"execPoll",processId:operationId}});expect(poll.status).toBe(200);expect((await poll.json<{result:{status:string}}>()).result.status).toBe("running");await tick();expect((await taskRuns(queued.id)).runs).toHaveLength(0);
   await runInDurableObject(root,async(instance,state)=>{const target=instance as unknown as {computer:{cancel:(botId:string,processId:string)=>Promise<unknown>};testOriginalCancel:(botId:string,processId:string)=>Promise<unknown>;flushProcessCancellations:()=>Promise<void>};target.computer.cancel=target.testOriginalCancel;state.storage.sql.exec("UPDATE run_processes SET next_at=0 WHERE process_id=?",operationId);await target.flushProcessCancellations();});
   await tick();expect((await slot(owner.id))?.task_id).toBe(queued.id);
  }finally{delete computerFixtureControl.execSession;}
 },60000);
 it("accepts non-UUID managed process IDs and preserves a direct process lease until terminal",async()=>{
  const owner=await bot(),operationId=`exec:test:${crypto.randomUUID()}`;computerFixtureControl.execSession={pollsBeforeComplete:100};
  try{const effect=await api(`/v1/bots/${owner.id}/computer/actions`,{operationId,action:{type:"exec",command:"printf managed"}});expect(effect.status).toBe(200);expect((await effect.json<{result:{status:string}}>()).result.status).toBe("running");const queued=await task(owner);expect(queued.status).toBe("queued");await tick();expect((await slot(owner.id))?.task_id).toBe(`@direct:${operationId}`);
   expect((await api(`/v1/bots/${owner.id}/computer/actions`,{operationId:crypto.randomUUID(),action:{type:"execCancel",processId:operationId}})).status).toBe(200);await tick();expect((await slot(owner.id))?.task_id).toBe(queued.id);
  }finally{delete computerFixtureControl.execSession;}
 },60000);
});
