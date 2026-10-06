import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import type { Bot, Message, Run } from "@botspace/contracts";
import type { AgentRuntime } from "../packages/runtime/src/types";
import type { Env } from "../apps/api/src/env";

const bindings=env as unknown as Env;
const api=(path:string,body?:unknown)=>exports.default.fetch(`https://botspace.test${path}`,{
  method:body===undefined?"GET":"POST",headers:{authorization:"Bearer test-only-botspace-owner-token-000000","content-type":"application/json"},
  ...(body===undefined?{}:{body:JSON.stringify(body)}),
});
type Internals={runtime:AgentRuntime;admit(id:string):Promise<void>};
const stubFor=(bot:Bot)=>bindings.BOT.get(bindings.BOT.idFromName(`owner:${bot.id}`));
const current=async(bot:Bot,run:Run)=>(await (await api(`/v1/bots/${bot.id}/runs/${run.id}`)).json<{run:Run}>()).run;
async function setup() {
  const {bot}=await (await api("/v1/bots",{name:"Admission retry"})).json<{bot:Bot}>();
  await api(`/v1/bots/${bot.id}/messages`);
  return bot;
}
async function send(bot:Bot,text:string,operationId=crypto.randomUUID()) {
  const response=await api(`/v1/bots/${bot.id}/messages`,{text,operationId});
  expect(response.status).toBe(202);
  return (await response.json<{run:Run}>()).run;
}
async function completed(bot:Bot,run:Run) {
  for(let i=0;i<100;i++) {if((await current(bot,run)).status==="completed") return;await new Promise(resolve=>setTimeout(resolve,5));}
  expect((await current(bot,run)).status).toBe("completed");
}
async function inboxCounts(bot:Bot) {
  const {messages}=await (await api(`/v1/bots/${bot.id}/messages`)).json<{messages:Message[]}>();
  return {user:messages.filter(message=>message.role==="user").length,assistant:messages.filter(message=>message.role==="assistant").length};
}

it("keeps a transient input-admission failure queued and recovers the same saved message",async()=>{
  const bot=await setup();let calls=0;const wakes:{id:string;delay:number}[]=[];
  await runInDurableObject(stubFor(bot),instance=>{
    const target=instance as unknown as Internals,original=target.runtime;
    target.runtime={...original,submit:async(text,input)=>{calls++;if(calls===1) throw new Error("private transient provider detail");return original.submit(text,input);},scheduleAdmissionRetry:async(id,delay)=>{wakes.push({id,delay});}};
  });
  const run=await send(bot,"Save this message exactly once");
  expect(run).toMatchObject({status:"queued",error:"Message saved. Delivery to the agent is being retried."});
  expect(wakes).toEqual([{id:run.operationId,delay:1000}]);
  expect(await inboxCounts(bot)).toEqual({user:1,assistant:0});
  expect(calls).toBe(1); // Reads respect the durable backoff.
  await runInDurableObject(stubFor(bot),async(instance,state)=>{
    state.storage.sql.exec("UPDATE admission_retries SET next_at=0 WHERE operation_id=?",run.operationId);
    await (instance as unknown as Internals).admit(run.operationId);
  });
  await completed(bot,run);
  expect(calls).toBe(2);
  expect(await inboxCounts(bot)).toEqual({user:1,assistant:1});
  expect(JSON.stringify(await current(bot,run))).not.toContain("private transient");
});

it("reconciles a lost admission receipt from Pi without submitting the input again",async()=>{
  const bot=await setup();let calls=0,wakes=0;
  await runInDurableObject(stubFor(bot),instance=>{
    const target=instance as unknown as Internals,original=target.runtime;
    target.runtime={...original,submit:async(text,input)=>{calls++;await original.submit(text,input);throw new Error("Receipt transport disconnected");},scheduleAdmissionRetry:async()=>{wakes++;}};
  });
  const run=await send(bot,"Already accepted by native runtime");
  await completed(bot,run);
  expect(calls).toBe(1);expect(wakes).toBe(0);
  expect(await inboxCounts(bot)).toEqual({user:1,assistant:1});
});

it("bounds automatic delivery retries and lets an explicit identical retry recover exhausted admission",async()=>{
  const bot=await setup();let calls=0,available=false;const delays:number[]=[];
  await runInDurableObject(stubFor(bot),instance=>{
    const target=instance as unknown as Internals,original=target.runtime;
    target.runtime={...original,submit:async(text,input)=>{calls++;if(!available) throw new Error("Unavailable");return original.submit(text,input);},scheduleAdmissionRetry:async(_id,delay)=>{delays.push(delay);}};
  });
  const text="Retain the accepted inbox entry",run=await send(bot,text);
  for(let i=0;i<6;i++) await runInDurableObject(stubFor(bot),async(instance,state)=>{
    state.storage.sql.exec("UPDATE admission_retries SET next_at=0 WHERE operation_id=?",run.operationId);
    await (instance as unknown as Internals).admit(run.operationId);
  });
  expect(calls).toBe(5);expect(delays).toEqual([1000,2000,4000,8000]);
  expect((await current(bot,run)).error).toContain("Retry this message");
  available=true;
  expect((await send(bot,text,run.operationId)).id).toBe(run.id);
  await completed(bot,run);
  expect(calls).toBe(6);expect(await inboxCounts(bot)).toEqual({user:1,assistant:1});
});

it("allows explicit retry of a legacy unadmitted failure without reopening genuine model failures",async()=>{
  const bot=await setup();let calls=0,available=false;
  await runInDurableObject(stubFor(bot),instance=>{
    const target=instance as unknown as Internals,original=target.runtime;
    target.runtime={...original,submit:async(text,input)=>{calls++;if(!available) throw new Error("Unavailable");return original.submit(text,input);},scheduleAdmissionRetry:async()=>{}};
  });
  const run=await send(bot,"Legacy delivery failure");
  await runInDurableObject(stubFor(bot),(_instance,state)=>{
    state.storage.sql.exec("UPDATE runs SET data=? WHERE id=?",JSON.stringify({...run,status:"failed",error:"The agent runtime could not accept this run."}),run.id);
    state.storage.sql.exec("DELETE FROM admission_retries WHERE operation_id=?",run.operationId);
  });
  available=true;await send(bot,"Legacy delivery failure",run.operationId);await completed(bot,run);
  const failure=await send(bot,"fixture:model-error");
  for(let i=0;i<100 && (await current(bot,failure)).status!=="failed";i++) await new Promise(resolve=>setTimeout(resolve,5));
  expect((await current(bot,failure)).status).toBe("failed");
  const before=calls;
  await send(bot,"fixture:model-error",failure.operationId);
  expect(calls).toBe(before);expect((await current(bot,failure)).status).toBe("failed");
});

it("does not resurrect a cancelled message when its scheduled admission wake arrives",async()=>{
  const bot=await setup();let calls=0;
  await runInDurableObject(stubFor(bot),instance=>{
    const target=instance as unknown as Internals;
    target.runtime={...target.runtime,submit:async()=>{calls++;throw new Error("Unavailable");},scheduleAdmissionRetry:async()=>{}};
  });
  const run=await send(bot,"Cancel before delivery");
  expect((await api(`/v1/bots/${bot.id}/runs/${run.id}/cancel`,{})).status).toBe(200);
  await runInDurableObject(stubFor(bot),async(instance,state)=>{
    state.storage.sql.exec("UPDATE admission_retries SET next_at=0 WHERE operation_id=?",run.operationId);
    await (instance as unknown as Internals).admit(run.operationId);
  });
  expect((await send(bot,"Cancel before delivery",run.operationId)).status).toBe("cancelled");
  expect(calls).toBe(1);expect(await inboxCounts(bot)).toEqual({user:1,assistant:0});
});
