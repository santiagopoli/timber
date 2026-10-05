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
  private readyBoot?: string;
  private desktop = false;

  constructor(ctx: DurableObjectState, env: ComputerEnv) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
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

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    try {
      if (request.method !== "POST") throw new ComputerProviderError("computer_method_not_allowed");
      const body = await request.json<{botId:string; operationId?:string; action?:ComputerAction}>();
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(body.botId)) throw new ComputerProviderError("computer_invalid_request");
      const savedBotId = await this.ctx.storage.get<string>("botId");
      if (savedBotId && savedBotId !== body.botId) throw new ComputerProviderError("computer_owner_mismatch");
      if (!savedBotId) await this.ctx.storage.put("botId", body.botId);
      if (path === "/status") return Response.json(await this.status(body.botId));
      if (path === "/touch") { await this.touch(); return Response.json({ok:true}); }
      if (path === "/suspend") {
        return Response.json(await this.serialize(async () => {
          if (this.container?.running) {
            await this.ensureReady(body.botId);
            await this.saveCheckpoint(body.botId, true);
            await this.container.destroy("User suspended computer after durable checkpoint");
            this.readyBoot = undefined;
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
    const checkpoint = await this.ctx.storage.get<Checkpoint>("lastCheckpoint");
    const container = this.container;
    let state: ComputerStatus["state"] = !container ? "unavailable" : this.starting ? "starting" : container.running ? "running" : "stopped";
    if (state === "running" && !this.readyBoot) {
      try {
        const health = await this.health();
        this.desktop = health.desktop;
      } catch { state = "starting"; }
    }
    return {
      id:botId, provider:"cloudflare", state,
      capabilities: container ? [...BASE_CAPABILITIES, ...(this.desktop ? DESKTOP_CAPABILITIES : [])] : [],
      ...(checkpoint ? {lastCheckpointId:checkpoint.id} : {}),
    };
  }

  private execute(botId: string, operationId: string, action: ComputerAction): Promise<ComputerResult> {
    // Include argument digest even when another call with this id is in flight.
    const flightKey = `${operationId}:${stableAction(action)}`;
    const existing = this.flights.get(flightKey);
    if (existing) return existing;
    const work = this.serialize(async () => {
      const digest = await sha256(stableAction(action));
      const key = `operation:${operationId}`;
      const existingRecord = await this.ctx.storage.get<OperationRecord>(key);
      if (existingRecord) {
        if (existingRecord.digest !== digest) return {operationId, status:"failed" as const, error:"operationId was already used with different arguments"};
        return existingRecord.result ?? {operationId, status:"interrupted" as const, error:"Operation outcome is unknown; it will not be replayed"};
      }
      await this.ensureReady(botId);
      await this.touch();
      await this.ctx.storage.put<OperationRecord>(key, {digest});
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
    await this.ctx.storage.put("lastActivity", Date.now());
    await this.ctx.storage.setAlarm(Date.now() + IDLE_MS);
    if (this.container?.running) await stage("computer_lifecycle_failed", () => this.container!.setInactivityTimeout(SAFETY_TIMEOUT_MS));
  }

  async alarm(): Promise<void> {
    await this.serialize(async () => {
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
        this.readyBoot = undefined;
      } catch {
        // Do not intentionally discard an uncheckpointed filesystem. A later
        // infrastructure failure can still lose it; this is not a live volume.
        await this.ctx.storage.setAlarm(Date.now() + 60_000);
      }
    });
  }

  private call(path: string, init: RequestInit = {}): Promise<Response> {
    if (!this.container) throw new ComputerProviderError("computer_not_configured");
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.token}`);
    return this.container.getTcpPort(PORT).fetch(`http://computer${path}`, {...init,headers});
  }

  private async health(): Promise<Health> {
    const response = await this.call("/health", {signal:AbortSignal.timeout(2000)});
    if (!response.ok) throw new Error("Computer is not ready");
    return response.json<Health>();
  }

  private ensureReady(botId: string): Promise<Health> {
    this.starting ??= this.startAndRestore(botId).finally(() => { this.starting = undefined; });
    return this.starting;
  }

  private async startAndRestore(botId: string): Promise<Health> {
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
      try { health = await this.health(); break; }
      catch { await new Promise(resolve => setTimeout(resolve,250)); }
    }
    if (!health) throw new ComputerProviderError("computer_not_ready");
    this.desktop = health.desktop;
    const storedBoot = await this.ctx.storage.get<string>("restoredBoot");
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
      await this.ctx.storage.put("restoredBoot",health.bootId);
    }
    this.readyBoot = health.bootId;
    if (started) await this.touch();
    return health;
  }

  private async bootstrap(): Promise<void> {
    const container = this.container!;
    await stage("computer_provisioning_failed", async () => {
      const install = await container.exec(["sh","-c", "mkdir -p /workspace /state /opt/botspace; if ! test -f /opt/botspace/desktop-ready; then export DEBIAN_FRONTEND=noninteractive; apt-get update > /state/bootstrap.log 2>&1 && apt-get install -y --no-install-recommends python3 chromium xvfb xdotool xclip scrot openbox fonts-liberation ca-certificates curl git procps >> /state/bootstrap.log 2>&1 && touch /opt/botspace/desktop-ready; fi"]);
      if ((await install.output()).exitCode !== 0) throw new ComputerProviderError("computer_provisioning_failed");
    });
    for (const [path, source] of [["/opt/botspace/server.py",serverSource],["/opt/botspace/start.sh",startSource]] as const) {
      await stage("computer_server_install_failed", async () => {
        const process = await container.exec(["python3","-c","import pathlib,sys; pathlib.Path(sys.argv[1]).write_bytes(sys.stdin.buffer.read())",path], {
          stdin:new ReadableStream<Uint8Array>({start(controller) {controller.enqueue(encoder.encode(source));controller.close();}}),
        });
        if ((await process.output()).exitCode !== 0) throw new ComputerProviderError("computer_server_install_failed");
      });
    }
    await stage("computer_server_start_failed", async () => {
      const process = await container.exec(["sh","-c","nohup sh /opt/botspace/start.sh > /state/server.log 2>&1 < /dev/null &"],{
        env:{BOTSPACE_COMPUTER_TOKEN:this.token,DISPLAY:":99",BOTSPACE_WORKSPACE:"/workspace",BOTSPACE_STATE:"/state"},
      });
      if ((await process.output()).exitCode !== 0) throw new ComputerProviderError("computer_server_start_failed");
    });
  }

  private async saveCheckpoint(botId: string, quiesce = false): Promise<Checkpoint> {
    const response = await stage("computer_checkpoint_failed", () => this.call("/checkpoint", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({quiesce})}));
    if (!response.ok || !response.body) throw new ComputerProviderError("computer_checkpoint_failed");
    const size = Number(response.headers.get("Content-Length"));
    if (!Number.isSafeInteger(size) || size <= 0 || size > 256 * 1024 * 1024) throw new ComputerProviderError("computer_checkpoint_integrity_failed");
    const id = crypto.randomUUID();
    const key = `bots/${botId}/checkpoints/${id}.tar.gz`;
    const checksum = response.headers.get("X-Content-SHA256") ?? "";
    if (!/^[a-f0-9]{64}$/.test(checksum)) throw new ComputerProviderError("computer_checkpoint_integrity_failed");
    const object = await stage("computer_checkpoint_persist_failed", () => this.env.FILES.put(key,response.body,{httpMetadata:{contentType:"application/gzip"},sha256:checksum}));
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
