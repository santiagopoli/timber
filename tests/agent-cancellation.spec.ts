import { env, exports } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Bot, BotEvent, Run, Subagent } from "@botspace/contracts";
import type { AgentRuntime } from "../packages/runtime/src/types";
import type { Env } from "../apps/api/src/env";

const bindings=env as unknown as Env;
const stubFor=(bot:Bot)=>bindings.BOT.get(bindings.BOT.idFromName(`owner:${bot.id}`));
type Internals={
  runtime:AgentRuntime;
  cancelRun(id:string):Promise<Run>;
  recover():Promise<void>;
  admit(operationId:string):Promise<void>;
  requestCancellation(id:string):NonNullable<Run['cancellation']>;
  fenceRun(id:string,cancellation?:NonNullable<Run['cancellation']>):void;
  queueRunCancellation(target:{operationId?:string;subagentId?:string},cancellation?:NonNullable<Run['cancellation']>):void;
  project(event:{type:string;operationId:string;eventKey?:string;data:Record<string,unknown>}):Promise<void>;
  completeOperation(op:string,status:string,text?:string,reason?:string,kind?:"final"|"progress",metadata?:{cancellationId?:string}):Promise<void>;
  createRun(input:{operationId:string;text:string},metadata:{role:"system";parentRunId:string;subagentId?:string}):Promise<Run>;
  receiveSubagentMessage(input:{subagentId:string;parentOperationId:string;operationId:string;text:string}):Promise<void>;
};
async function setup():Promise<Bot> {
  const response=await exports.default.fetch("https://timber.test/v1/bots",{method:"POST",headers:{authorization:"Bearer test-only-botspace-owner-token-000000","content-type":"application/json"},body:JSON.stringify({name:"Cancellation provenance"})});
  expect(response.status).toBe(201);
  const {bot}=await response.json<{bot:Bot}>();
  await (await exports.default.fetch(`https://timber.test/v1/bots/${bot.id}/runs`,{headers:{authorization:"Bearer test-only-botspace-owner-token-000000"}})).text();
  return bot;
}
function insertRun(state:DurableObjectState,bot:Bot,extra:Partial<Run>={}):Run {
  const now=new Date().toISOString(),run:Run={id:crypto.randomUUID(),botId:bot.id,operationId:crypto.randomUUID(),status:"running",createdAt:now,updatedAt:now,...extra};
  state.storage.sql.exec("INSERT INTO runs(id,operation_id,fingerprint,native_operation_id,data) VALUES(?,?,?,?,?)",run.id,run.operationId,"fixture",run.operationId,JSON.stringify(run));
  state.storage.sql.exec("INSERT INTO submissions(operation_id,run_id,text,admitted,subagent_id) VALUES(?,?,?,1,?)",run.operationId,run.id,"fixture",run.subagentId??null);
  return run;
}
const readRun=(state:DurableObjectState,id:string)=>JSON.parse(state.storage.sql.exec<{data:string}>("SELECT data FROM runs WHERE id=?",id).one().data) as Run;
const events=(state:DurableObjectState)=>state.storage.sql.exec<{data:string}>("SELECT data FROM events ORDER BY id").toArray().map(row=>JSON.parse(row.data) as BotEvent);

describe("explicit Stop provenance",()=>{
  it("preserves completed and failed history while grouping only unfinished descendants",async()=>{
    const bot=await setup();
    await runInDurableObject(stubFor(bot),async(instance,state)=>{
      const target=instance as unknown as Internals,runtime=target.runtime;
      const parent=insertRun(state,bot,{status:"completed"});
      const historical=[insertRun(state,bot,{parentRunId:parent.id,status:"completed"}),insertRun(state,bot,{parentRunId:parent.id,status:"failed",error:"The model request failed."}),insertRun(state,bot,{parentRunId:parent.id,status:"interrupted",error:"Provider disconnected."})];
      const child=insertRun(state,bot,{parentRunId:parent.id}),nested=insertRun(state,bot,{parentRunId:child.id,status:"queued"});
      target.runtime={...runtime,cancel:async()=>true,subagents:async()=>[]};
      try {
        expect(await target.cancelRun(parent.id)).toMatchObject(parent);
        await target.cancelRun(parent.id);
        for(const run of [parent,...historical]) {
          const {cancellation,...outcome}=readRun(state,run.id);
          expect(outcome).toEqual(run);expect(cancellation).toMatchObject({requestedRunId:parent.id});
        }
        const stopped=readRun(state,child.id),group=stopped.cancellation;
        expect(stopped).toMatchObject({status:"cancelled",cancellation:{requestedRunId:parent.id}});
        expect(readRun(state,nested.id)).toMatchObject({status:"cancelled",cancellation:group});
        const requests=events(state).filter(event=>event.type==="run.cancellation.requested");
        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({runId:parent.id,data:{cancellation:group}});
      } finally {target.runtime=runtime;}
    });
  });

  it.each(["event","wait"] as const)("groups native joined inputs through explicit cancellation provenance when %s arrives first",async order=>{
    const bot=await setup();
    await runInDurableObject(stubFor(bot),async(instance,state)=>{
      const target=instance as unknown as Internals,runtime=target.runtime;
      const first=insertRun(state,bot),latest=insertRun(state,bot),continuation=insertRun(state,bot,{parentRunId:first.id});
      const delayedReport=insertRun(state,bot,{parentRunId:first.id,status:"queued"});
      state.storage.sql.exec("UPDATE submissions SET admitted=0 WHERE run_id=?",delayedReport.id);
      let cancellationId:string|undefined;
      target.runtime={...runtime,subagents:async()=>[],submit:async()=>{throw new Error("A stopped parent's delayed report must not reach Pi");},cancel:async(_operationId,options)=>{
        cancellationId=options?.cancellationId;
        for(const run of [first,continuation]) {
          const event=()=>target.project({type:"run.failed",operationId:run.operationId,eventKey:`aborted:${run.id}`,data:{reason:"aborted",cancellationId,errorCode:"run_aborted",publicMessage:"The run was stopped before an answer completed."}});
          const wait=()=>target.completeOperation(run.operationId,"unanswered",undefined,"aborted",undefined,{cancellationId});
          if(order==="event") {await event();await wait();} else {await wait();await event();}
        }
        // A parent callback already saved before native capture can arrive
        // during the cancellation drain. It must fence before entering its gate.
        await target.admit(delayedReport.operationId);
        return true;
      }};
      try {
        await target.cancelRun(latest.id);
        expect(cancellationId).toBeDefined();
        for(const run of [first,latest,continuation,delayedReport]) {
          expect(readRun(state,run.id)).toMatchObject({status:"cancelled",cancellation:{id:cancellationId,requestedRunId:latest.id}});
          expect(readRun(state,run.id).error).toBeUndefined();
        }
        expect(events(state).filter(event=>event.type==="run.failed")).toHaveLength(0);
        expect(events(state).filter(event=>event.type==="run.cancelled")).toHaveLength(2);
        expect(events(state).filter(event=>event.type==="run.cancellation.requested")).toHaveLength(1);
      } finally {target.runtime=runtime;}
    });
  });

  it("keeps unrequested aborts and genuine execution errors visible",async()=>{
    const bot=await setup();
    await runInDurableObject(stubFor(bot),async(instance,state)=>{
      const target=instance as unknown as Internals,runtime=target.runtime,stopped=insertRun(state,bot);
      target.runtime={...runtime,cancel:async()=>true,subagents:async()=>[]};
      try {
        const cancellation=(await target.cancelRun(stopped.id)).cancellation!;
        for(const [reason,cancellationId,status] of [["aborted",undefined,"interrupted"],["aborted","unknown-request","interrupted"],["model_error",cancellation.id,"failed"]] as const) {
          const run=insertRun(state,bot);
          await target.project({type:"run.failed",operationId:run.operationId,data:{reason,cancellationId,publicMessage:"An actual diagnostic."}});
          expect(readRun(state,run.id)).toMatchObject({status,error:"An actual diagnostic."});
          expect(readRun(state,run.id).cancellation).toBeUndefined();
        }
      } finally {target.runtime=runtime;}
    });
  });

  it("retains the Stop fence after eviction without rewriting a completed parent",async()=>{
    const bot=await setup();let parent!:Run;
    await runInDurableObject(stubFor(bot),async(instance,state)=>{
      const target=instance as unknown as Internals,runtime=target.runtime;parent=insertRun(state,bot,{status:"completed"});
      target.runtime={...runtime,cancel:async()=>true,subagents:async()=>[]};
      try {await target.cancelRun(parent.id);} finally {target.runtime=runtime;}
    });
    await evictDurableObject(stubFor(bot));
    await runInDurableObject(stubFor(bot),async(instance,state)=>{
      const target=instance as unknown as Internals;
      expect(readRun(state,parent.id)).toMatchObject(parent);
      expect(readRun(state,parent.id).cancellation).toMatchObject({requestedRunId:parent.id});
      await expect(target.createRun({operationId:`subagent-report:${crypto.randomUUID()}`,text:"Late report"},{role:"system",parentRunId:parent.id})).rejects.toMatchObject({code:"run_cancelled"});
      await target.receiveSubagentMessage({subagentId:crypto.randomUUID(),parentOperationId:parent.operationId,operationId:crypto.randomUUID(),text:"Late message"});
      expect(state.storage.sql.exec("SELECT id FROM runs").toArray()).toHaveLength(1);
      expect(events(state).some(event=>event.type==="subagent.reported")).toBe(false);
    });
  });

  it("preserves old child input outcomes when native cancellation fences the session",async()=>{
    const bot=await setup();
    await runInDurableObject(stubFor(bot),async(instance,state)=>{
      const target=instance as unknown as Internals,parent=insertRun(state,bot,{status:"completed"}),subagentId=crypto.randomUUID();
      const done=insertRun(state,bot,{subagentId,parentRunId:parent.id,status:"completed"}),failed=insertRun(state,bot,{subagentId,parentRunId:parent.id,status:"failed",error:"Actual tool failure"}),current=insertRun(state,bot,{subagentId,parentRunId:parent.id});
      const subagent:Subagent={id:subagentId,name:"Worker",task:"Task",operationId:current.operationId,parentOperationId:parent.operationId,status:"cancelled",createdAt:current.createdAt,updatedAt:current.updatedAt};
      await target.project({type:"subagent.updated",operationId:parent.operationId,data:{subagent}});
      expect(readRun(state,done.id)).toEqual(done);
      expect(readRun(state,failed.id)).toEqual(failed);
      expect(readRun(state,current.id).status).toBe("cancelled");
    });
  });

  it("fences a completed child session and correlates its Stop before the shared parent event arrives",async()=>{
    const bot=await setup();
    await runInDurableObject(stubFor(bot),async(instance,state)=>{
      const target=instance as unknown as Internals,runtime=target.runtime,parent=insertRun(state,bot),requested=insertRun(state,bot),subagentId=crypto.randomUUID();
      const done=insertRun(state,bot,{subagentId,parentRunId:parent.id,status:"completed"}),current=insertRun(state,bot,{subagentId,parentRunId:parent.id});
      target.runtime={...runtime,cancel:async()=>true,subagents:async()=>[]};
      try {
        const cancellation=(await target.cancelRun(requested.id)).cancellation!;
        const subagent:Subagent={id:subagentId,name:"Worker",task:"Task",operationId:done.operationId,parentOperationId:parent.operationId,status:"completed",result:"A saved answer",createdAt:done.createdAt,updatedAt:done.updatedAt};
        await target.project({type:"subagent.stopped",operationId:parent.operationId,data:{subagent,cancellationId:cancellation.id}});
        expect(readRun(state,done.id)).toEqual({...done,cancellation});
        expect(readRun(state,current.id)).toMatchObject({status:"cancelled",cancellation});
        expect(readRun(state,parent.id).status).toBe("running");
        await expect(target.createRun({operationId:crypto.randomUUID(),text:"New child input"},{role:"system",parentRunId:parent.id,subagentId})).rejects.toMatchObject({code:"agent_inactive"});
      } finally {target.runtime=runtime;}
    });
  });

  it("recovers Stop intent saved before runtime dispatch and admits newer work only after the exact input was stopped",async()=>{
    const bot=await setup();let stopped!:Run;
    await runInDurableObject(stubFor(bot),async(instance,state)=>{
      const target=instance as unknown as Internals;stopped=insertRun(state,bot);
      const cancellation=target.requestCancellation(stopped.id);
      target.fenceRun(stopped.id,cancellation);
      target.queueRunCancellation({operationId:stopped.operationId},cancellation);
      // Simulate eviction after durable host acceptance but before any runtime
      // cancellation dispatch. No native receipt exists yet.
    });
    await evictDurableObject(stubFor(bot));
    await runInDurableObject(stubFor(bot),async(instance,state)=>{
      const target=instance as unknown as Internals,runtime=target.runtime,newer=insertRun(state,bot,{status:"queued"}),calls:string[]=[];
      state.storage.sql.exec("UPDATE submissions SET admitted=0 WHERE run_id=?",newer.id);
      target.runtime={...runtime,
        cancel:async(operationId,options)=>{calls.push(`cancel:${operationId}`);expect(options?.cancellationId).toBe(readRun(state,stopped.id).cancellation?.id);return true;},
        submit:async(_text,input)=>{calls.push(`submit:${input.operationId}`);expect(state.storage.sql.exec("SELECT id FROM pending_run_cancellations").toArray()).toHaveLength(0);return {operationId:input.operationId,accepted:true};},
        wait:async operationId=>({operationId,status:"done",text:"New independent answer",kind:"final"}),
      };
      try {
        await target.admit(newer.operationId);
        expect(calls).toEqual([`cancel:${stopped.operationId}`,`submit:${newer.operationId}`]);
        expect(readRun(state,stopped.id).status).toBe("cancelled");
        expect(readRun(state,newer.id).cancellation).toBeUndefined();
      } finally {target.runtime=runtime;}
    });
  });

  it("retains a failed cancellation for Lifecycle retry and keeps new native inputs outside that scope",async()=>{
    const bot=await setup();
    await runInDurableObject(stubFor(bot),async(instance,state)=>{
      const target=instance as unknown as Internals,runtime=target.runtime,stopped=insertRun(state,bot),newer=insertRun(state,bot,{status:"queued"});
      state.storage.sql.exec("UPDATE submissions SET admitted=0 WHERE run_id=?",newer.id);
      let attempts=0,submissions=0;
      target.runtime={...runtime,
        cancel:async operationId=>{expect(operationId).toBe(stopped.operationId);if(++attempts===1) throw new Error("Runtime unavailable");return true;},
        submit:async(_text,input)=>{submissions++;return {operationId:input.operationId,accepted:true};},
        wait:async operationId=>({operationId,status:"done",text:"Independent answer",kind:"final"}),
      };
      try {
        await target.cancelRun(stopped.id);
        expect(state.storage.sql.exec<{attempts:number}>("SELECT attempts FROM pending_run_cancellations").toArray()).toEqual([{attempts:1}]);
        await target.admit(newer.operationId);
        expect(submissions).toBe(0);
        expect(readRun(state,newer.id)).toMatchObject({status:"queued"});
        expect(readRun(state,newer.id).cancellation).toBeUndefined();
        state.storage.sql.exec("UPDATE pending_run_cancellations SET next_at=0");
        await target.admit(`run-cancel:run:${stopped.operationId}`);
        await target.admit(newer.operationId);
        expect(attempts).toBe(2);expect(submissions).toBe(1);
        expect(state.storage.sql.exec("SELECT id FROM pending_run_cancellations").toArray()).toHaveLength(0);
      } finally {target.runtime=runtime;}
    });
  });
});
