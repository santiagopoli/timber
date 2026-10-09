import { DurableObject } from "cloudflare:workers";
import { responsesFixture } from "../../packages/runtime/test/responses-fixture";
import { BotDO as ProductionBotDO } from "../../apps/api/src/bot";
import type { Env } from "../../apps/api/src/env";
import { nativeSubagentFixture } from "./subagent-fixture";
import { nativeExecFixture } from "./exec-fixture";
import { steeringFixture } from "./steering-fixture";
import { maintenanceFixture } from "./maintenance-fixture";

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
    const path=new URL(request.url).pathname;
    const model={id:"gpt-6.1-sol",name:"GPT-6.1 Sol",provider:"openai",reasoningEfforts:["low","medium","high","xhigh","max"],defaultReasoningEffort:"medium",supportsFast:true,fastServiceTier:"fast",contextWindow:1050000,maxOutputTokens:128000,inputModalities:["text","image"]};
    if(path==="/models")return Response.json({models:[model],connected:true,defaultModel:model.id});
    if(path==="/validate-model") {
      const settings=await request.json<{model:string;reasoningEffort?:string;fast?:boolean}>();
      return Response.json({settings:{...settings,reasoningEffort:settings.reasoningEffort??"medium",fast:settings.fast??false},model});
    }
    const input=await request.json<{input:Record<string,unknown>[]}>();
    this.ctx.storage.sql.exec("INSERT INTO inference_calls(input) VALUES(?)",JSON.stringify(input));
    const lastUser=input.input.filter(item=>item.role==="user").at(-1);
    if(inferenceFixtureControl.gate && JSON.stringify(lastUser).includes(inferenceFixtureControl.matches??"")) await inferenceFixtureControl.gate;
    const maintenance=maintenanceFixture(input.input);
    if(maintenance)return maintenance;
    const steering=steeringFixture(input.input);
    if(steering) return steering;
    const subagent=nativeSubagentFixture(input.input);
    if(subagent) return subagent;
    const exec=nativeExecFixture(input.input);
    if(exec) return exec;
    if(JSON.stringify(lastUser).includes('request-github-connect')) {
      const item={type:'function_call',id:'fc_github_fixture',call_id:'call_github_fixture',namespace:'timber_computer',name:'call_tool',arguments:JSON.stringify({name:'github_connect',arguments:{repository:'owner/private',permission:'write'}}),status:'completed'};
      const response={id:'resp_github_fixture',object:'response',status:'completed',output:[item],usage:{input_tokens:10,output_tokens:8,total_tokens:18}};
      const events=[
        {type:'response.created',response:{...response,status:'in_progress',output:[]}},
        {type:'response.output_item.added',output_index:0,item:{...item,arguments:'',status:'in_progress'}},
        {type:'response.function_call_arguments.delta',output_index:0,delta:item.arguments},
        {type:'response.output_item.done',output_index:0,item},
        {type:'response.completed',response},
      ];
      return new Response(events.map(event=>`data: ${JSON.stringify(event)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
    }
    return responsesFixture(input);
  }
}

export { GitHubAuthDO } from "../../apps/api/src/github";
