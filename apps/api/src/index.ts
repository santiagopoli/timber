import { authenticate } from "./auth";
import { ApiError, errorResponse, json } from "./errors";
import type { Env } from "./env";
import { UUID } from "./validation";
import type { Bot } from "@botspace/contracts";
export { WorkspaceDO } from "./workspace";
export { BotDO } from "./bot";
export { ChatGPTAuthDO } from "./chatgpt";
export { ComputerDO } from "@botspace/computer";

function internalRequest(request:Request,url:string):Request {
  const headers=new Headers();
  const contentType=request.headers.get("content-type");
  if(contentType) headers.set("content-type",contentType);
  return new Request(url,{method:request.method,headers,body:["GET","HEAD"].includes(request.method)?undefined:request.body,redirect:"manual"});
}
export default {
  async fetch(request:Request,env:Env):Promise<Response> {
    try {
      const url=new URL(request.url);
      if(url.pathname==="/health" && request.method==="GET") return json({ok:true,service:"botspace"});
      // Static developer console contains no account data or credentials.
      if((url.pathname==="/" || url.pathname==="/console" || url.pathname.startsWith("/console/")) && request.method==="GET") {
        if(!env.ASSETS) throw new ApiError(404,"not_found","Console not installed.");
        const assetUrl=new URL(request.url);
        if(assetUrl.pathname==="/" || assetUrl.pathname==="/console") assetUrl.pathname="/index.html";
        else assetUrl.pathname=assetUrl.pathname.slice("/console".length);
        const response=await env.ASSETS.fetch(new Request(assetUrl,request));
        const headers=new Headers(response.headers);
        headers.set("content-security-policy","default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' blob: data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
        headers.set("referrer-policy","no-referrer");
        headers.set("x-content-type-options","nosniff");
        return new Response(response.body,{status:response.status,headers});
      }
      const owner=await authenticate(request,env.BOTSPACE_API_TOKEN);
      if(!url.pathname.startsWith("/v1/")) throw new ApiError(404,"not_found","Endpoint not found.");
      if(url.pathname==="/v1/connections/chatgpt" || url.pathname==="/v1/connections/chatgpt/verify") {
        const verification=url.pathname.endsWith("/verify");
        if(verification?request.method!=="POST":!["GET","POST","DELETE"].includes(request.method)) throw new ApiError(405,"method_not_allowed","Method not allowed.");
        if(!env.CHATGPT) throw new ApiError(503,"chatgpt_not_configured","ChatGPT connections are not configured on this server.");
        const connection=env.CHATGPT.get(env.CHATGPT.idFromName(owner));
        return connection.fetch(internalRequest(request,`https://chatgpt/${verification?"verify":""}`));
      }
      const registry=env.WORKSPACE.get(env.WORKSPACE.idFromName(owner));
      if(url.pathname==="/v1/bots") {
        if(!["GET","POST"].includes(request.method)) throw new ApiError(405,"method_not_allowed","Method not allowed.");
        return registry.fetch(internalRequest(request,"https://workspace/"));
      }
      const match=/^\/v1\/bots\/([^/]+)(\/.*)?$/.exec(url.pathname);
      if(!match || !UUID.test(match[1])) throw new ApiError(404,"not_found","Bot not found.");
      const botId=match[1];
      const tail=match[2]??"";
      if(tail==="" && request.method==="PATCH") return registry.fetch(internalRequest(request,`https://workspace/${botId}`));
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
      return stub.fetch(new Request(`https://bot${tail||"/"}${url.search}`,{method:request.method,headers,body:["GET","HEAD"].includes(request.method)?undefined:request.body,redirect:"manual",signal:request.signal}));
    } catch(error) {return errorResponse(error);}
  },
} satisfies ExportedHandler<Env>;
