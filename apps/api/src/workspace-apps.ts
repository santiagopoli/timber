import { WorkerEntrypoint } from "cloudflare:workers";
import { ComputerProviderError, previewCloudComputer } from "@botspace/computer";
import type { Bot } from "@botspace/contracts";
import type { Env } from "./env";
import { ApiError, errorResponse } from "./errors";
import { object, string, UUID } from "./validation";

export interface AppReadiness {
  code:"http_error"|"computer_unavailable"|"timeout"|"connection_failed";
  httpStatus?:number;
  message:string;
}
export interface WorkspaceApp {
  id:string; botId:string; name:string; port:number; basePath:string; url:string;
  state:"ready"|"unavailable"|"stopped"; readiness?:AppReadiness; createdAt:string; updatedAt:string;
}
export interface WorkspaceAppOpen {actionUrl:string; ticket:string; expiresAt:string;}
interface Access {appId:string; expiresAt:number;}
interface Published {id:string; digest:string;}
interface Origins {previewOrigin:string; consoleOrigin:string;}

const APP="workspace-app:", OPERATION="workspace-app-operation:", TICKET="workspace-app-ticket:", SESSION="workspace-app-session:";
const TICKET_MS=60_000, SESSION_MS=60*60_000, MAX_APPS=16, MAX_ACCESS_PER_APP=16;
const COOKIE_PREFIX="__Secure-timber-app-";
const bytes=new TextEncoder();
const digest=async(value:string)=>Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes.encode(value))),b=>b.toString(16).padStart(2,"0")).join("");
const secret=()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,"0")).join("");
const cookieName=(appId:string)=>`${COOKIE_PREFIX}${appId}`;

function origin(value:string):string {
  try {const u=new URL(value);if(u.protocol==="https:" && u.origin===value) return value;} catch {}
  throw new ApiError(503,"apps_not_configured","Workspace apps are not configured.");
}
function missing():never {throw new ApiError(404,"app_not_found","This app is no longer available.");}
function httpReadiness(status:number):AppReadiness {
  const message=status===404
    ? "The app returned HTTP 404 at its registered base path. Configure the server and client router for the returned basePath, then check again."
    : status===401 || status===403
      ? `The app returned HTTP ${status}. Check its own access and allowed-host configuration; this probe already bypasses Timber's browser login.`
      : status>=500
        ? `The app preview returned HTTP ${status}. Inspect the existing server process and its log; verify the computer is running before starting another server.`
        : `The app returned HTTP ${status}. Inspect the route at the registered basePath and its server log.`;
  return {code:"http_error",httpStatus:status,message};
}
function probeFailure(error:unknown,timedOut=false):AppReadiness {
  if(timedOut || (error instanceof DOMException && error.name==="TimeoutError")) return {code:"timeout",message:"The app did not answer within five seconds. Poll the existing startup process and inspect its log before trying another server."};
  if(error instanceof ComputerProviderError) return {code:"computer_unavailable",message:"The workspace computer is not available. Check its status before starting or restarting the app."};
  return {code:"connection_failed",message:"The app preview could not connect. Verify an existing server is listening on the registered port, bound to 0.0.0.0, and inspect its log."};
}
function unavailable():Response {
  return new Response("The app is not responding. Return to its bot and ask it to start the app.",{status:503,headers:{"content-type":"text/plain; charset=utf-8","cache-control":"no-store","retry-after":"3","referrer-policy":"no-referrer"}});
}
export function parseWorkspaceApp(value:unknown):{name:string;port:number;operationId:string} {
  const data=object(value), name=string(data.name,"name",80).trim();
  if(!name) throw new ApiError(400,"invalid_request","App name cannot be blank.");
  if(typeof data.port!=="number" || !Number.isInteger(data.port) || data.port<1024 || data.port>65535 || [8080,5900,5901,6080,6081].includes(data.port)) {
    throw new ApiError(400,"invalid_request","Choose an app port from 1024 to 65535 other than the reserved control port.");
  }
  // Native tool operation IDs preserve already-admitted identities up to 160
  // characters. Do not truncate/hash an existing identity a second time here.
  if(typeof data.operationId!=="string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(data.operationId)) throw new ApiError(400,"invalid_request","Invalid app operation identity.");
  return {name,port:data.port,operationId:data.operationId};
}

/** Private browser access is owned by Timber, independently of the agent engine.
 * Publishing registers an existing app; it never executes a shell command. */
export class WorkspaceApps {
  private readonly origins:Origins;
  constructor(private readonly storage:DurableObjectStorage, private readonly computers:DurableObjectNamespace,
    private readonly botId:string, origins:Origins) {
    this.origins={previewOrigin:origin(origins.previewOrigin),consoleOrigin:origin(origins.consoleOrigin)};
    if(this.origins.previewOrigin===this.origins.consoleOrigin) throw new ApiError(503,"apps_not_configured","Workspace apps require a separate preview origin.");
    if(!UUID.test(botId)) throw new ApiError(400,"invalid_request","Invalid bot identity.");
  }

  async list():Promise<WorkspaceApp[]> {
    // A console poll must not wake a machine or keep an idle app alive.
    return [...(await this.storage.list<WorkspaceApp>({prefix:APP})).values()].sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id));
  }
  async refresh():Promise<WorkspaceApp[]> {
    // Explicit agent check. Passive UI polling uses list() above.
    return Promise.all((await this.list()).map(app=>this.probe(app)));
  }
  private async get(id:string):Promise<WorkspaceApp> {
    if(!UUID.test(id)) missing();
    const app=await this.storage.get<WorkspaceApp>(APP+id);
    if(!app || app.botId!==this.botId) missing();
    return app;
  }
  private async recordState(app:WorkspaceApp,state:WorkspaceApp["state"],readiness?:AppReadiness):Promise<WorkspaceApp> {
    return this.storage.transaction(async tx=>{
      const current=await tx.get<WorkspaceApp>(APP+app.id);
      if(!current) missing();
      if(current.state===state && JSON.stringify(current.readiness)===JSON.stringify(readiness)) return current;
      const updated={...current,state,updatedAt:new Date().toISOString()};
      if(readiness) updated.readiness=readiness;else delete updated.readiness;
      await tx.put(APP+app.id,updated);return updated;
    });
  }
  private async probe(app:WorkspaceApp):Promise<WorkspaceApp> {
    const signal=AbortSignal.timeout(5_000);
    try {
      const response=await previewCloudComputer(this.computers,this.botId,app.port,new Request(app.url,{signal}));
      await response.body?.cancel();
      const ready=response.status>=200 && response.status<400;
      return this.recordState(app,ready ? "ready":"unavailable",ready?undefined:httpReadiness(response.status));
    } catch(error) {return this.recordState(app,"unavailable",probeFailure(error,signal.aborted));}
  }

  async publish(input:unknown):Promise<WorkspaceApp> {
    const parsed=parseWorkspaceApp(input), hash=await digest(JSON.stringify({name:parsed.name,port:parsed.port}));
    const app=await this.storage.transaction(async tx=>{
      const prior=await tx.get<Published>(OPERATION+parsed.operationId);
      if(prior) {
        if(prior.digest!==hash) throw new ApiError(409,"operation_conflict","This operation was already used for a different app.");
        const existing=await tx.get<WorkspaceApp>(APP+prior.id);if(!existing) missing();return existing;
      }
      const apps=[...(await tx.list<WorkspaceApp>({prefix:APP})).values()];
      // New agent turns can rediscover an app without multiplying its cards.
      const existing=apps.find(value=>value.port===parsed.port && value.name===parsed.name);
      if(existing) {await tx.put(OPERATION+parsed.operationId,{id:existing.id,digest:hash});return existing;}
      if(apps.some(value=>value.port===parsed.port)) throw new ApiError(409,"app_port_in_use","This port already belongs to a named app.");
      if(apps.length>=MAX_APPS) throw new ApiError(409,"app_limit","Remove an unused app before adding another.");
      const id=crypto.randomUUID(), now=new Date().toISOString(), basePath=`/apps/${this.botId}.${id}/`;
      const created:WorkspaceApp={id,botId:this.botId,name:parsed.name,port:parsed.port,basePath,url:this.origins.previewOrigin+basePath,state:"unavailable",createdAt:now,updatedAt:now};
      await tx.put({[APP+id]:created,[OPERATION+parsed.operationId]:{id,digest:hash}});return created;
    });
    return this.probe(app);
  }

  async remove(id:string):Promise<{id:string;removed:true}> {
    await this.get(id);
    await this.storage.transaction(async tx=>{
      await tx.delete(APP+id);
      for(const prefix of [TICKET,SESSION]) {
        const keys=[...(await tx.list<Access>({prefix:`${prefix}${id}:`})).keys()];
        if(keys.length) await tx.delete(keys);
      }
    });
    return {id,removed:true};
  }

  async open(id:string):Promise<WorkspaceAppOpen> {
    const app=await this.probe(await this.get(id));
    const ticket=secret(), hash=await digest(ticket), expiresAt=Date.now()+TICKET_MS;
    await this.storage.transaction(async tx=>{
      if(!await tx.get(APP+id)) missing();
      await this.prune(tx,TICKET+id+":");
      await tx.put(TICKET+id+":"+hash,{appId:id,expiresAt});
    });
    return {actionUrl:app.url+"__timber_open",ticket,expiresAt:new Date(expiresAt).toISOString()};
  }

  private async prune(tx:DurableObjectTransaction,prefix:string):Promise<void> {
    const records=[...(await tx.list<Access>({prefix})).entries()].sort((a,b)=>a[1].expiresAt-b[1].expiresAt);
    const keep=records.filter(([,v])=>v.expiresAt>Date.now()).slice(-(MAX_ACCESS_PER_APP-1));
    const keepKeys=new Set(keep.map(([key])=>key)), remove=records.filter(([key])=>!keepKeys.has(key)).map(([key])=>key);
    if(remove.length) await tx.delete(remove);
  }

  /** Called only through the dedicated preview Worker service binding. */
  async preview(request:Request,id:string,publicPath:string):Promise<Response> {
    const app=await this.get(id);
    if(!publicPath.startsWith(app.basePath) || publicPath.includes("\\")) missing();
    const publicUrl=new URL(this.origins.previewOrigin+publicPath+new URL(request.url).search);
    if(publicUrl.pathname!==publicPath) missing();
    if(publicPath===app.basePath+"__timber_open") return this.exchange(request,app);
    const rawCookie=request.headers.get("cookie")??"";
    const token=rawCookie.split(";").map(value=>value.trim()).find(value=>value.startsWith(cookieName(id)+"="))?.slice(cookieName(id).length+1);
    if(!token || !/^[a-f0-9]{64}$/.test(token)) return this.accessRequired(app);
    const access=await this.storage.get<Access>(SESSION+id+":"+await digest(token));
    if(!access || access.appId!==id || access.expiresAt<=Date.now()) return this.accessRequired(app);
    // Preview code must not remain as a browser network interceptor after its
    // app grant is revoked or the workspace is deleted.
    if(request.headers.get("service-worker")==="script") return new Response("Service workers are not enabled for workspace previews.",{status:403});
    // Same-origin development app requests work; cross-site forms and sockets
    // cannot use a browser's app session to mutate the app silently.
    const requestOrigin=request.headers.get("origin");
    if(requestOrigin && requestOrigin!==this.origins.previewOrigin) return new Response("Origin not allowed.",{status:403});
    if(!requestOrigin && !["GET","HEAD","OPTIONS"].includes(request.method)) return new Response("Origin required.",{status:403});
    const headers=new Headers(request.headers);
    for(const name of [...headers.keys()]) {
      if(/^(authorization|proxy-authorization|forwarded|x-forwarded-.*|x-timber-.*|x-botspace-.*|cf-.*|host)$/i.test(name)) headers.delete(name);
    }
    const appCookies=rawCookie.split(";").map(value=>value.trim()).filter(value=>value && !value.startsWith(COOKIE_PREFIX));
    if(appCookies.length) headers.set("cookie",appCookies.join("; "));else headers.delete("cookie");
    headers.set("x-forwarded-host",publicUrl.host);headers.set("x-forwarded-proto","https");
    const forwarded=new Request(publicUrl,{method:request.method,headers,body:["GET","HEAD"].includes(request.method)?undefined:request.body,redirect:"manual",signal:request.signal});
    let response:Response;
    try {response=await previewCloudComputer(this.computers,this.botId,app.port,forwarded);}
    catch(error) {await this.recordState(app,"unavailable",probeFailure(error));return unavailable();}
    if(response.status===503) {await response.body?.cancel();await this.recordState(app,"unavailable",httpReadiness(503));return unavailable();}
    // A missing asset must not override the root readiness observation.
    // A root response, however, follows the same 2xx/3xx rule as agent probes.
    if(publicUrl.pathname===app.basePath) {
      const ready=response.status>=200 && response.status<400;
      await this.recordState(app,ready?"ready":"unavailable",ready?undefined:httpReadiness(response.status));
    }
    return appResponse(response,app);
  }

  private accessRequired(app:WorkspaceApp):Response {
    // A copied stable app URL contains no bearer credentials. Authorize this
    // browser using the authenticated “Open app” action in the bot's Apps list.
    const consoleUrl=this.origins.consoleOrigin+"/console/";
    return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Open app · Timber</title><h1>Open this app from Timber</h1><p>This browser needs access. Return to the bot and choose Open app.</p><a href="${consoleUrl}">Open Timber</a>`,{status:401,headers:{"content-type":"text/html; charset=utf-8","cache-control":"no-store","content-security-policy":"default-src 'none'; frame-ancestors 'none'; base-uri 'none'","referrer-policy":"no-referrer","x-content-type-options":"nosniff"}});
  }

  private async exchange(request:Request,app:WorkspaceApp):Promise<Response> {
    if(request.method!=="POST") throw new ApiError(405,"method_not_allowed","Open this app from Timber.");
    if(request.headers.get("origin")!==this.origins.consoleOrigin) throw new ApiError(403,"invalid_origin","Open this app from Timber.");
    if(!request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) throw new ApiError(400,"invalid_request","Invalid app access request.");
    const reader=request.body?.getReader();let body="", size=0;
    if(reader) while(true) {const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>256){await reader.cancel();throw new ApiError(413,"body_too_large","Invalid app access request.");}body+=new TextDecoder().decode(next.value);}
    const ticket=new URLSearchParams(body).get("ticket");
    if(!ticket || !/^[a-f0-9]{64}$/.test(ticket)) throw new ApiError(401,"invalid_app_ticket","App access expired. Open the app again from Timber.");
    const key=TICKET+app.id+":"+await digest(ticket), token=secret(), sessionKey=SESSION+app.id+":"+await digest(token), expiresAt=Date.now()+SESSION_MS;
    await this.storage.transaction(async tx=>{
      if(!await tx.get(APP+app.id)) missing();
      const pending=await tx.get<Access>(key);
      if(!pending || pending.appId!==app.id || pending.expiresAt<=Date.now()) throw new ApiError(401,"invalid_app_ticket","App access expired. Open the app again from Timber.");
      await tx.delete(key);await this.prune(tx,SESSION+app.id+":");await tx.put(sessionKey,{appId:app.id,expiresAt});
    });
    return new Response(null,{status:303,headers:{location:app.url,"set-cookie":`${cookieName(app.id)}=${token}; Path=${app.basePath}; Max-Age=${SESSION_MS/1000}; HttpOnly; Secure; SameSite=Lax`,"cache-control":"no-store","referrer-policy":"no-referrer"}});
  }
}

function appResponse(response:Response,app:WorkspaceApp):Response {
  const headers=new Headers(response.headers);
  // Keep same-origin HTML forms usable while suppressing cross-origin referrers.
  // no-referrer also turns their Origin header into null and fails our CSRF gate.
  headers.set("cache-control","private, no-store");headers.set("referrer-policy","same-origin");headers.set("x-robots-tag","noindex, nofollow");
  headers.delete("access-control-allow-origin");headers.delete("access-control-allow-credentials");headers.delete("service-worker-allowed");
  const cookies=response.headers.getSetCookie();headers.delete("set-cookie");
  for(const cookie of cookies) {
    const parts=cookie.split(";").map(value=>value.trim());
    if(!parts[0] || parts[0].startsWith(COOKIE_PREFIX)) continue;
    const attributes=parts.slice(1).filter(value=>!/^(domain|path)=/i.test(value));
    headers.append("set-cookie",[parts[0],...attributes,`Path=${app.basePath}`,"Secure"].join("; "));
  }
  const location=headers.get("location");
  if(location) {
    try {
      const target=new URL(location,app.url);
      if(["127.0.0.1","localhost","computer"].includes(target.hostname) || target.origin===new URL(app.url).origin) {
        const suffix=target.pathname.startsWith(app.basePath)?target.pathname:app.basePath+target.pathname.replace(/^\/+/g,"");
        headers.set("location",new URL(suffix+target.search+target.hash,app.url).href);
      }
    } catch {headers.delete("location");}
  }
  return new Response(response.body,{status:response.status,statusText:response.statusText,headers,...(response.webSocket?{webSocket:response.webSocket}:{})});
}

/** A service entrypoint cannot be reached by sending a special public HTTP
 * header. Only the separately deployed preview Worker is bound to this class. */
export class WorkspacePreviewGateway extends WorkerEntrypoint<Env> {
  async fetch(request:Request):Promise<Response> {
    try {
      const url=new URL(request.url), configured=origin(this.env.PREVIEW_ORIGIN??"");
      if(url.origin!==configured) missing();
      const match=/^\/apps\/([0-9a-f-]{36})\.([0-9a-f-]{36})(\/.*)?$/i.exec(url.pathname);
      if(!match || !UUID.test(match[1]) || !UUID.test(match[2])) missing();
      const [,botId,appId]=match;
      const registry=this.env.WORKSPACE.get(this.env.WORKSPACE.idFromName("owner"));
      const record=await registry.fetch(`https://workspace/${botId}`);
      if(!record.ok) missing();
      const {bot}=await record.json<{bot:Bot}>();
      const headers=new Headers(request.headers);
      headers.set("x-botspace-config",encodeURIComponent(JSON.stringify(bot)));
      headers.set("x-timber-preview-path",url.pathname);
      const target=`https://bot/workspace-app-preview/${appId}${url.search}`;
      const stub=this.env.BOT.get(this.env.BOT.idFromName(`owner:${botId}`));
      return await stub.fetch(new Request(target,{method:request.method,headers,body:["GET","HEAD"].includes(request.method)?undefined:request.body,redirect:"manual",signal:request.signal}));
    } catch(error) {return errorResponse(error);}
  }
}
