import { env, exports } from "cloudflare:workers";
import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import type { Approval, Bot, Message, Run } from "@botspace/contracts";
import type { Env } from "../../apps/api/src/env";

const bindings=env as unknown as Env;
const api=(path:string,body?:unknown)=>exports.default.fetch(`https://botspace.test${path}`,{
  method:body===undefined?"GET":"POST",headers:{authorization:"Bearer test-only-botspace-owner-token-000000","content-type":"application/json"},
  ...(body===undefined?{}:{body:JSON.stringify(body)}),
});
const messages=async(bot:Bot)=>(await (await api(`/v1/bots/${bot.id}/messages`)).json<{messages:Message[]}>()).messages;
async function status(bot:Bot,run:Run,value:Run["status"]) {
  for(let i=0;i<100;i++) {
    const current=(await (await api(`/v1/bots/${bot.id}/runs/${run.id}`)).json<{run:Run}>()).run;
    if(current.status===value) return;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  throw new Error(`Run did not become ${value}`);
}

it("keeps approval commentary as progress exactly once and persists a separate final answer after approval",async()=>{
  const {bot}=await (await api("/v1/bots",{name:"Approval progress"})).json<{bot:Bot}>();
  const {run}=await (await api(`/v1/bots/${bot.id}/messages`,{text:"request-multistep-recovery",operationId:crypto.randomUUID()})).json<{run:Run}>();
  await status(bot,run,"waiting_approval");
  // Wait for original native submission observation as well as live projection.
  await new Promise(resolve=>setTimeout(resolve,30));
  expect((await messages(bot)).filter(message=>message.role==="assistant").map(({kind,text})=>({kind,text}))).toEqual([{kind:"progress",text:"Working on fixture round 1."}]);
  const [approval]=(await (await api(`/v1/bots/${bot.id}/approvals`)).json<{approvals:Approval[]}>()).approvals;
  expect(approval.toolCallId).toBe("call_multistep_0_0|fc_multistep_0_0");
  expect((await api(`/v1/bots/${bot.id}/approvals/${approval.id}`,{decision:"approve"})).status).toBe(200);
  await status(bot,run,"completed");
  expect((await messages(bot)).filter(message=>message.role==="assistant").map(message=>message.kind)).toEqual(["progress","final"]);
  await runInDurableObject(bindings.BOT.get(bindings.BOT.idFromName(`owner:${bot.id}`)),(_instance,state)=>{
    const data=JSON.parse(state.storage.sql.exec<{data:string}>("SELECT data FROM events WHERE source_key=?",`tool:${approval.operationId}`).one().data);
    expect(data.data).toMatchObject({operationId:approval.operationId,toolCallId:approval.toolCallId,result:{status:"completed"}});
  });
});

it("persists automatic multi-tool progress plus one final answer and deduplicates native replay after restart",async()=>{
  const {bot}=await (await api("/v1/bots",{name:"Automatic progress",computerApprovalMode:"automatic"})).json<{bot:Bot}>();
  const {run}=await (await api(`/v1/bots/${bot.id}/messages`,{text:"request-multistep-recovery",operationId:crypto.randomUUID()})).json<{run:Run}>();
  await status(bot,run,"completed");
  const before=(await messages(bot)).filter(message=>message.role==="assistant");
  expect(before.map(message=>message.kind)).toEqual(["progress","progress","progress","final"]);
  expect(before[3].text).toBe("Completed both commands, opened the page, and checked the screenshot.");
  await runInDurableObject(bindings.BOT.get(bindings.BOT.idFromName(`owner:${bot.id}`)),(_instance,state)=>{
    const toolEvents=state.storage.sql.exec<{data:string}>("SELECT data FROM events WHERE source_key LIKE 'tool:%'").toArray().map(row=>JSON.parse(row.data).data);
    expect(toolEvents).toHaveLength(4);
    for(const event of toolEvents) expect(event).toMatchObject({toolCallId:expect.any(String),operationId:expect.any(String),result:{status:"completed"}});
  });
  await abortAllDurableObjects();
  expect((await messages(bot)).filter(message=>message.role==="assistant")).toEqual(before);
});
