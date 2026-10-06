import { DurableObject } from "cloudflare:workers";
import { responsesFixture } from "../../packages/runtime/test/responses-fixture";
import { BotDO as ProductionBotDO } from "../../apps/api/src/bot";
import type { Env } from "../../apps/api/src/env";

// Actual API, BotDO, registry, Pi lifecycle and SQLite. Only the external model
// transport and computer effect provider are deterministic test doubles.
export { default, WorkspaceDO } from "../../apps/api/src/index";
export { ComputerDO } from "../fixtures/worker";
export const inferenceFixtureControl:{gate?:Promise<void>;matches?:string}={};
export class BotDO extends ProductionBotDO {
  constructor(ctx:DurableObjectState,env:Env) {
    super(ctx,{...env,AI:{run:async()=>{throw new Error("Unexpected Workers AI fallback");}} as unknown as Ai});
  }
}
export class ChatGPTFixture extends DurableObject {
  constructor(ctx:DurableObjectState,env:object) {
    super(ctx,env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS inference_calls(id INTEGER PRIMARY KEY AUTOINCREMENT,input TEXT)");
  }
  async fetch(request:Request):Promise<Response> {
    const input=await request.json<{input:Record<string,unknown>[]}>();
    this.ctx.storage.sql.exec("INSERT INTO inference_calls(input) VALUES(?)",JSON.stringify(input));
    const lastUser=input.input.filter(item=>item.role==="user").at(-1);
    if(inferenceFixtureControl.gate && JSON.stringify(lastUser).includes(inferenceFixtureControl.matches??"")) await inferenceFixtureControl.gate;
    return responsesFixture(input);
  }
}
