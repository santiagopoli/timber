import type { AgentDelegation, Approval, Bot, BotEvent, ConnectionRequest, Message, Run, Subagent } from '../../../packages/contracts/src/index';

export type ChatApproval = Omit<Approval, 'status'> & { status: Approval['status'] | 'expired'; busy: boolean };
export type ChatConnection = ConnectionRequest & { busy?: boolean; opened?: boolean; error?: string };
export type MessageDelivery = {
  botId: string; operationId: string; text: string; createdAt: string;
  state: 'sending' | 'accepted' | 'unknown' | 'rejected';
  runId?: string; runStatus?: Run['status']; error?: string; canRetry?: boolean; mentions?: string[];
};
export type ChatModel = {
  bot: Bot; messages: Message[]; runs: Run[]; approvals: ChatApproval[]; connections: ChatConnection[]; events: BotEvent[];
  deliveries: MessageDelivery[]; draft: string; sending: boolean; loading: boolean;
  mentionBots: Bot[]; draftMentions: string[];
  subagents: Subagent[]; delegations: AgentDelegation[];
  currentRun: Run | null; runFilter: string | null; focusApproval: number;
  stream: { runId: string; text: string } | null;
  feedback?: { createdAt: string; runId?: string; error: boolean; text: string };
};
export type ChatCallbacks = {
  onDraft(botId: string, text: string, mentions?: string[]): void;
  onSend(botId: string, text: string, mentions?: string[]): void;
  onOpenBot(botId: string): void;
  onOpenAgents(agentId?: string): void;
  onRetry(botId: string, operationId: string): void;
  onDecision(botId: string, approvalId: string, decision: 'approve' | 'deny', allowComputer?: boolean): void;
  onClearFilter(): void;
  onStop(botId: string, runId: string): void;
  onConnect(botId: string, requestId: string): void;
};
