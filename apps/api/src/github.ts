import { DurableObject } from "cloudflare:workers";
import { createPrivateKey } from "node:crypto";
import { importPKCS8, SignJWT } from "jose";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Env } from "./env";
import { ApiError, errorResponse, json } from "./errors";
import { body, string } from "./validation";

type Permission = "read" | "write";
interface Scope { botId:string; repository:string; permission:Permission; }
interface ConnectionScope { botId:string; repository?:string; permission:Permission; }
interface Flow { botId?:string; repository?:string; permission:Permission; requestId?:string; origin:string; state:string; expiresAt:number; stage:"new"|"manifest"|"install"|"oauth"|"complete"; installationId?:number; }
interface App { id:number; slug:string; clientId:string; clientSecret:string; pem:string; ownerId:number; }
interface UserToken { accessToken:string; refreshToken?:string; expiresAt:number; }
interface Credentials { app:App; user?:UserToken; }
interface Ciphertext { iv:string; ciphertext:string; }
interface Connection { account?:{login:string; id:number}; app:{id:number; slug:string}; revision:string; connected:boolean; installationId?:number; permissions?:{contents?:Permission;pull_requests?:Permission}; repositorySelection?:"all"|"selected"; }
interface Grant extends Scope { installationId:number; revision:string; }
interface Capability extends Grant { id:string; expiresAt:number; origin:string; }
interface GitHubPR { number:number; html_url:string; title:string; state:string; body?:string; head?:{ref:string}; base?:{ref:string}; }
interface Operation { botId:string; fingerprint:string; status:"started"|"completed"|"interrupted"; result?:unknown; }
const API="https://api.github.com", GITHUB="https://github.com", MCP="https://api.githubcopilot.com/mcp/";
const encoder=new TextEncoder();
const FLOW_TTL=30*60_000;
function encode(value:Uint8Array):string {return btoa(String.fromCharCode(...value));}
function decode(value:string):Uint8Array {return Uint8Array.from(atob(value),x=>x.charCodeAt(0));}
function random():string {return Array.from(crypto.getRandomValues(new Uint8Array(32)),x=>x.toString(16).padStart(2,"0")).join("");}
async function hash(value:string):Promise<string> {return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",encoder.encode(value))),x=>x.toString(16).padStart(2,"0")).join("");}
function repository(value:unknown):string {
  if(typeof value!=="string" || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]{1,100}$/.test(value) || value.endsWith("/.") || value.endsWith("/..")) throw new ApiError(400,"invalid_repository","Use a GitHub repository in owner/repository form.");
  return value.toLowerCase();
}
function permission(value:unknown):Permission {if(value!=="read" && value!=="write") throw new ApiError(400,"invalid_permission","GitHub access must be read or write.");return value;}
function scope(value:Record<string,unknown>):Scope {
  const botId=string(value.botId,"botId",64);
  if(!/^[0-9a-f-]{36}$/i.test(botId)) throw new ApiError(400,"invalid_bot","Invalid bot identity.");
  return {botId,repository:repository(value.repository),permission:permission(value.permission)};
}
function connectionScope(value:Record<string,unknown>):ConnectionScope {
  if(value.repository!==undefined) return scope({...value,permission:value.permission??"read"});
  const botId=string(value.botId,"botId",64);
  if(!/^[0-9a-f-]{36}$/i.test(botId)) throw new ApiError(400,"invalid_bot","Invalid bot identity.");
  // The provider installation is the account-wide permission boundary.
  if(value.permission!==undefined) permission(value.permission);
  return {botId,permission:"read"};
}
function escapes(value:string):string {return value.replace(/[&<>"']/g,x=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[x]!);}
function page(title:string,content:string,status=200,headers:HeadersInit={}):Response {
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapes(title)} · Timber</title><body><main><h1>${escapes(title)}</h1>${content}</main></body></html>`,{status,headers:{"content-type":"text/html; charset=utf-8","cache-control":"no-store","referrer-policy":"no-referrer","x-content-type-options":"nosniff","content-security-policy":"default-src 'none'; form-action https://github.com; base-uri 'none'; frame-ancestors 'none'",...headers}});
}
function redirect(url:string,cookie?:string):Response {return new Response(null,{status:303,headers:{location:url,"cache-control":"no-store","referrer-policy":"no-referrer",...(cookie?{"set-cookie":cookie}:{})}});}
function cookie(state:string,maxAge=1800):string {return `__Host-timber-github=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;}
function safePR(value:GitHubPR):Record<string,unknown> {return {number:value.number,url:value.html_url,title:value.title,state:value.state,head:value.head?.ref,base:value.base?.ref};}
function branch(value:unknown,name:string):string {
  const result=string(value,name,200);
  if(!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(result) || result.includes("..") || result.includes("//") || result.endsWith("/") || result.endsWith(".") || result.endsWith(".lock")) throw new ApiError(400,"invalid_branch",`Invalid ${name} branch.`);
  return result;
}

/** Owns account credentials, repository grants and provider transports. Nothing can read credentials. */
export class GitHubAuthDO extends DurableObject<Env> {
  private serial:Promise<unknown>=Promise.resolve();
  private key?:CryptoKey;
  private context="";
  constructor(ctx:DurableObjectState,env:Env) {
    super(ctx,env);
    ctx.blockConcurrencyWhile(async()=>{this.context=await ctx.storage.get<string>("context")??`timber:github:${crypto.randomUUID()}`;await ctx.storage.put("context",this.context);});
  }
  private lock<T>(fn:()=>Promise<T>):Promise<T> {const next=this.serial.then(fn,fn);this.serial=next.catch(()=>{});return next;}
  private async alarmAt(timestamp:number):Promise<void> {
    const existing=await this.ctx.storage.getAlarm();
    if(existing===null || existing>timestamp) await this.ctx.storage.setAlarm(timestamp);
  }
  private async encryptionKey():Promise<CryptoKey> {
    if(this.key) return this.key;
    const value=this.env.CHATGPT_CREDENTIAL_KEY;
    if(!value || !/^[a-f0-9]{64}$/i.test(value)) throw new ApiError(503,"github_not_configured","GitHub credential encryption is not configured.");
    return this.key=await crypto.subtle.importKey("raw",Uint8Array.from(value.match(/../g)!,x=>parseInt(x,16)),"AES-GCM",false,["encrypt","decrypt"]);
  }
  private async save(credentials:Credentials):Promise<void> {
    const iv=crypto.getRandomValues(new Uint8Array(12));
    const ciphertext=await crypto.subtle.encrypt({name:"AES-GCM",iv,additionalData:encoder.encode(this.context)},await this.encryptionKey(),encoder.encode(JSON.stringify(credentials)));
    await this.ctx.storage.put("credentials",{iv:encode(iv),ciphertext:encode(new Uint8Array(ciphertext))});
  }
  private async credentials():Promise<Credentials> {
    const value=await this.ctx.storage.get<Ciphertext>("credentials");
    if(!value) throw new ApiError(409,"github_not_connected","Connect GitHub to give this bot access to the repository.");
    const clear=await crypto.subtle.decrypt({name:"AES-GCM",iv:decode(value.iv),additionalData:encoder.encode(this.context)},await this.encryptionKey(),decode(value.ciphertext));
    return JSON.parse(new TextDecoder().decode(clear)) as Credentials;
  }
  private async status():Promise<Response> {
    const connection=await this.ctx.storage.get<Connection>("connection");
    return json({provider:"github",connected:connection?.connected??false,...(connection?{account:connection.account?{id:connection.account.id,login:connection.account.login}:undefined,app:connection.app,repositorySelection:connection.repositorySelection,permissions:connection.permissions}:{} )});
  }
  private origin(value:unknown):string {
    const configured=(this.env as Env & {GITHUB_PUBLIC_ORIGIN?:string}).GITHUB_PUBLIC_ORIGIN;
    if(!configured || value!==configured || new URL(configured).origin!==configured || !configured.startsWith("https://")) throw new ApiError(503,"github_origin_not_configured","The GitHub callback origin has not been configured.");
    return configured;
  }
  private async api(path:string,token:string,method="GET",payload?:unknown):Promise<Response> {
    const response=await fetch(`${API}${path}`,{method,headers:{authorization:`Bearer ${token}`,accept:"application/vnd.github+json","x-github-api-version":"2022-11-28","user-agent":"Timber/0.1","content-type":"application/json"},...(payload!==undefined?{body:JSON.stringify(payload)}:{}),redirect:"manual",signal:AbortSignal.timeout(20_000)});
    if(!response.ok) {await response.body?.cancel();throw new ApiError(response.status===401?401:response.status===403?403:response.status===404?404:502,"github_request_failed",response.status===401?"GitHub access expired or was revoked. Connect GitHub again.":response.status===403?"GitHub did not allow this repository operation.":"GitHub could not complete this request.");}
    return response;
  }
  private async appJWT(app:App):Promise<string> {
    // GitHub returns PKCS#1; jose consumes PKCS#8. The PEM stays inside this DO.
    const pem=createPrivateKey(app.pem).export({format:"pem",type:"pkcs8"}).toString();
    const key=await importPKCS8(pem,"RS256");
    return new SignJWT({}).setProtectedHeader({alg:"RS256"}).setIssuer(String(app.id)).setIssuedAt(Math.floor(Date.now()/1000)-30).setExpirationTime(Math.floor(Date.now()/1000)+540).sign(key);
  }
  private async userToken():Promise<string> {
    const credentials=await this.credentials();
    if(!credentials.user) throw new ApiError(409,"github_not_connected","Complete GitHub authorization first.");
    if(credentials.user.expiresAt>Date.now()+60_000) return credentials.user.accessToken;
    if(!credentials.user.refreshToken) throw new ApiError(401,"github_reauthorization_required","Connect GitHub again to renew access.");
    credentials.user=await this.oauthToken(credentials.app,{grant_type:"refresh_token",refresh_token:credentials.user.refreshToken});
    await this.save(credentials);return credentials.user.accessToken;
  }
  private async oauthToken(app:App,fields:Record<string,string>):Promise<UserToken> {
    const response=await fetch(`${GITHUB}/login/oauth/access_token`,{method:"POST",headers:{accept:"application/json","content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({client_id:app.clientId,client_secret:app.clientSecret,...fields}),redirect:"manual",signal:AbortSignal.timeout(20_000)});
    const data=await response.json<Record<string,unknown>>().catch(()=>({} as Record<string,unknown>));
    if(!response.ok || typeof data.access_token!=="string" || data.error) throw new ApiError(401,"github_authorization_failed","GitHub authorization failed. Start a new connection.");
    return {accessToken:data.access_token,...(typeof data.refresh_token==="string"?{refreshToken:data.refresh_token}:{}),expiresAt:typeof data.expires_in==="number"?Date.now()+data.expires_in*1000:Number.MAX_SAFE_INTEGER};
  }
  private async connectedInstallation():Promise<Connection|undefined> {
    let connection=await this.ctx.storage.get<Connection>("connection");
    if(!connection?.connected) return undefined;
    // Older versions recorded the verified installation on a per-bot grant.
    // Recover that evidence and reverify it with GitHub without another OAuth.
    if(!connection.installationId) {
      const grants=await this.ctx.storage.list<Grant>({prefix:"grant:"});
      const legacy=[...grants.values()].find(grant=>grant.revision===connection!.revision);
      const {app}=await this.credentials();
      let installationId=legacy?.installationId;
      if(!installationId) {
        const token=await this.userToken();
        for(let page=1;page<=10 && !installationId;page++) {
          const list=await (await this.api(`/user/installations?per_page=100&page=${page}`,token)).json<{installations:{id:number;app_id:number;account?:{id:number};suspended_at?:unknown}[]}>();
          installationId=list.installations.find(item=>item.app_id===app.id && item.account?.id===connection!.account?.id && !item.suspended_at)?.id;
          if(list.installations.length<100) break;
        }
      }
      if(!installationId) return undefined;
      const installation=await (await this.api(`/app/installations/${installationId}`,await this.appJWT(app))).json<{app_id:number;suspended_at:unknown;permissions:Connection["permissions"];repository_selection:Connection["repositorySelection"]}>();
      if(installation.app_id!==app.id || installation.suspended_at) return undefined;
      const latest=await this.ctx.storage.get<Connection>("connection");
      if(!latest?.connected || latest.revision!==connection.revision) return undefined;
      connection={...connection,installationId,permissions:installation.permissions,repositorySelection:installation.repository_selection};
      await this.ctx.storage.put("connection",connection);
    }
    return connection;
  }
  private async grant(value:Scope):Promise<Grant|undefined> {
    const connection=await this.connectedInstallation();
    if(!connection?.installationId || await this.ctx.storage.get(`deleted:${value.botId}`)) return undefined;
    const {app}=await this.credentials();
    let installation:{id:number;app_id:number;suspended_at:unknown;permissions:Connection["permissions"]};
    // Resolve every repository against GitHub's current All/selected installation.
    // The owner connection is shared by bots; the token remains repository-narrow.
    try {installation=await (await this.api(`/repos/${value.repository}/installation`,await this.appJWT(app))).json<typeof installation>();}
    catch(error) {if(error instanceof ApiError && [403,404].includes(error.status)) return undefined;throw error;}
    if(installation.id!==connection.installationId || installation.app_id!==app.id || installation.suspended_at) return undefined;
    const actual=installation.permissions?.contents;
    if(actual!=="write" && (value.permission==="write" || actual!=="read")) return undefined;
    const latest=await this.ctx.storage.get<Connection>("connection");
    if(!latest?.connected || latest.revision!==connection.revision || await this.ctx.storage.get(`deleted:${value.botId}`)) return undefined;
    return {...value,installationId:connection.installationId,revision:connection.revision};
  }
  private async repositories(request:Request):Promise<Response> {
    const input=await body(request),access=connectionScope(input),connection=await this.connectedInstallation();
    if(await this.ctx.storage.get(`deleted:${access.botId}`)) throw new ApiError(410,"bot_deleted","This bot was deleted.");
    if(!connection?.installationId) throw new ApiError(403,"github_account_access_required","Connect GitHub to your Timber account before listing repositories.");
    const page=input.page??1;
    if(typeof page!=="number" || !Number.isSafeInteger(page) || page<1 || page>10000) throw new ApiError(400,"invalid_page","Repository page must be an integer from 1 to 10000.");
    const data=await (await this.api(`/user/installations/${connection.installationId}/repositories?per_page=100&page=${page}`,await this.userToken())).json<{total_count:number;repositories:{id:number;full_name:string;name:string;private:boolean;html_url:string;default_branch:string;description:string|null}[]}>();
    const latest=await this.ctx.storage.get<Connection>("connection");
    if(!latest?.connected || latest.revision!==connection.revision || await this.ctx.storage.get(`deleted:${access.botId}`)) throw new ApiError(403,"github_access_revoked","GitHub access was disconnected while loading repositories.");
    if(!Array.isArray(data.repositories)) throw new ApiError(502,"github_invalid_response","GitHub did not return a repository list.");
    const repositories=data.repositories.slice(0,100).map(repo=>({id:repo.id,repository:repo.full_name,name:repo.name,private:repo.private,url:repo.html_url,defaultBranch:repo.default_branch,description:repo.description?.slice(0,500)??null}));
    return json({repositories,page,totalCount:data.total_count,nextPage:page*100<data.total_count && page<10000?page+1:null,scope:"Repositories selected in this GitHub installation; All bots use the permissions and repository selection authorized in GitHub."});
  }
  private async requireGrant(value:Scope):Promise<Grant> {const grant=await this.grant(value);if(!grant) throw new ApiError(403,"github_access_required","This repository or permission is not available through the Timber account’s GitHub integration. Check the repository selection and permissions in GitHub.");return grant;}
  private async installationToken(grant:Grant):Promise<string> {
    const {app}=await this.credentials();
    const data=await (await this.api(`/app/installations/${grant.installationId}/access_tokens`,await this.appJWT(app),"POST",{repositories:[grant.repository.split("/")[1]],permissions:{contents:grant.permission,pull_requests:grant.permission,metadata:"read"}})).json<{token:string}>();
    if(typeof data.token!=="string") throw new ApiError(502,"github_token_failed","GitHub did not issue repository access.");
    return data.token;
  }
  private async notify(flow:Flow):Promise<boolean> {
    if(!flow.botId || !flow.requestId || await this.ctx.storage.get(`deleted:${flow.botId}`)) return true;
    const response=await this.env.BOT.get(this.env.BOT.idFromName(`owner:${flow.botId}`)).fetch(`https://bot/connections/${encodeURIComponent(flow.requestId)}/complete`,{method:"POST",headers:{"content-type":"application/json","x-timber-internal":"github"},body:JSON.stringify({provider:"github",repository:flow.repository,permission:flow.permission})});
    await response.body?.cancel();return response.ok || response.status===404 || response.status===410;
  }
  private async reconcileWaitingBots():Promise<void> {
    const waiting=await this.ctx.storage.list<{botId:string}>({prefix:"waiting-bot:",limit:100});
    for(const [key,{botId}] of waiting) {
      try {
        const response=await this.env.BOT.get(this.env.BOT.idFromName(`owner:${botId}`)).fetch("https://bot/connections/reconcile",{method:"POST",headers:{"x-timber-internal":"github"}});
        if(response.status===404 || response.status===410) {await response.body?.cancel();await this.ctx.storage.delete(key);continue;}
        if(response.ok) {const data=await response.json<{pending:number}>();if(data.pending===0) await this.ctx.storage.delete(key);}
        else await response.body?.cancel();
      } catch { /* Recovery and the alarm retry transient provider failures. */ }
    }
    if((await this.ctx.storage.list({prefix:"waiting-bot:",limit:1})).size) await this.alarmAt(Date.now()+30_000);
  }
  private async complete(flow:Flow,installationId:number,account:{id:number;login:string},installation:{permissions:Connection["permissions"];repository_selection:Connection["repositorySelection"]}):Promise<Response> {
    const connection=(await this.ctx.storage.get<Connection>("connection"))!;
    connection.connected=true;connection.account={id:account.id,login:account.login};connection.installationId=installationId;connection.permissions=installation.permissions;connection.repositorySelection=installation.repository_selection;
    flow.stage="complete";
    // Integration belongs to the Timber owner, even when setup started from a bot
    // that was cancelled or deleted while the provider consent page was open.
    await this.ctx.storage.put({connection,[`flow:${flow.state}`]:flow,...(flow.botId && flow.requestId?{[`notify:${flow.state}`]:flow}:{})});
    if(flow.botId && flow.requestId) {
      if(await this.notify(flow).catch(()=>false)) await this.ctx.storage.delete(`notify:${flow.state}`);
      else await this.alarmAt(Date.now()+5_000);
    }
    this.ctx.waitUntil(this.reconcileWaitingBots());
    return page("GitHub connected",`<p>GitHub is now connected to your Timber account. Your bots can use the repositories and permissions you authorized in GitHub.</p><p>${flow.botId?"Timber will resume the originating task if it is still active. ":""}You can close this tab and return to Timber.</p><p><a href="${escapes(`${flow.origin}/console/`)}">Open Timber</a></p>`,200,{"set-cookie":cookie("",0)});
  }
  private async startConnection(request:Request):Promise<Response> {
    const input=await body(request),origin=this.origin(input.origin);
    const access=input.botId===undefined?{permission:"read" as const}:{...connectionScope(input),requestId:string(input.requestId,"requestId",160)};
    await this.encryptionKey();
    // Owner approval is explicit here. A bot cannot call this internal endpoint.
    const flow:Flow={...access,origin,state:random(),expiresAt:Date.now()+FLOW_TTL,stage:"new"};
    await this.ctx.storage.put(`flow:${flow.state}`,flow);
    await this.alarmAt(Date.now()+FLOW_TTL);
    return json({url:`${origin}/github/setup/start?state=${flow.state}`,connected:false});
  }
  private async flow(request:Request,checkCookie=true):Promise<Flow> {
    const state=new URL(request.url).searchParams.get("state");
    if(!state || !/^[a-f0-9]{64}$/.test(state)) throw new ApiError(400,"github_invalid_state","This GitHub connection link is invalid. Start again in Timber.");
    const flow=await this.ctx.storage.get<Flow>(`flow:${state}`);
    if(!flow || flow.expiresAt<Date.now() || flow.stage==="complete") throw new ApiError(409,"github_expired_state","This GitHub connection link expired or was already used. Start again in Timber.");
    if(checkCookie && !(request.headers.get("cookie")??"").split(";").map(x=>x.trim()).includes(`__Host-timber-github=${state}`)) throw new ApiError(403,"github_browser_mismatch","Finish GitHub authorization in the browser that started the connection.");
    return flow;
  }
  private async setup(request:Request):Promise<Response> {
    const url=new URL(request.url),flow=await this.flow(request,url.pathname!=="/github/setup/start");
    if(url.pathname==="/github/setup/start") {
      const connection=await this.ctx.storage.get<Connection>("connection");
      if(connection) {flow.stage="install";await this.ctx.storage.put(`flow:${flow.state}`,flow);return redirect(`${GITHUB}/apps/${encodeURIComponent(connection.app.slug)}/installations/new?state=${flow.state}`,cookie(flow.state));}
      if(flow.stage!=="new") throw new ApiError(409,"github_setup_in_progress","A GitHub registration is already in progress.");
      flow.stage="manifest";await this.ctx.storage.put(`flow:${flow.state}`,flow);
      const manifest={name:`Timber ${flow.state.slice(0,8)}`,url:flow.origin,public:false,description:"Timber account integration: authorized repository development and pull requests.",redirect_url:`${flow.origin}/github/setup/manifest`,setup_url:`${flow.origin}/github/setup/install`,callback_urls:[`${flow.origin}/github/setup/oauth`],setup_on_update:true,request_oauth_on_install:false,hook_attributes:{url:`${flow.origin}/github/webhook`,active:false},default_permissions:{contents:"write",pull_requests:"write",metadata:"read"},default_events:[]};
      return page("Connect GitHub",`<p>Create your private Timber GitHub App, then select the repositories it may access. Connect GitHub to your Timber account. Choose selected repositories or all repositories in GitHub; your bots will use the access you authorize.${flow.repository?` This task requested <strong>${escapes(flow.repository)}</strong>.`:""}</p><form method="post" action="https://github.com/settings/apps/new?state=${flow.state}"><input type="hidden" name="manifest" value="${escapes(JSON.stringify(manifest))}"><button type="submit">Continue to GitHub</button></form>`,200,{"set-cookie":cookie(flow.state)});
    }
    if(url.pathname==="/github/setup/manifest") {
      if(flow.stage!=="manifest" || await this.ctx.storage.get("credentials")) throw new ApiError(409,"github_setup_used","This registration has already been handled.");
      const code=url.searchParams.get("code");if(!code || !/^[A-Za-z0-9_-]{10,200}$/.test(code)) throw new ApiError(400,"github_invalid_code","GitHub did not return a valid registration code.");
      // Consume before exchange: an uncertain exchange must never create a second App.
      flow.stage="install";await this.ctx.storage.put(`flow:${flow.state}`,flow);
      const response=await fetch(`${API}/app-manifests/${code}/conversions`,{method:"POST",headers:{accept:"application/vnd.github+json","user-agent":"Timber/0.1"},redirect:"manual",signal:AbortSignal.timeout(20_000)});
      const data=await response.json<{id:number;slug:string;client_id:string;client_secret:string;pem:string;owner:{id:number}}>();
      if(!response.ok || !Number.isSafeInteger(data.id) || !/^[A-Za-z0-9-]+$/.test(data.slug) || !data.client_id || !data.client_secret || !data.pem || !Number.isSafeInteger(data.owner?.id)) throw new ApiError(502,"github_manifest_failed","GitHub registration could not be completed. Start a new connection.");
      const app:App={id:data.id,slug:data.slug,clientId:data.client_id,clientSecret:data.client_secret,pem:data.pem,ownerId:data.owner.id};
      await this.save({app});await this.ctx.storage.put("connection",{app:{id:app.id,slug:app.slug},revision:random(),connected:false} satisfies Connection);
      return redirect(`${GITHUB}/apps/${app.slug}/installations/new?state=${flow.state}`);
    }
    if(url.pathname==="/github/setup/install") {
      if(flow.stage!=="install") throw new ApiError(409,"github_setup_used","This installation callback has already been handled.");
      const installationId=Number(url.searchParams.get("installation_id"));
      if(!Number.isSafeInteger(installationId) || installationId<1) throw new ApiError(400,"github_invalid_installation","GitHub did not return a valid installation.");
      const {app}=await this.credentials();
      flow.installationId=installationId;flow.stage="oauth";await this.ctx.storage.put(`flow:${flow.state}`,flow);
      return redirect(`${GITHUB}/login/oauth/authorize?${new URLSearchParams({client_id:app.clientId,redirect_uri:`${flow.origin}/github/setup/oauth`,state:flow.state})}`);
    }
    if(url.pathname==="/github/setup/oauth") {
      if(flow.stage!=="oauth" || !flow.installationId) throw new ApiError(409,"github_setup_used","This authorization callback has already been handled.");
      const code=url.searchParams.get("code");if(!code || !/^[A-Za-z0-9_-]{10,200}$/.test(code)) throw new ApiError(400,"github_invalid_code","GitHub authorization was not completed.");
      const credentials=await this.credentials();
      const user=await this.oauthToken(credentials.app,{code,redirect_uri:`${flow.origin}/github/setup/oauth`});
      const account=await (await this.api("/user",user.accessToken)).json<{id:number;login:string}>();
      if(account.id!==credentials.app.ownerId) throw new ApiError(403,"github_account_mismatch","Authorize with the GitHub account that owns this private Timber App.");
      // Do not trust the installation_id callback. Verify authenticated user membership,
      // this exact App and repository access through GitHub before granting anything.
      const installation=await (await this.api(`/app/installations/${flow.installationId}`,await this.appJWT(credentials.app))).json<{app_id:number;suspended_at:unknown;permissions:Connection["permissions"];repository_selection:Connection["repositorySelection"]}>();
      if(installation.app_id!==credentials.app.id || installation.suspended_at) throw new ApiError(403,"github_installation_mismatch","This installation is not active for the Timber App.");
      let found=false;
      for(let page=1;page<=10 && !found;page++) {
        const list=await (await this.api(`/user/installations?per_page=100&page=${page}`,user.accessToken)).json<{installations:{id:number;app_id:number}[]}>();
        found=list.installations.some(item=>item.id===flow.installationId && item.app_id===credentials.app.id);
        if(list.installations.length<100) break;
      }
      if(!found) throw new ApiError(403,"github_installation_mismatch","The GitHub installation does not belong to this authorized account.");
      credentials.user=user;await this.save(credentials);
      return this.complete(flow,flow.installationId,account,installation);
    }
    throw new ApiError(404,"not_found","GitHub setup endpoint not found.");
  }
  private async capability(request:Request):Promise<Response> {
    const input=await body(request),access=scope(input),grant=await this.requireGrant(access),origin=this.origin(input.origin??(this.env as Env & {GITHUB_PUBLIC_ORIGIN?:string}).GITHUB_PUBLIC_ORIGIN);
    const token=random(),id=await hash(token),cap:Capability={...grant,permission:access.permission,id,origin,expiresAt:Date.now()+5*60_000};
    await this.ctx.storage.put(`cap:${id}`,cap);await this.alarmAt(Date.now()+5*60_000);
    return json({id,token,url:`${origin}/github/git/${access.repository}.git`});
  }
  private async git(request:Request):Promise<Response> {
    const url=new URL(request.url),match=/^\/github\/git\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(url.pathname);
    const token=request.headers.get("authorization")?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
    if(!token || !match) throw new ApiError(401,"github_transport_unauthorized","Repository transport authorization is required.");
    const cap=await this.ctx.storage.get<Capability>(`cap:${await hash(token)}`);
    if(!cap || cap.expiresAt<Date.now() || repository(`${match[1]}/${match[2]}`)!==cap.repository || !(await this.grant(cap))) throw new ApiError(403,"github_transport_denied","Repository transport access expired or was revoked.");
    const endpoint=match[3],service=url.searchParams.get("service");
    if(endpoint==="info/refs" ? request.method!=="GET" || !["git-upload-pack","git-receive-pack"].includes(service??"") || [...url.searchParams.keys()].length!==1 || [...url.searchParams.keys()].some(key=>key!=="service") : request.method!=="POST" || url.search) throw new ApiError(400,"github_transport_invalid","Invalid repository transport request.");
    const write=endpoint==="git-receive-pack" || service==="git-receive-pack";
    if(write && cap.permission!=="write") throw new ApiError(403,"github_transport_read_only","This repository transport permits cloning only.");
    const installToken=await this.installationToken({...cap,permission:write?"write":"read"});
    const headers=new Headers({authorization:`Basic ${btoa(`x-access-token:${installToken}`)}`,"user-agent":"Timber/0.1"});
    for(const key of ["content-type","accept","git-protocol"]) {const value=request.headers.get(key);if(value) headers.set(key,value);}
    const response=await fetch(`${GITHUB}/${cap.repository}.git/${endpoint}${url.search}`,{method:request.method,headers,body:request.body,redirect:"manual",signal:request.signal});
    // Credentials and upstream redirect targets never escape the transport host.
    if(!response.ok) {await response.body?.cancel();throw new ApiError(response.status===401 || response.status===403?403:response.status===404?404:502,"github_transport_failed","GitHub could not complete the repository transfer.");}
    const out=new Headers({"cache-control":"no-store","x-content-type-options":"nosniff"});for(const key of ["content-type","content-encoding"]) {const value=response.headers.get(key);if(value) out.set(key,value);}
    return new Response(response.body,{status:response.status,headers:out});
  }
  private async callMCP(token:string,name:string,args:Record<string,unknown>):Promise<void> {
    const client=new Client({name:"timber",version:"0.1.0"});
    const transport=new StreamableHTTPClientTransport(new URL(MCP),{requestInit:{headers:{authorization:`Bearer ${token}`,"X-MCP-Tools":"create_pull_request,pull_request_read,list_pull_requests"},redirect:"manual"},fetch:async(input,init)=>{
      const target=new URL(typeof input==="string"?input:input.href);
      if(target.href!==MCP) throw new Error("Unexpected MCP destination");
      return fetch(input,{...init,redirect:"manual",signal:AbortSignal.any([...(init?.signal?[init.signal]:[]),AbortSignal.timeout(30_000)])});
    },reconnectionOptions:{maxRetries:0,initialReconnectionDelay:1000,maxReconnectionDelay:1000,reconnectionDelayGrowFactor:1}});
    try {await client.connect(transport);const result=await client.callTool({name,arguments:args},undefined,{timeout:30_000});if(result.isError) throw new ApiError(502,"github_mcp_failed","GitHub MCP could not complete the requested operation.");}
    finally {await client.close().catch(()=>{});}
  }
  private async reconcile(repository:string,head:string,base:string,marker:string,token:string):Promise<Record<string,unknown>|undefined> {
    const owner=repository.split("/")[0];
    const list=await (await this.api(`/repos/${repository}/pulls?${new URLSearchParams({state:"all",head:`${owner}:${head}`,base,per_page:"100"})}`,token)).json<GitHubPR[]>();
    const result=list.find(pr=>pr.body?.includes(marker));return result?safePR(result):undefined;
  }
  private async mcp(request:Request):Promise<Response> {
    const input=await body(request),name=string(input.name,"name",100),repo=repository(input.repository);
    if(name!=="create_pull_request" && name!=="pull_request_read" && name!=="list_pull_requests") throw new ApiError(400,"github_tool_unavailable","This GitHub tool is not enabled.");
    const access=scope({...input,repository:repo,permission:name==="create_pull_request"?"write":"read"});await this.requireGrant(access);
    const args=input.args;if(!args || typeof args!=="object" || Array.isArray(args)) throw new ApiError(400,"invalid_arguments","GitHub tool arguments must be an object.");
    const values=args as Record<string,unknown>,[owner,repositoryName]=repo.split("/");
    if((values.owner!==undefined && String(values.owner).toLowerCase()!==owner) || (values.repo!==undefined && String(values.repo).toLowerCase()!==repositoryName)) throw new ApiError(403,"github_repository_mismatch","Tool arguments must match the authorized repository.");
    const token=await this.userToken();
    if(name==="list_pull_requests") {
      const head=values.head===undefined?undefined:branch(values.head,"head");
      await this.callMCP(token,name,{owner,repo:repositoryName,state:"open",perPage:100,...(head?{head:`${owner}:${head}`}:{})});
      const params=new URLSearchParams({state:"open",per_page:"100",...(head?{head:`${owner}:${head}`}:{})});
      const items=await (await this.api(`/repos/${repo}/pulls?${params}`,token)).json<GitHubPR[]>();
      return json({status:"completed",data:items.map(safePR)});
    }
    if(name==="pull_request_read") {
      if(!Number.isSafeInteger(values.pullNumber) || Number(values.pullNumber)<1 || (values.method!==undefined && values.method!=="get")) throw new ApiError(400,"invalid_pull_request","Provide a pull request number.");
      await this.callMCP(token,name,{owner,repo:repositoryName,method:"get",pullNumber:values.pullNumber});
      const pr=await (await this.api(`/repos/${repo}/pulls/${values.pullNumber}`,token)).json<GitHubPR>();return json({status:"completed",data:safePR(pr)});
    }
    const operationId=string(input.operationId,"operationId",160),head=branch(values.head,"head"),base=branch(values.base,"base"),title=string(values.title,"title",256),description=values.body===undefined?"":string(values.body,"body",60_000);
    if(values.draft!==undefined && typeof values.draft!=="boolean") throw new ApiError(400,"invalid_arguments","draft must be a boolean.");
    const operationKey=`operation:${await hash(`${access.botId}:${operationId}`)}`,fingerprint=await hash(JSON.stringify({repo,head,base,title,description,draft:values.draft??false}));
    const previous=await this.ctx.storage.get<Operation>(operationKey);
    if(previous?.fingerprint!==undefined && previous.fingerprint!==fingerprint) throw new ApiError(409,"operation_conflict","This operation identity already belongs to different arguments.");
    if(previous?.status==="completed") return json({status:"completed",data:previous.result});
    const marker=`<!-- timber-operation:${await hash(`${access.botId}:${operationId}`)} -->`;
    const found=await this.reconcile(repo,head,base,marker,token);
    if(found) {await this.ctx.storage.put(operationKey,{botId:access.botId,fingerprint,status:"completed",result:found} satisfies Operation);return json({status:"completed",data:found});}
    if(previous) return json({status:"interrupted",error:{code:"github_operation_unconfirmed",message:"The previous pull request creation could not be confirmed. Inspect GitHub before issuing a new operation."}});
    // Journal before the remote effect. Recovery may reconcile, never repeat the write.
    await this.ctx.storage.put(operationKey,{botId:access.botId,fingerprint,status:"started"} satisfies Operation);
    try {
      await this.callMCP(token,name,{owner,repo:repositoryName,head,base,title,body:`${description}\n\n${marker}`,draft:values.draft??false});
      const result=await this.reconcile(repo,head,base,marker,token);
      if(!result) throw new Error("Unconfirmed MCP write");
      await this.ctx.storage.put(operationKey,{botId:access.botId,fingerprint,status:"completed",result} satisfies Operation);return json({status:"completed",data:result});
    } catch {
      // Provider errors may include tokens or source content. Only a fixed diagnostic escapes.
      await this.ctx.storage.put(operationKey,{botId:access.botId,fingerprint,status:"interrupted"} satisfies Operation);
      return json({status:"interrupted",error:{code:"github_operation_unconfirmed",message:"GitHub did not confirm the pull request result. The write was not automatically repeated."}});
    }
  }
  private async disconnect():Promise<Response> {
    // Revoke grants/capabilities before remote work. Clearing credentials is local and final.
    const connection=await this.ctx.storage.get<Connection>("connection");
    if(connection) await this.ctx.storage.put("connection",{...connection,connected:false,revision:random()});
    for(const prefix of ["grant:","account-grant:","cap:","flow:","notify:"]) {const entries=await this.ctx.storage.list({prefix});if(entries.size) await this.ctx.storage.delete([...entries.keys()]);}
    await this.ctx.storage.delete("credentials");await this.ctx.storage.delete("connection");
    return json({provider:"github",connected:false,revokedLocally:true,message:"Timber access was removed. You can also uninstall the private Timber App in GitHub Settings."});
  }
  async alarm():Promise<void> {
    await this.lock(async()=>{
      let retry=false;
      await this.reconcileWaitingBots();
      for(const [key,flow] of await this.ctx.storage.list<Flow>({prefix:"notify:"})) {if(await this.notify(flow).catch(()=>false)) await this.ctx.storage.delete(key);else retry=true;}
      for(const prefix of ["flow:","cap:"]) for(const [key,value] of await this.ctx.storage.list<{expiresAt:number}>({prefix})) if(value.expiresAt<Date.now()) await this.ctx.storage.delete(key);
      const pending=(await this.ctx.storage.list({prefix:"flow:"})).size+(await this.ctx.storage.list({prefix:"cap:"})).size;
      if(retry || pending) await this.alarmAt(Date.now()+(retry?30_000:5*60_000));
    });
  }
  async fetch(request:Request):Promise<Response> {
    try {
      const path=new URL(request.url).pathname;
      if(path==="/status" && request.method==="GET") return this.status();
      if(path==="/authorize" && request.method==="POST") {
        const access=connectionScope(await body(request));
        const authorized=!(await this.ctx.storage.get(`deleted:${access.botId}`)) && Boolean(access.repository?await this.grant({...access,repository:access.repository}):await this.connectedInstallation());
        if(!authorized && !(await this.ctx.storage.get(`deleted:${access.botId}`))) {await this.ctx.storage.put(`waiting-bot:${access.botId}`,{botId:access.botId});await this.alarmAt(Date.now()+30_000);}
        return json({authorized});
      }
      if(path.startsWith("/github/git/")) return await this.git(request);
      return await this.lock(async()=>{
        if(path.startsWith("/github/setup/") && request.method==="GET") return this.setup(request);
        if(path==="/connect" && request.method==="POST") return this.startConnection(request);
        if((path==="/disconnect" && request.method==="POST") || (path==="/status" && request.method==="DELETE")) return this.disconnect();
        const botMatch=/^\/bots\/([0-9a-f-]{36})$/i.exec(path);
        if(botMatch && request.method==="DELETE") {
          await this.ctx.storage.put(`deleted:${botMatch[1]}`,true);
          for(const prefix of ["grant:","account-grant:","cap:","notify:","operation:","waiting-bot:"]) for(const [key,value] of await this.ctx.storage.list<{botId:string}>({prefix})) if(value.botId===botMatch[1]) await this.ctx.storage.delete(key);
          return json({revoked:true});
        }
        if(path==="/git-capability" && request.method==="POST") return this.capability(request);
        if(/^\/git-capability\/[a-f0-9]{64}$/.test(path) && request.method==="DELETE") {await this.ctx.storage.delete(`cap:${path.split("/").pop()}`);return json({revoked:true});}
        if(path==="/repositories" && request.method==="POST") return this.repositories(request);
        if(path==="/mcp" && request.method==="POST") return this.mcp(request);
        throw new ApiError(404,"not_found","GitHub connection endpoint not found.");
      });
    } catch(error) {return errorResponse(error);}
  }
}
