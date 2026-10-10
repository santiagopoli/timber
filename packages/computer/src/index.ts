/// <reference path="./assets.d.ts" />
import { DurableObject } from "cloudflare:workers";
import type { ComputerAction, ComputerProvider, ComputerResult, ComputerStatus } from "@botspace/contracts";
import serverSource from "../../../infra/computer/server.py";
import startSource from "../../../infra/computer/start.sh";
import workspaceSource from "../../../infra/computer/workspace.py";
import desktopSource from "../../../infra/computer/desktop_bridge.py";
import { DesktopSessions, DesktopError } from "./live";

export interface ComputerEnv {
  FILES: R2Bucket;
  GITHUB?: DurableObjectNamespace;
  /** Temporary deployment mode. Installs desktop packages at cold start. */
  COMPUTER_BOOTSTRAP?: string;
}

interface OperationRecord { digest: string; result?: ComputerResult; processId?: string; conflict?:boolean; checkpoint?:{bootId:string;revision:number;warning?:string}; }
interface ExecCancellation {operationId:string;journal:boolean;}
interface ExecSession {
  digest: string;
  bootId: string;
  dispatched: boolean;
  result: ComputerResult;
  checkpoint: 'pending' | 'attempting' | 'done';
  checkpointAttemptId?: string;
}
interface Checkpoint { id: string; key: string; size: number; sha256: string; createdAt: string; bootId?:string; revision?:number; }
interface CheckpointRetry {bootId:string;revision:number;attempts:number;nextAttemptAt:number;blocked?:boolean;candidate?:Checkpoint;errorCode?:ComputerErrorCode;}
interface Health { ok: boolean; bootId: string; desktop: boolean; capabilities?:string[]; }
interface ContainerResult extends ComputerResult { artifactName?: string; }
interface GitTransport { id:string; url:string; token:string; }

const IDLE_MS = 5 * 60_000;
const SAFETY_TIMEOUT_MS = 15 * 60_000;
const EXEC_POLL_MS = 10_000;
const PORT = 8080;
const BASE_CAPABILITIES = ["exec", "readFile", "writeFile", "listFiles", "checkpoint"];
const DESKTOP_CAPABILITIES = ["screenshot", "click", "type", "key", "scroll", "navigate"];
const EXTENDED_MOUSE_CAPABILITIES = ["move", "doubleClick", "drag"];
const encoder = new TextEncoder();

function stableAction(action: ComputerAction): string {
  return JSON.stringify(action, Object.keys(action).sort());
}
async function sha256(value: string | ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", typeof value === "string" ? encoder.encode(value) : value);
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
}
const COMPUTER_ERRORS = {
  computer_unavailable: {status:503, message:"The cloud computer is unavailable. Try again shortly."},
  computer_not_configured: {status:503, message:"The cloud computer binding is not configured."},
  computer_image_missing: {status:503, message:"The cloud computer image is not configured."},
  computer_start_failed: {status:503, message:"Cloudflare could not start the computer. Check Containers access, provisioning, and instance capacity."},
  computer_lifecycle_failed: {status:503, message:"Cloudflare could not configure the computer lifetime."},
  computer_provisioning_failed: {status:503, message:"The cloud computer could not install its desktop packages."},
  computer_start_timeout: {status:503, message:"The cloud computer exceeded its startup time limit. No requested action was executed."},
  computer_server_install_failed: {status:503, message:"The cloud computer could not install its control server."},
  computer_server_start_failed: {status:503, message:"The cloud computer control server could not start."},
  computer_not_ready: {status:503, message:"The cloud computer started but its control server did not become ready."},
  computer_restore_missing: {status:503, message:"The latest workspace checkpoint is missing. The computer was not started with an empty workspace."},
  computer_restore_failed: {status:503, message:"The cloud computer could not restore its saved workspace."},
  computer_checkpoint_failed: {status:503, message:"The cloud computer could not create a workspace checkpoint."},
  computer_checkpoint_changed: {status:409, message:"Background processes changed workspace files during checkpoint. Keep live logs and temporary build output outside /workspace, then retry checkpoint."},
  computer_checkpoint_limit: {status:413, message:"The workspace exceeds the checkpoint limit of 256 MiB or 10,000 entries. Remove disposable build output or caches from /workspace, then retry checkpoint."},
  computer_checkpoint_nonportable: {status:409, message:"The workspace contains an external symlink or a special file that cannot be checkpointed. Use regular files and relative symlinks within /workspace, then retry checkpoint."},
  computer_checkpoint_integrity_failed: {status:503, message:"The workspace checkpoint failed size or checksum validation."},
  computer_checkpoint_persist_failed: {status:503, message:"The workspace checkpoint could not be saved durably. Retry the checkpoint, not the previous action."},
  computer_checkpoint_lost: {status:409, message:"The computer restarted before its latest files were checkpointed. Only the last saved workspace can be restored; do not repeat the previous action automatically."},
  computer_invalid_request: {status:400, message:"The computer request is invalid."},
  computer_method_not_allowed: {status:405, message:"The computer request method is not allowed."},
  computer_owner_mismatch: {status:403, message:"This computer belongs to another bot."},
  computer_deleted: {status:410, message:"This bot's computer has been permanently deleted."},
  computer_upgrade_required: {status:409, message:"This computer is running an older image. Suspend it after its current work finishes to save its workspace, then retry on the updated image. No action was executed."},
  computer_git_unavailable: {status:503, message:"The GitHub transport is unavailable. Reconnect GitHub and verify this bot's repository access."},
  computer_app_not_running: {status:503, message:"This app's computer is stopped. Ask the bot to start the app again."},
  computer_execution_active: {status:409, message:"A command is still running. Wait for it or cancel it before suspending, checkpointing, or taking control of the computer."},
  computer_idempotency_conflict: {status:409, message:"operationId was already used with different arguments."},
} as const;

export type ComputerErrorCode = keyof typeof COMPUTER_ERRORS;

/** Public errors contain only fixed, reviewed messages. Never construct one with
 * a provider response, command, environment value or raw exception message. */
export class ComputerProviderError extends Error {
  readonly status: number;
  readonly publicMessage: string;
  constructor(readonly code: ComputerErrorCode) {
    const spec = COMPUTER_ERRORS[code];
    super(spec.message);
    this.name = "ComputerProviderError";
    this.status = spec.status;
    this.publicMessage = spec.message;
  }
}

function safeError(error: unknown): ComputerProviderError {
  return error instanceof ComputerProviderError ? error : new ComputerProviderError("computer_unavailable");
}

async function checkpointResponseError(response:Response):Promise<ComputerProviderError> {
  // Older images return a short error string. Classify only known server errors;
  // never forward workspace paths, arbitrary provider responses or exceptions.
  if(response.status===400) {
    const body=await response.json<{error?:unknown}>().catch(()=>undefined);
    const message=body?.error;
    if(message==="Workspace changed during checkpoint; stop background writers and retry") return new ComputerProviderError("computer_checkpoint_changed");
    if(message==="Workspace exceeds checkpoint limit (256 MiB, 10000 entries)" || message==="Compressed checkpoint exceeds limit") return new ComputerProviderError("computer_checkpoint_limit");
    if(typeof message==="string" && (message.startsWith("Checkpoint contains an escaping symlink: ") || message.startsWith("Checkpoint contains a nonportable special file: "))) return new ComputerProviderError("computer_checkpoint_nonportable");
  }
  return new ComputerProviderError("computer_checkpoint_failed");
}

async function stage<T>(code: ComputerErrorCode, work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) {
    const safe = error instanceof ComputerProviderError ? error : new ComputerProviderError(code);
    // Stage and code are fixed strings, never exception bodies or tool input.
    console.error("computer.failure", {stage:code,code:safe.code});
    throw safe;
  }
}

/** There is one instance per bot. Never expose this DO directly without API auth. */
export class ComputerDO extends DurableObject<ComputerEnv> {
  private live:DesktopSessions;
  private tail: Promise<unknown> = Promise.resolve();
  // Effects stay ordered on tail. Files only share the shorter lifecycle gate,
  // so inspecting a restored workspace never waits for a shell command to exit.
  private workspaceTail: Promise<unknown> = Promise.resolve();
  private workspaceHealth?: Health;
  private starting?: Promise<Health>;
  private flights = new Map<string, Promise<ComputerResult>>();
  private token = "";
  private desktop = false;
  private capabilities:string[]=[];
  private deleted=false;
  private deleting?:Promise<void>;
  private shutdown=new AbortController();
  private execUpdates=new Map<string,Promise<unknown>>();
  private finalizingExecutions?:Promise<void>;

  constructor(ctx: DurableObjectState, env: ComputerEnv) {
    super(ctx, env);
    this.live=new DesktopSessions(ctx.storage,promise=>ctx.waitUntil(promise));
    void ctx.blockConcurrencyWhile(async () => {
      if(await ctx.storage.get<string>("deleted")) {this.deleted=true;this.shutdown.abort();return;}
      this.token = await ctx.storage.get<string>("internalToken") ?? crypto.randomUUID() + crypto.randomUUID();
      await ctx.storage.put("internalToken", this.token);
      // If the DO was evicted during an effect, its outcome is unknown. A retry
      // with the same id receives interrupted, never replays the effect.
      const operations = await ctx.storage.list<OperationRecord>({ prefix: "operation:" });
      for (const [key, record] of operations) {
        if (!record.result && !record.processId) {
          record.result = {operationId: key.slice(10), status: "interrupted", error: "Execution was interrupted. Inspect effects before creating another operation."};
          await ctx.storage.put(key, record);
        }
      }
      const sessions=await ctx.storage.list<ExecSession>({prefix:"exec-session:"});
      const retry=await ctx.storage.get<CheckpointRetry>('checkpointRetry');
      for(const [key,session] of sessions) if(session.checkpoint==='attempting') {
        const checkpoint=await ctx.storage.get<Checkpoint>('lastCheckpoint');
        if(checkpoint && checkpoint.id===session.checkpointAttemptId) session.result.checkpointId=checkpoint.id;
        else if(retry) session.result.checkpointStatus='pending';
        else session.result.error=`${session.result.error?session.result.error+' ':''}The checkpoint outcome could not be confirmed after recovery. Retry checkpoint; do not repeat the command.`;
        session.checkpoint='done';
        await this.storeExecution(key.slice('exec-session:'.length),session);
      }
      if([...sessions.values()].some(session=>session.result.status==='running' || session.checkpoint==='pending') || (retry && !retry.blocked)) await ctx.storage.setAlarm(Date.now()+1_000);
      if (this.container?.running) await stage("computer_lifecycle_failed", () => this.container!.setInactivityTimeout(SAFETY_TIMEOUT_MS));
    });
  }

  private get container(): Container | undefined {
    return this.ctx.container;
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.catch(() => undefined);
    return result;
  }
  private active():void {if(this.deleted) throw new ComputerProviderError("computer_deleted");}
  private withWorkspace<T>(fn: () => Promise<T>): Promise<T> {
    const work = async () => { this.active(); return fn(); };
    const result = this.workspaceTail.then(work, work);
    this.workspaceTail = result.catch(() => undefined);
    return result;
  }
  private remove(botId:string):Promise<void> {
    if(this.deleting) return this.deleting;
    this.deleted=true;
    this.shutdown.abort();
    this.deleting=(async()=>{
      await this.live.closeAll();
      await this.ctx.storage.put("deleted",botId);
      await this.ctx.storage.deleteAlarm();
      if(this.container && (this.container.running || this.starting)) await this.container.destroy("Bot permanently deleted");
      // Stop first, then drain queued/in-flight operations before acknowledging
      // deletion. Workspace can now remove R2 without a late uploader racing it.
      await this.tail;
      await this.workspaceTail;
      await Promise.all([...this.execUpdates.values()].map(work=>work.catch(()=>{})));
      await this.finalizingExecutions?.catch(()=>{});
      if(this.starting) await this.starting.catch(()=>{});
      while(true) {
        const values=await this.ctx.storage.list({limit:128});
        const keys=[...values.keys()].filter(key=>key!=="deleted");
        if(!keys.length) break;
        await this.ctx.storage.delete(keys);
      }
      await this.ctx.storage.deleteAlarm();
      this.token="";this.desktop=false;
    })().finally(()=>{this.deleting=undefined;});
    return this.deleting;
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    try {
      if(path.startsWith("/workspace/") || path.startsWith("/desktop")) return await this.inspect(request);
      if(path.startsWith("/preview/")) return await this.preview(request);
      if (request.method !== "POST") throw new ComputerProviderError("computer_method_not_allowed");
      const body = await request.json<{botId:string; operationId?:string; processId?:string; action?:ComputerAction}>();
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(body.botId)) throw new ComputerProviderError("computer_invalid_request");
      const savedBotId = await this.ctx.storage.get<string>("deleted") ?? await this.ctx.storage.get<string>("botId");
      if (savedBotId && savedBotId !== body.botId) throw new ComputerProviderError("computer_owner_mismatch");
      if(path==="/delete") {await this.remove(body.botId);return Response.json({botId:body.botId,deleted:true});}
      this.active();
      if (!savedBotId) await this.ctx.storage.put("botId", body.botId);
      this.active();
      if (path === "/status") return Response.json(await this.status(body.botId));
      if (path === "/touch") { await this.touch(); return Response.json({ok:true}); }
      if(path==='/exec/cancel') {
        if(!body.processId || !/^[A-Za-z0-9:_.-]{1,160}$/.test(body.processId)) throw new ComputerProviderError('computer_invalid_request');
        return Response.json(await this.cancelExecution(body.botId,body.processId,body.processId,false));
      }
      if (path === "/suspend") {
        return Response.json(await this.serialize(() => this.withWorkspace(async () => {
          this.active();
          if(await this.hasActiveExecutions()) throw new ComputerProviderError('computer_execution_active');
          await this.live.closeAll();
          if (this.container?.running) {
            await this.initializeWorkspace(body.botId);
            await this.saveCheckpoint(body.botId, true);
            await this.container.destroy("User suspended computer after durable checkpoint");
            this.desktop = false;
            this.workspaceHealth = undefined;
          }
          return this.status(body.botId);
        })));
      }
      if (path !== "/actions" || !body.action || !body.operationId || !/^[A-Za-z0-9:_.-]{1,160}$/.test(body.operationId)) {
        throw new ComputerProviderError("computer_invalid_request");
      }
      return Response.json(await this.execute(body.botId, body.operationId, body.action));
    } catch (error) {
      if(error instanceof DesktopError) return Response.json({error:{code:error.code,message:error.message}},{status:error.status});
      const safe = safeError(error);
      console.error("computer.failure", {stage:"request",code:safe.code});
      return Response.json({error:{code:safe.code,message:safe.publicMessage}}, {status:safe.status});
    }
  }

  private async inspect(request:Request):Promise<Response> {
    this.active();
    const url=new URL(request.url),botId=request.headers.get("x-timber-bot-id")??"";
    if(!/^[A-Za-z0-9_-]{1,100}$/.test(botId)) throw new ComputerProviderError("computer_invalid_request");
    const owner=await this.ctx.storage.get<string>("botId");
    if(owner && owner!==botId) throw new ComputerProviderError("computer_owner_mismatch");
    if(!owner) await this.ctx.storage.put("botId",botId);
    if(url.pathname==="/desktop-ws") return this.live.connect(botId,request,port=>{
      if(!this.container?.running) throw new ComputerProviderError("computer_app_not_running");
      return this.container.getTcpPort(port).fetch(new Request(`http://127.0.0.1:${port}/`,{headers:{Upgrade:"websocket",Authorization:`Bearer ${this.token}`,"Sec-WebSocket-Protocol":"binary"}}));
    },()=>this.touch());
    if(url.pathname==="/desktop/control" && request.method==="GET") return Response.json({controlled:await this.live.controlled()});
    if(url.pathname==="/desktop" && request.method==="POST") {
      const input=await request.json<{mode?:unknown;replaces?:unknown}>();
      if(input.mode!=="view" && input.mode!=="control") throw new ComputerProviderError("computer_invalid_request");
      if(input.replaces!==undefined && (input.mode!=="control" || typeof input.replaces!=="string" || !/^[a-f0-9-]{36}$/.test(input.replaces))) throw new ComputerProviderError("computer_invalid_request");
      const mode=input.mode;
      const replaces=input.replaces as string|undefined;
      const create=()=>this.withWorkspace(async()=>{
        if(mode==='control' && await this.hasActiveExecutions()) throw new ComputerProviderError('computer_execution_active');
        let health=this.container?.running && this.workspaceHealth
          ? this.workspaceHealth : await this.initializeWorkspace(botId);
        if(!health.capabilities?.includes("liveDesktop") && !health.capabilities?.includes("workspace")) throw new ComputerProviderError("computer_upgrade_required");
        // The HTTP process can become ready a moment before the desktop bridge.
        // Re-probe readiness, never replay an action or mislabel this as an old image.
        for(let attempt=0;!health.capabilities?.includes("liveDesktop") && attempt<10;attempt++) {
          await new Promise(resolve=>setTimeout(resolve,200));this.active();
          health=await this.health();
        }
        if(!health.capabilities?.includes("liveDesktop")) throw new DesktopError("desktop_unavailable",503,"The live desktop is still starting. Connect again shortly.");
        await this.touch();return Response.json(await this.live.create(botId,mode,replaces));
      });
      return mode==="view" ? create() : this.serialize(create);
    }
    const session=/^\/desktop\/([a-f0-9-]{36})(\/renew)?$/.exec(url.pathname);
    // Lease metadata must not wait behind a file read or checkpoint. Renewing
    // an existing viewer neither reads the workspace nor starts a computer.
    if(session && request.method==="POST" && session[2]) {const value=await this.live.renew(botId,session[1]);await this.touch();return Response.json(value);}
    if(session && request.method==="DELETE" && !session[2]) {await this.live.release(session[1]);return Response.json({released:true});}
    if(request.method!=="GET" || !/^\/workspace\/(tree|file|download|projects|changes|diff)$/.test(url.pathname)) throw new ComputerProviderError("computer_invalid_request");
    return this.withWorkspace(async()=>{
      const health=this.container?.running && this.workspaceHealth
        ? this.workspaceHealth : await this.initializeWorkspace(botId);
      if(!health.capabilities?.includes("workspace")) throw new ComputerProviderError("computer_upgrade_required");
      await this.touch();
      const response=await this.call(url.pathname+url.search);
      const headers=new Headers(response.headers);
      headers.set("cache-control","private, no-store");headers.set("x-content-type-options","nosniff");headers.set("content-security-policy","sandbox; default-src 'none'");
      if(url.pathname==="/workspace/download") headers.set("content-disposition",`attachment; filename="workspace-file"`);
      return new Response(response.body,{status:response.status,headers});
    });
  }

  private async status(botId: string): Promise<ComputerStatus> {
    const [checkpoint, startupFailure] = await Promise.all([
      this.ctx.storage.get<Checkpoint>("lastCheckpoint"),
      this.ctx.storage.get<ComputerErrorCode>("startupFailure"),
    ]);
    const container = this.container;
    let state: ComputerStatus["state"] = !container ? "unavailable" : this.starting ? "starting" : container.running ? "running" : "stopped";
    let error: ComputerProviderError | undefined;
    if (!container) error = new ComputerProviderError("computer_not_configured");
    else if (!this.starting && startupFailure) {
      state = "unavailable";
      error = new ComputerProviderError(startupFailure);
    } else if (state === "running") {
      try {
        const health = await this.health();
        this.desktop = health.desktop;
        this.capabilities=health.capabilities??[];
      } catch {
        // A failed probe is not an active startup. Status never boots, repairs,
        // touches idle activity, or replays an action just to update the UI.
        state = "unavailable";
        error = new ComputerProviderError("computer_not_ready");
      }
    }
    if (state !== "running") this.desktop = false;
    return {
      id:botId, provider:"cloudflare", state,
      capabilities: container ? [...BASE_CAPABILITIES, ...(this.desktop ? [...DESKTOP_CAPABILITIES,...this.capabilities.filter(value=>EXTENDED_MOUSE_CAPABILITIES.includes(value))] : []), ...this.capabilities.filter(value=>value==="gitClone" || value==="gitPush" || value==='execSessions')] : [],
      ...(checkpoint ? {lastCheckpointId:checkpoint.id} : {}),
      ...(error ? {error:{code:error.code,message:error.publicMessage}} : {}),
    };
  }

  private execute(botId: string, operationId: string, action: ComputerAction): Promise<ComputerResult> {
    this.active();
    if(action.type==='exec') return this.startExecution(botId,operationId,action);
    if(action.type==='execPoll') return this.pollExecution(botId,operationId,action.processId,action.yieldMs===undefined?1000:action.yieldMs);
    if(action.type==='execCancel') return this.cancelExecution(botId,operationId,action.processId);
    // Include argument digest even when another call with this id is in flight.
    const flightKey = `${operationId}:${stableAction(action)}`;
    const existing = this.flights.get(flightKey);
    if (existing) return existing;
    const work = this.serialize(async () => {
      this.active();
      const digest = await sha256(stableAction(action));
      this.active();
      const key = `operation:${operationId}`;
      const existingRecord = await this.ctx.storage.get<OperationRecord>(key);
      this.active();
      if (existingRecord) {
        if (existingRecord.digest !== digest) return {operationId, status:"failed" as const, error:"operationId was already used with different arguments"};
        return existingRecord.result ?? {operationId, status:"interrupted" as const, error:"Operation outcome is unknown; it will not be replayed"};
      }
      if(!["screenshot","readFile","listFiles"].includes(action.type) && await this.live.controlled()) return {operationId,status:"failed" as const,error:"A person has control of the desktop. No action was executed. Release desktop control before issuing a new action."};
      const health=await this.ensureReady(botId);
      if((action.type==="gitClone" || action.type==="gitPush") && !health.capabilities?.includes(action.type)) throw new ComputerProviderError("computer_upgrade_required");
      if(EXTENDED_MOUSE_CAPABILITIES.includes(action.type) && (!health.desktop || !health.capabilities?.includes(action.type))) throw new ComputerProviderError("computer_upgrade_required");
      await this.touch();
      this.active();
      const reserved=await this.ctx.storage.transaction(async txn=>{
        const record=await txn.get<OperationRecord>(key);
        if(!record) await txn.put<OperationRecord>(key,{digest});
        return record;
      });
      if(reserved) return reserved.digest===digest
        ? reserved.result??{operationId,status:'interrupted' as const,error:'Operation outcome is unknown; it will not be replayed'}
        : {operationId,status:'failed' as const,error:'operationId was already used with different arguments'};
      if(action.type==='writeFile' || action.type==='gitClone') await this.markCheckpointDirty(operationId,health.bootId);
      this.active();
      let result: ComputerResult;
      let operationStage: "checkpoint" | "action" | "artifact_read" | "artifact_store" = "action";
      try {
        if (action.type === "checkpoint") {
          operationStage = "checkpoint";
          const checkpoint = await this.withWorkspace(() => this.saveCheckpoint(botId));
          result = {operationId,status:"completed",checkpointId:checkpoint.id,checkpointStatus:'saved'};
        } else {
          const response = await this.dispatchAction(botId,operationId,action);
          if (!response.ok) throw new Error(`Computer rejected action (${response.status})`);
          const value = await response.json<ContainerResult>();
          result = {operationId,status:value.status,output:value.output,exitCode:value.exitCode,error:value.error};
          if (value.artifactName) {
            operationStage = "artifact_read";
            if (!/^[a-f0-9-]{36}\.png$/.test(value.artifactName)) throw new Error("Invalid screenshot artifact reference");
            const artifact = await this.call(`/artifacts/${value.artifactName}`);
            if (!artifact.ok || !artifact.body) throw new Error("Screenshot could not be read");
            const artifactId = crypto.randomUUID();
            operationStage = "artifact_store";
            this.active();
            await this.env.FILES.put(`bots/${botId}/artifacts/${artifactId}`, artifact.body, {httpMetadata:{contentType:"image/png"}});
            result.artifactId = artifactId;
            result.mimeType = "image/png";
          }
          // Terminal commands can mutate files even on nonzero exit. Confirm a
          // portable checkpoint before acknowledging these filesystem operations.
          if (action.type === "writeFile" || action.type === "gitClone") {
            operationStage = "checkpoint";
            try { result.checkpointId = (await this.withWorkspace(() => this.saveCheckpoint(botId))).id;result.checkpointStatus='saved'; }
            catch(error) {
              const failure=safeError(error);
              console.error("computer.failure",{stage:"checkpoint",code:failure.code});
              result=await this.recordCheckpointFailure(operationId,result,failure);
            }
          }
        }
      } catch (error) {
        console.error("computer.failure", {stage:operationStage,code:safeError(error).code});
        result = action.type==="checkpoint" && error instanceof ComputerProviderError
          ? {operationId,status:"failed",error:error.publicMessage}
          : error instanceof ComputerProviderError && error.code==="computer_git_unavailable"
          ? {operationId,status:"failed",error:`${error.publicMessage} No Git action was executed.`}
          : {operationId,status:"interrupted",error:"Computer connection or persistence failed; the action may have completed. Inspect effects before submitting a new operation."};
      }
      this.active();
      await this.ctx.storage.put<OperationRecord>(key, {...await this.ctx.storage.get<OperationRecord>(key),digest,result});
      // The effect's outcome is now durable. Failure to renew its idle lifetime
      // must not replace that known result with an uncertain transport failure.
      try { await this.touch(); }
      catch (error) {
        console.error("computer.failure", {stage:"post_result_touch",code:safeError(error).code});
      }
      return result;
    }).finally(() => this.flights.delete(flightKey));
    this.flights.set(flightKey, work);
    return work;
  }

  private validExecution(processId:string,yieldMs=0):void {
    if(typeof processId!=='string' || !/^[A-Za-z0-9:_.-]{1,160}$/.test(processId) || !Number.isSafeInteger(yieldMs) || yieldMs<0 || yieldMs>30_000) throw new ComputerProviderError('computer_invalid_request');
  }

  private withExecUpdate<T>(processId:string,work:()=>Promise<T>):Promise<T> {
    const result=(this.execUpdates.get(processId)??Promise.resolve()).then(()=>{this.active();return work();});
    const tail=result.catch(()=>{});
    this.execUpdates.set(processId,tail);
    void tail.then(()=>{if(this.execUpdates.get(processId)===tail) this.execUpdates.delete(processId);});
    return result;
  }

  private async storeExecution(processId:string,session:ExecSession):Promise<void> {
    this.active();
    const previous=await this.ctx.storage.get<OperationRecord>(`operation:${processId}`);
    await this.ctx.storage.put({[`exec-session:${processId}`]:session,[`operation:${processId}`]:{...previous,digest:session.digest,processId,result:session.result} satisfies OperationRecord});
  }

  private async hasActiveExecutions():Promise<boolean> {
    return [...(await this.ctx.storage.list<ExecSession>({prefix:'exec-session:'})).values()].some(session=>session.result.status==='running');
  }

  private async needsExecutionMaintenance():Promise<boolean> {
    return [...(await this.ctx.storage.list<ExecSession>({prefix:'exec-session:'})).values()].some(session=>session.result.status==='running' || session.checkpoint==='pending');
  }

  private executionResult(session:ExecSession,operationId:string):ComputerResult {
    const result={...session.result,operationId};
    if(result.status!=='running' && session.checkpoint!=='done') result.checkpointStatus='pending';
    return result;
  }

  private async updateExecution(processId:string,value:ComputerResult,lost=false):Promise<ExecSession> {
    return this.withExecUpdate(processId,async()=>{
      const session=await this.ctx.storage.get<ExecSession>(`exec-session:${processId}`);
      if(!session) throw new ComputerProviderError('computer_unavailable');
      // HTTP polls may finish out of order. A stale running snapshot can never
      // replace a known terminal outcome or shrink accumulated output.
      if(session.result.status==='running') {
        session.result={...value,operationId:processId,processId,
          output:(value.output?.length??0)<(session.result.output?.length??0)?session.result.output:value.output};
        if(lost) session.checkpoint='done';
        await this.storeExecution(processId,session);
      }
      return session;
    });
  }

  private async executionRequest(operationId:string,action:ComputerAction,yieldMs:number):Promise<ComputerResult> {
    const timeout=new AbortController(),timer=setTimeout(()=>timeout.abort(),yieldMs+10_000);
    try {
      const response=await this.call('/actions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operationId,action}),signal:timeout.signal});
      if(!response.ok) {
        if(response.status===409) {
          const body=await response.json<{error?:{code?:string}}>().catch(()=>undefined);
          if(body?.error?.code==='computer_idempotency_conflict') throw new ComputerProviderError('computer_idempotency_conflict');
        }
        throw new ComputerProviderError('computer_unavailable');
      }
      const result=await response.json<ComputerResult>();
      if(!['running','completed','failed','interrupted','cancelled'].includes(result.status) || (result.output!==undefined && typeof result.output!=='string')) throw new ComputerProviderError('computer_unavailable');
      return result;
    } finally {clearTimeout(timer);}
  }

  private async startExecution(botId:string,processId:string,action:Extract<ComputerAction,{type:'exec'}>):Promise<ComputerResult> {
    const yieldMs=action.yieldMs===undefined?1000:action.yieldMs;
    this.validExecution(processId,yieldMs);
    if(typeof action.command!=='string' || !action.command || action.command.length>32768 || (action.timeoutMs!==undefined && (!Number.isSafeInteger(action.timeoutMs) || action.timeoutMs<=0))) throw new ComputerProviderError('computer_invalid_request');
    // Waiting is a read preference, so changing yieldMs never changes the effect.
    const digest=await sha256(stableAction({type:'exec',command:action.command,...(action.timeoutMs===undefined?{}:{timeoutMs:action.timeoutMs})}));
    const prepared=await this.serialize(async()=>{
      this.active();
      const existing=await this.ctx.storage.get<OperationRecord>(`operation:${processId}`);
      if(existing) {
        if(existing.digest!==digest) return {operationId:processId,status:'failed' as const,error:'operationId was already used with different arguments'};
        if(!existing.processId) return existing.result??{operationId:processId,status:'interrupted' as const,error:'Operation outcome is unknown; it will not be replayed'};
        return undefined;
      }
      if(await this.ctx.storage.get(`exec-cancelled:${processId}`)) return {operationId:processId,processId,status:'cancelled' as const,output:''};
      if(await this.live.controlled()) return {operationId:processId,status:'failed' as const,error:'A person has control of the desktop. No action was executed. Release desktop control before issuing a new action.'};
      const health=await this.ensureReady(botId);
      if(!health.capabilities?.includes('execSessions')) throw new ComputerProviderError('computer_upgrade_required');
      await this.touch();
      const dispatch=await this.withExecUpdate(processId,async()=>{
        if(await this.ctx.storage.get(`exec-cancelled:${processId}`)) return false;
        const session:ExecSession={digest,bootId:health.bootId,dispatched:true,checkpoint:'pending',result:{operationId:processId,processId,status:'running',output:''}};
        await this.ctx.storage.transaction(async txn=>{
          if(await txn.get(`operation:${processId}`)) throw new ComputerProviderError('computer_idempotency_conflict');
          await txn.put({[`exec-session:${processId}`]:session,[`operation:${processId}`]:{digest,processId,result:session.result} satisfies OperationRecord});
        });
        return true;
      });
      if(!dispatch) return {operationId:processId,processId,status:'cancelled' as const,output:''};
      await this.markCheckpointDirty(processId,health.bootId);
      // Admission is short. The process owns its lifetime, not this request.
      try { await this.updateExecution(processId,await this.executionRequest(processId,{...action,yieldMs:0},0)); }
      catch(error) {
        this.active();
        if(error instanceof ComputerProviderError && error.code==='computer_idempotency_conflict') {
          await this.updateExecution(processId,{operationId:processId,processId,status:'failed',error:error.publicMessage},true);
          throw error;
        }
        console.error('computer.failure',{stage:'exec_admission',code:safeError(error).code});
      }
      await this.ctx.storage.setAlarm(Date.now()+EXEC_POLL_MS);
      return undefined;
    });
    if(prepared) return prepared;
    return this.pollExecution(botId,processId,processId,yieldMs);
  }

  private async pollExecution(botId:string,operationId:string,processId:string,yieldMs:number,finalize=true):Promise<ComputerResult> {
    this.validExecution(processId,yieldMs);
    this.active();
    let session=await this.ctx.storage.get<ExecSession>(`exec-session:${processId}`);
    if(!session) {
      const cancelled=!!await this.ctx.storage.get(`exec-cancelled:${processId}`);
      return {operationId,processId,processKnown:cancelled,status:cancelled?'cancelled':'interrupted',error:cancelled?undefined:'Execution session is unavailable; inspect its effects before creating another operation.'};
    }
    if(session.result.status==='running') {
      const lost=async()=>this.updateExecution(processId,{operationId:processId,processId,status:'interrupted',output:session!.result.output,error:'The execution computer was restarted or stopped. Inspect its effects before creating another operation. Uncheckpointed files may have been lost.'},true);
      if(!this.container?.running) session=await lost();
      else {
        const health=await this.health();
        if(health.bootId!==session.bootId || !health.capabilities?.includes('execSessions')) session=await lost();
        else {
          await this.touch();
          session=await this.updateExecution(processId,await this.executionRequest(operationId,{type:'execPoll',processId,yieldMs},yieldMs));
        }
      }
    }
    if(finalize && session.result.status!=='running' && session.checkpoint==='pending') {
      await this.finalizeExecutions(botId);
      session=(await this.ctx.storage.get<ExecSession>(`exec-session:${processId}`))??session;
    }
    return this.executionResult(session,operationId);
  }

  private async cancelExecution(botId:string,operationId:string,processId:string,journal=true):Promise<ComputerResult> {
    this.validExecution(processId);
    this.active();
    const digest=journal?await sha256(stableAction({type:'execCancel',processId})):undefined;
    const prepared=await this.withExecUpdate(processId,()=>this.ctx.storage.transaction(async txn=>{
      if(journal) {
        const previous=await txn.get<OperationRecord>(`operation:${operationId}`);
        if(previous && (previous.digest!==digest || previous.conflict)) throw new ComputerProviderError('computer_idempotency_conflict');
        if(previous?.result && previous.result.status!=='running') return {result:previous.result};
        if(!previous) await txn.put(`operation:${operationId}`,{digest,processId});
      }
      // The control reservation and cancellation intent are one durable write.
      // Recovery never observes an admitted cancel without its wakeable intent.
      await txn.put<ExecCancellation>(`exec-cancelled:${processId}`,{operationId,journal});
      return {session:await txn.get<ExecSession>(`exec-session:${processId}`)};
    }));
    if(prepared.result) return prepared.result;
    const session=prepared.session;
    let result:ComputerResult;
    if(!session || !session.dispatched) result={operationId,processId,status:'cancelled',output:''};
    else if(session.result.status!=='running') result=this.executionResult(session,operationId);
    else if(!this.container?.running) result=await this.pollExecution(botId,operationId,processId,0,false);
    else {
      const health=await this.health();
      if(health.bootId!==session.bootId || !health.capabilities?.includes('execSessions')) result=await this.pollExecution(botId,operationId,processId,0,false);
      else {
        const controlId=journal?operationId:`exec-cancel:${await sha256(processId)}`;
        try {result=this.executionResult(await this.updateExecution(processId,await this.executionRequest(controlId,{type:'execCancel',processId},0)),operationId);}
        catch(error) {
          if(error instanceof ComputerProviderError && error.code==='computer_idempotency_conflict') {
            await this.withExecUpdate(processId,async()=>{
              const intent=await this.ctx.storage.get<ExecCancellation>(`exec-cancelled:${processId}`);
              if(intent?.operationId===operationId && intent.journal===journal) await this.ctx.storage.delete(`exec-cancelled:${processId}`);
              if(digest) await this.ctx.storage.put(`operation:${operationId}`,{digest,processId,conflict:true});
            });
          }
          throw error;
        }
      }
    }
    if(digest) {this.active();await this.ctx.storage.put(`operation:${operationId}`,{digest,processId,result});}
    // Stop never queues behind a checkpoint upload. The alarm owns finalization.
    if(await this.needsExecutionMaintenance()) await this.ctx.storage.setAlarm(Date.now()+1_000);
    return result;
  }

  private finalizeExecutions(botId:string):Promise<void> {
    this.finalizingExecutions??=this.serialize(()=>this.withWorkspace(async()=>{
      if(await this.hasActiveExecutions()) return;
      const pending=[...(await this.ctx.storage.list<ExecSession>({prefix:'exec-session:'}))].filter(([,session])=>session.checkpoint==='pending');
      if(!pending.length) return;
      const attemptId=crypto.randomUUID();
      for(const [key,session] of pending) {session.checkpoint='attempting';session.checkpointAttemptId=attemptId;await this.storeExecution(key.slice('exec-session:'.length),session);}
      let checkpoint:Checkpoint|undefined,failure:ComputerProviderError|undefined;
      try {
        if(!this.container?.running) throw new ComputerProviderError('computer_checkpoint_failed');
        const health=await this.health();
        if(pending.some(([,session])=>session.bootId!==health.bootId)) throw new ComputerProviderError('computer_checkpoint_failed');
        checkpoint=await this.saveCheckpoint(botId,false,attemptId);
      } catch(error) {failure=safeError(error);console.error('computer.failure',{stage:'checkpoint',code:failure.code});}
      for(const [key,session] of pending) {
        session.checkpoint='done';
        if(checkpoint) {session.result.checkpointId=checkpoint.id;session.result.checkpointStatus='saved';}
        else session.result=await this.recordCheckpointFailure(key.slice('exec-session:'.length),session.result,failure!);
        await this.storeExecution(key.slice('exec-session:'.length),session);
      }
      try {await this.touch();} catch(error) {this.active();console.error('computer.failure',{stage:'post_result_touch',code:safeError(error).code});}
    })).finally(()=>{this.finalizingExecutions=undefined;});
    return this.finalizingExecutions;
  }

  private async markCheckpointDirty(operationId:string,bootId:string):Promise<void> {
    this.active();
    await this.ctx.storage.transaction(async txn=>{
      const record=await txn.get<OperationRecord>(`operation:${operationId}`);
      if(!record || record.checkpoint) return;
      const revision=(await txn.get<number>('checkpointRevision')??0)+1;
      const previous=await txn.get<CheckpointRetry>('checkpointRetry');
      const retry:CheckpointRetry=previous?.bootId===bootId?{...previous,revision,blocked:false}:{bootId,revision,attempts:0,nextAttemptAt:Date.now()};
      record.checkpoint={bootId,revision};
      await txn.put({[`operation:${operationId}`]:record,checkpointRevision:revision,checkpointRetry:retry});
      await txn.setAlarm(Date.now()+1_000);
    });
  }

  private async recordCheckpointFailure(operationId:string,result:ComputerResult,failure:ComputerProviderError):Promise<ComputerResult> {
    const record=await this.ctx.storage.get<OperationRecord>(`operation:${operationId}`);
    const retry=await this.ctx.storage.get<CheckpointRetry>('checkpointRetry');
    const warning=failure.code!=='computer_checkpoint_persist_failed' || !retry || retry.blocked || retry.attempts>=3
      ? `The action finished, but its files are not yet checkpointed. ${failure.publicMessage} Do not repeat the action to save its files.` : undefined;
    let error=result.error;
    if(record?.checkpoint?.warning && error?.endsWith(record.checkpoint.warning)) error=error.slice(0,-record.checkpoint.warning.length).trimEnd()||undefined;
    const value={...result,checkpointStatus:retry && !retry.blocked?'pending' as const:'failed' as const,error:warning?`${error?error+' ':''}${warning}`:error};
    if(record?.checkpoint) {record.checkpoint.warning=warning;record.result=value;this.active();await this.ctx.storage.put(`operation:${operationId}`,record);}
    return value;
  }

  private async scheduleComputerAlarm(fallback:number):Promise<void> {
    this.active();
    const retry=await this.ctx.storage.get<CheckpointRetry>('checkpointRetry');
    const active=await this.hasActiveExecutions();
    const execution=active || await this.needsExecutionMaintenance();
    const deadline=retry && !retry.blocked && !active?Math.max(Date.now()+100,retry.nextAttemptAt):Infinity;
    this.active();
    await this.ctx.storage.setAlarm(Math.min(fallback,execution?Date.now()+EXEC_POLL_MS:Infinity,deadline));
  }

  private checkpointDiagnostic(phase:'archive_upload'|'pointer_publish'|'retry_intent'|'candidate_lookup',error:unknown):void {
    const message=error instanceof Error?error.message:'';
    const cause=phase==='pointer_publish' || phase==='retry_intent'?'metadata_write'
      :/known length/i.test(message)?'stream_length'
      :/checksum|digest mismatch/i.test(message)?'checksum'
      :/429|too many|rate.?limit/i.test(message)?'rate_limit'
      :/network|disconnect|connection|fetch failed|socket/i.test(message)?'transport':'unknown';
    console.error('computer.checkpoint_failure',{phase,cause});
  }

  private async deferCheckpoint(failure:ComputerProviderError):Promise<boolean> {
    const retry=await this.ctx.storage.get<CheckpointRetry>('checkpointRetry');
    if(!retry) return false;
    const retryable=failure.status>=500 || failure.code==='computer_execution_active' || failure.code==='computer_checkpoint_changed';
    retry.attempts=Math.min(retry.attempts+1,32);
    retry.nextAttemptAt=Date.now()+Math.min(60_000,1000*2**Math.min(retry.attempts-1,6));
    retry.blocked=!retryable;retry.errorCode=failure.code;
    this.active();
    try {
      await this.ctx.storage.put('checkpointRetry',retry);
      for(const [key,record] of await this.ctx.storage.list<OperationRecord>({prefix:'operation:'})) {
        if(record.checkpoint?.bootId!==retry.bootId || !record.result || record.result.status==='running') continue;
        const processId=key.slice('operation:'.length),result=await this.recordCheckpointFailure(processId,record.result,failure);
        if(record.processId===processId) {
          const session=await this.ctx.storage.get<ExecSession>(`exec-session:${processId}`);
          if(session) {session.result=result;await this.storeExecution(processId,session);}
        }
      }
      await this.scheduleComputerAlarm(Date.now()+IDLE_MS);
    }
    catch(error) {this.checkpointDiagnostic('retry_intent',error);throw new ComputerProviderError('computer_checkpoint_persist_failed');}
    return retryable;
  }

  private async publishCheckpoint(checkpoint:Checkpoint):Promise<void> {
    this.active();
    try {
      await this.ctx.storage.transaction(async txn=>{
        await txn.put('lastCheckpoint',checkpoint);
        const operations=await txn.list<OperationRecord>({prefix:'operation:'});
        for(const [key,record] of operations) {
          const pending=record.checkpoint;
          if(!pending || pending.bootId!==checkpoint.bootId || pending.revision>(checkpoint.revision??-1)) continue;
          if(record.result) {
            let error=record.result.error;
            if(pending.warning && error?.endsWith(pending.warning)) error=error.slice(0,-pending.warning.length).trimEnd()||undefined;
            record.result={...record.result,checkpointId:checkpoint.id,checkpointStatus:'saved',error};
          }
          delete record.checkpoint;
          await txn.put(key,record);
          const processId=key.slice('operation:'.length);
          if(record.processId===processId) {
            const session=await txn.get<ExecSession>(`exec-session:${processId}`);
            if(session && session.result.status!=='running') {session.checkpoint='done';session.result=record.result??{...session.result,checkpointId:checkpoint.id,checkpointStatus:'saved'};await txn.put(`exec-session:${processId}`,session);}
          }
        }
        const retry=await txn.get<CheckpointRetry>('checkpointRetry');
        if(retry && retry.bootId===checkpoint.bootId) {
          if(retry.revision<=(checkpoint.revision??-1)) await txn.delete('checkpointRetry');
          else {delete retry.candidate;retry.attempts=0;retry.blocked=false;retry.nextAttemptAt=Date.now();await txn.put('checkpointRetry',retry);}
        }
      });
    } catch(error) {this.checkpointDiagnostic('pointer_publish',error);throw new ComputerProviderError('computer_checkpoint_persist_failed');}
  }

  private async recoverCheckpointCandidate():Promise<Checkpoint|undefined> {
    const retry=await this.ctx.storage.get<CheckpointRetry>('checkpointRetry');
    const candidate=retry?.candidate;
    if(!retry || !candidate) return undefined;
    const published=await this.ctx.storage.get<Checkpoint>('lastCheckpoint');
    if(published?.id===candidate.id) {await this.publishCheckpoint(candidate);return candidate;}
    let object:R2Object|null;
    try {object=await this.env.FILES.head(candidate.key);}
    catch(error) {this.checkpointDiagnostic('candidate_lookup',error);throw new ComputerProviderError('computer_checkpoint_persist_failed');}
    if(object) {
      const checksum=object.checksums.sha256;
      const actual=checksum?Array.from(new Uint8Array(checksum),byte=>byte.toString(16).padStart(2,'0')).join(''):undefined;
      if(object.size!==candidate.size || actual!==candidate.sha256) throw new ComputerProviderError('computer_checkpoint_integrity_failed');
      await this.publishCheckpoint(candidate);return candidate;
    }
    delete retry.candidate;
    this.active();await this.ctx.storage.put('checkpointRetry',retry);
    return undefined;
  }

  private async abandonCheckpoint():Promise<void> {
    const retry=await this.ctx.storage.get<CheckpointRetry>('checkpointRetry');
    if(!retry) return;
    const failure=new ComputerProviderError('computer_checkpoint_lost');
    retry.blocked=true;retry.errorCode=failure.code;
    await this.ctx.storage.put('checkpointRetry',retry);
    for(const [key,record] of await this.ctx.storage.list<OperationRecord>({prefix:'operation:'})) {
      if(record.checkpoint?.bootId!==retry.bootId || !record.result) continue;
      const result=await this.recordCheckpointFailure(key.slice('operation:'.length),record.result,failure);
      if(record.processId===key.slice('operation:'.length)) {
        const session=await this.ctx.storage.get<ExecSession>(`exec-session:${record.processId}`);
        if(session) {session.result=result;session.checkpoint='done';await this.storeExecution(record.processId,session);}
      }
    }
  }

  private async retryCheckpoint(botId:string):Promise<void> {
    await this.serialize(()=>this.withWorkspace(async()=>{
      const retry=await this.ctx.storage.get<CheckpointRetry>('checkpointRetry');
      if(!retry || retry.blocked || retry.nextAttemptAt>Date.now() || await this.hasActiveExecutions()) return;
      try {
        await this.recoverCheckpointCandidate();
        if(!await this.ctx.storage.get('checkpointRetry')) return;
        if(!this.container?.running || (await this.health()).bootId!==retry.bootId) {await this.abandonCheckpoint();return;}
        await this.saveCheckpoint(botId);
      } catch(error) {
        this.active();console.error('computer.failure',{stage:'checkpoint_retry',code:safeError(error).code});
        await this.deferCheckpoint(safeError(error));
      }
    }));
  }

  private async touch(): Promise<void> {
    this.active();
    await this.ctx.storage.put("lastActivity", Date.now());
    this.active();
    await this.scheduleComputerAlarm(Date.now()+IDLE_MS);
    this.active();
    if (this.container?.running) await stage("computer_lifecycle_failed", () => this.container!.setInactivityTimeout(SAFETY_TIMEOUT_MS));
  }

  private async dispatchAction(botId:string,operationId:string,action:ComputerAction):Promise<Response> {
    if(action.type!=="gitClone" && action.type!=="gitPush") return this.call("/actions", {
      method:"POST",body:JSON.stringify({operationId,action}),headers:{"Content-Type":"application/json"},
    });
    const binding=this.env.GITHUB;
    if(!binding) throw new ComputerProviderError("computer_git_unavailable");
    const github=binding.get(binding.idFromName("owner"));
    let transport:GitTransport;
    try {
      const response=await github.fetch("https://github.internal/git-capability", {
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({botId,repository:action.repository,permission:action.type==="gitClone"?"read":"write"}),
      });
      if(!response.ok) throw new ComputerProviderError("computer_git_unavailable");
      transport=await response.json<GitTransport>();
      if(typeof transport.id!=="string" || !/^[A-Za-z0-9_-]{1,160}$/.test(transport.id) || typeof transport.token!=="string" || typeof transport.url!=="string") throw new ComputerProviderError("computer_git_unavailable");
    } catch {throw new ComputerProviderError("computer_git_unavailable");}
    try {
      // Credential material is a private envelope, never part of the public
      // action, digest, journal, checkpoint or result.
      return await this.call("/actions", {method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({operationId,action,gitTransport:{url:transport.url,token:transport.token}})});
    } finally {
      try {await github.fetch(`https://github.internal/git-capability/${transport.id}`,{method:"DELETE"});}
      catch {console.error("computer.failure",{stage:"git_capability_revoke",code:"computer_git_unavailable"});}
    }
  }

  private async preview(request:Request):Promise<Response> {
    this.active();
    const url=new URL(request.url);
    const match=/^\/preview\/([0-9]{1,5})(\/.*)$/.exec(url.pathname);
    const port=match?Number(match[1]):0;
    if(!match || port<1024 || port>65535 || [PORT,5900,5901,6080,6081].includes(port)) throw new ComputerProviderError("computer_invalid_request");
    const botId=request.headers.get("x-timber-bot-id");
    if(!botId || !/^[A-Za-z0-9_-]{1,100}$/.test(botId)) throw new ComputerProviderError("computer_invalid_request");
    const owner=await this.ctx.storage.get<string>("botId");
    if(owner!==botId) throw new ComputerProviderError("computer_owner_mismatch");
    this.active();
    const container=this.container;
    if(!container?.running) throw new ComputerProviderError("computer_app_not_running");
    const headers=new Headers(request.headers);
    for(const name of [...headers.keys()]) if(name.toLowerCase()==="authorization" || /^x-(?:timber|botspace)-/i.test(name)) headers.delete(name);
    headers.set("Host",`localhost:${port}`);
    const target=`http://127.0.0.1:${port}${match[2]}${url.search}`;
    const response=await container.getTcpPort(port).fetch(new Request(target,{method:request.method,headers,
      ...(["GET","HEAD"].includes(request.method)?{}:{body:request.body}),redirect:"manual",signal:request.signal}));
    // Preserve native WebSocket responses. Preview reads reuse this running
    // computer, but can neither start a VM nor replay a write on failure.
    if(response.status<400) {
      try {await this.touch();}
      catch {console.error("computer.failure",{stage:"preview_touch",code:"computer_lifecycle_failed"});}
    }
    return response;
  }

  async alarm(): Promise<void> {
    if(this.deleted) {await this.ctx.storage.deleteAlarm();return;}
    const botId=await this.ctx.storage.get<string>('botId');
    if(botId && await this.needsExecutionMaintenance()) {
      try {
        for(const [key,session] of await this.ctx.storage.list<ExecSession>({prefix:'exec-session:'})) {
          if(session.result.status==='running') {
            const processId=key.slice('exec-session:'.length);
            const intent=await this.ctx.storage.get<ExecCancellation|true>(`exec-cancelled:${processId}`);
            if(intent) await this.cancelExecution(botId,intent===true?processId:intent.operationId,processId,intent===true?false:intent.journal);
            await this.pollExecution(botId,processId,processId,0,false);
          }
        }
        await this.finalizeExecutions(botId);
      } catch { /* Keep a durable wake for unavailable process status or checkpointing. */ }
      if(!this.deleted && await this.needsExecutionMaintenance()) { await this.scheduleComputerAlarm(Date.now()+EXEC_POLL_MS);return; }
    }
    if(botId) await this.retryCheckpoint(botId);
    const checkpointRetry=await this.ctx.storage.get<CheckpointRetry>('checkpointRetry');
    if(checkpointRetry && !checkpointRetry.blocked) {await this.scheduleComputerAlarm(Date.now()+IDLE_MS);return;}
    await this.serialize(() => this.withWorkspace(async () => {
      if(this.deleted) return;
      const lastActivity = await this.ctx.storage.get<number>("lastActivity") ?? 0;
      if (Date.now() - lastActivity < IDLE_MS) {
        await this.ctx.storage.setAlarm(lastActivity + IDLE_MS);
        return;
      }
      if (!this.container?.running) return;
      const botId = await this.ctx.storage.get<string>("botId");
      if (!botId) return;
      try {
        await this.initializeWorkspace(botId);
        await this.saveCheckpoint(botId, true);
        await this.container.destroy("Idle computer checkpointed");
        this.desktop = false;
        this.workspaceHealth = undefined;
      } catch {
        // Do not intentionally discard an uncheckpointed filesystem. A later
        // infrastructure failure can still lose it; this is not a live volume.
        if(!this.deleted) await this.ctx.storage.setAlarm(Date.now() + 60_000);
      }
    }));
  }

  private call(path: string, init: RequestInit = {}): Promise<Response> {
    this.active();
    if (!this.container) throw new ComputerProviderError("computer_not_configured");
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.token}`);
    return this.container.getTcpPort(PORT).fetch(`http://computer${path}`, {...init,headers,signal:init.signal?AbortSignal.any([init.signal,this.shutdown.signal]):this.shutdown.signal});
  }

  private async health(): Promise<Health> {
    const response = await this.call("/health", {signal:AbortSignal.timeout(2000)});
    if (!response.ok) throw new Error("Computer is not ready");
    const health = await response.json<Health>();
    if (health.ok !== true || typeof health.bootId !== "string" || !health.bootId || typeof health.desktop !== "boolean") throw new Error("Invalid computer health");
    return health;
  }

  private ensureReady(botId: string): Promise<Health> {
    return this.withWorkspace(() => this.initializeWorkspace(botId));
  }

  /** Called only inside the workspace gate: restoration cannot race a read. */
  private initializeWorkspace(botId: string): Promise<Health> {
    this.active();
    this.workspaceHealth = undefined;
    this.starting ??= this.startAndRestore(botId).then(async health => {
      this.active();
      await this.ctx.storage.delete("startupFailure");
      this.workspaceHealth = health;
      return health;
    }, async error => {
      const failure = safeError(error);
      this.desktop = false;
      if(!this.deleted) await this.ctx.storage.put("startupFailure",failure.code);
      throw failure;
    }).finally(() => { this.starting = undefined; });
    return this.starting;
  }

  private async startAndRestore(botId: string): Promise<Health> {
    this.active();
    const container = this.container;
    if (!container) throw new ComputerProviderError("computer_not_configured");
    const bootstrap = this.env.COMPUTER_BOOTSTRAP === "true";
    let started = false;
    if (!container.running) {
      const image = bootstrap ? "cloudflare/debian-trixie" : container.images.base;
      if (!image) throw new ComputerProviderError("computer_image_missing");
      try {
        container.start({image,instance:"standard-1",enableInternet:true,
          ...(bootstrap ? {entrypoint:["sleep","infinity"]} : {}),
          env:{BOTSPACE_COMPUTER_TOKEN:this.token,DISPLAY:":99",BOTSPACE_WORKSPACE:"/workspace",BOTSPACE_STATE:"/state"},
        });
      } catch {
        throw new ComputerProviderError("computer_start_failed");
      }
      started = true;
    }
    await stage("computer_lifecycle_failed", () => container.setInactivityTimeout(SAFETY_TIMEOUT_MS));
    if (bootstrap) {
      try { await this.health(); }
      catch { await this.bootstrap(); }
    }
    let health: Health | undefined;
    for (let attempt = 0; attempt < 120; attempt++) {
      this.active();
      try { health = await this.health(); break; }
      catch { await new Promise(resolve => setTimeout(resolve,250)); }
    }
    if (!health) throw new ComputerProviderError("computer_not_ready");
    this.active();
    this.desktop = health.desktop;
    this.capabilities=health.capabilities??[];
    const storedBoot = await this.ctx.storage.get<string>("restoredBoot");
    this.active();
    if (storedBoot !== health.bootId) {
      // An upload may have completed before the pointer write was interrupted.
      // Recover it before deciding which saved workspace a new computer restores.
      await this.recoverCheckpointCandidate();
      const retry=await this.ctx.storage.get<CheckpointRetry>('checkpointRetry');
      if(retry && retry.bootId!==health.bootId) await this.abandonCheckpoint();
      const checkpoint = await this.ctx.storage.get<Checkpoint>("lastCheckpoint");
      if (checkpoint) {
        const object = await stage("computer_restore_failed", () => this.env.FILES.get(checkpoint.key));
        if (!object) throw new ComputerProviderError("computer_restore_missing");
        // FixedLengthStream lets workerd emit Content-Length rather than chunked
        // transfer encoding, and rejects truncated objects while streaming.
        const transfer = new FixedLengthStream(object.size);
        const [response] = await stage("computer_restore_failed", () => Promise.all([
          this.call("/restore", {method:"POST",body:transfer.readable,
            headers:{"Content-Type":"application/gzip","X-Content-SHA256":checkpoint.sha256}}),
          object.body.pipeTo(transfer.writable),
        ]));
        if (!response.ok) throw new ComputerProviderError("computer_restore_failed");
      }
      this.active();
      await this.ctx.storage.put("restoredBoot",health.bootId);
    }
    if (started) await this.touch();
    return health;
  }

  private async bootstrap(): Promise<void> {
    this.active();
    const container = this.container!;
    await stage("computer_provisioning_failed", async () => {
      // GNU timeout stops the complete apt process group. Timing out only the
      // JavaScript wait or its parent shell would leave package installs running.
      const install = await container.exec(["timeout","--kill-after=5","240","sh","-c", "mkdir -p /workspace /state /opt/botspace; if ! test -f /opt/botspace/desktop-ready; then export DEBIAN_FRONTEND=noninteractive; apt-get update > /state/bootstrap.log 2>&1 && apt-get install -y --no-install-recommends python3 chromium xvfb xdotool xclip scrot openbox fonts-liberation ca-certificates curl git procps x11vnc python3-websockify >> /state/bootstrap.log 2>&1 && touch /opt/botspace/desktop-ready; fi"]);
      const {exitCode} = await install.output();
      if (exitCode === 124) throw new ComputerProviderError("computer_start_timeout");
      if (exitCode !== 0) throw new ComputerProviderError("computer_provisioning_failed");
    });
    for (const [path, source] of [["/opt/botspace/server.py",serverSource],["/opt/botspace/start.sh",startSource],["/opt/botspace/workspace.py",workspaceSource],["/opt/botspace/desktop_bridge.py",desktopSource]] as const) {
      this.active();
      await stage("computer_server_install_failed", async () => {
        const process = await container.exec(["timeout","--kill-after=5","30","python3","-c","import pathlib,sys; pathlib.Path(sys.argv[1]).write_bytes(sys.stdin.buffer.read())",path], {
          stdin:new ReadableStream<Uint8Array>({start(controller) {controller.enqueue(encoder.encode(source));controller.close();}}),
        });
        if ((await process.output()).exitCode !== 0) throw new ComputerProviderError("computer_server_install_failed");
      });
    }
    this.active();
    await stage("computer_server_start_failed", async () => {
      const process = await container.exec(["timeout","--kill-after=5","30","sh","-c","nohup sh /opt/botspace/start.sh > /state/server.log 2>&1 < /dev/null &"],{
        env:{BOTSPACE_COMPUTER_TOKEN:this.token,DISPLAY:":99",BOTSPACE_WORKSPACE:"/workspace",BOTSPACE_STATE:"/state"},
      });
      if ((await process.output()).exitCode !== 0) throw new ComputerProviderError("computer_server_start_failed");
    });
  }

  private async saveCheckpoint(botId: string, quiesce = false, checkpointId?:string): Promise<Checkpoint> {
    this.active();
    if(await this.hasActiveExecutions()) throw new ComputerProviderError('computer_execution_active');
    const bootId=await this.ctx.storage.get<string>('restoredBoot');
    if(!bootId) throw new ComputerProviderError('computer_checkpoint_failed');
    let retry!:CheckpointRetry;
    try {
      await this.ctx.storage.transaction(async txn=>{
        const existing=await txn.get<CheckpointRetry>('checkpointRetry');
        const revision=(await txn.get<number>('checkpointRevision')??0)+1;
        // Every explicit capture includes current files, even if a previous
        // upload can be recovered. Desktop/background writers have no tool ID.
        retry=existing?.bootId===bootId?{...existing,revision,blocked:false}:{bootId,revision,attempts:0,nextAttemptAt:Date.now()};
        await txn.put({checkpointRevision:revision,checkpointRetry:retry});
      });
      await this.scheduleComputerAlarm(Date.now()+1_000);
    }
    catch(error) {this.checkpointDiagnostic('retry_intent',error);throw new ComputerProviderError('computer_checkpoint_persist_failed');}
    for(let attempt=0;attempt<2;attempt++) {
      try {
        const recovered=await this.recoverCheckpointCandidate();
        const current=await this.ctx.storage.get<CheckpointRetry>('checkpointRetry');
        if(!current) {
          const saved=recovered??await this.ctx.storage.get<Checkpoint>('lastCheckpoint');
          if(saved?.bootId===bootId && (saved.revision??-1)>=retry.revision) return saved;
          throw new ComputerProviderError('computer_checkpoint_persist_failed');
        }
        const response=await stage('computer_checkpoint_failed',()=>this.call('/checkpoint',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({quiesce})}));
        if(!response.ok) throw await checkpointResponseError(response);
        if(!response.body) throw new ComputerProviderError('computer_checkpoint_failed');
        const size=Number(response.headers.get('Content-Length')),checksum=response.headers.get('X-Content-SHA256')??'';
        if(!Number.isSafeInteger(size) || size<=0 || size>256*1024*1024 || !/^[a-f0-9]{64}$/.test(checksum)) throw new ComputerProviderError('computer_checkpoint_integrity_failed');
        const id=attempt===0 && checkpointId?checkpointId:crypto.randomUUID();
        const checkpoint:Checkpoint={id,key:`bots/${botId}/checkpoints/${id}.tar.gz`,size,sha256:checksum,createdAt:new Date().toISOString(),bootId,revision:current.revision};
        current.candidate=checkpoint;
        try {this.active();await this.ctx.storage.put('checkpointRetry',current);}
        catch(error) {this.checkpointDiagnostic('retry_intent',error);await response.body.cancel().catch(()=>{});throw new ComputerProviderError('computer_checkpoint_persist_failed');}
        // A Content-Length header is not sufficient to give a JS/tunnel stream
        // a known length. Preserve streaming and enforce the byte count for R2.
        const transfer=new FixedLengthStream(size),abort=new AbortController();
        const upload=Promise.resolve().then(()=>this.env.FILES.put(checkpoint.key,transfer.readable,{httpMetadata:{contentType:'application/gzip'},sha256:checksum})).catch(error=>{abort.abort();throw error;});
        const pump=response.body.pipeTo(transfer.writable,{signal:abort.signal});
        let object:R2Object;
        try {
          [object]=await Promise.all([upload,pump]);
        } catch(error) {
          abort.abort();
          // Deletion drains this lifecycle gate. A failed pump must not leave
          // an R2 write running after deletion has swept the bot's objects.
          await Promise.allSettled([upload,pump]);
          this.checkpointDiagnostic('archive_upload',error);throw new ComputerProviderError('computer_checkpoint_persist_failed');
        }
        this.active();
        if(!object || object.size!==size) throw new ComputerProviderError('computer_checkpoint_integrity_failed');
        await this.publishCheckpoint(checkpoint);
        return checkpoint;
      } catch(error) {
        this.active();
        const failure=safeError(error),retryable=await this.deferCheckpoint(failure);
        // A transient persistence failure gets one immediate checkpoint-only
        // recovery attempt. Longer outages use the durable alarm and backoff.
        if(attempt===0 && retryable && failure.code==='computer_checkpoint_persist_failed') continue;
        throw failure;
      }
    }
    throw new ComputerProviderError('computer_checkpoint_persist_failed');
  }
}

async function rpc<T>(binding: DurableObjectNamespace, botId: string, path: string, extra: object = {}): Promise<T> {
  let response: Response;
  try {
    response = await binding.get(binding.idFromName(botId)).fetch(`https://computer.internal${path}`, {
      method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({botId,...extra}),
    });
  } catch { throw new ComputerProviderError("computer_unavailable"); }
  if (!response.ok) {
    // Error bodies are capped and message strings ignored. Only a recognized
    // code selects a local fixed message, so raw provider text cannot leak.
    try {
      const reader = response.body?.getReader();
      if (reader) {
        let text = "", size = 0;
        const decoder = new TextDecoder();
        while (true) {
          const {done,value} = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 2048) { await reader.cancel(); break; }
          text += decoder.decode(value,{stream:true});
        }
        text += decoder.decode();
        if (size <= 2048) {
          const body = JSON.parse(text) as {error?:{code?:unknown}};
          const code = body?.error?.code;
          if (typeof code === "string" && Object.prototype.hasOwnProperty.call(COMPUTER_ERRORS,code)) {
            throw new ComputerProviderError(code as ComputerErrorCode);
          }
        }
      }
    } catch (error) {
      if (error instanceof ComputerProviderError) throw error;
    }
    throw new ComputerProviderError("computer_unavailable");
  }
  try { return await response.json<T>(); }
  catch { throw new ComputerProviderError("computer_unavailable"); }
}

export function createCloudComputerProvider(binding: DurableObjectNamespace): ComputerProvider {
  return {
    exec:(botId,operationId,action) => rpc<ComputerResult>(binding,botId,"/actions",{operationId,action}),
    status:botId => rpc<ComputerStatus>(binding,botId,"/status"),
    checkpoint:botId => rpc<ComputerResult>(binding,botId,"/actions",{operationId:crypto.randomUUID(),action:{type:"checkpoint"}}),
    controlled:async botId => {
      let response:Response;
      try {response=await binding.get(binding.idFromName(botId)).fetch("https://computer.internal/desktop/control",{headers:{"x-timber-bot-id":botId}});}
      catch {throw new ComputerProviderError("computer_unavailable");}
      if(!response.ok)throw new ComputerProviderError("computer_unavailable");
      return (await response.json<{controlled:boolean}>()).controlled;
    },
    cancel:(botId,processId)=>rpc<ComputerResult>(binding,botId,'/exec/cancel',{processId}),
  };
}
export const touchCloudComputer = (binding: DurableObjectNamespace, botId: string) => rpc<{ok:true}>(binding,botId,"/touch");
export const suspendCloudComputer = (binding: DurableObjectNamespace, botId: string) => rpc<ComputerStatus>(binding,botId,"/suspend");
export const deleteCloudComputer = (binding: DurableObjectNamespace, botId: string) => rpc<{botId:string;deleted:true}>(binding,botId,"/delete");
export function previewCloudComputer(binding:DurableObjectNamespace,botId:string,port:number,request:Request):Promise<Response> {
  const url=new URL(request.url),headers=new Headers(request.headers);
  headers.set("x-timber-bot-id",botId);
  return binding.get(binding.idFromName(botId)).fetch(new Request(`https://computer.internal/preview/${port}${url.pathname}${url.search}`,{
    method:request.method,headers,...(["GET","HEAD"].includes(request.method)?{}:{body:request.body}),redirect:"manual",signal:request.signal,
  }));
}
