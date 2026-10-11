import {env,exports} from "cloudflare:workers";
import {evictDurableObject,runInDurableObject} from "cloudflare:test";
import {describe,expect,it} from "vitest";
import type {Bot,Task} from "@botspace/contracts";
import type {Env} from "../apps/api/src/env";

const bindings=env as unknown as Env;
const api=async<T>(path:string,input?:unknown,token="test-only-botspace-owner-token-000000")=>{
  const response=await exports.default.fetch(`https://timber.test${path}`,{method:input===undefined?"GET":"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},...(input===undefined?{}:{body:JSON.stringify(input)})});
  return {status:response.status,data:await response.json<T>()};
};
const registry=()=>bindings.WORKSPACE.get(bindings.WORKSPACE.idFromName("owner"));

describe("native dedicated bot + global task creation",()=>{
  it("creates a paired pending bot/task with safe defaults and replays the same pair",async()=>{
    const input={operationId:crypto.randomUUID(),title:"Dedicated task",description:"Initial dedicated transcript",startImmediately:false,newBot:{name:"Dedicated fixture",instructions:"Only for this task",allowNamedAgents:true}};
    const first=await api<{task:Task;bot:Bot}>("/v1/tasks",input);
    expect(first.status).toBe(201);
    expect(first.data.task).toMatchObject({title:input.title,botId:first.data.bot.id,botName:first.data.bot.name,status:"pending",dedicatedBot:true,startImmediately:false});
    expect(first.data.bot).toMatchObject({name:"Dedicated fixture",instructions:input.newBot.instructions,taskId:first.data.task.id,computerApprovalMode:"ask",allowNamedAgents:true,allowTaskCreation:false});
    await evictDurableObject(registry());
    const replay=await api<{task:Task;bot:Bot}>("/v1/tasks",input);
    expect(replay.status).toBe(200);
    expect(replay.data).toEqual(first.data);
    await evictDurableObject(registry());
    const changedAfterEviction=await api("/v1/tasks",{...input,title:"changed after eviction"});
    expect(changedAfterEviction.status).toBe(409);
    const changed=await api("/v1/tasks",{...input,newBot:{...input.newBot,allowNamedAgents:false}});
    expect(changed.status).toBe(409);
    const rows=await runInDurableObject(registry(),(_instance,state)=>({bots:state.storage.sql.exec<{id:string}>("SELECT id FROM bots WHERE id=?",first.data.bot.id).toArray().length,tasks:state.storage.sql.exec<{id:string}>("SELECT id FROM tasks WHERE id=?",first.data.task.id).toArray().length}));
    expect(rows).toEqual({bots:1,tasks:1});
  });

  it("requires exactly one bot source and rejects invalid new bot settings without orphan rows",async()=>{
    const bot=await api<{bot:Bot}>("/v1/bots",{name:"Existing task owner"});
    expect(bot.status).toBe(201);
    const base={operationId:crypto.randomUUID(),title:"Invalid pair",description:""};
    for(const both of [
      {...base,botId:bot.data.bot.id,newBot:{name:"Also new"}},
      {...base},
    ])expect((await api("/v1/tasks",both)).status).toBe(400);
    const sameOperation=crypto.randomUUID();
    const invalidModel=await api("/v1/tasks",{...base,operationId:sameOperation,newBot:{name:"Unknown explicit model",model:"not-in-any-catalog"}});
    expect(invalidModel.status).toBe(409);
    expect(invalidModel.data).toMatchObject({error:{code:"invalid_model_settings"}});
    const laterValid=await api("/v1/tasks",{...base,operationId:sameOperation,newBot:{name:"Valid after rejected explicit model"}});
    expect(laterValid.status).toBe(201);
    const operationId=crypto.randomUUID();
    const invalid=await api("/v1/tasks",{...base,operationId,newBot:{name:"Invalid settings",fast:"yes"}});
    expect(invalid.status).toBe(400);
    const rows=await runInDurableObject(registry(),(_instance,state)=>({bots:state.storage.sql.exec<{id:string}>("SELECT id FROM bots WHERE data LIKE '%Invalid settings%' OR data LIKE '%Unknown explicit model%'").toArray().length,receipt:state.storage.sql.exec<{operation_id:string}>("SELECT operation_id FROM task_operations WHERE operation_id=?",operationId).toArray().length}));
    expect(rows).toEqual({bots:0,receipt:0});
    const changed=await api("/v1/tasks",{...base,operationId:sameOperation,title:"Conflicting replay",newBot:{name:"Valid after rejected explicit model"}});
    expect(changed.status).toBe(409);
  });

  it("creates isolated task transcripts and independent bot computer identities",async()=>{
    const make=async(name:string)=>{
      const created=await api<{task:Task;bot:Bot}>("/v1/tasks",{operationId:crypto.randomUUID(),title:name,description:`${name} initial`,startImmediately:false,newBot:{name}});
      expect(created.status).toBe(201);
      const taskMessages=await api<{messages:unknown[]}>(`/v1/tasks/${created.data.task.id}/messages`);
      const botMessages=await api<{messages:unknown[]}>(`/v1/bots/${created.data.bot.id}/messages`);
      expect(taskMessages.data.messages).toEqual([]);
      expect(botMessages.data.messages).toEqual([]);
      return created.data;
    };
    const first=await make("Computer one"),second=await make("Computer two");
    const botOne=bindings.BOT.idFromName(`owner:${first.bot.id}`),taskOne=bindings.BOT.idFromName(`owner:task:${first.task.id}`);
    const botTwo=bindings.BOT.idFromName(`owner:${second.bot.id}`),taskTwo=bindings.BOT.idFromName(`owner:task:${second.task.id}`);
    expect(taskOne.equals(botOne)).toBe(false);
    expect(taskTwo.equals(botTwo)).toBe(false);
    expect(botOne.equals(botTwo)).toBe(false);
    expect(taskOne.equals(taskTwo)).toBe(false);
  });

  it("returns the fresh post-schedule task state for immediate starts",async()=>{
    const input={operationId:crypto.randomUUID(),title:"Fresh scheduled status",description:"fixture only",newBot:{name:"Auto-start fixture"}};
    const response=await api<{task:Task;bot:Bot}>("/v1/tasks",input);
    expect(response.status).toBe(201);
    const detail=await api<{task:Task}>(`/v1/tasks/${response.data.task.id}`);
    expect(detail.status).toBe(200);
    expect(response.data.task).toEqual(detail.data.task);
    expect(["queued","running","waiting_approval","waiting_connection","failed","completed"]).toContain(response.data.task.status);
  });

  it("deduplicates concurrent owner retries to the same created pair",async()=>{
    const input={operationId:crypto.randomUUID(),title:"Concurrent receipt",description:"",startImmediately:false,newBot:{name:"Concurrent dedicated bot"}};
    const [left,right]=await Promise.all([api<{task:Task;bot:Bot}>("/v1/tasks",input),api<{task:Task;bot:Bot}>("/v1/tasks",input)]);
    expect([left.status,right.status].sort()).toEqual([200,201]);
    expect(left.data).toEqual(right.data);
  });

  it("deduplicates concurrent existing-bot retries without a duplicate task",async()=>{
    const existing=await api<{bot:Bot}>("/v1/bots",{name:"Concurrent legacy owner"});
    const input={operationId:crypto.randomUUID(),title:"Concurrent legacy task",description:"",startImmediately:false,botId:existing.data.bot.id};
    const [left,right]=await Promise.all([api<{task:Task}>("/v1/tasks",input),api<{task:Task}>("/v1/tasks",input)]);
    expect([left.status,right.status].sort()).toEqual([200,201]);
    expect(left.data.task).toEqual(right.data.task);
    const count=await runInDurableObject(registry(),(_instance,state)=>state.storage.sql.exec("SELECT id FROM tasks WHERE json_extract(data,'$.title')=?",input.title).toArray().length);
    expect(count).toBe(1);
  });

  it("keeps the bot on task cancellation and never resurrects it after explicit deletion",async()=>{
    const input={operationId:crypto.randomUUID(),title:"Deletion tombstone",description:"Initial private description",startImmediately:false,newBot:{name:"Persistent dedicated bot",instructions:"private bot instructions"}};
    const created=await api<{task:Task;bot:Bot}>("/v1/tasks",input);
    expect(created.status).toBe(201);
    const cancelled=await api<{taskId:string;cancelRequested:boolean}>(`/v1/tasks/${created.data.task.id}/cancel`,{});
    expect(cancelled.status).toBe(200);
    expect(cancelled.data.cancelRequested).toBe(true);
    expect((await api<{task:Task;bot:Bot}>("/v1/tasks",input)).data.task.status).toBe("cancelled");
    await evictDurableObject(registry());
    expect((await api<{task:Task;bot:Bot}>("/v1/tasks",input)).data.task.status).toBe("cancelled");
    expect((await api<{bot:Bot}>(`/v1/bots/${created.data.bot.id}`)).status).toBe(200);
    const deletion=await exports.default.fetch(`https://timber.test/v1/bots/${created.data.bot.id}`,{method:"DELETE",headers:{authorization:"Bearer test-only-botspace-owner-token-000000"}});
    expect(deletion.status).toBe(200);
    const replay=await api("/v1/tasks",input);
    expect(replay.status).toBe(404);
    const changedReplay=await api("/v1/tasks",{...input,newBot:{...input.newBot,instructions:"different private instruction"}});
    expect(changedReplay.status).toBe(409);
    const bot=await api(`/v1/bots/${created.data.bot.id}`);
    expect(bot.status).toBe(404);
    expect((await api(`/v1/tasks/${created.data.task.id}`)).status).toBe(404);
    const taskList=await api<{tasks:Task[]}>("/v1/tasks");
    expect(taskList.data.tasks.some(task=>task.id===created.data.task.id)).toBe(false);
    const tombstone=await runInDurableObject(registry(),(_instance,state)=>({
      taskRows:state.storage.sql.exec("SELECT 1 FROM tasks WHERE id=?",created.data.task.id).toArray().length,
      botRows:state.storage.sql.exec("SELECT 1 FROM bots WHERE id=?",created.data.bot.id).toArray().length,
      receipt:state.storage.sql.exec<{operation_id:string;task_id:string;fingerprint:string}>("SELECT operation_id,task_id,fingerprint FROM task_operations WHERE operation_id=?",input.operationId).toArray()[0],
      privateTasks:state.storage.sql.exec("SELECT 1 FROM tasks WHERE data LIKE '%Deletion tombstone%' OR data LIKE '%Initial private description%' OR data LIKE '%Persistent dedicated bot%' OR data LIKE '%different private instruction%'").toArray().length,
      privateBots:state.storage.sql.exec("SELECT 1 FROM bots WHERE data LIKE '%Deletion tombstone%' OR data LIKE '%Initial private description%' OR data LIKE '%Persistent dedicated bot%' OR data LIKE '%different private instruction%'").toArray().length,
    }));
    expect(tombstone.taskRows).toBe(0);
    expect(tombstone.botRows).toBe(0);
    expect(tombstone.receipt).toMatchObject({operation_id:input.operationId,task_id:created.data.task.id});
    expect(tombstone.receipt.fingerprint).toMatch(/^dedicated:v1:[0-9a-f]{64}$/);
    expect(tombstone.privateTasks).toBe(0);
    expect(tombstone.privateBots).toBe(0);
    const completed=await api<{task:Task;bot:Bot}>("/v1/tasks",{operationId:crypto.randomUUID(),title:"Completed dedicated task",description:"",startImmediately:false,newBot:{name:"Completed bot survives"}});
    expect(completed.status).toBe(201);
    const finalized=await registry().fetch(`https://workspace/tasks/${completed.data.task.id}`,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({status:"completed"})});
    expect(finalized.status).toBe(200);
    expect((await api<{bot:Bot}>(`/v1/bots/${completed.data.bot.id}`)).status).toBe(200);
  });

  it("keeps legacy existing-bot creation backward compatible and owner auth fail-closed",async()=>{
    const bot=await api<{bot:Bot}>("/v1/bots",{name:"Legacy task owner"});
    const result=await api<{task:Task}>("/v1/tasks",{operationId:crypto.randomUUID(),title:"Legacy task",description:"",botId:bot.data.bot.id,startImmediately:false});
    expect(result.status).toBe(201);
    expect(result.data).toHaveProperty("task");
    expect(result.data).not.toHaveProperty("bot");
    expect(result.data.task).not.toHaveProperty("dedicatedBot");
    const unauthenticated=await exports.default.fetch("https://timber.test/v1/tasks",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({operationId:crypto.randomUUID(),title:"No auth",description:"",newBot:{name:"No auth"}})});
    expect(unauthenticated.status).toBe(401);
  });
});
