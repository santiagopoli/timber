import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import type { Approval, Bot, Message, Run } from "@botspace/contracts";
import type { Env } from "../../apps/api/src/env";

const bindings=env as unknown as Env;
const api=(path:string,body?:unknown)=>exports.default.fetch(`https://botspace.test${path}`,{
  method:body===undefined?"GET":"POST",headers:{authorization:"Bearer test-only-botspace-owner-token-000000","content-type":"application/json"},
  ...(body===undefined?{}:{body:JSON.stringify(body)}),
});
async function until<T>(read:()=>Promise<T>,predicate:(value:T)=>boolean):Promise<T> {
  for(let i=0;i<200;i++) {const value=await read();if(predicate(value)) return value;await new Promise(resolve=>setTimeout(resolve,10));}
  throw new Error("Real Pi did not reach the expected durable state");
}
it.each(["ask","automatic"] as const)("persists the final assistant answer after a real Pi command in %s mode without replaying the command",async(computerApprovalMode)=>{
  const beforeCalls=await runInDurableObject(bindings.CHATGPT!.get(bindings.CHATGPT!.idFromName("owner")),(_instance,state)=>
    state.storage.sql.exec<{total:number}>("SELECT COUNT(*) AS total FROM inference_calls").one().total);
  const created=await api("/v1/bots",{name:`Real Pi ${computerApprovalMode}`,computerApprovalMode});
  expect(created.status).toBe(201);
  const {bot}=await created.json<{bot:Bot}>();
  const submitted=await api(`/v1/bots/${bot.id}/messages`,{text:"request-exec",operationId:crypto.randomUUID()});
  expect(submitted.status).toBe(202);
  const {run}=await submitted.json<{run:Run}>();
  const getRun=async()=>(await (await api(`/v1/bots/${bot.id}/runs/${run.id}`)).json<{run:Run}>()).run;
  if(computerApprovalMode==="ask") {
    const [approval]=await until(async()=>(await (await api(`/v1/bots/${bot.id}/approvals`)).json<{approvals:Approval[]}>()).approvals,list=>list[0]?.status==="pending");
    await until(getRun,value=>value.status==="waiting_approval");
    expect((await api(`/v1/bots/${bot.id}/approvals/${approval.id}`,{decision:"approve"})).status).toBe(200);
  }
  const final=await until(getRun,value=>["completed","failed","interrupted"].includes(value.status));
  expect(final).toMatchObject({status:"completed"});
  const {messages}=await (await api(`/v1/bots/${bot.id}/messages`)).json<{messages:Message[]}>();
  expect(messages.filter(message=>message.role==="assistant").map(message=>message.text)).toEqual(["Hello from ChatGPT via the real Pi harness."]);
  const computer=bindings.COMPUTER.get(bindings.COMPUTER.idFromName(bot.id));
  expect(await runInDurableObject(computer,(_instance,state)=>state.storage.sql.exec<{total:number}>("SELECT COUNT(*) AS total FROM effects").one().total)).toBe(1);
  const calls=await runInDurableObject(bindings.CHATGPT!.get(bindings.CHATGPT!.idFromName("owner")),(_instance,state)=>
    state.storage.sql.exec<{input:string}>("SELECT input FROM inference_calls WHERE id>? ORDER BY id",beforeCalls).toArray());
  expect(calls).toHaveLength(2);
  expect(calls[1].input).toContain("fixture effect completed");
  expect((await (await api(`/v1/bots/${bot.id}/runs`)).json<{activeRuns:Run[]}>()).activeRuns).toEqual([]);
});
