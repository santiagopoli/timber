import { DurableObject } from "cloudflare:workers";
import type { ComputerAction, ComputerResult } from "@botspace/contracts";
import { ChatGPTAuthDO } from "../../apps/api/src/chatgpt";
import type { Env } from "../../apps/api/src/env";
export { ChatGPTAuthDO };
export { GitHubAuthDO } from "../../apps/api/src/github";
export class KeylessChatGPTAuthDO extends ChatGPTAuthDO {
  constructor(ctx: DurableObjectState, env: Env) {super(ctx, {...env, CHATGPT_CREDENTIAL_KEY: undefined});}
}
export {default, WorkspaceDO, BotDO} from "../../apps/api/src/index";
export {ComputerDO as RealComputerDO} from "../../packages/computer/src/index";
export const computerFixtureControl: {gate?: Promise<void>; status?: ComputerResult["status"]; failure?: {status: number; body: unknown};deleteFailure?:boolean;execSession?:{command?:string;pollsBeforeComplete?:number}} = {};

/** Test-only effects journal. This does not launch a container or implement tools. */
export class ComputerDO extends DurableObject {
  constructor(ctx: DurableObjectState, env: object) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS effects (id TEXT PRIMARY KEY, action TEXT NOT NULL, result TEXT NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS deletion (id INTEGER PRIMARY KEY)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS exec_sessions (id TEXT PRIMARY KEY,result TEXT NOT NULL,polls INTEGER NOT NULL DEFAULT 0,remaining INTEGER NOT NULL DEFAULT 0)");
  }
  async fetch(request: Request) {
    const input = await request.json<{botId: string; operationId: string; processId?:string; action: ComputerAction}>();
    const path = new URL(request.url).pathname;
    if(path==="/delete") {
      if(computerFixtureControl.deleteFailure) return Response.json({error:{code:"computer_unavailable"}},{status:503});
      this.ctx.storage.sql.exec("INSERT OR IGNORE INTO deletion(id) VALUES(1)");
      this.ctx.storage.sql.exec("DELETE FROM effects");
      this.ctx.storage.sql.exec("DELETE FROM exec_sessions");
      return Response.json({botId:input.botId,deleted:true});
    }
    if(this.ctx.storage.sql.exec("SELECT id FROM deletion").toArray().length) return Response.json({error:{code:"computer_deleted"}},{status:410});
    if (path === "/status") return Response.json({id: input.botId, provider: "cloudflare", state: "running", capabilities: ["exec", "checkpoint"]});
    if (path === "/touch") return Response.json({ok: true});
    if(path==="/exec/cancel") return Response.json(this.cancel(input.processId!));
    if (path !== "/actions") return new Response("Not found", {status: 404});
    if (computerFixtureControl.failure) return Response.json(computerFixtureControl.failure.body, {status: computerFixtureControl.failure.status});
    const previous = this.ctx.storage.sql.exec<{action: string; result: string}>("SELECT action,result FROM effects WHERE id=?", input.operationId).toArray()[0];
    if (previous) {
      if (previous.action !== JSON.stringify(input.action)) return new Response("Conflict", {status: 409});
      return Response.json(JSON.parse(previous.result));
    }
    if(input.action.type==="execPoll" || input.action.type==="execCancel") {
      const id=input.action.processId;
      const session=this.ctx.storage.sql.exec<{result:string;polls:number;remaining:number}>("SELECT * FROM exec_sessions WHERE id=?",id).toArray()[0];
      if(!session) return Response.json({error:{code:"process_not_found",message:"Process not found."}},{status:404});
      let result:ComputerResult=input.action.type==="execCancel"?this.cancel(id):JSON.parse(session.result);
      if(input.action.type==="execPoll" && result.status==="running") {
        if(session.polls>=session.remaining) result={...result,status:"completed",output:"fixture session completed",exitCode:0};
        this.ctx.storage.sql.exec("UPDATE exec_sessions SET result=?,polls=polls+1 WHERE id=?",JSON.stringify(result),id);
      }
      result={...result,operationId:input.operationId};
      this.ctx.storage.sql.exec("INSERT INTO effects(id,action,result) VALUES(?,?,?)",input.operationId,JSON.stringify(input.action),JSON.stringify(result));
      return Response.json(result);
    }
    const cancelled=this.ctx.storage.sql.exec<{result:string}>("SELECT result FROM exec_sessions WHERE id=?",input.operationId).toArray()[0];
    if(input.action.type==="exec" && cancelled) return Response.json({...JSON.parse(cancelled.result),operationId:input.operationId});
    const result: ComputerResult = {operationId: input.operationId, status: "completed", output: "fixture effect completed",
      ...(input.action.type === "checkpoint" ? {checkpointId: crypto.randomUUID()} : {})};
    if(input.action.type==="exec" && computerFixtureControl.execSession && (!computerFixtureControl.execSession.command || input.action.command===computerFixtureControl.execSession.command)) {
      result.status="running";result.processId=input.operationId;result.output="fixture session started";
      this.ctx.storage.sql.exec("INSERT INTO exec_sessions(id,result,remaining) VALUES(?,?,?)",input.operationId,JSON.stringify(result),computerFixtureControl.execSession.pollsBeforeComplete??0);
    }
    this.ctx.storage.sql.exec("INSERT INTO effects(id,action,result) VALUES(?,?,?)", input.operationId, JSON.stringify(input.action), JSON.stringify(result));
    if (input.action.type === "exec" && computerFixtureControl.gate) {
      await computerFixtureControl.gate;
      if(this.ctx.storage.sql.exec("SELECT id FROM deletion").toArray().length) return Response.json({error:{code:"computer_deleted"}},{status:410});
      const latest=this.ctx.storage.sql.exec<{result:string}>("SELECT result FROM exec_sessions WHERE id=?",input.operationId).toArray()[0];
      if(latest && (JSON.parse(latest.result) as ComputerResult).status==="cancelled") return Response.json(JSON.parse(latest.result));
      result.status = computerFixtureControl.status ?? result.status;
      this.ctx.storage.sql.exec("UPDATE effects SET result=? WHERE id=?", JSON.stringify(result), input.operationId);
    }
    return Response.json(result);
  }
  private cancel(id:string):ComputerResult {
    const row=this.ctx.storage.sql.exec<{result:string}>("SELECT result FROM exec_sessions WHERE id=?",id).toArray()[0];
    const previous=row?JSON.parse(row.result) as ComputerResult:undefined;
    const result:ComputerResult=previous && ["completed","failed","cancelled"].includes(previous.status)?previous:{operationId:id,processId:id,status:"cancelled",output:"fixture session cancelled"};
    this.ctx.storage.sql.exec("INSERT INTO exec_sessions(id,result) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET result=excluded.result",id,JSON.stringify(result));
    return result;
  }
}
