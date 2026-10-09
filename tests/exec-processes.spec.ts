import { env, exports } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Approval, Bot, BotEvent, ComputerAction, ComputerProvider, ComputerResult, Run } from "@botspace/contracts";
import type { AgentRuntime, RuntimeToolRequest, RuntimeToolResult } from "../packages/runtime/src/types";
import type { Env } from "../apps/api/src/env";
import { fingerprint, parseAction } from "../apps/api/src/validation";
import { computerActivityInput } from "../apps/api/src/tool-activity";
import { computerFixtureControl } from "./fixtures/worker";

const bindings=env as unknown as Env;
const api=(path:string,input?:unknown)=>exports.default.fetch(`https://timber.test${path}`,{method:input===undefined?"GET":"POST",headers:{authorization:"Bearer test-only-botspace-owner-token-000000","content-type":"application/json"},...(input===undefined?{}:{body:JSON.stringify(input)})});
const stubFor=(bot:Bot)=>bindings.BOT.get(bindings.BOT.idFromName(`owner:${bot.id}`));
type Internals={computer:ComputerProvider;runtime:AgentRuntime;executeTool(input:RuntimeToolRequest):Promise<RuntimeToolResult>;cancelRun(id:string):Promise<Run>;finishApproval(approval:Approval):Promise<void>;admit(op:string):Promise<void>;fenceSubagent(id:string):void;recover():Promise<void>;completeOperation(op:string,status:string,text?:string,reason?:string,kind?:"final"|"progress",answer?:{answerId?:string;answerOperationId?:string}):Promise<void>};
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>resolve=done);return {promise,resolve};}
function insertRun(state:DurableObjectState,bot:Bot,extra:Partial<Run>={}):Run {
  const now=new Date().toISOString();
  const run:Run={id:crypto.randomUUID(),botId:bot.id,operationId:crypto.randomUUID(),status:"running",createdAt:now,updatedAt:now,...extra};
  state.storage.sql.exec("INSERT INTO runs(id,operation_id,fingerprint,native_operation_id,data) VALUES(?,?,?,?,?)",run.id,run.operationId,"fixture",run.operationId,JSON.stringify(run));
  state.storage.sql.exec("INSERT INTO submissions(operation_id,run_id,text,admitted) VALUES(?,?,?,1)",run.operationId,run.id,"fixture held input");
  return run;
}
async function setup(mode:"ask"|"automatic"="automatic") {
  const {bot}=await (await api("/v1/bots",{name:"Process ownership",computerApprovalMode:mode})).json<{bot:Bot}>();
  await (await api(`/v1/bots/${bot.id}/messages`)).text();
  return bot;
}
const request=(run:Run,action:ComputerAction,operationId=crypto.randomUUID()):RuntimeToolRequest=>({operationId,runOperationId:run.operationId,action,signal:new AbortController().signal});
const eventRows=(state:DurableObjectState)=>state.storage.sql.exec<{data:string}>("SELECT data FROM events ORDER BY id").toArray().map(row=>JSON.parse(row.data) as BotEvent);

describe("command session validation and activity",()=>{
  it("has no implicit deadline or short timeout ceiling, with a separate bounded yield",()=>{
    expect(parseAction({type:"exec",command:"build"})).toEqual({type:"exec",command:"build"});
    expect(parseAction({type:"exec",command:"build",timeoutMs:7_200_000,yieldMs:0})).toMatchObject({timeoutMs:7_200_000,yieldMs:0});
    expect(computerActivityInput({type:"exec",command:"build"})).toEqual({command:"build",yieldMs:1000});
    for(const timeoutMs of [0,-1,1.5,Infinity,Number.MAX_SAFE_INTEGER+1]) expect(()=>parseAction({type:"exec",command:"build",timeoutMs})).toThrow();
    for(const yieldMs of [-1,30_001,0.5]) expect(()=>parseAction({type:"execPoll",processId:"exec:one",yieldMs})).toThrow();
    expect(parseAction({type:"execPoll",processId:"exec:one",yieldMs:30_000})).toEqual({type:"execPoll",processId:"exec:one",yieldMs:30_000});
    for(const processId of ["", "../other", "a".repeat(161)]) expect(()=>parseAction({type:"execCancel",processId})).toThrow();
  });
});

describe("durable command ownership and Stop",()=>{
  it("persists ownership before dispatch and cancels out of band while initial exec is blocked",async()=>{
    const bot=await setup();
    await runInDurableObject(stubFor(bot),async(instance,state)=>{
      const target=instance as unknown as Internals,run=insertRun(state,bot),provider=target.computer,runtime=target.runtime;
      const entered=deferred(),release=deferred();let cancellations=0;
      target.computer={...provider,exec:async(_bot,operationId)=>{expect(state.storage.sql.exec("SELECT process_id FROM run_processes WHERE process_id=?",operationId).toArray()).toHaveLength(1);entered.resolve();await release.promise;return {operationId,processId:operationId,status:"running"};},cancel:async(_bot,processId)=>{cancellations++;return {operationId:processId,processId,status:"cancelled"};}};
      target.runtime={...runtime,cancel:async()=>{expect(cancellations).toBe(1);return true;},subagents:async()=>[]};
      const input=request(run,{type:"exec",command:"long build",yieldMs:30_000});const pending=target.executeTool(input);
      try {
        await entered.promise;
        expect((await target.cancelRun(run.id)).status).toBe("cancelled");
        expect(cancellations).toBe(1);
        release.resolve();
        expect(await pending).toMatchObject({processId:input.operationId,status:"cancelled"});
        expect(state.storage.sql.exec<{status:string}>("SELECT status FROM run_processes").toArray()).toEqual([{status:"cancelled"}]);
      } finally {release.resolve();await pending.catch(()=>{});target.computer=provider;target.runtime=runtime;}
    });
  });

  it("automatically polls an approved running receipt and preserves its process identity",async()=>{
    const bot=await setup("ask");
    await runInDurableObject(stubFor(bot),async(instance,state)=>{
      const target=instance as unknown as Internals,run=insertRun(state,bot),provider=target.computer,admit=target.admit;
      const op=`exec:${crypto.randomUUID()}`;let continuation="",starts=0;
      target.admit=async native=>{continuation=native;};
      target.computer={...provider,exec:async(_bot,operationId,action)=>{if(action.type==="exec") {starts++;return {operationId,processId:operationId,status:"running",output:"building"};}return {operationId,processId:op,status:"completed",exitCode:0,output:"built"};}};
      try {
        const pending=await target.executeTool(request(run,{type:"exec",command:"build"},op));expect(pending.status).toBe("pending_approval");
        const approval=JSON.parse(state.storage.sql.exec<{data:string}>("SELECT data FROM approvals").toArray()[0].data) as Approval;
        approval.status="executing";state.storage.sql.exec("UPDATE approvals SET data=? WHERE id=?",JSON.stringify(approval),approval.id);
        await target.finishApproval(approval);
        const receipt=JSON.parse(state.storage.sql.exec<{data:string}>("SELECT data FROM approvals").toArray()[0].data) as Approval;
        expect(receipt).toMatchObject({status:"completed",result:{status:"running",processId:op}});
        const submission=state.storage.sql.exec<{text:string}>("SELECT text FROM submissions WHERE operation_id=?",continuation).toArray()[0];
        expect(submission.text).toContain("exec_poll");
        const result=await target.executeTool({...request(run,{type:"execPoll",processId:op,yieldMs:0}),runOperationId:continuation});
        expect(result).toMatchObject({status:"completed",processId:op});expect(starts).toBe(1);
        expect(state.storage.sql.exec("SELECT id FROM approvals").toArray()).toHaveLength(1);
        const events=eventRows(state).filter(event=>event.type==="process.updated");
        expect(events.at(-1)).toMatchObject({runId:run.id,data:{processId:op,operationId:op,result:{status:"completed",processId:op}}});
        expect(events.at(-1)!.data.observationOperationId).toBe((result as ComputerResult).operationId);
      } finally {target.computer=provider;target.admit=admit;}
    });
  });

  it("fences an executing approval and never queues its late running receipt",async()=>{
    const bot=await setup("ask");
    await runInDurableObject(stubFor(bot),async(instance,state)=>{
      const target=instance as unknown as Internals,run=insertRun(state,bot),provider=target.computer,runtime=target.runtime;
      const entered=deferred(),release=deferred();let cancelled=0;
      target.computer={...provider,exec:async(_bot,operationId)=>{entered.resolve();await release.promise;return {operationId,processId:operationId,status:"running"};},cancel:async(_bot,processId)=>{cancelled++;return {operationId:processId,processId,status:"cancelled"};}};
      target.runtime={...runtime,cancel:async()=>true,subagents:async()=>[]};
      const action:ComputerAction={type:"exec",command:"build"};const approval:Approval={id:crypto.randomUUID(),botId:bot.id,runId:run.id,operationId:crypto.randomUUID(),action,status:"executing",createdAt:run.createdAt,expiresAt:new Date(Date.now()+60_000).toISOString()};
      state.storage.sql.exec("INSERT INTO approvals(id,operation_id,fingerprint,data) VALUES(?,?,?,?)",approval.id,approval.operationId,await fingerprint(action),JSON.stringify(approval));
      const pending=target.finishApproval(approval);
      try {await entered.promise;await target.cancelRun(run.id);release.resolve();await pending;expect(cancelled).toBe(1);expect(state.storage.sql.exec("SELECT * FROM submissions WHERE operation_id LIKE 'approval:%'").toArray()).toHaveLength(0);expect(JSON.parse(state.storage.sql.exec<{data:string}>("SELECT data FROM approvals").toArray()[0].data)).toMatchObject({status:"interrupted"});}
      finally {release.resolve();await pending.catch(()=>{});target.computer=provider;target.runtime=runtime;}
    });
  });

  it("allows root control across tasks but restricts temporary agents to themselves and descendants",async()=>{
    const bot=await setup("ask");
    await runInDurableObject(stubFor(bot),async(instance,state)=>{
      const target=instance as unknown as Internals,provider=target.computer;
      const parent=insertRun(state,bot),left=insertRun(state,bot,{subagentId:crypto.randomUUID(),parentRunId:parent.id}),right=insertRun(state,bot,{subagentId:crypto.randomUUID(),parentRunId:parent.id}),descendant=insertRun(state,bot,{subagentId:crypto.randomUUID(),parentRunId:left.id});
      target.computer={...provider,exec:async(_bot,operationId,action)=>({operationId,processId:action.type==="exec"?operationId:(action as {processId:string}).processId,status:action.type==="execCancel"?"cancelled":"running"})};
      try {
        // Authorized approvals register the owner even with ask enabled.
        for(const [owner,op] of [[left,"left-process"],[right,"right-process"],[descendant,"descendant-process"]] as const) {
          const action:ComputerAction={type:"exec",command:op};
          state.storage.sql.exec("INSERT INTO run_processes(process_id,run_id,subagent_id,action,input,status) VALUES(?,?,?,?,?,'running')",op,owner.id,owner.subagentId!,JSON.stringify(action),JSON.stringify({command:op}));
        }
        await expect(target.executeTool(request(left,{type:"execCancel",processId:"right-process"}))).rejects.toMatchObject({status:403,code:"process_forbidden"});
        expect((await target.executeTool(request(left,{type:"execPoll",processId:"right-process",yieldMs:0}))).status).toBe("running");
        expect((await target.executeTool(request(left,{type:"execCancel",processId:"descendant-process"}))).status).toBe("cancelled");
        expect((await target.executeTool(request(parent,{type:"execCancel",processId:"right-process"}))).status).toBe("cancelled");
        await expect(target.executeTool(request(parent,{type:"execCancel",processId:"other-bot-process"}))).rejects.toMatchObject({status:404,code:"process_not_found"});
        expect(state.storage.sql.exec("SELECT id FROM approvals").toArray()).toHaveLength(0);
      } finally {target.computer=provider;}
    });
  });

  it("recovers a durable cancellation after eviction without redispatching exec",async()=>{
    const bot=await setup();let processId="";
    await runInDurableObject(stubFor(bot),async(instance,state)=>{
      const target=instance as unknown as Internals,run=insertRun(state,bot),provider=target.computer,runtime=target.runtime;
      target.computer={...provider,exec:async(_bot,operationId)=>({operationId,processId:operationId,status:"running"}),cancel:async()=>{throw new Error("Transport unavailable");}};
      target.runtime={...runtime,cancel:async()=>true,subagents:async()=>[]};
      try {processId=crypto.randomUUID();await target.executeTool(request(run,{type:"exec",command:"build"},processId));await target.cancelRun(run.id);expect(state.storage.sql.exec<{cancel_requested:number}>("SELECT cancel_requested FROM run_processes").toArray()).toEqual([{cancel_requested:1}]);state.storage.sql.exec("UPDATE run_processes SET next_at=0");}
      finally {target.computer=provider;target.runtime=runtime;}
    });
    await evictDurableObject(stubFor(bot));
    await runInDurableObject(stubFor(bot),async(instance,state)=>{
      await (instance as unknown as Internals).recover();
      expect(state.storage.sql.exec<{status:string;cancel_requested:number}>("SELECT status,cancel_requested FROM run_processes WHERE process_id=?",processId).toArray()).toEqual([{status:"cancelled",cancel_requested:0}]);
    });
    await runInDurableObject(bindings.COMPUTER.get(bindings.COMPUTER.idFromName(bot.id)),(_instance,state)=>expect(state.storage.sql.exec("SELECT id FROM effects").toArray()).toHaveLength(0));
  });

  it("rejects a conflicting cancellation ID before marking another process for cancellation",async()=>{
    const bot=await setup();
    await runInDurableObject(stubFor(bot),async(instance,state)=>{
      const target=instance as unknown as Internals,run=insertRun(state,bot),provider=target.computer;let cancellations=0;
      target.computer={...provider,exec:async(_bot,operationId,action)=>{if(action.type==="execCancel") cancellations++;return {operationId,processId:action.type==="exec"?operationId:(action as {processId:string}).processId,status:action.type==="execCancel"?"cancelled":"running"};}};
      try {
        await target.executeTool(request(run,{type:"exec",command:"first"},"first-process"));
        await target.executeTool(request(run,{type:"exec",command:"second"},"second-process"));
        await target.executeTool(request(run,{type:"execCancel",processId:"first-process"},"cancel-once"));
        await expect(target.executeTool(request(run,{type:"execCancel",processId:"second-process"},"cancel-once"))).rejects.toMatchObject({status:409,code:"idempotency_conflict"});
        expect(cancellations).toBe(1);
        expect(state.storage.sql.exec<{status:string;cancel_requested:number}>("SELECT status,cancel_requested FROM run_processes WHERE process_id='second-process'").toArray()).toEqual([{status:"running",cancel_requested:0}]);
      } finally {target.computer=provider;}
    });
  });

  it("stops processes retained by a completed parent and every previous child input",async()=>{
    const bot=await setup();
    await runInDurableObject(stubFor(bot),async(instance,state)=>{
      const target=instance as unknown as Internals,provider=target.computer,runtime=target.runtime;
      const parent=insertRun(state,bot,{status:"completed"}),agentId=crypto.randomUUID(),children=[insertRun(state,bot,{status:"completed",subagentId:agentId,parentRunId:parent.id}),insertRun(state,bot,{status:"failed",subagentId:agentId,parentRunId:parent.id})];
      const cancelled:string[]=[];
      target.runtime={...runtime,cancel:async()=>true,cancelSubagent:async()=>true,subagents:async()=>[]};
      target.computer={...provider,cancel:async(_bot,processId)=>{cancelled.push(processId);return {operationId:processId,processId,status:"cancelled"};}};
      for(const run of [parent,...children]) state.storage.sql.exec("INSERT INTO run_processes(process_id,run_id,subagent_id,action,input,status) VALUES(?,?,?,?,?,'running')",run.id,run.id,run.subagentId??null,JSON.stringify({type:"exec",command:"background work"}),JSON.stringify({command:"background work"}));
      try {await target.cancelRun(parent.id);expect(new Set(cancelled)).toEqual(new Set([parent.id,...children.map(child=>child.id)]));expect(state.storage.sql.exec<{status:string}>("SELECT status FROM run_processes").toArray().every(row=>row.status==="cancelled")).toBe(true);}
      finally {target.computer=provider;target.runtime=runtime;}
    });
  });

  it("uses the persisted Lifecycle callback to observe completion after the parent finished and the host was evicted",async()=>{
    const bot=await setup(),op=crypto.randomUUID();let runId="";
    computerFixtureControl.execSession={pollsBeforeComplete:0};
    try {
      await runInDurableObject(stubFor(bot),async(instance,state)=>{
        const target=instance as unknown as Internals,run=insertRun(state,bot);runId=run.id;
        expect(await target.executeTool(request(run,{type:"exec",command:"background build"},op))).toMatchObject({status:"running",processId:op});
        state.storage.sql.exec("UPDATE runs SET data=? WHERE id=?",JSON.stringify({...run,status:"completed"}),run.id);
        expect(await state.storage.get(`fixture-admission-retry:process-poll:${op}`)).toMatchObject({operationId:`process-poll:${op}`,delayMs:10_000});
      });
    } finally {delete computerFixtureControl.execSession;}
    await evictDurableObject(stubFor(bot));
    await runInDurableObject(stubFor(bot),async(instance,state)=>{
      const target=instance as unknown as Internals,runtime=target.runtime;
      target.runtime={...runtime,submit:async()=>{throw new Error("Passive observation must not submit model input");},wait:async()=>{throw new Error("Passive observation must not invoke inference");}};
      try {
        // The fixture persists Lifecycle jobs; invoking admit is the exact alarm
        // callback supplied by BotDO to the real runtime scheduler.
        await target.admit(`process-poll:${op}`);
        expect(state.storage.sql.exec("SELECT * FROM process_observations").toArray()).toHaveLength(0);
        expect(eventRows(state).filter(event=>event.type==="process.updated").at(-1)).toMatchObject({runId,data:{processId:op,result:{status:"completed",exitCode:0}}});
        expect(JSON.parse(state.storage.sql.exec<{data:string}>("SELECT data FROM runs WHERE id=?",runId).toArray()[0].data).status).toBe("completed");
        expect(state.storage.sql.exec("SELECT * FROM messages").toArray()).toHaveLength(0);
      } finally {target.runtime=runtime;}
    });
  });

  it("reuses a passive poll identity after transport loss and allocates a fresh bounded identity for its next observation",async()=>{
    const bot=await setup();
    await runInDurableObject(stubFor(bot),async(instance,state)=>{
      const target=instance as unknown as Internals,provider=target.computer,run=insertRun(state,bot),op="exec:"+"a".repeat(150);const polls:string[]=[];
      target.computer={...provider,exec:async(_bot,operationId,action)=>{if(action.type==="exec") return {operationId,processId:operationId,status:"running"};polls.push(operationId);if(polls.length===1) throw new Error("Lost receipt");return {operationId,processId:op,status:polls.length===2?"running":"completed"};}};
      try {
        await target.executeTool(request(run,{type:"exec",command:"background build"},op));
        for(let attempt=0;attempt<3;attempt++) await target.admit(`process-poll:${op}`);
        expect(polls).toHaveLength(3);expect(polls[1]).toBe(polls[0]);expect(polls[2]).not.toBe(polls[1]);expect(polls.every(id=>id.length<=160)).toBe(true);
        expect(eventRows(state).filter(event=>event.type==="tool.started")).toHaveLength(1);
      } finally {target.computer=provider;}
    });
  });

  it("stops retrying cancellation when the provider confirms its execution computer was lost",async()=>{
    const bot=await setup();
    await runInDurableObject(stubFor(bot),async(instance,state)=>{
      const target=instance as unknown as Internals,provider=target.computer,runtime=target.runtime,run=insertRun(state,bot),op=crypto.randomUUID();let cancels=0;
      target.runtime={...runtime,cancel:async()=>true,subagents:async()=>[]};
      target.computer={...provider,exec:async(_bot,operationId)=>({operationId,processId:operationId,status:"running"}),cancel:async(_bot,processId)=>{cancels++;return {operationId:processId,processId,status:"interrupted",error:"The execution computer was restarted."};}};
      try {await target.executeTool(request(run,{type:"exec",command:"background build"},op));await target.cancelRun(run.id);await target.admit(`process-cancel:${op}`);expect(cancels).toBe(1);expect(state.storage.sql.exec<{cancel_requested:number}>("SELECT cancel_requested FROM run_processes").toArray()).toEqual([{cancel_requested:0}]);expect(await state.storage.get(`fixture-admission-retry:process-cancel:${op}`)).toBeUndefined();}
      finally {target.computer=provider;target.runtime=runtime;}
    });
  });
});

describe("steered native answers",()=>{
  it("settles each input but deduplicates the answer and attributes it to its author in either wait order",async()=>{
    const bot=await setup();
    await runInDurableObject(stubFor(bot),async(instance,state)=>{
      const target=instance as unknown as Internals;
      for(const reversed of [false,true]) {
        const first=insertRun(state,bot),latest=insertRun(state,bot),answer={answerId:crypto.randomUUID(),answerOperationId:latest.operationId};
        for(const run of reversed?[latest,first]:[first,latest]) await target.completeOperation(run.operationId,"done","One shared final answer",undefined,"final",answer);
        const messages=state.storage.sql.exec<{data:string}>("SELECT data FROM messages WHERE source_key=?",`answer-entry:${answer.answerId}`).toArray();
        expect(messages).toHaveLength(1);expect(JSON.parse(messages[0].data)).toMatchObject({runId:latest.id,text:"One shared final answer"});
        expect(state.storage.sql.exec<{status:string}>("SELECT json_extract(data,'$.status') AS status FROM runs WHERE id IN (?,?)",first.id,latest.id).toArray()).toEqual([{status:"completed"},{status:"completed"}]);
      }
    });
  });
});
