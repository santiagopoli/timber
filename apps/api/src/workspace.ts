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
        const bot:Bot={id:crypto.randomUUID(),name:input.name!,instructions:input.instructions??"",...settings,runtime:"pi",computerApprovalMode:input.computerApprovalMode??"ask",allowNamedAgents:input.allowNamedAgents??false,createdAt:now,updatedAt:now};
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
