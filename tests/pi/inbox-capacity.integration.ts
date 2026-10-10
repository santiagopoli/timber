import { env, exports } from "cloudflare:workers";
import { abortAllDurableObjects, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import type { Approval, Bot, Message, Run } from "@botspace/contracts";
import type { Env } from "../../apps/api/src/env";
import type { AgentRuntime } from "../../packages/runtime/src/types";

const bindings=env as unknown as Env;
const api=(path:string,input?:unknown)=>exports.default.fetch(`https://timber.test${path}`,{
  method:input===undefined?"GET":"POST",headers:{authorization:"Bearer test-only-botspace-owner-token-000000","content-type":"application/json"},
  ...(input===undefined?{}:{body:JSON.stringify(input)}),
});
async function send(bot:Bot,text:string,operationId=crypto.randomUUID()) {
  const response=await api(`/v1/bots/${bot.id}/messages`,{text,operationId});
  expect(response.status).toBe(202);
  return (await response.json<{run:Run}>()).run;
}
async function current(bot:Bot,run:Run) {return (await (await api(`/v1/bots/${bot.id}/runs/${run.id}`)).json<{run:Run}>()).run;}
async function until(bot:Bot,run:Run,status:Run["status"]) {
  for(let i=0;i<300;i++) {if((await current(bot,run)).status===status) return;await new Promise(resolve=>setTimeout(resolve,10));}
  expect((await current(bot,run)).status).toBe(status);
}
it("the real Pi harness processes a 17th user input while sixteen approvals remain unresolved",async()=>{
  const {bot}=await (await api("/v1/bots",{name:"Real Pi seventeen inputs"})).json<{bot:Bot}>();
  const waiting:Run[]=[];
  for(let i=0;i<16;i++) {
    const run=await send(bot,`request-exec approval ${i}`);
    await until(bot,run,"waiting_approval");
    waiting.push(run);
  }
  const text="Answer a legitimate new user message; do not run or approve previous commands",run=await send(bot,text);
  await until(bot,run,"completed");
  expect((await send(bot,text,run.operationId)).id).toBe(run.id);
  for(const old of waiting) expect((await current(bot,old)).status).toBe("waiting_approval");
  const {approvals}=await (await api(`/v1/bots/${bot.id}/approvals`)).json<{approvals:Approval[]}>();
  expect(approvals).toHaveLength(16);
  expect(approvals.every(approval=>approval.status==="pending")).toBe(true);
  const {messages}=await (await api(`/v1/bots/${bot.id}/messages`)).json<{messages:Message[]}>();
  expect(messages.filter(message=>message.runId===run.id && message.role==="user")).toHaveLength(1);
  expect(messages.filter(message=>message.runId===run.id && message.role==="assistant")).toHaveLength(1);
  const computer=bindings.COMPUTER.get(bindings.COMPUTER.idFromName(bot.id));
  expect(await runInDurableObject(computer,(_instance,state)=>state.storage.sql.exec<{total:number}>("SELECT COUNT(*) AS total FROM effects").one().total)).toBe(0);
},60_000);

it("a native-capacity wait wakes through the real Lifecycle alarm after eviction without a browser read",async()=>{
  const {bot}=await (await api("/v1/bots",{name:"Capacity alarm recovery"})).json<{bot:Bot}>();
  await api(`/v1/bots/${bot.id}/messages`);
  let stub=bindings.BOT.get(bindings.BOT.idFromName(`owner:${bot.id}`));
  await runInDurableObject(stub,instance=>{
    const target=instance as unknown as {runtime:AgentRuntime},original=target.runtime;
    target.runtime={...original,pending:async()=>Array.from({length:16},(_,index)=>({operationId:`full-inbox-${index}`,status:"queued" as const}))};
  });
  const run=await send(bot,"Saved behind a full native inbox");
  expect(run).toMatchObject({status:"queued",error:"Message saved. Waiting for space in the agent inbox."});
  await abortAllDurableObjects();
  stub=bindings.BOT.get(bindings.BOT.idFromName(`owner:${bot.id}`));
  await new Promise(resolve=>setTimeout(resolve,1100));
  await runDurableObjectAlarm(stub);
  // Read only SQL; do not invoke HTTP's opportunistic admission recovery.
  const read=()=>runInDurableObject(stub,(_instance,state)=>JSON.parse(state.storage.sql.exec<{data:string}>("SELECT data FROM runs WHERE id=?",run.id).one().data) as Run);
  let stored=await read();
  for(let i=0;i<300 && stored.status!=="completed";i++) {await new Promise(resolve=>setTimeout(resolve,10));stored=await read();}
  expect(stored.status).toBe("completed");
  const {messages}=await (await api(`/v1/bots/${bot.id}/messages`)).json<{messages:Message[]}>();
  expect(messages.filter(message=>message.role==="user")).toHaveLength(1);
  expect(messages.filter(message=>message.role==="assistant")).toHaveLength(1);
});
