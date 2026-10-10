import {env,exports} from "cloudflare:workers";
import {runInDurableObject} from "cloudflare:test";
import {describe,expect,it} from "vitest";
import type {AgentDelegation,Bot,Message,Run,Task} from "@botspace/contracts";
import {AgentCoordinator} from "../apps/api/src/agent-coordination";
import type {Env} from "../apps/api/src/env";

const bindings=env as unknown as Env;
type Call={identity:string;path:string;taskId:string|null;input?:Record<string,unknown>};
type Delivery={delegation:AgentDelegation;text:string;kind:"bot";sourceTaskId?:string;result?:string};
type Internals={
  source(input:Record<string,unknown>):Promise<{run:Run}>;
  processOnce(id:string):Promise<void>;
  process(id:string):Promise<void>;
};
const registry=()=>bindings.WORKSPACE.get(bindings.WORKSPACE.idFromName("owner"));
const bot=():Bot=>({id:crypto.randomUUID(),name:"Task coordinator fixture",instructions:"",runtime:"pi",model:"@cf/test",allowNamedAgents:true,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
const run=(owner:Bot,status:Run["status"]="running"):Run=>({id:crypto.randomUUID(),botId:owner.id,operationId:crypto.randomUUID(),status,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});

function fixture(state:DurableObjectState) {
  const source=bot(),target=bot(),sourceRun=run(source),targetRun=run(target,"completed"),taskId=crypto.randomUUID();
  for(const value of [source,target])state.storage.sql.exec("INSERT INTO bots(id,data) VALUES(?,?)",value.id,JSON.stringify(value));
  const saveTask=(patch:Record<string,unknown>={})=>state.storage.sql.exec("INSERT INTO tasks(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",taskId,JSON.stringify({id:taskId,botId:source.id,status:"running",...patch}));
  saveTask();
  const calls:Call[]=[],reservations:Array<{botId:string;taskId?:string}>=[],names=new Map<string,string>();
  let failCancellation=false,stopOnResult=false;
  const namespace={
    idFromName(name:string){const id=bindings.BOT.idFromName(name);names.set(id.toString(),name);return id;},
    get(id:DurableObjectId){return {fetch:async(request:Request)=>{
      const identity=names.get(id.toString())!,path=new URL(request.url).pathname;
      const input=request.method==="POST"?await request.json<Record<string,unknown>>():undefined;
      calls.push({identity,path,taskId:request.headers.get("x-timber-task-id"),...(input?{input}:{})});
      if(path==="/agent-cancel"&&failCancellation)throw new Error("Cancellation transport unavailable");
      if(path==="/agent-results"&&stopOnResult)saveTask({status:"cancelling",cancelRequested:true});
      if(path.startsWith("/runs/"))return Response.json({run:identity===`owner:${target.id}`?targetRun:sourceRun});
      if(path==="/agent-messages")return Response.json({run:targetRun});
      if(path==="/messages")return Response.json({messages:[{id:crypto.randomUUID(),botId:target.id,runId:targetRun.id,role:"assistant",kind:"final",text:"Task result",createdAt:targetRun.createdAt}]});
      return Response.json({received:true,cancelled:true});
    }};},
  } as unknown as Env["BOT"];
  const reopen=()=>new AgentCoordinator(state,{...bindings,BOT:namespace},async()=>{},(botId,_op,taskId)=>{reservations.push({botId,...(taskId?{taskId}:{})});return crypto.randomUUID();},()=>{});
  const coordinator=reopen();
  const internals=coordinator as unknown as Internals;
  const input={sourceBotId:source.id,sourceRunId:sourceRun.id,sourceTaskId:taskId,operationId:crypto.randomUUID()};
  const request=(path:string,input:Record<string,unknown>)=>coordinator.fetch(new Request(`https://workspace${path}`,{method:"POST",headers:{"content-type":"application/json","x-timber-internal":"agents"},body:JSON.stringify(input)}));
  const seed=(phase:string,scoped=true):Delivery=>{
    const now=new Date().toISOString(),delegation:AgentDelegation={id:crypto.randomUUID(),sourceBotId:source.id,sourceBotName:source.name,sourceRunId:sourceRun.id,targetBotId:target.id,targetBotName:target.name,path:[source.id,target.id],status:"queued",createdAt:now,updatedAt:now};
    const delivery:Delivery={delegation,text:"Delegated task",kind:"bot",...(scoped?{sourceTaskId:taskId}:{}),...(phase==="result"?{result:"Task result"}:{})};
    state.storage.sql.exec("INSERT INTO agent_deliveries(id,source_bot_id,operation_id,fingerprint,phase,next_at,data) VALUES(?,?,?,?,?,0,?)",delegation.id,source.id,crypto.randomUUID(),"fixture",phase,JSON.stringify(delivery));
    return delivery;
  };
  const row=(id:string)=>state.storage.sql.exec<{phase:string;data:string}>("SELECT phase,data FROM agent_deliveries WHERE id=?",id).toArray()[0];
  return {source,target,sourceRun,taskId,saveTask,calls,reservations,coordinator,internals,reopen,input,request,seed,row,stopDuringResult:()=>{stopOnResult=true;},setCancelFailure:(value:boolean)=>{failCancellation=value;}};
}

describe("task-scoped named-bot coordinator",()=>{
  it("resolves task source runs in their separate conversation and validates assigned membership",async()=>{
    await runInDurableObject(registry(),async(_instance,state)=>{
      const f=fixture(state);
      expect((await f.internals.source(f.input)).run.id).toBe(f.sourceRun.id);
      expect(f.calls).toEqual([{identity:`owner:task:${f.taskId}`,path:`/runs/${f.sourceRun.id}`,taskId:f.taskId}]);
      f.calls.length=0;
      f.saveTask({botId:f.target.id});
      await expect(f.internals.source(f.input)).rejects.toMatchObject({code:"agent_source_mismatch"});
      expect(f.calls).toHaveLength(0);
      await expect(f.internals.source({...f.input,sourceTaskId:crypto.randomUUID()})).rejects.toMatchObject({status:404});
      await expect(f.internals.source({...f.input,sourceTaskId:"not-a-task"})).rejects.toMatchObject({code:"invalid_request"});
      f.saveTask({cancelRequested:true});
      await expect(f.internals.source(f.input)).rejects.toMatchObject({code:"run_inactive"});
    });
  });

  it("creates named bots from task runs, preserving idempotency and safe child policy",async()=>{
    await runInDurableObject(registry(),async(_instance,state)=>{
      const f=fixture(state),input={...f.input,name:"Task-created helper",instructions:"Review the task"};
      const created=await f.request("/agents/create",input);
      expect(created.status).toBe(201);
      const child=(await created.json<{bot:Bot}>()).bot;
      expect(child).toMatchObject({createdByBotId:f.source.id,computerApprovalMode:"ask",allowNamedAgents:false});
      const replay=await f.request("/agents/create",input);
      expect((await replay.json<{bot:Bot}>()).bot.id).toBe(child.id);
      await expect(f.request("/agents/create",{...input,sourceTaskId:undefined})).rejects.toMatchObject({code:"idempotency_conflict"});
      expect(f.calls.every(call=>call.identity===`owner:task:${f.taskId}`)).toBe(true);
    });
  });

  it("persists source scope and routes result admission back to the task, not its assigned bot",async()=>{
    await runInDurableObject(registry(),async(_instance,state)=>{
      const f=fixture(state),input={...f.input,targetBotId:f.target.id,text:"Investigate this task"};
      const response=await f.request("/agents/send",input);
      expect(response.status).toBe(202);
      const {delegation}=await response.json<{delegation:AgentDelegation}>();
      await f.internals.process(delegation.id);
      expect(JSON.parse(f.row(delegation.id).data).sourceTaskId).toBe(f.taskId);
      expect(f.calls.find(call=>call.path==="/agent-messages")).toMatchObject({identity:`owner:${f.target.id}`,taskId:null});
      const recovered=f.reopen() as unknown as Internals;
      await recovered.processOnce(delegation.id); // Observe from the persisted outbox.
      await recovered.processOnce(delegation.id); // Deliver using persisted task scope.
      expect(f.row(delegation.id).phase).toBe("done");
      expect(f.calls.find(call=>call.path==="/agent-results")).toMatchObject({identity:`owner:task:${f.taskId}`,taskId:f.taskId,input:{operationId:`agent-result:${delegation.id}`,text:"Task result"}});
      expect(f.reservations).toEqual([{botId:f.target.id},{botId:f.source.id,taskId:f.taskId}]);
      const replay=await f.request("/agents/send",input);
      expect((await replay.json<{delegation:AgentDelegation}>()).delegation.id).toBe(delegation.id);
      await expect(f.request("/agents/send",{...input,sourceTaskId:undefined})).rejects.toMatchObject({code:"idempotency_conflict"});
    });
  });

  it.each(["submit","result"] as const)("retains exact target cancellation through outages when a completed source task is stopped in %s phase",async phase=>{
    await runInDurableObject(registry(),async(_instance,state)=>{
      const f=fixture(state),delivery=f.seed(phase),id=delivery.delegation.id;
      f.sourceRun.status="completed";
      f.saveTask({status:"cancelling",cancelRequested:true});
      await f.internals.processOnce(id);
      expect(f.row(id).phase).toBe("cancel");
      expect(f.calls).toHaveLength(0);
      f.setCancelFailure(true);
      await f.internals.processOnce(id);
      expect(f.row(id).phase).toBe("cancel");
      f.setCancelFailure(false);
      await (f.reopen() as unknown as Internals).processOnce(id);
      expect(f.row(id).phase).toBe("done");
      expect(f.calls.filter(call=>call.path==="/agent-cancel").every(call=>call.identity===`owner:${f.target.id}`&&call.input?.operationId===`delegate:${id}`)).toBe(true);
      expect(f.calls.some(call=>call.path==="/agent-results"||call.path==="/agent-messages")).toBe(false);
    });
  });

  it("does not finish a result delivery when task Stop races its response",async()=>{
    await runInDurableObject(registry(),async(_instance,state)=>{
      const f=fixture(state),delivery=f.seed("result"),id=delivery.delegation.id;
      f.sourceRun.status="completed";f.stopDuringResult();
      await f.internals.processOnce(id);
      expect(f.row(id).phase).toBe("cancel");
      await f.internals.processOnce(id);
      expect(f.row(id).phase).toBe("done");
      expect(f.calls.filter(call=>call.path==="/agent-cancel")).toEqual([expect.objectContaining({identity:`owner:${f.target.id}`,input:{operationId:`delegate:${id}`}})]);
      expect(f.sourceRun.status).toBe("completed");
    });
  });

  it("redacts a removed task's delivery but retains cancellation until target acknowledgement",async()=>{
    await runInDurableObject(registry(),async(_instance,state)=>{
      const f=fixture(state),delivery=f.seed("submit"),id=delivery.delegation.id;
      state.storage.sql.exec("DELETE FROM tasks WHERE id=?",f.taskId);
      await f.internals.processOnce(id);
      expect(f.row(id).phase).toBe("cancel");
      expect(JSON.parse(f.row(id).data)).toMatchObject({text:"",delegation:{sourceBotName:"Deleted bot",targetBotName:""}});
      f.setCancelFailure(true);
      await f.internals.processOnce(id);
      expect(f.row(id).phase).toBe("cancel");
      f.setCancelFailure(false);
      await f.internals.processOnce(id);
      expect(f.row(id)).toBeUndefined();
      expect(f.calls.some(call=>call.path==="/agent-results")).toBe(false);
    });
  });

  it("keeps legacy ordinary-bot results on their original conversation and admission scope",async()=>{
    await runInDurableObject(registry(),async(_instance,state)=>{
      const f=fixture(state),delivery=f.seed("result",false);
      await f.internals.processOnce(delivery.delegation.id);
      expect(f.row(delivery.delegation.id).phase).toBe("done");
      expect(f.calls).toHaveLength(1);
      expect(f.calls[0]).toMatchObject({identity:`owner:${f.source.id}`,path:"/agent-results",taskId:null});
      expect(f.reservations).toEqual([{botId:f.source.id}]);
    });
  });
});


describe("task delegation scheduler integration",()=>{
  it("holds the task slot after its root completes and resumes the result only in that task conversation",async()=>{
    const api=(path:string,input?:unknown)=>exports.default.fetch(`https://timber.test${path}`,{
      method:input===undefined?"GET":"POST",
      headers:{authorization:"Bearer test-only-botspace-owner-token-000000","content-type":"application/json"},
      ...(input===undefined?{}:{body:JSON.stringify(input)}),
    });
    const createBot=async()=>{
      const response=await api("/v1/bots",{name:"Delegation scheduler fixture"});
      expect(response.status).toBe(201);
      return (await response.json<{bot:Bot}>()).bot;
    };
    const source=await createBot(),target=await createBot();
    const created=await api("/v1/tasks",{operationId:crypto.randomUUID(),title:"Background named delegation",description:"Continue after its result",botId:source.id,startImmediately:false});
    expect(created.status).toBe(201);
    const {task}=await created.json<{task:Task}>();
    const taskStub=bindings.BOT.get(bindings.BOT.idFromName(`owner:task:${task.id}`));
    const targetStub=bindings.BOT.get(bindings.BOT.idFromName(`owner:${target.id}`));
    // Initialize real BotDO identities through their authenticated routes. All
    // inference in this suite uses the deterministic fixture runtime, not a model.
    for(const path of [`/v1/tasks/${task.id}/messages`,`/v1/bots/${source.id}/messages`,`/v1/bots/${target.id}/messages`])expect((await api(path)).status).toBe(200);
    const sourceRun=run(source,"completed"),targetRun=run(target,"completed");
    const insertCompleted=(state:DurableObjectState,value:Run,text:string)=>{
      state.storage.sql.exec("INSERT INTO runs(id,operation_id,fingerprint,native_operation_id,data) VALUES(?,?,?,?,?)",value.id,value.operationId,"fixture",value.operationId,JSON.stringify(value));
      const message:Message={id:crypto.randomUUID(),botId:value.botId,runId:value.id,role:"assistant",kind:"final",text,createdAt:value.createdAt};
      state.storage.sql.exec("INSERT INTO messages(id,source_key,data) VALUES(?,?,?)",message.id,`fixture-answer:${value.id}`,JSON.stringify(message));
    };
    await runInDurableObject(taskStub,(_instance,state)=>insertCompleted(state,sourceRun,"Root finished; named helper remains active."));
    await runInDurableObject(targetStub,(_instance,state)=>insertCompleted(state,targetRun,"Named helper result for the isolated task."));
    const now=new Date().toISOString(),delegation:AgentDelegation={id:crypto.randomUUID(),sourceBotId:source.id,sourceBotName:source.name,sourceRunId:sourceRun.id,targetBotId:target.id,targetBotName:target.name,targetRunId:targetRun.id,path:[source.id,target.id],status:"running",createdAt:now,updatedAt:now};
    type Scheduler={reconcileComputerSlots():Promise<void>;agents:{process(id:string):Promise<void>}};
    await runInDurableObject(registry(),async(instance,state)=>{
      state.storage.sql.exec("UPDATE tasks SET data=? WHERE id=?",JSON.stringify({...task,status:"running"}),task.id);
      state.storage.sql.exec("INSERT INTO task_slots(bot_id,task_id,token,generation,updated_at) VALUES(?,?,?,?,?)",source.id,task.id,crypto.randomUUID(),1,Date.now());
      const delivery:Delivery={delegation,text:"Investigate the isolated task",kind:"bot",sourceTaskId:task.id};
      // Keep wall-clock alarms out of this assertion; explicitly advance each
      // durable outbox phase below using the production coordinator.
      state.storage.sql.exec("INSERT INTO agent_deliveries(id,source_bot_id,operation_id,fingerprint,phase,next_at,data) VALUES(?,?,?,?,'observe',?,?)",delegation.id,source.id,crypto.randomUUID(),"fixture",Date.now()+60_000,JSON.stringify(delivery));
      await (instance as unknown as Scheduler).reconcileComputerSlots();
      expect(state.storage.sql.exec<{task_id:string}>("SELECT task_id FROM task_slots WHERE bot_id=?",source.id).one().task_id).toBe(task.id);
      expect(JSON.parse(state.storage.sql.exec<{data:string}>("SELECT data FROM tasks WHERE id=?",task.id).one().data).status).toBe("running");
    });
    expect((await api(`/v1/bots/${source.id}/messages`,{operationId:crypto.randomUUID(),text:"Ordinary chat waits without stealing task lease"})).status).toBe(202);
    await runInDurableObject(registry(),async(instance,state)=>{
      const scheduler=instance as unknown as Scheduler;
      await scheduler.agents.process(delegation.id); // Observe target completion.
      expect(state.storage.sql.exec<{phase:string}>("SELECT phase FROM agent_deliveries WHERE id=?",delegation.id).one().phase).toBe("result");
      await scheduler.reconcileComputerSlots();
      expect(state.storage.sql.exec<{task_id:string}>("SELECT task_id FROM task_slots WHERE bot_id=?",source.id).one().task_id).toBe(task.id);
      await scheduler.agents.process(delegation.id); // Admit task result continuation.
      expect(state.storage.sql.exec<{phase:string}>("SELECT phase FROM agent_deliveries WHERE id=?",delegation.id).one().phase).toBe("done");
    });
    let continuation:Run|undefined;
    for(let attempt=0;attempt<100;attempt++){
      const response=await api(`/v1/tasks/${task.id}/runs`);
      expect(response.status).toBe(200);
      continuation=(await response.json<{runs:Run[]}>()).runs.find(value=>value.operationId===`agent-result:${delegation.id}`);
      if(continuation?.status==="completed")break;
      await new Promise(resolve=>setTimeout(resolve,5));
    }
    expect(continuation).toMatchObject({operationId:`agent-result:${delegation.id}`,parentRunId:sourceRun.id,status:"completed"});
    const taskMessages=(await (await api(`/v1/tasks/${task.id}/messages`)).json<{messages:Message[]}>()).messages;
    expect(taskMessages).toContainEqual(expect.objectContaining({runId:sourceRun.id,text:"Named helper result for the isolated task.",provenance:expect.objectContaining({kind:"delegation_result",delegationId:delegation.id})}));
    expect(taskMessages.some(message=>message.runId===continuation!.id&&message.role==="assistant")).toBe(true);
    expect((await (await api(`/v1/bots/${source.id}/messages`)).json<{messages:Message[]}>()).messages).toEqual([expect.objectContaining({role:"user",text:"Ordinary chat waits without stealing task lease"})]);
    await runInDurableObject(registry(),async(instance,state)=>{
      await (instance as unknown as Scheduler).reconcileComputerSlots();
      expect(state.storage.sql.exec("SELECT 1 FROM task_slots WHERE bot_id=?",source.id).toArray()).toHaveLength(0);
      expect(JSON.parse(state.storage.sql.exec<{data:string}>("SELECT data FROM tasks WHERE id=?",task.id).one().data).status).toBe("completed");
    });
  },60000);
});


describe("task delegation cancellation scheduler integration",()=>{
  it("retains the source task slot until exact named cancellation is acknowledged, without reopening its completed root",async()=>{
    const api=(path:string,input?:unknown)=>exports.default.fetch(`https://timber.test${path}`,{method:input===undefined?"GET":"POST",headers:{authorization:"Bearer test-only-botspace-owner-token-000000","content-type":"application/json"},...(input===undefined?{}:{body:JSON.stringify(input)})});
    const createBot=async()=>{
      const response=await api("/v1/bots",{name:"Cancellation scheduler fixture"});
      expect(response.status).toBe(201);
      return (await response.json<{bot:Bot}>()).bot;
    };
    const source=await createBot(),target=await createBot();
    const created=await api("/v1/tasks",{operationId:crypto.randomUUID(),title:"Stop background named work",description:"",botId:source.id,startImmediately:false});
    expect(created.status).toBe(201);
    const {task}=await created.json<{task:Task}>(),id=crypto.randomUUID();
    const taskStub=bindings.BOT.get(bindings.BOT.idFromName(`owner:task:${task.id}`));
    const targetStub=bindings.BOT.get(bindings.BOT.idFromName(`owner:${target.id}`));
    for(const path of [`/v1/tasks/${task.id}/messages`,`/v1/bots/${source.id}/messages`,`/v1/bots/${target.id}/messages`])expect((await api(path)).status).toBe(200);
    const sourceRun=run(source,"completed"),targetRun={...run(target),operationId:`delegate:${id}`};
    const insert=(state:DurableObjectState,value:Run)=>state.storage.sql.exec("INSERT INTO runs(id,operation_id,fingerprint,native_operation_id,data) VALUES(?,?,?,?,?)",value.id,value.operationId,"fixture",value.operationId,JSON.stringify(value));
    await runInDurableObject(taskStub,(_instance,state)=>{insert(state,sourceRun);});
    await runInDurableObject(targetStub,(_instance,state)=>{insert(state,targetRun);});
    const now=new Date().toISOString(),delegation:AgentDelegation={id,sourceBotId:source.id,sourceBotName:source.name,sourceRunId:sourceRun.id,targetBotId:target.id,targetBotName:target.name,targetRunId:targetRun.id,path:[source.id,target.id],status:"cancelled",error:"The source task was cancelled.",createdAt:now,updatedAt:now};
    type Scheduler={reconcileComputerSlots():Promise<void>;agents:{process(id:string):Promise<void>}};
    await runInDurableObject(registry(),async(instance,state)=>{
      state.storage.sql.exec("UPDATE tasks SET data=? WHERE id=?",JSON.stringify({...task,status:"cancelling",cancelRequested:true}),task.id);
      state.storage.sql.exec("INSERT INTO task_slots(bot_id,task_id,token,generation,updated_at) VALUES(?,?,?,?,?)",source.id,task.id,crypto.randomUUID(),1,Date.now());
      const delivery:Delivery={delegation,text:"Background named work",kind:"bot",sourceTaskId:task.id};
      state.storage.sql.exec("INSERT INTO agent_deliveries(id,source_bot_id,operation_id,fingerprint,phase,next_at,data) VALUES(?,?,?,?,'cancel',?,?)",id,source.id,crypto.randomUUID(),"fixture",Date.now()+60_000,JSON.stringify(delivery));
      await (instance as unknown as Scheduler).reconcileComputerSlots();
      expect(state.storage.sql.exec<{task_id:string}>("SELECT task_id FROM task_slots WHERE bot_id=?",source.id).one().task_id).toBe(task.id);
      expect(JSON.parse(state.storage.sql.exec<{data:string}>("SELECT data FROM tasks WHERE id=?",task.id).one().data).status).toBe("cancelling");
    });
    let original:((request:Request)=>Promise<Response>)|undefined;
    await runInDurableObject(targetStub,instance=>{
      const object=instance as unknown as {fetch(request:Request):Promise<Response>};
      original=object.fetch.bind(object);
      object.fetch=request=>new URL(request.url).pathname==="/agent-cancel"
        ? Promise.resolve(Response.json({error:{code:"fixture_outage",message:"Cancellation delivery unavailable."}},{status:503}))
        : original!(request);
    });
    try {
      await runInDurableObject(registry(),async(instance,state)=>{
        const scheduler=instance as unknown as Scheduler;
        await scheduler.agents.process(id);
        expect(state.storage.sql.exec<{phase:string}>("SELECT phase FROM agent_deliveries WHERE id=?",id).one().phase).toBe("cancel");
        await scheduler.reconcileComputerSlots();
        expect(state.storage.sql.exec<{task_id:string}>("SELECT task_id FROM task_slots WHERE bot_id=?",source.id).one().task_id).toBe(task.id);
      });
      expect((await api(`/v1/bots/${source.id}/messages`,{operationId:crypto.randomUUID(),text:"Saved during named cancellation"})).status).toBe(202);
    } finally {
      await runInDurableObject(targetStub,instance=>{(instance as unknown as {fetch(request:Request):Promise<Response>}).fetch=original!;});
    }
    await runInDurableObject(registry(),async(instance,state)=>{
      const scheduler=instance as unknown as Scheduler;
      await scheduler.agents.process(id);
      expect(state.storage.sql.exec<{phase:string}>("SELECT phase FROM agent_deliveries WHERE id=?",id).one().phase).toBe("done");
      await scheduler.reconcileComputerSlots();
      expect(state.storage.sql.exec("SELECT 1 FROM task_slots WHERE bot_id=?",source.id).toArray()).toHaveLength(0);
      expect(JSON.parse(state.storage.sql.exec<{data:string}>("SELECT data FROM tasks WHERE id=?",task.id).one().data).status).toBe("cancelled");
    });
    const targetState=await (await api(`/v1/bots/${target.id}/runs/${targetRun.id}`)).json<{run:Run}>();
    expect(targetState.run.status).toBe("cancelled");
    await runInDurableObject(targetStub,(_instance,state)=>expect(state.storage.sql.exec("SELECT 1 FROM cancelled_agent_inputs WHERE operation_id=?",`delegate:${id}`).toArray()).toHaveLength(1));
    const taskRuns=(await (await api(`/v1/tasks/${task.id}/runs`)).json<{runs:Run[]}>()).runs;
    expect(taskRuns).toEqual([expect.objectContaining({id:sourceRun.id,status:"completed"})]);
    expect((await (await api(`/v1/tasks/${task.id}/messages`)).json<{messages:Message[]}>()).messages).toEqual([]);
    expect((await (await api(`/v1/bots/${source.id}/messages`)).json<{messages:Message[]}>()).messages).toEqual([]);
  },60000);
});
