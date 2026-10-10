import {env,exports} from "cloudflare:workers";
import {describe,expect,it} from "vitest";
import type {Bot,Task} from "@botspace/contracts";
import {computerFixtureControl} from "./fixtures/worker";
import type {Env} from "../apps/api/src/env";
const token="test-only-botspace-owner-token-000000";
const bindings=env as unknown as Env;
const api=(path:string,init:RequestInit={})=>exports.default.fetch(`https://botspace.test${path}`,{...init,headers:{authorization:`Bearer ${token}`,"content-type":"application/json",...init.headers}});
async function createBot():Promise<Bot>{const r=await api("/v1/bots",{method:"POST",body:JSON.stringify({name:"Task bot"})});expect(r.status).toBe(201);return (await r.json<{bot:Bot}>()).bot;}
describe("global task API",()=>{
 it("creates idempotent pending tasks and gives each task an isolated transcript",async()=>{
  const bot=await createBot(),operationId=crypto.randomUUID();
  const payload={operationId,title:"Research",description:"Find useful information",botId:bot.id,startImmediately:false};
  const created=await api("/v1/tasks",{method:"POST",body:JSON.stringify(payload)});expect(created.status).toBe(201);
  const {task}=await created.json<{task:Task}>();expect(task.status).toBe("pending");expect(task.botId).toBe(bot.id);
  const replay=await api("/v1/tasks",{method:"POST",body:JSON.stringify(payload)});expect(replay.status).toBe(200);expect((await replay.json<{task:Task}>()).task.id).toBe(task.id);
  const list=await api("/v1/tasks");expect((await list.json<{tasks:Task[]}>()).tasks.map(t=>t.id)).toContain(task.id);
  expect((await api(`/v1/tasks/${task.id}/messages`)).status).toBe(200);
  const main=await api(`/v1/bots/${bot.id}/messages`);expect((await main.json<{messages:unknown[]}>()).messages).toHaveLength(0);
  expect((await api(`/v1/tasks/${task.id}`)).status).toBe(200);
  expect((await api(`/v1/tasks/${crypto.randomUUID()}/messages`)).status).toBe(404);
 },60000);
 it("fences a cancelled task from new chat input",async()=>{const bot=await createBot();const created=await api("/v1/tasks",{method:"POST",body:JSON.stringify({operationId:crypto.randomUUID(),title:"Stop me",description:"",botId:bot.id,startImmediately:false})});const {task}=await created.json<{task:Task}>();const cancelled=await api(`/v1/tasks/${task.id}/cancel`,{method:"POST"});expect(cancelled.status).toBe(200);expect((await api(`/v1/tasks/${task.id}/messages`,{method:"POST",body:JSON.stringify({operationId:crypto.randomUUID(),text:"Continue"})})).status).toBe(409);},60000);
 it("requires explicit allowTaskCreation for bot task creation",async()=>{const bot=await createBot(),registry=bindings.WORKSPACE.get(bindings.WORKSPACE.idFromName("owner"));const payload={operationId:crypto.randomUUID(),title:"Bot task",description:"Do it",sourceBotId:bot.id,sourceRunId:crypto.randomUUID()};const denied=await registry.fetch("https://workspace/tasks/bot",{method:"POST",headers:{"content-type":"application/json","x-timber-internal":"task"},body:JSON.stringify(payload)});expect(denied.status).toBe(403);expect((await denied.json<{error:{code:string}}>() ).error.code).toBe("task_creation_not_allowed");expect((await api(`/v1/bots/${bot.id}`,{method:"PATCH",body:JSON.stringify({allowTaskCreation:true})})).status).toBe(200);const allowed=await registry.fetch("https://workspace/tasks/bot",{method:"POST",headers:{"content-type":"application/json","x-timber-internal":"task"},body:JSON.stringify(payload)});expect(allowed.status).toBe(201);expect((await allowed.json<{task:Record<string,unknown>}>()).task).toMatchObject({creator:"bot",createdByBotId:bot.id,sourceRunId:payload.sourceRunId,status:"pending"});},60000);
 it("blocks ordinary bot computer work while a task holds its shared-computer slot",async()=>{const bot=await createBot();const created=await api("/v1/tasks",{method:"POST",body:JSON.stringify({operationId:crypto.randomUUID(),title:"Exclusive task",description:"",botId:bot.id,startImmediately:false})});const {task}=await created.json<{task:Task}>();const registry=bindings.WORKSPACE.get(bindings.WORKSPACE.idFromName("owner"));const claim=await registry.fetch(`https://workspace/tasks/${task.id}/claim`,{method:"POST"});expect(claim.status).toBe(200);const message=await api(`/v1/bots/${bot.id}/messages`,{method:"POST",body:JSON.stringify({operationId:crypto.randomUUID(),text:"Please proceed"})});expect(message.status).toBe(409);const action=await api(`/v1/bots/${bot.id}/computer/actions`,{method:"POST",body:JSON.stringify({operationId:crypto.randomUUID(),action:{type:"key",key:"Escape"}})});expect(action.status).toBe(409);await registry.fetch(`https://workspace/tasks/${task.id}/release`,{method:"POST"});},60000);
 it("blocks direct mutations while a human holds desktop control",async()=>{const bot=await createBot();computerFixtureControl.controlled=true;try{const response=await api(`/v1/bots/${bot.id}/computer/actions`,{method:"POST",body:JSON.stringify({operationId:crypto.randomUUID(),action:{type:"key",key:"Escape"}})});expect(response.status).toBe(409);}finally{delete computerFixtureControl.controlled;}},60000);
 it("serializes a direct computer action racing a task lease",async()=>{
  const bot=await createBot(),created=await api("/v1/tasks",{method:"POST",body:JSON.stringify({operationId:crypto.randomUUID(),title:"Racing task",description:"",botId:bot.id,startImmediately:false})});
  const {task}=await created.json<{task:Task}>(),registry=bindings.WORKSPACE.get(bindings.WORKSPACE.idFromName("owner"));
  const [claim,action]=await Promise.all([
    registry.fetch(`https://workspace/tasks/${task.id}/claim`,{method:"POST"}),
    api(`/v1/bots/${bot.id}/computer/actions`,{method:"POST",body:JSON.stringify({operationId:crypto.randomUUID(),action:{type:"key",key:"Escape"}})}),
  ]);
  expect([200,409]).toContain(claim.status);expect([200,409,500]).toContain(action.status);
  if(claim.status===200)expect(action.status).toBe(409);
  if(action.status!==409)expect(claim.status).toBe(409);
 },60000);
 it("wakes a queued task from the durable alarm after the ordinary bot lease becomes idle",async()=>{
  const bot=await createBot(),registry=bindings.WORKSPACE.get(bindings.WORKSPACE.idFromName("owner"));
  expect((await registry.fetch(`https://workspace/tasks/bot-slot/${bot.id}`,{method:"POST"})).status).toBe(200);
  const created=await api("/v1/tasks",{method:"POST",body:JSON.stringify({operationId:crypto.randomUUID(),title:"Wake without polling",description:"Run after the bot lease clears",botId:bot.id,startImmediately:true})});
  expect(created.status).toBe(201);const {task}=await created.json<{task:Task}>();expect(task.status).toBe("queued");
  await new Promise(resolve=>setTimeout(resolve,6200));
  const latest=await api(`/v1/tasks/${task.id}`);expect(latest.status).toBe(200);
  expect(["running","waiting_approval","waiting_connection","completed","failed" ]).toContain((await latest.json<{task:Task}>()).task.status);
 },20000);
 it("fences and removes assigned tasks before deleting their bot computer",async()=>{const bot=await createBot();const created=await api("/v1/tasks",{method:"POST",body:JSON.stringify({operationId:crypto.randomUUID(),title:"Owned task",description:"",botId:bot.id,startImmediately:false})});const {task}=await created.json<{task:Task}>();const unopenedResponse=await api("/v1/tasks",{method:"POST",body:JSON.stringify({operationId:crypto.randomUUID(),title:"Unopened task",description:"",botId:bot.id,startImmediately:false})});const {task:unopened}=await unopenedResponse.json<{task:Task}>();expect((await api(`/v1/tasks/${task.id}/messages`)).status).toBe(200);const deletion=await api(`/v1/bots/${bot.id}`,{method:"DELETE"});expect(deletion.status).toBe(200);expect((await api(`/v1/tasks/${task.id}`)).status).toBe(404);expect((await api(`/v1/tasks/${unopened.id}`)).status).toBe(404);},60000);
 it("rejects operation-ID reuse with different task data",async()=>{const bot=await createBot(),operationId=crypto.randomUUID();const a={operationId,title:"one",description:"",botId:bot.id,startImmediately:false};expect((await api("/v1/tasks",{method:"POST",body:JSON.stringify(a)})).status).toBe(201);expect((await api("/v1/tasks",{method:"POST",body:JSON.stringify({...a,title:"two"})})).status).toBe(409);},60000);
});
