import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import type { Approval, Bot, Message, Run } from "@botspace/contracts";
import type { AgentRuntime } from "../packages/runtime/src/types";
import type { Env } from "../apps/api/src/env";

const bindings=env as unknown as Env;
const api=(path:string,body?:unknown)=>exports.default.fetch(`https://botspace.test${path}`,{
  method:body===undefined?"GET":"POST",
  headers:{authorization:"Bearer test-only-botspace-owner-token-000000","content-type":"application/json"},
  ...(body===undefined?{}:{body:JSON.stringify(body)}),
});
type Internals={runtime:AgentRuntime;observe(id:string):void;admit(id:string):Promise<void>};
async function until<T>(read:()=>Promise<T>,matches:(value:T)=>boolean):Promise<T> {
  for(let i=0;i<100;i++) {const value=await read();if(matches(value)) return value;await new Promise(resolve=>setTimeout(resolve,5));}
  throw new Error("Expected continuation state was not reached");
}

it.each(["observation","admission"] as const)("ignores a late original %s failure after the approved effect has queued its answer",async(kind)=>{
  const {bot}=await (await api("/v1/bots",{name:`Late ${kind}`})).json<{bot:Bot}>();
  const originalId=crypto.randomUUID();
  const {run}=await (await api(`/v1/bots/${bot.id}/messages`,{text:"fixture:approval",operationId:originalId})).json<{run:Run}>();
  const readRun=async()=>(await (await api(`/v1/bots/${bot.id}/runs/${run.id}`)).json<{run:Run}>()).run;
  const approvals=async()=>(await (await api(`/v1/bots/${bot.id}/approvals`)).json<{approvals:Approval[]}>()).approvals;
  const [approval]=await until(approvals,list=>list[0]?.status==="pending");
  await until(readRun,value=>value.status==="waiting_approval");
  // Allow the original fixture observer to settle before installing a second,
  // delayed transport observation of that same durable native operation.
  await new Promise(resolve=>setTimeout(resolve,20));
  let rejectOriginal!:(error:Error)=>void;
  const oldFailure=new Promise<never>((_resolve,reject)=>{rejectOriginal=reject;});
  let finishAnswer!:(value:Awaited<ReturnType<AgentRuntime["wait"]>>)=>void;
  const answer=new Promise<Awaited<ReturnType<AgentRuntime["wait"]>>>(resolve=>{finishAnswer=resolve;});
  let continuationWaited=false;
  const stub=bindings.BOT.get(bindings.BOT.idFromName(`owner:${bot.id}`));
  await runInDurableObject(stub,(instance,state)=>{
    const target=instance as unknown as Internals,original=target.runtime;
    target.runtime={...original,
      submit:(text,input)=>input.operationId===originalId?oldFailure:original.submit(text,input),
      wait:id=>{if(id===originalId) return oldFailure;continuationWaited=true;return answer;},
    };
    if(kind==="observation") target.observe(originalId);
    else {
      const active={...run,status:"queued"};
      state.storage.sql.exec("UPDATE runs SET data=? WHERE id=?",JSON.stringify(active),run.id);
      state.storage.sql.exec("UPDATE submissions SET admitted=0 WHERE operation_id=?",originalId);
      state.waitUntil(target.admit(originalId));
    }
  });
  try {
    expect((await api(`/v1/bots/${bot.id}/approvals/${approval.id}`,{decision:"approve"})).status).toBe(200);
    await until(async()=>continuationWaited,Boolean);
    expect((await approvals())[0].status).toBe("completed");
    rejectOriginal(new Error("late transport error from the old paused operation"));
    await new Promise(resolve=>setTimeout(resolve,20));
    expect((await readRun()).status).toBe("queued");
    finishAnswer({operationId:`approval:${approval.id}`,status:"done",text:"The command completed successfully."});
    await until(readRun,value=>value.status==="completed");
    const {messages}=await (await api(`/v1/bots/${bot.id}/messages`)).json<{messages:Message[]}>();
    expect(messages.filter(message=>message.role==="assistant").map(message=>message.text)).toEqual(["The command completed successfully."]);
    const computer=bindings.COMPUTER.get(bindings.COMPUTER.idFromName(bot.id));
    expect(await runInDurableObject(computer,(_instance,state)=>state.storage.sql.exec<{total:number}>("SELECT COUNT(*) AS total FROM effects").one().total)).toBe(1);
  } finally {
    rejectOriginal(new Error("test cleanup"));
    finishAnswer({operationId:`approval:${approval.id}`,status:"unanswered",reason:"aborted"});
  }
});
