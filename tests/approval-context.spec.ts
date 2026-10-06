import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Approval, Bot, ComputerAction, ComputerProvider, Run } from "@botspace/contracts";
import type { RuntimeApprovalContext, RuntimeToolResult } from "../packages/runtime/src/types";
import type { Env } from "../apps/api/src/env";
import { fingerprint } from "../apps/api/src/validation";

const bindings=env as unknown as Env;
const token="test-only-botspace-owner-token-000000";
const api=(path:string,body?:unknown,method?:string)=>exports.default.fetch(`https://botspace.test${path}`,{
  method:method??(body===undefined?"GET":"POST"),
  headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},
  ...(body===undefined?{}:{body:JSON.stringify(body)}),
});
const stubFor=(bot:Bot)=>bindings.BOT.get(bindings.BOT.idFromName(`owner:${bot.id}`));
type BotInternals={
  approvalContext():RuntimeApprovalContext;
  configure(request:Request):void;
  currentBot():Promise<Bot>;
  executeTool(input:{operationId:string;runOperationId:string;action:ComputerAction;signal?:AbortSignal}):Promise<RuntimeToolResult>;
  computer:ComputerProvider;
};
async function createBot(mode?:"ask"|"automatic"):Promise<Bot> {
  const response=await api("/v1/bots",{name:"Approval context",...(mode?{computerApprovalMode:mode}:{})});
  expect(response.status).toBe(201);
  const {bot}=await response.json<{bot:Bot}>();
  expect((await api(`/v1/bots/${bot.id}/messages`)).status).toBe(200);
  return bot;
}
async function submit(bot:Bot,text="fixture:approval"):Promise<Run> {
  const response=await api(`/v1/bots/${bot.id}/messages`,{text,operationId:crypto.randomUUID()});
  expect(response.status).toBe(202);
  return (await response.json<{run:Run}>()).run;
}
async function waitRun(bot:Bot,run:Run,status:Run["status"]):Promise<Run> {
  for(let i=0;i<100;i++) {
    const response=await api(`/v1/bots/${bot.id}/runs/${run.id}`);
    const current=(await response.json<{run:Run}>()).run;
    if(current.status===status) return current;
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  throw new Error(`Run did not reach ${status}`);
}
async function approvalFor(bot:Bot,run:Run):Promise<Approval> {
  await waitRun(bot,run,"waiting_approval");
  const {approvals}=await (await api(`/v1/bots/${bot.id}/approvals`)).json<{approvals:Approval[]}>();
  return approvals.find(approval=>approval.runId===run.id)!;
}
const contextFor=(bot:Bot)=>runInDurableObject(stubFor(bot),(instance)=>(instance as unknown as BotInternals).approvalContext());
const effectsFor=(bot:Bot)=>runInDurableObject(bindings.COMPUTER.get(bindings.COMPUTER.idFromName(bot.id)),(_instance,state)=>
  state.storage.sql.exec<{id:string}>("SELECT id FROM effects WHERE json_extract(action,'$.type')!='checkpoint'").toArray());

describe("host-owned approval context and execution policy",()=>{
  it("reports denial immediately and lets a new message request a fresh approval without executing it",async()=>{
    const bot=await createBot();
    const firstRun=await submit(bot),firstApproval=await approvalFor(bot,firstRun);
    expect((await contextFor(bot)).active.map(value=>value.id)).toContain(firstApproval.id);
    expect((await api(`/v1/bots/${bot.id}/approvals/${firstApproval.id}`,{decision:"deny"})).status).toBe(200);
    const deniedContext=await contextFor(bot);
    expect(deniedContext.active.some(value=>value.id===firstApproval.id)).toBe(false);
    expect(deniedContext.recent.find(value=>value.id===firstApproval.id)?.status).toBe("denied");
    await waitRun(bot,firstRun,"completed");
    const secondRun=await submit(bot),secondApproval=await approvalFor(bot,secondRun);
    expect(secondApproval.id).not.toBe(firstApproval.id);
    expect(secondApproval.operationId).not.toBe(firstApproval.operationId);
    expect(await effectsFor(bot)).toHaveLength(0);
    const current=await contextFor(bot);
    expect(current.active.map(value=>value.id)).toEqual([secondApproval.id]);
    expect(current.recent.find(value=>value.id===firstApproval.id)?.status).toBe("denied");
    await api(`/v1/bots/${bot.id}/approvals/${firstApproval.id}`,{decision:"approve"});
    expect(await effectsFor(bot)).toHaveLength(0);
    await api(`/v1/bots/${bot.id}/approvals/${secondApproval.id}`,{decision:"approve"});
    await waitRun(bot,secondRun,"completed");
    expect(await effectsFor(bot)).toHaveLength(1);
  });

  it("includes every active approval and only20 recent others, with expiration projected without mutation or private arguments",async()=>{
    const bot=await createBot();
    await runInDurableObject(stubFor(bot),(instance,state)=>{
      const past=new Date(Date.now()-60_000).toISOString(),future=new Date(Date.now()+60_000).toISOString();
      const insert=(status:Approval["status"],expiresAt:string):Approval=>{
        const id=crypto.randomUUID();
        const approval:Approval={id,botId:bot.id,runId:crypto.randomUUID(),operationId:`context:${id}`,status,createdAt:past,expiresAt,
          action:{type:"exec",command:"private-command-value"},
          ...(status==="completed"?{result:{operationId:`context:${id}`,status:"completed" as const,output:"private-output-value"}}:{})};
        state.storage.sql.exec("INSERT INTO approvals(id,operation_id,fingerprint,data) VALUES(?,?,?,?)",id,approval.operationId,id,JSON.stringify(approval));
        return approval;
      };
      const pending=insert("pending",future);
      for(let i=0;i<25;i++) insert(i%2?"denied":"completed",future);
      const expired=insert("pending",past);
      const executing=insert("executing",past);
      const snapshot=(instance as unknown as BotInternals).approvalContext();
      expect(snapshot.active.map(value=>value.id)).toEqual([executing.id,pending.id]);
      expect(snapshot.active[0].status).toBe("executing");
      expect(snapshot.recent).toHaveLength(20);
      expect(snapshot.recent[0]).toEqual({id:expired.id,status:"expired",actionType:"exec",expiresAt:past});
      for(const summary of [...snapshot.active,...snapshot.recent]) expect(Object.keys(summary).sort()).toEqual(["actionType","expiresAt","id","status"]);
      expect(JSON.stringify(snapshot)).not.toContain("private-command-value");
      expect(JSON.stringify(snapshot)).not.toContain("private-output-value");
      const durable=state.storage.sql.exec<{data:string}>("SELECT data FROM approvals WHERE id=?",expired.id).one();
      expect((JSON.parse(durable.data) as Approval).status).toBe("pending");
    });
  });

  it("executes fresh shell and GUI calls automatically only for the bot configured that way",async()=>{
    const automatic=await createBot("automatic"),asking=await createBot();
    for(const text of ["fixture:approval","fixture:gui-approval"]) {
      const run=await submit(automatic,text);
      await waitRun(automatic,run,"completed");
    }
    expect(await effectsFor(automatic)).toHaveLength(2);
    expect(await contextFor(automatic)).toEqual({active:[],recent:[]});
    const askRun=await submit(asking),askApproval=await approvalFor(asking,askRun);
    expect(askApproval.status).toBe("pending");
    expect(await effectsFor(asking)).toHaveLength(0);
  });

  it("keeps old pending and denied operations inert after a mode change while allowing a new operation",async()=>{
    const bot=await createBot();
    const run=await submit(bot),approval=await approvalFor(bot,run);
    await api(`/v1/bots/${bot.id}`,{computerApprovalMode:"automatic"},"PATCH");
    // Refresh the internal config from the authenticated registry without changing the decision.
    await api(`/v1/bots/${bot.id}/approvals`);
    let calls=0;
    await runInDurableObject(stubFor(bot),async(instance,state)=>{
      const target=instance as unknown as BotInternals;
      target.computer={...target.computer,exec:async(_botId,operationId)=>{calls++;return {operationId,status:"completed"};}};
      const oldInput={operationId:approval.operationId,runOperationId:run.operationId,action:approval.action};
      const pending=await target.executeTool(oldInput);
      expect(pending.status).toBe("pending_approval");
      expect(calls).toBe(0);
      state.storage.sql.exec("UPDATE approvals SET data=? WHERE id=?",JSON.stringify({...approval,status:"denied"}),approval.id);
      const denied=await target.executeTool(oldInput);
      expect(denied.status).toBe("failed");
      expect(calls).toBe(0);
      for(const status of ["completed","failed","interrupted"] as const) {
        const result={operationId:approval.operationId,status,output:"stored outcome"};
        state.storage.sql.exec("UPDATE approvals SET data=? WHERE id=?",JSON.stringify({...approval,status,result}),approval.id);
        expect(await target.executeTool(oldInput)).toEqual(result);
        expect(calls).toBe(0);
      }
      const fresh=await target.executeTool({...oldInput,operationId:`fresh:${crypto.randomUUID()}`});
      expect(fresh.status).toBe("completed");
      expect(calls).toBe(1);
    });
  });

  it("ignores stale in-flight config so an older automatic mode cannot reopen permission",async()=>{
    const original=await createBot("automatic");
    const changed=await api(`/v1/bots/${original.id}`,{computerApprovalMode:"ask"},"PATCH");
    expect(changed.status).toBe(200);
    const {bot}=await changed.json<{bot:Bot}>();
    expect(bot.updatedAt>original.updatedAt).toBe(true);
    const run=await submit(bot);
    await approvalFor(bot,run);
    await runInDurableObject(stubFor(bot),async(instance,state)=>{
      const target=instance as unknown as BotInternals;
      target.configure(new Request("https://bot/messages",{headers:{"x-botspace-config":encodeURIComponent(JSON.stringify(original))}}));
      const stored=JSON.parse(state.storage.sql.exec<{data:string}>("SELECT data FROM config WHERE id=1").one().data) as Bot;
      expect(stored.computerApprovalMode).toBe("ask");
      expect(stored.updatedAt).toBe(bot.updatedAt);
      let calls=0;
      target.computer={...target.computer,exec:async(_botId,operationId)=>{calls++;return {operationId,status:"completed"};}};
      const result=await target.executeTool({operationId:`stale-config:${crypto.randomUUID()}`,runOperationId:run.operationId,action:{type:"exec",command:"printf requires-approval"}});
      expect(result.status).toBe("pending_approval");
      expect(calls).toBe(0);
    });
  });

  it("refreshes revoked automatic policy before a background dispatch without another bot request",async()=>{
    const bot=await createBot(),run=await submit(bot);
    await approvalFor(bot,run);
    await api(`/v1/bots/${bot.id}`,{computerApprovalMode:"automatic"},"PATCH");
    await api(`/v1/bots/${bot.id}/approvals`);
    await api(`/v1/bots/${bot.id}`,{computerApprovalMode:"ask"},"PATCH");
    await runInDurableObject(stubFor(bot),async(instance,state)=>{
      const target=instance as unknown as BotInternals;
      expect((JSON.parse(state.storage.sql.exec<{data:string}>("SELECT data FROM config WHERE id=1").one().data) as Bot).computerApprovalMode).toBe("automatic");
      let calls=0;
      target.computer={...target.computer,exec:async(_botId,operationId)=>{calls++;return {operationId,status:"completed"};}};
      const result=await target.executeTool({operationId:`revoke:${crypto.randomUUID()}`,runOperationId:run.operationId,action:{type:"exec",command:"printf requires-approval"}});
      expect(result.status).toBe("pending_approval");
      expect(calls).toBe(0);
      expect((await target.currentBot()).computerApprovalMode).toBe("ask");
    });
  });

  it("fails closed on unavailable current policy while leaving an existing pending decision inert",async()=>{
    const bot=await createBot(),run=await submit(bot),approval=await approvalFor(bot,run);
    await api(`/v1/bots/${bot.id}`,{computerApprovalMode:"automatic"},"PATCH");
    await api(`/v1/bots/${bot.id}/approvals`);
    const registry=bindings.WORKSPACE.get(bindings.WORKSPACE.idFromName("owner"));
    const saved=await runInDurableObject(registry,(_instance,state)=>{
      const row=state.storage.sql.exec<{data:string}>("SELECT data FROM bots WHERE id=?",bot.id).one();
      state.storage.sql.exec("DELETE FROM bots WHERE id=?",bot.id);
      return row.data;
    });
    try {
      await runInDurableObject(stubFor(bot),async(instance)=>{
        const target=instance as unknown as BotInternals;
        let calls=0;
        target.computer={...target.computer,exec:async(_botId,operationId)=>{calls++;return {operationId,status:"completed"};}};
        expect((await target.executeTool({operationId:approval.operationId,runOperationId:run.operationId,action:approval.action})).status).toBe("pending_approval");
        await expect(target.executeTool({operationId:`unavailable:${crypto.randomUUID()}`,runOperationId:run.operationId,action:approval.action})).rejects.toMatchObject({code:"bot_policy_unavailable",status:503});
        expect(calls).toBe(0);
      });
    } finally {
      await runInDurableObject(registry,(_instance,state)=>{state.storage.sql.exec("INSERT INTO bots(id,data) VALUES(?,?)",bot.id,saved);});
    }
  });

  it("rechecks cancellation after awaiting current settings before dispatch",async()=>{
    const bot=await createBot(),run=await submit(bot);
    await approvalFor(bot,run);
    await runInDurableObject(stubFor(bot),async(instance,state)=>{
      const target=instance as unknown as BotInternals;
      let ready!:()=>void,release!:()=>void,calls=0;
      const started=new Promise<void>(resolve=>{ready=resolve;});
      const gate=new Promise<void>(resolve=>{release=resolve;});
      target.currentBot=async()=>{ready();await gate;return {...bot,computerApprovalMode:"automatic"};};
      target.computer={...target.computer,exec:async(_botId,operationId)=>{calls++;return {operationId,status:"completed"};}};
      const executing=target.executeTool({operationId:`cancel-await:${crypto.randomUUID()}`,runOperationId:run.operationId,action:{type:"exec",command:"printf cancelled"}});
      await started;
      state.storage.sql.exec("UPDATE runs SET data=? WHERE id=?",JSON.stringify({...run,status:"cancelled"}),run.id);
      release();
      expect((await executing).status).toBe("interrupted");
      expect(calls).toBe(0);
    });
  });

  it("honors a decision created by another invocation while the registry lookup is pending",async()=>{
    const bot=await createBot(),run=await submit(bot);
    await approvalFor(bot,run);
    await runInDurableObject(stubFor(bot),async(instance,state)=>{
      const target=instance as unknown as BotInternals;
      let ready!:()=>void,release!:()=>void,calls=0;
      const started=new Promise<void>(resolve=>{ready=resolve;});
      const gate=new Promise<void>(resolve=>{release=resolve;});
      target.currentBot=async()=>{ready();await gate;return {...bot,computerApprovalMode:"automatic"};};
      target.computer={...target.computer,exec:async(_botId,operationId)=>{calls++;return {operationId,status:"completed"};}};
      const action:ComputerAction={type:"exec",command:"printf concurrent"};
      const hash=await fingerprint(action);
      const operationId=`concurrent:${crypto.randomUUID()}`;
      const executing=target.executeTool({operationId,runOperationId:run.operationId,action});
      await started;
      const approval:Approval={id:crypto.randomUUID(),botId:bot.id,runId:run.id,operationId,action,status:"pending",createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60_000).toISOString()};
      state.storage.sql.exec("INSERT INTO approvals(id,operation_id,fingerprint,data) VALUES(?,?,?,?)",approval.id,operationId,hash,JSON.stringify(approval));
      release();
      const result=await executing;
      expect(result).toMatchObject({status:"pending_approval",approvalId:approval.id});
      expect(calls).toBe(0);
    });
  });

  it("defaults a legacy bot without an approval mode to asking",async()=>{
    const bot=await createBot(),run=await submit(bot);
    await approvalFor(bot,run);
    await runInDurableObject(bindings.WORKSPACE.get(bindings.WORKSPACE.idFromName("owner")),(_instance,state)=>{
      const legacy=JSON.parse(state.storage.sql.exec<{data:string}>("SELECT data FROM bots WHERE id=?",bot.id).one().data) as Bot;
      delete legacy.computerApprovalMode;
      state.storage.sql.exec("UPDATE bots SET data=? WHERE id=?",JSON.stringify(legacy),bot.id);
    });
    await runInDurableObject(stubFor(bot),async(instance,state)=>{
      const target=instance as unknown as BotInternals;
      const config=JSON.parse(state.storage.sql.exec<{data:string}>("SELECT data FROM config WHERE id=1").one().data) as Bot;
      delete config.computerApprovalMode;
      state.storage.sql.exec("UPDATE config SET data=? WHERE id=1",JSON.stringify(config));
      let calls=0;
      target.computer={...target.computer,exec:async(_botId,operationId)=>{calls++;return {operationId,status:"completed"};}};
      const result=await target.executeTool({operationId:`legacy:${crypto.randomUUID()}`,runOperationId:run.operationId,action:{type:"exec",command:"printf legacy"}});
      expect(result.status).toBe("pending_approval");
      expect(calls).toBe(0);
    });
  });
});
