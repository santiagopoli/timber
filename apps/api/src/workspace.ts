import { DurableObject } from "cloudflare:workers";
import type { Bot } from "@botspace/contracts";
import type { Env } from "./env";
import { ApiError, errorResponse, json } from "./errors";
import { body, parseBotInput, UUID } from "./validation";

export class WorkspaceDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx,env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS bots (id TEXT PRIMARY KEY, data TEXT NOT NULL)");
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
      const row=this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM bots WHERE id=?",id).toArray()[0];
      if(!row) throw new ApiError(404,"not_found","Bot not found.");
      if(request.method==="GET") return json({bot:JSON.parse(row.data)});
      if(request.method==="PATCH") {
        const input=parseBotInput(await body(request),true);
        // Re-read after the body await, so concurrent updates cannot erase a newer field.
        const current=this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM bots WHERE id=?",id).toArray()[0];
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
