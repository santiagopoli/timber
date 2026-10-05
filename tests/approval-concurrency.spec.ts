import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Approval, Bot, ComputerProvider, Run } from "@botspace/contracts";
import { ComputerProviderError } from "../packages/computer/src/index";
import type { Env } from "../apps/api/src/env";

const bindings=env as unknown as Env;
const token="test-only-botspace-owner-token-000000";
const api=(path:string,body?:unknown)=>exports.default.fetch(`https://botspace.test${path}`,{
  method:body===undefined?"GET":"POST",
  headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},
  ...(body===undefined?{}:{body:JSON.stringify(body)}),
});
const stubFor=(bot:Bot)=>bindings.BOT.get(bindings.BOT.idFromName(`owner:${bot.id}`));
async function approvalFor(bot:Bot):Promise<Approval> {
  const response=await api(`/v1/bots/${bot.id}/approvals`);
  expect(response.status).toBe(200);
  return (await response.json<{approvals:Approval[]}>()).approvals[0];
}
async function runFor(bot:Bot,run:Run):Promise<Run> {
  const response=await api(`/v1/bots/${bot.id}/runs/${run.id}`);
  expect(response.status).toBe(200);
  return (await response.json<{run:Run}>()).run;
}
async function pausedBot():Promise<{bot:Bot;run:Run;approval:Approval}> {
  const created=await api("/v1/bots",{name:"Approval concurrency"});
  expect(created.status).toBe(201);
  const {bot}=await created.json<{bot:Bot}>();
  const submitted=await api(`/v1/bots/${bot.id}/messages`,{text:"fixture:approval",operationId:crypto.randomUUID()});
  expect(submitted.status).toBe(202);
  const {run}=await submitted.json<{run:Run}>();
  for(let i=0;i<100;i++) {
    const approval=await approvalFor(bot);
    if(approval?.status==="pending" && (await runFor(bot,run)).status==="waiting_approval") return {bot,run,approval};
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  throw new Error("Fixture approval did not become pending");
}
async function settledRun(bot:Bot,run:Run,status:Run["status"]):Promise<Run> {
  for(let i=0;i<100;i++) {
    const current=await runFor(bot,run);
    if(current.status===status) return current;
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  const current=await runFor(bot,run);
  expect(current.status).toBe(status);
  return current;
}
type BotInternals={
  computer:ComputerProvider;
  finishApproval(approval:Approval):Promise<void>;
  queueApprovalContinuation(approval:Approval):string|undefined;
};

describe("approved action completion under polling and recovery",()=>{
  it("coalesces poll-triggered recovery with the accepted action and queues one continuation",async()=>{
    const {bot,run,approval}=await pausedBot();
    let release!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;});
    let calls=0;
    await runInDurableObject(stubFor(bot),(instance)=>{
      const target=instance as unknown as BotInternals;
      target.computer={...target.computer,exec:async(_botId,operationId)=>{
        calls++;
        if(calls>1) throw new Error("Duplicate RPC lost its response after the original effect");
        await gate;
        return {operationId,status:"completed",output:"one effect"};
      }};
    });
    try {
      expect((await api(`/v1/bots/${bot.id}/approvals/${approval.id}`,{decision:"approve"})).status).toBe(200);
      for(let i=0;i<5;i++) {
        await Promise.all([approvalFor(bot),runFor(bot,run),api(`/v1/bots/${bot.id}/messages`)]);
        await new Promise(resolve=>setTimeout(resolve,5));
      }
      expect(calls).toBe(1);
      expect((await approvalFor(bot)).status).toBe("executing");
      expect((await runFor(bot,run)).status).toBe("waiting_approval");
      release();
      await settledRun(bot,run,"completed");
      expect((await approvalFor(bot)).status).toBe("completed");
      const continuations=await runInDurableObject(stubFor(bot),(_instance,state)=>
        state.storage.sql.exec<{total:number}>("SELECT COUNT(*) AS total FROM submissions WHERE operation_id=?",`approval:${approval.id}`).one().total);
      expect(continuations).toBe(1);
      expect(calls).toBe(1);
    } finally {release();}
  });

  it("ignores stale finalizers and never rewinds an existing continuation",async()=>{
    const {bot,run,approval}=await pausedBot();
    let calls=0;
    await runInDurableObject(stubFor(bot),async(instance,state)=>{
      const target=instance as unknown as BotInternals;
      target.computer={...target.computer,exec:async(_botId,operationId)=>{
        calls++;return {operationId,status:"completed"};
      }};
      const finished:Approval={...approval,status:"completed",result:{operationId:approval.operationId,status:"completed"}};
      const originalContinuation=`approval:${approval.id}`;
      const newerContinuation=`approval:${crypto.randomUUID()}`;
      state.storage.sql.exec("UPDATE approvals SET data=? WHERE id=?",JSON.stringify(finished),approval.id);
      state.storage.sql.exec("INSERT INTO submissions(operation_id,run_id,text,admitted) VALUES(?,?,?,1)",originalContinuation,run.id,"already continued");
      state.storage.sql.exec("INSERT INTO submissions(operation_id,run_id,text,admitted) VALUES(?,?,?,1)",newerContinuation,run.id,"newer active continuation");
      const active:Run={...run,status:"waiting_approval"};
      state.storage.sql.exec("UPDATE runs SET native_operation_id=?,data=? WHERE id=?",newerContinuation,JSON.stringify(active),run.id);
      // This is the stale executing snapshot that an overlapping recovery had read.
      await target.finishApproval({...approval,status:"executing"});
      // Admission itself must also be idempotent if called after another result.
      const resume=state.storage.transactionSync(()=>target.queueApprovalContinuation(finished));
      expect(resume).toBeUndefined();
      const saved=state.storage.sql.exec<{native_operation_id:string;data:string}>("SELECT native_operation_id,data FROM runs WHERE id=?",run.id).one();
      expect(saved.native_operation_id).toBe(newerContinuation);
      expect((JSON.parse(saved.data) as Run).status).toBe("waiting_approval");
      expect((JSON.parse(state.storage.sql.exec<{data:string}>("SELECT data FROM approvals WHERE id=?",approval.id).one().data) as Approval).status).toBe("completed");
    });
    expect(calls).toBe(0);
  });

  it.each(["reviewed","unknown"] as const)("keeps %s provider failures conservative and removes raw exception details",async(kind)=>{
    const {bot,run,approval}=await pausedBot();
    let calls=0;
    await runInDurableObject(stubFor(bot),(instance)=>{
      const target=instance as unknown as BotInternals;
      target.computer={...target.computer,exec:async()=>{
        calls++;
        if(kind==="reviewed") throw new ComputerProviderError("computer_start_failed");
        throw new Error("raw-upstream-secret-DO-NOT-PERSIST");
      }};
    });
    await api(`/v1/bots/${bot.id}/approvals/${approval.id}`,{decision:"approve"});
    const current=await settledRun(bot,run,"interrupted");
    const finalApproval=await approvalFor(bot);
    expect(finalApproval.status).toBe("interrupted");
    const serialized=JSON.stringify({current,finalApproval});
    expect(serialized).not.toContain("raw-upstream-secret");
    if(kind==="reviewed") {
      expect(current.error).toContain("computer_start_failed");
      expect(finalApproval.result?.error).toContain("Cloudflare could not start the computer.");
    } else expect(finalApproval.result?.error).toContain("Could not establish whether the action completed.");
    await Promise.all([approvalFor(bot),runFor(bot,run),api(`/v1/bots/${bot.id}/approvals/${approval.id}`,{decision:"approve"})]);
    expect(calls).toBe(1);
  });
});
