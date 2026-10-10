import {env,exports} from "cloudflare:workers";
import {abortAllDurableObjects,runDurableObjectAlarm,runInDurableObject} from "cloudflare:test";
import {expect,it} from "vitest";
import type {Bot,Task,Run,Message} from "@botspace/contracts";
import type {Env} from "../../apps/api/src/env";
const bindings=env as unknown as Env;
async function api<T>(path:string,input?:unknown){const r=await exports.default.fetch(`https://timber.test${path}`,{method:input===undefined?"GET":"POST",headers:{authorization:"Bearer test-only-botspace-owner-token-000000","content-type":"application/json"},...(input===undefined?{}:{body:JSON.stringify(input)})});expect(r.ok).toBe(true);return r.json<T>();}
it("ordinary task-contention receipts wake through real Pi Lifecycle after eviction without a UI read and never steal task ownership",async()=>{
 const {bot}=await api<{bot:Bot}>("/v1/bots",{name:"Task queue real Pi"});
 const {task}=await api<{task:Task}>("/v1/tasks",{operationId:crypto.randomUUID(),title:"Computer owner",description:"request-exec task queue approval",botId:bot.id});
 const registry=bindings.WORKSPACE.get(bindings.WORKSPACE.idFromName("owner"));
 for(let n=0;n<300;n++){const {activeRuns}=await api<{activeRuns:Run[]}>(`/v1/tasks/${task.id}/runs`);if(activeRuns.some(r=>r.status==="waiting_approval"))break;await new Promise(resolve=>setTimeout(resolve,10));}
 const op=crypto.randomUUID(),input={operationId:op,text:"Durably saved while the task holds this computer"};
 const first=await api<{run:Run}>(`/v1/bots/${bot.id}/messages`,input),duplicate=await api<{run:Run}>(`/v1/bots/${bot.id}/messages`,input);expect(first.run.status).toBe("queued");expect(duplicate.run.id).toBe(first.run.id);
 await runInDurableObject(registry,(_,state)=>expect(state.storage.sql.exec<{task_id:string}>("SELECT task_id FROM task_slots WHERE bot_id=?",bot.id).one().task_id).toBe(task.id));
 let stub=bindings.BOT.get(bindings.BOT.idFromName(`owner:${bot.id}`));
 await runInDurableObject(stub,(_,state)=>{expect(state.storage.sql.exec<{admitted:number}>("SELECT admitted FROM submissions WHERE operation_id=?",op).one().admitted).toBe(0);expect(state.storage.sql.exec("SELECT 1 FROM admission_retries WHERE operation_id=?",op).toArray()).toHaveLength(0);expect(state.storage.sql.exec("SELECT 1 FROM execution_claims WHERE operation_id=?",op).toArray()).toHaveLength(0);});
 await api(`/v1/tasks/${task.id}/cancel`,{});await runDurableObjectAlarm(registry);
 await abortAllDurableObjects();stub=bindings.BOT.get(bindings.BOT.idFromName(`owner:${bot.id}`));await new Promise(resolve=>setTimeout(resolve,1100));await runDurableObjectAlarm(stub);
 // SQL-only observers cannot trigger HTTP's opportunistic native recovery.
 const read=()=>runInDurableObject(stub,(_,state)=>JSON.parse(state.storage.sql.exec<{data:string}>("SELECT data FROM runs WHERE id=?",first.run.id).one().data) as Run);
 let saved=await read();for(let n=0;n<300&&saved.status!=="completed";n++){await new Promise(resolve=>setTimeout(resolve,10));saved=await read();}expect(saved.status).toBe("completed");expect(saved.operationId).toBe(op);
 const {messages}=await api<{messages:Message[]}>(`/v1/bots/${bot.id}/messages`);expect(messages.filter(m=>m.role==="user")).toEqual([expect.objectContaining({text:input.text,runId:first.run.id})]);expect(messages.filter(m=>m.role==="assistant")).toHaveLength(1);
});
