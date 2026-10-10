import { DurableObject } from "cloudflare:workers";
import type { Bot, ModelSettings } from "@botspace/contracts";
import type { Env } from "./env";
import { ApiError, errorResponse, json } from "./errors";
import { body, parseBotInput, UUID } from "./validation";
import { AgentCoordinator } from "./agent-coordination";

export class WorkspaceDO extends DurableObject<Env> {
  private deleting=new Map<string,Promise<void>>();
  private agents:AgentCoordinator;
  private configuring:Promise<unknown>=Promise.resolve();
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx,env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS bots (id TEXT PRIMARY KEY, data TEXT NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY,data TEXT NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS task_operations (operation_id TEXT PRIMARY KEY,task_id TEXT NOT NULL,fingerprint TEXT NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS task_slots (bot_id TEXT PRIMARY KEY,task_id TEXT NOT NULL,token TEXT,generation INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL DEFAULT 0,payload TEXT,direct_process_id TEXT)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS computer_slot_generations (bot_id TEXT PRIMARY KEY,generation INTEGER NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS computer_admissions (token TEXT PRIMARY KEY,bot_id TEXT NOT NULL,task_id TEXT NOT NULL,operation_id TEXT NOT NULL,slot_token TEXT NOT NULL,created_at INTEGER NOT NULL)");
    ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS computer_admissions_scope ON computer_admissions(bot_id,task_id)");
    const columns=ctx.storage.sql.exec<{name:string}>("PRAGMA table_info(task_slots)").toArray().map(row=>row.name);
    if(!columns.includes("token")) ctx.storage.sql.exec("ALTER TABLE task_slots ADD COLUMN token TEXT");
    if(!columns.includes("generation")) ctx.storage.sql.exec("ALTER TABLE task_slots ADD COLUMN generation INTEGER NOT NULL DEFAULT 0");
    if(!columns.includes("updated_at")) ctx.storage.sql.exec("ALTER TABLE task_slots ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0");
    if(!columns.includes("payload")) ctx.storage.sql.exec("ALTER TABLE task_slots ADD COLUMN payload TEXT");
    if(!columns.includes("direct_process_id")) ctx.storage.sql.exec("ALTER TABLE task_slots ADD COLUMN direct_process_id TEXT");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS bot_task_deletions (task_id TEXT PRIMARY KEY,bot_id TEXT NOT NULL,completed INTEGER NOT NULL DEFAULT 0)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS bot_deletions (id TEXT PRIMARY KEY,completed INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL)");
    this.agents=new AgentCoordinator(ctx,env,()=>this.rearmDeletion(),(botId,operationId)=>this.beginComputerAdmission(botId,null,operationId),token=>this.completeComputerAdmission(token));
    ctx.waitUntil(this.rearmDeletion());
  }
  private serializeConfiguration<T>(change:()=>Promise<T>):Promise<T> {
    const pending=this.configuring.then(change,change);this.configuring=pending.catch(()=>{});return pending;
  }
  private async modelSettings(input:ModelSettings):Promise<ModelSettings> {
    if(input.model.startsWith("@cf/")) {
      if(input.reasoningEffort!==undefined || input.fast) throw new ApiError(400,"invalid_model_settings","ChatGPT reasoning and Fast mode options require a model from the connected ChatGPT account.");
      return {model:input.model,fast:false};
    }
    if(!this.env.CHATGPT) throw new ApiError(503,"chatgpt_not_configured","Connect ChatGPT before selecting model settings.");
    const response=await this.env.CHATGPT.get(this.env.CHATGPT.idFromName("owner")).fetch("https://chatgpt/validate-model",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(input)});
    const result=await response.json<{settings?:ModelSettings;error?:{code:string;message:string}}>();
    if(!response.ok) throw new ApiError(response.status,result.error?.code??"invalid_model_settings",result.error?.message??"The model settings could not be validated.");
    if(!result.settings || result.settings.model!==input.model) throw new ApiError(502,"invalid_model_settings","The model settings could not be validated.");
    return result.settings;
  }
  private async rearmDeletion():Promise<void> {
    const next=this.ctx.storage.sql.exec<{next_at:number}>("SELECT next_at FROM bot_deletions WHERE completed=0 ORDER BY next_at LIMIT 1").toArray()[0];
    const agentTime=this.agents.nextAlarm();
    const schedulerActive=this.ctx.storage.sql.exec("SELECT 1 FROM task_slots LIMIT 1").toArray().length>0 || this.ctx.storage.sql.exec("SELECT 1 FROM computer_admissions LIMIT 1").toArray().length>0 || this.ctx.storage.sql.exec("SELECT 1 FROM tasks WHERE json_extract(data,'$.status')='queued' AND json_extract(data,'$.startImmediately')=1 LIMIT 1").toArray().length>0;
    const now=Date.now(),existingAlarm=await this.ctx.storage.getAlarm();
    const schedulerTime=schedulerActive?Math.min(existingAlarm&&existingAlarm>now?existingAlarm:Infinity,now+5000):Infinity;
    const nextAt=Math.min(next?.next_at??Infinity,agentTime??Infinity,schedulerTime);
    if(Number.isFinite(nextAt)) await this.ctx.storage.setAlarm(Math.max(Date.now(),nextAt));
    else await this.ctx.storage.deleteAlarm();
  }
  private cleanup(id:string):Promise<void> {
    const pending=this.deleting.get(id);
    if(pending) return pending;
    const work=this.cleanupOnce(id).finally(()=>this.deleting.delete(id));
    this.deleting.set(id,work);
    return work;
  }
  private async cleanupOnce(id:string):Promise<void> {
    try {
      const pendingTasks=this.ctx.storage.sql.exec<{task_id:string}>("SELECT task_id FROM bot_task_deletions WHERE bot_id=? AND completed=0 ORDER BY task_id",id).toArray();
      for(const item of pendingTasks) {
        const taskRow=this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM tasks WHERE id=?",item.task_id).toArray()[0];
        if(taskRow) {
          const task=JSON.parse(taskRow.data) as {id:string;botId:string};
          const taskDO=this.env.BOT.get(this.env.BOT.idFromName(`owner:task:${task.id}`));
          const stopped=await taskDO.fetch("https://task/task-delete",{method:"POST",headers:{"x-timber-internal":"task-cleanup","x-timber-task-id":task.id,"x-timber-bot-id":task.botId}});
          if(!stopped.ok) throw new Error("Task shutdown pending");
        }
        this.ctx.storage.sql.exec("DELETE FROM task_slots WHERE bot_id=? AND task_id=?",id,item.task_id);
        this.ctx.storage.sql.exec("DELETE FROM task_operations WHERE task_id=?",item.task_id);
        this.ctx.storage.sql.exec("DELETE FROM tasks WHERE id=?",item.task_id);
        this.ctx.storage.sql.exec("UPDATE bot_task_deletions SET completed=1 WHERE task_id=?",item.task_id);
      }
      this.ctx.storage.sql.exec("DELETE FROM task_slots WHERE bot_id=?",id);
      const bot=this.env.BOT.get(this.env.BOT.idFromName(`owner:${id}`));
      const response=await bot.fetch("https://bot/delete",{method:"POST",headers:{"x-botspace-bot-id":id}});
      if(!response.ok) throw new Error("Bot shutdown pending");
      // Computer shutdown has fenced and drained every possible uploader. Delete
      // pages from the beginning so partial failures can resume idempotently.
      while(true) {
        const objects=await this.env.FILES.list({prefix:`bots/${id}/`,limit:1000});
        if(!objects.objects.length) break;
        await this.env.FILES.delete(objects.objects.map(object=>object.key));
      }
      this.ctx.storage.sql.exec("UPDATE bot_deletions SET completed=1,next_at=0 WHERE id=?",id);
    } catch {
      const previous=this.ctx.storage.sql.exec<{attempts:number}>("SELECT attempts FROM bot_deletions WHERE id=?",id).one();
      const attempts=previous.attempts+1;
      this.ctx.storage.sql.exec("UPDATE bot_deletions SET attempts=?,next_at=? WHERE id=?",attempts,Date.now()+Math.min(60_000,1000*2**Math.min(attempts-1,6)),id);
      throw new ApiError(503,"bot_deletion_pending","Bot access is disabled. Data cleanup is still pending; retry deletion.");
    } finally {await this.rearmDeletion();}
  }
  private reserveBotSlot(botId:string):{token:string;generation:number} {
    const current=this.ctx.storage.sql.exec<{task_id:string}>("SELECT task_id FROM task_slots WHERE bot_id=?",botId).toArray()[0];
    if(current&&current.task_id!=="@bot") throw new ApiError(409,"computer_busy","A task or direct action is using this bot's computer.");
    const token=crypto.randomUUID(),generation=this.nextSlotGeneration(botId);
    this.ctx.storage.sql.exec("INSERT INTO task_slots(bot_id,task_id,token,generation,updated_at) VALUES(?,'@bot',?,?,?) ON CONFLICT(bot_id) DO UPDATE SET token=excluded.token,generation=excluded.generation,updated_at=excluded.updated_at",botId,token,generation,Date.now());
    return {token,generation};
  }
  private beginComputerAdmission(botId:string,taskId:string|null,operationId:string,allowQueued=false):string {
    let slotToken:string;
    if(taskId===null) slotToken=this.reserveBotSlot(botId).token;
    else {
      const taskRow=this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM tasks WHERE id=?",taskId).toArray()[0];
      if(!taskRow)throw new ApiError(404,"not_found","Task not found.");
      const task=JSON.parse(taskRow.data) as {status:string;cancelRequested?:boolean};
      if(task.cancelRequested||!(allowQueued?task.status==="queued":["running","waiting_approval","waiting_connection"].includes(task.status)))throw new ApiError(409,"task_not_running","The task is not accepting input.");
      const current=this.slotFor(botId);
      if(!current||current.task_id!==taskId) throw new ApiError(409,"computer_busy","The task no longer holds this bot's computer.");
      const token=crypto.randomUUID(),generation=this.nextSlotGeneration(botId);slotToken=token;
      this.ctx.storage.sql.exec("UPDATE task_slots SET token=?,generation=?,updated_at=? WHERE bot_id=? AND task_id=? AND token IS ?",token,generation,Date.now(),botId,taskId,current.token);
    }
    const admissionToken=crypto.randomUUID();
    this.ctx.storage.sql.exec("INSERT INTO computer_admissions(token,bot_id,task_id,operation_id,slot_token,created_at) VALUES(?,?,?,?,?,?)",admissionToken,botId,taskId??"@bot",operationId,slotToken,Date.now());
    this.ctx.waitUntil(this.rearmDeletion());
    return admissionToken;
  }
  private completeComputerAdmission(token:string):void {
    const row=this.ctx.storage.sql.exec<{bot_id:string;task_id:string;slot_token:string}>("SELECT bot_id,task_id,slot_token FROM computer_admissions WHERE token=?",token).toArray()[0];
    if(!row)return;
    this.ctx.storage.sql.exec("DELETE FROM computer_admissions WHERE token=?",token);
    this.ctx.storage.sql.exec("UPDATE task_slots SET updated_at=? WHERE bot_id=? AND task_id=? AND token=?",Date.now(),row.bot_id,row.task_id,row.slot_token);
  }
  private hasPendingAdmission(botId:string,taskId:string):boolean {
    return this.ctx.storage.sql.exec("SELECT 1 FROM computer_admissions WHERE bot_id=? AND task_id=? LIMIT 1",botId,taskId).toArray().length>0;
  }
  private nextSlotGeneration(botId:string):number {
    const previous=this.ctx.storage.sql.exec<{generation:number}>("SELECT generation FROM computer_slot_generations WHERE bot_id=?",botId).toArray()[0]?.generation??0;
    const fallback=this.ctx.storage.sql.exec<{generation:number}>("SELECT COALESCE(MAX(generation),0) AS generation FROM task_slots WHERE bot_id=?",botId).toArray()[0]?.generation??0;
    const generation=Math.max(previous,fallback)+1;
    this.ctx.storage.sql.exec("INSERT INTO computer_slot_generations(bot_id,generation) VALUES(?,?) ON CONFLICT(bot_id) DO UPDATE SET generation=excluded.generation",botId,generation);
    return generation;
  }
  private slotFor(botId:string):{task_id:string;token:string|null;generation:number;updated_at:number}|undefined {return this.ctx.storage.sql.exec<{task_id:string;token:string|null;generation:number;updated_at:number}>("SELECT task_id,token,generation,updated_at FROM task_slots WHERE bot_id=?",botId).toArray()[0];}
  private releaseSlot(botId:string,taskId:string,token:string|null,updatedAt?:number):void {
    if(updatedAt===undefined)this.ctx.storage.sql.exec("DELETE FROM task_slots WHERE bot_id=? AND task_id=? AND token IS ?",botId,taskId,token);
    else this.ctx.storage.sql.exec("DELETE FROM task_slots WHERE bot_id=? AND task_id=? AND token IS ? AND updated_at=?",botId,taskId,token,updatedAt);
  }
  private async computerControlled(botId:string,bot:Bot):Promise<boolean> {
    const root=this.env.BOT.get(this.env.BOT.idFromName(`owner:${botId}`)),headers={"x-botspace-config":encodeURIComponent(JSON.stringify(bot)),"x-timber-internal":"scheduler"};
    const response=await root.fetch(new Request("https://bot/computer/lease-state",{headers}));
    if(!response.ok)throw new ApiError(503,"computer_state_unavailable","Could not verify interactive desktop control; mutation is blocked safely.");
    return (await response.json<{computerControlled:boolean}>()).computerControlled;
  }
  private async schedulerSnapshot(botId:string,bot:Bot,taskId?:string):Promise<{activeRuns:number;activeProcesses:number;computerControlled:boolean;latest?:string}> {
    const identity=taskId?`owner:task:${taskId}`:`owner:${botId}`;
    const stub=this.env.BOT.get(this.env.BOT.idFromName(identity)),root=this.env.BOT.get(this.env.BOT.idFromName(`owner:${botId}`));
    const prefix=taskId?"task":"bot";
    const headers={"x-botspace-config":encodeURIComponent(JSON.stringify(bot))};
    const [r,s,c]=await Promise.all([stub.fetch(new Request(`https://${prefix}/runs`,{headers})),stub.fetch(new Request(`https://${prefix}/summary`,{headers})),root.fetch(new Request("https://bot/computer/lease-state",{headers:{...headers,"x-timber-internal":"scheduler"}}))]);
    if(!r.ok||!s.ok||!c.ok) throw new Error("Run reconciliation unavailable");
    const page=await r.json<{activeRuns:unknown[];runs:Array<{status:string}>}>(),summary=await s.json<{summary:{activeRuns:number;activeProcesses:number}}>(),lease=await c.json<{computerControlled:boolean}>();
    return {activeRuns:page.activeRuns.length,activeProcesses:summary.summary.activeProcesses,computerControlled:lease.computerControlled,latest:page.runs[0]?.status};
  }
  private finalizeTask(slot:{bot_id:string;task_id:string;token:string|null;generation:number;updated_at:number},status:string):void {
    this.ctx.storage.transactionSync(()=>{
      const currentSlot=this.slotFor(slot.bot_id);
      if(!currentSlot||currentSlot.task_id!==slot.task_id||currentSlot.token!==slot.token||currentSlot.generation!==slot.generation||currentSlot.updated_at!==slot.updated_at||this.hasPendingAdmission(slot.bot_id,slot.task_id))return;
      const row=this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM tasks WHERE id=?",slot.task_id).toArray()[0];
      if(!row)return;
      const task=JSON.parse(row.data) as {status:string;cancelRequested?:boolean;updatedAt:string};
      if(status==="cancelled"&&!(task.cancelRequested||task.status==="cancelling"))return;
      if(["completed","failed","cancelled"].includes(task.status)&&task.status!==status)return;
      task.status=status;task.updatedAt=new Date().toISOString();
      this.ctx.storage.sql.exec("UPDATE tasks SET data=? WHERE id=?",JSON.stringify(task),slot.task_id);
      this.ctx.storage.sql.exec("DELETE FROM task_slots WHERE bot_id=? AND task_id=? AND token IS ? AND generation=? AND updated_at=?",slot.bot_id,slot.task_id,slot.token,slot.generation,slot.updated_at);
    });
  }
  private updateTaskStatus(taskId:string,status:string):void {
    const row=this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM tasks WHERE id=?",taskId).toArray()[0];if(!row)return;
    const task=JSON.parse(row.data) as {status:string;cancelRequested?:boolean;updatedAt:string};
    if(task.cancelRequested||task.status==="cancelling")return;
    if(["completed","failed","cancelled"].includes(task.status)&&status!==task.status)return;
    task.status=status;task.updatedAt=new Date().toISOString();this.ctx.storage.sql.exec("UPDATE tasks SET data=? WHERE id=?",JSON.stringify(task),taskId);
  }
  private markTaskRunning(taskId:string):void {this.updateTaskStatus(taskId,"running");}
  private releaseFailedTaskSlot(taskId:string):void {
    const row=this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM tasks WHERE id=?",taskId).toArray()[0];if(!row)return;
    if((JSON.parse(row.data) as {status:string}).status!=="failed")return;
    const task=JSON.parse(row.data) as {botId:string},slot=this.slotFor(task.botId);
    if(slot?.task_id===taskId)this.releaseSlot(task.botId,taskId,slot.token,slot.updated_at);
  }
  private async reconcileAdmissions():Promise<void> {
    const rows=this.ctx.storage.sql.exec<{token:string;bot_id:string;task_id:string;operation_id:string;created_at:number}>("SELECT token,bot_id,task_id,operation_id,created_at FROM computer_admissions WHERE created_at<=? ORDER BY created_at LIMIT 32",Date.now()-60_000).toArray();
    for(const row of rows) {
      try {
        const botRow=this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM bots WHERE id=?",row.bot_id).toArray()[0];
        if(!botRow) {this.ctx.storage.sql.exec("DELETE FROM computer_admissions WHERE bot_id=?",row.bot_id);continue;}
        const bot=JSON.parse(botRow.data) as Bot,task=row.task_id!=="@bot",identity=task?`owner:task:${row.task_id}`:`owner:${row.bot_id}`;
        const stub=this.env.BOT.get(this.env.BOT.idFromName(identity)),headers={"x-botspace-config":encodeURIComponent(JSON.stringify(bot)),"x-timber-internal":"scheduler"};
        const status=await stub.fetch(new Request(`https://bot/admission/${encodeURIComponent(row.operation_id)}`,{headers}));
        if(!status.ok)continue;
        const {accepted}=await status.json<{accepted:boolean}>();
        if(!accepted) {
          const fence=await stub.fetch(new Request(`https://bot/admission-fence/${encodeURIComponent(row.operation_id)}`,{method:"POST",headers}));
          if(!fence.ok)continue;
        }
        this.ctx.storage.sql.exec("DELETE FROM computer_admissions WHERE bot_id=? AND task_id=? AND operation_id=?",row.bot_id,row.task_id,row.operation_id);
      } catch { /* Unknown request outcomes retain a durable admission fence. */ }
    }
  }
  private async reconcileComputerSlots():Promise<void> {
    await this.reconcileAdmissions();
    const slots=this.ctx.storage.sql.exec<{bot_id:string;task_id:string;token:string|null;generation:number;updated_at:number;payload:string|null;direct_process_id:string|null}>("SELECT bot_id,task_id,token,generation,updated_at,payload,direct_process_id FROM task_slots").toArray();
    for(const slot of slots) {
      try {
        const botRow=this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM bots WHERE id=?",slot.bot_id).toArray()[0];
        if(!botRow){this.releaseSlot(slot.bot_id,slot.task_id,slot.token);continue;}
        const bot=JSON.parse(botRow.data) as Bot;
        if(slot.task_id.startsWith("@direct:")) {
          if(!slot.payload||!slot.token)continue;
          const direct=JSON.parse(slot.payload) as {operationId:string;action:{type:string;processId?:string}};
          const stub=this.env.BOT.get(this.env.BOT.idFromName(`owner:${slot.bot_id}`));
          const operation=slot.direct_process_id&&direct.action.type!=="execCancel"
            ? {operationId:`scheduler-poll:${slot.token}:${Math.floor(Date.now()/5000)}`,action:{type:"execPoll",processId:slot.direct_process_id}}
            : direct;
          const receipt=await stub.fetch(new Request("https://bot/computer/actions",{method:"POST",headers:{"content-type":"application/json","x-botspace-config":encodeURIComponent(JSON.stringify(bot))},body:JSON.stringify(operation)}));
          if(!receipt.ok) {
            const failure:{error?:{code?:string}}=await receipt.json<{error?:{code?:string}}>().catch(()=>({error:undefined}));
            if(["execPoll","execCancel"].includes(direct.action.type)&&failure.error?.code==="process_not_found")this.releaseSlot(slot.bot_id,slot.task_id,slot.token,slot.updated_at);
            continue;
          }
          const result=(await receipt.json<{result:{status:string;processId?:string;checkpointStatus?:string}}>()).result;
          if(result.status==="running"&&result.processId&&!slot.direct_process_id)this.ctx.storage.sql.exec("UPDATE task_slots SET direct_process_id=? WHERE bot_id=? AND token=?",result.processId,slot.bot_id,slot.token);
          else if(["completed","failed","cancelled"].includes(result.status)&&result.checkpointStatus!=="pending")this.releaseSlot(slot.bot_id,slot.task_id,slot.token,slot.updated_at);
          else if(result.status==="interrupted"&&result.checkpointStatus!=="pending") {const state=await this.schedulerSnapshot(slot.bot_id,bot);if(state.activeProcesses===0&&!state.computerControlled)this.releaseSlot(slot.bot_id,slot.task_id,slot.token,slot.updated_at);}
          continue;
        }
        if(slot.task_id==="@bot") {
          const state=await this.schedulerSnapshot(slot.bot_id,bot);
          if(state.activeRuns===0&&state.activeProcesses===0&&!state.computerControlled&&!this.hasPendingAdmission(slot.bot_id,"@bot")&&Date.now()-slot.updated_at>5000)this.releaseSlot(slot.bot_id,slot.task_id,slot.token,slot.updated_at);
          continue;
        }
        const row=this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM tasks WHERE id=?",slot.task_id).toArray()[0];
        if(!row){this.releaseSlot(slot.bot_id,slot.task_id,slot.token);continue;}
        const task=JSON.parse(row.data) as {id:string;botId:string;status:string;title:string;description:string;cancelRequested?:boolean;updatedAt:string};
        const state=await this.schedulerSnapshot(slot.bot_id,bot,task.id);
        if(task.status==="queued" && state.activeRuns===0 && state.activeProcesses===0 && !this.hasPendingAdmission(slot.bot_id,task.id)) {
          const fresh=this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM tasks WHERE id=?",task.id).toArray()[0];
          const currentTask=fresh?JSON.parse(fresh.data) as typeof task:undefined;
          if(!currentTask||currentTask.status!=="queued"||currentTask.cancelRequested)continue;
          const mainState=await this.schedulerSnapshot(slot.bot_id,bot);
          if(mainState.activeRuns||mainState.activeProcesses||mainState.computerControlled)continue;
          const startStub=this.env.BOT.get(this.env.BOT.idFromName(`owner:task:${task.id}`));
          const admission=this.beginComputerAdmission(slot.bot_id,task.id,`task-start:${task.id}`,true);
          const startResponse=await startStub.fetch(new Request("https://task/messages",{method:"POST",headers:{"content-type":"application/json","x-botspace-config":encodeURIComponent(JSON.stringify(bot)),"x-timber-task-id":task.id},body:JSON.stringify({operationId:`task-start:${task.id}`,text:task.description||task.title})}));
          this.completeComputerAdmission(admission);
          if(startResponse.ok)this.markTaskRunning(task.id);
          else if(startResponse.status>=400&&startResponse.status<500&&startResponse.status!==409&&startResponse.status!==429){this.updateTaskStatus(task.id,"failed");this.releaseFailedTaskSlot(task.id);}
          continue;
        }
        const stub=this.env.BOT.get(this.env.BOT.idFromName(`owner:task:${task.id}`)),headers={"x-botspace-config":encodeURIComponent(JSON.stringify(bot))};
        if(task.cancelRequested) {
          const [runs,processes]=await Promise.all([
            stub.fetch(new Request("https://task/runs",{headers})),
            stub.fetch(new Request("https://task/cancel-processes",{method:"POST",headers:{...headers,"x-timber-internal":"task","x-timber-task-id":task.id}})),
          ]);
          if(!runs.ok||!processes.ok)continue;
          const page=await runs.json<{activeRuns:Array<{id:string}>}>();
          const outcomes=await Promise.all(page.activeRuns.map(run=>stub.fetch(new Request(`https://task/runs/${run.id}/cancel`,{method:"POST",headers}))));
          if(outcomes.some(outcome=>!outcome.ok))continue;
          const after=await this.schedulerSnapshot(slot.bot_id,bot,task.id);
          if(after.activeRuns===0&&after.activeProcesses===0&&!after.computerControlled&&!this.hasPendingAdmission(slot.bot_id,task.id))this.finalizeTask(slot,"cancelled");
          continue;
        }
        if(state.activeRuns===0&&state.activeProcesses===0&&!state.computerControlled&&!this.hasPendingAdmission(slot.bot_id,task.id)&&["running","waiting_approval","waiting_connection","cancelling"].includes(task.status)) {
          const fresh=this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM tasks WHERE id=?",task.id).toArray()[0];
          if(!fresh)continue;const current=JSON.parse(fresh.data) as typeof task;
          const terminal=current.cancelRequested||current.status==="cancelling"?"cancelled":(["completed","failed","cancelled"].includes(state.latest??"")?state.latest!:"failed");
          this.finalizeTask(slot,terminal);
        } else if(state.activeRuns===0&&state.activeProcesses===0&&!state.computerControlled&&!this.hasPendingAdmission(slot.bot_id,task.id)&&["completed","failed","cancelled"].includes(task.status)) this.releaseSlot(slot.bot_id,slot.task_id,slot.token,slot.updated_at);
      } catch { /* An uncertain holder stays fenced until a later reconciliation. */ }
    }
    const queued=this.ctx.storage.sql.exec<{id:string;data:string}>("SELECT id,data FROM tasks WHERE json_extract(data,'$.status')='queued' AND json_extract(data,'$.startImmediately')=1 ORDER BY rowid").toArray();
    const bots=new Set<string>();
    for(const row of queued) {
      const task=JSON.parse(row.data) as {id:string;botId:string;title:string;description:string;status:string};
      if(bots.has(task.botId)||this.ctx.storage.sql.exec("SELECT 1 FROM task_slots WHERE bot_id=?",task.botId).toArray().length)continue;
      const token=crypto.randomUUID();let reserved=false;
      this.ctx.storage.transactionSync(()=>{if(!this.ctx.storage.sql.exec("SELECT 1 FROM task_slots WHERE bot_id=?",task.botId).toArray().length){const generation=this.nextSlotGeneration(task.botId);this.ctx.storage.sql.exec("INSERT INTO task_slots(bot_id,task_id,token,generation,updated_at) VALUES(?,?,?,?,?)",task.botId,task.id,token,generation,Date.now());reserved=true;}});
      if(!reserved)continue;bots.add(task.botId);
      try {
        const botRow=this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM bots WHERE id=?",task.botId).toArray()[0];if(!botRow)continue;
        const bot=JSON.parse(botRow.data) as Bot,state=await this.schedulerSnapshot(task.botId,bot);
        if(state.activeRuns||state.activeProcesses||state.computerControlled){this.ctx.storage.sql.exec("UPDATE task_slots SET task_id='@bot',updated_at=? WHERE bot_id=? AND token=?",Date.now(),task.botId,token);continue;}
        const fresh=this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM tasks WHERE id=?",task.id).toArray()[0];
        const current=fresh?JSON.parse(fresh.data) as typeof task:undefined;if(!current||current.status!=="queued")continue;
        const stub=this.env.BOT.get(this.env.BOT.idFromName(`owner:task:${task.id}`)),admission=this.beginComputerAdmission(task.botId,task.id,`task-start:${task.id}`,true);
        const response=await stub.fetch(new Request("https://task/messages",{method:"POST",headers:{"content-type":"application/json","x-botspace-config":encodeURIComponent(JSON.stringify(bot)),"x-timber-task-id":task.id},body:JSON.stringify({operationId:`task-start:${task.id}`,text:task.description||task.title})}));
        this.completeComputerAdmission(admission);
        if(response.ok)this.markTaskRunning(task.id);
        else if(response.status>=400&&response.status<500&&response.status!==409&&response.status!==429){this.updateTaskStatus(task.id,"failed");this.releaseFailedTaskSlot(task.id);}
      } catch { /* Keep both intent and token; stable operation ID makes retry safe. */ }
    }
  }
  async alarm():Promise<void> {
    const due=this.ctx.storage.sql.exec<{id:string}>("SELECT id FROM bot_deletions WHERE completed=0 AND next_at<=? ORDER BY next_at LIMIT 8",Date.now()).toArray();
    await Promise.allSettled([...due.map(row=>this.cleanup(row.id)),this.agents.alarm()]);
    await this.reconcileComputerSlots();
    await this.rearmDeletion();
  }
  private async deleteBot(id:string):Promise<Response> {
    const previous=this.ctx.storage.sql.exec<{completed:number}>("SELECT completed FROM bot_deletions WHERE id=?",id).toArray()[0];
    if(previous?.completed) return json({botId:id,deleted:true});
    if(!previous) {
      if(!this.ctx.storage.sql.exec<{id:string}>("SELECT id FROM bots WHERE id=?",id).toArray()[0]) throw new ApiError(404,"not_found","Bot not found.");
      this.ctx.storage.transactionSync(()=>{
        this.ctx.storage.sql.exec("INSERT INTO bot_deletions(id,next_at) VALUES(?,?)",id,Date.now());
        const tasks=this.ctx.storage.sql.exec<{id:string;data:string}>("SELECT id,data FROM tasks WHERE json_extract(data,'$.botId')=?",id).toArray();
        for(const entry of tasks) {this.ctx.storage.sql.exec("INSERT OR IGNORE INTO bot_task_deletions(task_id,bot_id) VALUES(?,?)",entry.id,id);const task=JSON.parse(entry.data);task.status="cancelled";task.deleting=true;task.updatedAt=new Date().toISOString();this.ctx.storage.sql.exec("UPDATE tasks SET data=? WHERE id=?",JSON.stringify(task),entry.id);}
        this.ctx.storage.sql.exec("DELETE FROM bots WHERE id=?",id);
        this.agents.forgetBot(id);
      });
    }
    // Fence is durable before cleanup and is also the authorization record for
    // retries. Keep only this minimal tombstone after all user data is erased.
    await this.rearmDeletion();
    const work=this.cleanup(id);
    this.ctx.waitUntil(work.catch(()=>{}));
    await work;
    return json({botId:id,deleted:true});
  }
  async fetch(request:Request):Promise<Response> {
    try {
      const path=new URL(request.url).pathname;
      if(path.startsWith("/agents/")) return await this.agents.fetch(request);
      if(path==="/tasks" && request.method==="GET") {
        const tasks=this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM tasks ORDER BY rowid DESC").toArray().map(row=>JSON.parse(row.data));
        return json({tasks});
      }
      if(path==="/tasks/bot" && request.method==="POST") {
        if(request.headers.get("x-timber-internal")!=="task") throw new ApiError(403,"internal_only","Task creation is internal.");
        const input=await body(request),sourceId=input.sourceBotId;
        if(typeof sourceId!=="string" || !UUID.test(sourceId) || typeof input.sourceRunId!=="string" || !UUID.test(input.sourceRunId)) throw new ApiError(400,"invalid_request","Invalid task creator identity.");
        const sourceRow=this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM bots WHERE id=?",sourceId).toArray()[0];if(!sourceRow)throw new ApiError(404,"not_found","Task creator bot not found.");
        const source=JSON.parse(sourceRow.data) as Bot;if(source.allowTaskCreation!==true)throw new ApiError(403,"task_creation_not_allowed","The owner has not allowed this bot to create tasks.");
        if(typeof input.operationId!=="string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.operationId) || typeof input.title!=="string" || !input.title.trim() || input.title.length>160 || typeof input.description!=="string" || input.description.length>32000 || input.startImmediately!==undefined && typeof input.startImmediately!=="boolean") throw new ApiError(400,"invalid_request","Invalid task details.");
        const fingerprint=JSON.stringify({sourceId,sourceRunId:input.sourceRunId,title:input.title.trim(),description:input.description,startImmediately:input.startImmediately!==false});
        const existing=this.ctx.storage.sql.exec<{task_id:string;fingerprint:string}>("SELECT task_id,fingerprint FROM task_operations WHERE operation_id=?",`bot-task:${sourceId}:${input.operationId}`).toArray()[0];
        if(existing){if(existing.fingerprint!==fingerprint)throw new ApiError(409,"operation_id_conflict","operationId was already used for another task.");const row=this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM tasks WHERE id=?",existing.task_id).toArray()[0];return json({task:JSON.parse(row.data)});}
        const now=new Date().toISOString(),task={id:crypto.randomUUID(),title:input.title.trim(),description:input.description,botId:source.id,botName:source.name,creator:"bot",createdByBotId:source.id,sourceRunId:input.sourceRunId,status:"pending",startImmediately:false,createdAt:now,updatedAt:now};
        this.ctx.storage.transactionSync(()=>{this.ctx.storage.sql.exec("INSERT INTO tasks(id,data) VALUES(?,?)",task.id,JSON.stringify(task));this.ctx.storage.sql.exec("INSERT INTO task_operations(operation_id,task_id,fingerprint) VALUES(?,?,?)",`bot-task:${sourceId}:${input.operationId}`,task.id,fingerprint);});
        return json({task},201);
      }
      if(path==="/tasks" && request.method==="POST") {
        const input=await body(request);
        if(typeof input.operationId!=="string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.operationId)) throw new ApiError(400,"invalid_request","operationId is invalid.");
        if(typeof input.title!=="string" || !input.title.trim() || input.title.length>160) throw new ApiError(400,"invalid_request","title must contain 1 to 160 characters.");
        if(typeof input.description!=="string" || input.description.length>32000) throw new ApiError(400,"invalid_request","description must contain at most 32000 characters.");
        if(typeof input.botId!=="string" || !UUID.test(input.botId)) throw new ApiError(400,"invalid_request","botId must be a UUID.");
        if(input.startImmediately!==undefined && typeof input.startImmediately!=="boolean") throw new ApiError(400,"invalid_request","startImmediately must be a boolean.");
        const existing=this.ctx.storage.sql.exec<{task_id:string;fingerprint:string}>("SELECT task_id,fingerprint FROM task_operations WHERE operation_id=?",input.operationId).toArray()[0];
        const fingerprint=JSON.stringify({title:input.title.trim(),description:input.description,botId:input.botId,startImmediately:input.startImmediately!==false});
        if(existing) {if(existing.fingerprint!==fingerprint) throw new ApiError(409,"operation_id_conflict","operationId was already used for another task."); const row=this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM tasks WHERE id=?",existing.task_id).toArray()[0]; if(!row) throw new ApiError(404,"not_found","Task not found.");const saved=JSON.parse(row.data) as {status:string;startImmediately?:boolean};if(saved.status==="queued"&&saved.startImmediately){await this.rearmDeletion();await this.reconcileComputerSlots();const fresh=this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM tasks WHERE id=?",existing.task_id).toArray()[0];return json({task:JSON.parse(fresh.data)});}return json({task:saved});}
        const botRow=this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM bots WHERE id=?",input.botId).toArray()[0];
        if(!botRow) throw new ApiError(404,"not_found","Assigned bot not found.");
        const bot=JSON.parse(botRow.data) as Bot, now=new Date().toISOString();
        const task={id:crypto.randomUUID(),title:input.title.trim(),description:input.description,botId:bot.id,botName:bot.name,creator:"owner",status:input.startImmediately===false?"pending":"queued",startImmediately:input.startImmediately!==false,createdAt:now,updatedAt:now};
        this.ctx.storage.transactionSync(()=>{this.ctx.storage.sql.exec("INSERT INTO tasks(id,data) VALUES(?,?)",task.id,JSON.stringify(task));this.ctx.storage.sql.exec("INSERT INTO task_operations(operation_id,task_id,fingerprint) VALUES(?,?,?)",input.operationId,task.id,fingerprint);});
        if(task.status==="queued"){await this.rearmDeletion();await this.reconcileComputerSlots();}
        const saved=this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM tasks WHERE id=?",task.id).toArray()[0];
        return json({task:JSON.parse(saved.data)},201);
      }
      const admissionRoute=/^\/tasks\/bot-slot\/([0-9a-f-]{36})\/admissions(?:\/([0-9a-f-]{36}))?$/.exec(path);
      if(admissionRoute && request.method==="POST" && !admissionRoute[2]) {
        const input=await body(request),operationId=input.operationId;
        if(typeof operationId!=="string"||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(operationId))throw new ApiError(400,"invalid_request","A valid admission operationId is required.");
        const taskId=input.taskId===undefined?null:input.taskId;
        if(taskId!==null&&(typeof taskId!=="string"||!UUID.test(taskId)))throw new ApiError(400,"invalid_request","Invalid task admission identity.");
        return json({token:this.beginComputerAdmission(admissionRoute[1],taskId as string|null,operationId)});
      }
      if(admissionRoute && request.method==="DELETE" && admissionRoute[2]) {this.completeComputerAdmission(admissionRoute[2]);await this.rearmDeletion();return json({released:true});}
      const directProcess=/^\/tasks\/bot-slot\/([0-9a-f-]{36})\/direct-process$/.exec(path);
      if(directProcess && request.method==="POST") {
        const key=new URL(request.url).searchParams.get("key"),token=new URL(request.url).searchParams.get("token"),input=await body(request);
        if(!key||!token||typeof input.processId!=="string"||!UUID.test(input.processId))throw new ApiError(400,"invalid_request","A direct process receipt is required.");
        this.ctx.storage.sql.exec("UPDATE task_slots SET direct_process_id=?,updated_at=? WHERE bot_id=? AND task_id=? AND token=?",input.processId,Date.now(),directProcess[1],`@direct:${key}`,token);
        return json({saved:true});
      }
      const botSlot=/^\/tasks\/bot-slot\/([0-9a-f-]{36})$/.exec(path);
      if(botSlot) {
        const botId=botSlot[1];
        if(request.method==="POST") {
          const direct=new URL(request.url).searchParams.get("kind")==="direct";
          const key=new URL(request.url).searchParams.get("key");
          const current=this.ctx.storage.sql.exec<{task_id:string;token:string|null;generation:number;direct_process_id:string|null}>("SELECT task_id,token,generation,direct_process_id FROM task_slots WHERE bot_id=?",botId).toArray()[0];
          if(direct) {
            if(!key||! /^[A-Za-z0-9:_.-]{1,160}$/.test(key)) throw new ApiError(400,"invalid_request","A stable direct-action key is required.");
            const input=await body(request),payload=JSON.stringify(input.payload);
            if(!payload||payload==="null") throw new ApiError(400,"invalid_request","The direct action payload is required.");
            let holder=`@direct:${key}`,leaseKey=key;const action=(input.payload as {action?:{type?:string;processId?:string}}).action;
            if(!["execPoll","execCancel"].includes(action?.type??"")) {
              const botRow=this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM bots WHERE id=?",botId).toArray()[0];
              if(!botRow)throw new ApiError(404,"not_found","Bot not found.");
              if(await this.computerControlled(botId,JSON.parse(botRow.data) as Bot))throw new ApiError(409,"computer_busy","Interactive desktop control is active; mutations are paused until control is released.");
            }
            if(current?.task_id.startsWith("@direct:")&&["execPoll","execCancel"].includes(action?.type??"")&&current.direct_process_id===action?.processId) {holder=current.task_id;leaseKey=holder.slice("@direct:".length);}
            if(current?.task_id==="@bot"&&["key","click","type","scroll"].includes(action?.type??"")) {
              const botRow=this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM bots WHERE id=?",botId).toArray()[0];
              if(botRow) {
                const bot=JSON.parse(botRow.data) as Bot,stub=this.env.BOT.get(this.env.BOT.idFromName(`owner:${botId}`));
                const runs=await stub.fetch(new Request("https://bot/runs",{headers:{"x-botspace-config":encodeURIComponent(JSON.stringify(bot))}}));
                if(runs.ok) {const page=await runs.json<{activeRuns:Array<{status:string}>}>();if(page.activeRuns.length&&page.activeRuns.every(run=>run.status==="waiting_approval")) {const op=(input.payload as {operationId?:unknown}).operationId;if(typeof op!=="string")throw new ApiError(400,"invalid_request","A stable action operationId is required.");const admissionToken=this.beginComputerAdmission(botId,null,op);return json({claimed:true,token:current.token??"",generation:current.generation,key,shared:true,admissionToken});}}
              }
            }
            if(current && current.task_id!==holder) throw new ApiError(409,"computer_busy","This bot's shared computer is occupied. Retry when the active work finishes.");
            const token=current?.token??crypto.randomUUID(),generation=current?.generation??this.nextSlotGeneration(botId);
            let nextToken=token,nextGeneration=generation;
            if(!current)this.ctx.storage.sql.exec("INSERT INTO task_slots(bot_id,task_id,token,generation,updated_at,payload,direct_process_id) VALUES(?,?,?,?,?,?,NULL)",botId,holder,token,generation,Date.now(),payload);
            else {
              const old=this.ctx.storage.sql.exec<{payload:string|null}>("SELECT payload FROM task_slots WHERE bot_id=? AND token=?",botId,token).toArray()[0]?.payload;
              if(action?.type!=="execPoll"&&action?.type!=="execCancel"&&old&&old!==payload) throw new ApiError(409,"operation_id_conflict","A direct-action key is already reserved for different input.");
              nextToken=crypto.randomUUID();nextGeneration=this.nextSlotGeneration(botId);
              this.ctx.storage.sql.exec("UPDATE task_slots SET token=?,generation=?,updated_at=?,payload=CASE WHEN ?='execCancel' THEN ? ELSE payload END WHERE bot_id=? AND token=?",nextToken,nextGeneration,Date.now(),action?.type??"",payload,botId,token);
            }
            await this.rearmDeletion();return json({claimed:true,token:nextToken,generation:nextGeneration,key:leaseKey});
          }
          this.reserveBotSlot(botId);
          const reserved=this.slotFor(botId);await this.rearmDeletion();return json({claimed:true,token:reserved?.token,generation:reserved?.generation});
        }
        if(request.method==="DELETE") {
          const key=new URL(request.url).searchParams.get("key"),token=new URL(request.url).searchParams.get("token");
          if(key&&token)this.ctx.storage.sql.exec("DELETE FROM task_slots WHERE bot_id=? AND task_id=? AND token=?",botId,`@direct:${key}`,token);
          else this.ctx.storage.sql.exec("DELETE FROM task_slots WHERE bot_id=? AND task_id='@bot'",botId);
          await this.rearmDeletion();return json({released:true});
        }
        if(request.method==="GET") return json({taskLocked:!!this.ctx.storage.sql.exec("SELECT 1 FROM task_slots WHERE bot_id=? AND task_id!='@bot'",botId).toArray().length});
      }
      const taskControl=/^\/tasks\/([0-9a-f-]{36})\/(claim|release)$/.exec(path);
      if(taskControl && request.method==="POST") {
        const id=taskControl[1],row=this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM tasks WHERE id=?",id).toArray()[0];
        if(!row)throw new ApiError(404,"not_found","Task not found.");
        const task=JSON.parse(row.data) as {id:string;botId:string;status:string};
        if(taskControl[2]==="claim"&&new URL(request.url).searchParams.get("message")==="1"&&!['running','waiting_approval','waiting_connection'].includes(task.status)) throw new ApiError(409,"task_not_running","A task can accept messages only while its run is active.");
        if(taskControl[2]==="release") {const slot=this.ctx.storage.sql.exec<{token:string|null}>("SELECT token FROM task_slots WHERE bot_id=? AND task_id=?",task.botId,id).toArray()[0];if(slot)this.releaseSlot(task.botId,id,slot.token);await this.rearmDeletion();return json({released:true});}
        const current=this.ctx.storage.sql.exec<{task_id:string;token:string|null;generation:number}>("SELECT task_id,token,generation FROM task_slots WHERE bot_id=?",task.botId).toArray()[0];
        if(current && current.task_id!==id) throw new ApiError(409,"task_slot_busy",current.task_id==="@bot"?"The assigned bot has active work. Task remains queued until it is idle.":"Another task assigned to this bot is active.");
        let token=current?.token??crypto.randomUUID(),generation=current?.generation??0;
        if(!current) this.ctx.storage.transactionSync(()=>{generation=this.nextSlotGeneration(task.botId);this.ctx.storage.sql.exec("INSERT INTO task_slots(bot_id,task_id,token,generation,updated_at) VALUES(?,?,?,?,?)",task.botId,id,token,generation,Date.now());});
        if(current?.task_id===id) {
          if(new URL(request.url).searchParams.get("message")==="1") {token=crypto.randomUUID();const generation=this.nextSlotGeneration(task.botId);this.ctx.storage.sql.exec("UPDATE task_slots SET token=?,generation=?,updated_at=? WHERE bot_id=? AND task_id=? AND token IS ?",token,generation,Date.now(),task.botId,id,current.token);await this.rearmDeletion();return json({claimed:true,token,generation});}
          return json({claimed:true,token,generation:current.generation});
        }
        const botRow=this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM bots WHERE id=?",task.botId).toArray()[0];if(!botRow)throw new ApiError(404,"not_found","Assigned bot not found.");
        try {
          const bot=JSON.parse(botRow.data) as Bot,state=await this.schedulerSnapshot(task.botId,bot);
          if(state.activeRuns||state.activeProcesses){this.ctx.storage.sql.exec("UPDATE task_slots SET task_id='@bot',updated_at=? WHERE bot_id=? AND token=?",Date.now(),task.botId,token);await this.rearmDeletion();throw new ApiError(409,"task_slot_busy","The assigned bot has active work. Task remains queued until it is idle.");}
        } catch(error) {
          if(error instanceof ApiError) throw error;
          this.ctx.storage.sql.exec("UPDATE task_slots SET task_id='@bot',updated_at=? WHERE bot_id=? AND token=?",Date.now(),task.botId,token);await this.rearmDeletion();
          throw new ApiError(503,"bot_busy_check_failed","Could not verify that the assigned bot is idle; task start is queued safely.");
        }
        await this.rearmDeletion();return json({claimed:true,token,generation});
      }
      const startRoute=/^\/tasks\/([0-9a-f-]{36})\/start$/.exec(path);
      if(startRoute && request.method==="POST") {
        const taskRow=this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM tasks WHERE id=?",startRoute[1]).toArray()[0];if(!taskRow)throw new ApiError(404,"not_found","Task not found.");
        const task=JSON.parse(taskRow.data) as {id:string;status:string;startImmediately:boolean;updatedAt:string;cancelRequested?:boolean};
        if(["cancelled","completed","failed"].includes(task.status))throw new ApiError(409,"task_not_restartable","This task is already terminal.");
        if(task.cancelRequested||task.status==="cancelling")throw new ApiError(409,"task_cancelling","This task is being cancelled and cannot be restarted.");
        if(task.status==="pending"){task.status="queued";task.startImmediately=true;task.updatedAt=new Date().toISOString();this.ctx.storage.sql.exec("UPDATE tasks SET data=? WHERE id=?",JSON.stringify(task),task.id);}
        await this.rearmDeletion();await this.reconcileComputerSlots();
        const latest=this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM tasks WHERE id=?",task.id).toArray()[0];return json({task:JSON.parse(latest.data)},202);
      }
      const taskMatch=/^\/tasks\/([0-9a-f-]{36})$/.exec(path);
      if(taskMatch && request.method==="GET") {const row=this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM tasks WHERE id=?",taskMatch[1]).toArray()[0];if(!row) throw new ApiError(404,"not_found","Task not found.");return json({task:JSON.parse(row.data)});}
      if(taskMatch && request.method==="PATCH") {const row=this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM tasks WHERE id=?",taskMatch[1]).toArray()[0];if(!row) throw new ApiError(404,"not_found","Task not found.");const task=JSON.parse(row.data) as {id:string;botId:string;status:string;cancelRequested?:boolean;updatedAt?:string};const input=await body(request);if(!["pending","queued","running","waiting_approval","waiting_connection","cancelling","completed","failed","cancelled"].includes(input.status as string)) throw new ApiError(400,"invalid_request","Invalid task status.");if(["completed","failed","cancelled"].includes(task.status)&&input.status!==task.status)throw new ApiError(409,"task_terminal","A terminal task cannot be changed.");if((task.cancelRequested||task.status==="cancelling")&&!['cancelling','cancelled'].includes(input.status as string))throw new ApiError(409,"task_cancelling","A cancellation request cannot be rewound.");task.status=input.status as string;if(input.cancelRequested===true) (task as {cancelRequested?:boolean}).cancelRequested=true;task.updatedAt=new Date().toISOString();
        if(task.status==="cancelling"&&!this.ctx.storage.sql.exec("SELECT 1 FROM task_slots WHERE bot_id=? AND task_id=?",task.botId,task.id).toArray().length) task.status="cancelled";
        this.ctx.storage.sql.exec("UPDATE tasks SET data=? WHERE id=?",JSON.stringify(task),taskMatch[1]);await this.rearmDeletion();return json({task});}

      const id=path.slice(1);
      if(path==="/" && request.method==="GET") {
        const bots=this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM bots ORDER BY rowid DESC").toArray().map(row=>JSON.parse(row.data));
        return json({bots});
      }
      if(path==="/" && request.method==="POST") {
        const input=parseBotInput(await body(request));
        const requested:ModelSettings={model:input.model??this.env.BOTSPACE_DEFAULT_MODEL??"gpt-6.1-sol",...(input.reasoningEffort===undefined?{}:{reasoningEffort:input.reasoningEffort}),...(input.fast===undefined?{}:{fast:input.fast})};
        const settings=input.model!==undefined || input.reasoningEffort!==undefined || input.fast!==undefined?await this.modelSettings(requested):requested;
        const now=new Date().toISOString();
        const bot:Bot={id:crypto.randomUUID(),name:input.name!,instructions:input.instructions??"",...settings,runtime:"pi",computerApprovalMode:input.computerApprovalMode??"ask",allowNamedAgents:input.allowNamedAgents??false,allowTaskCreation:input.allowTaskCreation??false,createdAt:now,updatedAt:now};
        this.ctx.storage.sql.exec("INSERT INTO bots (id,data) VALUES (?,?)",bot.id,JSON.stringify(bot));
        return json({bot},201);
      }
      if(!UUID.test(id)) throw new ApiError(404,"not_found","Bot not found.");
      if(request.method==="DELETE") return await this.deleteBot(id);
      const row=this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM bots WHERE id=?",id).toArray()[0];
      if(!row) throw new ApiError(404,"not_found","Bot not found.");
      if(request.method==="GET") return json({bot:JSON.parse(row.data)});
      if(request.method==="PATCH") {
        const input=parseBotInput(await body(request),true);
        return await this.serializeConfiguration(async()=>{
          const current=this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM bots WHERE id=?",id).toArray()[0];
          if(!current) throw new ApiError(404,"not_found","Bot not found.");
          const previous:Bot=JSON.parse(current.data),candidate:Bot={...previous,...input};
          if(input.model!==undefined && input.model!==previous.model) {
            // Options from another model never leak into this selection.
            if(input.reasoningEffort===undefined)delete candidate.reasoningEffort;
            if(input.fast===undefined)delete candidate.fast;
          }
          const changed=input.model!==undefined || input.reasoningEffort!==undefined || input.fast!==undefined;
          const settings=changed?await this.modelSettings({model:candidate.model,...(candidate.reasoningEffort===undefined?{}:{reasoningEffort:candidate.reasoningEffort}),...(candidate.fast===undefined?{}:{fast:candidate.fast})}):undefined;
          if(!this.ctx.storage.sql.exec("SELECT id FROM bots WHERE id=?",id).toArray().length) throw new ApiError(404,"not_found","Bot not found.");
          const updatedAt=new Date(Math.max(Date.now(),Date.parse(previous.updatedAt)+1)).toISOString();
          const bot:Bot={...candidate,...settings,updatedAt};
          if(settings && settings.reasoningEffort===undefined)delete bot.reasoningEffort;
          this.ctx.storage.sql.exec("UPDATE bots SET data=? WHERE id=?",JSON.stringify(bot),id);
          return json({bot});
        });
      }
      throw new ApiError(405,"method_not_allowed","Method not allowed.");
    } catch(error) {return errorResponse(error);}
  }
}
