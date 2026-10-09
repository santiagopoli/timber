import type { DurableObject } from 'cloudflare:workers';
import type { Approval, Bot, ComputerAction, ComputerResult } from '@botspace/contracts';
import type { AISettings } from 'agents/models/pi-ai';

export type PendingApproval = {
  status: 'pending_approval';
  approvalId: string;
  message?: string;
};
export type PendingConnection = {
  status: 'pending_connection';
  requestId: string;
  provider: 'github';
  repository?: string;
  permission: 'read' | 'write';
  message?: string;
};
/** A host-owned durable wait. A later host submission resumes the conversation. */
export type RuntimePause = PendingApproval | PendingConnection;
export type RuntimeToolResult = ComputerResult | RuntimePause;
export interface HostToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
export interface RuntimeToolRequest {
  /** Stable identity for this tool invocation, preserved across Pi recovery. */
  operationId: string;
  /** The original user submission, used to attach approvals to the right run. */
  runOperationId: string;
  /** Temporary child identity and its own durable input, when dispatched by a child. */
  subagentId?: string;
  subagentOperationId?: string;
  /** Opaque display correlation only; never use this as the computer journal identity. */
  toolCallId?: string;
  action: ComputerAction;
  signal: AbortSignal;
}
export interface RuntimeTools {
  execute(request: RuntimeToolRequest): Promise<RuntimeToolResult>;
  readImage?(artifactId: string): Promise<{ data: string; mimeType: string }>;
  /** Metadata only. The host retains service credentials and capability policy. */
  catalog?(): Promise<HostToolDefinition[]>;
  call?(request: RuntimeHostToolRequest): Promise<RuntimeToolResult>;
}
export interface RuntimeHostToolRequest {
  operationId: string;
  runOperationId: string;
  subagentId?: string;
  subagentOperationId?: string;
  toolCallId?: string;
  name: string;
  arguments: Record<string, unknown>;
  signal: AbortSignal;
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
  kind?: 'progress' | 'final';
  createdAt?: string;
}
export type RuntimeSubagent = {
  id: string;
  name: string;
  task: string;
  parentOperationId: string;
  parentSubagentId?: string;
  operationId: string;
  status: 'queued' | 'running' | 'waiting_approval' | 'waiting_connection' | 'completed' | 'failed' | 'cancelled';
  createdAt: string;
  updatedAt: string;
  result?: string;
  error?: string;
};
/** Current host metadata only: never commands, arguments, results, or credentials. */
export interface RuntimeApprovalSummary {
  id: string;
  status: Approval['status'] | 'expired';
  actionType: ComputerAction['type'];
  expiresAt: string;
}
export interface RuntimeApprovalContext {
  active: RuntimeApprovalSummary[];
  recent: RuntimeApprovalSummary[];
}
export interface PiRuntimeOptions<Env extends object> {
  owner: DurableObject<Env>;
  storage: DurableObjectStorage;
  ai: AISettings['binding'];
  /** Host-owned OAuth transport; the runtime never receives account credentials. */
  chatgpt?: { fetch(request: Request): Promise<Response> };
  getBot(): Promise<Pick<Bot, 'name' | 'instructions' | 'model' | 'computerApprovalMode'>>;
  getApprovalContext?(): Promise<RuntimeApprovalContext>;
  tools: RuntimeTools;
  onEvent?(event: RuntimeEvent): void | Promise<void>;
  /** Admit an attributed, deduplicated parent continuation through host run policy. */
  onSubagentMessage?(input: { subagentId: string; parentOperationId: string; operationId: string; text: string }): Promise<void>;
  /** Wake the host's durable input outbox; attempts and backoff remain host-owned. */
  onAdmissionRetry?(operationId: string): Promise<void>;
  defaultModel?: string;
  /** Optional per-task cap; omitted, null or 0 means unlimited. Recovery does not reset it. */
  maxGenerations?: number | null;
  /** Optional independent tool cap; omitted, null or 0 means unlimited. */
  maxToolCalls?: number | null;
}

/** Host-facing protocol. No Pi session IDs, native transcript or lifecycle types. */
export interface RuntimeReceipt { operationId: string; accepted: boolean; }
export interface RuntimeOperationResult { operationId: string; status: 'done' | 'unanswered'; text?: string; kind?: RuntimeMessage['kind']; reason?: string; answerId?: string; answerOperationId?: string; }
export interface RuntimeOperation { operationId: string; status: 'queued' | 'running' | 'done' | 'unanswered' | 'missing'; text?: string; kind?: RuntimeMessage['kind']; reason?: string; answerId?: string; answerOperationId?: string; }
export interface RuntimePendingOperation { operationId: string; status: 'queued' | 'running'; }
export interface AgentRuntime {
  submit(text: string, input: { operationId: string; images?: {data:string;mimeType:string}[]; whenBusy?: 'steer' | 'followUp' }): Promise<RuntimeReceipt>;
  /** Persist one replaceable wake for this input; never replay a tool or await inference. */
  scheduleAdmissionRetry(operationId: string, delayMs: number): Promise<void>;
  wait(operationId: string): Promise<RuntimeOperationResult>;
  pending(): Promise<RuntimePendingOperation[]>;
  cancel(operationId?: string): Promise<boolean>;
  operation(operationId: string): Promise<RuntimeOperation>;
  messages(): Promise<RuntimeMessage[]>;
  subagents(): Promise<RuntimeSubagent[]>;
  subagentMessages(id: string): Promise<RuntimeMessage[]>;
  sendSubagent(id: string, text: string, input: { operationId: string }): Promise<RuntimeReceipt>;
  cancelSubagent(id: string): Promise<boolean>;
  dispose(): Promise<void>;
  /** Permanently fence new work and await quiescence before host storage deletion.
   * Rejects if shutdown exceeds its bounded wait; retain the tombstone and retry. */
  destroy(): Promise<void>;
}
