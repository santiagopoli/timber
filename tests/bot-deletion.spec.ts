import { env, exports } from "cloudflare:workers";
import { abortAllDurableObjects, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import type { Bot, ComputerAction, Run } from "@botspace/contracts";
import type { Env } from "../apps/api/src/env";
import { computerFixtureControl } from "./fixtures/worker";

const bindings=env as unknown as Env;
const api=(path:string,method="GET",body?:unknown,authorized=true)=>exports.default.fetch(`https://botspace.test${path}`,{
  method,headers:{...(authorized?{authorization:"Bearer test-only-botspace-owner-token-000000"}:{}),"content-type":"application/json"},
  ...(body===undefined?{}:{body:JSON.stringify(body)}),
});
const botStub=(bot:Bot)=>bindings.BOT.get(bindings.BOT.idFromName(`owner:${bot.id}`));
const computerStub=(bot:Bot)=>bindings.COMPUTER.get(bindings.COMPUTER.idFromName(bot.id));
const registry=()=>bindings.WORKSPACE.get(bindings.WORKSPACE.idFromName("owner"));
const create=async(name:string)=>(await (await api("/v1/bots","POST",{name})).json<{bot:Bot}>()).bot;
async function settled(bot:Bot,run:Run,status:Run["status"]="completed") {
  for(let i=0;i<100;i++) {
    const {run:current}=await (await api(`/v1/bots/${bot.id}/runs/${run.id}`)).json<{run:Run}>();
    if(current.status===status) return;
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  throw new Error("Run did not reach expected state");
}
const send=async(bot:Bot,text:string)=>(await (await api(`/v1/bots/${bot.id}/messages`,"POST",{text,operationId:crypto.randomUUID()})).json<{run:Run}>()).run;

it("permanently removes only the authenticated bot's data, fences stale requests, and is idempotent after eviction",async()=>{
  const bot=await create("Delete me"),other=await create("Keep me");
  const run=await send(bot,"Private conversation to remove");await settled(bot,run);
  const artifactId=crypto.randomUUID();
  await bindings.FILES.put(`bots/${bot.id}/artifacts/${artifactId}`,"private artifact");
  await bindings.FILES.put(`bots/${bot.id}/checkpoints/test.tar.gz`,"private checkpoint");
  await bindings.FILES.put(`bots/${other.id}/artifacts/keep`,"other bot's artifact");
  await api(`/v1/bots/${bot.id}/computer/actions`,"POST",{operationId:"manual-before-delete",action:{type:"listFiles"}});
  const auth=bindings.CHATGPT!.get(bindings.CHATGPT!.idFromName("owner"));
  await runInDurableObject(auth,(_instance,state)=>state.storage.put("deletion-test-shared","shared connection remains"));
  expect((await api(`/v1/bots/${bot.id}`,"DELETE",undefined,false)).status).toBe(401);
  expect((await api(`/v1/bots/${crypto.randomUUID()}`,"DELETE")).status).toBe(404);
  const removed=await api(`/v1/bots/${bot.id}`,"DELETE");
  expect(removed.status).toBe(200);expect(await removed.json()).toEqual({botId:bot.id,deleted:true});
  expect((await bindings.FILES.list({prefix:`bots/${bot.id}/`})).objects).toEqual([]);
  expect(await (await bindings.FILES.get(`bots/${other.id}/artifacts/keep`))!.text()).toBe("other bot's artifact");
  for(const suffix of ["","/messages","/runs","/approvals","/computer",`/artifacts/${artifactId}`]) expect((await api(`/v1/bots/${bot.id}${suffix}`)).status).toBe(404);
  expect((await api(`/v1/bots/${bot.id}`,"PATCH",{name:"Revived"})).status).toBe(404);
  expect((await api(`/v1/bots/${bot.id}/messages`,"POST",{text:"revive",operationId:crypto.randomUUID()})).status).toBe(404);
  const bots=(await (await api("/v1/bots")).json<{bots:Bot[]}>()).bots;
  expect(bots.some(value=>value.id===bot.id)).toBe(false);expect(bots.some(value=>value.id===other.id)).toBe(true);
  await runInDurableObject(botStub(bot),async(_instance,state)=>{
    for(const table of ["config","runs","messages","events","approvals","submissions","admission_retries"]) expect(state.storage.sql.exec<{total:number}>(`SELECT COUNT(*) AS total FROM ${table}`).one().total).toBe(0);
    expect(state.storage.sql.exec<{bot_id:string}>("SELECT bot_id FROM bot_deletion").one().bot_id).toBe(bot.id);
    expect(await state.storage.getAlarm()).toBeNull();
  });
  expect(await runInDurableObject(botStub(bot),(_instance,state)=>state.storage.list())).toEqual(new Map());
  expect(await runInDurableObject(auth,(_instance,state)=>state.storage.get("deletion-test-shared"))).toBe("shared connection remains");
  await abortAllDurableObjects();
  const stale=await botStub(bot).fetch("https://bot/messages",{headers:{"x-botspace-config":encodeURIComponent(JSON.stringify(bot))}});
  expect(stale.status).toBe(404);
  expect(await (await api(`/v1/bots/${bot.id}`,"DELETE")).json()).toEqual({botId:bot.id,deleted:true});
  expect((await computerStub(bot).fetch("https://computer/actions",{method:"POST",body:JSON.stringify({botId:bot.id,operationId:"stale",action:{type:"exec",command:"must not execute"}})})).status).toBe(410);
});

it("keeps a partially deleted bot inaccessible and completes cleanup from its durable alarm",async()=>{
  const bot=await create("Retry cleanup");
  await bindings.FILES.put(`bots/${bot.id}/artifacts/remove-after-stop`,"retain until fenced stop");
  computerFixtureControl.deleteFailure=true;
  try {
    const response=await api(`/v1/bots/${bot.id}`,"DELETE");
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({error:{code:"bot_deletion_pending"}});
    expect((await api(`/v1/bots/${bot.id}`)).status).toBe(404);
    expect((await bindings.FILES.list({prefix:`bots/${bot.id}/`})).objects).toHaveLength(1);
    expect(await runInDurableObject(registry(),(_instance,state)=>state.storage.getAlarm())).not.toBeNull();
  } finally {delete computerFixtureControl.deleteFailure;}
  await runInDurableObject(registry(),(_instance,state)=>{state.storage.sql.exec("UPDATE bot_deletions SET next_at=0 WHERE id=?",bot.id);});
  expect(await runDurableObjectAlarm(registry())).toBe(true);
  expect((await bindings.FILES.list({prefix:`bots/${bot.id}/`})).objects).toEqual([]);
  expect(await (await api(`/v1/bots/${bot.id}`,"DELETE")).json()).toEqual({botId:bot.id,deleted:true});
});

it("cannot resurrect a bot through a PATCH body that finishes after deletion",async()=>{
  const bot=await create("Concurrent edit/delete");
  let release!:(value:Uint8Array)=>void;
  const bytes=new Promise<Uint8Array>(resolve=>{release=resolve;});
  const request=new Request(`https://workspace/${bot.id}`,{method:"PATCH",headers:{"content-type":"application/json"},body:new ReadableStream({async start(controller){controller.enqueue(await bytes);controller.close();}})});
  const patch=registry().fetch(request);
  // The patch can have read membership, but cannot parse its body yet.
  await new Promise(resolve=>setTimeout(resolve,5));
  expect((await api(`/v1/bots/${bot.id}`,"DELETE")).status).toBe(200);
  release(new TextEncoder().encode(JSON.stringify({name:"Late edit"})));
  expect((await patch).status).toBe(404);
  expect((await api(`/v1/bots/${bot.id}`)).status).toBe(404);
});

it("blocks a tool resuming after deletion and ignores late native projection callbacks",async()=>{
  const bot=await create("Late callbacks");
  const run=await send(bot,"fixture:approval");await settled(bot,run,"waiting_approval");
  let enter!:()=>void,release!:()=>void;
  const entered=new Promise<void>(resolve=>{enter=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  type Internals={currentBot():Promise<Bot>;executeTool(input:{operationId:string;runOperationId:string;action:ComputerAction;signal:AbortSignal}):Promise<unknown>;project(event:{type:string;operationId:string;data:Record<string,unknown>}):Promise<void>};
  let late:Promise<unknown>=Promise.resolve();
  await runInDurableObject(botStub(bot),instance=>{
    const target=instance as unknown as Internals;
    target.currentBot=async()=>{enter();await gate;return {...bot,computerApprovalMode:"automatic"};};
    late=target.executeTool({operationId:"late-tool",runOperationId:run.operationId,action:{type:"exec",command:"must not execute"},signal:new AbortController().signal}).catch(error=>error);
  });
  await entered;
  expect((await api(`/v1/bots/${bot.id}`,"DELETE")).status).toBe(200);
  release();expect(await late).toMatchObject({code:"not_found"});
  await runInDurableObject(botStub(bot),async(instance,state)=>{
    await (instance as unknown as Internals).project({type:"run.completed",operationId:run.operationId,data:{text:"Late answer must not reappear"}});
    expect(state.storage.sql.exec<{total:number}>("SELECT COUNT(*) AS total FROM messages").one().total).toBe(0);
  });
  expect(await runInDurableObject(computerStub(bot),(_instance,state)=>state.storage.sql.exec<{total:number}>("SELECT COUNT(*) AS total FROM effects").one().total)).toBe(0);
});
