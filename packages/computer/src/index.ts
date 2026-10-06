/// <reference path="./assets.d.ts" />
import { DurableObject } from "cloudflare:workers";
import type { ComputerAction, ComputerProvider, ComputerResult, ComputerStatus } from "@botspace/contracts";
import serverSource from "../../../infra/computer/server.py";
import startSource from "../../../infra/computer/start.sh";

export interface ComputerEnv {
  FILES: R2Bucket;
  /** Temporary deployment mode. Installs desktop packages at cold start. */
  COMPUTER_BOOTSTRAP?: string;
}

interface OperationRecord { digest: string; result?: ComputerResult; }
interface Checkpoint { id: string; key: string; size: number; sha256: string; createdAt: string; }
interface Health { ok: boolean; bootId: string; desktop: boolean; }
interface ContainerResult extends ComputerResult { artifactName?: string; }

const IDLE_MS = 5 * 60_000;
const SAFETY_TIMEOUT_MS = 15 * 60_000;
const PORT = 8080;
const BASE_CAPABILITIES = ["exec", "readFile", "writeFile", "listFiles", "checkpoint"];
const DESKTOP_CAPABILITIES = ["screenshot", "click", "type", "key", "scroll", "navigate"];
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
  computer_checkpoint_integrity_failed: {status:503, message:"The workspace checkpoint failed size or checksum validation."},
  computer_checkpoint_persist_failed: {status:503, message:"The workspace checkpoint could not be saved durably. Retry the checkpoint, not the previous action."},
  computer_invalid_request: {status:400, message:"The computer request is invalid."},
  computer_method_not_allowed: {status:405, message:"The computer request method is not allowed."},
  computer_owner_mismatch: {status:403, message:"This computer belongs to another bot."},
  computer_deleted: {status:410, message:"This bot's computer has been permanently deleted."},
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
  private tail: Promise<unknown> = Promise.resolve();
  private starting?: Promise<Health>;
  private flights = new Map<string, Promise<ComputerResult>>();
  private token = "";
  private desktop = false;
  private deleted=false;
  private deleting?:Promise<void>;
  private shutdown=new AbortController();

  constructor(ctx: DurableObjectState, env: ComputerEnv) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      if(await ctx.storage.get<string>("deleted")) {this.deleted=true;this.shutdown.abort();return;}
      this.token = await ctx.storage.get<string>("internalToken") ?? crypto.randomUUID() + crypto.randomUUID();
      await ctx.storage.put("internalToken", this.token);
      // If the DO was evicted during an effect, its outcome is unknown. A retry
      // with the same id receives interrupted, never replays the effect.
      const operations = await ctx.storage.list<OperationRecord>({ prefix: "operation:" });
      for (const [key, record] of operations) {
        if (!record.result) {
          record.result = {operationId: key.slice(10), status: "interrupted", error: "Execution was interrupted. Inspect effects before creating another operation."};
          await ctx.storage.put(key, record);
        }
      }
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
  private remove(botId:string):Promise<void> {
    if(this.deleting) return this.deleting;
    this.deleted=true;
    this.shutdown.abort();
    this.deleting=(async()=>{
      await this.ctx.storage.put("deleted",botId);
      await this.ctx.storage.deleteAlarm();
      if(this.container && (this.container.running || this.starting)) await this.container.destroy("Bot permanently deleted");
      // Stop first, then drain queued/in-flight operations before acknowledging
      // deletion. Workspace can now remove R2 without a late uploader racing it.
      await this.tail;
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
      if (request.method !== "POST") throw new ComputerProviderError("computer_method_not_allowed");
      const body = await request.json<{botId:string; operationId?:string; action?:ComputerAction}>();
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(body.botId)) throw new ComputerProviderError("computer_invalid_request");
      const savedBotId = await this.ctx.storage.get<string>("deleted") ?? await this.ctx.storage.get<string>("botId");
      if (savedBotId && savedBotId !== body.botId) throw new ComputerProviderError("computer_owner_mismatch");
      if(path==="/delete") {await this.remove(body.botId);return Response.json({botId:body.botId,deleted:true});}
      this.active();
      if (!savedBotId) await this.ctx.storage.put("botId", body.botId);
      this.active();
      if (path === "/status") return Response.json(await this.status(body.botId));
      if (path === "/touch") { await this.touch(); return Response.json({ok:true}); }
      if (path === "/suspend") {
        return Response.json(await this.serialize(async () => {
          this.active();
          if (this.container?.running) {
            await this.ensureReady(body.botId);
            await this.saveCheckpoint(body.botId, true);
            await this.container.destroy("User suspended computer after durable checkpoint");
            this.desktop = false;
          }
          return this.status(body.botId);
        }));
      }
      if (path !== "/actions" || !body.action || !body.operationId || !/^[A-Za-z0-9:_.-]{1,160}$/.test(body.operationId)) {
        throw new ComputerProviderError("computer_invalid_request");
      }
      return Response.json(await this.execute(body.botId, body.operationId, body.action));
    } catch (error) {
      const safe = safeError(error);
      console.error("computer.failure", {stage:"request",code:safe.code});
      return Response.json({error:{code:safe.code,message:safe.publicMessage}}, {status:safe.status});
    }
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
      capabilities: container ? [...BASE_CAPABILITIES, ...(this.desktop ? DESKTOP_CAPABILITIES : [])] : [],
      ...(checkpoint ? {lastCheckpointId:checkpoint.id} : {}),
      ...(error ? {error:{code:error.code,message:error.publicMessage}} : {}),
    };
  }

  private execute(botId: string, operationId: string, action: ComputerAction): Promise<ComputerResult> {
    this.active();
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
      await this.ensureReady(botId);
      await this.touch();
      this.active();
      await this.ctx.storage.put<OperationRecord>(key, {digest});
      this.active();
      let result: ComputerResult;
      let operationStage: "checkpoint" | "action" | "artifact_read" | "artifact_store" = "action";
      try {
        if (action.type === "checkpoint") {
          operationStage = "checkpoint";
          const checkpoint = await this.saveCheckpoint(botId);
          result = {operationId,status:"completed",checkpointId:checkpoint.id};
        } else {
          const response = await this.call("/actions", {
            method:"POST", body:JSON.stringify({operationId,action}),
            headers:{"Content-Type":"application/json"},
          });
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
          if (action.type === "exec" || action.type === "writeFile") {
            operationStage = "checkpoint";
            try { result.checkpointId = (await this.saveCheckpoint(botId)).id; }
            catch { result.error = `${result.error ? result.error + " " : ""}The action finished, but its files are not yet checkpointed. Retry checkpoint, not the action.`; }
          }
        }
      } catch (error) {
        console.error("computer.failure", {stage:operationStage,code:safeError(error).code});
        result = {operationId,status:"interrupted",error:"Computer connection or persistence failed; the action may have completed. Inspect effects before submitting a new operation."};
      }
      this.active();
      await this.ctx.storage.put<OperationRecord>(key, {digest,result});
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

  private async touch(): Promise<void> {
    this.active();
    await this.ctx.storage.put("lastActivity", Date.now());
    this.active();
    await this.ctx.storage.setAlarm(Date.now() + IDLE_MS);
    this.active();
    if (this.container?.running) await stage("computer_lifecycle_failed", () => this.container!.setInactivityTimeout(SAFETY_TIMEOUT_MS));
  }

  async alarm(): Promise<void> {
    if(this.deleted) {await this.ctx.storage.deleteAlarm();return;}
    await this.serialize(async () => {
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
        await this.ensureReady(botId);
        await this.saveCheckpoint(botId, true);
        await this.container.destroy("Idle computer checkpointed");
        this.desktop = false;
      } catch {
        // Do not intentionally discard an uncheckpointed filesystem. A later
        // infrastructure failure can still lose it; this is not a live volume.
        if(!this.deleted) await this.ctx.storage.setAlarm(Date.now() + 60_000);
      }
    });
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
    this.active();
    this.starting ??= this.startAndRestore(botId).then(async health => {
      this.active();
      await this.ctx.storage.delete("startupFailure");
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
    const storedBoot = await this.ctx.storage.get<string>("restoredBoot");
    this.active();
    if (storedBoot !== health.bootId) {
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
      const install = await container.exec(["timeout","--kill-after=5","240","sh","-c", "mkdir -p /workspace /state /opt/botspace; if ! test -f /opt/botspace/desktop-ready; then export DEBIAN_FRONTEND=noninteractive; apt-get update > /state/bootstrap.log 2>&1 && apt-get install -y --no-install-recommends python3 chromium xvfb xdotool xclip scrot openbox fonts-liberation ca-certificates curl git procps >> /state/bootstrap.log 2>&1 && touch /opt/botspace/desktop-ready; fi"]);
      const {exitCode} = await install.output();
      if (exitCode === 124) throw new ComputerProviderError("computer_start_timeout");
      if (exitCode !== 0) throw new ComputerProviderError("computer_provisioning_failed");
    });
    for (const [path, source] of [["/opt/botspace/server.py",serverSource],["/opt/botspace/start.sh",startSource]] as const) {
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

  private async saveCheckpoint(botId: string, quiesce = false): Promise<Checkpoint> {
    this.active();
    const response = await stage("computer_checkpoint_failed", () => this.call("/checkpoint", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({quiesce})}));
    if (!response.ok || !response.body) throw new ComputerProviderError("computer_checkpoint_failed");
    const size = Number(response.headers.get("Content-Length"));
    if (!Number.isSafeInteger(size) || size <= 0 || size > 256 * 1024 * 1024) throw new ComputerProviderError("computer_checkpoint_integrity_failed");
    const id = crypto.randomUUID();
    const key = `bots/${botId}/checkpoints/${id}.tar.gz`;
    const checksum = response.headers.get("X-Content-SHA256") ?? "";
    if (!/^[a-f0-9]{64}$/.test(checksum)) throw new ComputerProviderError("computer_checkpoint_integrity_failed");
    this.active();
    const object = await stage("computer_checkpoint_persist_failed", () => this.env.FILES.put(key,response.body,{httpMetadata:{contentType:"application/gzip"},sha256:checksum}));
    this.active();
    if (!object || object.size !== size) throw new ComputerProviderError("computer_checkpoint_integrity_failed");
    const checkpoint: Checkpoint = {id,key,size,sha256:checksum,createdAt:new Date().toISOString()};
    // R2 atomically publishes an object. Only then does this durable pointer move.
    await stage("computer_checkpoint_persist_failed", () => this.ctx.storage.put("lastCheckpoint",checkpoint));
    return checkpoint;
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
  };
}
export const touchCloudComputer = (binding: DurableObjectNamespace, botId: string) => rpc<{ok:true}>(binding,botId,"/touch");
export const suspendCloudComputer = (binding: DurableObjectNamespace, botId: string) => rpc<ComputerStatus>(binding,botId,"/suspend");
export const deleteCloudComputer = (binding: DurableObjectNamespace, botId: string) => rpc<{botId:string;deleted:true}>(binding,botId,"/delete");
