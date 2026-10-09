import { DurableObject } from "cloudflare:workers";
import { classifyModelFailure, normalizeModelCatalog, resolveModelSettings, type ModelCatalog, type ModelOption, type ModelSettings } from "@botspace/contracts";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { Env } from "./env";
import { ApiError, errorResponse, json } from "./errors";
import { body, string } from "./validation";

const ISSUER = "https://auth.openai.com";
const RESOURCE = "https://api.openai.com/v1";
const MODEL = "gpt-6.1-sol";
const MODEL_CACHE_MS = 5 * 60_000;
const INFERENCE_TIMEOUT_MS = 30 * 60_000;
interface CachedModels {revision:string;expiresAt:number;models:ModelOption[];}
const TOKEN_ENDPOINT = `${ISSUER}/api/accounts/oauth/token`;
const PLAN_SCOPE = "chatgpt.tokens.use.direct";
const encoder = new TextEncoder();
interface Account { clientId:string; subject:string; email?:string; }
interface Tokens {
  accessToken:string; refreshToken:string; idToken:string; scopes:string[];
  expiresAt:number; earliestRefreshAt?:number;
}
interface Ciphertext { iv:string; ciphertext:string; }
interface Connection { account:Account; revision?:string; verifiedAt?:string; needsReauth?:boolean; }
interface Discovery { issuer:string; jwks_uri:string; revocation_endpoint?:string; }

function encode(bytes:Uint8Array):string {return btoa(String.fromCharCode(...bytes));}
function decode(value:string):Uint8Array {return Uint8Array.from(atob(value),c=>c.charCodeAt(0));}
function scopes(value:unknown):string[] {
  if(typeof value!=="string") throw new ApiError(400,"chatgpt_scope_missing","ChatGPT plan permission was not granted. Sign in again and authorize plan usage.");
  const items=value.split(/\s+/).filter(Boolean);
  if(!items.includes(PLAN_SCOPE) || !items.includes("resource.invoke")) throw new ApiError(400,"chatgpt_scope_missing","ChatGPT plan permission was not granted. Sign in again and authorize plan usage.");
  return items;
}
function authURL(value:unknown):string {
  if(typeof value!=="string") throw new ApiError(502,"chatgpt_discovery_failed","OpenAI authentication configuration is unavailable.");
  const url=new URL(value);
  if(url.origin!==ISSUER || url.username || url.password || url.hash) throw new ApiError(502,"chatgpt_discovery_failed","Unexpected OpenAI authentication configuration.");
  return url.href;
}
function publicProviderError(status:number,error?:{code?:unknown;message?:unknown;param?:unknown}):{code:string;message:string} {
  const failure=classifyModelFailure({...error,status});
  return {code:failure.errorCode,message:failure.publicMessage};
}

/** One credential owner and refresh writer, independent of every bot/computer. */
export class ChatGPTAuthDO extends DurableObject<Env> {
  private hostId="";
  private serial:Promise<unknown>=Promise.resolve();
  private discovery?:Discovery;
  private jwks?:ReturnType<typeof createRemoteJWKSet>;
  private key?:CryptoKey;
  private active=new Set<AbortController>();
  private catalogPending?:{revision:string;promise:Promise<ModelOption[]>};

  constructor(ctx:DurableObjectState,env:Env) {
    super(ctx,env);
    ctx.blockConcurrencyWhile(async()=>{
      this.hostId=await ctx.storage.get<string>("hostId")??`urn:uuid:${crypto.randomUUID()}`;
      await ctx.storage.put("hostId",this.hostId);
    });
  }
  private lock<T>(fn:()=>Promise<T>):Promise<T> {
    const pending=this.serial.then(fn,fn);this.serial=pending.catch(()=>{});return pending;
  }
  private async encryptionKey():Promise<CryptoKey> {
    if(this.key) return this.key;
    const value=this.env.CHATGPT_CREDENTIAL_KEY;
    if(!value || !/^[a-f0-9]{64}$/i.test(value)) throw new ApiError(503,"chatgpt_not_configured","The server's ChatGPT credential key has not been configured.");
    this.key=await crypto.subtle.importKey("raw",Uint8Array.from(value.match(/../g)!,x=>parseInt(x,16)),"AES-GCM",false,["encrypt","decrypt"]);
    return this.key;
  }
  private async saveTokens(tokens:Tokens,connection?:Connection):Promise<void> {
    const iv=crypto.getRandomValues(new Uint8Array(12));
    const ciphertext=await crypto.subtle.encrypt({name:"AES-GCM",iv,additionalData:encoder.encode(this.hostId)},await this.encryptionKey(),encoder.encode(JSON.stringify(tokens)));
    const credentials:Ciphertext={iv:encode(iv),ciphertext:encode(new Uint8Array(ciphertext))};
    if(connection) await this.ctx.storage.put({credentials,connection});
    else await this.ctx.storage.put("credentials",credentials);
  }
  private async readTokens():Promise<Tokens> {
    const record=await this.ctx.storage.get<Ciphertext>("credentials");
    if(!record) throw new ApiError(409,"chatgpt_not_connected","Connect your ChatGPT plan with npm run chatgpt:login before using gpt-6.1-sol.");
    const clear=await crypto.subtle.decrypt({name:"AES-GCM",iv:decode(record.iv),additionalData:encoder.encode(this.hostId)},await this.encryptionKey(),decode(record.ciphertext));
    return JSON.parse(new TextDecoder().decode(clear)) as Tokens;
  }
  private async configuration():Promise<Discovery> {
    if(this.discovery) return this.discovery;
    const response=await fetch(`${ISSUER}/.well-known/openid-configuration`,{redirect:"manual",signal:AbortSignal.timeout(15_000)});
    if(!response.ok) throw new ApiError(502,"chatgpt_discovery_failed","OpenAI authentication configuration is unavailable.");
    const data=await response.json<Discovery>();
    if(data.issuer!==ISSUER) throw new ApiError(502,"chatgpt_discovery_failed","Unexpected OpenAI identity issuer.");
    authURL(data.jwks_uri);if(data.revocation_endpoint) authURL(data.revocation_endpoint);
    this.discovery=data;return data;
  }
  private async verifyToken(token:string,audience:string):Promise<JWTPayload> {
    this.jwks??=createRemoteJWKSet(new URL((await this.configuration()).jwks_uri),{timeoutDuration:15_000});
    try {
      const {payload}=await jwtVerify(token,this.jwks,{issuer:ISSUER,audience,algorithms:["RS256","PS256","ES256","EdDSA"],clockTolerance:5,requiredClaims:["exp","iat","sub"]});
      if(!Number.isFinite(payload.iat) || payload.iat!>Date.now()/1000+5 || !payload.sub) throw new Error("Invalid identity claims");
      return payload;
    }
    catch {throw new ApiError(400,"chatgpt_invalid_identity","OpenAI identity validation failed. Complete a fresh ChatGPT sign-in.");}
  }
  private async import(request:Request):Promise<Response> {
    const data=await body(request);
    const clientId=string(data.client_id,"client_id",256);
    if(clientId==="dynamic_agent_client" || !/^[A-Za-z0-9_-]+$/.test(clientId)) throw new ApiError(400,"chatgpt_invalid_client","Use the issued OAuth client ID.");
    if(data.ext_agent_host_id!==this.hostId) throw new ApiError(409,"chatgpt_host_mismatch","The sign-in was prepared for a different Timber host.");
    const accessToken=string(data.access_token,"access_token",32_000);
    const refreshToken=string(data.refresh_token,"refresh_token",32_000);
    const idToken=string(data.id_token,"id_token",32_000);
    const nonce=string(data.nonce,"nonce",256);
    scopes(data.scope);
    const identity=await this.verifyToken(idToken,clientId);
    if(identity.nonce!==nonce) throw new ApiError(400,"chatgpt_invalid_identity","The OpenAI sign-in nonce did not match.");
    if((identity.azp!==undefined && identity.azp!==clientId) || (Array.isArray(identity.aud) && identity.aud.length>1 && identity.azp!==clientId)) throw new ApiError(400,"chatgpt_invalid_identity","The OpenAI identity was issued for another client.");
    const access=await this.verifyToken(accessToken,RESOURCE);
    if(access.client_id!==clientId || access.sub!==identity.sub) throw new ApiError(400,"chatgpt_invalid_identity","OpenAI tokens do not belong to the same registration.");
    const granted=scopes(access.scope);
    const previous=await this.ctx.storage.get<Connection>("connection");
    if(previous && await this.ctx.storage.get("credentials") && (previous.account.subject!==identity.sub || previous.account.clientId!==clientId)) throw new ApiError(409,"chatgpt_account_mismatch","Disconnect the existing ChatGPT account before connecting another registration.");
    const earliestRefreshAt=typeof data.earliest_refresh_at==="number"?data.earliest_refresh_at*1000:undefined;
    const tokens:Tokens={accessToken,refreshToken,idToken,scopes:granted,expiresAt:access.exp!*1000,...(earliestRefreshAt?{earliestRefreshAt}:{})};
    await this.ctx.storage.delete("modelCatalog");this.catalogPending=undefined;
    await this.saveTokens(tokens,{revision:crypto.randomUUID(),account:{clientId,subject:identity.sub!,...(typeof identity.email==="string"?{email:identity.email}:{})}});
    for(const controller of this.active) controller.abort();this.active.clear();
    return json(await this.status());
  }
  private async status() {
    const connection=await this.ctx.storage.get<Connection>("connection");
    const credentials=await this.ctx.storage.get<Ciphertext>("credentials");
    return {connected:Boolean(credentials && !connection?.needsReauth),hostId:this.hostId,model:MODEL,status:connection?.needsReauth?"reauthorization_required":!credentials?"disconnected":connection?.verifiedAt?"verified":"connected_unverified",...(connection?{account:connection.account,verifiedAt:connection.verifiedAt}:{})};
  }
  private async token():Promise<string> {
    // Called only under lock. One owner rotates a session even across many bots.
    const tokens=await this.readTokens();
    const connection=await this.ctx.storage.get<Connection>("connection");
    if(!connection || connection.needsReauth) throw new ApiError(401,"chatgpt_reauthorization_required","Sign in to ChatGPT again.");
    if(tokens.expiresAt>Date.now()+60_000) return tokens.accessToken;
    if(tokens.earliestRefreshAt && tokens.earliestRefreshAt>Date.now()) {
      if(tokens.expiresAt>Date.now()+5_000) return tokens.accessToken;
      throw new ApiError(503,"chatgpt_refresh_pending","OpenAI has not allowed token renewal yet. Try again shortly.");
    }
    const response=await fetch(TOKEN_ENDPOINT,{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"refresh_token",client_id:connection.account.clientId,refresh_token:tokens.refreshToken,resource:RESOURCE}),redirect:"manual",signal:AbortSignal.timeout(20_000)});
    const data=await response.json<Record<string,unknown>>().catch(()=>({} as Record<string,unknown>));
    if(!response.ok) {
      if(["invalid_grant","invalid_refresh_token","token_expired","refresh_token_expired","refresh_token_invalidated","refresh_token_reused"].includes(String(data.error))) {
        await this.ctx.storage.delete("credentials");
        await this.ctx.storage.put("connection",{...connection,needsReauth:true,verifiedAt:undefined});
        throw new ApiError(401,"chatgpt_reauthorization_required","The ChatGPT session expired or was revoked. Sign in again.");
      }
      throw new ApiError(503,"chatgpt_refresh_failed","ChatGPT token renewal failed. The connection was retained; try again later.");
    }
    const accessToken=string(data.access_token,"access_token",32_000);
    const refreshToken=string(data.refresh_token,"refresh_token",32_000);
    const access=await this.verifyToken(accessToken,RESOURCE);
    if(access.sub!==connection.account.subject || access.client_id!==connection.account.clientId) throw new ApiError(401,"chatgpt_invalid_identity","The refreshed ChatGPT identity did not match.");
    const granted=scopes(access.scope);
    const replacement:Tokens={accessToken,refreshToken,idToken:typeof data.id_token==="string"?data.id_token:tokens.idToken,scopes:granted,expiresAt:access.exp!*1000,...(typeof data.earliest_refresh_at==="number"?{earliestRefreshAt:data.earliest_refresh_at*1000}:{})};
    await this.saveTokens(replacement);
    return accessToken;
  }
  private revision(connection:Connection):string {return connection.revision??`${connection.account.clientId}:${connection.account.subject}`;}
  private async modelList():Promise<ModelOption[]> {
    const initial=await this.lock(async()=>{
      const token=await this.token();
      const connection=(await this.ctx.storage.get<Connection>("connection"))!;
      const revision=this.revision(connection),cached=await this.ctx.storage.get<CachedModels>("modelCatalog");
      return {token,revision,cached:cached?.revision===revision && cached.expiresAt>Date.now()?cached.models:undefined};
    });
    if(initial.cached) return initial.cached;
    if(this.catalogPending?.revision===initial.revision) return this.catalogPending.promise;
    const promise=(async()=>{
      const controller=new AbortController();this.active.add(controller);
      try {
        let response:Response;
        try {response=await fetch(`${RESOURCE}/models`,{headers:{Authorization:`Bearer ${initial.token}`,"User-Agent":"Timber/0.1.0"},redirect:"manual",signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15_000)])});}
        catch {throw new ApiError(503,"model_catalog_unavailable","The connected account's model catalogue could not be loaded. Refresh and try again.");}
        if(!response.ok) {
          await response.body?.cancel();
          throw new ApiError(503,"model_catalog_unavailable",response.status===401?"The model catalogue rejected this ChatGPT connection. Reconnect ChatGPT.":"The connected account's model catalogue is unavailable. Refresh and try again.");
        }
        let raw:unknown;
        const reader=response.body?.getReader();let bytes=0,text="";
        try {
          if(!reader) throw new Error("empty");
          const decoder=new TextDecoder();
          while(true) {const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>2_000_000)throw new Error("large");text+=decoder.decode(part.value,{stream:true});}
          text+=decoder.decode();raw=JSON.parse(text);
        } catch {throw new ApiError(503,"model_catalog_invalid","The connected account returned an unreadable model catalogue.");}
        finally {await reader?.cancel().catch(()=>{});}
        let models:ModelOption[];
        try {models=normalizeModelCatalog(raw);} catch {throw new ApiError(503,"model_catalog_invalid","The connected account returned an unsupported model catalogue.");}
        await this.lock(async()=>{
          const current=await this.ctx.storage.get<Connection>("connection");
          if(!current || current.needsReauth || this.revision(current)!==initial.revision || !await this.ctx.storage.get("credentials")) throw new ApiError(409,"chatgpt_connection_changed","The ChatGPT connection changed. Refresh the model catalogue.");
          await this.ctx.storage.put<CachedModels>("modelCatalog",{revision:initial.revision,expiresAt:Date.now()+MODEL_CACHE_MS,models});
        });
        return models;
      } finally {this.active.delete(controller);}
    })();
    this.catalogPending={revision:initial.revision,promise};
    try {return await promise;} finally {if(this.catalogPending?.promise===promise)this.catalogPending=undefined;}
  }
  private async catalog():Promise<ModelCatalog> {
    const current=await this.status(),fallback=this.env.BOTSPACE_DEFAULT_MODEL??MODEL;
    if(!current.connected)return {models:[],connected:false,defaultModel:fallback};
    try {
      const models=await this.modelList();
      return {models,connected:true,defaultModel:models.find(model=>model.id===fallback)?.id??models[0]?.id??fallback};
    } catch(error) {
      return {models:[],connected:(await this.status()).connected,defaultModel:fallback,error:error instanceof ApiError?error.message:"The model catalogue is unavailable. Refresh and try again."};
    }
  }
  private async validateSettings(input:ModelSettings):Promise<{settings:ModelSettings;model:ModelOption}> {
    const models=await this.modelList();
    let settings:ModelSettings;
    try {settings=resolveModelSettings(input,models);}
    catch(error) {throw new ApiError(400,"invalid_model_settings",error instanceof Error?error.message:"Invalid model settings.");}
    return {settings,model:models.find(model=>model.id===settings.model)!};
  }
  private async provider(request:Request):Promise<Response> {
    const payload=await request.json<Record<string,unknown>>();
    if(typeof payload.model!=="string" || payload.store!==false || payload.stream!==true || !Array.isArray(payload.input)) throw new ApiError(400,"chatgpt_invalid_request","The ChatGPT plan route requires an account-supported model with streaming and client-owned history.");
    const unsupported=["background","conversation","max_output_tokens","max_tool_calls","metadata","moderation","multi_agent","prompt","prompt_cache_retention","safety_identifier","temperature","top_logprobs","top_p","truncation","user","previous_response_id"];
    if(unsupported.some(key=>payload[key]!==undefined)) throw new ApiError(400,"chatgpt_invalid_request","Unsupported options on the ChatGPT subscription route.");
    const reasoning=payload.reasoning;
    if(reasoning!==undefined && (!reasoning || typeof reasoning!=="object" || Array.isArray(reasoning))) throw new ApiError(400,"invalid_model_settings","reasoning must be an object.");
    const effort=(reasoning as {effort?:unknown}|undefined)?.effort;
    if(effort!==undefined && typeof effort!=="string") throw new ApiError(400,"invalid_model_settings","Reasoning effort must be a catalogue option.");
    if(payload.service_tier!==undefined && !["fast","priority"].includes(String(payload.service_tier))) throw new ApiError(400,"invalid_model_settings","Only an advertised Fast mode tier may be selected.");
    const initial=await this.ctx.storage.get<Connection>("connection");
    const {settings}=await this.validateSettings({model:payload.model,...(effort===undefined?{}:{reasoningEffort:effort as string}),fast:payload.service_tier!==undefined});
    if(settings.reasoningEffort) payload.reasoning={...(reasoning as Record<string,unknown>??{}),effort:settings.reasoningEffort};
    const controller=new AbortController();
    const token=await this.lock(async()=>{
      const token=await this.token(),current=(await this.ctx.storage.get<Connection>("connection"))!;
      if(!initial || this.revision(current)!==this.revision(initial)) throw new ApiError(409,"chatgpt_connection_changed","The ChatGPT connection changed. Retry with the current connection.");
      this.active.add(controller);return token;
    });
    const timer=setTimeout(()=>controller.abort(),INFERENCE_TIMEOUT_MS);
    const signal=AbortSignal.any([request.signal,controller.signal]);
    const cleanup=()=>{clearTimeout(timer);this.active.delete(controller);};
    let response:Response;
    try {response=await fetch(`${RESOURCE}/responses`,{method:"POST",headers:{Authorization:`Bearer ${token}`,"content-type":"application/json","User-Agent":"Timber/0.1.0"},body:JSON.stringify(payload),redirect:"manual",signal});}
    catch {cleanup();throw new ApiError(502,"model_connection_interrupted","Connection lost while contacting ChatGPT. Try again later.");}
    if(!response.ok) {
      const data=await response.json<{error?:{code?:unknown;message?:unknown;param?:unknown}}>().catch(()=>({error:undefined}));
      cleanup();
      const failure=publicProviderError(response.status,data.error);
      console.warn(JSON.stringify({event:"model.failure",stage:"request",status:response.status,errorCode:failure.code}));
      return json({error:failure},response.status>=400?response.status:502);
    }
    if(!response.body) {cleanup();throw new ApiError(502,"chatgpt_empty_response","OpenAI returned an empty inference response.");}
    // Track active streams so disconnect cancels current inference as well as new work.
    const reader=response.body.getReader();
    const stream=new ReadableStream<Uint8Array>({
      async pull(output) {try {const part=await reader.read();if(part.done){cleanup();output.close();}else output.enqueue(part.value);}catch(error){cleanup();output.error(error);}},
      async cancel(reason) {cleanup();controller.abort();await reader.cancel(reason).catch(()=>{});},
    });
    return new Response(stream,{status:response.status,headers:{"content-type":"text/event-stream","cache-control":"no-store"}});
  }
  private async verify():Promise<Response> {
    const initial=await this.ctx.storage.get<Connection>("connection");
    const models=await this.modelList();
    const model=models.find(model=>model.id===(this.env.BOTSPACE_DEFAULT_MODEL??MODEL))?.id??models[0]?.id;
    if(!model)throw new ApiError(409,"model_unavailable","No model is available in this ChatGPT account.");
    const response=await this.provider(new Request("https://chatgpt/responses",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({model,input:[{role:"user",content:"Reply with exactly TIMBER_CONNECTED."}],store:false,stream:true})}));
    if(!response.ok) return response;
    const reader=response.body!.getReader(),decoder=new TextDecoder();let buffer="",bytes=0,completed=false;
    try {
      while(true) {
        const part=await reader.read();if(part.done) break;
        bytes+=part.value.byteLength;if(bytes>512_000) throw new ApiError(502,"chatgpt_verification_incomplete","The verification response exceeded its limit.");
        buffer+=decoder.decode(part.value,{stream:true});
        let index:number;
        while((index=buffer.indexOf("\n"))>=0) {
          const line=buffer.slice(0,index).trim();buffer=buffer.slice(index+1);
          if(!line.startsWith("data:") || line==="data: [DONE]") continue;
          let event:{type?:string;code?:string;message?:string;param?:string;response?:{status?:string;incomplete_details?:{reason?:string};error?:{code?:string;message?:string;param?:string}};error?:{code?:string;message?:string;param?:string}};
          try {event=JSON.parse(line.slice(5).trim());} catch {continue;}
          if(event.type==="response.completed" && (!event.response?.status || event.response.status==="completed")) completed=true;
          if(["response.failed","response.incomplete","error"].includes(event.type??"")) {
            const reason=event.response?.incomplete_details?.reason;
            const failure=publicProviderError(502,reason==="max_output_tokens"?{code:"model_output_limit"}:reason==="content_filter"?{code:"model_response_filtered"}:event.response?.error??event.error??event);
            throw new ApiError(502,failure.code,failure.message);
          }
        }
      }
    } finally {await reader.cancel().catch(()=>{});}
    if(!completed) throw new ApiError(502,"chatgpt_verification_incomplete","The stream ended without a completed response. Access is not yet verified.");
    await this.lock(async()=>{
      const connection=await this.ctx.storage.get<Connection>("connection");
      if(!initial || !connection || connection.revision!==initial.revision || connection.needsReauth || !await this.ctx.storage.get("credentials")) throw new ApiError(409,"chatgpt_connection_changed","The ChatGPT connection changed during verification. Verify the current connection again.");
      await this.ctx.storage.put("connection",{...connection,verifiedAt:new Date().toISOString()});
    });
    return json({ok:true,model});
  }
  private async disconnect():Promise<Response> {
    for(const controller of this.active) controller.abort();this.active.clear();
    let revoked=false;
    const connection=await this.ctx.storage.get<Connection>("connection");
    try {
      const tokens=await this.readTokens();
      const endpoint=(await this.configuration()).revocation_endpoint;
      if(endpoint && connection) {
        const response=await fetch(authURL(endpoint),{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({token:tokens.refreshToken,token_type_hint:"refresh_token",client_id:connection.account.clientId}),redirect:"manual",signal:AbortSignal.timeout(15_000)});
        revoked=response.status===200;await response.body?.cancel();
      }
    } catch { /* Local disconnection must still succeed. Report unconfirmed revocation. */ }
    await this.ctx.storage.delete("credentials");
    await this.ctx.storage.delete("modelCatalog");this.catalogPending=undefined;
    if(connection) await this.ctx.storage.put("connection",{account:connection.account});
    return json({...await this.status(),revoked});
  }
  async fetch(request:Request):Promise<Response> {
    try {
      const path=new URL(request.url).pathname;
      if(path==="/" && request.method==="GET") return json(await this.status());
      if(path==="/" && request.method==="POST") return await this.lock(()=>this.import(request));
      if(path==="/" && request.method==="DELETE") return await this.lock(()=>this.disconnect());
      if(path==="/models" && request.method==="GET") return json(await this.catalog());
      if(path==="/validate-model" && request.method==="POST") {
        const data=await body(request);
        if(typeof data.model!=="string" || (data.reasoningEffort!==undefined && typeof data.reasoningEffort!=="string") || (data.fast!==undefined && typeof data.fast!=="boolean")) throw new ApiError(400,"invalid_model_settings","Invalid model settings.");
        return json(await this.validateSettings({model:data.model,...(data.reasoningEffort===undefined?{}:{reasoningEffort:data.reasoningEffort as string}),...(data.fast===undefined?{}:{fast:data.fast as boolean})}));
      }
      if(path==="/responses" && request.method==="POST") return await this.provider(request);
      if(path==="/verify" && request.method==="POST") return await this.verify();
      throw new ApiError(404,"not_found","Connection endpoint not found.");
    } catch(error) {return errorResponse(error);}
  }
}
