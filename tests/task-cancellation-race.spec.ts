import {env,exports} from "cloudflare:workers";
import {runInDurableObject} from "cloudflare:test";
import {describe,expect,it} from "vitest";
import type {Bot,Run,Task} from "@botspace/contracts";
import type {Env} from "../apps/api/src/env";

const bindings=env as unknown as Env;
const registry=()=>bindings.WORKSPACE.get(bindings.WORKSPACE.idFromName("owner"));
const rootDO=(owner:Bot)=>bindings.BOT.get(bindings.BOT.idFromName(`owner:${owner.id}`));
const taskDO=(task:Task)=>bindings.BOT.get(bindings.BOT.idFromName(`owner:task:${task.id}`));
type Snapshot={activeRuns:number;activeProcesses:number;pendingCancellations:number;computerControlled:boolean;latest?:string;activeStatus?:string};
type Scheduler={
  schedulerSnapshot(botId:string,bot:Bot,taskId?:string):Promise<Snapshot>;
  reconcileComputerSlots():Promise<void>;
};
type Slot={task_id:string;token:string;generation:number;updated_at:number};
const api=async<T>(path:string,input?:unknown)=>{
  const response=await exports.default.fetch(`https://timber.test${path}`,{method:input===undefined?"GET":"POST",headers:{authorization:"Bearer test-only-botspace-owner-token-000000","content-type":"application/json"},...(input===undefined?{}:{body:JSON.stringify(input)})});
  // Return only plain data after completing each real DO response stream.
  const data=await response.json<T>();
  return {status:response.status,data};
};
const lease=(owner:Bot)=>runInDurableObject(registry(),(_instance,state)=>state.storage.sql.exec<Slot>("SELECT task_id,token,generation,updated_at FROM task_slots WHERE bot_id=?",owner.id).toArray()[0]);
const savedTask=(task:Task)=>runInDurableObject(registry(),(_instance,state)=>JSON.parse(state.storage.sql.exec<{data:string}>("SELECT data FROM tasks WHERE id=?",task.id).one().data) as Task);
const cancellationCount=(task:Task)=>runInDurableObject(taskDO(task),(_instance,state)=>state.storage.sql.exec<{n:number}>("SELECT COUNT(*) n FROM pending_run_cancellations").one().n);

// Native acknowledgement uses the deterministic tests/fixtures/runtime.ts.
// No real computer process, inference, or provider cancellation is invoked.
describe("first task Stop versus an in-flight terminal scheduler snapshot",()=>{
  it("invalidates the pre-Stop observation and retains the task computer lease until native cancellation acknowledges",async()=>{
    const createdBot=await api<{bot:Bot}>("/v1/bots",{name:"First Stop race fixture"});
    expect(createdBot.status).toBe(201);
    const owner=createdBot.data.bot;
    const createdTask=await api<{task:Task}>("/v1/tasks",{operationId:crypto.randomUUID(),title:"Stop snapshot race",description:"",botId:owner.id,startImmediately:false});
    expect(createdTask.status).toBe(201);
    const task=createdTask.data.task;
    for(const path of [`/v1/tasks/${task.id}/messages`,`/v1/bots/${owner.id}/messages`]){
      const initialized=await api<{messages:unknown[]}>(path);
      expect(initialized.status).toBe(200);
      expect(initialized.data.messages).toEqual([]);
    }
    expect(taskDO(task).id.equals(rootDO(owner).id)).toBe(false);
    const now=new Date().toISOString(),operationId=crypto.randomUUID();
    const completed:Run={id:crypto.randomUUID(),botId:owner.id,operationId,model:owner.model,status:"completed",createdAt:now,updatedAt:now};
    await runInDurableObject(taskDO(task),(_instance,state)=>{
      expect(JSON.parse(state.storage.sql.exec<{data:string}>("SELECT data FROM config WHERE id=1").one().data).id).toBe(owner.id);
      state.storage.sql.exec("INSERT INTO runs(id,operation_id,fingerprint,native_operation_id,data) VALUES(?,?,?,?,?)",completed.id,operationId,"fixture",operationId,JSON.stringify(completed));
      state.storage.sql.exec("INSERT INTO submissions(operation_id,run_id,text,admitted) VALUES(?,?,?,1)",operationId,completed.id,"Previously accepted native task input");
    });
    await runInDurableObject(rootDO(owner),(_instance,state)=>{
      // Both conversations retain the same assigned bot/computer identity, but
      // only the task conversation contains the historical task input.
      expect(JSON.parse(state.storage.sql.exec<{data:string}>("SELECT data FROM config WHERE id=1").one().data).id).toBe(owner.id);
      expect(state.storage.sql.exec("SELECT 1 FROM runs").toArray()).toHaveLength(0);
    });
    await runInDurableObject(registry(),(_instance,state)=>{
      state.storage.sql.exec("UPDATE tasks SET data=? WHERE id=?",JSON.stringify({...task,status:"running"}),task.id);
      state.storage.sql.exec("INSERT INTO task_slots(bot_id,task_id,token,generation,updated_at) VALUES(?,?,?,?,?)",owner.id,task.id,crypto.randomUUID(),1,Date.now());
    });
    const before=await lease(owner);
    expect(before?.task_id).toBe(task.id);
    expect(await cancellationCount(task)).toBe(0);

    let enter!:()=>void,release!:()=>void;
    const entered=new Promise<void>(resolve=>{enter=resolve;});
    const resume=new Promise<void>(resolve=>{release=resolve;});
    let original:Scheduler["schedulerSnapshot"]|undefined,gated=false,oldSnapshot:Snapshot|undefined;
    await runInDurableObject(registry(),instance=>{
      const scheduler=instance as unknown as Scheduler;
      original=scheduler.schedulerSnapshot;
      scheduler.schedulerSnapshot=async(botId,config,taskId)=>{
        // Obtain the genuine completed/idle TaskDO observation first. Hold only
        // its return to reconciliation, not the TaskDO or its response stream.
        const observed=await original!.call(scheduler,botId,config,taskId);
        if(botId===owner.id&&taskId===task.id&&!gated){
          gated=true;oldSnapshot=observed;
          expect(observed).toMatchObject({activeRuns:0,activeProcesses:0,pendingCancellations:0,computerControlled:false,latest:"completed"});
          enter();await resume;
        }
        return observed;
      };
    });
    const reconciliation=runInDurableObject(registry(),async instance=>{
      await (instance as unknown as Scheduler).reconcileComputerSlots();
    });
    try{
      await Promise.race([entered,reconciliation.then(()=>{throw new Error("Reconciliation returned without reaching the gated task snapshot");})]);
      // A first Stop is persisted in Workspace before its separate TaskDO has
      // acknowledged native shutdown. Represent that durable, unacknowledged
      // native intent while the old zero-pending snapshot remains in flight.
      await runInDurableObject(taskDO(task),async(_instance,state)=>{
        await state.storage.put(`fixture-runtime:${operationId}`,{text:"Previously accepted native task input",status:"running"});
        state.storage.sql.exec("INSERT INTO pending_run_cancellations(id,operation_id,next_at) VALUES(?,?,?)",`run:${operationId}`,operationId,Date.now()+60_000);
      });
      const stop=await registry().fetch(`https://workspace/tasks/${task.id}`,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({status:"cancelling",cancelRequested:true})});
      expect(stop.status).toBe(200);
      expect((await stop.json<{task:Task}>()).task).toMatchObject({id:task.id,status:"cancelling",cancelRequested:true});
      const afterStop=await lease(owner);
      expect(afterStop?.task_id).toBe(task.id);
      expect(await cancellationCount(task)).toBe(1);
      expect(oldSnapshot?.pendingCancellations).toBe(0);

      release();await reconciliation;
      // The stale idle observation must not falsely acknowledge this Stop,
      // finalize the task, release its computer, or migrate work to bot chat.
      expect(await lease(owner)).toEqual(afterStop);
      expect(afterStop?.token).not.toBe(before?.token);
      expect(afterStop!.generation).toBeGreaterThan(before!.generation);
      expect(await savedTask(task)).toMatchObject({status:"cancelling",cancelRequested:true});
      expect(await cancellationCount(task)).toBe(1);
    }finally{
      release();await reconciliation.catch(()=>{});
      await runInDurableObject(registry(),instance=>{
        if(original)(instance as unknown as Scheduler).schedulerSnapshot=original;
      });
    }

    // A new, ungated production snapshot sees the real cancellation journal.
    // It too must retain the lease, even though every public input is terminal.
    await runInDurableObject(registry(),async instance=>{
      await (instance as unknown as Scheduler).reconcileComputerSlots();
    });
    expect((await lease(owner))?.task_id).toBe(task.id);
    expect(await savedTask(task)).toMatchObject({status:"cancelling",cancelRequested:true});
    expect(await cancellationCount(task)).toBe(1);
    await runInDurableObject(taskDO(task),async(instance,state)=>{
      state.storage.sql.exec("UPDATE pending_run_cancellations SET next_at=0 WHERE id=?",`run:${operationId}`);
      // Drain through the real host/native cancellation port, rather than
      // deleting a journal row or overriding production release fences.
      await (instance as unknown as {flushRunCancellations():Promise<void>}).flushRunCancellations();
      expect(state.storage.sql.exec("SELECT 1 FROM pending_run_cancellations").toArray()).toHaveLength(0);
      expect(await state.storage.get<{status:string;result:{reason:string}}>(`fixture-runtime:${operationId}`)).toMatchObject({status:"unanswered",result:{reason:"aborted"}});
      expect(JSON.parse(state.storage.sql.exec<{data:string}>("SELECT data FROM runs WHERE id=?",completed.id).one().data)).toEqual(completed);
    });
    await runInDurableObject(registry(),async instance=>{
      await (instance as unknown as Scheduler).reconcileComputerSlots();
    });
    expect(await lease(owner)).toBeUndefined();
    expect(await savedTask(task)).toMatchObject({status:"cancelled",cancelRequested:true});
    const rootRuns=await api<{runs:Run[]}>(`/v1/bots/${owner.id}/runs`);
    expect(rootRuns.status).toBe(200);expect(rootRuns.data.runs).toEqual([]);
    const rootMessages=await api<{messages:unknown[]}>(`/v1/bots/${owner.id}/messages`);
    expect(rootMessages.status).toBe(200);expect(rootMessages.data.messages).toEqual([]);
  });
});
