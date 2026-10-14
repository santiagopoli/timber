import type { ComputerAction, ComputerResult, ModelSettings } from "./index";
export type DevicePermission =
  | "diagnostics"
  | "files.read"
  | "files.write"
  | "host.shell"
  | "agent.run";
export type ExecutionTarget =
  | { kind: "cloud" }
  | {
      kind: "device";
      deviceId: string;
      workspaceId: string;
      agentMode?: "cloud" | "local";
    };
export interface DeviceWorkspace {
  id: string;
  name: string;
  path: string;
  capabilities?: DevicePermission[];
}
export interface DeviceGrant {
  botId: string;
  workspaceIds: string[];
  permissions: DevicePermission[];
  epoch: string;
  updatedAt: string;
}
export interface Device {
  id: string;
  name: string;
  platform: string;
  version: string;
  workspaces: DeviceWorkspace[];
  grants: DeviceGrant[];
  status: "online" | "offline" | "revoked";
  online: boolean;
  createdAt: string;
  lastSeenAt?: string;
  revokedAt?: string;
}
export interface DevicePairing {
  pairingId: string;
  code: string;
  expiresAt: string;
  status: "pending" | "approved";
  deviceId?: string;
}
export interface DeviceAgentInput {
  operationId: string;
  botId: string;
  runId?: string;
  taskId?: string;
  nativeOperationId?: string;
  text: string;
  instructions: string;
  modelSettings: ModelSettings;
  images?: Array<{ data: string; mimeType: string }>;
  context?: Array<{ role: "user" | "assistant" | "system"; text: string }>;
  tools?: Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    replay: "safe" | "unsafe";
  }>;
  sessionId?: string;
}
export type LocalAgentInput = DeviceAgentInput;
export interface DeviceAgentEvent {
  type: string;
  data: Record<string, unknown>;
  operationId?: string;
  eventKey?: string;
}
export interface DeviceAgentResult {
  status: "done" | "unanswered";
  text?: string;
  reason?: string;
  kind?: "progress" | "final";
}
export interface DeviceDiagnosticAction {
  type: "diagnostics";
  target: "system" | "processes" | "disk";
  limit?: number;
}
export interface DeviceJob {
  id: string;
  deviceId: string;
  botId: string;
  scopeId?: string;
  parentJobId?: string;
  taskId?: string;
  nativeOperationId?: string;
  workspaceId: string;
  operationId: string;
  type: "computer" | "agent";
  permission: DevicePermission;
  grantEpoch: string;
  state:
    | "queued"
    | "delivered"
    | "running"
    | "completed"
    | "failed"
    | "cancelled"
    | "interrupted";
  createdAt: string;
  updatedAt: string;
  claimToken?: string;
  action?: ComputerAction | DeviceDiagnosticAction;
  agent?: DeviceAgentInput;
  approval?: {
    authorized: true;
    mode: "automatic" | "approved";
    approvalId?: string;
  };
  result?: ComputerResult;
  agentResult?: DeviceAgentResult;
  cancelRequested?: boolean;
  uncertain?: boolean;
}
export interface DevicePoll {
  jobs: DeviceJob[];
  cancellations: Array<{ jobId: string; operationId: string }>;
  device: Device;
}
export const DEVICE_PROOF_HEADERS = {
  id: "x-timber-device",
  time: "x-timber-time",
  nonce: "x-timber-nonce",
  signature: "x-timber-signature",
} as const;
const bytes = (value: string) => new TextEncoder().encode(value);
export async function deviceBodyHash(
  body: string | Uint8Array | ArrayBuffer = "",
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    typeof body === "string" ? bytes(body) : (body as ArrayBuffer),
  );
  return Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
}
/** Sign the public route path + exact encoded HTTP body; credentials never appear in URLs. */
export async function deviceProofMessage(input: {
  method: string;
  path: string;
  id: string;
  time: string;
  nonce: string;
  body?: string | Uint8Array | ArrayBuffer;
}): Promise<string> {
  return [
    "timber-device-v1",
    input.method.toUpperCase(),
    input.path,
    input.id,
    input.time,
    input.nonce,
    await deviceBodyHash(input.body),
  ].join("\n");
}
export function deviceBase64Url(value: Uint8Array): string {
  let text = "";
  for (const byte of value) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function deviceDecodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value))
    throw new Error("Invalid proof encoding");
  return Uint8Array.from(
    atob(value.replace(/-/g, "+").replace(/_/g, "/")),
    (character) => character.charCodeAt(0),
  );
}
export async function deviceProofHeaders(
  privateKey: CryptoKey,
  input: {
    method: string;
    path: string;
    id: string;
    body?: string | Uint8Array | ArrayBuffer;
    time?: string;
    nonce?: string;
  },
): Promise<Record<string, string>> {
  const time = input.time ?? String(Date.now()),
    nonce = input.nonce ?? crypto.randomUUID(),
    message = await deviceProofMessage({ ...input, time, nonce });
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    bytes(message),
  );
  return {
    [DEVICE_PROOF_HEADERS.id]: input.id,
    [DEVICE_PROOF_HEADERS.time]: time,
    [DEVICE_PROOF_HEADERS.nonce]: nonce,
    [DEVICE_PROOF_HEADERS.signature]: deviceBase64Url(
      new Uint8Array(signature),
    ),
  };
}
