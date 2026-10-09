import { env, exports } from "cloudflare:workers";
import { abortAllDurableObjects, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import type { Approval, Bot, Message, Run } from "@botspace/contracts";
import type { Env } from "../../apps/api/src/env";
import { inferenceFixtureControl } from "./worker";
import type { AgentRuntime } from "../../packages/runtime/src/types";

const bindings=env as unknown as Env;
const api=(path:string,body?:unknown)=>exports.default.fetch(`https://botspace.test${path}`,{
  method:body===undefined?"GET":"POST",headers:{authorization:"Bearer test-only-botspace-owner-token-000000","content-type":"application/json"},
  ...(body===undefined?{}:{body:JSON.stringify(body)}),
});
async function until<T>(read:()=>Promise<T>,predicate:(value:T)=>boolean):Promise<T> {
  for(let i=0;i<200;i++) {const value=await read();if(predicate(value)) return value;await new Promise(resolve=>setTimeout(resolve,10));}
  throw new Error("Real Pi did not process its durable inbox");
}
const getRun=async(bot:Bot,run:Run)=>(await (await api(`/v1/bots/${bot.id}/runs/${run.id}`)).json<{run:Run}>()).run;
const send=async(bot:Bot,text:string,operationId=crypto.randomUUID())=>{
  const response=await api(`/v1/bots/${bot.id}/messages`,{text,operationId});
  expect(response.status).toBe(202);
  return (await response.json<{run:Run}>()).run;
};
it("accepts and processes distinct messages queued behind a busy real Pi run exactly once",async()=>{
  const {bot}=await (await api("/v1/bots",{name:"Busy real Pi inbox"})).json<{bot:Bot}>();
  let release!:()=>void;
  inferenceFixtureControl.matches="slow-first-message";
  inferenceFixtureControl.gate=new Promise(resolve=>{release=resolve;});
  try {
    const first=await send(bot,"slow-first-message");
    await until(()=>getRun(bot,first),value=>value.status==="running");
    const second=await send(bot,"second-follow-up");
    const third=await send(bot,"third-follow-up");
    expect(second.status).toBe("queued");
    expect(third.status).toBe("queued");
    const duplicate=await send(bot,"second-follow-up",second.operationId);
    expect(duplicate.id).toBe(second.id);
    expect((await getRun(bot,second)).status).toBe("queued");
    release();
    for(const run of [first,second,third]) expect(await until(()=>getRun(bot,run),value=>["completed","failed","interrupted"].includes(value.status))).toMatchObject({status:"completed"});
    const {messages}=await (await api(`/v1/bots/${bot.id}/messages`)).json<{messages:Message[]}>();
    expect(messages.filter(message=>message.role==="user").map(message=>message.text)).toEqual(["slow-first-message","second-follow-up","third-follow-up"]);
    for(const run of [first,second,third]) expect(messages.filter(message=>message.role==="assistant" && message.runId===run.id)).toHaveLength(1);
    expect((await (await api(`/v1/bots/${bot.id}/runs`)).json<{activeRuns:Run[]}>()).activeRuns).toEqual([]);
  } finally {release();delete inferenceFixtureControl.gate;delete inferenceFixtureControl.matches;}
});

it("processes a fresh message while an older run waits for approval without approving its action",async()=>{
  const {bot}=await (await api("/v1/bots",{name:"Pending approval real Pi inbox"})).json<{bot:Bot}>();
  const first=await send(bot,"request-exec");
  await until(()=>getRun(bot,first),value=>value.status==="waiting_approval");
  const second=await send(bot,"Answer this fresh message while the previous action remains pending");
  expect(await until(()=>getRun(bot,second),value=>["completed","failed","interrupted"].includes(value.status))).toMatchObject({status:"completed"});
  expect((await getRun(bot,first)).status).toBe("waiting_approval");
  const {approvals}=await (await api(`/v1/bots/${bot.id}/approvals`)).json<{approvals:Approval[]}>();
  expect(approvals).toHaveLength(1);
  expect(approvals[0].status).toBe("pending");
  const {messages}=await (await api(`/v1/bots/${bot.id}/messages`)).json<{messages:Message[]}>();
  expect(messages.filter(message=>message.role==="assistant" && message.runId===second.id)).toHaveLength(1);
  const computer=bindings.COMPUTER.get(bindings.COMPUTER.idFromName(bot.id));
  expect(await runInDurableObject(computer,(_instance,state)=>state.storage.sql.exec<{total:number}>("SELECT COUNT(*) AS total FROM effects").one().total)).toBe(0);
});

it("wakes an unadmitted saved message durably after object eviction with no browser polling",async()=>{
  const {bot}=await (await api("/v1/bots",{name:"Durable admission wake"})).json<{bot:Bot}>();
  await api(`/v1/bots/${bot.id}/messages`);
  let stub=bindings.BOT.get(bindings.BOT.idFromName(`owner:${bot.id}`));
  await runInDurableObject(stub,instance=>{
    const target=instance as unknown as {runtime:AgentRuntime};
    target.runtime={...target.runtime,submit:async()=>{throw new Error("Transient delivery transport failure");}};
  });
  const run=await send(bot,"Reply to this durably saved message after admission recovers");
  expect(run.status).toBe("queued");
  expect(run.error).toContain("Delivery to the agent is being retried");
  await abortAllDurableObjects();
  stub=bindings.BOT.get(bindings.BOT.idFromName(`owner:${bot.id}`));
  // The real shared Lifecycle alarm must admit the saved input. No API GET or
  // repeated POST is allowed to invoke BotDO.fetch's opportunistic recovery.
  await new Promise(resolve=>setTimeout(resolve,1100));
  await runDurableObjectAlarm(stub);
  const readStored=()=>runInDurableObject(stub,(_instance,state)=>JSON.parse(state.storage.sql.exec<{data:string}>("SELECT data FROM runs WHERE id=?",run.id).one().data) as Run);
  expect(await until(readStored,value=>["completed","failed","interrupted"].includes(value.status))).toMatchObject({status:"completed"});
  const {messages}=await (await api(`/v1/bots/${bot.id}/messages`)).json<{messages:Message[]}>();
  expect(messages.filter(message=>message.role==="user")).toHaveLength(1);
  expect(messages.filter(message=>message.role==="assistant")).toHaveLength(1);
  expect(messages.find(message=>message.role==="assistant")?.text).toBe("Hello from ChatGPT via the real Pi harness.");
});


it("retains the chosen model configuration when a saved run is admitted after a settings change and eviction",async()=>{
  const create=await api("/v1/bots",{name:"Model snapshot",model:"gpt-6.1-sol",reasoningEffort:"high",fast:true});
  const {bot}=await create.json<{bot:Bot}>();
  await api(`/v1/bots/${bot.id}/messages`);
  let stub=bindings.BOT.get(bindings.BOT.idFromName(`owner:${bot.id}`));
  await runInDurableObject(stub,instance=>{const target=instance as unknown as {runtime:AgentRuntime};target.runtime={...target.runtime,submit:async()=>{throw new Error("Transient delivery");}};});
  const run=await send(bot,"remember the selected inference settings");
  expect(run).toMatchObject({model:"gpt-6.1-sol",reasoningEffort:"high",fast:true,status:"queued"});
  const patch=await exports.default.fetch(`https://botspace.test/v1/bots/${bot.id}`,{method:"PATCH",headers:{authorization:"Bearer test-only-botspace-owner-token-000000","content-type":"application/json"},body:JSON.stringify({reasoningEffort:"low",fast:false})});
  expect(patch.status).toBe(200);
  await abortAllDurableObjects();
  stub=bindings.BOT.get(bindings.BOT.idFromName(`owner:${bot.id}`));
  await new Promise(resolve=>setTimeout(resolve,1100));await runDurableObjectAlarm(stub);
  expect(await until(()=>getRun(bot,run),value=>["completed","failed","interrupted"].includes(value.status))).toMatchObject({status:"completed",reasoningEffort:"high",fast:true});
  const provider=bindings.CHATGPT!.get(bindings.CHATGPT!.idFromName("owner"));
  const payload=await runInDurableObject(provider,(_instance,state)=>state.storage.sql.exec<{input:string}>("SELECT input FROM inference_calls ORDER BY id DESC LIMIT 1").one().input);
  expect(JSON.parse(payload)).toMatchObject({model:"gpt-6.1-sol",reasoning:{effort:"high"},service_tier:"fast"});
});
