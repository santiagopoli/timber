import { authenticate, consoleSession } from "./auth";
import { ApiError, errorResponse, json } from "./errors";
import type { Env } from "./env";
import { UUID, operationId as validateOperationId, parseAction } from "./validation";
import type { Bot } from "@botspace/contracts";
export { WorkspaceDO } from "./workspace";
export { BotDO } from "./bot";
export { GitHubAuthDO } from "./github";
export { WorkspacePreviewGateway } from "./workspace-apps";
export { ChatGPTAuthDO } from "./chatgpt";
export { ComputerDO } from "@botspace/computer";

/** Drain or cancel an incoming body when a route rejects before forwarding it.
 * Workerd treats returning while a POST stream remains unread as an error. */
async function discardRequestBody(request:Request):Promise<void> {
  if(!request.body || request.bodyUsed || request.body.locked) return;
  try { await request.body.cancel(); } catch { /* A forwarded/locked stream is already owned elsewhere. */ }
}

async function beginAdmission(env:Env,botId:string,operationId:string,taskId?:string):Promise<string> {
  const path=`https://workspace/tasks/bot-slot/${botId}/admissions`;
  const response=await env.WORKSPACE.get(env.WORKSPACE.idFromName("owner")).fetch(new Request(path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({operationId,...taskId?{taskId}:{}})}));
  if(!response.ok)throw new ApiError(response.status,"computer_busy","The bot's shared computer is occupied; retry when its current work finishes.");
  return (await response.json<{token:string}>()).token;
}
async function completeAdmission(env:Env,botId:string,token:string):Promise<void> {
  await env.WORKSPACE.get(env.WORKSPACE.idFromName("owner")).fetch(`https://workspace/tasks/bot-slot/${botId}/admissions/${token}`,{method:"DELETE"});
}
async function bodyOperationId(request:Request):Promise<string> {
  try {const input=await request.clone().json() as {operationId?:unknown};return validateOperationId(input.operationId);}
  catch(error) {await discardRequestBody(request);throw error;}
}

function internalRequest(request:Request,url:string):Request {
  const headers=new Headers();
  const contentType=request.headers.get("content-type");
  if(contentType) headers.set("content-type",contentType);
  return new Request(url,{method:request.method,headers,body:["GET","HEAD"].includes(request.method)?undefined:request.body,redirect:"manual"});
}
export default {
  async fetch(request:Request,env:Env):Promise<Response> {
    let requestBodyForwarded=false;
    try {
      const url=new URL(request.url);
      if(url.pathname==="/health" && request.method==="GET") return json({ok:true,service:"botspace"});
      // Static developer console contains no account data or credentials.
      if((url.pathname==="/" || url.pathname==="/console" || url.pathname.startsWith("/console/")) && request.method==="GET") {
        if(!env.ASSETS) throw new ApiError(404,"not_found","Console not installed.");
        // Assets canonicalizes /index.html back to /. Redirect the public aliases
        // before rewriting, otherwise / -> /index.html -> / loops indefinitely.
        if(["/","/console","/console/index.html"].includes(url.pathname)) {
          return new Response(null,{status:307,headers:{location:`/console/${url.search}`,"cache-control":"no-store"}});
        }
        const assetUrl=new URL(request.url);
        assetUrl.pathname=assetUrl.pathname.slice("/console".length);
        const response=await env.ASSETS.fetch(new Request(assetUrl,request));
        const headers=new Headers(response.headers);
        const previewOrigin=env.PREVIEW_ORIGIN && /^https:\/\/[a-z0-9.-]+$/.test(env.PREVIEW_ORIGIN)?env.PREVIEW_ORIGIN:"";
        headers.set("content-security-policy",`default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ${url.origin.replace(/^http/, 'ws')}; img-src 'self' blob: data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self' ${previewOrigin}`);
        // A cross-origin form POST with no-referrer sends Origin: null. The
        // app ticket handoff requires our exact origin, without a path/query.
        headers.set("referrer-policy","strict-origin");
        headers.set("x-content-type-options","nosniff");
        // Always load the current shell; its fingerprinted JS/CSS retain their
        // own asset cache policy. This never reloads an active conversation.
        if(assetUrl.pathname==="/" || headers.get("content-type")?.includes("text/html")) headers.set("cache-control","no-store");
        return new Response(response.body,{status:response.status,headers});
      }
      // Provider callbacks are one-time, browser-bound flows. Git transport is
      // authenticated independently with short-lived repository-scoped capabilities.
      if((/^\/github\/setup\/(start|manifest|install|oauth)$/.test(url.pathname) && request.method==="GET") || url.pathname.startsWith("/github/git/")) {
        if(!env.GITHUB) throw new ApiError(503,"github_not_configured","GitHub is not configured.");
        return env.GITHUB.get(env.GITHUB.idFromName("owner")).fetch(request);
      }
      // Browser WebSockets cannot send Authorization. Only this exact route uses
      // a one-use, bot-bound ticket in a protocol header, never in its URL.
      const desktop=/^\/v1\/bots\/([^/]+)\/computer\/live$/.exec(url.pathname);
      if(desktop) {
        if(!env.BOTSPACE_API_TOKEN || env.BOTSPACE_API_TOKEN.length<24) throw new ApiError(503,"auth_unconfigured","API authentication is not configured.");
        if(request.method!=="GET" || request.headers.get("upgrade")?.toLowerCase()!=="websocket" || request.headers.get("origin")!==url.origin || url.search || !UUID.test(desktop[1])) throw new ApiError(403,"desktop_access_denied","Desktop access denied.");
        const protocols=request.headers.get("sec-websocket-protocol")??"";
        if(protocols.length>256) throw new ApiError(403,"desktop_access_denied","Desktop access denied.");
        const registry=env.WORKSPACE.get(env.WORKSPACE.idFromName("owner"));
        const record=await registry.fetch(`https://workspace/${desktop[1]}`);
        if(!record.ok) return record;
        return env.COMPUTER.get(env.COMPUTER.idFromName(desktop[1])).fetch(new Request("https://computer.internal/desktop-ws",{headers:{"x-timber-bot-id":desktop[1],Upgrade:"websocket","sec-websocket-protocol":protocols}}));
      }
      if(url.pathname==="/v1/session") return await consoleSession(request,env.BOTSPACE_API_TOKEN);
      const owner=await authenticate(request,env.BOTSPACE_API_TOKEN);
      if(!url.pathname.startsWith("/v1/")) throw new ApiError(404,"not_found","Endpoint not found.");
      if(url.pathname==="/v1/models") {
        if(request.method!=="GET")throw new ApiError(405,"method_not_allowed","Method not allowed.");
        if(!env.CHATGPT)return json({models:[],connected:false,defaultModel:env.BOTSPACE_DEFAULT_MODEL??"gpt-6.1-sol",error:"ChatGPT connections are not configured on this server."});
        return env.CHATGPT.get(env.CHATGPT.idFromName(owner)).fetch("https://chatgpt/models");
      }
      if(url.pathname==="/v1/connections/chatgpt" || url.pathname==="/v1/connections/chatgpt/verify") {
        const verification=url.pathname.endsWith("/verify");
        if(verification?request.method!=="POST":!["GET","POST","DELETE"].includes(request.method)) throw new ApiError(405,"method_not_allowed","Method not allowed.");
        if(!env.CHATGPT) throw new ApiError(503,"chatgpt_not_configured","ChatGPT connections are not configured on this server.");
        const connection=env.CHATGPT.get(env.CHATGPT.idFromName(owner));
        requestBodyForwarded=true;return connection.fetch(internalRequest(request,`https://chatgpt/${verification?"verify":""}`));
      }
      if(url.pathname==="/v1/connections/github/connect") {
        if(request.method!=="POST") throw new ApiError(405,"method_not_allowed","Method not allowed.");
        if(!env.GITHUB) throw new ApiError(503,"github_not_configured","GitHub is not configured.");
        return env.GITHUB.get(env.GITHUB.idFromName(owner)).fetch(new Request("https://github/connect",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({origin:env.GITHUB_PUBLIC_ORIGIN})}));
      }
      if(url.pathname==="/v1/connections/github") {
        if(!["GET","DELETE"].includes(request.method)) throw new ApiError(405,"method_not_allowed","Method not allowed.");
        if(!env.GITHUB) throw new ApiError(503,"github_not_configured","GitHub is not configured.");
        requestBodyForwarded=true;return env.GITHUB.get(env.GITHUB.idFromName(owner)).fetch(internalRequest(request,"https://github/status"));
      }
      const registry=env.WORKSPACE.get(env.WORKSPACE.idFromName(owner));
      if(url.pathname==="/v1/tasks") {
        if(request.method==="GET") return registry.fetch(new Request("https://workspace/tasks"));
        if(request.method!=="POST") throw new ApiError(405,"method_not_allowed","Method not allowed.");
        requestBodyForwarded=true;const created=await registry.fetch(internalRequest(request,"https://workspace/tasks"));
        if(!created.ok) return created;
        return created;
      }
      const taskRoute=/^\/v1\/tasks\/([0-9a-f-]{36})(?:\/(messages|runs|events|start|cancel))?$/.exec(url.pathname);
      if(taskRoute) {
        const [,taskId,endpoint]=taskRoute;
        const taskResponse=await registry.fetch(`https://workspace/tasks/${taskId}`);
        if(!taskResponse.ok) return taskResponse;
        const {task}=await taskResponse.json<{task:{id:string;botId:string;status:string;description:string;title:string}}>();
        const botResponse=await registry.fetch(`https://workspace/${task.botId}`);
        if(!botResponse.ok) return botResponse;
        const {bot}=await botResponse.json<{bot:Bot}>();
        if(!endpoint) {if(request.method!=="GET")throw new ApiError(405,"method_not_allowed","Method not allowed.");return json({task});}
        const stub=env.BOT.get(env.BOT.idFromName(`${owner}:task:${taskId}`));
        const headers=new Headers();headers.set("x-botspace-config",encodeURIComponent(JSON.stringify(bot)));
        headers.set("x-timber-task-id",taskId);
        const contentType=request.headers.get("content-type");if(contentType)headers.set("content-type",contentType);
        const lastEvent=request.headers.get("last-event-id");if(lastEvent)headers.set("last-event-id",lastEvent);
        if(endpoint==="start") {
          if(request.method!=="POST") throw new ApiError(405,"method_not_allowed","Method not allowed.");
          await discardRequestBody(request);
          const forwarded=await registry.fetch(new Request(`https://workspace/tasks/${taskId}/start`,{method:"POST"}));
          return forwarded;
        }
        if(endpoint==="cancel") {
          if(request.method!=="POST") throw new ApiError(405,"method_not_allowed","Method not allowed.");
          await discardRequestBody(request);
          if(["completed","failed","cancelled"].includes(task.status)) throw new ApiError(409,"task_terminal","A terminal task cannot be cancelled.");
          const persisted=await registry.fetch(`https://workspace/tasks/${taskId}`,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({status:"cancelling",cancelRequested:true})});
          if(!persisted.ok)return persisted;
          const [runs,processes]=await Promise.all([
            stub.fetch(new Request("https://task/runs",{headers})),
            stub.fetch(new Request("https://task/cancel-processes",{method:"POST",headers:(()=>{const h=new Headers(headers);h.set("x-timber-internal","task");return h;})()})),
          ]);
          if(!runs.ok||!processes.ok)return json({taskId,cancelRequested:true,confirmed:false,runCount:0});
          const data=await runs.json<{activeRuns:Array<{id:string}>}>(),processState=await processes.json<{confirmed:boolean}>();
          const outcomes=await Promise.all(data.activeRuns.map(run=>stub.fetch(new Request(`https://task/runs/${run.id}/cancel`,{method:"POST",headers}))));
          const failed=outcomes.some(outcome=>!outcome.ok);
          return json({taskId,cancelRequested:true,confirmed:!failed&&processState.confirmed&&data.activeRuns.length===0,runCount:outcomes.length});
        }
        if(endpoint==="messages" && request.method==="POST" && task.status==="cancelled") {await discardRequestBody(request);throw new ApiError(409,"task_cancelled","Cancelled tasks cannot accept new messages.");}
        if(endpoint==="messages" && request.method==="POST" && !["running","waiting_approval","waiting_connection"].includes(task.status)) {await discardRequestBody(request);throw new ApiError(409,"task_not_running","This task is not currently running; wait for it to start before messaging it.");}
        let admissionToken:string|undefined;
        if(endpoint==="messages" && request.method==="POST") admissionToken=await beginAdmission(env,task.botId,await bodyOperationId(request),taskId);
        requestBodyForwarded=true;
        const response=await stub.fetch(new Request(`https://task/${endpoint}${url.search}`,{method:request.method,headers,body:["GET","HEAD"].includes(request.method)?undefined:request.body,redirect:"manual",signal:request.signal}));
        if(admissionToken)await completeAdmission(env,task.botId,admissionToken);

        return response;
      }
      if(url.pathname==="/v1/bots") {
        if(!["GET","POST"].includes(request.method)) throw new ApiError(405,"method_not_allowed","Method not allowed.");
        requestBodyForwarded=true;return registry.fetch(internalRequest(request,"https://workspace/"));
      }
      const match=/^\/v1\/bots\/([^/]+)(\/.*)?$/.exec(url.pathname);
      if(!match || !UUID.test(match[1])) throw new ApiError(404,"not_found","Bot not found.");
      const botId=match[1];
      const tail=match[2]??"";
      if(["/agent-messages","/agent-results","/agent-cancel"].includes(tail)) throw new ApiError(404,"not_found","Endpoint not found.");
      if(tail==="" && ["PATCH","DELETE"].includes(request.method)) {requestBodyForwarded=true;return registry.fetch(internalRequest(request,`https://workspace/${botId}`));}
      const record=await registry.fetch(`https://workspace/${botId}`);
      if(!record.ok) return record;
      const {bot}=await record.json<{bot:Bot}>();
      if(!tail && request.method==="GET") return json({bot});
      const artifact=/^\/artifacts\/([^/]+)$/.exec(tail);
      if(artifact && request.method==="GET") {
        if(!UUID.test(artifact[1])) throw new ApiError(404,"not_found","Artifact not found.");
        const stored=await env.FILES.get(`bots/${botId}/artifacts/${artifact[1]}`);
        if(!stored) throw new ApiError(404,"not_found","Artifact not found.");
        const contentType=stored.httpMetadata?.contentType??"application/octet-stream";
        return new Response(stored.body,{headers:{"content-type":contentType,"content-disposition":`attachment; filename="${artifact[1]}"`,"cache-control":"private, no-store","x-content-type-options":"nosniff","content-security-policy":"sandbox; default-src 'none'"}});
      }
      const stub=env.BOT.get(env.BOT.idFromName(`${owner}:${botId}`));
      const headers=new Headers();
      headers.set("x-botspace-config",encodeURIComponent(JSON.stringify(bot)));
      const contentType=request.headers.get("content-type");
      if(contentType) headers.set("content-type",contentType);
      const lastEvent=request.headers.get("last-event-id");
      if(lastEvent) headers.set("last-event-id",lastEvent);
      let admissionToken:string|undefined;
      const agentMessage=/^\/agents\/([^/]+)\/messages$/.exec(tail);
      let decodedAgentId="";try{decodedAgentId=agentMessage?decodeURIComponent(agentMessage[1]):"";}catch{}
      const isRunAdmission=tail==="/messages"&&request.method==="POST"||!!agentMessage&&UUID.test(decodedAgentId)&&request.method==="POST";
      if(isRunAdmission) admissionToken=await beginAdmission(env,botId,await bodyOperationId(request));
      if(tail==="/computer/actions" && request.method==="POST") {
        const raw=await request.text();
        let input:{operationId?:unknown;action?:{type?:unknown;processId?:unknown}};
        try {input=JSON.parse(raw) as typeof input;} catch {input={};}
        const op=validateOperationId(input.operationId),action=parseAction(input.action);
        const directInput={operationId:op,action};
        if(["readFile","listFiles","screenshot"].includes(action.type)) {
          return await stub.fetch(new Request(`https://bot${tail}${url.search}`,{method:"POST",headers,body:JSON.stringify(directInput),redirect:"manual",signal:request.signal}));
        }
        const key=(action.type==="execPoll"||action.type==="execCancel")?validateOperationId(action.processId):op;
        const reservation=await registry.fetch(new Request(`https://workspace/tasks/bot-slot/${botId}?kind=direct&key=${encodeURIComponent(key)}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({payload:directInput})}));
        if(!reservation.ok)return reservation;
        const {token,shared,admissionToken,key:leaseKey}=await reservation.json<{token:string;shared?:boolean;admissionToken?:string;key?:string}>();
        const direct=new Request(`https://bot${tail}${url.search}`,{method:"POST",headers,body:JSON.stringify(directInput),redirect:"manual",signal:request.signal});
        const response=await stub.fetch(direct);
        if(shared&&admissionToken)await completeAdmission(env,botId,admissionToken);
        if(!shared&&response.ok) {
          try {
            const result=(await response.clone().json<{result:{status:string;processId?:string;checkpointStatus?:string}}>()).result;
            if(result.status==="running"&&result.processId) await registry.fetch(`https://workspace/tasks/bot-slot/${botId}/direct-process?key=${encodeURIComponent(key)}&token=${encodeURIComponent(token)}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({processId:result.processId})});
            if(["completed","failed","cancelled"].includes(result.status)&&result.checkpointStatus!=="pending") await registry.fetch(`https://workspace/tasks/bot-slot/${botId}?key=${encodeURIComponent(leaseKey??key)}&token=${encodeURIComponent(token)}`,{method:"DELETE"});
          } catch { /* An unreadable/uncertain receipt keeps the lease held. */ }
        }
        return response;
      }
      const mutation=tail==="/computer/suspend" && request.method==="POST" || tail==="/computer/live-session" && request.method==="POST" || /^\/approvals\/[^/]+$/.test(tail) && request.method==="POST";
      if(mutation) admissionToken=await beginAdmission(env,botId,`mutation:${crypto.randomUUID()}`);
      requestBodyForwarded=true;
      const response=await stub.fetch(new Request(`https://bot${tail||"/"}${url.search}`,{method:request.method,headers,body:["GET","HEAD"].includes(request.method)?undefined:request.body,redirect:"manual",signal:request.signal}));
      if(admissionToken)await completeAdmission(env,botId,admissionToken);
      return response;
    } catch(error) {return errorResponse(error);} finally {if(!requestBodyForwarded)await discardRequestBody(request);}
  },
} satisfies ExportedHandler<Env>;
