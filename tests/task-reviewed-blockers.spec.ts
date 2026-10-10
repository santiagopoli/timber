import {env,exports} from "cloudflare:workers";
import {evictDurableObject,runDurableObjectAlarm,runInDurableObject} from "cloudflare:test";
import {describe,expect,it} from "vitest";
import type {Bot,Task,Run} from "@botspace/contracts";
import type {Env} from "../apps/api/src/env";
import {computerFixtureControl} from "./fixtures/worker";
const bindings=env as unknown as Env;
const registry=()=>bindings.WORKSPACE.get(bindings.WORKSPACE.idFromName("owner"));
const root=(bot:Bot)=>bindings.BOT.get(bindings.BOT.idFromName(`owner:${bot.id}`));
async function api(path:string,input?:unknown,method=input===undefined?"GET":"POST") {
 const r=await exports.default.fetch(`https://timber.test${path}`,{method,headers:{authorization:"Bearer test-only-botspace-owner-token-000000","content-type":"application/json"},...(input===undefined?{}:{body:JSON.stringify(input)})});
 const data=await r.json<any>();return {status:r.status,data};
}
async function bot(){const r=await api("/v1/bots",{name:"Reviewed blockers"});expect(r.status).toBe(201);return r.data.bot as Bot;}
async function task(owner:Bot,description="fixture:approval",startImmediately=true){const r=await api("/v1/tasks",{operationId:crypto.randomUUID(),title:"Reviewed task",description,botId:owner.id,startImmediately});expect(r.status).toBe(201);return r.data.task as Task;}
async function slot(owner:Bot){return runInDurableObject(registry(),(_,state)=>state.storage.sql.exec<{task_id:string;token:string;generation:number;payload:string}>("SELECT task_id,token,generation,payload FROM task_slots WHERE bot_id=?",owner.id).toArray()[0]);}
async function reconcile(){await runInDurableObject(registry(),async instance=>{await (instance as unknown as {reconcileComputerSlots():Promise<void>}).reconcileComputerSlots();});}
async function wake(owner:Bot,op:string){await runInDurableObject(root(owner),async instance=>{await (instance as unknown as {admit(id:string):Promise<void>}).admit(op);});}
async function effects(owner:Bot){return runInDurableObject(bindings.COMPUTER.get(bindings.COMPUTER.idFromName(owner.id)),(_,state)=>state.storage.sql.exec<{id:string}>("SELECT id FROM effects").toArray().map(row=>row.id));}
async function terminal(id:string,status:string){for(let n=0;n<100;n++){const r=await api(`/v1/tasks/${id}/runs`);if(r.data.runs[0]?.status===status)return r.data.runs[0] as Run;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error(`Missing ${status} task result`);}
describe("reviewed task blockers",()=>{
 it("releases a confirmed pre-effect conflicting action and wakes the already-queued task",async()=>{
  const owner=await bot(),op=crypto.randomUUID();
  expect((await api(`/v1/bots/${owner.id}/computer/actions`,{operationId:op,action:{type:"key",key:"Escape"}})).status).toBe(200);
  expect(await slot(owner)).toBeUndefined();const next=await task(owner,"fixture:approval",false);
  let release!:()=>void,enter!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),entered=new Promise<void>(resolve=>{enter=resolve;});
  type Dispatch={dispatchComputer(op:string,action:any):Promise<unknown>};let original:Dispatch["dispatchComputer"]|undefined;
  await runInDurableObject(root(owner),instance=>{const target=instance as unknown as Dispatch;original=target.dispatchComputer;target.dispatchComputer=async(id,action)=>{if(id===op&&action.key==="Enter"){enter();await gate;}return original!.call(target,id,action);};});
  const conflictRequest=api(`/v1/bots/${owner.id}/computer/actions`,{operationId:op,action:{type:"key",key:"Enter"}});
  await entered;expect((await slot(owner))?.task_id).toBe(`@direct:${op}`);
  // Persist the legitimate start intent while the rejecting RPC is in flight;
  // dispatching its alarm does not need a browser read to free/start the task.
  await runInDurableObject(registry(),(_,state)=>{state.storage.sql.exec("UPDATE tasks SET data=? WHERE id=?",JSON.stringify({...next,status:"queued",startImmediately:true}),next.id);});
  release();const conflict=await conflictRequest;
  await runInDurableObject(root(owner),instance=>{(instance as unknown as Dispatch).dispatchComputer=original!;});
  expect(conflict.status).toBe(409);expect(conflict.data).toMatchObject({error:{code:"idempotency_conflict"},preEffectRejected:true});expect(await effects(owner)).toEqual([op]);
  expect(await runDurableObjectAlarm(registry())).toBe(true);await terminal(next.id,"waiting_approval");expect((await slot(owner))?.task_id).toBe(next.id);
 });
 it("allows suspend after a confirmed upgrade-required rejection, but retains an uncertain transport lease",async()=>{
  const owner=await bot();computerFixtureControl.failure={status:409,body:{error:{code:"computer_upgrade_required"}}};
  try {const r=await api(`/v1/bots/${owner.id}/computer/actions`,{operationId:crypto.randomUUID(),action:{type:"exec",command:"never dispatched"}});expect(r.status).toBe(409);expect(r.data.preEffectRejected).toBe(true);expect(await slot(owner)).toBeUndefined();await runInDurableObject(root(owner),(_,state)=>{expect(state.storage.sql.exec("SELECT 1 FROM run_processes WHERE status='running'").toArray()).toHaveLength(0);});}
  finally {delete computerFixtureControl.failure;}
  expect((await api(`/v1/bots/${owner.id}/computer/suspend`,{})).status).toBe(200);
  computerFixtureControl.failure={status:503,body:{error:{code:"computer_unavailable"}}};
  try {expect((await api(`/v1/bots/${owner.id}/computer/actions`,{operationId:crypto.randomUUID(),action:{type:"key",key:"Escape"}})).status).toBe(503);const held=await slot(owner);expect(held?.task_id.startsWith("@direct:")).toBe(true);await reconcile();expect((await slot(owner))?.token).toBe(held?.token);}
  finally {delete computerFixtureControl.failure;}
 });
 it("rereads direct lease after a delayed body and preserves the competing cancellation intent",async()=>{
  const owner=await bot(),key=crypto.randomUUID();computerFixtureControl.execSession={command:"CAS fixture",pollsBeforeComplete:100};
  try {expect((await api(`/v1/bots/${owner.id}/computer/actions`,{operationId:key,action:{type:"exec",command:"CAS fixture"}})).data.result.status).toBe("running");}
  finally {delete computerFixtureControl.execSession;}
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  const poll={operationId:crypto.randomUUID(),action:{type:"execPoll",processId:key}},cancel={operationId:crypto.randomUUID(),action:{type:"execCancel",processId:key}};
  const delayed=new ReadableStream({async start(controller){await gate;controller.enqueue(new TextEncoder().encode(JSON.stringify({payload:poll})));controller.close();}});
  const url=`https://workspace/tasks/bot-slot/${owner.id}?kind=direct&key=${key}`;
  const polling=registry().fetch(new Request(url,{method:"POST",headers:{"content-type":"application/json"},body:delayed}));
  const cancelled=await registry().fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({payload:cancel})});
  expect(cancelled.status).toBe(200);const claim=await cancelled.json<{token:string}>();expect((await slot(owner))?.token).toBe(claim.token);expect(JSON.parse((await slot(owner))!.payload)).toEqual(cancel);
  release();const response=await polling;expect(response.status).toBe(200);const observed=await response.json<{token:string;generation:number}>();expect(await slot(owner)).toMatchObject({token:observed.token,generation:observed.generation});expect(JSON.parse((await slot(owner))!.payload)).toEqual(cancel);
 });
 it.each(["cancelled","changed"])("rereads a %s direct intent after a paused control check",async mode=>{
  const owner=await bot(),record=await task(owner);await terminal(record.id,"waiting_approval");const op=crypto.randomUUID(),input={operationId:op,action:{type:"key",key:"Escape"}};
  let release!:()=>void,enter!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),entered=new Promise<void>(resolve=>{enter=resolve;});
  type Control={computerControlled(id:string,bot:Bot):Promise<boolean>};let original!:Control["computerControlled"];let first=true;
  await runInDurableObject(registry(),instance=>{const target=instance as unknown as Control;original=target.computerControlled;target.computerControlled=async(id,bot)=>{const controlled=await original.call(target,id,bot);if(id===owner.id&&first){first=false;enter();await gate;}return controlled;};});
  const delayed=api(`/v1/bots/${owner.id}/computer/actions`,input);await entered;
  expect((await api(`/v1/bots/${owner.id}/computer/actions`,mode==="changed"?{...input,action:{type:"key",key:"Enter"}}:input)).status).toBe(202);
  if(mode==="cancelled"){await api(`/v1/bots/${owner.id}/computer/queued-actions/${op}/cancel`,{});await api(`/v1/tasks/${record.id}/cancel`,{});await reconcile();}
  release();const response=await delayed;
  await runInDurableObject(registry(),instance=>{(instance as unknown as Control).computerControlled=original;});
  expect(response.status).toBe(409);expect(response.data.error.code).toBe(mode==="cancelled"?"action_cancelled":"operation_id_conflict");expect(await effects(owner)).not.toContain(op);
 });
 it("fences a stale reconciler after control awaits while preserving a replacement task holder",async()=>{
  const owner=await bot(),op=crypto.randomUUID(),input={operationId:op,action:{type:"exec",command:"stale reconciler must not run"}};
  const url=`https://workspace/tasks/bot-slot/${owner.id}?kind=direct&key=${op}`;
  expect((await registry().fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({payload:input})})).status).toBe(200);
  let release!:()=>void,enter!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),entered=new Promise<void>(resolve=>{enter=resolve;});
  type Control={computerControlled(id:string,bot:Bot):Promise<boolean>};let original!:Control["computerControlled"];let first=true;
  await runInDurableObject(registry(),instance=>{const target=instance as unknown as Control;original=target.computerControlled;target.computerControlled=async(id,bot)=>{const controlled=await original.call(target,id,bot);if(id===owner.id&&first){first=false;enter();await gate;}return controlled;};});
  const delayed=reconcile();await entered;
  computerFixtureControl.failure={status:409,body:{error:{code:"computer_upgrade_required"}}};
  try {expect((await api(`/v1/bots/${owner.id}/computer/actions`,input)).status).toBe(409);} finally {delete computerFixtureControl.failure;}
  expect(await slot(owner)).toBeUndefined();const record=await task(owner);await terminal(record.id,"waiting_approval");const replacement=await slot(owner);
  release();await delayed;await runInDurableObject(registry(),instance=>{(instance as unknown as Control).computerControlled=original;});
  expect(await effects(owner)).not.toContain(op);expect(await slot(owner)).toMatchObject({task_id:record.id,token:replacement!.token});
 });
 it("validates at the BotDO effect boundary and pins a live journal dispatch until its receipt",async()=>{
  const owner=await bot(),op=crypto.randomUUID(),input={operationId:op,action:{type:"key",key:"Escape"}},url=`https://workspace/tasks/bot-slot/${owner.id}?kind=direct&key=${op}`;
  const claimed=await (await registry().fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({payload:input})})).json<{token:string;generation:number}>();
  await registry().fetch(`https://workspace/tasks/bot-slot/${owner.id}?key=${op}&token=${claimed.token}`,{method:"DELETE"});
  const record=await task(owner);await terminal(record.id,"waiting_approval");
  const stale=await root(owner).fetch("https://bot/computer/actions",{method:"POST",headers:{"content-type":"application/json","x-botspace-config":encodeURIComponent(JSON.stringify(owner)),"x-timber-direct-lease":JSON.stringify({key:op,...claimed})},body:JSON.stringify(input)});
  expect(stale.status).toBe(409);expect(await effects(owner)).not.toContain(op);
  await api(`/v1/tasks/${record.id}/cancel`,{});await reconcile();
  let release!:()=>void,enter!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),entered=new Promise<void>(resolve=>{enter=resolve;});
  type Dispatch={dispatchComputer(op:string,action:any):Promise<unknown>};let original!:Dispatch["dispatchComputer"];
  await runInDurableObject(root(owner),instance=>{const target=instance as unknown as Dispatch;original=target.dispatchComputer;target.dispatchComputer=async(id,action)=>{if(id===op){enter();await gate;}return original.call(target,id,action);};});
  const dispatch=api(`/v1/bots/${owner.id}/computer/actions`,input);await entered;const held=await slot(owner);
  await registry().fetch(`https://workspace/tasks/bot-slot/${owner.id}?key=${op}&token=${held!.token}`,{method:"DELETE"});expect((await slot(owner))?.token).toBe(held!.token);
  const next=await task(owner);expect(next.status).toBe("queued");release();expect((await dispatch).status).toBe(200);
  await runInDurableObject(root(owner),instance=>{(instance as unknown as Dispatch).dispatchComputer=original;});
  await reconcile();await terminal(next.id,"waiting_approval");expect((await slot(owner))?.task_id).toBe(next.id);expect((await effects(owner)).filter(id=>id===op)).toHaveLength(1);
 });
 it("stores normal inputs exactly once at contention, keeps task ownership, and wakes the same input after eviction",async()=>{
  const owner=await bot(),record=await task(owner);await terminal(record.id,"waiting_approval");const held=await slot(owner),op=crypto.randomUUID(),input={operationId:op,text:"Unchanged durable text"};
  const first=await api(`/v1/bots/${owner.id}/messages`,input),repeat=await api(`/v1/bots/${owner.id}/messages`,input);
  expect(first.status).toBe(202);expect(repeat.data.run.id).toBe(first.data.run.id);expect(first.data.run.status).toBe("queued");expect((await slot(owner))?.task_id).toBe(held?.task_id);
  await runInDurableObject(root(owner),async(_,state)=>{expect(state.storage.sql.exec("SELECT 1 FROM admission_retries WHERE operation_id=?",op).toArray()).toHaveLength(0);expect(state.storage.sql.exec<{text:string;admitted:number}>("SELECT text,admitted FROM submissions WHERE operation_id=?",op).one()).toEqual({text:input.text,admitted:0});expect(await state.storage.get(`fixture-runtime:${op}`)).toBeUndefined();expect(await state.storage.get(`fixture-admission-retry:${op}`)).toMatchObject({operationId:op,delayMs:1000});});
  expect((await api(`/v1/tasks/${record.id}/cancel`,{})).status).toBe(200);await reconcile();await evictDurableObject(root(owner));await wake(owner,op);
  let resumed=await api(`/v1/bots/${owner.id}/runs/${first.data.run.id}`);for(let n=0;n<100&&resumed.data.run.status!=="completed";n++){await new Promise(resolve=>setTimeout(resolve,5));resumed=await api(`/v1/bots/${owner.id}/runs/${first.data.run.id}`);}expect(resumed.data.run.status).toBe("completed");expect((await slot(owner))?.task_id).toBe("@bot");
  expect((await api(`/v1/bots/${owner.id}/messages`)).data.messages.filter((m:any)=>m.role==="user")).toEqual([expect.objectContaining({text:input.text,runId:first.data.run.id})]);
 });
 it("cancels an unadmitted queued input permanently without blocking a replacement input",async()=>{
  const owner=await bot(),record=await task(owner);await terminal(record.id,"waiting_approval");const oldOp=crypto.randomUUID(),old=await api(`/v1/bots/${owner.id}/messages`,{operationId:oldOp,text:"Do not execute"});
  expect((await api(`/v1/bots/${owner.id}/runs/${old.data.run.id}/cancel`,{})).status).toBe(200);
  await api(`/v1/tasks/${record.id}/cancel`,{});await reconcile();await evictDurableObject(root(owner));await wake(owner,oldOp);
  const replacement=await api(`/v1/bots/${owner.id}/messages`,{operationId:crypto.randomUUID(),text:"Replacement"});expect(replacement.status).toBe(202);
  await runInDurableObject(root(owner),async(_,state)=>expect(await state.storage.get(`fixture-runtime:${oldOp}`)).toBeUndefined());
  expect((await api(`/v1/bots/${owner.id}/runs/${old.data.run.id}`)).data.run.status).toBe("cancelled");
 });
 it("queues exact owner-authorized direct input and permits cancelling only before durable claim",async()=>{
  const owner=await bot(),record=await task(owner);await terminal(record.id,"waiting_approval");const op=crypto.randomUUID(),input={operationId:op,action:{type:"key",key:"Escape"}};
  expect((await api(`/v1/bots/${owner.id}/computer/actions`,input)).data).toEqual({operationId:op,status:"queued",accepted:true});
  expect((await api(`/v1/bots/${owner.id}/computer/actions`,input)).status).toBe(202);expect((await api(`/v1/bots/${owner.id}/computer/queued-actions`)).data.actions).toEqual([{...input,state:"pending"}]);
  const cancelledOp=crypto.randomUUID();await api(`/v1/bots/${owner.id}/computer/actions`,{...input,operationId:cancelledOp});expect((await api(`/v1/bots/${owner.id}/computer/queued-actions/${cancelledOp}/cancel`,{})).status).toBe(200);
  await api(`/v1/tasks/${record.id}/cancel`,{});await evictDurableObject(registry());expect(await runDurableObjectAlarm(registry())).toBe(true);await reconcile();
  expect(await effects(owner)).toContain(op);expect(await effects(owner)).not.toContain(cancelledOp);expect((await api(`/v1/bots/${owner.id}/computer/actions`,{...input,operationId:cancelledOp})).data.error.code).toBe("action_cancelled");
 });
 it.each(["completed","failed"] as const)("explicitly continues a %s task with a fresh run in the same chat, never replaying task-start",async status=>{
  const owner=await bot(),record=await task(owner,status==="completed"?"Original task":"fixture:model-error");const original=await terminal(record.id,status);await reconcile();
  expect((await api(`/v1/tasks/${record.id}`)).data.task.status).toBe(status);
  const input={operationId:crypto.randomUUID(),text:"New explicit continuation"},continued=await api(`/v1/tasks/${record.id}/continue`,input);expect(continued.status).toBe(202);const newRun=await terminal(record.id,"completed");expect(newRun.id).not.toBe(original.id);expect(newRun.operationId).not.toBe(original.operationId);
  expect((await api(`/v1/tasks/${record.id}/continue`,input)).status).toBe(202);const runs=(await api(`/v1/tasks/${record.id}/runs`)).data.runs;expect(runs).toHaveLength(2);expect(runs.find((r:Run)=>r.id===original.id).status).toBe(status);
  const messages=(await api(`/v1/tasks/${record.id}/messages`)).data.messages;expect(messages.filter((m:any)=>m.role==="user").map((m:any)=>m.text)).toEqual([record.description,input.text]);
  expect((await api(`/v1/bots/${owner.id}/messages`)).data.messages).toEqual([]);
 });
 it("never continues a cancelled task or rewinds its permanent fence",async()=>{
  const owner=await bot(),record=await task(owner);await terminal(record.id,"waiting_approval");await api(`/v1/tasks/${record.id}/cancel`,{});await reconcile();
  const r=await api(`/v1/tasks/${record.id}/continue`,{operationId:crypto.randomUUID(),text:"No cancelled restart"});expect(r.status).toBe(409);expect(r.data.error.code).toBe("task_cancelled");expect((await api(`/v1/tasks/${record.id}`)).data.task.status).toBe("cancelled");
 });
 it("expires reciprocal pre-submit task delegations and releases only after exact cancellation and result outboxes acknowledge across eviction",async()=>{
  const a=await bot(),b=await bot(),ta=await task(a,"",false),tb=await task(b,"",false),pairs=[{source:a,target:b,record:ta},{source:b,target:a,record:tb}],ids:string[]=[];
  for(const {source,target,record} of pairs) {
    await api(`/v1/tasks/${record.id}/messages`);await api(`/v1/bots/${target.id}/messages`);
    const now=new Date().toISOString(),run:Run={id:crypto.randomUUID(),botId:source.id,operationId:crypto.randomUUID(),model:source.model,status:"completed",createdAt:now,updatedAt:now};
    await runInDurableObject(bindings.BOT.get(bindings.BOT.idFromName(`owner:task:${record.id}`)),(_,state)=>{state.storage.sql.exec("INSERT INTO runs(id,operation_id,fingerprint,native_operation_id,data) VALUES(?,?,?,?,?)",run.id,run.operationId,"fixture",run.operationId,JSON.stringify(run));});
    const id=crypto.randomUUID();ids.push(id);
    await runInDurableObject(registry(),(_,state)=>{
      state.storage.sql.exec("UPDATE tasks SET data=? WHERE id=?",JSON.stringify({...record,status:"running"}),record.id);
      state.storage.sql.exec("INSERT INTO task_slots(bot_id,task_id,token,generation,updated_at) VALUES(?,?,?,?,?)",source.id,record.id,crypto.randomUUID(),1,Date.now());
      const delegation={id,sourceBotId:source.id,sourceBotName:source.name,sourceRunId:run.id,targetBotId:target.id,targetBotName:target.name,path:[source.id,target.id],status:"queued",createdAt:new Date(Date.now()-24*60*60*1000-1).toISOString(),updatedAt:now};
      state.storage.sql.exec("INSERT INTO agent_deliveries(id,source_bot_id,operation_id,fingerprint,phase,next_at,data) VALUES(?,?,?,?,'submit',0,?)",id,source.id,crypto.randomUUID(),"fixture",JSON.stringify({delegation,text:"Reciprocal task request",kind:"bot",sourceTaskId:record.id}));
    });
  }
  await evictDurableObject(registry());expect(await runDurableObjectAlarm(registry())).toBe(true);
  await runInDurableObject(registry(),(_,state)=>{for(const id of ids){const row=state.storage.sql.exec<{phase:string;data:string}>("SELECT phase,data FROM agent_deliveries WHERE id=?",id).one();expect(row.phase).toBe("cancel");expect(JSON.parse(row.data).delegation).toMatchObject({status:"cancelled",error:expect.stringContaining("24-hour")});}});
  expect((await slot(a))?.task_id).toBe(ta.id);expect((await slot(b))?.task_id).toBe(tb.id);
  await evictDurableObject(registry());expect(await runDurableObjectAlarm(registry())).toBe(true);
  for(let n=0;n<ids.length;n++){const target=pairs[n].target;await runInDurableObject(root(target),(_,state)=>expect(state.storage.sql.exec("SELECT 1 FROM cancelled_agent_inputs WHERE operation_id=?",`delegate:${ids[n]}`).toArray()).toHaveLength(1));}
  await runInDurableObject(registry(),(_,state)=>{for(const id of ids)expect(state.storage.sql.exec<{phase:string}>("SELECT phase FROM agent_deliveries WHERE id=?",id).one().phase).toBe("result");});
  expect((await slot(a))?.task_id).toBe(ta.id);expect((await slot(b))?.task_id).toBe(tb.id);
  expect(await runDurableObjectAlarm(registry())).toBe(true);await terminal(ta.id,"completed");await terminal(tb.id,"completed");await reconcile();
  expect(await slot(a)).toBeUndefined();expect(await slot(b)).toBeUndefined();
  await runInDurableObject(registry(),(_,state)=>{for(const id of ids){const row=state.storage.sql.exec<{phase:string;data:string}>("SELECT phase,data FROM agent_deliveries WHERE id=?",id).one();expect(row.phase).toBe("done");expect(JSON.parse(row.data).delegation.status).toBe("cancelled");expect(JSON.parse(row.data).result).toContain("24-hour lifetime");}});
 });

});
