export * from './models.js';
export * from './model-errors.js';
export type RunStatus = "queued" | "running" | "waiting_approval" | "waiting_connection" | "completed" | "failed" | "cancelled" | "interrupted";
export type ComputerApprovalMode = "ask" | "automatic";
export interface Bot { id: string; name: string; instructions: string; runtime: "pi"; model: string; reasoningEffort?: string; fast?: boolean; computerApprovalMode?: ComputerApprovalMode; allowNamedAgents?: boolean; createdByBotId?: string; createdAt: string; updatedAt: string; }
export interface MessageProvenance { kind: "bot" | "mention" | "delegation_result"; sourceBotId: string; sourceBotName: string; sourceRunId?: string; delegationId?: string; }
export interface RunDelegation { id: string; sourceBotId: string; sourceRunId: string; path: string[]; }
export interface AgentDelegation extends RunDelegation { sourceBotName: string; targetBotId: string; targetBotName: string; targetRunId?: string; status: RunStatus; createdAt: string; updatedAt: string; error?: string; }
export interface ImageAttachment { artifactId: string; mimeType: "image/png" | "image/jpeg"; size: number; }
export interface Message { attachments?: ImageAttachment[]; id: string; botId: string; runId?: string; role: "user" | "assistant" | "tool" | "system"; kind?: "progress" | "final"; text: string; provenance?: MessageProvenance; mentions?: string[]; createdAt: string; }
export interface RunCancellation { id: string; requestedRunId: string; }
export interface Run { admissionRetryable?: boolean; model?: string; reasoningEffort?: string; fast?: boolean; id: string; botId: string; operationId: string; status: RunStatus; delegation?: RunDelegation; subagentId?: string; parentRunId?: string; cancellation?: RunCancellation; createdAt: string; updatedAt: string; error?: string; errorCode?: string; }
export interface Subagent { model?: string; reasoningEffort?: string; fast?: boolean; id: string; name: string; task: string; parentOperationId: string; parentSubagentId?: string; operationId: string; status: "queued" | "running" | "waiting_approval" | "waiting_connection" | "completed" | "failed" | "cancelled"; createdAt: string; updatedAt: string; result?: string; error?: string; }

/** A newest-first history page plus all currently active runs, independent of pagination. */
/** Stable rowid pages of the retained public transcript, chronological within each page. */
export interface MessagePage { messages: Message[]; nextCursor: string | null; }
export interface RunPage { runs: Run[]; activeRuns: Run[]; nextCursor: string | null; }
export interface BotEvent { id: number; botId: string; runId?: string; type: string; data: Record<string, unknown>; createdAt: string; }
export type ComputerAction =
 | {type:"exec";command:string;timeoutMs?:number;yieldMs?:number}
 | {type:"execPoll";processId:string;yieldMs?:number}
 | {type:"execCancel";processId:string}
 | {type:"readFile";path:string}
 | {type:"writeFile";path:string;content:string}
 | {type:"listFiles";path?:string}
 | {type:"screenshot"}
 | {type:"click";x:number;y:number;button?:"left"|"right"|"middle"}
 | {type:"move";x:number;y:number}
 | {type:"doubleClick";x:number;y:number;button?:"left"|"right"|"middle"}
 | {type:"drag";fromX:number;fromY:number;toX:number;toY:number;button?:"left"|"right"|"middle";durationMs?:number}
 | {type:"type";text:string}
 | {type:"key";key:string}
 | {type:"scroll";direction:"up"|"down";amount?:number}
 | {type:"navigate";url:string}
 | {type:"gitClone";repository:string;path:string;branch?:string}
 | {type:"gitPush";repository:string;path:string;branch:string}
 | {type:"checkpoint"};
/** An exec receipt may still be running; processId remains stable across polls and cancellation. */
export interface ComputerResult { operationId:string;status:"running"|"completed"|"failed"|"interrupted"|"cancelled";processId?:string;processKnown?:boolean;output?:string;exitCode?:number;artifactId?:string;mimeType?:string;checkpointId?:string;checkpointStatus?:"pending"|"saved"|"failed";error?:string; }
export interface ComputerStatus { id:string;provider:"cloudflare";state:"stopped"|"starting"|"running"|"unavailable";capabilities:string[];lastCheckpointId?:string;error?:{code:string;message:string}; }
export interface Approval {id:string;botId:string;runId:string;operationId:string;toolCallId?:string;action:ComputerAction;status:"pending"|"approved"|"denied"|"executing"|"completed"|"failed"|"interrupted";createdAt:string;expiresAt:string;result?:ComputerResult;}
export interface ComputerProvider {exec(botId:string,operationId:string,action:ComputerAction):Promise<ComputerResult>;cancel(botId:string,processId:string):Promise<ComputerResult>;status(botId:string):Promise<ComputerStatus>;checkpoint(botId:string):Promise<ComputerResult>;}
export interface ApiError {error:{code:string;message:string};}

export interface ConnectionRequest {id:string;botId:string;runId:string;nativeOperationId?:string;provider:"github";repository?:string;permission:"read"|"write";status:"pending"|"connected"|"cancelled";createdAt:string;}

export type {MemoryCategory,MemoryActor,MemoryState,MemorySource,MemoryEntry,MemorySaveInput,MemorySuggestionInput,MemoryForgetInput,MemoryAcceptInput,MemoryMutationResult,MemoryRevision,MemorySearchHit,MemorySearchResult,MemoryReviewStatus,MemoryLegacy,MemoryLimits,BotMemory} from './memory';
export interface CompactionReceipt {id:string;reason:"manual"|"threshold"|"overflow";status:"running"|"completed"|"unchanged"|"failed"|"cancelled";summaryApplied:boolean;error?:string;createdAt?:string;startedAt?:string;summaryCreatedAt?:string;firstKeptEntryId?:number;summarizedEntries?:number;estimatedTokensBefore?:number;historyRetained?:true;}
export interface BotContextStatus {automatic:true;estimatedTokens:number;activeEntries:number;contextWindow:number;compactions:CompactionReceipt[];historyRetained:true;}

export * from "./avatars";
