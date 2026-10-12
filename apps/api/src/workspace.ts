import { DurableObject } from "cloudflare:workers";
import type { Bot, ModelSettings,Task,TaskUpdate } from "@botspace/contracts";
import type { Env } from "./env";
import { ApiError, errorResponse, json } from "./errors";
import { body, parseBotInput, parseMessage, parseAction, operationId, UUID } from "./validation";
import { AgentCoordinator } from "./agent-coordination";
import { AvatarCoordinator } from "./avatars";
import {OwnerKeychainCoordinator} from './owner-keychain';
import {validateModelSettings} from './model-catalog';

export class WorkspaceDO extends DurableObject<Env> {
  private deleting=new Map<string,Promise<void>>();
  private agents:AgentCoordinator;
  private avatars:AvatarCoordinator;
  private keychain:OwnerKeychainCoordinator;
  private configuring:Promise<unknown>=Promise.resolve();
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx,env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS bots (id TEXT PRIMARY KEY, data TEXT NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY,data TEXT NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS task_isolation_migrations(task_id TEXT PRIMARY KEY,bot_id TEXT NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS task_operations (operation_id TEXT PRIMARY KEY,task_id TEXT NOT NULL,fingerprint TEXT NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS task_message_receipts (operation_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,mode TEXT NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS task_updates (id TEXT PRIMARY KEY,task_id TEXT NOT NULL,data TEXT NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS task_slots (bot_id TEXT PRIMARY KEY,task_id TEXT NOT NULL,token TEXT,generation INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL DEFAULT 0,payload TEXT,direct_process_id TEXT)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS direct_intents (bot_id TEXT NOT NULL,operation_id TEXT NOT NULL,lease_key TEXT NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL,receipt TEXT,receipt_status INTEGER NOT NULL DEFAULT 200,PRIMARY KEY(bot_id,operation_id))");
    if(!ctx.storage.sql.exec<{name:string}>("PRAGMA table_info(direct_intents)").toArray().some(c=>c.name==="receipt"))ctx.storage.sql.exec("ALTER TABLE direct_intents ADD COLUMN receipt TEXT");
    if(!ctx.storage.sql.exec<{name:string}>("PRAGMA table_info(direct_intents)").toArray().some(c=>c.name==="receipt_status"))ctx.storage.sql.exec("ALTER TABLE direct_intents ADD COLUMN receipt_status INTEGER NOT NULL DEFAULT 200");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS computer_slot_generations (bot_id TEXT PRIMARY KEY,generation INTEGER NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS computer_admissions (token TEXT PRIMARY KEY,bot_id TEXT NOT NULL,task_id TEXT NOT NULL,operation_id TEXT NOT NULL,slot_token TEXT NOT NULL,created_at INTEGER NOT NULL)");
    ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS computer_admissions_scope ON computer_admissions(bot_id,task_id)");
    if(!ctx.storage.sql.exec<{name:string}>("PRAGMA table_info(computer_admissions)").toArray().some(c=>c.name==="payload"))ctx.storage.sql.exec("ALTER TABLE computer_admissions ADD COLUMN payload TEXT");
    const columns=ctx.storage.sql.exec<{name:string}>("PRAGMA table_info(task_slots)").toArray().map(row=>row.name);
    if(!columns.includes("token")) ctx.storage.sql.exec("ALTER TABLE task_slots ADD COLUMN token TEXT");
    if(!columns.includes("generation")) ctx.storage.sql.exec("ALTER TABLE task_slots ADD COLUMN generation INTEGER NOT NULL DEFAULT 0");
    if(!columns.includes("updated_at")) ctx.storage.sql.exec("ALTER TABLE task_slots ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0");
    if(!columns.includes("payload")) ctx.storage.sql.exec("ALTER TABLE task_slots ADD COLUMN payload TEXT");
    if(!columns.includes("direct_process_id")) ctx.storage.sql.exec("ALTER TABLE task_slots ADD COLUMN direct_process_id TEXT");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS bot_task_deletions (task_id TEXT PRIMARY KEY,bot_id TEXT NOT NULL,completed INTEGER NOT NULL DEFAULT 0)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS bot_deletions (id TEXT PRIMARY KEY,completed INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL)");
    this.keychain=new OwnerKeychainCoordinator(ctx,env,()=>this.rearmDeletion());
    this.agents=new AgentCoordinator(ctx,env,()=>this.rearmDeletion(),(botId,operationId,taskId)=>this.beginComputerAdmission(botId,taskId??null,operationId),token=>this.completeComputerAdmission(token));
    this.avatars=new AvatarCoordinator(ctx,env,()=>this.rearmDeletion());
    ctx.blockConcurrencyWhile(()=>this.rearmDeletion());
  }
  private serializeConfiguration<T>(change:()=>Promise<T>):Promise<T> {
    const pending=this.configuring.then(change,change);this.configuring=pending.catch(()=>{});return pending;
  }
  private async modelSettings(input:ModelSettings):Promise<ModelSettings> {
    if(input.model.startsWith("@cf/")) {
      if(input.reasoningEffort!==undefined || input.fast) throw new ApiError(400,"invalid_model_settings","ChatGPT reasoning and Fast mode options require a model from the connected ChatGPT account.");
      return {model:input.model,fast:false};
    }
    return validateModelSettings(this.env,input);
  }
  private async rearmDeletion():Promise<void> {
    const next=this.ctx.storage.sql.exec<{next_at:number}>("SELECT next_at FROM bot_deletions WHERE completed=0 ORDER BY next_at LIMIT 1").toArray()[0];
    const agentTime=this.agents.nextAlarm();
    const schedulerActive=this.ctx.storage.sql.exec("SELECT 1 FROM task_isolation_migrations LIMIT 1").toArray().length>0 || this.ctx.storage.sql.exec("SELECT 1 FROM task_updates LIMIT 1").toArray().length>0 || this.ctx.storage.sql.exec("SELECT 1 FROM direct_intents WHERE state='pending' LIMIT 1").toArray().length>0 || this.ctx.storage.sql.exec("SELECT 1 FROM task_slots LIMIT 1").toArray().length>0 || this.ctx.storage.sql.exec("SELECT 1 FROM computer_admissions LIMIT 1").toArray().length>0 || this.ctx.storage.sql.exec("SELECT 1 FROM tasks WHERE json_extract(data,'$.status')='queued' AND COALESCE(json_extract(data,'$.startImmediately'),1)=1 LIMIT 1").toArray().length>0;
    const now=Date.now(),existingAlarm=await this.ctx.storage.getAlarm();
    const schedulerTime=schedulerActive?Math.min(existingAlarm&&existingAlarm>now?existingAlarm:Infinity,now+5000):Infinity;
    const nextAt=Math.min(next?.next_at??Infinity,agentTime??Infinity,schedulerTime,this.avatars?.nextAlarm()??Infinity,this.keychain?.nextAlarm()??Infinity);
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
          this.ctx.waitUntil(stopped.arrayBuffer().catch(()=>{}));
          if(!stopped.ok) throw new Error("Task shutdown pending");
        }
        this.ctx.storage.sql.exec("DELETE FROM task_slots WHERE task_id=?",item.task_id);
        this.ctx.storage.sql.exec("DELETE FROM task_operations WHERE task_id=?",item.task_id);
        this.ctx.storage.sql.exec("DELETE FROM task_message_receipts WHERE json_extract(fingerprint,'$.taskId')=?",item.task_id);
        this.ctx.storage.sql.exec("DELETE FROM task_updates WHERE task_id=?",item.task_id);
        this.ctx.storage.sql.exec("DELETE FROM task_isolation_migrations WHERE task_id=?",item.task_id);
        this.ctx.storage.sql.exec("DELETE FROM tasks WHERE id=?",item.task_id);
        this.ctx.storage.sql.exec("UPDATE bot_task_deletions SET completed=1 WHERE task_id=?",item.task_id);
      }
      this.ctx.storage.sql.exec("DELETE FROM task_slots WHERE bot_id=?",id);
      const bot=this.env.BOT.get(this.env.BOT.idFromName(`owner:${id}`));
      const response=await bot.fetch("https://bot/delete",{method:"POST",headers:{"x-botspace-bot-id":id}});
      this.ctx.waitUntil(response.arrayBuffer().catch(()=>{}));
      if(!response.ok) throw new Error("Bot shutdown pending");
      await this.avatars.drainBot(id);
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
    if(this.ctx.storage.sql.exec("SELECT 1 FROM computer_admissions WHERE bot_id=? AND payload IS NOT NULL LIMIT 1",botId).toArray().length)throw new ApiError(409,"computer_busy","An owner computer effect is awaiting its authoritative receipt.");
    const token=crypto.randomUUID(),generation=this.nextSlotGeneration(botId);
    this.ctx.storage.sql.exec("INSERT INTO task_slots(bot_id,task_id,token,generation,updated_at) VALUES(?,'@bot',?,?,?) ON CONFLICT(bot_id) DO UPDATE SET token=excluded.token,generation=excluded.generation,updated_at=excluded.updated_at",botId,token,generation,Date.now());
    return {token,generation};
  }
  protected newTaskComputerMode():"shared"|"isolated" {return "isolated";}
  private taskLeaseKey(task:{id:string;botId:string;computerMode?:string}):string {return task.computerMode==='isolated'?`task:${task.id}`:task.botId;}
  private beginComputerAdmission(botId:string,taskId:string|null,operationId:string):string {
    let slotToken:string;
    if(taskId===null) slotToken=this.reserveBotSlot(botId).token;
    else {
      const taskRow=this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM tasks WHERE id=?",taskId).toArray()[0];
      if(!taskRow)throw new ApiError(404,"not_found","Task not found.");
      const task=JSON.parse(taskRow.data) as Task & {startOperationId?:string;cancelRequested?:boolean};
      if(botId===`task:${task.id}`)botId=task.botId;
      if(task.botId!==botId)throw new ApiError(403,"task_mismatch","Task does not belong to this assigned bot.");
      if(this.ctx.storage.sql.exec('SELECT 1 FROM task_isolation_migrations WHERE task_id=?',task.id).toArray().length)throw new ApiError(409,'computer_busy','The task environment is being isolated.');
      if(task.cancelRequested||!["queued","running","waiting_approval","waiting_connection"].includes(task.status))throw new ApiError(409,"task_not_running","The task is not accepting input.");
      // A task's initial/continuation input must enter Pi before messages saved
      // while it was waiting. Contention is capacity, never a delivery failure.
      if(task.status==="queued"&&operationId!==this.taskStartOperation(task))throw new ApiError(409,"computer_busy","Your message is saved; the task is waiting for its computer.");
      botId=this.taskLeaseKey(task);
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
  private beginTaskInboxAdmission(botId:string,taskId:string,operationId:string):string {
    const row=this.ctx.storage.sql.exec<{data:string}>('SELECT data FROM tasks WHERE id=?',taskId).toArray()[0];
    const task=row?JSON.parse(row.data) as Task & {cancelRequested?:boolean}:undefined;
    if(!task||task.botId!==botId)throw new ApiError(404,'not_found','Task not found for this bot.');
    if(task.cancelRequested||!['queued','running','waiting_approval','waiting_connection'].includes(task.status))throw new ApiError(409,'task_not_running','The task is not accepting messages.');
    botId=this.taskLeaseKey(task);
    // Pin the receipt, not the computer. This prevents a concurrent scheduler
    // observation from finishing a task while its incoming message is in flight.
    const slot=this.slotFor(botId),token=crypto.randomUUID();
    this.ctx.storage.sql.exec('INSERT INTO computer_admissions(token,bot_id,task_id,operation_id,slot_token,created_at) VALUES(?,?,?,?,?,?)',token,botId,taskId,operationId,slot?.task_id===taskId?slot.token??'inbox':'inbox',Date.now());
    this.ctx.waitUntil(this.rearmDeletion());
    return token;
  }
  private completeComputerAdmission(token:string):void {
    const row=this.ctx.storage.sql.exec<{bot_id:string;task_id:string;slot_token:string}>("SELECT bot_id,task_id,slot_token FROM computer_admissions WHERE token=?",token).toArray()[0];
    if(!row)return;
    this.ctx.storage.sql.exec("DELETE FROM computer_admissions WHERE token=?",token);
    if(!row.task_id.startsWith("@direct:"))this.ctx.storage.sql.exec("UPDATE task_slots SET updated_at=? WHERE bot_id=? AND task_id=? AND token=?",Date.now(),row.bot_id,row.task_id,row.slot_token);
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
    if(this.hasPendingAdmission(botId,taskId))return;
    if(updatedAt===undefined)this.ctx.storage.sql.exec("DELETE FROM task_slots WHERE bot_id=? AND task_id=? AND token IS ?",botId,taskId,token);
    else this.ctx.storage.sql.exec("DELETE FROM task_slots WHERE bot_id=? AND task_id=? AND token IS ? AND updated_at=?",botId,taskId,token,updatedAt);
  }
  private async computerControlled(botId:string,bot:Bot):Promise<boolean> {
    const root=this.env.BOT.get(this.env.BOT.idFromName(`owner:${botId}`)),headers={"x-botspace-config":encodeURIComponent(JSON.stringify(bot)),"x-timber-internal":"scheduler"};
    const response=await root.fetch(new Request("https://bot/computer/lease-state",{headers}));
    if(!response.ok){this.ctx.waitUntil(response.arrayBuffer().catch(()=>{}));throw new ApiError(503,"computer_state_unavailable","Could not verify interactive desktop control; mutation is blocked safely.");}
    return (await response.json<{computerControlled:boolean}>()).computerControlled;
  }
  private async schedulerSnapshot(botId:string,bot:Bot,taskId?:string):Promise<{activeRuns:number;executionRuns:number;activeProcesses:number;pendingCancellations:number;computerControlled:boolean;latest?:string;latestRunId?:string;activeStatus?:string}> {
    botId=bot.id;
    const identity=taskId?`owner:task:${taskId}`:`owner:${botId}`;
    const stub=this.env.BOT.get(this.env.BOT.idFromName(identity)),root=this.env.BOT.get(this.env.BOT.idFromName(`owner:${botId}`));
    const prefix=taskId?"task":"bot";
    const headers={"x-botspace-config":encodeURIComponent(JSON.stringify(bot)),"x-timber-internal":"scheduler",...(taskId?{"x-timber-task-id":taskId}:{})};
    const record=taskId?this.ctx.storage.sql.exec<{data:string}>('SELECT data FROM tasks WHERE id=?',taskId).toArray()[0]:undefined;
    const isolated=record&&JSON.parse(record.data).computerMode==='isolated';
    const [r,s,c]=await Promise.all([stub.fetch(new Request(`https://${prefix}/runs`,{headers})),stub.fetch(new Request(`https://${prefix}/summary`,{headers})),(isolated?stub:root).fetch(new Request("https://bot/computer/lease-state",{headers:isolated?headers:{"x-botspace-config":encodeURIComponent(JSON.stringify(bot)),"x-timber-internal":"scheduler"}}))]);
    if(!r.ok||!s.ok||!c.ok) {await Promise.all([r.arrayBuffer(),s.arrayBuffer(),c.arrayBuffer()]);throw new Error("Run reconciliation unavailable");}
    const page=await r.json<{activeRuns:Array<{status:string;subagentId?:string}>;runs:Array<{id:string;status:string;subagentId?:string}>}>(),summary=await s.json<{summary:{activeRuns:number;activeProcesses:number;pendingCancellations?:number;executionRuns?:number}}>(),lease=await c.json<{computerControlled:boolean}>();
    const latest=page.runs.find(run=>!run.subagentId);
    return {activeRuns:taskId?page.activeRuns.length:summary.summary.executionRuns??page.activeRuns.length,executionRuns:summary.summary.executionRuns??page.activeRuns.length,activeProcesses:summary.summary.activeProcesses,pendingCancellations:summary.summary.pendingCancellations??0,computerControlled:lease.computerControlled,latest:latest?.status,latestRunId:latest?.id,activeStatus:page.activeRuns.find(run=>!run.subagentId)?.status};
  }
  private hasTaskDelegation(taskId:string):boolean {
    return this.ctx.storage.sql.exec("SELECT 1 FROM agent_deliveries WHERE phase!='done' AND json_extract(data,'$.sourceTaskId')=? LIMIT 1",taskId).toArray().length>0;
  }
  /** Called inside the same synchronous transaction as the status/lease change. */
  private saveTask(task:{id:string;status:string},resultRunId?:string):void {
    const value=task as Task,previous=this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM tasks WHERE id=?",value.id).toArray()[0];
    const prior=previous?JSON.parse(previous.data) as Task:undefined,changed=!prior||prior.status!==value.status;
    value.statusVersion=(prior?.statusVersion??0)+(changed?1:0);
    this.ctx.storage.sql.exec("INSERT INTO tasks(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",value.id,JSON.stringify(value));
    if(changed&&value.creator==="bot"&&value.sourceRunId) {
      const update:TaskUpdate&{resultRunId?:string}={task:value,notificationId:`task-update:${value.id}:${value.statusVersion}`,...(resultRunId?{resultRunId}:{})};
      this.ctx.storage.sql.exec("INSERT OR IGNORE INTO task_updates(id,task_id,data) VALUES(?,?,?)",update.notificationId,value.id,JSON.stringify(update));
    }
  }
  private async deliverTaskUpdates():Promise<void> {
    const blocked=new Set<string>();
    for(const row of this.ctx.storage.sql.exec<{id:string;task_id:string;data:string}>("SELECT id,task_id,data FROM task_updates ORDER BY rowid LIMIT 32").toArray()) {
      if(blocked.has(row.task_id))continue;
      const update=JSON.parse(row.data) as TaskUpdate&{resultRunId?:string},task=update.task;
      try {
        const botRow=this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM bots WHERE id=?",task.botId).toArray()[0];
        if(!botRow){this.ctx.storage.sql.exec("DELETE FROM task_updates WHERE id=?",row.id);continue;}
        const bot=JSON.parse(botRow.data) as Bot;
        if(task.sourceTaskId&&!this.ctx.storage.sql.exec("SELECT 1 FROM tasks WHERE id=?",task.sourceTaskId).toArray().length){this.ctx.storage.sql.exec("DELETE FROM task_updates WHERE id=?",row.id);continue;}
        if(["completed","failed"].includes(task.status)&&update.result===undefined) {
          const stub=this.env.BOT.get(this.env.BOT.idFromName(`owner:task:${task.id}`));
          const response=await stub.fetch("https://task/messages?limit=100",{headers:{"x-botspace-config":encodeURIComponent(JSON.stringify(bot)),"x-timber-task-id":task.id}});
          if(!response.ok){await response.arrayBuffer();throw new Error("Task outcome unavailable");}
          const page=await response.json<{messages:Array<{runId?:string;role:string;kind?:string;text:string}>}>();
          update.result=(update.resultRunId?[...page.messages].reverse().find(message=>message.runId===update.resultRunId&&message.role==="assistant"&&message.kind==="final")?.text.slice(0,32000):undefined)??(task.status==="failed"?"The task could not finish. Open its conversation to review the error and continue safely.":"The task completed. Open its conversation to inspect the result.");
          this.ctx.storage.sql.exec("UPDATE task_updates SET data=? WHERE id=?",JSON.stringify(update),row.id);
        }
        const target=this.env.BOT.get(this.env.BOT.idFromName(task.sourceTaskId?`owner:task:${task.sourceTaskId}`:`owner:${task.botId}`));
        const response=await target.fetch("https://bot/task-updates",{method:"POST",headers:{"content-type":"application/json","x-timber-internal":"task","x-botspace-config":encodeURIComponent(JSON.stringify(bot)),...(task.sourceTaskId?{"x-timber-task-id":task.sourceTaskId}:{})},body:JSON.stringify(update)});
        await response.arrayBuffer();
        // A retained source run cannot appear later: it existed before creation.
        // Older rows omitted sourceTaskId; never guess another conversation or
        // keep the scheduler awake forever for an unresolvable/deleted origin.
        if(!response.ok&&![404,410].includes(response.status))throw new Error("Task status delivery unavailable");
        this.ctx.storage.sql.exec("DELETE FROM task_updates WHERE id=?",row.id);
      }catch{blocked.add(row.task_id);}
    }
  }
  private finalizeTask(slot:{bot_id:string;task_id:string;token:string|null;generation:number;updated_at:number},status:string,resultRunId?:string):void {
    this.ctx.storage.transactionSync(()=>{
      const currentSlot=this.slotFor(slot.bot_id);
      if(!currentSlot||currentSlot.task_id!==slot.task_id||currentSlot.token!==slot.token||currentSlot.generation!==slot.generation||currentSlot.updated_at!==slot.updated_at||this.hasPendingAdmission(slot.bot_id,slot.task_id)||this.hasTaskDelegation(slot.task_id))return;
      const row=this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM tasks WHERE id=?",slot.task_id).toArray()[0];
      if(!row)return;
      const task=JSON.parse(row.data) as {status:string;cancelRequested?:boolean;updatedAt:string};
      if(status==="cancelled"&&!(task.cancelRequested||task.status==="cancelling"))return;
      if(["completed","failed","cancelled"].includes(task.status)&&task.status!==status)return;
      task.status=status;task.updatedAt=new Date().toISOString();
      this.saveTask({...JSON.parse(row.data),...task},resultRunId);
      this.ctx.storage.sql.exec("DELETE FROM task_slots WHERE bot_id=? AND task_id=? AND token IS ? AND generation=? AND updated_at=?",slot.bot_id,slot.task_id,slot.token,slot.generation,slot.updated_at);
    });
  }
  private updateTaskStatus(taskId:string,status:string):void {
    const row=this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM tasks WHERE id=?",taskId).toArray()[0];if(!row)return;
    const task=JSON.parse(row.data) as {status:string;cancelRequested?:boolean;updatedAt:string};
    if(task.cancelRequested||task.status==="cancelling")return;
    if(["completed","failed","cancelled"].includes(task.status)&&status!==task.status)return;
    if(task.status===status)return;
    task.status=status;task.updatedAt=new Date().toISOString();this.ctx.storage.transactionSync(()=>this.saveTask({...JSON.parse(row.data),...task}));
  }
  private markTaskRunning(taskId:string):void {this.updateTaskStatus(taskId,"running");}
  private releaseFailedTaskSlot(taskId:string):void {
    const row=this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM tasks WHERE id=?",taskId).toArray()[0];if(!row)return;
    if((JSON.parse(row.data) as {status:string}).status!=="failed")return;
    const task=JSON.parse(row.data) as Task,key=this.taskLeaseKey(task),slot=this.slotFor(key);
    if(slot?.task_id===taskId)this.releaseSlot(key,taskId,slot.token,slot.updated_at);
  }
  private saveDirectReceipt(botId:string,operationId:string,receipt:unknown,terminal=false,status=200):void {
    this.ctx.storage.sql.exec("UPDATE direct_intents SET receipt=?,receipt_status=?,state=CASE WHEN ?=1 THEN 'settled' ELSE state END WHERE bot_id=? AND operation_id=? AND state!='cancelled'",JSON.stringify(receipt),status,terminal?1:0,botId,operationId);
  }
  private taskStartOperation(task:{id:string;startOperationId?:string}):string {return task.startOperationId??`task-start:${task.id}`;}
  /** Read-only projection of the current holder; never persisted in the task. */
  private taskView(task:Task):Task {
    const view={...task};delete view.queue;
    if(task.status!=="queued")return view;
    const slot=this.slotFor(this.taskLeaseKey(task));
    if(!slot)view.queue={reason:"scheduled"};
    else if(slot.task_id===task.id)view.queue={reason:"starting"};
    else if(slot.task_id==="@bot")view.queue={reason:"bot"};
    else if(slot.task_id.startsWith("@direct:"))view.queue={reason:"direct_action"};
    else {
      const row=this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM tasks WHERE id=?",slot.task_id).toArray()[0];
      const blocker=row?JSON.parse(row.data) as Task:undefined;
      view.queue=blocker?.botId===task.botId?{reason:"task",blockingTask:{id:blocker.id,title:blocker.title}}:{reason:"scheduled"};
    }
    return view;
  }
  private async reconcileAdmissions():Promise<void> {
    const rows=this.ctx.storage.sql.exec<{token:string;bot_id:string;task_id:string;operation_id:string;created_at:number;payload:string|null}>("SELECT token,bot_id,task_id,operation_id,created_at,payload FROM computer_admissions WHERE created_at<=? AND payload IS NULL AND task_id NOT LIKE '@direct:%' ORDER BY created_at LIMIT 32",Date.now()-60_000).toArray();
    for(const row of rows) {
      // Direct pins recover through the original computer journal, not native input admission.
      if(row.task_id.startsWith("@direct:")||row.payload)continue;
      try {
        const taskRecord=row.bot_id.startsWith('task:')?this.ctx.storage.sql.exec<{data:string}>('SELECT data FROM tasks WHERE id=?',row.task_id).toArray()[0]:undefined;
        const ownerId=taskRecord?JSON.parse(taskRecord.data).botId:row.bot_id;
        const botRow=this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM bots WHERE id=?",ownerId).toArray()[0];
        if(!botRow) {this.ctx.storage.sql.exec("DELETE FROM computer_admissions WHERE bot_id=?",row.bot_id);continue;}
        const bot=JSON.parse(botRow.data) as Bot,task=row.task_id!=="@bot",identity=task?`owner:task:${row.task_id}`:`owner:${row.bot_id}`;
        const stub=this.env.BOT.get(this.env.BOT.idFromName(identity)),headers={"x-botspace-config":encodeURIComponent(JSON.stringify(bot)),"x-timber-internal":"scheduler",...(task?{"x-timber-task-id":row.task_id}:{})};
        const status=await stub.fetch(new Request(`https://bot/admission/${encodeURIComponent(row.operation_id)}`,{headers}));
        if(!status.ok){await status.arrayBuffer();continue;}
        let {accepted}=await status.json<{accepted:boolean}>();
        if(!accepted) {
          const fence=await stub.fetch(new Request(`https://bot/admission-fence/${encodeURIComponent(row.operation_id)}`,{method:"POST",headers}));
          if(!fence.ok){await fence.arrayBuffer();continue;}
          // A run may have been accepted between the read and the fence RPC.
          // BotDO atomically reports that case instead of fencing accepted work.
          accepted=(await fence.json<{accepted?:boolean}>()).accepted===true;
        }
        if(task) {
          const saved=this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM tasks WHERE id=?",row.task_id).toArray()[0];
          const record=saved?JSON.parse(saved.data) as {id:string;status:string;cancelRequested?:boolean;startOperationId?:string;startAttempt?:number}:undefined;
          if(record&&record.status==="queued"&&!record.cancelRequested&&this.taskStartOperation(record)===row.operation_id) {
            if(accepted)this.markTaskRunning(record.id);
            else {
              // Only a confirmed, never-accepted input gets a fresh identity.
              // The old ID stays fenced, so a delayed original cannot execute.
              record.startAttempt=(record.startAttempt??0)+1;
              record.startOperationId=`task-start:${record.id}:${record.startAttempt}`;
              this.ctx.storage.sql.exec("UPDATE tasks SET data=? WHERE id=?",JSON.stringify(record),record.id);
            }
          }
        }
        this.ctx.storage.sql.exec("DELETE FROM computer_admissions WHERE bot_id=? AND task_id=? AND operation_id=?",row.bot_id,row.task_id,row.operation_id);
      } catch { /* Unknown request outcomes retain a durable admission fence. */ }
    }
  }
  private async reconcileComputerSlots():Promise<void> {
    await this.reconcileAdmissions();
    await this.isolateQueuedTasks();
    await this.startQueuedTasks(true);
    const slots=this.ctx.storage.sql.exec<{bot_id:string;task_id:string;token:string|null;generation:number;updated_at:number;payload:string|null;direct_process_id:string|null}>("SELECT bot_id,task_id,token,generation,updated_at,payload,direct_process_id FROM task_slots").toArray();
    for(const slot of slots) {
      try {
        const taskRecord=slot.bot_id.startsWith('task:')?this.ctx.storage.sql.exec<{data:string}>('SELECT data FROM tasks WHERE id=?',slot.task_id).toArray()[0]:undefined;
        const ownerId=taskRecord?JSON.parse(taskRecord.data).botId:slot.bot_id;
        const botRow=this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM bots WHERE id=?",ownerId).toArray()[0];
        if(!botRow){this.releaseSlot(slot.bot_id,slot.task_id,slot.token);continue;}
        const bot=JSON.parse(botRow.data) as Bot;
        if(slot.task_id.startsWith("@direct:")) {
          if(!slot.payload||!slot.token)continue;
          if(await this.computerControlled(slot.bot_id,bot))continue;
          const freshSlot=this.slotFor(slot.bot_id);
          if(!freshSlot||freshSlot.task_id!==slot.task_id||freshSlot.token!==slot.token||freshSlot.generation!==slot.generation)continue;
          // Recover the exact pinned effect (including an owner poll) before
          // generating a fresh scheduler observation; otherwise crash-left pins
          // could permanently prevent this holder from releasing its lease.
          const pinned=this.ctx.storage.sql.exec<{payload:string}>("SELECT payload FROM computer_admissions WHERE bot_id=? AND task_id=? AND slot_token=? AND payload IS NOT NULL ORDER BY created_at LIMIT 1",slot.bot_id,slot.task_id,slot.token).toArray()[0];
          const direct=JSON.parse(pinned?.payload??slot.payload) as {operationId:string;action:{type:string;processId?:string}};
          const stub=this.env.BOT.get(this.env.BOT.idFromName(`owner:${slot.bot_id}`));
          const operation=!pinned&&slot.direct_process_id&&direct.action.type!=="execCancel"
            ? {operationId:`scheduler-poll:${slot.token}:${Math.floor(Date.now()/5000)}`,action:{type:"execPoll",processId:slot.direct_process_id}}
            : direct;
          const receipt=await stub.fetch(new Request("https://bot/computer/actions",{method:"POST",headers:{"content-type":"application/json","x-botspace-config":encodeURIComponent(JSON.stringify(bot)),"x-timber-direct-lease":JSON.stringify({key:slot.task_id.slice("@direct:".length),token:slot.token,generation:slot.generation})},body:JSON.stringify(operation)}));
          if(!receipt.ok) {
            const failure:{preEffectRejected?:boolean;error?:{code?:string}}=await receipt.json<{preEffectRejected?:boolean;error?:{code?:string}}>().catch(()=>({error:undefined}));
            if(failure.preEffectRejected) {this.saveDirectReceipt(slot.bot_id,direct.operationId,failure,true,receipt.status);const state=await this.schedulerSnapshot(slot.bot_id,bot);if(!state.activeRuns&&!state.activeProcesses&&!state.pendingCancellations&&!state.computerControlled)this.releaseSlot(slot.bot_id,slot.task_id,slot.token,slot.updated_at);}
            continue;
          }
          const result=(await receipt.json<{result:{status:string;processId?:string;checkpointStatus?:string}}>()).result;
          const settled=["completed","failed","cancelled","interrupted"].includes(result.status)&&result.checkpointStatus!=="pending";
          this.saveDirectReceipt(slot.bot_id,direct.operationId,{result:{...result,operationId:direct.operationId}},settled);
          if(slot.direct_process_id&&slot.direct_process_id!==direct.operationId)this.saveDirectReceipt(slot.bot_id,slot.direct_process_id,{result:{...result,operationId:slot.direct_process_id}},settled);
          if(result.status==="running"&&result.processId&&!slot.direct_process_id)this.ctx.storage.sql.exec("UPDATE task_slots SET direct_process_id=? WHERE bot_id=? AND token=?",result.processId,slot.bot_id,slot.token);
          else if(["completed","failed","cancelled"].includes(result.status)&&result.checkpointStatus!=="pending")this.releaseSlot(slot.bot_id,slot.task_id,slot.token,slot.updated_at);
          else if(result.status==="interrupted"&&result.checkpointStatus!=="pending") {const state=await this.schedulerSnapshot(slot.bot_id,bot);if(state.activeProcesses===0&&state.pendingCancellations===0&&!state.computerControlled)this.releaseSlot(slot.bot_id,slot.task_id,slot.token,slot.updated_at);}
          continue;
        }
        if(slot.task_id==="@bot") {
          const pinned=this.ctx.storage.sql.exec<{token:string;payload:string}>("SELECT token,payload FROM computer_admissions WHERE bot_id=? AND task_id='@bot' AND slot_token=? AND payload IS NOT NULL ORDER BY created_at LIMIT 1",slot.bot_id,slot.token).toArray()[0];
          if(pinned) {
            if(await this.computerControlled(slot.bot_id,bot))continue;
            const observed=this.slotFor(slot.bot_id);
            if(!observed||observed.task_id!==slot.task_id||observed.token!==slot.token||observed.generation!==slot.generation)continue;
            const stub=this.env.BOT.get(this.env.BOT.idFromName(`owner:${slot.bot_id}`));
            const response=await stub.fetch(new Request("https://bot/computer/actions",{method:"POST",headers:{"content-type":"application/json","x-botspace-config":encodeURIComponent(JSON.stringify(bot)),"x-timber-direct-lease":JSON.stringify({token:slot.token,generation:slot.generation,admissionToken:pinned.token})},body:pinned.payload}));
            await response.arrayBuffer();
            continue;
          }
          const state=await this.schedulerSnapshot(slot.bot_id,bot);
          if(state.activeRuns===0&&state.activeProcesses===0&&state.pendingCancellations===0&&!state.computerControlled&&!this.hasPendingAdmission(slot.bot_id,"@bot")&&Date.now()-slot.updated_at>5000)this.releaseSlot(slot.bot_id,slot.task_id,slot.token,slot.updated_at);
          continue;
        }
        const row=this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM tasks WHERE id=?",slot.task_id).toArray()[0];
        if(!row){this.releaseSlot(slot.bot_id,slot.task_id,slot.token);continue;}
        const task=JSON.parse(row.data) as Task & {startText?:string;startAttachments?:string[];startMentions?:string[];startOperationId?:string;cancelRequested?:boolean};
        if(this.taskLeaseKey(task)!==slot.bot_id){this.releaseSlot(slot.bot_id,task.id,slot.token,slot.updated_at);continue;}
        const state=await this.schedulerSnapshot(slot.bot_id,bot,task.id);
        const observedSlot=this.slotFor(slot.bot_id);
        if(!observedSlot||observedSlot.task_id!==slot.task_id||observedSlot.token!==slot.token||observedSlot.generation!==slot.generation||observedSlot.updated_at!==slot.updated_at)continue;
        if(state.executionRuns>0&&state.activeStatus&&["queued","running","waiting_approval","waiting_connection"].includes(task.status)) {
          this.updateTaskStatus(task.id,["waiting_approval","waiting_connection"].includes(state.activeStatus)?state.activeStatus:"running");
        }
        if(task.status==="queued" && state.executionRuns===0 && state.activeProcesses===0 && state.pendingCancellations===0 && !this.hasPendingAdmission(slot.bot_id,task.id)) {
          const fresh=this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM tasks WHERE id=?",task.id).toArray()[0];
          const currentTask=fresh?JSON.parse(fresh.data) as typeof task:undefined;
          if(!currentTask||currentTask.status!=="queued"||currentTask.cancelRequested)continue;
          if(task.computerMode!=='isolated'){
            const mainState=await this.schedulerSnapshot(slot.bot_id,bot);
            if(mainState.activeRuns||mainState.activeProcesses||mainState.pendingCancellations||mainState.computerControlled)continue;
          }
          const startStub=this.env.BOT.get(this.env.BOT.idFromName(`owner:task:${task.id}`));
          const admission=this.beginComputerAdmission(slot.bot_id,task.id,this.taskStartOperation(task));
          const startResponse=await startStub.fetch(new Request("https://task/messages",{method:"POST",headers:{"content-type":"application/json","x-botspace-config":encodeURIComponent(JSON.stringify(bot)),"x-timber-task-id":task.id},body:JSON.stringify({operationId:this.taskStartOperation(task),text:task.startText??(task.description||task.title),...(task.startAttachments?.length?{attachments:task.startAttachments}:{}),...(task.startMentions?.length?{mentions:task.startMentions}:{})})}));
          this.ctx.waitUntil(startResponse.arrayBuffer().catch(()=>{}));
          this.completeComputerAdmission(admission);
          if(startResponse.ok)this.markTaskRunning(task.id);
          else if(startResponse.status>=400&&startResponse.status<500&&startResponse.status!==409&&startResponse.status!==429){this.updateTaskStatus(task.id,"failed");this.releaseFailedTaskSlot(task.id);}
          continue;
        }
        const stub=this.env.BOT.get(this.env.BOT.idFromName(`owner:task:${task.id}`)),headers={"x-botspace-config":encodeURIComponent(JSON.stringify(bot)),"x-timber-task-id":task.id};
        if(task.cancelRequested) {
          const [runs,processes]=await Promise.all([
            stub.fetch(new Request("https://task/runs",{headers})),
            stub.fetch(new Request("https://task/cancel-processes",{method:"POST",headers:{...headers,"x-timber-internal":"task","x-timber-task-id":task.id}})),
          ]);
          this.ctx.waitUntil(processes.arrayBuffer().catch(()=>{}));
          if(!runs.ok||!processes.ok){await runs.arrayBuffer();continue;}
          const page=await runs.json<{activeRuns:Array<{id:string}>}>();
          const outcomes=await Promise.all(page.activeRuns.map(run=>stub.fetch(new Request(`https://task/runs/${run.id}/cancel`,{method:"POST",headers}))));
          this.ctx.waitUntil(Promise.all(outcomes.map(outcome=>outcome.arrayBuffer().catch(()=>{}))));
          if(outcomes.some(outcome=>!outcome.ok))continue;
          const after=await this.schedulerSnapshot(slot.bot_id,bot,task.id);
          if(after.activeRuns===0&&after.activeProcesses===0&&after.pendingCancellations===0&&!after.computerControlled&&!this.hasPendingAdmission(slot.bot_id,task.id)&&!this.hasTaskDelegation(task.id))this.finalizeTask(slot,"cancelled");
          continue;
        }
        if(state.activeRuns===0&&state.activeProcesses===0&&state.pendingCancellations===0&&!state.computerControlled&&!this.hasPendingAdmission(slot.bot_id,task.id)&&!this.hasTaskDelegation(task.id)&&["running","waiting_approval","waiting_connection","cancelling"].includes(task.status)) {
          const fresh=this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM tasks WHERE id=?",task.id).toArray()[0];
          if(!fresh)continue;const current=JSON.parse(fresh.data) as typeof task;
          const terminal=current.cancelRequested||current.status==="cancelling"?"cancelled":(["completed","failed","cancelled"].includes(state.latest??"")?state.latest!:"failed");
          this.finalizeTask(slot,terminal,state.latestRunId);
        } else if(state.activeRuns===0&&state.activeProcesses===0&&state.pendingCancellations===0&&!state.computerControlled&&!this.hasPendingAdmission(slot.bot_id,task.id)&&!this.hasTaskDelegation(task.id)&&["completed","failed","cancelled"].includes(task.status)) this.releaseSlot(slot.bot_id,slot.task_id,slot.token,slot.updated_at);
      } catch { /* An uncertain holder stays fenced until a later reconciliation. */ }
    }
    const directQueue=this.ctx.storage.sql.exec<{bot_id:string;operation_id:string;lease_key:string;payload:string}>("SELECT bot_id,operation_id,lease_key,payload FROM direct_intents WHERE state='pending' ORDER BY created_at,rowid").toArray();
    for(const intent of directQueue) {
      if(this.slotFor(intent.bot_id))continue;
      const botRow=this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM bots WHERE id=?",intent.bot_id).toArray()[0];
      if(!botRow)continue;
      try {const state=await this.schedulerSnapshot(intent.bot_id,JSON.parse(botRow.data) as Bot);if(state.activeRuns||state.activeProcesses||state.pendingCancellations||state.computerControlled)continue;}catch{continue;}
      this.ctx.storage.transactionSync(()=>{
        if(this.slotFor(intent.bot_id))return;
        const pending=this.ctx.storage.sql.exec("SELECT 1 FROM direct_intents WHERE bot_id=? AND operation_id=? AND state='pending'",intent.bot_id,intent.operation_id).toArray().length;
        if(!pending)return;
        const token=crypto.randomUUID(),generation=this.nextSlotGeneration(intent.bot_id);
        this.ctx.storage.sql.exec("INSERT INTO task_slots(bot_id,task_id,token,generation,updated_at,payload) VALUES(?,?,?,?,?,?)",intent.bot_id,`@direct:${intent.lease_key}`,token,generation,Date.now(),intent.payload);
        this.ctx.storage.sql.exec("UPDATE direct_intents SET state='claimed' WHERE bot_id=? AND operation_id=? AND state='pending'",intent.bot_id,intent.operation_id);
      });
    }
    await this.startQueuedTasks(false);
  }
  private async startQueuedTasks(isolatedOnly:boolean):Promise<void> {
    const queued=this.ctx.storage.sql.exec<{id:string;data:string}>("SELECT id,data FROM tasks WHERE json_extract(data,'$.status')='queued' AND COALESCE(json_extract(data,'$.startImmediately'),1)=1 ORDER BY rowid").toArray();
    const bots=new Set<string>();
    for(const row of queued) {
      const task=JSON.parse(row.data) as Task & {startText?:string;startAttachments?:string[];startMentions?:string[];startOperationId?:string};
      if((task.computerMode==='isolated')!==isolatedOnly)continue;
      const key=this.taskLeaseKey(task);
      if(bots.has(key)||this.ctx.storage.sql.exec("SELECT 1 FROM task_slots WHERE bot_id=?",key).toArray().length)continue;
      const token=crypto.randomUUID();let reserved=false;
      this.ctx.storage.transactionSync(()=>{if(!this.ctx.storage.sql.exec("SELECT 1 FROM task_slots WHERE bot_id=?",key).toArray().length){const generation=this.nextSlotGeneration(key);this.ctx.storage.sql.exec("INSERT INTO task_slots(bot_id,task_id,token,generation,updated_at) VALUES(?,?,?,?,?)",key,task.id,token,generation,Date.now());reserved=true;}});
      if(!reserved)continue;bots.add(key);
      try {
        const botRow=this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM bots WHERE id=?",task.botId).toArray()[0];if(!botRow)continue;
        const bot=JSON.parse(botRow.data) as Bot;
        if(task.computerMode!=='isolated'){
          const state=await this.schedulerSnapshot(task.botId,bot);
          if(state.activeRuns||state.activeProcesses||state.pendingCancellations||state.computerControlled){this.ctx.storage.sql.exec("UPDATE task_slots SET task_id='@bot',updated_at=? WHERE bot_id=? AND token=?",Date.now(),key,token);continue;}
        }
        const fresh=this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM tasks WHERE id=?",task.id).toArray()[0];
        const current=fresh?JSON.parse(fresh.data) as typeof task:undefined;if(!current||current.status!=="queued")continue;
        const stub=this.env.BOT.get(this.env.BOT.idFromName(`owner:task:${task.id}`)),admission=this.beginComputerAdmission(task.botId,task.id,this.taskStartOperation(task));
        const response=await stub.fetch(new Request("https://task/messages",{method:"POST",headers:{"content-type":"application/json","x-botspace-config":encodeURIComponent(JSON.stringify(bot)),"x-timber-task-id":task.id},body:JSON.stringify({operationId:this.taskStartOperation(task),text:task.startText??(task.description||task.title),...(task.startAttachments?.length?{attachments:task.startAttachments}:{}),...(task.startMentions?.length?{mentions:task.startMentions}:{})})}));
        this.ctx.waitUntil(response.arrayBuffer().catch(()=>{}));
        this.completeComputerAdmission(admission);
        if(response.ok)this.markTaskRunning(task.id);
        else if(response.status>=400&&response.status<500&&response.status!==409&&response.status!==429){this.updateTaskStatus(task.id,"failed");this.releaseFailedTaskSlot(task.id);}
      } catch { /* Keep both intent and token; stable operation ID makes retry safe. */ }
    }
  }
  private async isolateQueuedTasks():Promise<void> {
    if(this.newTaskComputerMode()!=='isolated')return;
    const rows=this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM tasks WHERE COALESCE(json_extract(data,'$.computerMode'),'shared')='shared' AND (json_extract(data,'$.status') IN ('queued','pending') OR EXISTS(SELECT 1 FROM task_isolation_migrations m WHERE m.task_id=tasks.id))").toArray();
    for(const row of rows){
      const task=JSON.parse(row.data) as Task;
      if(this.hasPendingAdmission(task.botId,task.id))continue;
      this.ctx.storage.sql.exec('INSERT OR IGNORE INTO task_isolation_migrations(task_id,bot_id) VALUES(?,?)',task.id,task.botId);
      let resolved=false;
      try{
        const botRow=this.ctx.storage.sql.exec<{data:string}>('SELECT data FROM bots WHERE id=?',task.botId).toArray()[0];if(!botRow){resolved=true;continue;}
        const response=await this.env.BOT.get(this.env.BOT.idFromName(`owner:task:${task.id}`)).fetch('https://task/task-isolate',{method:'POST',headers:{'x-timber-internal':'scheduler','x-timber-task-id':task.id,'x-botspace-config':encodeURIComponent(botRow.data)}});
        if(!response.ok){await response.body?.cancel();continue;}
        const {isolated}=await response.json<{isolated:boolean}>();if(!isolated){resolved=true;continue;}
        const saved=this.ctx.storage.sql.exec<{data:string}>('SELECT data FROM tasks WHERE id=?',task.id).toArray()[0];if(!saved){resolved=true;continue;}
        const current=JSON.parse(saved.data) as Task;current.computerMode='isolated';if(current.status==='queued'&&current.startImmediately===undefined)current.startImmediately=true;
        this.ctx.storage.transactionSync(()=>{
          this.saveTask(current);
          if(!this.hasPendingAdmission(task.botId,task.id))this.ctx.storage.sql.exec('DELETE FROM task_slots WHERE bot_id=? AND task_id=?',task.botId,task.id);
        });
        resolved=true;
      }catch{/* A lost preparation receipt is retried, never an execution. */}
      finally{if(resolved)this.ctx.storage.sql.exec('DELETE FROM task_isolation_migrations WHERE task_id=?',task.id);}
    }
  }
  async alarm():Promise<void> {
    const due=this.ctx.storage.sql.exec<{id:string}>("SELECT id FROM bot_deletions WHERE completed=0 AND next_at<=? ORDER BY next_at LIMIT 8",Date.now()).toArray();
    await Promise.allSettled([...due.map(row=>this.cleanup(row.id)),this.agents.alarm(),this.avatars.alarm(),this.keychain.alarm()]);
    await this.reconcileComputerSlots();
    await this.deliverTaskUpdates();
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
        this.ctx.storage.sql.exec("DELETE FROM direct_intents WHERE bot_id=?",id);
        this.keychain.forgetBot(id);
        this.agents.forgetBot(id);
        this.avatars.forgetBot(id);
      });
    }
    // Fence is durable before cleanup and is also the authorization record for
    // retries. Keep only this minimal tombstone after all user data is erased.
    const work=this.cleanup(id);
    this.ctx.waitUntil(work.catch(()=>{}));
    await this.rearmDeletion();
    await work;
    return json({botId:id,deleted:true});
  }
  async fetch(request:Request):Promise<Response> {
    try {
      const path=new URL(request.url).pathname;
      if(path==='/keychain-tools')return await this.keychain.tool(await body(request),request.signal);
      if(path==='/keychain/deploy-verify')return await this.keychain.verifySecureDeploy(request);
      if(path==='/keychain'||path.startsWith('/keychain/'))return await this.keychain.fetch(request);
      if(path.startsWith("/avatar")) return await this.avatars.fetch(request);
      if(path.startsWith("/agents/")) return await this.agents.fetch(request);
      const inspectTasks=/^\/tasks\/inspect\/([0-9a-f-]{36})$/.exec(path);
      if(inspectTasks && request.method==='GET') {
        if(request.headers.get('x-timber-internal')!=='task')throw new ApiError(403,'internal_only','Task inspection is internal.');
        const botId=inspectTasks[1],url=new URL(request.url),taskId=url.searchParams.get('taskId'),before=url.searchParams.get('before');
        if(before!==null&&(!/^\d+$/.test(before)||!Number.isSafeInteger(Number(before))||Number(before)<1))throw new ApiError(400,'invalid_cursor','Invalid task inspection cursor.');
        const row=this.ctx.storage.sql.exec<{data:string}>('SELECT data FROM bots WHERE id=?',botId).toArray()[0];
        if(!row)throw new ApiError(404,'not_found','Bot not found.');
        if(taskId===null) {
          const rows=this.ctx.storage.sql.exec<{cursor:number;data:string}>("SELECT rowid AS cursor,data FROM tasks WHERE json_extract(data,'$.botId')=? AND rowid<? ORDER BY rowid DESC LIMIT 31",botId,before===null?Number.MAX_SAFE_INTEGER:Number(before)).toArray();
          return json({tasks:rows.slice(0,30).map(row=>{const task=JSON.parse(row.data) as Task;return {id:task.id,title:task.title,status:task.status,createdAt:task.createdAt,updatedAt:task.updatedAt};}),nextCursor:rows.length>30?String(rows[29].cursor):null});
        }
        if(!UUID.test(taskId))throw new ApiError(400,'invalid_request','Invalid task ID.');
        const saved=this.ctx.storage.sql.exec<{data:string}>('SELECT data FROM tasks WHERE id=?',taskId).toArray()[0];
        const task=saved?JSON.parse(saved.data) as Task:undefined;
        if(!task||task.botId!==botId)throw new ApiError(404,'not_found','Task not found for this bot.');
        const bot=JSON.parse(row.data) as Bot,query=new URLSearchParams();
        for(const key of ['before','limit'])if(url.searchParams.has(key))query.set(key,url.searchParams.get(key)!);
        const response=await this.env.BOT.get(this.env.BOT.idFromName(`owner:task:${taskId}`)).fetch(`https://task/progress?${query}`,{headers:{'x-botspace-config':encodeURIComponent(JSON.stringify(bot)),'x-timber-task-id':taskId}});
        if(!response.ok)return response;
        return json({task:{id:task.id,title:task.title,status:task.status,queue:this.taskView(task).queue},progress:await response.json()});
      }
      if(path==='/tasks/message'&&request.method==='POST') {
        if(request.headers.get('x-timber-internal')!=='task')throw new ApiError(403,'internal_only','Task messaging is internal.');
        const input=await body(request),message=parseMessage({operationId:input.operationId,text:input.text});
        if(typeof input.sourceBotId!=='string'||!UUID.test(input.sourceBotId)||typeof input.sourceRunId!=='string'||!UUID.test(input.sourceRunId)||typeof input.taskId!=='string'||!UUID.test(input.taskId))throw new ApiError(400,'invalid_request','Invalid task message identity.');
        const botRow=this.ctx.storage.sql.exec<{data:string}>('SELECT data FROM bots WHERE id=?',input.sourceBotId).toArray()[0];
        if(!botRow)throw new ApiError(404,'not_found','Bot not found.');
        const bot=JSON.parse(botRow.data) as Bot,headers={'x-botspace-config':encodeURIComponent(JSON.stringify(bot)),'content-type':'application/json'};
        const source=await this.env.BOT.get(this.env.BOT.idFromName(`owner:${bot.id}`)).fetch(`https://bot/runs/${input.sourceRunId}`,{headers});
        if(!source.ok)return source;
        const {run}=await source.json<{run:{botId:string;status:string;cancellation?:unknown;subagentId?:string}}>();
        if(run.botId!==bot.id||run.subagentId||run.cancellation||!['queued','running','waiting_approval','waiting_connection'].includes(run.status))throw new ApiError(409,'run_inactive','The coordinating run is no longer active.');
        const row=this.ctx.storage.sql.exec<{data:string}>('SELECT data FROM tasks WHERE id=?',input.taskId).toArray()[0];
        const task=row?JSON.parse(row.data) as Task & {cancelRequested?:boolean}:undefined;
        if(!task||task.botId!==bot.id)throw new ApiError(404,'not_found','Task not found for this bot.');
        if(task.cancelRequested||['cancelled','cancelling'].includes(task.status))throw new ApiError(409,'task_cancelled','Cancelled tasks cannot accept messages.');
        if(task.status==='pending')throw new ApiError(409,'task_not_running','Start this task before messaging it.');
        const key=`${bot.id}:${message.operationId}`,fingerprint=JSON.stringify({taskId:task.id,sourceRunId:input.sourceRunId,text:message.text});
        const previous=this.ctx.storage.sql.exec<{fingerprint:string;mode:string}>('SELECT fingerprint,mode FROM task_message_receipts WHERE operation_id=?',key).toArray()[0];
        if(previous&&previous.fingerprint!==fingerprint)throw new ApiError(409,'operation_id_conflict','This task message operation was used with different instructions.');
        const mode=previous?.mode??(['completed','failed'].includes(task.status)?'continue':'messages');
        this.ctx.storage.sql.exec('INSERT OR IGNORE INTO task_message_receipts(operation_id,fingerprint,mode) VALUES(?,?,?)',key,fingerprint,mode);
        // Freeze routing before dispatch. A lost acknowledgment must not turn a
        // now-completed message into an unintended second continuation.
        if(mode==='continue')return this.fetch(new Request(`https://workspace/tasks/${task.id}/continue`,{method:'POST',headers,body:JSON.stringify(message)}));
        // A settled replay already has a receipt and must not reopen the task.
        const admission=['queued','running','waiting_approval','waiting_connection'].includes(task.status)?this.beginTaskInboxAdmission(bot.id,task.id,message.operationId):undefined;
        const response=await this.env.BOT.get(this.env.BOT.idFromName(`owner:task:${task.id}`)).fetch('https://task/messages',{method:'POST',headers:{...headers,'x-timber-task-id':task.id},body:JSON.stringify(message)});
        if(admission)this.completeComputerAdmission(admission);
        return response;
      }
      if(path==="/tasks" && request.method==="GET") {
        const tasks=this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM tasks ORDER BY rowid DESC").toArray().map(row=>this.taskView(JSON.parse(row.data) as Task));
        return json({tasks});
      }
      if(path==="/tasks/bot" && request.method==="POST") {
        if(request.headers.get("x-timber-internal")!=="task") throw new ApiError(403,"internal_only","Task creation is internal.");
        const input=await body(request),sourceId=input.sourceBotId;
        if(typeof sourceId!=="string" || !UUID.test(sourceId) || typeof input.sourceRunId!=="string" || !UUID.test(input.sourceRunId)) throw new ApiError(400,"invalid_request","Invalid task creator identity.");
        const sourceRow=this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM bots WHERE id=?",sourceId).toArray()[0];if(!sourceRow)throw new ApiError(404,"not_found","Task creator bot not found.");
        const source=JSON.parse(sourceRow.data) as Bot;if(source.allowTaskCreation!==true)throw new ApiError(403,"task_creation_not_allowed","The owner has not allowed this bot to create tasks.");
        if(typeof input.operationId!=="string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.operationId) || typeof input.title!=="string" || !input.title.trim() || input.title.length>160 || typeof input.description!=="string" || input.description.length>32000 || input.startImmediately!==undefined && typeof input.startImmediately!=="boolean") throw new ApiError(400,"invalid_request","Invalid task details.");
        const fingerprint=JSON.stringify({sourceId,sourceRunId:input.sourceRunId,sourceTaskId:input.sourceTaskId??null,title:input.title.trim(),description:input.description,startImmediately:input.startImmediately!==false});
        const existing=this.ctx.storage.sql.exec<{task_id:string;fingerprint:string}>("SELECT task_id,fingerprint FROM task_operations WHERE operation_id=?",`bot-task:${sourceId}:${input.operationId}`).toArray()[0];
        if(existing){if(existing.fingerprint!==fingerprint)throw new ApiError(409,"operation_id_conflict","operationId was already used for another task.");const row=this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM tasks WHERE id=?",existing.task_id).toArray()[0];return json({task:JSON.parse(row.data)});}
        const sourceTaskId=input.sourceTaskId;
        if(sourceTaskId!==undefined&&(typeof sourceTaskId!=="string"||!UUID.test(sourceTaskId)))throw new ApiError(400,"invalid_request","Invalid task creator conversation.");
        const checkSourceTask=()=>{
          if(!sourceTaskId)return;
          const row=this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM tasks WHERE id=?",sourceTaskId).toArray()[0];
          const task=row?JSON.parse(row.data) as {botId:string;cancelRequested?:boolean;status:string}:undefined;
          if(!task||task.botId!==sourceId||task.cancelRequested||!["queued","running","waiting_approval","waiting_connection"].includes(task.status))throw new ApiError(409,"run_inactive","The source task is no longer active.");
        };
        checkSourceTask();
        const sourceDO=this.env.BOT.get(this.env.BOT.idFromName(sourceTaskId?`owner:task:${sourceTaskId}`:`owner:${sourceId}`));
        const receipt=await sourceDO.fetch(`https://bot/runs/${input.sourceRunId}`,{headers:{"x-botspace-config":encodeURIComponent(JSON.stringify(source)),...(sourceTaskId?{"x-timber-task-id":sourceTaskId as string}:{})}});
        if(!receipt.ok)return receipt;
        const {run}=await receipt.json<{run:{botId:string;status:string;cancellation?:unknown}}>();
        if(run.botId!==sourceId||run.cancellation||!["queued","running","waiting_approval","waiting_connection"].includes(run.status))throw new ApiError(409,"run_inactive","The task creator run is no longer active.");
        checkSourceTask();
        const currentSource=this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM bots WHERE id=?",sourceId).toArray()[0];
        if(!currentSource||(JSON.parse(currentSource.data) as Bot).allowTaskCreation!==true)throw new ApiError(403,"task_creation_not_allowed","The owner has not allowed this bot to create tasks.");
        const raced=this.ctx.storage.sql.exec<{task_id:string;fingerprint:string}>("SELECT task_id,fingerprint FROM task_operations WHERE operation_id=?",`bot-task:${sourceId}:${input.operationId}`).toArray()[0];
        if(raced){if(raced.fingerprint!==fingerprint)throw new ApiError(409,"operation_id_conflict","operationId was already used for another task.");return json({task:JSON.parse(this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM tasks WHERE id=?",raced.task_id).one().data)});}
        const now=new Date().toISOString(),task={id:crypto.randomUUID(),title:input.title.trim(),description:input.description,botId:source.id,botName:source.name,creator:"bot",createdByBotId:source.id,sourceRunId:input.sourceRunId,...(sourceTaskId?{sourceTaskId}:{}),computerMode:this.newTaskComputerMode(),status:"pending",startImmediately:input.startImmediately!==false,createdAt:now,updatedAt:now};
        if(task.startImmediately)task.status="queued";
        this.ctx.storage.transactionSync(()=>{this.saveTask(task);this.ctx.storage.sql.exec("INSERT INTO task_operations(operation_id,task_id,fingerprint) VALUES(?,?,?)",`bot-task:${sourceId}:${input.operationId}`,task.id,fingerprint);});
        await this.rearmDeletion();
        if(task.computerMode==='isolated'&&task.startImmediately)this.ctx.waitUntil(this.reconcileComputerSlots());
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
        const task={id:crypto.randomUUID(),title:input.title.trim(),description:input.description,botId:bot.id,botName:bot.name,creator:"owner",computerMode:this.newTaskComputerMode(),status:input.startImmediately===false?"pending":"queued",startImmediately:input.startImmediately!==false,createdAt:now,updatedAt:now};
        this.ctx.storage.transactionSync(()=>{this.saveTask(task);this.ctx.storage.sql.exec("INSERT INTO task_operations(operation_id,task_id,fingerprint) VALUES(?,?,?)",input.operationId,task.id,fingerprint);});
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
        if(input.inbox===true&&typeof taskId==='string')return json({token:this.beginTaskInboxAdmission(admissionRoute[1],taskId,operationId)});
        return json({token:this.beginComputerAdmission(admissionRoute[1],taskId as string|null,operationId)});
      }
      if(admissionRoute && request.method==="DELETE" && admissionRoute[2]) {this.completeComputerAdmission(admissionRoute[2]);await this.rearmDeletion();return json({released:true});}
      const directDispatch=/^\/tasks\/bot-slot\/([0-9a-f-]{36})\/direct-dispatch$/.exec(path);
      if(directDispatch&&request.method==="POST") {
        const input=await body(request),botId=directDispatch[1],lease=input.lease as {key?:string;token?:string;generation?:number;admissionToken?:string}|null,op=operationId(input.operationId),action=parseAction(input.action);
        const slot=this.slotFor(botId),holder=lease?.admissionToken?"@bot":`@direct:${lease?.key}`;
        if(!slot||slot.task_id!==holder||slot.token!==lease?.token||slot.generation!==lease?.generation)throw new ApiError(409,"computer_lease_stale","The computer lease changed before action dispatch.");
        const intent=this.ctx.storage.sql.exec<{payload:string;state:string}>("SELECT payload,state FROM direct_intents WHERE bot_id=? AND operation_id=?",botId,op).toArray()[0];
        if(intent?.state==="cancelled")throw new ApiError(409,"action_cancelled","This queued action was cancelled and will not execute.");
        if(intent&&intent.payload!==JSON.stringify({operationId:op,action}))throw new ApiError(409,"operation_id_conflict","Queued action operationId was already used for different input.");
        if(lease?.admissionToken) {
          const admission=this.ctx.storage.sql.exec<{payload:string|null}>("SELECT payload FROM computer_admissions WHERE token=? AND bot_id=? AND task_id='@bot' AND operation_id=? AND slot_token=?",lease.admissionToken,botId,op,slot.token).toArray()[0];
          if(!admission)throw new ApiError(409,"computer_lease_stale","The direct admission is no longer valid.");
          const payload=JSON.stringify({operationId:op,action});
          if(admission.payload&&admission.payload!==payload)throw new ApiError(409,"operation_id_conflict","The pinned computer action arguments changed.");
          this.ctx.storage.sql.exec("UPDATE computer_admissions SET payload=? WHERE token=? AND payload IS NULL",payload,lease.admissionToken);
          return json({token:lease.admissionToken});
        }
        const existing=this.ctx.storage.sql.exec<{token:string;payload:string|null}>("SELECT token,payload FROM computer_admissions WHERE bot_id=? AND task_id=? AND operation_id=? AND slot_token=?",botId,holder,op,slot.token).toArray()[0];
        const payload=JSON.stringify({operationId:op,action});
        if(existing?.payload&&existing.payload!==payload)throw new ApiError(409,"operation_id_conflict","The pinned computer action arguments changed.");
        const token=existing?.token??crypto.randomUUID();
        if(!existing)this.ctx.storage.sql.exec("INSERT INTO computer_admissions(token,bot_id,task_id,operation_id,slot_token,created_at,payload) VALUES(?,?,?,?,?,?,?)",token,botId,holder,op,slot.token,Date.now(),payload);
        this.ctx.waitUntil(this.rearmDeletion());return json({token});
      }
      const directQueueRoute=/^\/tasks\/bot-slot\/([0-9a-f-]{36})\/queued-actions(?:\/([^/]+)\/cancel)?$/.exec(path);
      if(directQueueRoute&&request.method==="GET"&&!directQueueRoute[2])return json({actions:this.ctx.storage.sql.exec<{operation_id:string;payload:string;state:string;receipt:string|null}>("SELECT operation_id,payload,state,receipt FROM direct_intents WHERE bot_id=? ORDER BY rowid DESC LIMIT 100",directQueueRoute[1]).toArray().map(row=>({...JSON.parse(row.payload),state:row.state,...(row.receipt?{receipt:JSON.parse(row.receipt)}:{})}))});
      if(directQueueRoute&&request.method==="POST"&&directQueueRoute[2]) {
        const op=operationId(decodeURIComponent(directQueueRoute[2])),row=this.ctx.storage.sql.exec<{state:string}>("SELECT state FROM direct_intents WHERE bot_id=? AND operation_id=?",directQueueRoute[1],op).toArray()[0];
        if(!row)throw new ApiError(404,"not_found","Queued action not found.");
        if(row.state!=="pending"&&row.state!=="cancelled")throw new ApiError(409,"action_already_claimed","The action has begun dispatch; inspect its receipt or cancel its managed process explicitly.");
        this.ctx.storage.sql.exec("UPDATE direct_intents SET state='cancelled' WHERE bot_id=? AND operation_id=? AND state='pending'",directQueueRoute[1],op);
        await this.rearmDeletion();return json({operationId:op,cancelled:true});
      }
      const directReceipt=/^\/tasks\/bot-slot\/([0-9a-f-]{36})\/receipt$/.exec(path);
      if(directReceipt&&request.method==="POST") {
        const input=await body(request),url=new URL(request.url),slot=this.slotFor(directReceipt[1]);
        if(slot?.task_id===`@direct:${url.searchParams.get("key")}`&&slot.token===url.searchParams.get("token")&&typeof input.operationId==="string")this.saveDirectReceipt(directReceipt[1],input.operationId,input.receipt,input.terminal===true,typeof input.status==="number"&&Number.isInteger(input.status)&&input.status>=200&&input.status<600?input.status:200);
        return json({recorded:true});
      }
      const rejectedDirect=/^\/tasks\/bot-slot\/([0-9a-f-]{36})\/reject$/.exec(path);
      if(rejectedDirect&&request.method==="POST") {
        const url=new URL(request.url),slot=this.slotFor(rejectedDirect[1]),key=url.searchParams.get("key"),token=url.searchParams.get("token");
        if(slot&&slot.task_id===`@direct:${key}`&&slot.token===token) {
          const row=this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM bots WHERE id=?",rejectedDirect[1]).toArray()[0];
          if(row) {const state=await this.schedulerSnapshot(rejectedDirect[1],JSON.parse(row.data) as Bot);if(!state.activeRuns&&!state.activeProcesses&&!state.pendingCancellations&&!state.computerControlled)this.releaseSlot(rejectedDirect[1],slot.task_id,slot.token,slot.updated_at);}
        }
        await this.rearmDeletion();return json({reconciled:true});
      }
      const directProcess=/^\/tasks\/bot-slot\/([0-9a-f-]{36})\/direct-process$/.exec(path);
      if(directProcess && request.method==="POST") {
        const key=new URL(request.url).searchParams.get("key"),token=new URL(request.url).searchParams.get("token"),input=await body(request);
        if(!key||!token||typeof input.processId!=="string"||! /^[A-Za-z0-9:_.-]{1,160}$/.test(input.processId))throw new ApiError(400,"invalid_request","A direct process receipt is required.");
        this.ctx.storage.sql.exec("UPDATE task_slots SET direct_process_id=?,updated_at=? WHERE bot_id=? AND task_id=? AND token=?",input.processId,Date.now(),directProcess[1],`@direct:${key}`,token);
        return json({saved:true});
      }
      const botSlot=/^\/tasks\/bot-slot\/([0-9a-f-]{36})$/.exec(path);
      if(botSlot) {
        const botId=botSlot[1];
        if(request.method==="POST") {
          const direct=new URL(request.url).searchParams.get("kind")==="direct";
          const key=new URL(request.url).searchParams.get("key");
          let current=this.ctx.storage.sql.exec<{task_id:string;token:string|null;generation:number;direct_process_id:string|null}>("SELECT task_id,token,generation,direct_process_id FROM task_slots WHERE bot_id=?",botId).toArray()[0];
          if(direct) {
            if(!key||! /^[A-Za-z0-9:_.-]{1,160}$/.test(key)) throw new ApiError(400,"invalid_request","A stable direct-action key is required.");
            const input=await body(request);
            const supplied=input.payload as {operationId?:unknown;action?:unknown};
            const directOperation=operationId(supplied?.operationId),validatedAction=parseAction(supplied?.action),payload=JSON.stringify({operationId:directOperation,action:validatedAction});
            const savedIntent=():Response|undefined=>{
              const pin=this.ctx.storage.sql.exec<{payload:string;task_id:string;slot_token:string;token:string}>("SELECT payload,task_id,slot_token,token FROM computer_admissions WHERE bot_id=? AND operation_id=? AND payload IS NOT NULL LIMIT 1",botId,directOperation).toArray()[0];
              if(pin&&pin.payload!==payload)throw new ApiError(409,"operation_id_conflict","The pinned computer action arguments changed.");
              if(pin) {
                const slot=this.slotFor(botId);
                if(slot?.task_id===pin.task_id&&slot.token===pin.slot_token)return json({claimed:true,token:slot.token,generation:slot.generation,key:pin.task_id.startsWith("@direct:")?pin.task_id.slice("@direct:".length):key,...(pin.task_id==="@bot"?{shared:true,admissionToken:pin.token}:{})});
                throw new ApiError(409,"computer_lease_stale","The pinned action no longer holds its computer lease.");
              }
              const intent=this.ctx.storage.sql.exec<{payload:string;state:string;receipt:string|null;receipt_status:number}>("SELECT payload,state,receipt,receipt_status FROM direct_intents WHERE bot_id=? AND operation_id=?",botId,directOperation).toArray()[0];
              if(intent&&intent.payload!==payload)throw new ApiError(409,"operation_id_conflict","Queued action operationId was already used for different input.");
              if(intent?.state==="cancelled")throw new ApiError(409,"action_cancelled","This queued action was cancelled and will not execute.");
              if(intent?.state==="settled"&&intent.receipt)return json({receipt:JSON.parse(intent.receipt),receiptStatus:intent.receipt_status});
              if(intent?.state==="pending")return json({queued:true,operationId:directOperation},202);
            };
            const saved=savedIntent();if(saved)return saved;
            if(!payload||payload==="null") throw new ApiError(400,"invalid_request","The direct action payload is required.");
            let holder=`@direct:${key}`,leaseKey=key;const action=(input.payload as {action?:{type?:string;processId?:string}}).action;
            if(!["execPoll","execCancel"].includes(action?.type??"")) {
              const botRow=this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM bots WHERE id=?",botId).toArray()[0];
              if(!botRow)throw new ApiError(404,"not_found","Bot not found.");
              if(await this.computerControlled(botId,JSON.parse(botRow.data) as Bot))throw new ApiError(409,"computer_busy","Interactive desktop control is active; mutations are paused until control is released.");
            }
            current=this.ctx.storage.sql.exec<NonNullable<typeof current>>("SELECT task_id,token,generation,direct_process_id FROM task_slots WHERE bot_id=?",botId).toArray()[0];
            if(current?.task_id.startsWith("@direct:")&&["execPoll","execCancel"].includes(action?.type??"")&&current.direct_process_id===action?.processId) {holder=current.task_id;leaseKey=holder.slice("@direct:".length);}
            if(current?.task_id==="@bot"&&["key","click","type","scroll"].includes(action?.type??"")&&!this.ctx.storage.sql.exec("SELECT 1 FROM computer_admissions WHERE bot_id=? AND payload IS NOT NULL LIMIT 1",botId).toArray().length) {
              const botRow=this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM bots WHERE id=?",botId).toArray()[0];
              if(botRow) {
                const bot=JSON.parse(botRow.data) as Bot,stub=this.env.BOT.get(this.env.BOT.idFromName(`owner:${botId}`));
                const runs=await stub.fetch(new Request("https://bot/runs",{headers:{"x-botspace-config":encodeURIComponent(JSON.stringify(bot))}}));
                if(runs.ok) {const page=await runs.json<{activeRuns:Array<{status:string}>}>();if(page.activeRuns.length&&page.activeRuns.every(run=>run.status==="waiting_approval")) {const saved=savedIntent();if(saved)return saved;const latest=this.slotFor(botId);if(!latest||latest.task_id!=="@bot")throw new ApiError(409,"computer_busy","The computer lease changed; retry the same operation ID.");const op=(input.payload as {operationId?:unknown}).operationId;if(typeof op!=="string")throw new ApiError(400,"invalid_request","A stable action operationId is required.");const admissionToken=this.beginComputerAdmission(botId,null,op);this.ctx.storage.sql.exec("UPDATE computer_admissions SET payload=? WHERE token=?",payload,admissionToken);return json({claimed:true,token:this.slotFor(botId)?.token??"",generation:this.slotFor(botId)?.generation,key,shared:true,admissionToken});}}else this.ctx.waitUntil(runs.arrayBuffer().catch(()=>{}));
              }
            }
            // Reread immutable arguments and cancellation state after every await.
            const latestIntent=savedIntent();if(latestIntent)return latestIntent;
            // All body/control/run awaits precede the authoritative CAS read.
            current=this.ctx.storage.sql.exec<NonNullable<typeof current>>("SELECT task_id,token,generation,direct_process_id FROM task_slots WHERE bot_id=?",botId).toArray()[0];
            holder=`@direct:${key}`;leaseKey=key;
            if(current?.task_id.startsWith("@direct:")&&["execPoll","execCancel"].includes(action?.type??"")&&current.direct_process_id===action?.processId){holder=current.task_id;leaseKey=holder.slice("@direct:".length);}
            if(current && current.task_id!==holder) {
              const count=this.ctx.storage.sql.exec<{n:number}>("SELECT COUNT(*) n FROM direct_intents WHERE bot_id=? AND state='pending'",botId).one().n;
              if(count>=32)throw new ApiError(429,"computer_queue_full","This bot's direct action queue is full.");
              const inserted=this.ctx.storage.sql.exec<{operation_id:string}>("INSERT INTO direct_intents(bot_id,operation_id,lease_key,payload,state,created_at) VALUES(?,?,?,?,'pending',?) ON CONFLICT(bot_id,operation_id) DO NOTHING RETURNING operation_id",botId,directOperation,key,payload,Date.now()).toArray();
              if(inserted.length!==1){const saved=savedIntent();if(saved)return saved;throw new ApiError(409,"computer_busy","The queued action changed; retry the same operation ID.");}
              await this.rearmDeletion();return json({queued:true,operationId:directOperation},202);
            }
            const token=current?.token??crypto.randomUUID(),generation=current?.generation??this.nextSlotGeneration(botId);
            let nextToken=token,nextGeneration=generation;
            if(!current)this.ctx.storage.sql.exec("INSERT INTO task_slots(bot_id,task_id,token,generation,updated_at,payload,direct_process_id) VALUES(?,?,?,?,?,?,NULL)",botId,holder,token,generation,Date.now(),payload);
            else {
              if(this.hasPendingAdmission(botId,holder)){await this.rearmDeletion();return json({claimed:true,token:current.token,generation:current.generation,key:leaseKey});}
              const old=this.ctx.storage.sql.exec<{payload:string|null}>("SELECT payload FROM task_slots WHERE bot_id=? AND token=?",botId,token).toArray()[0]?.payload;
              if(action?.type!=="execPoll"&&action?.type!=="execCancel"&&old&&old!==payload) throw new ApiError(409,"operation_id_conflict","A direct-action key is already reserved for different input.");
              nextToken=crypto.randomUUID();nextGeneration=this.nextSlotGeneration(botId);
              const changed=this.ctx.storage.sql.exec<{token:string}>("UPDATE task_slots SET token=?,generation=?,updated_at=?,payload=CASE WHEN ?='execCancel' THEN ? ELSE payload END WHERE bot_id=? AND token IS ? AND generation=? RETURNING token",nextToken,nextGeneration,Date.now(),action?.type??"",payload,botId,current.token,current.generation).toArray();
              if(changed.length!==1)throw new ApiError(409,"computer_busy","The computer lease changed; retry the same operation ID.");
            }
            await this.rearmDeletion();return json({claimed:true,token:nextToken,generation:nextGeneration,key:leaseKey});
          }
          this.reserveBotSlot(botId);
          const reserved=this.slotFor(botId);await this.rearmDeletion();return json({claimed:true,token:reserved?.token,generation:reserved?.generation});
        }
        if(request.method==="DELETE") {
          const key=new URL(request.url).searchParams.get("key"),token=new URL(request.url).searchParams.get("token");
          if(key&&token)this.releaseSlot(botId,`@direct:${key}`,token);
          else {const slot=this.slotFor(botId);if(slot?.task_id==="@bot")this.releaseSlot(botId,"@bot",slot.token);}
          await this.rearmDeletion();return json({released:true});
        }
        if(request.method==="GET") {
          const taskId=new URL(request.url).searchParams.get('taskId');let key=botId;
          if(taskId){const row=this.ctx.storage.sql.exec<{data:string}>('SELECT data FROM tasks WHERE id=?',taskId).toArray()[0];const task=row?JSON.parse(row.data) as Task:undefined;if(!task||task.botId!==botId)throw new ApiError(404,'not_found','Task not found for this bot.');key=this.taskLeaseKey(task);}
          const slot=this.slotFor(key);return json({taskLocked:!!slot&&slot.task_id!=="@bot",holder:slot?.task_id??null});
        }
      }
      const taskControl=/^\/tasks\/([0-9a-f-]{36})\/(claim|release)$/.exec(path);
      if(taskControl && request.method==="POST") {
        const id=taskControl[1],row=this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM tasks WHERE id=?",id).toArray()[0];
        if(!row)throw new ApiError(404,"not_found","Task not found.");
        const task=JSON.parse(row.data) as Task;const key=this.taskLeaseKey(task);
        if(taskControl[2]==="claim"&&new URL(request.url).searchParams.get("message")==="1"&&!['running','waiting_approval','waiting_connection'].includes(task.status)) throw new ApiError(409,"task_not_running","A task can accept messages only while its run is active.");
        if(taskControl[2]==="release") {const slot=this.ctx.storage.sql.exec<{token:string|null}>("SELECT token FROM task_slots WHERE bot_id=? AND task_id=?",key,id).toArray()[0];if(slot)this.releaseSlot(key,id,slot.token);await this.rearmDeletion();return json({released:true});}
        const current=this.ctx.storage.sql.exec<{task_id:string;token:string|null;generation:number}>("SELECT task_id,token,generation FROM task_slots WHERE bot_id=?",key).toArray()[0];
        if(current && current.task_id!==id) throw new ApiError(409,"task_slot_busy",current.task_id==="@bot"?"The assigned bot has active work. Task remains queued until it is idle.":"Another task assigned to this bot is active.");
        let token=current?.token??crypto.randomUUID(),generation=current?.generation??0;
        if(!current) this.ctx.storage.transactionSync(()=>{generation=this.nextSlotGeneration(key);this.ctx.storage.sql.exec("INSERT INTO task_slots(bot_id,task_id,token,generation,updated_at) VALUES(?,?,?,?,?)",key,id,token,generation,Date.now());});
        if(current?.task_id===id) {
          if(new URL(request.url).searchParams.get("message")==="1") {token=crypto.randomUUID();const generation=this.nextSlotGeneration(key);this.ctx.storage.sql.exec("UPDATE task_slots SET token=?,generation=?,updated_at=? WHERE bot_id=? AND task_id=? AND token IS ?",token,generation,Date.now(),key,id,current.token);await this.rearmDeletion();return json({claimed:true,token,generation});}
          return json({claimed:true,token,generation:current.generation});
        }
        if(task.computerMode==='isolated'){await this.rearmDeletion();return json({claimed:true,token,generation});}
        const botRow=this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM bots WHERE id=?",task.botId).toArray()[0];if(!botRow)throw new ApiError(404,"not_found","Assigned bot not found.");
        try {
          const bot=JSON.parse(botRow.data) as Bot,state=await this.schedulerSnapshot(task.botId,bot);
          if(state.activeRuns||state.activeProcesses||state.pendingCancellations||state.computerControlled){this.ctx.storage.sql.exec("UPDATE task_slots SET task_id='@bot',updated_at=? WHERE bot_id=? AND token=?",Date.now(),key,token);await this.rearmDeletion();throw new ApiError(409,"task_slot_busy","The assigned bot has active work. Task remains queued until it is idle.");}
        } catch(error) {
          if(error instanceof ApiError) throw error;
          this.ctx.storage.sql.exec("UPDATE task_slots SET task_id='@bot',updated_at=? WHERE bot_id=? AND token=?",Date.now(),key,token);await this.rearmDeletion();
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
        if(task.status==="pending"){task.status="queued";task.startImmediately=true;task.updatedAt=new Date().toISOString();this.ctx.storage.transactionSync(()=>this.saveTask(task));}
        await this.rearmDeletion();await this.reconcileComputerSlots();
        const latest=this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM tasks WHERE id=?",task.id).toArray()[0];return json({task:JSON.parse(latest.data)},202);
      }
      const continueRoute=/^\/tasks\/([0-9a-f-]{36})\/continue$/.exec(path);
      if(continueRoute&&request.method==="POST") {
        const input=await body(request);
        if(typeof input.operationId!=="string"||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.operationId)||typeof input.text!=="string"||input.text.length>32000)throw new ApiError(400,"invalid_request","Continue requires a fresh operationId and explicit instructions.");
        const parsed=parseMessage(input);
        if(parsed.attachments?.length&&parsed.mentions?.length)throw new ApiError(400,'image_mentions_unsupported','Image messages cannot mention other bots yet.');
        const id=continueRoute[1],op=`task-continue:${id}:${input.operationId}`,fingerprint=JSON.stringify({taskId:id,text:input.text,...(parsed.attachments?.length?{attachments:parsed.attachments}:{}),...(parsed.mentions?.length?{mentions:parsed.mentions}:{})});
        const row=this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM tasks WHERE id=?",id).toArray()[0];if(!row)throw new ApiError(404,"not_found","Task not found.");
        const task=JSON.parse(row.data) as {id:string;status:string;startImmediately:boolean;updatedAt:string;cancelRequested?:boolean;startOperationId?:string;startText?:string;startAttachments?:string[];startMentions?:string[]};
        if(task.cancelRequested||["cancelled","cancelling"].includes(task.status))throw new ApiError(409,"task_cancelled","Cancelled tasks cannot be continued; create a new task.");
        const previous=this.ctx.storage.sql.exec<{fingerprint:string;task_id:string}>("SELECT fingerprint,task_id FROM task_operations WHERE operation_id=?",op).toArray()[0];
        if(previous){if(previous.fingerprint!==fingerprint)throw new ApiError(409,"operation_id_conflict","Continue operationId was used with different instructions.");return json({task},202);}
        if(!["completed","failed"].includes(task.status))throw new ApiError(409,"task_not_terminal","Continue is only available for completed or failed tasks.");
        task.status="queued";task.startImmediately=true;task.startOperationId=`task-continue:${crypto.randomUUID()}`;task.startText=input.text;task.startAttachments=parsed.attachments;task.startMentions=parsed.mentions;task.updatedAt=new Date().toISOString();
        this.ctx.storage.transactionSync(()=>{this.ctx.storage.sql.exec("INSERT INTO task_operations(operation_id,task_id,fingerprint) VALUES(?,?,?)",op,id,fingerprint);this.saveTask(task);});
        await this.rearmDeletion();await this.reconcileComputerSlots();
        return json({task:JSON.parse(this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM tasks WHERE id=?",id).one().data)},202);
      }
      const taskMatch=/^\/tasks\/([0-9a-f-]{36})$/.exec(path);
      if(taskMatch && request.method==="GET") {const row=this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM tasks WHERE id=?",taskMatch[1]).toArray()[0];if(!row) throw new ApiError(404,"not_found","Task not found.");return json({task:this.taskView(JSON.parse(row.data) as Task)});}
      if(taskMatch && request.method==="PATCH") {const input=await body(request);const row=this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM tasks WHERE id=?",taskMatch[1]).toArray()[0];if(!row) throw new ApiError(404,"not_found","Task not found.");const task=JSON.parse(row.data) as Task & {cancelRequested?:boolean};if(!["pending","queued","running","waiting_approval","waiting_connection","cancelling","completed","failed","cancelled"].includes(input.status as string)) throw new ApiError(400,"invalid_request","Invalid task status.");if(["completed","failed","cancelled"].includes(task.status)&&input.status!==task.status)throw new ApiError(409,"task_terminal","A terminal task cannot be changed.");if((task.cancelRequested||task.status==="cancelling")&&!['cancelling','cancelled'].includes(input.status as string))throw new ApiError(409,"task_cancelling","A cancellation request cannot be rewound.");const firstStop=(input.status==="cancelling"||input.cancelRequested===true)&&!task.cancelRequested&&task.status!=="cancelling";task.status=input.status as Task["status"];if(input.cancelRequested===true) (task as {cancelRequested?:boolean}).cancelRequested=true;task.updatedAt=new Date().toISOString();
        if(task.status==="cancelling"&&!this.ctx.storage.sql.exec("SELECT 1 FROM task_slots WHERE bot_id=? AND task_id=?",this.taskLeaseKey(task),task.id).toArray().length) task.status="cancelled";
        this.ctx.storage.transactionSync(()=>{
          this.saveTask(task);
          // Stop and lease invalidation are one durable change: observations
          // sampled before Stop cannot certify post-Stop cancellation drain.
          if(firstStop)this.ctx.storage.sql.exec("UPDATE task_slots SET token=?,generation=?,updated_at=? WHERE bot_id=? AND task_id=?",crypto.randomUUID(),this.nextSlotGeneration(this.taskLeaseKey(task)),Date.now(),this.taskLeaseKey(task),task.id);
        });await this.rearmDeletion();return json({task});}

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
