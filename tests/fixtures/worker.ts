import { DurableObject } from "cloudflare:workers";
import type { ComputerAction, ComputerResult } from "@botspace/contracts";
import { ChatGPTAuthDO } from "../../apps/api/src/chatgpt";
import type { Env } from "../../apps/api/src/env";
export { ChatGPTAuthDO };
export class KeylessChatGPTAuthDO extends ChatGPTAuthDO {
  constructor(ctx: DurableObjectState, env: Env) {super(ctx, {...env, CHATGPT_CREDENTIAL_KEY: undefined});}
}
export {default, WorkspaceDO, BotDO} from "../../apps/api/src/index";
export {ComputerDO as RealComputerDO} from "../../packages/computer/src/index";
export const computerFixtureControl: {gate?: Promise<void>; status?: ComputerResult["status"]} = {};

/** Test-only effects journal. This does not launch a container or implement tools. */
export class ComputerDO extends DurableObject {
  constructor(ctx: DurableObjectState, env: object) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS effects (id TEXT PRIMARY KEY, action TEXT NOT NULL, result TEXT NOT NULL)");
  }
  async fetch(request: Request) {
    const input = await request.json<{botId: string; operationId: string; action: ComputerAction}>();
    const path = new URL(request.url).pathname;
    if (path === "/status") return Response.json({id: input.botId, provider: "cloudflare", state: "running", capabilities: ["exec", "checkpoint"]});
    if (path === "/touch") return Response.json({ok: true});
    if (path !== "/actions") return new Response("Not found", {status: 404});
    const previous = this.ctx.storage.sql.exec<{action: string; result: string}>("SELECT action,result FROM effects WHERE id=?", input.operationId).toArray()[0];
    if (previous) {
      if (previous.action !== JSON.stringify(input.action)) return new Response("Conflict", {status: 409});
      return Response.json(JSON.parse(previous.result));
    }
    const result: ComputerResult = {operationId: input.operationId, status: "completed", output: "fixture effect completed",
      ...(input.action.type === "checkpoint" ? {checkpointId: crypto.randomUUID()} : {})};
    this.ctx.storage.sql.exec("INSERT INTO effects(id,action,result) VALUES(?,?,?)", input.operationId, JSON.stringify(input.action), JSON.stringify(result));
    if (input.action.type === "exec" && computerFixtureControl.gate) {
      await computerFixtureControl.gate;
      result.status = computerFixtureControl.status ?? "completed";
      this.ctx.storage.sql.exec("UPDATE effects SET result=? WHERE id=?", JSON.stringify(result), input.operationId);
    }
    return Response.json(result);
  }
}
