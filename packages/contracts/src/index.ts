export type RunStatus = "queued" | "running" | "waiting_approval" | "completed" | "failed" | "cancelled" | "interrupted";
export type ComputerApprovalMode = "ask" | "automatic";
export interface Bot { id: string; name: string; instructions: string; runtime: "pi"; model: string; computerApprovalMode?: ComputerApprovalMode; createdAt: string; updatedAt: string; }
export interface Message { id: string; botId: string; runId?: string; role: "user" | "assistant" | "tool" | "system"; kind?: "progress" | "final"; text: string; createdAt: string; }
export interface Run { id: string; botId: string; operationId: string; status: RunStatus; createdAt: string; updatedAt: string; error?: string; }
/** A newest-first history page plus all currently active runs, independent of pagination. */
export interface RunPage { runs: Run[]; activeRuns: Run[]; nextCursor: string | null; }
export interface BotEvent { id: number; botId: string; runId?: string; type: string; data: Record<string, unknown>; createdAt: string; }
export type ComputerAction =
 | {type:"exec";command:string;timeoutMs?:number}
 | {type:"readFile";path:string}
 | {type:"writeFile";path:string;content:string}
 | {type:"listFiles";path?:string}
 | {type:"screenshot"}
 | {type:"click";x:number;y:number;button?:"left"|"right"|"middle"}
 | {type:"type";text:string}
 | {type:"key";key:string}
 | {type:"scroll";direction:"up"|"down";amount?:number}
 | {type:"navigate";url:string}
 | {type:"checkpoint"};
export interface ComputerResult { operationId:string;status:"completed"|"failed"|"interrupted";output?:string;exitCode?:number;artifactId?:string;mimeType?:string;checkpointId?:string;error?:string; }
export interface ComputerStatus { id:string;provider:"cloudflare";state:"stopped"|"starting"|"running"|"unavailable";capabilities:string[];lastCheckpointId?:string;error?:{code:string;message:string}; }
export interface Approval {id:string;botId:string;runId:string;operationId:string;toolCallId?:string;action:ComputerAction;status:"pending"|"approved"|"denied"|"executing"|"completed"|"failed"|"interrupted";createdAt:string;expiresAt:string;result?:ComputerResult;}
export interface ComputerProvider {exec(botId:string,operationId:string,action:ComputerAction):Promise<ComputerResult>;status(botId:string):Promise<ComputerStatus>;checkpoint(botId:string):Promise<ComputerResult>;}
export interface ApiError {error:{code:string;message:string};}
