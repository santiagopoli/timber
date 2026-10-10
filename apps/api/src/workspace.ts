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
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS task_slots (bot_id TEXT PRIMARY KEY,task_id TEXT NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS bot_task_deletions (task_id TEXT PRIMARY KEY,bot_id TEXT NOT NULL,completed INTEGER NOT NULL DEFAULT 0)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS bot_deletions (id TEXT PRIMARY KEY,completed INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL)");
    this.agents=new AgentCoordinator(ctx,env,()=>this.rearmDeletion());
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
    const nextAt=Math.min(next?.next_at??Infinity,agentTime??Infinity);
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
  async alarm():Promise<void> {
    const due=this.ctx.storage.sql.exec<{id:string}>("SELECT id FROM bot_deletions WHERE completed=0 AND next_at<=? ORDER BY next_at LIMIT 8",Date.now()).toArray();
    await Promise.allSettled([...due.map(row=>this.cleanup(row.id)),this.agents.alarm()]);
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
        if(existing) {if(existing.fingerprint!==fingerprint) throw new ApiError(409,"operation_id_conflict","operationId was already used for another task."); const row=this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM tasks WHERE id=?",existing.task_id).toArray()[0]; if(!row) throw new ApiError(404,"not_found","Task not found."); return json({task:JSON.parse(row.data)});}
        const botRow=this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM bots WHERE id=?",input.botId).toArray()[0];
        if(!botRow) throw new ApiError(404,"not_found","Assigned bot not found.");
        const bot=JSON.parse(botRow.data) as Bot, now=new Date().toISOString();
        const task={id:crypto.randomUUID(),title:input.title.trim(),description:input.description,botId:bot.id,botName:bot.name,creator:"owner",status:input.startImmediately===false?"pending":"queued",startImmediately:input.startImmediately!==false,createdAt:now,updatedAt:now};
        this.ctx.storage.transactionSync(()=>{this.ctx.storage.sql.exec("INSERT INTO tasks(id,data) VALUES(?,?)",task.id,JSON.stringify(task));this.ctx.storage.sql.exec("INSERT INTO task_operations(operation_id,task_id,fingerprint) VALUES(?,?,?)",input.operationId,task.id,fingerprint);});
        return json({task},201);
      }
      const botSlot=/^\/tasks\/bot-slot\/([0-9a-f-]{36})$/.exec(path);
      if(botSlot) {
        const botId=botSlot[1];
        if(request.method==="POST") {
          const existing=this.ctx.storage.sql.exec<{task_id:string}>("SELECT task_id FROM task_slots WHERE bot_id=?",botId).toArray()[0];
          if(existing && existing.task_id!=="@bot") throw new ApiError(409,"computer_busy","A task is using this bot's computer. Finish or cancel it before starting bot work.");
          this.ctx.storage.sql.exec("INSERT INTO task_slots(bot_id,task_id) VALUES(?,?) ON CONFLICT(bot_id) DO UPDATE SET task_id='@bot'",botId,"@bot");return json({claimed:true});
        }
        if(request.method==="DELETE") {this.ctx.storage.sql.exec("DELETE FROM task_slots WHERE bot_id=? AND task_id='@bot'",botId);return json({released:true});}
        if(request.method==="GET") return json({taskLocked:!!this.ctx.storage.sql.exec("SELECT 1 FROM task_slots WHERE bot_id=? AND task_id!='@bot'",botId).toArray().length});
      }
      const taskControl=/^\/tasks\/([0-9a-f-]{36})\/(claim|release)$/.exec(path);
      if(taskControl && request.method==="POST") {
        const id=taskControl[1],row=this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM tasks WHERE id=?",id).toArray()[0];if(!row)throw new ApiError(404,"not_found","Task not found.");const task=JSON.parse(row.data);
        if(taskControl[2]==="release") {this.ctx.storage.sql.exec("DELETE FROM task_slots WHERE bot_id=? AND task_id=?",task.botId,id);return json({released:true});}
        const existing=this.ctx.storage.sql.exec<{task_id:string}>("SELECT task_id FROM task_slots WHERE bot_id=?",task.botId).toArray()[0];
        if(existing && existing.task_id!==id) throw new ApiError(409,"task_slot_busy",existing.task_id==="@bot"?"The assigned bot has active work. Stop or finish it before starting this task.":"Another task assigned to this bot is active. Stop or finish it before starting this task.");
        const botRow=this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM bots WHERE id=?",task.botId).toArray()[0];if(!botRow)throw new ApiError(404,"not_found","Assigned bot not found.");
        const bot=JSON.parse(botRow.data) as Bot,main=this.env.BOT.get(this.env.BOT.idFromName(`owner:${task.botId}`));
        const activeResponse=await main.fetch(new Request("https://bot/runs",{headers:{"x-botspace-config":encodeURIComponent(JSON.stringify(bot))}}));
        if(!activeResponse.ok)throw new ApiError(503,"bot_busy_check_failed","Could not verify the assigned bot is idle; task start is blocked safely.");
        const active=await activeResponse.json<{activeRuns:unknown[]}>();
        if(active.activeRuns.length)throw new ApiError(409,"task_slot_busy","The assigned bot has an active run. Stop or finish it before starting this task.");
        const afterCheck=this.ctx.storage.sql.exec<{task_id:string}>("SELECT task_id FROM task_slots WHERE bot_id=?",task.botId).toArray()[0];
        if(afterCheck && afterCheck.task_id!==id)throw new ApiError(409,"task_slot_busy","Assigned bot work began while checking the task slot.");
        this.ctx.storage.sql.exec("INSERT INTO task_slots(bot_id,task_id) VALUES(?,?) ON CONFLICT(bot_id) DO UPDATE SET task_id=excluded.task_id",task.botId,id);return json({claimed:true});
      }
      const taskMatch=/^\/tasks\/([0-9a-f-]{36})$/.exec(path);
      if(taskMatch && request.method==="GET") {const row=this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM tasks WHERE id=?",taskMatch[1]).toArray()[0];if(!row) throw new ApiError(404,"not_found","Task not found.");return json({task:JSON.parse(row.data)});}
      if(taskMatch && request.method==="PATCH") {const row=this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM tasks WHERE id=?",taskMatch[1]).toArray()[0];if(!row) throw new ApiError(404,"not_found","Task not found.");const task=JSON.parse(row.data);const input=await body(request);if(!["pending","queued","running","waiting_approval","waiting_connection","completed","failed","cancelled"].includes(input.status as string)) throw new ApiError(400,"invalid_request","Invalid task status.");task.status=input.status as string;task.updatedAt=new Date().toISOString();this.ctx.storage.sql.exec("UPDATE tasks SET data=? WHERE id=?",JSON.stringify(task),taskMatch[1]);return json({task});}

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
