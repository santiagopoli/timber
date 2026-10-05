import type { DurableObject } from 'cloudflare:workers';
import type { Bot, ComputerAction, ComputerResult } from '@botspace/contracts';
import type { AISettings } from 'agents/models/pi-ai';

export type PendingApproval = {
  status: 'pending_approval';
  approvalId: string;
  message?: string;
};
export type RuntimeToolResult = ComputerResult | PendingApproval;
export interface RuntimeToolRequest {
  /** Stable identity for this tool invocation, preserved across Pi recovery. */
  operationId: string;
  /** The original user submission, used to attach approvals to the right run. */
  runOperationId: string;
  action: ComputerAction;
  signal: AbortSignal;
}
export interface RuntimeTools {
  execute(request: RuntimeToolRequest): Promise<RuntimeToolResult>;
  readImage?(artifactId: string): Promise<{ data: string; mimeType: string }>;
}
export interface RuntimeEvent {
  type: string;
  data: Record<string, unknown>;
  operationId?: string;
  /** Stable native-entry or submission key when this event can be replayed. */
  eventKey?: string;
}
export interface RuntimeMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  text: string;
  createdAt?: string;
}
export interface PiRuntimeOptions<Env extends object> {
  owner: DurableObject<Env>;
  storage: DurableObjectStorage;
  ai: AISettings['binding'];
  /** Host-owned OAuth transport; the runtime never receives account credentials. */
  chatgpt?: { fetch(request: Request): Promise<Response> };
  getBot(): Promise<Pick<Bot, 'name' | 'instructions' | 'model'>>;
  tools: RuntimeTools;
  onEvent?(event: RuntimeEvent): void | Promise<void>;
  defaultModel?: string;
  maxGenerations?: number;
  maxToolCalls?: number;
}

/** Host-facing protocol. No Pi session IDs, native transcript or lifecycle types. */
export interface RuntimeReceipt { operationId: string; accepted: boolean; }
export interface RuntimeOperationResult { operationId: string; status: 'done' | 'unanswered'; text?: string; reason?: string; }
export interface RuntimeOperation { operationId: string; status: 'queued' | 'running' | 'done' | 'unanswered' | 'missing'; text?: string; reason?: string; }
export interface RuntimePendingOperation { operationId: string; status: 'queued' | 'running'; }
export interface AgentRuntime {
  submit(text: string, input: { operationId: string }): Promise<RuntimeReceipt>;
  wait(operationId: string): Promise<RuntimeOperationResult>;
  pending(): Promise<RuntimePendingOperation[]>;
  cancel(operationId?: string): Promise<boolean>;
  operation(operationId: string): Promise<RuntimeOperation>;
  messages(): Promise<RuntimeMessage[]>;
  dispose(): Promise<void>;
}
