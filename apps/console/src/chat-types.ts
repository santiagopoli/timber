import type { Approval, Bot, BotEvent, Message, Run } from '../../../packages/contracts/src/index';

export type ChatApproval = Omit<Approval, 'status'> & { status: Approval['status'] | 'expired'; busy: boolean };
export type MessageDelivery = {
  botId: string; operationId: string; text: string; createdAt: string;
  state: 'sending' | 'accepted' | 'unknown' | 'rejected';
  runId?: string; runStatus?: Run['status']; error?: string; canRetry?: boolean;
};
export type ChatModel = {
  bot: Bot; messages: Message[]; runs: Run[]; approvals: ChatApproval[]; events: BotEvent[];
  deliveries: MessageDelivery[]; draft: string; sending: boolean; loading: boolean;
  currentRun: Run | null; runFilter: string | null; focusApproval: number;
  stream: { runId: string; text: string } | null;
  feedback?: { createdAt: string; runId?: string; error: boolean; text: string };
};
export type ChatCallbacks = {
  onDraft(botId: string, text: string): void;
  onSend(botId: string, text: string): void;
  onRetry(botId: string, operationId: string): void;
  onDecision(botId: string, approvalId: string, decision: 'approve' | 'deny', allowComputer?: boolean): void;
  onClearFilter(): void;
  onStop(botId: string, runId: string): void;
};
