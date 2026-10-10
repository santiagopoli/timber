import {env,exports} from "cloudflare:workers";
import {evictDurableObject,runInDurableObject} from "cloudflare:test";
import {describe,expect,it} from "vitest";
import type {Approval,Bot,ComputerProvider,Run,Task} from "@botspace/contracts";
import type {AgentRuntime,RuntimeSubagent} from "../packages/runtime/src/types";
import type {Env} from "../apps/api/src/env";

const bindings=env as unknown as Env;
const api=(path:string,input?:unknown)=>exports.default.fetch(`https://timber.test${path}`,{method:input===undefined?"GET":"POST",headers:{authorization:"Bearer test-only-botspace-owner-token-000000","content-type":"application/json"},...(input===undefined?{}:{body:JSON.stringify(input)})});
const registry=()=>bindings.WORKSPACE.get(bindings.WORKSPACE.idFromName("owner"));
const botStub=(bot:Bot)=>bindings.BOT.get(bindings.BOT.idFromName(`owner:${bot.id}`));
const taskStub=(task:Task)=>bindings.BOT.get(bindings.BOT.idFromName(`owner:task:${task.id}`));
type Internals={
  runtime:AgentRuntime;
  computer:ComputerProvider;
  admit(op:string):Promise<void>;
  enqueueAgentContinuation(source:Run,op:string,text:string):Promise<void>;
  deleteTaskConversation(taskId:string,botId:string):Promise<void>;
  finishApproval(approval:Approval):Promise<void>;
  recover():Promise<void>;
  project(event:{type:string;operationId:string;data:Record<string,unknown>}):Promise<void>;
};
async function setupBot():Promise<Bot>{
  const response=await api("/v1/bots",{name:"Task lifecycle fixture"});
  expect(response.status).toBe(201);
  const {bot}=await response.json<{bot:Bot}>();
  const messages=await api(`/v1/bots/${bot.id}/messages`);
  expect(messages.status).toBe(200);
  // Complete the read so unsafe eviction does not wait on an open DO response.
  await messages.text();
  return bot;
}
async function setupTask(bot:Bot):Promise<Task>{
  const response=await api("/v1/tasks",{operationId:crypto.randomUUID(),title:"Lifecycle regression",description:"",botId:bot.id,startImmediately:false});
  expect(response.status).toBe(201);
  const {task}=await response.json<{task:Task}>();
  const messages=await api(`/v1/tasks/${task.id}/messages`);
  expect(messages.status).toBe(200);
  // Complete the read so unsafe eviction does not wait on an open DO response.
  await messages.text();
  return task;
}
async function setTask(task:Task,status:Task["status"],holdSlot=false){
  await runInDurableObject(registry(),(_instance,state)=>{
    state.storage.sql.exec("UPDATE tasks SET data=? WHERE id=?",JSON.stringify({...task,status}),task.id);
    if(holdSlot)state.storage.sql.exec("INSERT INTO task_slots(bot_id,task_id,token,generation,updated_at) VALUES(?,?,?,?,?)",task.botId,task.id,crypto.randomUUID(),1,Date.now());
  });
}
function insertRun(state:DurableObjectState,bot:Bot,extra:Partial<Run>={}):Run{
  const now=new Date().toISOString(),run:Run={id:crypto.randomUUID(),botId:bot.id,operationId:crypto.randomUUID(),model:bot.model,status:"completed",createdAt:now,updatedAt:now,...extra};
  state.storage.sql.exec("INSERT INTO runs(id,operation_id,fingerprint,native_operation_id,data) VALUES(?,?,?,?,?)",run.id,run.operationId,"fixture",run.operationId,JSON.stringify(run));
  state.storage.sql.exec("INSERT INTO submissions(operation_id,run_id,text,admitted,subagent_id) VALUES(?,?,?,1,?)",run.operationId,run.id,"Previously admitted lifecycle fixture",run.subagentId??null);
  return run;
}
function insertProcess(state:DurableObjectState,run:Run,processId:string,registered=false){
  const action={type:"exec",command:"background lifecycle fixture"};
  state.storage.sql.exec("INSERT INTO run_processes(process_id,run_id,subagent_id,action,input,status,result,dispatch_state) VALUES(?,?,?,?,?,'running',?,?)",processId,run.id,run.subagentId??null,JSON.stringify(action),JSON.stringify({command:action.command}),registered?null:JSON.stringify({operationId:processId,processId,status:"running"}),registered?"registered":"received");
}

// All native calls use tests/fixtures/runtime.ts. Computer effects below are
// deterministic provider mocks; no real command, container or model is invoked.
describe("internal continuation admission",()=>{
  it("does not admit an ordinary-bot report while another task owns its computer",async()=>{
    const bot=await setupBot(),task=await setupTask(bot);
    await setTask(task,"running",true);
    await runInDurableObject(botStub(bot),async(instance,state)=>{
      const target=instance as unknown as Internals,parent=insertRun(state,bot),op=`subagent-report:${crypto.randomUUID()}`,admit=target.admit;
      let nativeAdmissions=0;
      target.admit=async()=>{nativeAdmissions++;};
      try{
        await expect(target.enqueueAgentContinuation(parent,op,"Delayed child report")).rejects.toMatchObject({code:"computer_busy"});
        expect(state.storage.sql.exec("SELECT id FROM runs WHERE operation_id=?",op).toArray()).toHaveLength(0);
        expect(nativeAdmissions).toBe(0);
      }finally{target.admit=admit;}
    });
    await runInDurableObject(registry(),(_instance,state)=>expect(state.storage.sql.exec<{task_id:string}>("SELECT task_id FROM task_slots WHERE bot_id=?",bot.id).one().task_id).toBe(task.id));
  });

  it.each(["completed","failed"] as const)("does not reopen a %s task for a late native report",async status=>{
    const bot=await setupBot(),task=await setupTask(bot);
    await setTask(task,status);
    await runInDurableObject(taskStub(task),async(instance,state)=>{
      const target=instance as unknown as Internals,parent=insertRun(state,bot,{status}),op=`subagent-report:${crypto.randomUUID()}`,admit=target.admit;
      let nativeAdmissions=0;
      target.admit=async()=>{nativeAdmissions++;};
      try{
        // A terminal report may be explicitly rejected or acknowledged without
        // continuation. In either case it must not create executable host work.
        await target.enqueueAgentContinuation(parent,op,"Late result after finalization").catch(()=>{});
        expect(state.storage.sql.exec("SELECT id FROM runs WHERE operation_id=?",op).toArray()).toHaveLength(0);
        expect(nativeAdmissions).toBe(0);
      }finally{target.admit=admit;}
    });
    await runInDurableObject(registry(),(_instance,state)=>{
      expect(state.storage.sql.exec("SELECT 1 FROM task_slots WHERE bot_id=?",bot.id).toArray()).toHaveLength(0);
      expect(JSON.parse(state.storage.sql.exec<{data:string}>("SELECT data FROM tasks WHERE id=?",task.id).one().data).status).toBe(status);
    });
  });

  it("admits an internal continuation under its active task slot rather than an ordinary-bot slot",async()=>{
    const bot=await setupBot(),task=await setupTask(bot);
    await setTask(task,"running",true);
    const op=`subagent-report:${crypto.randomUUID()}`;
    await runInDurableObject(taskStub(task),async(instance,state)=>{
      const target=instance as unknown as Internals,parent=insertRun(state,bot),admit=target.admit;
      target.admit=async()=>{};
      try{
        await target.enqueueAgentContinuation(parent,op,"Task-scoped child result");
        const saved=JSON.parse(state.storage.sql.exec<{data:string}>("SELECT data FROM runs WHERE operation_id=?",op).one().data) as Run;
        expect(saved).toMatchObject({parentRunId:parent.id,status:"queued"});
      }finally{target.admit=admit;}
    });
    await runInDurableObject(registry(),(_instance,state)=>expect(state.storage.sql.exec<{task_id:string}>("SELECT task_id FROM task_slots WHERE bot_id=?",bot.id).one().task_id).toBe(task.id));
    expect((await (await api(`/v1/bots/${bot.id}/messages`)).json<{messages:unknown[]}>()).messages).toEqual([]);
  });
});

describe("task cleanup acknowledgement",()=>{
  it("cancels a completed root's live process and retains its tombstone/journal through outage and eviction",async()=>{
    const bot=await setupBot(),task=await setupTask(bot),processId=crypto.randomUUID();
    let attempts=0;
    await runInDurableObject(taskStub(task),async(instance,state)=>{
      const target=instance as unknown as Internals,parent=insertRun(state,bot),provider=target.computer;
      insertProcess(state,parent,processId);
      target.computer={...provider,cancel:async(_bot,id)=>{attempts++;expect(id).toBe(processId);throw new Error("Cancellation transport unavailable");}};
      try{
        await expect(target.deleteTaskConversation(task.id,bot.id)).rejects.toMatchObject({code:"task_cleanup_pending"});
        expect(attempts).toBeGreaterThan(0);
        expect(state.storage.sql.exec<{cancel_requested:number}>("SELECT cancel_requested FROM run_processes WHERE process_id=?",processId).one().cancel_requested).toBe(1);
        expect(state.storage.sql.exec("SELECT 1 FROM task_deletion WHERE id=1").toArray()).toHaveLength(1);
        expect(state.storage.sql.exec("SELECT 1 FROM bot_deletion WHERE id=1").toArray()).toHaveLength(0);
        expect(state.storage.sql.exec("SELECT 1 FROM runs WHERE id=?",parent.id).toArray()).toHaveLength(1);
      }finally{target.computer=provider;}
    });
    await evictDurableObject(taskStub(task));
    await runInDurableObject(taskStub(task),async(instance,state)=>{
      const target=instance as unknown as Internals,provider=target.computer;
      target.computer={...provider,cancel:async(_bot,id)=>{attempts++;expect(id).toBe(processId);return {operationId:id,processId:id,status:"cancelled"};}};
      try{
        expect(state.storage.sql.exec("SELECT 1 FROM run_processes WHERE process_id=?",processId).toArray()).toHaveLength(1);
        await target.deleteTaskConversation(task.id,bot.id);
        expect(state.storage.sql.exec("SELECT 1 FROM run_processes").toArray()).toHaveLength(0);
        expect(state.storage.sql.exec("SELECT 1 FROM task_deletion WHERE id=1").toArray()).toHaveLength(0);
        expect(state.storage.sql.exec("SELECT 1 FROM bot_deletion WHERE id=1").toArray()).toHaveLength(1);
      }finally{target.computer=provider;}
    });
    expect(attempts).toBeGreaterThan(1);
  });

  it("retains native cancellation across cleanup-only eviction until exact dispatch is acknowledged",async()=>{
    const bot=await setupBot(),task=await setupTask(bot);
    let operationId="",id="",cancels=0;
    await runInDurableObject(taskStub(task),async(instance,state)=>{
      const target=instance as unknown as Internals,parent=insertRun(state,bot),runtime=target.runtime;
      operationId=parent.operationId;id=`run:${operationId}`;
      await state.storage.put(`fixture-runtime:${operationId}`,{text:"Previously accepted native input",status:"running"});
      state.storage.sql.exec("INSERT INTO pending_run_cancellations(id,operation_id) VALUES(?,?)",id,operationId);
      target.runtime={...runtime,cancel:async()=>{cancels++;throw new Error("Native cancellation unavailable");},destroy:async()=>{}};
      try{
        await expect(target.deleteTaskConversation(task.id,bot.id)).rejects.toMatchObject({code:"task_cleanup_pending"});
        expect(cancels).toBeGreaterThan(0);
        expect(state.storage.sql.exec("SELECT 1 FROM pending_run_cancellations WHERE id=?",id).toArray()).toHaveLength(1);
        expect(state.storage.sql.exec("SELECT 1 FROM task_deletion WHERE id=1").toArray()).toHaveLength(1);
        expect(state.storage.sql.exec("SELECT 1 FROM bot_deletion WHERE id=1").toArray()).toHaveLength(0);
        expect(state.storage.sql.exec("SELECT 1 FROM runs WHERE id=?",parent.id).toArray()).toHaveLength(1);
      }finally{target.runtime=runtime;}
    });
    await evictDurableObject(taskStub(task));
    await runInDurableObject(taskStub(task),async(instance,state)=>{
      const target=instance as unknown as Internals,runtime=target.runtime;
      let nativeAdmissions=0;
      target.runtime={...runtime,submit:async()=>{nativeAdmissions++;throw new Error("Cleanup must not resume native scheduling");},cancel:async(op,options)=>{expect(op).toBe(operationId);cancels++;return runtime.cancel(op,options);}};
      try{
        expect(state.storage.sql.exec("SELECT 1 FROM pending_run_cancellations WHERE id=?",id).toArray()).toHaveLength(1);
        await target.deleteTaskConversation(task.id,bot.id);
        expect(nativeAdmissions).toBe(0);
        expect(state.storage.sql.exec("SELECT 1 FROM pending_run_cancellations").toArray()).toHaveLength(0);
        expect(state.storage.sql.exec("SELECT 1 FROM task_deletion WHERE id=1").toArray()).toHaveLength(0);
        expect(state.storage.sql.exec("SELECT 1 FROM bot_deletion WHERE id=1").toArray()).toHaveLength(1);
      }finally{target.runtime=runtime;}
    });
    expect(cancels).toBeGreaterThan(1);
  });

  it("acknowledges child cancellation callbacks while the task is in cleanup-only mode",async()=>{
    const bot=await setupBot(),task=await setupTask(bot);
    await runInDurableObject(taskStub(task),async(instance,state)=>{
      const target=instance as unknown as Internals,parent=insertRun(state,bot),runtime=target.runtime,id=crypto.randomUUID();
      const child:RuntimeSubagent={id,name:"Cleanup child",task:"Native background work",model:bot.model,parentOperationId:parent.operationId,operationId:`fixture-child:${id}`,status:"running",createdAt:parent.createdAt,updatedAt:parent.updatedAt};
      insertRun(state,bot,{operationId:child.operationId,subagentId:id,parentRunId:parent.id,status:"running"});
      let childCancellations=0;
      target.runtime={...runtime,cancel:async()=>true,cancelSubagent:async(agentId)=>{
        expect(agentId).toBe(id);childCancellations++;
        // Real native cancellation publishes these events before acknowledging
        // its durable session intent. Cleanup projection must not call active().
        await target.project({type:"subagent.stopped",operationId:parent.operationId,data:{subagent:{...child,status:"cancelled"}}});
        return true;
      },destroy:async()=>{}};
      try{
        await target.deleteTaskConversation(task.id,bot.id);
        expect(childCancellations).toBe(1);
        expect(state.storage.sql.exec("SELECT 1 FROM pending_run_cancellations").toArray()).toHaveLength(0);
        expect(state.storage.sql.exec("SELECT 1 FROM bot_deletion WHERE id=1").toArray()).toHaveLength(1);
      }finally{target.runtime=runtime;}
    });
  });
});

describe("abandoned registered approval processes",()=>{
  it.each(["executing","interrupted"] as const)("recovery fences registered exec with %s approval and terminal owner, without executing it",async status=>{
    const bot=await setupBot();
    await runInDurableObject(botStub(bot),async(instance,state)=>{
      const target=instance as unknown as Internals,parent=insertRun(state,bot,{status:"failed",error:"Recorded model failure"}),provider=target.computer,processId=crypto.randomUUID();
      const approval:Approval={id:crypto.randomUUID(),botId:bot.id,runId:parent.id,operationId:processId,action:{type:"exec",command:"background lifecycle fixture"},status,createdAt:parent.createdAt,expiresAt:new Date(Date.now()+60_000).toISOString()};
      state.storage.sql.exec("INSERT INTO approvals(id,operation_id,fingerprint,data) VALUES(?,?,?,?)",approval.id,processId,"fixture",JSON.stringify(approval));
      insertProcess(state,parent,processId,true);
      let starts=0,cancels=0;
      target.computer={...provider,exec:async()=>{starts++;throw new Error("Abandoned exec must never dispatch");},cancel:async(_bot,id)=>{cancels++;expect(id).toBe(processId);return {operationId:id,processId:id,status:"cancelled"};}};
      try{
        await target.recover();
        expect(starts).toBe(0);expect(cancels).toBe(1);
        expect(state.storage.sql.exec<{status:string;cancel_requested:number}>("SELECT status,cancel_requested FROM run_processes WHERE process_id=?",processId).one()).toEqual({status:"cancelled",cancel_requested:0});
        await target.recover();
        expect(cancels).toBe(1);
        expect(JSON.parse(state.storage.sql.exec<{data:string}>("SELECT data FROM runs WHERE id=?",parent.id).one().data)).toMatchObject({status:"failed",error:"Recorded model failure"});
      }finally{target.computer=provider;}
    });
  });
});

async function seedChild(bot:Bot,status:RuntimeSubagent["status"],stop?:"session"|"parent",task?:Task):Promise<RuntimeSubagent>{
  return runInDurableObject(task?taskStub(task):botStub(bot),async(_instance,state)=>{
    const parent=insertRun(state,bot),id=crypto.randomUUID(),operationId=`fixture-child:${id}`;
    const child:RuntimeSubagent={id,name:"Follow-up lifecycle child",task:"Original task",model:bot.model,parentOperationId:parent.operationId,operationId,status,createdAt:parent.createdAt,updatedAt:parent.updatedAt,...(status==="failed"?{error:"Saved failure"}:{result:"Saved answer"})};
    const childRun=insertRun(state,bot,{operationId,subagentId:id,parentRunId:parent.id,status});
    await state.storage.put(`fixture-subagent:${id}`,child);
    if(stop)state.storage.sql.exec("INSERT INTO run_stops(run_id) VALUES(?)",stop==="parent"?parent.id:childRun.id);
    return child;
  });
}

describe("completed subagent follow-up lifecycle",()=>{
  it.each(["completed","failed"] as const)("accepts a fresh follow-up to an unstopped %s child without rewriting its earlier outcome",async status=>{
    const bot=await setupBot(),child=await seedChild(bot,status),operationId=crypto.randomUUID(),path=`/v1/bots/${bot.id}/agents/${child.id}/messages`;
    const response=await api(path,{operationId,text:"New explicit child task"});
    expect(response.status).toBe(202);
    const {run}=await response.json<{run:Run}>();
    expect(run).toMatchObject({subagentId:child.id,operationId});
    const replay=await api(path,{operationId,text:"New explicit child task"});
    expect(replay.status).toBe(202);
    expect((await replay.json<{run:Run}>()).run.id).toBe(run.id);
    await runInDurableObject(botStub(bot),(_instance,state)=>{
      const historical=JSON.parse(state.storage.sql.exec<{data:string}>("SELECT data FROM runs WHERE operation_id=?",child.operationId).one().data) as Run;
      expect(historical.status).toBe(status);
      expect(state.storage.sql.exec("SELECT 1 FROM runs WHERE operation_id=?",operationId).toArray()).toHaveLength(1);
    });
  });

  it.each(["cancelled","session","parent"] as const)("rejects follow-up when child lifecycle is fenced by %s",async fence=>{
    const bot=await setupBot(),child=await seedChild(bot,fence==="cancelled"?"cancelled":"completed",fence==="cancelled"?undefined:fence),operationId=crypto.randomUUID();
    expect((await api(`/v1/bots/${bot.id}/agents/${child.id}/messages`,{operationId,text:"Must not restart stopped work"})).status).toBe(409);
    await runInDurableObject(botStub(bot),(_instance,state)=>expect(state.storage.sql.exec("SELECT 1 FROM runs WHERE operation_id=?",operationId).toArray()).toHaveLength(0));
  });

  it("rejects a child follow-up behind the task-wide durable cancellation fence",async()=>{
    const bot=await setupBot(),task=await setupTask(bot);
    await setTask(task,"running",true);
    const child=await seedChild(bot,"completed",undefined,task),operationId=crypto.randomUUID();
    await runInDurableObject(taskStub(task),(_instance,state)=>{state.storage.sql.exec("INSERT INTO task_cancel_fences(task_id,created_at) VALUES(?,?)",task.id,Date.now());});
    expect((await api(`/v1/tasks/${task.id}/agents/${child.id}/messages`,{operationId,text:"Must not reopen the task"})).status).toBe(409);
    await runInDurableObject(taskStub(task),(_instance,state)=>expect(state.storage.sql.exec("SELECT 1 FROM runs WHERE operation_id=?",operationId).toArray()).toHaveLength(0));
  });
});
