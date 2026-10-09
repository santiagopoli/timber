import type { AgentDelegation, Approval, Bot, BotEvent, CompactionReceipt, ConnectionRequest, Message, Run, Subagent } from '../../../packages/contracts/src/index';
import type {ModelSelection, ModelSettingsState} from './model-settings';
import type {ContextMemoryRequest} from './context-memory';

export type ChatApproval = Omit<Approval, 'status'> & { status: Approval['status'] | 'expired'; busy: boolean };
export type ChatConnection = ConnectionRequest & { busy?: boolean; opened?: boolean; error?: string };
export type MessageDelivery = {
  botId: string; operationId: string; text: string; createdAt: string;
  state: 'sending' | 'accepted' | 'unknown' | 'rejected';
  runId?: string; runStatus?: Run['status']; error?: string; canRetry?: boolean; mentions?: string[];
};
export type ChatModel = {
  bot: Bot; messages: Message[]; runs: Run[]; approvals: ChatApproval[]; connections: ChatConnection[]; events: BotEvent[];
  acceptedImageIds?: string[]; deliveries: MessageDelivery[]; draft: string; sending: boolean; loading: boolean;
  mentionBots: Bot[]; draftMentions: string[];
  modelSettings:ModelSettingsState;
  subagents: Subagent[]; delegations: AgentDelegation[];
  collaborationEvents: BotEvent[];
  compactions?: readonly CompactionReceipt[];
  historyLoading?: boolean; historyHasMore?: boolean; historyError?: string;
  currentRun: Run | null; runFilter: string | null; focusApproval: number;
  stream: { runId: string; text: string } | null;
  feedback?: { createdAt: string; runId?: string; error: boolean; text: string };
};
export type ChatCallbacks = {
  onDraft(botId: string, text: string, mentions?: string[]): void;
  onSend(botId: string, text: string, mentions?: string[], files?: {url:string;mediaType?:string;filename?:string}[]): void | Promise<void>;
  onOpenBot(botId: string): void;
  onOpenAgents(agentId?: string): void;
  onModelSettings(botId:string,settings:ModelSelection):Promise<void>;
  onRefreshModels():void;
  onContextRequest:ContextMemoryRequest;
  onRecovery(botId:string,target:'model'|'connection'|'context'):void;

  onRetry(botId: string, operationId: string): void;
  onDecision(botId: string, approvalId: string, decision: 'approve' | 'deny', allowComputer?: boolean): void;
  onClearFilter(): void;
  onHistoryNearTop?(botId: string): void;
  onStop(botId: string, runId: string): void;
  onConnect(botId: string, requestId: string): void;
};
