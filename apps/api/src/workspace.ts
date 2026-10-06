import { DurableObject } from "cloudflare:workers";
import type { Bot } from "@botspace/contracts";
import type { Env } from "./env";
import { ApiError, errorResponse, json } from "./errors";
import { body, parseBotInput, UUID } from "./validation";

export class WorkspaceDO extends DurableObject<Env> {
  private deleting=new Map<string,Promise<void>>();
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx,env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS bots (id TEXT PRIMARY KEY, data TEXT NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS bot_deletions (id TEXT PRIMARY KEY,completed INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL)");
  }
  private async rearmDeletion():Promise<void> {
    const next=this.ctx.storage.sql.exec<{next_at:number}>("SELECT next_at FROM bot_deletions WHERE completed=0 ORDER BY next_at LIMIT 1").toArray()[0];
    if(next) await this.ctx.storage.setAlarm(Math.max(Date.now(),next.next_at));
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
    await Promise.allSettled(due.map(row=>this.cleanup(row.id)));
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
      const id=path.slice(1);
      if(path==="/" && request.method==="GET") {
        const bots=this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM bots ORDER BY rowid DESC").toArray().map(row=>JSON.parse(row.data));
        return json({bots});
      }
      if(path==="/" && request.method==="POST") {
        const input=parseBotInput(await body(request));
        const now=new Date().toISOString();
        const bot:Bot={id:crypto.randomUUID(),name:input.name!,instructions:input.instructions??"",model:input.model??this.env.BOTSPACE_DEFAULT_MODEL??"gpt-6.1-sol",runtime:"pi",computerApprovalMode:input.computerApprovalMode??"ask",createdAt:now,updatedAt:now};
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
        // Re-read after the body await, so concurrent updates cannot erase a newer field.
        const current=this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM bots WHERE id=?",id).toArray()[0];
        if(!current) throw new ApiError(404,"not_found","Bot not found.");
        const previous:Bot=JSON.parse(current.data);
        // BotDO uses this version to reject delayed configuration snapshots.
        const updatedAt=new Date(Math.max(Date.now(),Date.parse(previous.updatedAt)+1)).toISOString();
        const bot:Bot={...previous,...input,updatedAt};
        this.ctx.storage.sql.exec("UPDATE bots SET data=? WHERE id=?",JSON.stringify(bot),id);
        return json({bot});
      }
      throw new ApiError(405,"method_not_allowed","Method not allowed.");
    } catch(error) {return errorResponse(error);}
  }
}
