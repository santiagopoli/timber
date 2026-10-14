import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { ApiError, errorResponse, json } from "./errors";
import { UUID, parseAction } from "./validation";
import {
  deviceProofMessage,
  deviceDecodeBase64Url,
  deviceBodyHash,
} from "../../../packages/contracts/src/devices";
import type {
  Device,
  DeviceAgentEvent,
  DeviceAgentResult,
  DeviceGrant,
  DeviceJob,
  DevicePairing,
  DevicePermission,
  DeviceWorkspace,
} from "../../../packages/contracts/src/devices";
import type { ComputerResult } from "@botspace/contracts";
interface DeviceEnv extends Env {
  DEVICES?: DurableObjectNamespace;
}
type StoredDevice = Omit<Device, "online" | "status" | "grants"> & {
  publicKey: JsonWebKey;
  revokedAt?: string;
};
type StoredPairing = DevicePairing & {
  publicKey: JsonWebKey;
  name: string;
  platform: string;
  version: string;
  workspaces: DeviceWorkspace[];
};
type StoredJob = DeviceJob & {
  payloadKey?: string;
  fingerprint: string;
  parentJobId?: string;
  uncertain?: boolean;
};
const permissions: DevicePermission[] = [
  "diagnostics",
  "files.read",
  "files.write",
  "host.shell",
  "agent.run",
];
const now = () => new Date().toISOString();
const identifier = (value: unknown, name: string) => {
  if (typeof value !== "string" || !UUID.test(value))
    throw new ApiError(400, "invalid_request", `Invalid ${name}.`);
  return value;
};
const text = (value: unknown, name: string, max: number, min = 1) => {
  if (typeof value !== "string" || value.length < min || value.length > max)
    throw new ApiError(400, "invalid_request", `Invalid ${name}.`);
  return value;
};
function workspaces(value: unknown): DeviceWorkspace[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32)
    throw new ApiError(
      400,
      "invalid_request",
      "Register one to 32 workspaces.",
    );
  const result = value.map((item) => {
    if (!item || typeof item !== "object")
      throw new ApiError(400, "invalid_request", "Invalid workspace.");
    const id = text(item.id, "workspace ID", 100),
      name = text(item.name, "workspace name", 100),
      path = text(item.path, "workspace path", 4096);
    if (
      !/^[A-Za-z0-9_.-]+$/.test(id) ||
      path.includes("\0") ||
      (!path.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(path))
    )
      throw new ApiError(
        400,
        "invalid_request",
        "Use an absolute workspace path.",
      );
    const capabilities = item.capabilities;
    if (
      capabilities !== undefined &&
      (!Array.isArray(capabilities) ||
        capabilities.some((permission) => !permissions.includes(permission)))
    )
      throw new ApiError(
        400,
        "invalid_request",
        "Invalid workspace capability.",
      );
    return {
      id,
      name,
      path,
      ...(capabilities
        ? { capabilities: [...new Set(capabilities)] as DevicePermission[] }
        : {}),
    };
  });
  if (new Set(result.map((item) => item.id)).size !== result.length)
    throw new ApiError(400, "invalid_request", "Workspace IDs must be unique.");
  return result;
}
async function read(
  request: Request,
  limit = 32_000_000,
): Promise<{ bytes: Uint8Array; input: Record<string, unknown> }> {
  const reader = request.body?.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  if (reader)
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new ApiError(
          413,
          "body_too_large",
          "Device request exceeds its limit.",
        );
      }
      chunks.push(item.value);
    }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let input: unknown = {};
  try {
    if (size) input = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ApiError(400, "invalid_request", "Invalid JSON.");
  }
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new ApiError(400, "invalid_request", "Expected an object.");
  return { bytes, input: input as Record<string, unknown> };
}
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
        )
      : item,
  );
}
function required(action: Record<string, unknown>): DevicePermission {
  if (["exec", "gitClone", "gitPush"].includes(String(action.type)))
    return "host.shell";
  if (action.type === "writeFile") return "files.write";
  if (["readFile", "listFiles"].includes(String(action.type)))
    return "files.read";
  if (
    ["diagnostics", "execPoll", "execCancel", "checkpoint"].includes(
      String(action.type),
    )
  )
    return "diagnostics";
  throw new ApiError(
    400,
    "device_capability_unsupported",
    "This device protocol supports files, managed commands and local agents.",
  );
}
const unsafe = (permission: DevicePermission) =>
  ["host.shell", "files.write", "agent.run"].includes(permission);

/** Private owner registry. The Worker forwards only the explicit public routes below. */
export class DevicesDO extends DurableObject<DeviceEnv> {
  constructor(ctx: DurableObjectState, env: DeviceEnv) {
    super(ctx, env);
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY,data TEXT NOT NULL);CREATE TABLE IF NOT EXISTS pairings(id TEXT PRIMARY KEY,code TEXT UNIQUE NOT NULL,expires_at INTEGER NOT NULL,data TEXT NOT NULL);CREATE TABLE IF NOT EXISTS device_grants(device_id TEXT NOT NULL,bot_id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(device_id,bot_id));CREATE TABLE IF NOT EXISTS device_proofs(identity TEXT NOT NULL,nonce TEXT NOT NULL,expires_at INTEGER NOT NULL,PRIMARY KEY(identity,nonce));CREATE TABLE IF NOT EXISTS device_jobs(id TEXT PRIMARY KEY,device_id TEXT NOT NULL,scope_id TEXT NOT NULL,operation_id TEXT NOT NULL,state TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(device_id,scope_id,operation_id));CREATE INDEX IF NOT EXISTS device_jobs_queue ON device_jobs(device_id,state);CREATE TABLE IF NOT EXISTS device_workspace_leases(device_id TEXT NOT NULL,workspace_id TEXT NOT NULL,job_id TEXT NOT NULL,PRIMARY KEY(device_id,workspace_id));CREATE TABLE IF NOT EXISTS device_cancellations(job_id TEXT PRIMARY KEY,device_id TEXT NOT NULL,operation_id TEXT NOT NULL);CREATE INDEX IF NOT EXISTS device_jobs_parent ON device_jobs(json_extract(data,'$.parentJobId'));CREATE TABLE IF NOT EXISTS device_job_events(job_id TEXT NOT NULL,sequence INTEGER NOT NULL,event_key TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(job_id,sequence),UNIQUE(job_id,event_key));`,
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS device_revoked_bots(bot_id TEXT PRIMARY KEY)",
    );
  }
  private row<T>(table: string, id: string): T | undefined {
    const row = this.ctx.storage.sql
      .exec<{ data: string }>(`SELECT data FROM ${table} WHERE id=?`, id)
      .toArray()[0];
    return row ? JSON.parse(row.data) : undefined;
  }
  private device(id: string): StoredDevice {
    const device = this.row<StoredDevice>("devices", id);
    if (!device)
      throw new ApiError(404, "device_not_found", "Device not found.");
    return device;
  }
  private view(device: StoredDevice): Device {
    const { publicKey: _key, ...metadata } = device;
    const online =
      !device.revokedAt &&
      !!device.lastSeenAt &&
      Date.now() - Date.parse(device.lastSeenAt) < 60_000;
    return {
      ...metadata,
      grants: this.ctx.storage.sql
        .exec<{ data: string }>(
          "SELECT data FROM device_grants WHERE device_id=?",
          device.id,
        )
        .toArray()
        .map((row) => JSON.parse(row.data)),
      online,
      status: device.revokedAt ? "revoked" : online ? "online" : "offline",
    };
  }
  private saveDevice(device: StoredDevice) {
    this.ctx.storage.sql.exec(
      "INSERT INTO devices(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      device.id,
      JSON.stringify(device),
    );
  }
  private job(id: string): StoredJob {
    const job = this.row<StoredJob>("device_jobs", id);
    if (!job) throw new ApiError(404, "job_not_found", "Job not found.");
    return job;
  }
  private saveJob(job: StoredJob) {
    job.updatedAt = now();
    this.ctx.storage.sql.exec(
      "INSERT INTO device_jobs(id,device_id,scope_id,operation_id,state,data) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,data=excluded.data",
      job.id,
      job.deviceId,
      job.scopeId ?? job.botId,
      job.operationId,
      job.state,
      JSON.stringify(job),
    );
  }
  private release(job: StoredJob) {
    if (job.uncertain) return;
    if (
      this.ctx.storage.sql
        .exec(
          "SELECT 1 FROM device_jobs WHERE json_extract(data,'$.parentJobId')=? AND (state IN ('queued','delivered','running') OR json_extract(data,'$.uncertain')=1) LIMIT 1",
          job.id,
        )
        .toArray().length
    )
      return;
    this.ctx.storage.sql.exec(
      "DELETE FROM device_workspace_leases WHERE device_id=? AND workspace_id=? AND job_id=?",
      job.deviceId,
      job.workspaceId,
      job.id,
    );
  }
  private releaseParent(job: StoredJob) {
    if (job.parentJobId) {
      const parent = this.job(job.parentJobId);
      if (
        ["completed", "failed", "cancelled", "interrupted"].includes(
          parent.state,
        )
      ) {
        this.release(parent);
        this.releaseParent(parent);
      }
    }
  }
  private cancel(job: StoredJob) {
    if (
      !job.uncertain &&
      ["completed", "failed", "cancelled", "interrupted"].includes(job.state)
    )
      return;
    const delivered = job.state !== "queued";
    job.cancelRequested = true;
    if (["queued", "delivered"].includes(job.state)) {
      job.state = "cancelled";
      this.release(job);
    }
    this.saveJob(job);
    if (delivered)
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO device_cancellations(job_id,device_id,operation_id) VALUES(?,?,?)",
        job.id,
        job.deviceId,
        job.operationId,
      );
    for (const row of this.ctx.storage.sql
      .exec<{
        data: string;
      }>(
        "SELECT data FROM device_jobs WHERE json_extract(data,'$.parentJobId')=? AND state IN ('queued','delivered','running')",
        job.id,
      )
      .toArray())
      this.cancel(JSON.parse(row.data));
    this.releaseParent(job);
  }
  private cancellations(deviceId: string) {
    return this.ctx.storage.sql
      .exec<{
        jobId: string;
        operationId: string;
      }>(
        "SELECT job_id AS jobId,operation_id AS operationId FROM device_cancellations WHERE device_id=? LIMIT 128",
        deviceId,
      )
      .toArray();
  }
  private fence(deviceId: string, botId?: string) {
    for (const row of this.ctx.storage.sql
      .exec<{
        data: string;
      }>(
        `SELECT data FROM device_jobs WHERE device_id=? AND (state IN ('queued','delivered','running') OR json_extract(data,'$.uncertain')=1)`,
        deviceId,
      )
      .toArray()) {
      const job = JSON.parse(row.data) as StoredJob;
      if (!botId || job.botId === botId) this.cancel(job);
    }
  }
  private grant(
    device: StoredDevice,
    job: Pick<DeviceJob, "botId" | "workspaceId" | "permission" | "grantEpoch">,
  ): DeviceGrant {
    if (
      this.ctx.storage.sql
        .exec("SELECT 1 FROM device_revoked_bots WHERE bot_id=?", job.botId)
        .toArray().length
    )
      throw new ApiError(
        403,
        "bot_revoked",
        "Device access for this bot was permanently revoked.",
      );
    if (device.revokedAt)
      throw new ApiError(403, "device_revoked", "This device was revoked.");
    const row = this.ctx.storage.sql
      .exec<{
        data: string;
      }>(
        "SELECT data FROM device_grants WHERE device_id=? AND bot_id=?",
        device.id,
        job.botId,
      )
      .toArray()[0];
    const grant = row ? (JSON.parse(row.data) as DeviceGrant) : undefined;
    if (
      !grant ||
      grant.epoch !== job.grantEpoch ||
      !device.workspaces.some(
        (workspace) => workspace.id === job.workspaceId,
      ) ||
      !grant.workspaceIds.includes(job.workspaceId) ||
      !grant.permissions.includes(job.permission)
    )
      throw new ApiError(
        403,
        "device_grant_revoked",
        "This job is outside the current device grant.",
      );
    return grant;
  }
  private async member(botId: string, taskId?: string) {
    const registry = this.env.WORKSPACE.get(
      this.env.WORKSPACE.idFromName("owner"),
    );
    const response = await registry.fetch(`https://workspace/${botId}`);
    if (!response.ok) {
      await response.body?.cancel();
      throw new ApiError(404, "bot_not_found", "Bot not found.");
    }
    await response.body?.cancel();
    if (taskId) {
      const response = await registry.fetch(
        `https://workspace/tasks/${taskId}`,
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new ApiError(404, "task_not_found", "Task not found.");
      }
      const { task } = await response.json<{
        task: { botId?: string; id: string };
      }>();
      if (task.botId !== botId)
        throw new ApiError(
          403,
          "task_mismatch",
          "The task belongs to another bot.",
        );
    }
  }
  private async proof(
    request: Request,
    bytes: Uint8Array,
    id: string,
    key: JsonWebKey,
  ) {
    if (request.headers.get("x-timber-device") !== id)
      throw new ApiError(
        401,
        "device_proof_invalid",
        "Device proof identity mismatch.",
      );
    const time = request.headers.get("x-timber-time") ?? "",
      nonce = request.headers.get("x-timber-nonce") ?? "",
      signature = request.headers.get("x-timber-signature") ?? "";
    if (
      !/^\d{13}$/.test(time) ||
      Math.abs(Date.now() - Number(time)) > 60_000 ||
      !UUID.test(nonce)
    )
      throw new ApiError(
        401,
        "device_proof_expired",
        "Device proof is expired or invalid.",
      );
    let valid = false;
    try {
      const publicKey = await crypto.subtle.importKey(
        "jwk",
        key,
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"],
      );
      const url = new URL(request.url),
        message = await deviceProofMessage({
          method: request.method,
          path: url.pathname + url.search,
          id,
          time,
          nonce,
          body: bytes,
        });
      valid = await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        publicKey,
        deviceDecodeBase64Url(signature) as BufferSource,
        new TextEncoder().encode(message),
      );
    } catch {}
    if (!valid)
      throw new ApiError(
        401,
        "device_proof_invalid",
        "Device proof could not be verified.",
      );
    this.ctx.storage.sql.exec(
      "DELETE FROM device_proofs WHERE expires_at<?",
      Date.now(),
    );
    try {
      this.ctx.storage.sql.exec(
        "INSERT INTO device_proofs(identity,nonce,expires_at) VALUES(?,?,?)",
        id,
        nonce,
        Date.now() + 120_000,
      );
    } catch {
      throw new ApiError(
        409,
        "device_proof_replayed",
        "Device proof was already used.",
      );
    }
  }
  private async pair(input: Record<string, unknown>): Promise<Response> {
    const publicKey = input.publicKey as JsonWebKey;
    if (
      !publicKey ||
      publicKey.kty !== "EC" ||
      publicKey.crv !== "P-256" ||
      publicKey.d ||
      typeof publicKey.x !== "string" ||
      typeof publicKey.y !== "string"
    )
      throw new ApiError(
        400,
        "invalid_public_key",
        "A public P-256 key is required.",
      );
    try {
      await crypto.subtle.importKey(
        "jwk",
        { kty: "EC", crv: "P-256", x: publicKey.x, y: publicKey.y },
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"],
      );
    } catch {
      throw new ApiError(400, "invalid_public_key", "Invalid public key.");
    }
    this.ctx.storage.sql.exec(
      "DELETE FROM pairings WHERE expires_at<?",
      Date.now(),
    );
    if (
      this.ctx.storage.sql
        .exec<{ n: number }>("SELECT COUNT(*) n FROM pairings")
        .one().n >= 16
    )
      throw new ApiError(
        429,
        "pairing_capacity",
        "Too many pending device pairings.",
      );
    const pairing: StoredPairing = {
      pairingId: crypto.randomUUID(),
      code: crypto.randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase(),
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      status: "pending",
      publicKey: { kty: "EC", crv: "P-256", x: publicKey.x, y: publicKey.y },
      name: text(input.name, "device name", 80),
      platform: text(input.platform, "platform", 40),
      version: text(input.version, "version", 80),
      workspaces: workspaces(input.workspaces),
    };
    this.ctx.storage.sql.exec(
      "INSERT INTO pairings(id,code,expires_at,data) VALUES(?,?,?,?)",
      pairing.pairingId,
      pairing.code,
      Date.parse(pairing.expiresAt),
      JSON.stringify(pairing),
    );
    return json(
      {
        pairingId: pairing.pairingId,
        code: pairing.code,
        expiresAt: pairing.expiresAt,
        status: "pending",
      },
      201,
    );
  }
  private async approve(input: Record<string, unknown>) {
    const code = text(input.code, "pairing code", 20)
      .replace(/[\s-]/g, "")
      .toUpperCase();
    const row = this.ctx.storage.sql
      .exec<{ data: string }>("SELECT data FROM pairings WHERE code=?", code)
      .toArray()[0];
    if (!row)
      throw new ApiError(404, "pairing_not_found", "Pairing code not found.");
    const pairing = JSON.parse(row.data) as StoredPairing;
    if (Date.parse(pairing.expiresAt) <= Date.now())
      throw new ApiError(
        409,
        "pairing_expired",
        "This pairing expired. Start a new pairing.",
      );
    if (pairing.status === "approved")
      return json({ device: this.view(this.device(pairing.deviceId!)) });
    const device: StoredDevice = {
      id: crypto.randomUUID(),
      name: pairing.name,
      platform: pairing.platform,
      version: pairing.version,
      workspaces: pairing.workspaces,
      publicKey: pairing.publicKey,
      createdAt: now(),
    };
    this.ctx.storage.transactionSync(() => {
      this.saveDevice(device);
      pairing.status = "approved";
      pairing.deviceId = device.id;
      this.ctx.storage.sql.exec(
        "UPDATE pairings SET data=? WHERE id=?",
        JSON.stringify(pairing),
        pairing.pairingId,
      );
    });
    return json({ device: this.view(device) });
  }
  private async enqueue(input: Record<string, unknown>): Promise<Response> {
    const device = this.device(identifier(input.deviceId, "device ID")),
      botId = identifier(input.botId, "bot ID"),
      taskId =
        input.taskId === undefined
          ? undefined
          : identifier(input.taskId, "task ID"),
      workspaceId = text(input.workspaceId, "workspace ID", 100),
      operationId = text(input.operationId, "operation ID", 160);
    if (!/^[A-Za-z0-9:_.-]+$/.test(operationId))
      throw new ApiError(400, "invalid_request", "Invalid operation ID.");
    const type =
      input.type === "agent"
        ? "agent"
        : input.type === "computer"
          ? "computer"
          : undefined;
    if (!type) throw new ApiError(400, "invalid_request", "Invalid job type.");
    const action =
        type === "computer"
          ? input.action &&
            typeof input.action === "object" &&
            (input.action as { type?: string }).type === "diagnostics"
            ? this.diagnostic(input.action)
            : parseAction(input.action)
          : undefined,
      permission = action
        ? required(action as unknown as Record<string, unknown>)
        : "agent.run";
    const row = this.ctx.storage.sql
      .exec<{
        data: string;
      }>(
        "SELECT data FROM device_grants WHERE device_id=? AND bot_id=?",
        device.id,
        botId,
      )
      .toArray()[0];
    const grant = row ? (JSON.parse(row.data) as DeviceGrant) : undefined;
    if (!grant)
      throw new ApiError(
        403,
        "device_grant_required",
        "Grant this bot access to the device workspace first.",
      );
    const scopeId =
        input.scopeId === undefined
          ? (taskId ?? botId)
          : text(input.scopeId, "scope ID", 160),
      fingerprint = await deviceBodyHash(stable({ ...input, scopeId }));
    const prior = this.ctx.storage.sql
      .exec<{
        data: string;
      }>(
        "SELECT data FROM device_jobs WHERE device_id=? AND scope_id=? AND operation_id=?",
        device.id,
        scopeId,
        operationId,
      )
      .toArray()[0];
    if (prior) {
      const job = JSON.parse(prior.data) as StoredJob;
      if (job.fingerprint !== fingerprint)
        throw new ApiError(
          409,
          "idempotency_conflict",
          "Device operation arguments changed.",
        );
      return json({ job: this.publicJob(job) });
    }
    this.grant(device, {
      botId,
      workspaceId,
      permission,
      grantEpoch: grant.epoch,
    });
    if (!device.workspaces.some((item) => item.id === workspaceId))
      throw new ApiError(
        403,
        "workspace_unavailable",
        "The registered workspace is unavailable.",
      );
    if (
      unsafe(permission) &&
      ((input.approval as DeviceJob["approval"])?.authorized !== true ||
        !["automatic", "approved"].includes(
          (input.approval as DeviceJob["approval"])!.mode,
        ))
    )
      throw new ApiError(
        403,
        "device_approval_required",
        "This host action requires explicit authorization.",
      );
    await this.member(botId, taskId);
    let parentJobId =
      input.parentJobId === undefined
        ? undefined
        : identifier(input.parentJobId, "parent job ID");
    if (action && ["execPoll", "execCancel"].includes(action.type)) {
      const processId = (action as { processId: string }).processId;
      const original = this.ctx.storage.sql
        .exec<{
          data: string;
        }>(
          "SELECT data FROM device_jobs WHERE device_id=? AND json_extract(data,'$.botId')=? AND json_extract(data,'$.workspaceId')=? AND (json_extract(data,'$.result.processId')=? OR operation_id=?) ORDER BY rowid LIMIT 1",
          device.id,
          botId,
          workspaceId,
          processId,
          processId,
        )
        .toArray()[0];
      if (!original)
        throw new ApiError(
          403,
          "device_process_mismatch",
          "This process does not belong to the requested workspace and bot.",
        );
      const parent = JSON.parse(original.data) as StoredJob;
      if ((parent.taskId ?? undefined) !== taskId)
        throw new ApiError(
          403,
          "device_process_mismatch",
          "This process belongs to another conversation.",
        );
      if (parent.state === "running")
        parentJobId ??= parent.parentJobId ?? parent.id;
    }
    if (parentJobId) {
      const parent = this.job(parentJobId);
      if (
        parent.deviceId !== device.id ||
        parent.workspaceId !== workspaceId ||
        parent.botId !== botId ||
        (parent.taskId ?? undefined) !== taskId ||
        parent.state !== "running"
      )
        throw new ApiError(
          403,
          "device_parent_mismatch",
          "Parent job cannot authorize this workspace action.",
        );
    }
    const job: StoredJob = {
      id: crypto.randomUUID(),
      deviceId: device.id,
      botId,
      scopeId,
      ...(taskId ? { taskId } : {}),
      ...(parentJobId ? { parentJobId } : {}),
      ...(typeof input.nativeOperationId === "string"
        ? { nativeOperationId: input.nativeOperationId }
        : {}),
      workspaceId,
      operationId,
      type,
      permission,
      grantEpoch: grant.epoch,
      state: "queued",
      createdAt: now(),
      updatedAt: now(),
      fingerprint,
      ...(action ? { action } : {}),
      ...(input.approval
        ? { approval: input.approval as DeviceJob["approval"] }
        : {}),
    };
    if (type === "agent") {
      const agent = input.agent as DeviceJob["agent"];
      if (
        !agent ||
        agent.operationId !== operationId ||
        agent.botId !== botId ||
        !agent.modelSettings?.model ||
        typeof agent.text !== "string" ||
        typeof agent.instructions !== "string"
      )
        throw new ApiError(
          400,
          "invalid_agent_job",
          "Invalid local agent input.",
        );
      if (
        agent.images?.some(
          (image) =>
            !["image/png", "image/jpeg"].includes(image.mimeType) ||
            typeof image.data !== "string" ||
            image.data.length > 7_000_000,
        ) ||
        (agent.images && agent.images.length > 4)
      )
        throw new ApiError(
          400,
          "invalid_agent_job",
          "Invalid local agent images.",
        );
      const payload = JSON.stringify(agent);
      job.agent = { ...agent, context: undefined, images: undefined };
      job.payloadKey = `bots/${botId}/device-inputs/${job.id}.json`;
      await this.env.FILES.put(job.payloadKey, payload, {
        httpMetadata: { contentType: "application/json" },
      });
    }
    // Grant/identity can change while writing a large immutable input payload.
    this.grant(this.device(device.id), job);
    await this.member(botId, taskId);
    const raced = this.ctx.storage.sql
      .exec<{
        data: string;
      }>(
        "SELECT data FROM device_jobs WHERE device_id=? AND scope_id=? AND operation_id=?",
        device.id,
        scopeId,
        operationId,
      )
      .toArray()[0];
    if (raced) {
      const winner = JSON.parse(raced.data) as StoredJob;
      if (winner.fingerprint !== fingerprint)
        throw new ApiError(
          409,
          "idempotency_conflict",
          "Device operation arguments changed.",
        );
      return json({ job: this.publicJob(winner) });
    }
    this.grant(this.device(device.id), job);
    this.saveJob(job);
    return json({ job: this.publicJob(job) }, 202);
  }
  private diagnostic(value: unknown): {
    type: "diagnostics";
    target: "system" | "processes" | "disk";
    limit?: number;
  } {
    const action = value as { target?: string; limit?: number };
    if (
      !["system", "processes", "disk"].includes(action.target ?? "") ||
      (action.limit !== undefined &&
        (!Number.isSafeInteger(action.limit) ||
          action.limit < 1 ||
          action.limit > 100))
    )
      throw new ApiError(
        400,
        "invalid_request",
        "Invalid diagnostics request.",
      );
    return {
      type: "diagnostics",
      target: action.target as "system" | "processes" | "disk",
      ...(action.limit ? { limit: action.limit } : {}),
    };
  }
  private publicJob(job: StoredJob): DeviceJob {
    const {
      fingerprint: _fingerprint,
      payloadKey: _payload,
      ...publicJob
    } = job;
    return publicJob;
  }
  private async wireJob(job: StoredJob): Promise<DeviceJob> {
    const result = this.publicJob(job);
    if (job.payloadKey) {
      const payload = await this.env.FILES.get(job.payloadKey);
      if (!payload)
        throw new ApiError(
          503,
          "device_job_payload_unavailable",
          "The local agent input is unavailable.",
        );
      result.agent = await payload.json();
    }
    return result;
  }
  private async hostAlive(job: StoredJob): Promise<boolean> {
    if (!job.nativeOperationId && job.type !== "agent") return true;
    const response = await this.env.BOT.get(
      this.env.BOT.idFromName(
        job.taskId ? "owner:task:" + job.taskId : "owner:" + job.botId,
      ),
    ).fetch("https://bot/device-runtime/check", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-timber-internal": "device-runtime",
        ...(job.taskId ? { "x-timber-task-id": job.taskId } : {}),
      },
      body: JSON.stringify({ job: this.publicJob(job) }),
    });
    if ([403, 404, 409, 410].includes(response.status)) {
      await response.body?.cancel();
      return false;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new ApiError(
        503,
        "device_scope_unavailable",
        "The originating task authorization could not be checked.",
      );
    }
    return (await response.json<{ active: boolean }>()).active === true;
  }
  private alive(
    job: StoredJob,
    deviceId: string,
    input: Record<string, unknown>,
    cancel = false,
  ) {
    if (
      job.deviceId !== deviceId ||
      typeof input.claimToken !== "string" ||
      input.claimToken !== job.claimToken
    )
      throw new ApiError(
        403,
        "device_job_mismatch",
        "The job does not belong to this device claim.",
      );
    if (!cancel) this.grant(this.device(deviceId), job);
    if (job.cancelRequested && !cancel)
      throw new ApiError(
        409,
        "device_job_cancelled",
        "This job was cancelled.",
      );
  }
  private async poll(device: StoredDevice): Promise<Response> {
    const jobs: DeviceJob[] = [];
    for (const row of this.ctx.storage.sql
      .exec<{
        data: string;
      }>(
        "SELECT data FROM device_jobs WHERE device_id=? AND state='queued' ORDER BY rowid LIMIT 20",
        device.id,
      )
      .toArray()) {
      const job = JSON.parse(row.data) as StoredJob;
      try {
        this.grant(device, job);
      } catch {
        this.cancel(job);
        continue;
      }
      if (!(await this.hostAlive(job))) {
        this.cancel(job);
        continue;
      }
      const held = this.ctx.storage.sql
        .exec<{
          job_id: string;
        }>(
          "SELECT job_id FROM device_workspace_leases WHERE device_id=? AND workspace_id=?",
          device.id,
          job.workspaceId,
        )
        .toArray()[0];
      if (held && held.job_id !== job.parentJobId) continue;
      if (
        job.parentJobId &&
        (!held || this.job(job.parentJobId).state !== "running")
      ) {
        this.cancel(job);
        continue;
      }
      const childActive =
        job.parentJobId &&
        this.ctx.storage.sql
          .exec(
            "SELECT 1 FROM device_jobs WHERE device_id=? AND (state IN ('delivered','running') OR json_extract(data,'$.uncertain')=1) AND json_extract(data,'$.parentJobId')=? AND json_extract(data,'$.workspaceId')=? LIMIT 1",
            device.id,
            job.parentJobId,
            job.workspaceId,
          )
          .toArray().length > 0;
      if (childActive) continue;
      const wire = await this.wireJob(job);
      if (this.job(job.id).state !== "queued") continue;
      const admitted = this.ctx.storage.transactionSync(() => {
        this.grant(this.device(device.id), job);
        const currentHolder = this.ctx.storage.sql
          .exec<{
            job_id: string;
          }>(
            "SELECT job_id FROM device_workspace_leases WHERE device_id=? AND workspace_id=?",
            device.id,
            job.workspaceId,
          )
          .toArray()[0];
        if (currentHolder && currentHolder.job_id !== job.parentJobId)
          return false;
        if (
          job.parentJobId &&
          (!currentHolder ||
            this.job(job.parentJobId).state !== "running" ||
            this.ctx.storage.sql
              .exec(
                "SELECT 1 FROM device_jobs WHERE device_id=? AND (state IN ('delivered','running') OR json_extract(data,'$.uncertain')=1) AND json_extract(data,'$.parentJobId')=? AND json_extract(data,'$.workspaceId')=? LIMIT 1",
                device.id,
                job.parentJobId,
                job.workspaceId,
              )
              .toArray().length)
        )
          return false;
        if (!currentHolder)
          this.ctx.storage.sql.exec(
            "INSERT INTO device_workspace_leases(device_id,workspace_id,job_id) VALUES(?,?,?)",
            device.id,
            job.workspaceId,
            job.id,
          );
        job.state = "delivered";
        job.claimToken = crypto.randomUUID();
        this.saveJob(job);
        return true;
      });
      if (!admitted) continue;
      jobs.push({ ...wire, state: job.state, claimToken: job.claimToken });
      if (jobs.length >= 4) break;
    }
    return json({
      jobs,
      cancellations: this.cancellations(device.id),
      device: this.view(device),
    });
  }
  private async result(
    job: StoredJob,
    input: Record<string, unknown>,
  ): Promise<Response> {
    return this.ctx.storage.transactionSync(() => {
      this.alive(job, job.deviceId, input, true);
      if (
        ["completed", "failed", "cancelled", "interrupted"].includes(
          job.state,
        ) &&
        !job.uncertain
      ) {
        this.ctx.storage.sql.exec(
          "DELETE FROM device_cancellations WHERE job_id=?",
          job.id,
        );
        return json({ job: this.publicJob(job) });
      }
      if (job.state !== "running" && !job.uncertain)
        throw new ApiError(
          409,
          "device_job_not_started",
          "Start this claim before publishing its result.",
        );
      if (job.type === "computer") {
        const result = input.result as ComputerResult;
        if (
          !result ||
          result.operationId !== job.operationId ||
          ![
            "running",
            "completed",
            "failed",
            "cancelled",
            "interrupted",
          ].includes(result.status) ||
          (result.output && result.output.length > 131072)
        )
          throw new ApiError(
            400,
            "invalid_device_result",
            "Invalid computer result.",
          );
        job.result = result;
        job.uncertain =
          result.processKnown === false &&
          (job.action?.type === "exec" || !!job.uncertain);
        if (job.uncertain) {
          job.cancelRequested = true;
          this.ctx.storage.sql.exec(
            "INSERT OR IGNORE INTO device_cancellations(job_id,device_id,operation_id) VALUES(?,?,?)",
            job.id,
            job.deviceId,
            job.operationId,
          );
        }
        if (result.status !== "running") job.state = result.status;
        else job.state = "running";
      } else {
        const result = input.agentResult as DeviceAgentResult;
        if (
          !result ||
          !["done", "unanswered"].includes(result.status) ||
          (result.text && result.text.length > 65536)
        )
          throw new ApiError(
            400,
            "invalid_device_result",
            "Invalid agent result.",
          );
        job.agentResult = result;
        job.state =
          result.status === "done"
            ? "completed"
            : result.reason === "aborted"
              ? "cancelled"
              : "interrupted";
      }
      if (job.state !== "running" && !job.uncertain) {
        this.release(job);
        this.ctx.storage.sql.exec(
          "DELETE FROM device_cancellations WHERE job_id=?",
          job.id,
        );
      }
      this.saveJob(job);
      if (job.state !== "running") this.releaseParent(job);
      if (
        job.action &&
        ["execPoll", "execCancel"].includes(job.action.type) &&
        job.result?.status !== "running"
      ) {
        const processId = (job.action as { processId: string }).processId;
        for (const row of this.ctx.storage.sql
          .exec<{
            data: string;
          }>(
            "SELECT data FROM device_jobs WHERE device_id=? AND state='running'",
            job.deviceId,
          )
          .toArray()) {
          const original = JSON.parse(row.data) as StoredJob;
          if (
            original.workspaceId === job.workspaceId &&
            original.botId === job.botId &&
            (original.result?.processId === processId ||
              original.operationId === processId) &&
            original.type === "computer"
          ) {
            original.result = {
              ...job.result!,
              operationId: original.operationId,
            };
            original.state = job.result!.status as StoredJob["state"];
            this.saveJob(original);
            this.release(original);
            this.releaseParent(original);
            this.ctx.storage.sql.exec(
              "DELETE FROM device_cancellations WHERE job_id=?",
              original.id,
            );
          }
        }
      }
      return json({ job: this.publicJob(job) });
    });
  }
  private async callback(
    job: StoredJob,
    input: Record<string, unknown>,
    kind: string,
    request: Request,
  ): Promise<Response> {
    this.alive(job, job.deviceId, input);
    if (job.type !== "agent" || job.state !== "running")
      throw new ApiError(
        409,
        "device_job_inactive",
        "The local agent job is inactive.",
      );
    await this.member(job.botId, job.taskId);
    if (kind === "event") {
      const event = input.event as DeviceAgentEvent,
        sequence = input.sequence;
      if (
        !Number.isSafeInteger(sequence) ||
        Number(sequence) < 1 ||
        !event ||
        !event.data ||
        typeof event.data !== "object" ||
        Array.isArray(event.data) ||
        (event.operationId !== undefined &&
          event.operationId !== job.operationId) ||
        typeof event.eventKey !== "string" ||
        event.eventKey.length < 1 ||
        event.eventKey.length > 160 ||
        ![
          "message.delta",
          "message",
          "runtime.snapshot",
          "run.queued",
          "run.started",
          "run.completed",
          "run.failed",
          "tool.started",
          "tool.completed",
          "subagent.created",
          "subagent.updated",
          "subagent.completed",
        ].includes(event.type)
      )
        throw new ApiError(
          400,
          "invalid_device_event",
          "Invalid local agent event.",
        );
      const existing = this.ctx.storage.sql
        .exec<{
          sequence: number;
          data: string;
        }>(
          "SELECT sequence,data FROM device_job_events WHERE job_id=? AND (sequence=? OR event_key=?)",
          job.id,
          Number(sequence),
          event.eventKey,
        )
        .toArray()[0];
      const data = stable(event);
      if (
        existing &&
        (existing.sequence !== Number(sequence) || existing.data !== data)
      )
        throw new ApiError(
          409,
          "idempotency_conflict",
          "Agent event identity changed.",
        );
      if (
        !existing &&
        Number(sequence) !==
          this.ctx.storage.sql
            .exec<{
              n: number;
            }>(
              "SELECT COALESCE(MAX(sequence),0) n FROM device_job_events WHERE job_id=?",
              job.id,
            )
            .one().n +
            1
      )
        throw new ApiError(
          409,
          "device_event_sequence",
          "Publish events in sequence without gaps.",
        );
      if (!existing)
        this.ctx.storage.sql.exec(
          "INSERT INTO device_job_events(job_id,sequence,event_key,data) VALUES(?,?,?,?)",
          job.id,
          Number(sequence),
          event.eventKey,
          data,
        );
    }
    const path =
      kind === "tool"
        ? "tool"
        : kind === "inference"
          ? "inference"
          : kind === "snapshot"
            ? "snapshot"
            : "event";
    return this.env.BOT.get(
      this.env.BOT.idFromName(
        job.taskId ? `owner:task:${job.taskId}` : `owner:${job.botId}`,
      ),
    ).fetch(
      new Request(`https://bot/device-runtime/${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-timber-internal": "device-runtime",
          ...(job.taskId ? { "x-timber-task-id": job.taskId } : {}),
        },
        body: JSON.stringify({ job: this.publicJob(job), payload: input }),
        signal: request.signal,
      }),
    );
  }
  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url),
        path = url.pathname,
        { input, bytes } = await read(
          request,
          path === "/v1/device-connect/pairings"
            ? 32_000
            : path.startsWith("/v1/devices")
              ? 64_000
              : path.endsWith("/agent/inference")
                ? 32_000_000
                : path.startsWith("/internal/")
                  ? 32_000_000
                  : 300_000,
        );
      if (path.startsWith("/internal/")) {
        if (
          !["computer", "agent"].includes(
            request.headers.get("x-timber-internal") ?? "",
          )
        )
          throw new ApiError(
            403,
            "internal_only",
            "Device operations are internal.",
          );
        const botRevoke = /^\/internal\/bots\/([^/]+)\/revoke$/.exec(path);
        if (botRevoke && request.method === "POST") {
          const botId = identifier(botRevoke[1], "bot ID");
          this.ctx.storage.transactionSync(() => {
            this.ctx.storage.sql.exec(
              "INSERT OR IGNORE INTO device_revoked_bots(bot_id) VALUES(?)",
              botId,
            );
            this.ctx.storage.sql.exec(
              "DELETE FROM device_grants WHERE bot_id=?",
              botId,
            );
            for (const row of this.ctx.storage.sql
              .exec<{
                data: string;
              }>(
                "SELECT data FROM device_jobs WHERE json_extract(data,'$.botId')=? AND (state IN ('queued','delivered','running') OR json_extract(data,'$.uncertain')=1)",
                botId,
              )
              .toArray())
              this.cancel(JSON.parse(row.data));
          });
          return json({ revoked: true });
        }
        const deviceStatus = /^\/internal\/devices\/([^/]+)$/.exec(path);
        if (deviceStatus && request.method === "GET") {
          const device = this.device(identifier(deviceStatus[1], "device ID"));
          const activeJobs = this.ctx.storage.sql
            .exec<{
              n: number;
            }>(
              "SELECT COUNT(*) n FROM device_jobs WHERE device_id=? AND state IN ('queued','delivered','running')",
              device.id,
            )
            .one().n;
          const heldWorkspaces = this.ctx.storage.sql
            .exec<{
              workspaceId: string;
              jobId: string;
            }>(
              "SELECT workspace_id AS workspaceId,job_id AS jobId FROM device_workspace_leases WHERE device_id=?",
              device.id,
            )
            .toArray();
          return json({
            device: this.view(device),
            activeJobs,
            heldWorkspaces,
          });
        }
        if (path === "/internal/operations" && request.method === "GET") {
          const deviceId = identifier(
              url.searchParams.get("deviceId"),
              "device ID",
            ),
            scopeId = text(url.searchParams.get("scopeId"), "scope ID", 160),
            operationId = text(
              url.searchParams.get("operationId"),
              "operation ID",
              160,
            );
          const row = this.ctx.storage.sql
            .exec<{
              data: string;
            }>(
              "SELECT data FROM device_jobs WHERE device_id=? AND scope_id=? AND operation_id=?",
              deviceId,
              scopeId,
              operationId,
            )
            .toArray()[0];
          return json({
            job: row ? this.publicJob(JSON.parse(row.data)) : null,
          });
        }
        if (path === "/internal/jobs" && request.method === "POST")
          return await this.enqueue(input);
        const route = /^\/internal\/jobs\/([^/]+)(?:\/(cancel))?$/.exec(path);
        if (route) {
          const job = this.job(identifier(route[1], "job ID"));
          if (route[2] && request.method === "POST") {
            this.cancel(job);
            return json({ job: this.publicJob(job) });
          }
          if (request.method === "GET") {
            const after = Number(url.searchParams.get("after") ?? 0);
            if (!Number.isSafeInteger(after) || after < 0)
              throw new ApiError(
                400,
                "invalid_cursor",
                "Invalid event cursor.",
              );
            const events = this.ctx.storage.sql
              .exec<{ sequence: number; data: string }>(
                "SELECT sequence,data FROM device_job_events WHERE job_id=? AND sequence>? ORDER BY sequence LIMIT 100",
                job.id,
                after,
              )
              .toArray()
              .map((row) => ({
                sequence: row.sequence,
                event: JSON.parse(row.data),
              }));
            return json({ job: this.publicJob(job), events });
          }
        }
        throw new ApiError(404, "not_found", "Device operation not found.");
      }
      if (path === "/v1/device-connect/pairings" && request.method === "POST")
        return await this.pair(input);
      const pairingRoute =
        /^\/v1\/device-connect\/pairings\/([^/]+)\/poll$/.exec(path);
      if (pairingRoute && request.method === "POST") {
        const pairing = this.row<StoredPairing>(
          "pairings",
          identifier(pairingRoute[1], "pairing ID"),
        );
        if (!pairing || Date.parse(pairing.expiresAt) <= Date.now())
          throw new ApiError(
            404,
            "pairing_expired",
            "Pairing is unavailable or expired.",
          );
        await this.proof(request, bytes, pairing.pairingId, pairing.publicKey);
        return json({
          pairingId: pairing.pairingId,
          status: pairing.status,
          expiresAt: pairing.expiresAt,
          ...(pairing.deviceId
            ? {
                deviceId: pairing.deviceId,
                device: this.view(this.device(pairing.deviceId)),
              }
            : {}),
        });
      }
      const connect =
        /^\/v1\/device-connect\/([^/]+)\/(heartbeat|disconnect|jobs\/poll|jobs\/([^/]+)\/(start|result|agent\/(?:inference|tool|event|snapshot)))$/.exec(
          path,
        );
      if (connect && request.method === "POST") {
        let device = this.device(identifier(connect[1], "device ID"));
        await this.proof(request, bytes, device.id, device.publicKey);
        device = this.device(device.id);
        if (
          device.revokedAt &&
          connect[4] !== "result" &&
          connect[2] !== "jobs/poll" &&
          connect[2] !== "disconnect"
        )
          throw new ApiError(403, "device_revoked", "This device was revoked.");
        device.lastSeenAt = now();
        this.saveDevice(device);
        if (connect[2] === "disconnect") {
          device.revokedAt ??= now();
          this.ctx.storage.transactionSync(() => {
            this.saveDevice(device);
            this.ctx.storage.sql.exec(
              "DELETE FROM device_grants WHERE device_id=?",
              device.id,
            );
            this.fence(device.id);
          });
          return json({ device: this.view(device) });
        }
        if (connect[2] === "heartbeat") {
          if (input.workspaces !== undefined) {
            const updated = workspaces(input.workspaces);
            if (stable(updated) !== stable(device.workspaces)) {
              this.fence(device.id);
              this.ctx.storage.sql.exec(
                "DELETE FROM device_grants WHERE device_id=?",
                device.id,
              );
              device.workspaces = updated;
            }
          }
          if (input.version !== undefined)
            device.version = text(input.version, "version", 80);
          this.saveDevice(device);
          return json({ device: this.view(device) });
        }
        if (connect[2] === "jobs/poll") {
          if (device.revokedAt)
            return json({
              jobs: [],
              cancellations: this.cancellations(device.id),
              device: this.view(device),
            });
          return await this.poll(device);
        }
        let job = this.job(identifier(connect[3], "job ID"));
        this.alive(job, device.id, input, connect[4] === "result");
        if (connect[4] === "start") {
          if (!(await this.hostAlive(job))) {
            this.cancel(job);
            throw new ApiError(
              409,
              "device_job_cancelled",
              "The originating task is no longer active.",
            );
          }
          job = this.job(job.id);
          this.alive(job, device.id, input);
          if (job.state === "running")
            return json({ job: this.publicJob(job) });
          if (job.state !== "delivered")
            throw new ApiError(
              409,
              "device_job_inactive",
              "The job cannot be started.",
            );
          job.state = "running";
          this.saveJob(job);
          return json({ job: this.publicJob(job) });
        }
        if (connect[4] === "result") return await this.result(job, input);
        return await this.callback(
          job,
          input,
          connect[4].slice("agent/".length),
          request,
        );
      }
      if (request.headers.get("x-timber-owner") !== "owner")
        throw new ApiError(
          401,
          "unauthorized",
          "Owner authentication required.",
        );
      if (path === "/v1/devices" && request.method === "GET")
        return json({
          devices: this.ctx.storage.sql
            .exec<{ data: string }>(
              "SELECT data FROM devices ORDER BY rowid DESC",
            )
            .toArray()
            .map((row) => this.view(JSON.parse(row.data))),
        });
      if (path === "/v1/devices/pairings/approve" && request.method === "POST")
        return await this.approve(input);
      const owner = /^\/v1\/devices\/([^/]+)(?:\/grants(?:\/([^/]+))?)?$/.exec(
        path,
      );
      if (owner) {
        const device = this.device(identifier(owner[1], "device ID"));
        if (!path.includes("/grants") && request.method === "DELETE") {
          device.revokedAt ??= now();
          this.ctx.storage.transactionSync(() => {
            this.saveDevice(device);
            this.ctx.storage.sql.exec(
              "DELETE FROM device_grants WHERE device_id=?",
              device.id,
            );
            this.fence(device.id);
          });
          return json({ device: this.view(device) });
        }
        if (path.includes("/grants") && request.method === "DELETE") {
          const botId = identifier(owner[2], "bot ID");
          this.ctx.storage.transactionSync(() => {
            this.ctx.storage.sql.exec(
              "DELETE FROM device_grants WHERE device_id=? AND bot_id=?",
              device.id,
              botId,
            );
            this.fence(device.id, botId);
          });
          return json({ device: this.view(device) });
        }
        if (path.endsWith("/grants") && request.method === "POST") {
          if (device.revokedAt)
            throw new ApiError(
              403,
              "device_revoked",
              "Pair the machine again before granting access.",
            );
          const botId = identifier(input.botId, "bot ID");
          await this.member(botId);
          if (
            !Array.isArray(input.workspaceIds) ||
            input.workspaceIds.length < 1 ||
            input.workspaceIds.some(
              (id) =>
                !device.workspaces.some((workspace) => workspace.id === id),
            ) ||
            !Array.isArray(input.permissions) ||
            input.permissions.length < 1 ||
            input.permissions.some(
              (value) => !permissions.includes(value as DevicePermission),
            )
          )
            throw new ApiError(
              400,
              "invalid_device_grant",
              "Select registered workspaces and explicit permissions.",
            );
          const grant: DeviceGrant = {
            botId,
            workspaceIds: [...new Set(input.workspaceIds)] as string[],
            permissions: [...new Set(input.permissions)] as DevicePermission[],
            epoch: crypto.randomUUID(),
            updatedAt: now(),
          };
          this.ctx.storage.transactionSync(() => {
            if (this.device(device.id).revokedAt)
              throw new ApiError(403, "device_revoked", "Device was revoked.");
            if (
              this.ctx.storage.sql
                .exec("SELECT 1 FROM device_revoked_bots WHERE bot_id=?", botId)
                .toArray().length
            )
              throw new ApiError(
                403,
                "bot_revoked",
                "Device access for this bot was permanently revoked.",
              );
            if (
              !grant.workspaceIds.every((id) =>
                this.device(device.id).workspaces.some(
                  (workspace) => workspace.id === id,
                ),
              )
            )
              throw new ApiError(
                409,
                "workspace_unavailable",
                "The registered device workspaces changed.",
              );
            const previous = this.ctx.storage.sql
              .exec<{
                data: string;
              }>(
                "SELECT data FROM device_grants WHERE device_id=? AND bot_id=?",
                device.id,
                botId,
              )
              .toArray()[0];
            if (previous) {
              const existing = JSON.parse(previous.data) as DeviceGrant;
              if (
                existing.workspaceIds.length === grant.workspaceIds.length &&
                existing.workspaceIds.every((id) =>
                  grant.workspaceIds.includes(id),
                ) &&
                existing.permissions.length === grant.permissions.length &&
                existing.permissions.every((permission) =>
                  grant.permissions.includes(permission),
                )
              )
                return;
            }
            this.fence(device.id, botId);
            this.ctx.storage.sql.exec(
              "INSERT INTO device_grants(device_id,bot_id,data) VALUES(?,?,?) ON CONFLICT(device_id,bot_id) DO UPDATE SET data=excluded.data",
              device.id,
              botId,
              JSON.stringify(grant),
            );
          });
          return json({ device: this.view(this.device(device.id)) });
        }
      }
      throw new ApiError(404, "not_found", "Device route not found.");
    } catch (error) {
      return errorResponse(error);
    }
  }
}

/** Called before owner auth for device-connect, after owner auth for owner management. */
export async function routeDevices(
  request: Request,
  env: DeviceEnv,
  owner?: string,
): Promise<Response | undefined> {
  const path = new URL(request.url).pathname;
  const connect =
    path === "/v1/device-connect/pairings" ||
    /^\/v1\/device-connect\/pairings\/[0-9a-f-]{36}\/poll$/.test(path) ||
    /^\/v1\/device-connect\/[0-9a-f-]{36}\/(heartbeat|disconnect|jobs\/poll|jobs\/[0-9a-f-]{36}\/(start|result|agent\/(inference|tool|event|snapshot)))$/.test(
      path,
    );
  const management =
    path === "/v1/devices" ||
    path === "/v1/devices/pairings/approve" ||
    /^\/v1\/devices\/[0-9a-f-]{36}(\/grants(\/[0-9a-f-]{36})?)?$/.test(path);
  if (!connect && !management) return;
  if (management && owner !== "owner") return;
  if (!env.DEVICES)
    return json(
      {
        error: {
          code: "devices_not_configured",
          message: "Owned machines are not configured.",
        },
      },
      503,
    );
  const headers = new Headers();
  for (const name of [
    "content-type",
    "x-timber-device",
    "x-timber-time",
    "x-timber-nonce",
    "x-timber-signature",
    "cf-connecting-ip",
  ]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (management) headers.set("x-timber-owner", "owner");
  // Bound unsigned bootstrap at the edge before handing its body to the DO stream bridge.
  let pairingBytes: Uint8Array | undefined;
  if (path === "/v1/device-connect/pairings" && request.method === "POST") {
    try {
      pairingBytes = (await read(request, 32_000)).bytes;
    } catch (error) {
      return errorResponse(error);
    }
  }
  return env.DEVICES.get(env.DEVICES.idFromName("owner")).fetch(
    pairingBytes
      ? new Request(request.url, {
          method: request.method,
          headers,
          body: pairingBytes,
          signal: request.signal,
        })
      : new Request(request, { headers }),
  );
}
export async function deviceRequest<T>(
  env: DeviceEnv,
  path: string,
  input?: unknown,
  source: "computer" | "agent" = "computer",
): Promise<T> {
  if (!env.DEVICES)
    throw new ApiError(
      503,
      "devices_not_configured",
      "Owned machines are not configured.",
    );
  const response = await env.DEVICES.get(env.DEVICES.idFromName("owner")).fetch(
    new Request(`https://devices/internal${path}`, {
      method: input === undefined ? "GET" : "POST",
      headers: {
        "content-type": "application/json",
        "x-timber-internal": source,
      },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    }),
  );
  const result = await response.json<
    T & { error?: { code: string; message: string } }
  >();
  if (!response.ok)
    throw new ApiError(
      response.status,
      result.error?.code ?? "device_unavailable",
      result.error?.message ?? "Device request failed.",
    );
  return result;
}
