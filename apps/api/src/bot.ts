import { DurableObject } from "cloudflare:workers";
import type { ModelCatalog, ModelSettings, AgentDelegation, Approval, Bot, BotEvent, ComputerAction, ComputerResult, ComputerStatus, ConnectionRequest, Message, MessageProvenance, MessagePage, Run, RunDelegation, RunPage, RunStatus } from "@botspace/contracts";
import {isModelErrorCode, MODEL_FAILURES} from "@botspace/contracts";
import { createCloudComputerProvider, touchCloudComputer, suspendCloudComputer, deleteCloudComputer, ComputerProviderError } from "@botspace/computer";
import { createPiRuntime, parseRuntimeLimit, ModelConfigurationError, type AgentRuntime, type RuntimeApprovalContext, type RuntimeApprovalSummary, type RuntimeToolResult, type RuntimeHostToolRequest, type RuntimeSubagent } from "@botspace/runtime";
import { agentCoordinatorRequest } from "./agent-coordination";
import { hostTools, validateHostArguments, githubDevelopmentSkill, workspaceAppsSkill } from "./host-tools";
import { WorkspaceApps } from "./workspace-apps";
import { computerActivityInput, hostActivityInput } from "./tool-activity";
import type { Env } from "./env";
import { ApiError, errorResponse, json } from "./errors";
import { body, fingerprint, operationId, parseAction, parseMessage, UUID } from "./validation";

type JsonRow = {data:string};
type RunRow = JsonRow & {id:string;operation_id:string;fingerprint:string;native_operation_id:string};
import {uploadChatImage} from "./chat-images";
import {maintenanceRequest} from "./bot-maintenance";
type Submission = {operation_id:string;run_id:string;text:string;admitted:number;subagent_id?:string|null};
type MentionDelivery = {operation_id:string;run_id:string;target_id:string;text:string;attempts:number};

type AdmissionRetry = {attempts:number;next_at:number};
type ProcessRow = {process_id:string;run_id:string|null;subagent_id:string|null;tool_call_id:string|null;action:string;input:string;status:ComputerResult["status"];result:string|null;dispatch_state:"registered"|"dispatching"|"uncertain"|"received";cancel_requested:number;cancel_attempts:number;next_at:number};
type ProcessObservation = {process_id:string;sequence:number;operation_id:string|null;next_at:number};
type RuntimeProjection = {type:string;data:Record<string,unknown>;operationId?:string;eventKey?:string};
type RuntimeAnswer = {answerId?:string;answerOperationId?:string;cancellationId?:string};
type RunCancellation = NonNullable<Run["cancellation"]>;
type PendingRunCancellation = {id:string;operation_id:string|null;subagent_id:string|null;cancellation_id:string|null;attempts:number;next_at:number};
const terminal = new Set<RunStatus>(["completed","failed","cancelled","interrupted"]);
const automatic = new Set<ComputerAction["type"]>(["readFile","listFiles","screenshot","checkpoint","execPoll","execCancel"]);
const gui = new Set<ComputerAction["type"]>(["navigate","click","move","doubleClick","drag","type","key","scroll"]);
const timestamp = ()=>new Date().toISOString();
const legacyAdmissionFailure="The agent runtime could not accept this run.";
const admissionPending="Message saved. Delivery to the agent is being retried.";
const admissionExhausted="Message saved, but delivery to the agent could not be confirmed. Retry this message to resume delivery.";
const maxAdmissionAttempts=5;
// Host runs are input receipts, not workers: several running inputs can share
// one Pi turn. Pi owns execution concurrency (one root, eight child sessions).
// Bound queued input separately, and retain a final circuit breaker for stuck
// projections without aborting or rewriting genuine outstanding work.
const maxNativeQueuedInputs=16;
const maxUserQueuedInputs=32;
const maxInternalQueuedInputs=16;
const maxOutstandingInputs=128;
const capacityPending="Message saved. Waiting for space in the agent inbox.";
async function consumeUnusedBody(request:Request):Promise<void> {
  const reader=request.body?.getReader();let bytes=0;
  if(reader) while(true) {const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.byteLength;if(bytes>300_000){await reader.cancel();throw new ApiError(413,"body_too_large","Request body too large.");}}
}

export class BotDO extends DurableObject<Env> {
  private runtime!:AgentRuntime;
  private computer:ReturnType<typeof createCloudComputerProvider>;
  private admitting=new Map<string,Promise<void>>();
  private admissionQueue:Promise<void>=Promise.resolve();
  private admissionReservations=new Set<string>();
  private capacityWakes=new Map<string,Promise<void>>();
  private mentioning=new Map<string,Promise<void>>();
  private observing=new Set<string>();
  private recovering?:Promise<void>;
  private reconcilingConnections?:Promise<void>;
  private lastConnectionCheck=0;
  private finishingApprovals=new Map<string,Promise<void>>();
  private cancellingProcesses=new Map<string,Promise<void>>();
  private flushingRunCancellations?:Promise<void>;
  private pollingProcesses=new Map<string,Promise<void>>();
  private dispatchingProcesses=new Map<string,number>();
  private streams=0;
  private lastComputerTouch=0;
  private takingControl=false;
  private suspending?:Promise<ComputerStatus>;
  private deleted=false;
  private taskDeleting=false;
  private deleting?:Promise<void>;
  private closeStreams=new Set<()=>void>();

  constructor(ctx:DurableObjectState,env:Env) {
    super(ctx,env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS bot_deletion (id INTEGER PRIMARY KEY CHECK(id=1),bot_id TEXT NOT NULL)");
    this.deleted=ctx.storage.sql.exec<{bot_id:string}>("SELECT bot_id FROM bot_deletion WHERE id=1").toArray().length>0;
    this.computer=createCloudComputerProvider(env.COMPUTER);
    // A deleted object's identity is never reused. Do not reopen Pi or recreate
    // conversation state when a delayed request/alarm wakes its tombstone.
    if(this.deleted) return;
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS config (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL, native_operation_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS runs_status_idx ON runs (json_extract(data,'$.status'));
      CREATE TABLE IF NOT EXISTS submissions (operation_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, text TEXT NOT NULL, admitted INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS admission_sources (run_id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('user','internal')));
      CREATE TABLE IF NOT EXISTS capacity_waits (operation_id TEXT PRIMARY KEY,run_id TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS capacity_waits_run_idx ON capacity_waits(run_id);
      CREATE TABLE IF NOT EXISTS admission_retries (operation_id TEXT PRIMARY KEY, attempts INTEGER NOT NULL, next_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS configuration_admissions (operation_id TEXT PRIMARY KEY, code TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, source_key TEXT UNIQUE, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS approvals_status_expiry_idx ON approvals (json_extract(data,'$.status'),json_extract(data,'$.expiresAt'));
      CREATE TABLE IF NOT EXISTS connections (id TEXT PRIMARY KEY, operation_id TEXT UNIQUE NOT NULL, fingerprint TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, source_key TEXT UNIQUE, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mention_deliveries (operation_id TEXT PRIMARY KEY,run_id TEXT NOT NULL,target_id TEXT NOT NULL,text TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS cancelled_agent_inputs (operation_id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS run_stops (run_id TEXT PRIMARY KEY,cancellation TEXT);
      CREATE TABLE IF NOT EXISTS pending_run_cancellations (id TEXT PRIMARY KEY,operation_id TEXT,subagent_id TEXT,cancellation_id TEXT,attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS task_cancel_fences (task_id TEXT PRIMARY KEY,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS admission_fences (operation_id TEXT PRIMARY KEY,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS run_processes (process_id TEXT PRIMARY KEY,run_id TEXT,subagent_id TEXT,tool_call_id TEXT,action TEXT NOT NULL,input TEXT NOT NULL,status TEXT NOT NULL,result TEXT,dispatch_state TEXT NOT NULL DEFAULT 'registered',cancel_requested INTEGER NOT NULL DEFAULT 0,cancel_attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS computer_operations (operation_id TEXT PRIMARY KEY,action TEXT NOT NULL,run_id TEXT);
      CREATE TABLE IF NOT EXISTS process_observations (process_id TEXT PRIMARY KEY,sequence INTEGER NOT NULL DEFAULT 0,operation_id TEXT,next_at INTEGER NOT NULL);
    `);
    if(!ctx.storage.sql.exec<{name:string}>("PRAGMA table_info(submissions)").toArray().some(column=>column.name==="subagent_id")) ctx.storage.sql.exec("ALTER TABLE submissions ADD COLUMN subagent_id TEXT");
    if(!ctx.storage.sql.exec<{name:string}>("PRAGMA table_info(run_processes)").toArray().some(column=>column.name==="dispatch_state")) ctx.storage.sql.exec("ALTER TABLE run_processes ADD COLUMN dispatch_state TEXT NOT NULL DEFAULT 'registered'");
    this.runtime=createPiRuntime({
      owner:this,
      storage:ctx.storage,
      ai:env.AI,
      maxGenerations:parseRuntimeLimit(env.BOTSPACE_MAX_GENERATIONS,"BOTSPACE_MAX_GENERATIONS"),
      maxToolCalls:parseRuntimeLimit(env.BOTSPACE_MAX_TOOL_CALLS,"BOTSPACE_MAX_TOOL_CALLS"),
      ...(env.CHATGPT?{chatgpt:{models:async()=>{
        const connection=env.CHATGPT!.get(env.CHATGPT!.idFromName("owner"));
        const response=await connection.fetch(new Request("https://chatgpt/models"));
        if(!response.ok)throw new Error("The connected model catalogue is unavailable. Retry shortly.");
        return response.json<ModelCatalog>();
      },fetch:async(request:Request)=>{
        const url=new URL(request.url);
        if(url.href!=="https://api.openai.com/v1/responses" || request.method!=="POST") throw new Error("Unsupported ChatGPT inference route");
        const connection=env.CHATGPT!.get(env.CHATGPT!.idFromName("owner"));
        return connection.fetch(new Request("https://chatgpt/responses",{method:"POST",headers:{"content-type":"application/json"},body:request.body,signal:request.signal}));
      }}}:{}),
      getBot:async()=>this.currentBot(),
      getApprovalContext:async()=>this.approvalContext(),
      onAdmissionRetry:async(operationId)=>this.admit(operationId),
      onSubagentMessage:async(input)=>this.receiveSubagentMessage(input),
      tools:{
        execute:async(input)=>this.executeTool(input),
        catalog:async()=>hostTools,
        call:async(input)=>this.executeHostTool(input),
        readImage:async(artifactId)=>this.readImage(artifactId),
      },
      onEvent:async(event)=>this.project(event),
    });
  }

  private active():void {if(this.deleted || this.taskDeleting) throw new ApiError(404,"not_found","Bot not found.");}
  private async deleteTaskConversation(taskId:string,botId:string):Promise<void> {
    if(!UUID.test(taskId) || !UUID.test(botId) || !this.ctx.id.equals(this.env.BOT.idFromName(`owner:task:${taskId}`))) throw new ApiError(403,"task_mismatch","Task identity mismatch.");
    const config=this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM config WHERE id=1").toArray()[0];
    const tombstone=this.ctx.storage.sql.exec<{bot_id:string}>("SELECT bot_id FROM bot_deletion WHERE id=1").toArray()[0];
    if(!config) {
      if(tombstone && tombstone.bot_id!==botId) throw new ApiError(403,"task_mismatch","Task identity mismatch.");
      this.ctx.storage.sql.exec("INSERT OR IGNORE INTO bot_deletion(id,bot_id) VALUES(1,?)",botId);this.deleted=true;return;
    }
    if((JSON.parse(config.data) as Bot).id!==botId || (tombstone && tombstone.bot_id!==botId)) throw new ApiError(403,"task_mismatch","Task identity mismatch.");
    this.taskDeleting=true;
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO bot_deletion(id,bot_id) VALUES(1,?)",botId);
    try {
      if(this.deleted) {
        // After eviction the durable tombstone prevents runtime recovery. Cancel
        // any computer sessions left in the task's journal before removing it.
        const processes=this.ctx.storage.sql.exec<{process_id:string;status:string}>("SELECT process_id,status FROM run_processes WHERE status='running' OR cancel_requested=1").toArray();
        for(const process of processes) {const result=await this.computer.cancel(botId,process.process_id);if(result.status==="running")throw new Error("Task process cancellation is not confirmed");}
      } else {
        const active=this.ctx.storage.sql.exec<{id:string}>("SELECT id FROM runs WHERE json_extract(data,'$.status') IN ('queued','running','waiting_approval','waiting_connection')").toArray();
        for(const run of active) await this.cancelRun(run.id);
        await Promise.all([this.flushProcessCancellations(),this.flushRunCancellations()]);
        this.deleted=true;
        for(const close of this.closeStreams)close();
        await this.runtime?.destroy();
        await Promise.allSettled([...this.admitting.values(),...this.finishingApprovals.values(),...(this.recovering?[this.recovering]:[])]);
      }
      const tables=this.ctx.storage.sql.exec<{name:string}>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name!='bot_deletion'").toArray();
      this.ctx.storage.transactionSync(()=>{this.ctx.storage.sql.exec("PRAGMA defer_foreign_keys=ON");for(const table of tables)this.ctx.storage.sql.exec(`DELETE FROM "${table.name.replace(/"/g,'""')}"`);});
      while(true){const keys=[...(await this.ctx.storage.list({limit:128})).keys()];if(!keys.length)break;await this.ctx.storage.delete(keys);}
      await this.ctx.storage.deleteAlarm();
    } catch {throw new ApiError(503,"task_cleanup_pending","Task execution is fenced, but shutdown is not yet confirmed.");}
  }

  private async deleteBot(id:string):Promise<void> {
    if(this.deleting) return this.deleting;
    const previous=this.ctx.storage.sql.exec<{bot_id:string}>("SELECT bot_id FROM bot_deletion WHERE id=1").toArray()[0];
    if(previous && previous.bot_id!==id) throw new ApiError(403,"bot_mismatch","Bot identity mismatch.");
    if(!this.ctx.id.equals(this.env.BOT.idFromName(`owner:${id}`))) throw new ApiError(403,"bot_mismatch","Bot identity mismatch.");
    this.deleted=true;
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO bot_deletion(id,bot_id) VALUES(1,?)",id);
    for(const close of this.closeStreams) close();
    const work=(async()=>{
      // Stop the computer alongside Pi: a native task may be awaiting its tool
      // response. Neither side may acknowledge cleanup before it is quiescent.
      await Promise.all([this.runtime?.destroy(),deleteCloudComputer(this.env.COMPUTER,id),...(this.env.GITHUB?[this.github(`/bots/${id}`,"DELETE")]:[])]);
      await Promise.allSettled([...this.admitting.values(),...this.finishingApprovals.values(),...(this.recovering?[this.recovering]:[]),...(this.suspending?[this.suspending]:[])]);
      const tables=this.ctx.storage.sql.exec<{name:string}>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name!='bot_deletion'").toArray();
      this.ctx.storage.transactionSync(()=>{
        this.ctx.storage.sql.exec("PRAGMA defer_foreign_keys=ON");
        for(const table of tables) this.ctx.storage.sql.exec(`DELETE FROM "${table.name.replace(/"/g,'""')}"`);
      });
      while(true) {
        const keys=[...(await this.ctx.storage.list({limit:128})).keys()];
        if(!keys.length) break;
        await this.ctx.storage.delete(keys);
      }
      await this.ctx.storage.deleteAlarm();
    })().finally(()=>{this.deleting=undefined;});
    this.deleting=work;
    return work;
  }

  private bot():Bot {
    this.active();
    const row=this.ctx.storage.sql.exec<JsonRow>("SELECT data FROM config WHERE id=1").toArray()[0];
    if(!row) throw new ApiError(409,"bot_unconfigured","Bot configuration is not available.");
    return JSON.parse(row.data) as Bot;
  }
  private configure(request:Request):void {
    const raw=request.headers.get("x-botspace-config");
    if(!raw) throw new ApiError(403,"internal_only","Missing internal configuration.");
    this.acceptConfig(JSON.parse(decodeURIComponent(raw)) as Bot);
  }
  private async currentBot():Promise<Bot> {
    const id=this.bot().id;
    try {
      const registry=this.env.WORKSPACE.get(this.env.WORKSPACE.idFromName("owner"));
      const response=await registry.fetch(`https://workspace/${id}`);
      if(!response.ok) throw new Error("Bot configuration unavailable");
      const {bot}=await response.json<{bot:Bot}>();
      this.acceptConfig(bot);
      return this.bot();
    } catch {
      throw new ApiError(503,"bot_policy_unavailable","Current bot settings could not be checked. No new computer action was authorized.");
    }
  }
  private acceptConfig(incoming:Bot):void {
    this.active();
    if(!UUID.test(incoming.id)) throw new ApiError(400,"invalid_bot","Invalid bot identity.");
    const current=this.ctx.storage.sql.exec<JsonRow>("SELECT data FROM config WHERE id=1").toArray()[0];
    if(current) {
      const previous=JSON.parse(current.data) as Bot;
      if(previous.id!==incoming.id) throw new ApiError(403,"bot_mismatch","Bot identity mismatch.");
      // An older in-flight request must not undo a newer permission/config edit.
      // WorkspaceDO assigns a strictly increasing updatedAt to each accepted patch.
      if(incoming.updatedAt<previous.updatedAt) return;
    }
    this.ctx.storage.sql.exec("INSERT INTO config (id,data) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",JSON.stringify(incoming));
  }
  private getRunRow(id:string):RunRow {
    const row=this.ctx.storage.sql.exec<RunRow>("SELECT * FROM runs WHERE id=?",id).toArray()[0];
    if(!row) throw new ApiError(404,"not_found","Run not found.");
    return row;
  }
  private getRun(id:string):Run {return JSON.parse(this.getRunRow(id).data);}
  private runView(row:Pick<RunRow,'data'|'native_operation_id'>):Run {
    const run=JSON.parse(row.data) as Run;
    // Older deployments discarded the subscription error's code. Reclassify
    // its saved native diagnostic for display, without resubmitting the input,
    // changing terminal state/timestamps, or rewriting conversation history.
    if(run.status!=='failed' || run.errorCode && run.errorCode!=='model_request_failed')return run;
    const generic=[undefined,'The model could not complete this request.','The model request failed before an answer completed.',MODEL_FAILURES.model_request_failed];
    if(!generic.includes(run.error))return run;
    const failure=this.runtime.failureDiagnostic?.(row.native_operation_id);
    return failure?.errorCode==='chatgpt_allowance_exhausted'
      ? {...run,errorCode:'chatgpt_allowance_exhausted',error:MODEL_FAILURES.chatgpt_allowance_exhausted}
      : run;
  }
  private summary():{lastMessage?:{text:string;createdAt:string};status:RunStatus|"ready";activeRuns:number;activeAgents:number;activeProcesses:number} {
    const active=this.ctx.storage.sql.exec<{status:RunStatus;subagent_id:string|null}>("SELECT json_extract(data,'$.status') AS status,json_extract(data,'$.subagentId') AS subagent_id FROM runs WHERE json_extract(data,'$.status') IN ('queued','running','waiting_approval','waiting_connection')").toArray();
    const roots=active.filter(run=>!run.subagent_id);
    const priority:RunStatus[]=["waiting_approval","waiting_connection","running","queued"];
    const message=this.ctx.storage.sql.exec<JsonRow>("SELECT data FROM messages WHERE json_extract(data,'$.role') IN ('user','assistant') ORDER BY rowid DESC LIMIT 1").toArray()[0];
    const latest=message?JSON.parse(message.data) as Message:undefined;
    const preview=latest?.text.trim() ? latest.text : latest?.attachments?.length ? (latest.attachments.length===1 ? "Image" : `${latest.attachments.length} images`) : latest?.text;
    const activeProcesses=this.ctx.storage.sql.exec<{total:number}>("SELECT COUNT(*) AS total FROM run_processes WHERE status='running'").toArray()[0].total;
    return {status:priority.find(status=>roots.some(run=>run.status===status))??(activeProcesses?"running":"ready"),activeRuns:roots.length,activeAgents:new Set(active.flatMap(run=>run.subagent_id?[run.subagent_id]:[])).size,activeProcesses,...(latest?{lastMessage:{text:(preview??"").slice(0,240),createdAt:latest.createdAt}}:{})};
  }
  private listMessages(url:URL):MessagePage {
    const raw=url.searchParams.get("limit"),limit=raw===null?500:Number(raw);
    if((raw!==null&&!/^\d+$/.test(raw))||!Number.isSafeInteger(limit)||limit<1||limit>500)
      throw new ApiError(400,"invalid_limit","limit must be an integer from 1 to 500.");
    const cursor=url.searchParams.get("before"),before=cursor===null?undefined:Number(cursor);
    if(cursor!==null&&(!/^\d+$/.test(cursor)||!Number.isSafeInteger(before)||Number(before)<=0))
      throw new ApiError(400,"invalid_cursor","before must be a positive safe integer cursor.");
    type Row={cursor:number;data:string};
    // One extra row determines the end without OFFSET or an archive-wide scan.
    const rows=before===undefined
      ?this.ctx.storage.sql.exec<Row>("SELECT rowid AS cursor,data FROM messages ORDER BY rowid DESC LIMIT ?",limit+1).toArray()
      :this.ctx.storage.sql.exec<Row>("SELECT rowid AS cursor,data FROM messages WHERE rowid<? ORDER BY rowid DESC LIMIT ?",before,limit+1).toArray();
    const page=rows.slice(0,limit);
    return {messages:page.slice().reverse().map(row=>JSON.parse(row.data) as Message),nextCursor:rows.length>limit?String(page[page.length-1].cursor):null};
  }
  private listRuns(url:URL):RunPage {
    const limitRaw=url.searchParams.get("limit");
    const limit=limitRaw===null?30:Number(limitRaw);
    if((limitRaw!==null && !/^\d+$/.test(limitRaw)) || !Number.isSafeInteger(limit) || limit<1 || limit>100) {
      throw new ApiError(400,"invalid_limit","limit must be an integer from 1 to 100.");
    }
    const beforeRaw=url.searchParams.get("before");
    let before:number|undefined;
    if(beforeRaw!==null) {
      before=Number(beforeRaw);
      if(!/^\d+$/.test(beforeRaw) || !Number.isSafeInteger(before) || before<=0) {
        throw new ApiError(400,"invalid_cursor","before must be a positive safe integer cursor.");
      }
    }
    type PageRow = {cursor:number;data:string;native_operation_id:string};
    // One extra row determines whether another page exists, without COUNT(*) or OFFSET.
    const rows=before===undefined
      ? this.ctx.storage.sql.exec<PageRow>("SELECT rowid AS cursor,data,native_operation_id FROM runs ORDER BY rowid DESC LIMIT ?",limit+1).toArray()
      : this.ctx.storage.sql.exec<PageRow>("SELECT rowid AS cursor,data,native_operation_id FROM runs WHERE rowid<? ORDER BY rowid DESC LIMIT ?",before,limit+1).toArray();
    const page=rows.slice(0,limit);
    // Native children also project inputs here. Include every active input so
    // pagination/reconnection cannot hide an older parent or pending approval.
    const activeRows=this.ctx.storage.sql.exec<JsonRow>("SELECT data FROM runs WHERE json_extract(data,'$.status') IN ('queued','running','waiting_approval','waiting_connection') ORDER BY rowid DESC").toArray();
    return {
      runs:page.map(row=>this.runView(row)),
      activeRuns:activeRows.map(row=>JSON.parse(row.data) as Run),
      nextCursor:rows.length>limit?String(page[page.length-1].cursor):null,
    };
  }
  private findRun(nativeOperationId:string):RunRow|undefined {
    return this.ctx.storage.sql.exec<RunRow>("SELECT runs.* FROM runs JOIN submissions ON submissions.run_id=runs.id WHERE submissions.operation_id=?",nativeOperationId).toArray()[0];
  }
  private saveRun(run:Run):void {
    if(this.deleted) return;
    const retryable=["queued","failed"].includes(run.status) && !run.cancellation && this.ctx.storage.sql.exec(
      "SELECT c.operation_id FROM configuration_admissions c JOIN submissions s ON s.operation_id=c.operation_id JOIN runs r ON r.id=s.run_id AND r.native_operation_id=s.operation_id WHERE s.run_id=? AND s.admitted=0 AND NOT EXISTS(SELECT 1 FROM run_stops WHERE run_id=s.run_id)",run.id,
    ).toArray().length>0;
    if(retryable) run.admissionRetryable=true;else delete run.admissionRetryable;
    this.ctx.storage.sql.exec("UPDATE runs SET data=? WHERE id=?",JSON.stringify(run),run.id);
  }
  private emit(type:string,data:Record<string,unknown>,runId?:string,sourceKey?:string):void {
    if(this.deleted) return;
    const event:Omit<BotEvent,"id">={botId:this.bot().id,type,data,createdAt:timestamp(),...(runId?{runId}:{})};
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO events (source_key,data) VALUES (?,?)",sourceKey??null,JSON.stringify(event));
  }
  private startTool(operationId:string,data:Record<string,unknown>,runId:string):void {
    // Re-observing a completed operation must not create a fresh running row.
    // The provider's operation journal remains the authority for effects.
    if(this.ctx.storage.sql.exec("SELECT id FROM events WHERE source_key=?",`tool:${operationId}`).toArray().length) return;
    this.emit("tool.started",{operationId,...data},runId,`tool-start:${operationId}`);
  }
  private addMessage(message:Message,sourceKey:string):void {
    if(this.deleted) return;
    const existed=this.ctx.storage.sql.exec<{id:string}>("SELECT id FROM messages WHERE source_key=?",sourceKey).toArray()[0];
    if(existed) return;
    this.ctx.storage.sql.exec("INSERT INTO messages (id,source_key,data) VALUES (?,?,?)",message.id,sourceKey,JSON.stringify(message));
    this.emit("message.created",{message},message.runId,`message:${sourceKey}`);
  }
  private updateStatus(runId:string,status:RunStatus,error?:string,errorCode?:string):boolean {
    if(this.deleted) return false;
    const run=this.getRun(runId);
    const safeCode=error && isModelErrorCode(errorCode)?errorCode:undefined;
    if(run.status===status && run.error===error && run.errorCode===safeCode) return false;
    const updated:Run={...run,status,updatedAt:timestamp(),...(error?{error}:{})};
    if(!error) delete updated.error;
    if(safeCode) updated.errorCode=safeCode;else delete updated.errorCode;
    this.saveRun(updated);
    this.emit("run.updated",{run:updated},runId);
    if(status==="running" || terminal.has(status)) this.ctx.storage.sql.exec("DELETE FROM capacity_waits WHERE run_id=?",runId);
    if((run.status==="queued" && status==="running") || terminal.has(status)) this.wakeCapacityAdmissions(run.subagentId);
    return true;
  }
  private approvalContext():RuntimeApprovalContext {
    const now=timestamp();
    // Project only host-owned metadata. Commands, text, results and credentials
    // must never enter this generation context through the approval journal.
    type SummaryRow={id:string;status:RuntimeApprovalSummary["status"];actionType:RuntimeApprovalSummary["actionType"];expiresAt:string};
    const active=this.ctx.storage.sql.exec<SummaryRow>(
      "SELECT id,json_extract(data,'$.status') AS status,json_extract(data,'$.action.type') AS actionType,json_extract(data,'$.expiresAt') AS expiresAt FROM approvals WHERE json_extract(data,'$.status')='executing' OR (json_extract(data,'$.status')='pending' AND json_extract(data,'$.expiresAt')>?) ORDER BY rowid DESC",
      now,
    ).toArray();
    const recent=this.ctx.storage.sql.exec<SummaryRow>(
      "SELECT id,json_extract(data,'$.status') AS status,json_extract(data,'$.action.type') AS actionType,json_extract(data,'$.expiresAt') AS expiresAt FROM approvals WHERE json_extract(data,'$.status')!='executing' AND (json_extract(data,'$.status')!='pending' OR json_extract(data,'$.expiresAt')<=?) ORDER BY rowid DESC LIMIT 20",
      now,
    ).toArray().map((approval):RuntimeApprovalSummary=>({...approval,status:approval.status==="pending"?"expired":approval.status}));
    // Expiration is a view here; enforcement and execution remain in the host.
    return {active,recent};
  }
  private hasPendingApproval(runId:string):boolean {
    return this.ctx.storage.sql.exec<JsonRow>("SELECT data FROM approvals").toArray().some(row=>{
      const approval=JSON.parse(row.data) as Approval;
      return approval.runId===runId && ["pending","executing"].includes(approval.status);
    });
  }

  private async project(event:RuntimeProjection):Promise<void> {
    if(this.deleted) return;
    if(event.type.startsWith("subagent.")) {
      const agent=event.data.subagent as RuntimeSubagent|undefined;
      const child=agent?.id?this.recordSubagent(agent):undefined;
      if(agent && (agent.status==="cancelled" || event.type==="subagent.stopped")) {
        const parent=this.findRun(agent.parentOperationId);
        const cancellation=(child?this.runCancellation(child.id):undefined)??(parent?this.runCancellation(parent.id):undefined)??this.cancellationById(event.data.cancellationId);
        this.fenceSubagent(agent.id,cancellation);
      }
      const sourceSubagentId=typeof event.data.subagentId==="string"?event.data.subagentId:event.type==="subagent.message.sent" && typeof event.data.sourceSubagentId==="string"?event.data.sourceSubagentId:undefined;
      // Message events describe both ends of a delivery. Attribute the event to
      // the sender's input; the recipient may belong to an older root task.
      const row=child?this.getRunRow(child.id):sourceSubagentId?this.childRun(sourceSubagentId):event.operationId?this.findRun(event.operationId):undefined;
      this.emit(event.type,event.data,row?.id,event.eventKey?`runtime:${event.eventKey}`:undefined);
      return;
    }
    const row=event.operationId?this.findRun(event.operationId):undefined;
    // Native snapshots replay committed progress after a restart without a run
    // attribution. Stable native IDs deduplicate both live and snapshot paths.
    const progress=event.data;
    if(event.type==="message" && (row || !event.operationId) && progress.role==="assistant" && progress.kind==="progress" && typeof progress.id==="string" && typeof progress.text==="string" && progress.text.trim()) {
      const sourceRun=row?JSON.parse(row.data) as Run:undefined;
      const config=this.ctx.storage.sql.exec<JsonRow>("SELECT data FROM config WHERE id=1").toArray()[0];
      if(config) this.addMessage({id:crypto.randomUUID(),botId:(JSON.parse(config.data) as Bot).id,...(sourceRun?{runId:sourceRun.id}:{}),role:"assistant",kind:"progress",text:progress.text,createdAt:typeof progress.createdAt==="string"?progress.createdAt:timestamp()},`native:${progress.id}`);
    }
    if(!row) return;
    const cancellation=event.type==="run.failed" && row.native_operation_id===event.operationId?this.runtimeCancellation(row.id,event.data.reason,event.data.cancellationId):undefined;
    const run=JSON.parse(this.getRunRow(row.id).data) as Run;
    // Do not expose raw provider error strings, which may contain request details.
    const errorCode=isModelErrorCode(event.data.errorCode)?event.data.errorCode:undefined;
    const data:Record<string,unknown>=event.type==="runtime.error"?{message:"The runtime reported an error."}:event.type==="run.failed"?{...event.data,...(errorCode?{errorCode,publicMessage:MODEL_FAILURES[errorCode]}:{})}:event.data;
    if(event.type==="run.failed"&&!errorCode)delete data.errorCode;
    this.emit(cancellation?"run.cancelled":event.type,cancellation?{cancellation}:data,run.id,event.eventKey?`runtime:${event.eventKey}`:undefined);
    if(row.native_operation_id!==event.operationId) return;
    // A durable terminal event may provide a safe diagnostic after wait() already
    // projected a generic error. It must never undo user cancellation or success.
    const genericInterruption=run.status==="interrupted" && ["The agent run was interrupted before a final answer.","The agent run was interrupted."].includes(run.error??"");
    const enrichFailure=event.type==="run.failed" && (errorCode || typeof event.data.publicMessage==="string") && (run.status==="failed" || genericInterruption);
    if(terminal.has(run.status) && !enrichFailure) return;
    if(Date.now()-this.lastComputerTouch>60_000) {
      this.lastComputerTouch=Date.now();
      this.ctx.waitUntil(touchCloudComputer(this.env.COMPUTER,run.botId).catch(()=>{}));
    }
    if(event.type==="run.started" && !this.hasPendingApproval(run.id) && !this.hasPendingConnection(run.id)) this.updateStatus(run.id,"running");
    if(event.type==="run.completed") await this.completeOperation(event.operationId!,"done",typeof event.data.text==="string"?event.data.text:undefined,undefined,event.data.kind==="progress"?"progress":"final",{answerId:typeof event.data.answerId==="string"?event.data.answerId:undefined,answerOperationId:typeof event.data.answerOperationId==="string"?event.data.answerOperationId:undefined});
    if(event.type==="run.failed") {
      if(this.hasPendingConnection(run.id)) this.updateStatus(run.id,"waiting_connection");
      else if(this.hasPendingApproval(run.id)) this.updateStatus(run.id,"waiting_approval");
      else {
        const failure=this.operationFailure(typeof event.data.reason==="string"?event.data.reason:undefined,errorCode?MODEL_FAILURES[errorCode]:typeof event.data.publicMessage==="string"?event.data.publicMessage:undefined);
        const changed=this.updateStatus(run.id,failure.status,failure.error,errorCode);
        if(changed && errorCode) console.warn(JSON.stringify({event:"model.failure",errorCode,stage:"runtime"}));
      }
    }
  }
  private operationFailure(reason?:string,publicMessage?:string):{status:"failed"|"interrupted";error:string} {
    const failed=reason!==undefined && ["model_error","tool_error","task_error","task_failed","budget_exceeded"].includes(reason);
    return {
      status:failed?"failed":"interrupted",
      error:publicMessage?.slice(0,800) ?? (reason==="model_error"?"The model could not complete this request.":failed?"The agent encountered an execution error.":"The agent run was interrupted before a final answer."),
    };
  }
  private async completeOperation(nativeOperationId:string,status:string,text?:string,reason?:string,kind?:Message["kind"],answer?:RuntimeAnswer):Promise<void> {
    if(this.deleted) return;
    const row=this.findRun(nativeOperationId);
    if(!row) return;
    if(row.native_operation_id===nativeOperationId) this.runtimeCancellation(row.id,reason,answer?.cancellationId);
    const run=this.getRun(row.id);
    // Pi may place several user inputs in one native turn. Every receipt settles
    // its own host run, while one immutable native answer appears exactly once
    // under the input that authored that generation, independent of wait order.
    const answerRow=answer?.answerOperationId?this.findRun(answer.answerOperationId):undefined;
    if(text && kind!=="progress") this.addMessage({id:crypto.randomUUID(),botId:run.botId,runId:answerRow?.id??run.id,role:"assistant",kind:"final",text,createdAt:timestamp()},answer?.answerId?`answer-entry:${answer.answerId}`:`answer:${nativeOperationId}`);
    if(row.native_operation_id!==nativeOperationId || terminal.has(run.status)) return;
    if(this.hasPendingConnection(run.id)) {this.updateStatus(run.id,"waiting_connection");return;}
    if(this.hasPendingApproval(run.id)) {this.updateStatus(run.id,"waiting_approval");return;}
    // The provider checkpoints file mutations before returning their results.
    // Read-only/GUI turns must not stop a warm browser just to copy its profile.
    if(status==="done" && (kind==="progress" || !text?.trim())) this.updateStatus(run.id,"failed","The task stopped before a final answer. Its recorded actions remain available.");
    else if(status==="done") this.updateStatus(run.id,"completed");
    else {const failure=this.operationFailure(reason);this.updateStatus(run.id,failure.status,failure.error);}
  }

  private childRun(id:string):RunRow|undefined {
    return this.ctx.storage.sql.exec<RunRow>("SELECT * FROM runs WHERE json_extract(data,'$.subagentId')=? ORDER BY rowid DESC LIMIT 1",id).toArray()[0];
  }
  /** Child sessions retain an independent host run so approvals, tools and named
   * delegation can continue after the parent has returned its first answer. */
  private recordSubagent(agent:RuntimeSubagent):Run {
    this.active();
    const existing=this.findRun(agent.operationId);
    if(existing) {
      const run=JSON.parse(existing.data) as Run;
      if(terminal.has(run.status)) return run;
      if(existing.native_operation_id!==agent.operationId) return run;
      this.ctx.storage.sql.exec("INSERT OR IGNORE INTO submissions(operation_id,run_id,text,admitted,subagent_id) VALUES(?,?,?,1,?)",agent.operationId,run.id,agent.task,agent.id);
      this.ctx.storage.sql.exec("UPDATE runs SET native_operation_id=? WHERE id=?",agent.operationId,run.id);
      const status=this.hasPendingApproval(run.id)?"waiting_approval":this.hasPendingConnection(run.id)?"waiting_connection":agent.status;
      this.updateStatus(run.id,status,status==="cancelled"?undefined:agent.error);
      return this.getRun(run.id);
    }
    const parent=this.findRun(agent.parentOperationId);
    if(!parent) throw new ApiError(409,"run_not_found","Subagent has no parent run.");
    const source=JSON.parse(parent.data) as Run;
    const run:Run={model:agent.model??source.model,reasoningEffort:agent.reasoningEffort,fast:agent.fast,id:crypto.randomUUID(),botId:source.botId,operationId:`subagent:${agent.operationId}`,subagentId:agent.id,parentRunId:source.id,...(source.delegation?{delegation:source.delegation}:{}),status:this.stopped(source.id)?"cancelled":agent.status,...(this.runCancellation(source.id)?{cancellation:this.runCancellation(source.id)}:{}),createdAt:agent.createdAt,updatedAt:agent.updatedAt};
    this.ctx.storage.transactionSync(()=>{
      this.ctx.storage.sql.exec("INSERT INTO runs(id,operation_id,fingerprint,native_operation_id,data) VALUES(?,?,?,?,?)",run.id,run.operationId,run.operationId,agent.operationId,JSON.stringify(run));
      this.ctx.storage.sql.exec("INSERT OR IGNORE INTO submissions(operation_id,run_id,text,admitted,subagent_id) VALUES(?,?,?,1,?)",agent.operationId,run.id,agent.task,agent.id);
      this.emit("run.updated",{run},run.id,`created:${run.id}`);
    });
    return run;
  }
  private async childToolInput<T extends {runOperationId:string;subagentId?:string;subagentOperationId?:string}>(input:T):Promise<T> {
    if(!input.subagentId) return input;
    const agent=(await this.runtime.subagents()).find(item=>item.id===input.subagentId);
    if(!agent || agent.status==="cancelled" || this.subagentStopped(agent.id) || !input.subagentOperationId) throw new ApiError(409,"agent_inactive","The subagent input is no longer active.");
    // A follow-up may already be durably queued while the current tool returns.
    // Its receipt must not invalidate the input that actually owns this call.
    if(!this.findRun(input.subagentOperationId)) this.recordSubagent({...agent,operationId:input.subagentOperationId,status:"running"});
    return {...input,runOperationId:input.subagentOperationId};
  }
  private async validateMentions(mentions:string[]):Promise<void> {
    const registry=this.env.WORKSPACE.get(this.env.WORKSPACE.idFromName("owner"));
    for(const id of mentions) {
      if(id===this.bot().id) throw new ApiError(400,"self_mention","Mention another bot.");
      const response=await registry.fetch(`https://workspace/${id}`);
      if(!response.ok) throw new ApiError(response.status===404?404:503,"mention_unavailable","A mentioned bot is no longer available.");
    }
  }
  private dispatchMention(id:string):Promise<void> {
    const previous=this.mentioning.get(id);if(previous) return previous;
    const work=(async()=>{
      const delivery=this.ctx.storage.sql.exec<MentionDelivery>("SELECT * FROM mention_deliveries WHERE operation_id=?",id).toArray()[0];
      if(!delivery || delivery.attempts>=maxAdmissionAttempts || this.deleted) return;
      const run=this.getRun(delivery.run_id);
      if(this.stopped(run.id)) {this.ctx.storage.sql.exec("DELETE FROM mention_deliveries WHERE operation_id=?",id);return;}
      try {
        const value=await agentCoordinatorRequest<{delegation:AgentDelegation}>(this.env,"/agents/send",{sourceBotId:run.botId,sourceRunId:run.id,operationId:id,targetBotId:delivery.target_id,text:delivery.text,kind:"mention"});
        if(this.deleted) return;
        this.ctx.storage.sql.exec("DELETE FROM mention_deliveries WHERE operation_id=?",id);
        this.emit("delegation.updated",value,run.id,`mention:${id}`);
      } catch {
        if(this.deleted) return;
        const attempts=delivery.attempts+1;
        this.ctx.storage.sql.exec("UPDATE mention_deliveries SET attempts=? WHERE operation_id=?",attempts,id);
        if(attempts<maxAdmissionAttempts) await this.runtime.scheduleAdmissionRetry(id,1000*2**(attempts-1));
        else this.addMessage({id:crypto.randomUUID(),botId:run.botId,runId:run.id,role:"system",text:"A mentioned bot could not receive this message. Check its conversation before sending a new message.",createdAt:timestamp()},`mention-failed:${id}`);
      }
    })().finally(()=>this.mentioning.delete(id));
    this.mentioning.set(id,work);return work;
  }
  private async retryConfigurationAdmission(row:RunRow):Promise<void> {
    const id=row.native_operation_id;
    if(!this.ctx.storage.sql.exec("SELECT operation_id FROM configuration_admissions WHERE operation_id=?",id).toArray().length) return;
    await this.admitting.get(id);
    const run=this.getRun(row.id);
    if(this.stopped(run.id) || !["failed","queued"].includes(run.status)) return;
    // A typed configuration failure precedes native admission. Confirm that
    // again before adopting corrected settings for this exact saved input.
    try {if((await this.runtime.operation(id)).status!=="missing") return;} catch {return;}
    const selection=run.subagentId?await this.subagent(run.subagentId):await this.currentBot();
    this.ctx.storage.transactionSync(()=>{
      const latest=this.getRunRow(row.id),current=JSON.parse(latest.data) as Run;
      const submission=this.ctx.storage.sql.exec<Submission>("SELECT * FROM submissions WHERE operation_id=?",id).toArray()[0];
      if(this.stopped(row.id) || latest.native_operation_id!==id || !submission || submission.admitted || !["failed","queued"].includes(current.status)
        || !this.ctx.storage.sql.exec("SELECT operation_id FROM configuration_admissions WHERE operation_id=?",id).toArray().length) return;
      // A terminal delivery failure is not already using a queue slot. An
      // explicit resend must not reopen unlimited historical failures at once.
      if(current.status==="failed") this.checkInboxCapacity(this.admissionSource(current));
      this.saveRun({...current,model:selection.model,reasoningEffort:selection.reasoningEffort,fast:selection.fast});
      this.ctx.storage.sql.exec("DELETE FROM admission_retries WHERE operation_id=?",id);
      this.ctx.storage.sql.exec("DELETE FROM configuration_admissions WHERE operation_id=?",id);
      this.updateStatus(row.id,"queued");
    });
  }
  private async createRun(input:{text:string;operationId:string;mentions?:string[];attachments?:string[]},metadata?:{provenance?:MessageProvenance;delegation?:RunDelegation;role?:Message["role"];parentRunId?:string;subagentId?:string;taskId?:string}):Promise<Run> {
    if(metadata?.taskId&&this.ctx.storage.sql.exec("SELECT 1 FROM task_cancel_fences WHERE task_id=?",metadata.taskId).toArray().length)throw new ApiError(409,"task_cancelled","This task was cancelled and cannot accept input.");
    if(this.takingControl) throw new ApiError(409,"computer_busy","Desktop control is being acquired. Retry after the connection is established.");
    if(input.attachments?.length && input.mentions?.length) throw new ApiError(400,"image_mentions_unsupported","Image messages cannot mention other bots yet.");
    const attachments:NonNullable<Message["attachments"]>=[];
    for(const artifactId of input.attachments??[]) {
      const image=await this.env.FILES.head(`bots/${this.bot().id}/artifacts/${artifactId}`);
      if(!image || image.customMetadata?.chatImage!=="true") throw new ApiError(400,"invalid_attachment","Image does not belong to this bot.");
      attachments.push({artifactId,mimeType:image.httpMetadata!.contentType as "image/png"|"image/jpeg",size:image.size});
    }
    this.active();
    const hash=await fingerprint({text:input.text,...(input.attachments?.length?{attachments:input.attachments}:{}),...(input.mentions?.length?{mentions:input.mentions}:{}),...(metadata?.provenance?{provenance:metadata.provenance}:{}),...(metadata?.delegation?{delegation:metadata.delegation}:{}),...(metadata?.subagentId?{subagentId:metadata.subagentId}:{})});

    if(this.takingControl) throw new ApiError(409,"computer_busy","Desktop control is being acquired. Retry after the connection is established.");
    this.active();
    if(!metadata && /^(approval|delegate|connection|subagent|agent-result|subagent-report|mention|process-cancel|process-poll|run-cancel):/.test(input.operationId)) throw new ApiError(400,"reserved_operation_id","This operationId prefix is reserved.");
    if(this.ctx.storage.sql.exec("SELECT 1 FROM admission_fences WHERE operation_id=?",input.operationId).toArray().length)throw new ApiError(409,"admission_fenced","This input was fenced after its request outcome could not be confirmed.");
    if(this.ctx.storage.sql.exec("SELECT operation_id FROM cancelled_agent_inputs WHERE operation_id=?",input.operationId).toArray().length) throw new ApiError(409,"run_cancelled","This delegated input has been cancelled.");
    if(metadata?.parentRunId && this.stopped(metadata.parentRunId)) throw new ApiError(409,"run_cancelled","The parent task has been cancelled.");
    if(metadata?.subagentId && this.subagentStopped(metadata.subagentId)) throw new ApiError(409,"agent_inactive","This subagent has been stopped.");
    const existing=this.ctx.storage.sql.exec<RunRow>("SELECT * FROM runs WHERE operation_id=?",input.operationId).toArray()[0];
    if(existing) {
      if(existing.fingerprint!==hash) throw new ApiError(409,"idempotency_conflict","operationId was already used with different input.");
      await this.retryConfigurationAdmission(existing);
      const run=this.getRun(existing.id);
      const submission=this.ctx.storage.sql.exec<Submission>("SELECT * FROM submissions WHERE operation_id=?",existing.native_operation_id).toArray()[0];
      // An explicit retry can reopen only a known input-delivery failure. Model,
      // tool, cancellation and interrupted-effect outcomes remain terminal.
      if(!this.stopped(run.id) && submission && !submission.admitted && ((run.status==="failed" && run.error===legacyAdmissionFailure) || (run.status==="queued" && run.error===admissionExhausted))) {
        if(run.status==="failed") this.checkInboxCapacity(this.admissionSource(run));
        this.ctx.storage.transactionSync(()=>{
          this.ctx.storage.sql.exec("DELETE FROM admission_retries WHERE operation_id=?",existing.native_operation_id);
          this.updateStatus(run.id,"queued");
        });
      }
      await this.deliverReceipt(existing.native_operation_id,run.id);
      for(const delivery of this.ctx.storage.sql.exec<MentionDelivery>("SELECT * FROM mention_deliveries WHERE run_id=?",existing.id).toArray()) await this.dispatchMention(delivery.operation_id);
      return this.getRun(existing.id);
    }
    if(this.ctx.storage.sql.exec("SELECT 1 FROM admission_fences WHERE operation_id=?",input.operationId).toArray().length)throw new ApiError(409,"admission_fenced","This input was fenced after its request outcome could not be confirmed.");
    await this.validateMentions(input.mentions??[]);
    const selection:ModelSettings|RuntimeSubagent=metadata?.subagentId?await this.subagent(metadata.subagentId):await this.currentBot();
    this.active();
    // Registry validation yielded; serialize duplicate submissions by checking
    // the durable receipt again before the transaction.
    if(this.ctx.storage.sql.exec("SELECT id FROM runs WHERE operation_id=?",input.operationId).toArray().length) return this.createRun(input,metadata);
    if(this.ctx.storage.sql.exec("SELECT 1 FROM admission_fences WHERE operation_id=?",input.operationId).toArray().length)throw new ApiError(409,"admission_fenced","This input was fenced after its request outcome could not be confirmed.");
    if(this.ctx.storage.sql.exec("SELECT operation_id FROM cancelled_agent_inputs WHERE operation_id=?",input.operationId).toArray().length) throw new ApiError(409,"run_cancelled","This delegated input has been cancelled.");
    if(metadata?.parentRunId && this.stopped(metadata.parentRunId)) throw new ApiError(409,"run_cancelled","The parent task has been cancelled.");
    if(metadata?.subagentId && this.subagentStopped(metadata.subagentId)) throw new ApiError(409,"agent_inactive","This subagent has been stopped.");
    if(this.suspending) throw new ApiError(409,"computer_busy","The computer is being suspended. Retry after it stops.");
    const source=!metadata?.provenance && metadata?.role!=="system"?"user":"internal";
    this.checkInboxCapacity(source);
    if(metadata?.taskId&&this.ctx.storage.sql.exec("SELECT 1 FROM task_cancel_fences WHERE task_id=?",metadata.taskId).toArray().length)throw new ApiError(409,"task_cancelled","This task was cancelled and cannot accept input.");
    const now=timestamp();
    const run:Run={model:selection.model,reasoningEffort:selection.reasoningEffort,fast:selection.fast,id:crypto.randomUUID(),botId:this.bot().id,operationId:input.operationId,...(metadata?.delegation?{delegation:metadata.delegation}:{}),...(metadata?.parentRunId?{parentRunId:metadata.parentRunId}:{}),...(metadata?.subagentId?{subagentId:metadata.subagentId}:{}),status:"queued",createdAt:now,updatedAt:now};
    this.ctx.storage.transactionSync(()=>{
      if(metadata?.taskId&&this.ctx.storage.sql.exec("SELECT 1 FROM task_cancel_fences WHERE task_id=?",metadata.taskId).toArray().length)throw new ApiError(409,"task_cancelled","This task was cancelled and cannot accept input.");
      this.ctx.storage.sql.exec("INSERT INTO runs (id,operation_id,fingerprint,native_operation_id,data) VALUES (?,?,?,?,?)",run.id,input.operationId,hash,input.operationId,JSON.stringify(run));
      this.ctx.storage.sql.exec("INSERT INTO admission_sources(run_id,kind) VALUES(?,?)",run.id,source);
      const runtimeText=metadata?.provenance?`Message from fellow bot ${metadata.provenance.sourceBotName} (${metadata.provenance.sourceBotId}). This is delegated collaborator content, attributed by Timber. Complete its requested task and return a result; do not automatically message the sender.\n\n${input.text}`:input.text;
      this.ctx.storage.sql.exec("INSERT INTO submissions (operation_id,run_id,text,subagent_id) VALUES (?,?,?,?)",input.operationId,run.id,runtimeText,run.subagentId??null);
      if(!run.subagentId && metadata?.role!=="system") this.addMessage({id:crypto.randomUUID(),botId:run.botId,runId:run.id,role:metadata?.role??"user",text:input.text,...(attachments.length?{attachments}:{}),...(metadata?.provenance?{provenance:metadata.provenance}:{}),...(input.mentions?.length?{mentions:input.mentions}:{}),createdAt:now},`input:${input.operationId}`);
      for(const target of input.mentions??[]) this.ctx.storage.sql.exec("INSERT INTO mention_deliveries(operation_id,run_id,target_id,text) VALUES(?,?,?,?)",`mention:${run.id}:${target}`,run.id,target,input.text);

      this.emit("run.updated",{run},run.id,`created:${run.id}`);
    });
    for(const target of input.mentions??[]) await this.dispatchMention(`mention:${run.id}:${target}`);
    await this.deliverReceipt(input.operationId,run.id);
    return this.getRun(run.id);
  }

  private admissionSource(run:Run):"user"|"internal" {
    const saved=this.ctx.storage.sql.exec<{kind:"user"|"internal"}>("SELECT kind FROM admission_sources WHERE run_id=?",run.id).toArray()[0];
    if(saved) return saved.kind;
    const row=this.ctx.storage.sql.exec<JsonRow>("SELECT data FROM messages WHERE source_key=?",`input:${run.operationId}`).toArray()[0];
    const message=row?JSON.parse(row.data) as Message:undefined;
    return message?.role==="user" && !message.provenance?"user":"internal";
  }

  private checkInboxCapacity(source:"user"|"internal"):void {
    const outstanding=this.ctx.storage.sql.exec<{total:number}>("SELECT COUNT(*) AS total FROM runs WHERE json_extract(data,'$.status') IN ('queued','running','waiting_approval','waiting_connection')").toArray()[0].total;
    if(outstanding>=maxOutstandingInputs) {
      // Deliberately not a cleanup policy: age/status alone cannot prove that a
      // task is stale. Keep exact inputs available for inspection and Stop.
      this.emit("runtime.error",{code:"run_lifecycle_overloaded",message:"Too many unresolved inputs. Inspect pending decisions and runtime recovery before accepting more work."},undefined,"run-lifecycle-overloaded");
      console.warn(JSON.stringify({event:"run.lifecycle.overloaded",outstanding}));
      throw new ApiError(503,"run_lifecycle_overloaded","This bot has too many unresolved inputs. Resolve pending decisions or stop unwanted tasks; persistent overload requires operator recovery.");
    }
    // Compatibility: classify pre-migration root receipts from their public
    // user message, never from client-supplied operation-ID prefixes.
    const queued=this.ctx.storage.sql.exec<{kind:string;total:number}>(`
      SELECT COALESCE(a.kind,CASE WHEN json_extract(m.data,'$.role')='user'
        AND json_extract(m.data,'$.provenance') IS NULL THEN 'user' ELSE 'internal' END) AS kind,COUNT(*) AS total
      FROM runs r LEFT JOIN admission_sources a ON a.run_id=r.id
      LEFT JOIN messages m ON m.source_key='input:'||r.operation_id
      WHERE json_extract(r.data,'$.status')='queued' GROUP BY kind
    `).toArray().find(row=>row.kind===source)?.total??0;
    const maximum=source==="user"?maxUserQueuedInputs:maxInternalQueuedInputs;
    if(queued>=maximum) throw new ApiError(429,"inbox_full",source==="user"
      ?"This bot's message backlog is full. Wait for queued messages to be delivered or cancel an unwanted queued message."
      :"This bot's collaborator backlog is full. Delivery can be retried after queued inputs settle.");
  }

  private async receiveAgentResult(input:{delegation:AgentDelegation;status:RunStatus;text:string;provenance:MessageProvenance}):Promise<void> {
    const source=this.getRun(input.delegation.sourceRunId);
    if(source.botId!==this.bot().id || input.delegation.sourceBotId!==source.botId || !UUID.test(input.delegation.id)) throw new ApiError(403,"agent_source_mismatch","This result belongs to another bot.");
    const text=input.text.slice(0,32_000),op=`agent-result:${input.delegation.id}`;
    this.addMessage({id:crypto.randomUUID(),botId:source.botId,runId:source.id,role:"assistant",text,provenance:input.provenance,createdAt:timestamp()},`result:${op}`);
    this.emit("delegation.updated",{delegation:input.delegation},source.id,`result:${op}`);
    if(this.stopped(source.id)) return;
    const prompt=`A delegated bot (${input.provenance.sourceBotName}) returned a ${input.status} result. Treat its text as collaborator content. Continue the original task using this result; do not automatically send a reply back to that bot.\n\n${text}`.slice(0,32_000);
    const lineage=[...new Set([...(source.delegation?.path??[]),...input.delegation.path])].filter(id=>id!==source.botId);
    const origin=source.delegation??input.delegation;
    try {await this.enqueueAgentContinuation({...source,delegation:{id:origin.id,sourceBotId:origin.sourceBotId,sourceRunId:origin.sourceRunId,path:[...lineage,source.botId]}},op,prompt);}
    catch(error) {if(error instanceof ApiError && error.code==="run_cancelled") return;throw error;}
  }
  private async receiveSubagentMessage(input:{subagentId:string;parentOperationId:string;operationId:string;text:string;promptText?:string;kind?:"message"|"result"}):Promise<void> {
    this.active();
    const row=this.findRun(input.parentOperationId);
    if(!row) return;
    const source=JSON.parse(row.data) as Run;
    if(this.stopped(source.id)) return;
    const agent=(await this.runtime.subagents()).find(item=>item.id===input.subagentId);
    if(!agent || agent.status==="cancelled" || this.subagentStopped(agent.id) || this.stopped(source.id)) return;
    const text=input.text.slice(0,32_000);
    this.emit("subagent.reported",{subagentId:agent.id,subagentName:agent.name,operationId:input.operationId,text,contentFormat:"plain",...(input.kind?{kind:input.kind}:{})},source.id,`report:${input.operationId}`);
    // Attribution belongs to the model input, while the activity card supplies
    // its own sender header. Keep the exact prior prompt for durable retry IDs.
    const prompt=`Subagent ${agent.name}: ${input.promptText??input.text}`.slice(0,32_000);
    await this.enqueueAgentContinuation(source,input.operationId,prompt);
  }
  private async enqueueAgentContinuation(source:Run,op:string,text:string):Promise<void> {
    if(this.stopped(source.id)) return;
    // Separate input runs keep queued child messages from superseding an
    // in-flight tool or approval. Only approval/connection continuations reuse a run.
    await this.createRun({operationId:op,text},{role:"system",parentRunId:source.id,...(source.subagentId?{subagentId:source.subagentId}:{}),...(source.delegation?{delegation:source.delegation}:{})});
  }
  private async cancelAgentInput(op:string):Promise<void> {
    if(!/^delegate:[0-9a-f-]{36}$/i.test(op)) throw new ApiError(400,"invalid_request","Invalid delegated operation ID.");
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO cancelled_agent_inputs(operation_id) VALUES(?)",op);
    const row=this.ctx.storage.sql.exec<RunRow>("SELECT * FROM runs WHERE operation_id=?",op).toArray()[0];
    if(row) await this.cancelRun(row.id);
  }
  private async subagent(id:string):Promise<RuntimeSubagent> {
    const agent=(await this.runtime.subagents()).find(item=>item.id===id);
    if(!agent) throw new ApiError(404,"not_found","Subagent not found.");
    return agent;
  }
  private async cancelSubagent(id:string,cancellation?:RunCancellation):Promise<void> {
    // Persist the exact session intent before consulting the runtime. Its native
    // registry may contain newer descendants, which emit their own stop events.
    const rows=this.ctx.storage.sql.exec<RunRow>("SELECT * FROM runs").toArray();
    const ids=new Set(rows.filter(row=>(JSON.parse(row.data) as Run).subagentId===id).map(row=>row.id));
    this.includeDescendants(ids,rows);
    for(const runId of ids) this.fenceRun(runId,cancellation);
    this.queueRunCancellation({subagentId:id},cancellation);
    await Promise.all([this.flushProcessCancellations(),this.flushRunCancellations()]);
  }
  private includeDescendants(ids:Set<string>,rows:RunRow[]):void {
    for(let changed=true;changed;) {changed=false;for(const row of rows) {const run=JSON.parse(row.data) as Run;if(run.parentRunId && ids.has(run.parentRunId) && !ids.has(row.id)) {ids.add(row.id);changed=true;}}}
  }
  private queueRunCancellation(target:{operationId?:string;subagentId?:string},cancellation?:RunCancellation):void {
    const id=target.subagentId?`agent:${target.subagentId}`:`run:${target.operationId}`;
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO pending_run_cancellations(id,operation_id,subagent_id,cancellation_id) VALUES(?,?,?,?)",id,target.operationId??null,target.subagentId??null,cancellation?.id??null);
    // Also wake intents appended while an existing drain is awaiting native IO.
    this.ctx.waitUntil(this.runtime.scheduleAdmissionRetry(`run-cancel:${id}`,1000).catch(()=>{}));
  }
  private flushRunCancellations():Promise<void> {
    if(this.flushingRunCancellations) return this.flushingRunCancellations;
    const work=(async()=>{
      const pending=this.ctx.storage.sql.exec<PendingRunCancellation>("SELECT * FROM pending_run_cancellations").toArray();
      for(const item of pending) {
        if(item.next_at>Date.now()) {await this.runtime.scheduleAdmissionRetry(`run-cancel:${item.id}`,item.next_at-Date.now());continue;}
        // Recovery retries an exact input/session, never a blanket conversation
        // abort. Keep admission gated until this durable intent is acknowledged.
        try {
          await this.runtime.scheduleAdmissionRetry(`run-cancel:${item.id}`,1000);
          if(item.subagent_id) await this.runtime.cancelSubagent(item.subagent_id);
          else await this.runtime.cancel(item.operation_id!,item.cancellation_id?{cancellationId:item.cancellation_id}:undefined);
          this.ctx.storage.sql.exec("DELETE FROM pending_run_cancellations WHERE id=?",item.id);
        } catch {
          const attempts=item.attempts+1,delay=Math.min(60_000,1000*2**Math.min(attempts-1,6));
          this.ctx.storage.sql.exec("UPDATE pending_run_cancellations SET attempts=?,next_at=? WHERE id=?",attempts,Date.now()+delay,item.id);
          await this.runtime.scheduleAdmissionRetry(`run-cancel:${item.id}`,delay);
        }
      }
    })().finally(()=>{this.flushingRunCancellations=undefined;});
    this.flushingRunCancellations=work;return work;
  }
  private fenceSubagent(id:string,cancellation?:RunCancellation):void {
    for(const row of this.ctx.storage.sql.exec<{id:string}>("SELECT id FROM runs WHERE json_extract(data,'$.subagentId')=?",id).toArray()) this.fenceRun(row.id,cancellation);
    this.ctx.waitUntil(this.flushProcessCancellations());
  }
  private runtimeCancellation(runId:string,reason:unknown,cancellationId:unknown):RunCancellation|undefined {
    if(reason!=="aborted" || typeof cancellationId!=="string") return;
    // Only a locally persisted Stop request can label a native abort as user
    // cancellation. Provider failures and unrequested aborts remain errors.
    const cancellation=this.cancellationById(cancellationId);
    if(!cancellation) return;
    this.fenceRun(runId,cancellation);
    this.ctx.waitUntil(this.flushProcessCancellations());
    return cancellation;
  }
  private cancellationById(id:unknown):RunCancellation|undefined {
    if(typeof id!=="string") return;
    const row=this.ctx.storage.sql.exec<{cancellation:string}>("SELECT cancellation FROM run_stops WHERE json_extract(cancellation,'$.id')=? LIMIT 1",id).toArray()[0];
    return row?JSON.parse(row.cancellation):undefined;
  }
  private subagentStopped(id:string):boolean {
    return this.ctx.storage.sql.exec("SELECT 1 FROM run_stops JOIN runs ON runs.id=run_stops.run_id WHERE json_extract(runs.data,'$.subagentId')=? LIMIT 1",id).toArray().length>0;
  }
  private stopped(id:string):boolean {
    return this.getRun(id).status==="cancelled" || this.ctx.storage.sql.exec("SELECT run_id FROM run_stops WHERE run_id=?",id).toArray().length>0;
  }
  private runCancellation(id:string):RunCancellation|undefined {
    const row=this.ctx.storage.sql.exec<{cancellation:string|null}>("SELECT cancellation FROM run_stops WHERE run_id=?",id).toArray()[0];
    return row?.cancellation?JSON.parse(row.cancellation):undefined;
  }
  private requestCancellation(id:string):RunCancellation {
    const cancellation:RunCancellation=this.runCancellation(id)??{id:crypto.randomUUID(),requestedRunId:id};
    this.ctx.storage.sql.exec("INSERT INTO run_stops(run_id,cancellation) VALUES(?,?) ON CONFLICT(run_id) DO UPDATE SET cancellation=COALESCE(run_stops.cancellation,excluded.cancellation)",id,JSON.stringify(cancellation));
    this.emit("run.cancellation.requested",{cancellation},id,`cancellation:${cancellation.id}`);
    return cancellation;
  }
  private fenceRun(id:string,cancellation?:RunCancellation):void {
    this.ctx.storage.sql.exec("INSERT INTO run_stops(run_id,cancellation) VALUES(?,?) ON CONFLICT(run_id) DO UPDATE SET cancellation=COALESCE(run_stops.cancellation,excluded.cancellation)",id,cancellation?JSON.stringify(cancellation):null);
    const run=this.getRun(id);
    // Stop fences future work without rewriting already recorded answers or
    // genuine failures. Completed tasks may still own cancellable processes.
    if(!terminal.has(run.status)) {
      if(cancellation) this.saveRun({...run,cancellation});
      this.updateStatus(id,"cancelled");
    } else if(cancellation && !run.cancellation) {
      // Consumers such as the named-bot coordinator need the Stop intent even
      // when its owner finished earlier. The prior outcome remains unchanged.
      const updated={...run,cancellation};
      this.saveRun(updated);this.emit("run.updated",{run:updated},id);
    }
    this.ctx.storage.sql.exec("UPDATE run_processes SET cancel_requested=1,next_at=0 WHERE run_id=? AND status='running'",id);
    // Persist the fence before any await. A provider receipt or a recovered
    // approval must never restart a command after Stop has been accepted.
    for(const row of this.ctx.storage.sql.exec<JsonRow>("SELECT data FROM approvals WHERE json_extract(data,'$.runId')=? AND json_extract(data,'$.status')='executing' AND json_extract(data,'$.action.type')='exec'",id).toArray()) {
      const approval=JSON.parse(row.data) as Approval;
      approval.status="interrupted";approval.result={operationId:approval.operationId,processId:approval.operationId,status:"interrupted",error:"Run stopped. Process cancellation requested."};
      this.saveApproval(approval);this.emit("approval.updated",{approval},id);
    }
    for(const row of this.ctx.storage.sql.exec<JsonRow>("SELECT data FROM approvals WHERE json_extract(data,'$.runId')=? AND json_extract(data,'$.status')='pending'",id).toArray()) {
      const approval=JSON.parse(row.data) as Approval;
      approval.status="denied";this.saveApproval(approval);this.emit("approval.updated",{approval},id);
    }
    for(const row of this.ctx.storage.sql.exec<JsonRow>("SELECT data FROM connections WHERE json_extract(data,'$.runId')=? AND json_extract(data,'$.status')='pending'",id).toArray()) {
      const connection=JSON.parse(row.data) as ConnectionRequest;
      connection.status="cancelled";this.saveConnection(connection);this.emit("connection.updated",{connection},id);
    }
  }

  private async waitForCapacity(operationId:string,runId:string):Promise<void> {
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO capacity_waits(operation_id,run_id) VALUES(?,?)",operationId,runId);
    this.updateStatus(runId,"queued",capacityPending);
    await this.runtime.scheduleAdmissionRetry(operationId,1000);
  }
  private async deliverReceipt(operationId:string,runId:string):Promise<void> {
    const submission=this.ctx.storage.sql.exec<Submission>("SELECT * FROM submissions WHERE operation_id=?",operationId).toArray()[0];
    // The durable receipt must not wait behind an older admission RPC. Persist
    // a wake before acknowledging, then let the capacity lane kick off delivery.
    // Never turn an already-admitted native queued input into a fresh delivery.
    if(this.admitting.size && submission && !submission.admitted && this.getRun(runId).status==="queued" && this.canAdmit(operationId,runId)) {
      await this.waitForCapacity(operationId,runId);
      this.ctx.waitUntil(this.admit(operationId));
      return;
    }
    await this.admit(operationId);
  }
  private wakeCapacityAdmissions(subagentId?:string):void {
    const scope=subagentId??"root";
    if(this.capacityWakes.has(scope)) return;
    const rows=this.ctx.storage.sql.exec<{operation_id:string}>(`
      SELECT c.operation_id FROM runs r
      JOIN capacity_waits c ON c.run_id=r.id AND c.operation_id=r.native_operation_id
      JOIN submissions s ON s.operation_id=c.operation_id
      WHERE json_extract(r.data,'$.status')='queued' AND s.admitted=0
        AND s.subagent_id IS ? AND NOT EXISTS(SELECT 1 FROM run_stops stop WHERE stop.run_id=r.id)
      ORDER BY r.rowid
    `,subagentId??null).toArray();
    if(!rows.length) return;
    // Scheduling is durable and effect-free. Do not await admission from a
    // native status callback; that callback can itself be inside submit().
    const work=(async()=>{for(const row of rows) await this.runtime.scheduleAdmissionRetry(row.operation_id,0);})()
      .catch(()=>{}).finally(()=>this.capacityWakes.delete(scope));
    this.capacityWakes.set(scope,work);
    this.ctx.waitUntil(work);
  }

  /** This outbox only admits durable inputs. Pi owns all execution and tool recovery. */
  private admit(nativeOperationId:string):Promise<void> {
    if(nativeOperationId.startsWith("run-cancel:")) return this.flushRunCancellations();
    if(nativeOperationId.startsWith("process-poll:")) return this.pollProcess(nativeOperationId.slice("process-poll:".length));
    if(nativeOperationId.startsWith("process-cancel:")) return this.cancelProcess(nativeOperationId.slice("process-cancel:".length));
    if(nativeOperationId.startsWith("mention:")) return this.dispatchMention(nativeOperationId);
    const existing=this.admitting.get(nativeOperationId);
    if(existing) return existing;
    // Deduplicate the entire delivery by exact input ID, but do not serialize
    // its receipt: submit can remain pending after Pi has placed/paused an input.
    const operation=this.admitOnce(nativeOperationId).finally(()=>this.admitting.delete(nativeOperationId));
    this.admitting.set(nativeOperationId,operation);
    return operation;
  }
  private async admitOnce(nativeOperationId:string):Promise<void> {
    if(this.deleted) return;
    const submission=this.ctx.storage.sql.exec<Submission>("SELECT * FROM submissions WHERE operation_id=?",nativeOperationId).toArray()[0];
    if(!submission) return;
    const row=this.getRunRow(submission.run_id),run=JSON.parse(row.data) as Run;
    if(!this.canAdmit(nativeOperationId,run.id)) return;
    // A fresh user message must not enter Pi before an earlier persisted Stop
    // has captured its native scope. Otherwise recovery could abort new work.
    await this.flushRunCancellations();
    if(!this.canAdmit(nativeOperationId,run.id)) return;
    if(this.ctx.storage.sql.exec("SELECT id FROM pending_run_cancellations LIMIT 1").toArray().length) {
      await this.runtime.scheduleAdmissionRetry(nativeOperationId,1000);return;
    }
    const retry=this.ctx.storage.sql.exec<AdmissionRetry>("SELECT attempts,next_at FROM admission_retries WHERE operation_id=?",nativeOperationId).toArray()[0];
    if(!submission.admitted && retry && (retry.attempts>=maxAdmissionAttempts || retry.next_at>Date.now())) return;
    try {
      if(!submission.admitted) {
        if(submission.subagent_id) {
          if(!this.canAdmit(nativeOperationId,run.id)) return;
          await this.runtime.sendSubagent(submission.subagent_id,submission.text,{operationId:nativeOperationId});
        } else {
          const message=this.ctx.storage.sql.exec<JsonRow>("SELECT data FROM messages WHERE source_key=?",`input:${nativeOperationId}`).toArray()[0];
          const attachments=message?(JSON.parse(message.data) as Message).attachments:undefined;
          const images=await Promise.all((attachments??[]).map(image=>this.readImage(image.artifactId)));
          // Only capacity reconciliation, reservation and submit kickoff share
          // the lane. Never await an indefinitely pending submit receipt in it.
          const kickoff=this.admissionQueue.then(async()=>{
            if(!this.canAdmit(nativeOperationId,run.id)) return;
            const pending=await this.runtime.pending();
            const states=new Map(pending.map(input=>[input.operationId,input.status]));
            const queued=new Set(pending.filter(input=>input.status==="queued").map(input=>input.operationId));
            // Pending submit RPCs may not yet be visible to Pi. Count their exact
            // IDs once, not again when the native inbox already contains them.
            // A placed or paused native input is no longer an inbox slot even
            // if its transport receipt is still pending. After DO eviction Pi's
            // durable operation state replaces these process-local reservations.
            for(const reserved of this.admissionReservations) {
              const status=states.get(reserved)??(await this.runtime.operation(reserved)).status;
              if(status==="missing" || status==="queued") queued.add(reserved);
            }
            if(queued.size>=maxNativeQueuedInputs && !states.has(nativeOperationId)) {
              const known=await this.runtime.operation(nativeOperationId);
              if(known.status==="missing") return;
            }
            if(!this.canAdmit(nativeOperationId,run.id)) return;
            this.admissionReservations.add(nativeOperationId);
            const receipt=(async()=>{
              try {return await this.runtime.submit(submission.text,{...(run.model?{modelSettings:{model:run.model,reasoningEffort:run.reasoningEffort,fast:run.fast}}:{}),operationId:nativeOperationId,whenBusy:"steer",...(images.length?{images}:{})});}
              finally {this.admissionReservations.delete(nativeOperationId);}
            })();
            // Attach rejection handling before returning the wrapper. The outer
            // admission consumes the original result, outside the short lane.
            void receipt.catch(()=>{});
            return {receipt};
          });
          this.admissionQueue=kickoff.then(()=>{},()=>{});
          const started=await kickoff;
          if(!started) {
            if(this.canAdmit(nativeOperationId,run.id)) await this.waitForCapacity(nativeOperationId,run.id);
            return;
          }
          await started.receipt;
        }
        if(this.deleted) return;
        const configurationFailure=this.ctx.storage.sql.exec("SELECT operation_id FROM configuration_admissions WHERE operation_id=?",nativeOperationId).toArray().length>0;
        this.ctx.storage.sql.exec("UPDATE submissions SET admitted=1 WHERE operation_id=?",nativeOperationId);
        this.ctx.storage.sql.exec("DELETE FROM capacity_waits WHERE operation_id=?",nativeOperationId);
        this.ctx.storage.sql.exec("DELETE FROM admission_retries WHERE operation_id=?",nativeOperationId);
        this.ctx.storage.sql.exec("DELETE FROM configuration_admissions WHERE operation_id=?",nativeOperationId);
        const current=this.getRunRow(run.id),latest=JSON.parse(current.data) as Run;
        if(current.native_operation_id===nativeOperationId && latest.status==="queued" && (configurationFailure || [admissionPending,admissionExhausted,capacityPending].includes(latest.error??""))) this.updateStatus(run.id,"queued");
      }
      if(!submission.subagent_id) this.observe(nativeOperationId);
    } catch(error) {
      // Admission may settle after an approval replaced this native input or the
      // user cancelled it. A stale failure cannot terminate the newer input.
      if(!this.canAdmit(nativeOperationId,run.id)) return;
      // A lost receipt does not mean Pi rejected the input. Reconcile its durable
      // record before retrying the same idempotent input; never restart a tool.
      let known:Awaited<ReturnType<AgentRuntime["operation"]>>|undefined;
      try {if(!submission.subagent_id) known=await this.runtime.operation(nativeOperationId);} catch {/* Keep delivery unconfirmed. */}
      if(!this.canAdmit(nativeOperationId,run.id)) return;
      if(known && known.status!=="missing") {
        this.ctx.storage.sql.exec("UPDATE submissions SET admitted=1 WHERE operation_id=?",nativeOperationId);
        this.ctx.storage.sql.exec("DELETE FROM capacity_waits WHERE operation_id=?",nativeOperationId);
        this.ctx.storage.sql.exec("DELETE FROM admission_retries WHERE operation_id=?",nativeOperationId);
        this.ctx.storage.sql.exec("DELETE FROM configuration_admissions WHERE operation_id=?",nativeOperationId);
        if(known.status==="done" || known.status==="unanswered") await this.completeOperation(nativeOperationId,known.status,known.text,known.reason,known.kind,known);
        else {this.updateStatus(run.id,known.status==="running"?"running":"queued");this.observe(nativeOperationId);}
        return;
      }
      const attempts=(retry?.attempts??0)+1,delayMs=1000*2**(attempts-1);
      if(error instanceof ModelConfigurationError && known?.status==="missing") {
        this.ctx.storage.transactionSync(()=>{
          this.ctx.storage.sql.exec("INSERT OR REPLACE INTO configuration_admissions(operation_id,code) VALUES(?,?)",nativeOperationId,error.code);
          this.ctx.storage.sql.exec("INSERT OR REPLACE INTO admission_retries(operation_id,attempts,next_at) VALUES(?,?,?)",nativeOperationId,attempts,Date.now()+delayMs);
          this.updateStatus(run.id,error.retryable?"queued":"failed",error.message,error.code);
        });
        if(error.retryable && attempts<maxAdmissionAttempts) await this.runtime.scheduleAdmissionRetry(nativeOperationId,delayMs);
        return;
      }
      this.ctx.storage.sql.exec("INSERT INTO admission_retries(operation_id,attempts,next_at) VALUES(?,?,?) ON CONFLICT(operation_id) DO UPDATE SET attempts=excluded.attempts,next_at=excluded.next_at",nativeOperationId,attempts,Date.now()+delayMs);
      this.updateStatus(run.id,"queued",attempts<maxAdmissionAttempts?admissionPending:admissionExhausted);
      if(attempts<maxAdmissionAttempts) await this.runtime.scheduleAdmissionRetry(nativeOperationId,delayMs);
    }
  }
  private canAdmit(nativeOperationId:string,runId:string):boolean {
    if(this.deleted) return false;
    const current=this.getRunRow(runId),run=JSON.parse(current.data) as Run;
    if(run.parentRunId && this.stopped(run.parentRunId)) {
      this.fenceRun(run.id,this.runCancellation(run.parentRunId));return false;
    }
    return current.native_operation_id===nativeOperationId && !this.stopped(runId) && !terminal.has(run.status) && !["waiting_approval","waiting_connection"].includes(run.status);
  }
  private observe(nativeOperationId:string):void {
    if(this.deleted) return;
    if(this.observing.has(nativeOperationId)) return;
    this.observing.add(nativeOperationId);
    this.ctx.waitUntil((async()=>{
      try {
        const result=await this.runtime.wait(nativeOperationId);
        await this.completeOperation(nativeOperationId,result.status,result.text,result.reason,result.kind,result);
      } catch {if(!this.deleted) {const row=this.findRun(nativeOperationId);if(row?.native_operation_id===nativeOperationId) {const run=JSON.parse(row.data) as Run;if(!terminal.has(run.status) && !["waiting_approval","waiting_connection"].includes(run.status)) this.updateStatus(run.id,"interrupted","The agent run was interrupted.");}}}
      finally {this.observing.delete(nativeOperationId);}
    })());
  }
  private recover():Promise<void> {
    if(this.deleted) return Promise.resolve();
    if(this.recovering) return this.recovering;
    this.recovering=(async()=>{
      await Promise.all([this.flushProcessCancellations(),this.flushRunCancellations()]);
      for(const process of this.ctx.storage.sql.exec<ProcessRow>("SELECT * FROM run_processes WHERE (status='running' OR json_extract(result,'$.checkpointStatus')='pending') AND cancel_requested=0").toArray()) {
        if(!process.result) {
          // A live initial request may still be provisioning. Only a failed RPC
          // or a restart makes its missing receipt an observation to reconcile.
          if(this.dispatchingProcesses.has(process.process_id) || !["dispatching","uncertain"].includes(process.dispatch_state)) continue;
          this.ctx.storage.sql.exec("UPDATE run_processes SET dispatch_state='uncertain' WHERE process_id=?",process.process_id);
        }
        const observation=this.ctx.storage.sql.exec<ProcessObservation>("SELECT * FROM process_observations WHERE process_id=?",process.process_id).toArray()[0];
        if(!observation) this.scheduleProcessPoll(process.process_id);
        else if(observation.next_at<=Date.now()) await this.pollProcess(process.process_id);
        else await this.runtime.scheduleAdmissionRetry(`process-poll:${process.process_id}`,observation.next_at-Date.now());
      }
      await this.reconcileConnections();
      for(const delivery of this.ctx.storage.sql.exec<MentionDelivery>("SELECT * FROM mention_deliveries WHERE attempts<?",maxAdmissionAttempts).toArray()) await this.dispatchMention(delivery.operation_id);
      // Status-indexed accepted work only, not the full retained history.
      // admit() observes s.admitted=1 inputs without submitting them again.
      const rows=this.ctx.storage.sql.exec<RunRow>("SELECT * FROM runs WHERE json_extract(data,'$.status') IN ('queued','running') ORDER BY rowid").toArray();
      // One slow delivery must not starve unrelated recovered outbox inputs or
      // approval finalizers. Exact-ID deduplication and the capacity lane still
      // protect concurrent HTTP, recovery and Lifecycle admission.
      for(const row of rows) this.ctx.waitUntil(this.admit(row.native_operation_id));
      // The computer provider deduplicates these operation IDs, including interrupted operations.
      const approvals=this.ctx.storage.sql.exec<JsonRow>("SELECT data FROM approvals").toArray().map(row=>JSON.parse(row.data) as Approval);
      for(const approval of approvals) if(approval.status==="executing") await this.finishApproval(approval);
    })().finally(()=>{this.recovering=undefined;});
    return this.recovering;
  }

  private existingToolDecision(operationId:string,hash:string):RuntimeToolResult|undefined {
    const existing=this.ctx.storage.sql.exec<{fingerprint:string;data:string}>("SELECT fingerprint,data FROM approvals WHERE operation_id=?",operationId).toArray()[0];
    if(existing) {
      if(existing.fingerprint!==hash) throw new ApiError(409,"idempotency_conflict","Tool operation arguments changed.");
      const approval=JSON.parse(existing.data) as Approval;
      if(approval.result) return approval.result;
      if(approval.status==="denied") return {operationId:operationId,status:"failed",error:"User denied this action."};
      return {status:"pending_approval",approvalId:approval.id,message:"Waiting for the user to approve the stored action. Stop and wait."};
    }
    return undefined;
  }
  private process(id:string):ProcessRow|undefined {
    return this.ctx.storage.sql.exec<ProcessRow>("SELECT * FROM run_processes WHERE process_id=?",id).toArray()[0];
  }
  private registerProcess(op:string,action:Extract<ComputerAction,{type:"exec"}>,run?:Run,toolCallId?:string):ProcessRow {
    const existing=this.process(op);
    if(existing) {
      if(existing.action!==JSON.stringify(action) || existing.run_id!==(run?.id??null)) throw new ApiError(409,"idempotency_conflict","Process operation arguments or owner changed.");
      return existing;
    }
    this.ctx.storage.sql.exec("INSERT INTO run_processes(process_id,run_id,subagent_id,tool_call_id,action,input,status) VALUES(?,?,?,?,?,?,'running')",op,run?.id??null,run?.subagentId??null,toolCallId??null,JSON.stringify(action),JSON.stringify(computerActivityInput(action)));
    return this.process(op)!;
  }
  private authorizeProcess(action:Extract<ComputerAction,{type:"execPoll"|"execCancel"}>,run?:Run):ProcessRow {
    const process=this.process(action.processId);
    if(!process) throw new ApiError(404,"process_not_found","Process not found for this bot.");
    if(action.type==="execCancel" && run?.subagentId) {
      // Root bot and authenticated owner control this bot's computer. A temporary
      // child may stop its own inputs and descendants, never a sibling's work.
      let owner=process.run_id?this.getRun(process.run_id):undefined;
      const visited=new Set<string>();
      while(owner && owner.subagentId!==run.subagentId && owner.parentRunId && !visited.has(owner.id)) {visited.add(owner.id);owner=this.getRun(owner.parentRunId);}
      if(owner?.subagentId!==run.subagentId) throw new ApiError(403,"process_forbidden","A subagent may cancel only its own processes or those of its descendants.");
    }
    return process;
  }
  private publishProcess(process:ProcessRow,result:ComputerResult,observationOperationId=result.operationId):void {
    this.emit("process.updated",{processId:process.process_id,operationId:process.process_id,...(observationOperationId!==process.process_id?{observationOperationId}:{}),...(process.subagent_id?{subagentId:process.subagent_id}:{}),...(process.tool_call_id?{toolCallId:process.tool_call_id}:{}),input:JSON.parse(process.input),result,...(process.cancel_requested?{cancellationRequested:true}:{})},process.run_id??undefined);
  }
  private recordProcessResult(id:string,result:ComputerResult):ComputerResult {
    const process=this.process(id);
    if(!process || this.deleted) return result;
    // A late initial receipt or poll cannot undo a completed cancellation.
    if(process.status!=="running" && result.status==="running" || process.status==="cancelled" && result.status!=="cancelled") return {...JSON.parse(process.result!),operationId:result.operationId};
    const receipt={...result,processId:id};
    const cancellationPending=process.cancel_requested && result.status==="running";
    const previous=process.result?JSON.parse(process.result) as ComputerResult:undefined;
    if(previous?.checkpointStatus==="saved" && process.status!=="running" && (receipt.checkpointStatus!=="saved" || !receipt.checkpointId)) {
      // Concurrent polls and the original command/cancel RPC can return an older
      // terminal snapshot after persistence was confirmed. Keep that confirmation
      // monotonic without changing the newly observed command's terminal status.
      receipt.checkpointStatus="saved";
      receipt.checkpointId=previous.checkpointId;
      if(receipt.status===previous.status) {
        if(previous.error===undefined) delete receipt.error;
        else receipt.error=previous.error;
      }
    }
    // A fresh observation ID is a receipt identity, not a change in the process.
    // Do not repeatedly persist its entire output when nothing has changed.
    const comparable=(value:ComputerResult)=>JSON.stringify(value,Object.keys(value).filter(key=>key!=="operationId").sort());
    if(previous && comparable(previous)===comparable(receipt) && !!process.cancel_requested===!!cancellationPending) {
      this.scheduleProcessPoll(id);
      return receipt;
    }
    this.ctx.storage.sql.exec("UPDATE run_processes SET status=?,result=?,dispatch_state='received',cancel_requested=? WHERE process_id=?",result.status,JSON.stringify(receipt),cancellationPending?1:0,id);
    this.publishProcess(this.process(id)!,receipt);
    if((receipt.status==="running" || receipt.checkpointStatus==="pending") && !cancellationPending) this.scheduleProcessPoll(id);
    else this.ctx.storage.sql.exec("DELETE FROM process_observations WHERE process_id=?",id);
    return receipt;
  }
  private needsProcessObservation(process:ProcessRow):boolean {
    return process.status==="running" && (!!process.result || process.dispatch_state==="uncertain" && !this.dispatchingProcesses.has(process.process_id)) || !!process.result && (JSON.parse(process.result) as ComputerResult).checkpointStatus==="pending";
  }
  private scheduleProcessPoll(id:string,delayMs=10_000):void {
    if(this.deleted) return;
    const process=this.process(id);
    if(!process || !this.needsProcessObservation(process) || process.cancel_requested) return;
    this.ctx.storage.sql.exec("INSERT INTO process_observations(process_id,next_at) VALUES(?,?) ON CONFLICT(process_id) DO UPDATE SET next_at=excluded.next_at",id,Date.now()+delayMs);
    this.ctx.waitUntil(this.runtime.scheduleAdmissionRetry(`process-poll:${id}`,delayMs));
  }
  private pollProcess(id:string):Promise<void> {
    const previous=this.pollingProcesses.get(id);if(previous) return previous;
    const pending=(async()=>{
      if(this.deleted) return;
      let process=this.process(id);
      if(!process || !this.needsProcessObservation(process)) return;
      if(process.cancel_requested) {await this.cancelProcess(id);return;}
      let observation=this.ctx.storage.sql.exec<ProcessObservation>("SELECT * FROM process_observations WHERE process_id=?",id).toArray()[0];
      if(!observation) {this.scheduleProcessPoll(id);return;}
      try {
        if(!observation.operation_id) {
          const sequence=observation.sequence+1;
          const op=`process-poll:${await fingerprint({processId:id,sequence})}`;
          process=this.process(id);
          if(this.deleted || !process || !this.needsProcessObservation(process) || process.cancel_requested) return;
          this.ctx.storage.sql.exec("UPDATE process_observations SET operation_id=?,sequence=? WHERE process_id=?",op,sequence,id);
          observation={...observation,sequence,operation_id:op};
        }
        // A passive observation never admits a model input or invokes a runtime
        // tool. Its stable receipt survives transport loss without restarting exec.
        const result=await this.computer.exec(this.bot().id,observation.operation_id!,{type:"execPoll",processId:id,yieldMs:0});
        if(this.deleted) return;
        this.ctx.storage.sql.exec("UPDATE process_observations SET operation_id=NULL WHERE process_id=?",id);
        if(result.processKnown===false) {
          // Missing admission is not proof that a delayed request cannot start.
          // Fence its original ID and acknowledge cancellation before finishing.
          this.ctx.storage.sql.exec("UPDATE run_processes SET cancel_requested=1,next_at=0 WHERE process_id=?",id);
          await this.cancelProcess(id);
          return;
        }
        this.recordProcessResult(id,result);
      } catch {if(!this.deleted) this.scheduleProcessPoll(id);}
    })().finally(()=>this.pollingProcesses.delete(id));
    this.pollingProcesses.set(id,pending);return pending;
  }
  private async dispatchComputer(op:string,action:ComputerAction,run?:Run,toolCallId?:string):Promise<ComputerResult> {
    const known=this.ctx.storage.sql.exec<{action:string;run_id:string|null}>("SELECT action,run_id FROM computer_operations WHERE operation_id=?",op).toArray()[0];
    if(known && (known.action!==JSON.stringify(action) || known.run_id!==(run?.id??null))) throw new ApiError(409,"idempotency_conflict","Computer operation arguments or owner changed.");
    // Reserve the invocation before persisting a cancellation intent. A reused
    // control ID must not fence another process when the provider rejects it.
    if(!known) this.ctx.storage.sql.exec("INSERT INTO computer_operations(operation_id,action,run_id) VALUES(?,?,?)",op,JSON.stringify(action),run?.id??null);
    let process:ProcessRow|undefined;
    if(action.type==="exec") {
      process=this.registerProcess(op,action,run,toolCallId);
      if(process.cancel_requested || process.status==="cancelled") {
        await this.cancelProcess(op);
        const current=this.process(op)!;
        return current.status==="cancelled"?{...JSON.parse(current.result!),operationId:op}:{operationId:op,processId:op,status:"interrupted",error:"Process cancellation requested. Do not restart it."};
      }
    } else if(action.type==="execPoll" || action.type==="execCancel") {
      process=this.authorizeProcess(action,run);
    }
    const initial=action.type==="exec" && process && !process.result;
    if(initial) {
      this.ctx.storage.sql.exec("UPDATE run_processes SET dispatch_state='dispatching' WHERE process_id=?",process!.process_id);
      this.dispatchingProcesses.set(process!.process_id,(this.dispatchingProcesses.get(process!.process_id)??0)+1);
    }
    try {
      const result=await this.computer.exec(this.bot().id,op,action);
      if(!process || this.deleted) return result;
      const receipt=this.recordProcessResult(process.process_id,result);
      if(this.process(process.process_id)?.cancel_requested) this.ctx.waitUntil(this.cancelProcess(process.process_id));
      return receipt;
    } catch(error) {
      if(initial && !this.deleted) this.ctx.storage.sql.exec("UPDATE run_processes SET dispatch_state='uncertain' WHERE process_id=? AND result IS NULL",process!.process_id);
      if(action.type==="execCancel" && process && !this.deleted && !(error instanceof ComputerProviderError && error.code==="computer_idempotency_conflict")) this.ctx.storage.sql.exec("UPDATE run_processes SET cancel_requested=1,next_at=0 WHERE process_id=?",process.process_id);
      if(process && !this.deleted && this.process(process.process_id)?.cancel_requested) this.ctx.waitUntil(this.cancelProcess(process.process_id));
      throw error;
    } finally {
      if(initial) {
        const remaining=(this.dispatchingProcesses.get(process!.process_id)??1)-1;
        if(remaining) this.dispatchingProcesses.set(process!.process_id,remaining);
        else {
          this.dispatchingProcesses.delete(process!.process_id);
          if(!this.deleted && this.process(process!.process_id)?.dispatch_state==="uncertain") this.scheduleProcessPoll(process!.process_id);
        }
      }
    }
  }
  private flushProcessCancellations():Promise<void> {
    const processes=this.ctx.storage.sql.exec<{process_id:string}>("SELECT process_id FROM run_processes WHERE cancel_requested=1 AND next_at<=?",Date.now()).toArray();
    return Promise.all(processes.map(process=>this.cancelProcess(process.process_id))).then(()=>{});
  }
  private cancelProcess(id:string):Promise<void> {
    const existing=this.cancellingProcesses.get(id);
    if(existing) return existing;
    const pending=(async()=>{
      const process=this.process(id);
      if(this.deleted || !process?.cancel_requested) return;
      this.publishProcess(process,process.result?JSON.parse(process.result):{operationId:id,processId:id,status:"running"});
      try {
        const result=await this.computer.cancel(this.bot().id,id);
        if(this.deleted) return;
        this.recordProcessResult(id,result);
        if(this.process(id)?.cancel_requested) throw new Error("Cancellation not acknowledged");
      } catch {
        if(this.deleted) return;
        const attempts=process.cancel_attempts+1,delay=Math.min(60_000,1000*2**Math.min(attempts-1,6));
        this.ctx.storage.sql.exec("UPDATE run_processes SET cancel_attempts=?,next_at=? WHERE process_id=? AND cancel_requested=1",attempts,Date.now()+delay,id);
        await this.runtime.scheduleAdmissionRetry(`process-cancel:${id}`,delay);
      }
    })().finally(()=>this.cancellingProcesses.delete(id));
    this.cancellingProcesses.set(id,pending);
    return pending;
  }
  private async executeTool(input:{operationId:string;runOperationId:string;subagentId?:string;subagentOperationId?:string;toolCallId?:string;action:ComputerAction;signal?:AbortSignal}):Promise<RuntimeToolResult> {
    this.active();
    input=await this.childToolInput(input);
    const row=this.findRun(input.runOperationId);
    if(!row) throw new ApiError(409,"run_not_found","Tool has no active run.");
    const run=JSON.parse(row.data) as Run;
    if(row.native_operation_id!==input.runOperationId || terminal.has(run.status) || input.signal?.aborted) return {operationId:input.operationId,status:"interrupted",error:"Run is no longer active."};
    const action=parseAction(input.action);
    const hash=await fingerprint(action);
    this.active();
    const existing=this.existingToolDecision(input.operationId,hash);
    if(existing) return existing;
    const bot=await this.currentBot();
    this.active();
    if(this.getRunRow(run.id).native_operation_id!==input.runOperationId || terminal.has(this.getRun(run.id).status) || input.signal?.aborted) return {operationId:input.operationId,status:"interrupted",error:"Run is no longer active."};
    // Another invocation may have persisted this exact decision while the
    // registry read was pending. Recheck before dispatching under fresh policy.
    const concurrentDecision=this.existingToolDecision(input.operationId,hash);
    if(concurrentDecision) return concurrentDecision;
    if(automatic.has(action.type) || bot.computerApprovalMode==="automatic") {
      const activity={...(input.subagentId?{subagentId:input.subagentId}:{}),...(input.toolCallId?{toolCallId:input.toolCallId}:{}),actionType:action.type,input:computerActivityInput(action)};
      this.startTool(input.operationId,activity,run.id);
      const result=await this.dispatchComputer(input.operationId,action,run,input.toolCallId);
      this.emit("tool.completed",{operationId:input.operationId,...activity,result},run.id,`tool:${input.operationId}`);
      return result;
    }
    const now=Date.now();
    const approval:Approval={id:crypto.randomUUID(),botId:run.botId,runId:run.id,operationId:input.operationId,...(input.toolCallId?{toolCallId:input.toolCallId}:{}),action,status:"pending",createdAt:new Date(now).toISOString(),expiresAt:new Date(now+(gui.has(action.type)?5*60*1000:24*60*60*1000)).toISOString()};
    this.ctx.storage.sql.exec("INSERT INTO approvals (id,operation_id,fingerprint,data) VALUES (?,?,?,?)",approval.id,input.operationId,hash,JSON.stringify(approval));
    this.updateStatus(run.id,"waiting_approval");
    this.emit("approval.created",{approval},run.id,`approval:${approval.id}`);
    return {status:"pending_approval",approvalId:approval.id,message:"The exact action needs user approval. Stop and wait for the decision."};
  }
  private apps():WorkspaceApps {
    return new WorkspaceApps(this.ctx.storage,this.env.COMPUTER,this.bot().id,{previewOrigin:this.env.PREVIEW_ORIGIN??'',consoleOrigin:this.env.GITHUB_PUBLIC_ORIGIN??''});
  }
  private reconcileConnections(force=false):Promise<void> {
    if(this.deleted) return Promise.resolve();
    if(this.reconcilingConnections) return this.reconcilingConnections;
    if(!force && Date.now()-this.lastConnectionCheck<5_000) return Promise.resolve();
    this.lastConnectionCheck=Date.now();
    this.reconcilingConnections=(async()=>{
      const pending=this.ctx.storage.sql.exec<JsonRow>("SELECT data FROM connections WHERE json_extract(data,'$.status')='pending' LIMIT 16").toArray();
      for(const row of pending) {
        const connection=JSON.parse(row.data) as ConnectionRequest;
        if(terminal.has(this.getRun(connection.runId).status)) {connection.status='cancelled';this.saveConnection(connection);continue;}
        try {await this.completeConnection(connection.id);} catch { /* Missing access stays pending. Never replay a tool effect. */ }
      }
    })().finally(()=>{this.reconcilingConnections=undefined;});
    return this.reconcilingConnections;
  }
  private listConnections():ConnectionRequest[] {
    return this.ctx.storage.sql.exec<JsonRow>("SELECT data FROM connections ORDER BY (json_extract(data,'$.status')='pending') DESC, rowid DESC LIMIT 100").toArray().map(row=>JSON.parse(row.data));
  }
  private getConnection(id:string):ConnectionRequest|undefined {
    const row=this.ctx.storage.sql.exec<JsonRow>("SELECT data FROM connections WHERE id=?",id).toArray()[0];
    return row?JSON.parse(row.data):undefined;
  }
  private saveConnection(connection:ConnectionRequest):void {
    this.ctx.storage.sql.exec("UPDATE connections SET data=? WHERE id=?",JSON.stringify(connection),connection.id);
  }
  private hasPendingConnection(runId:string):boolean {
    return this.ctx.storage.sql.exec("SELECT id FROM connections WHERE json_extract(data,'$.runId')=? AND json_extract(data,'$.status')='pending' LIMIT 1",runId).toArray().length>0;
  }
  private async github(path:string,method='POST',input?:unknown):Promise<Record<string,unknown>> {
    if(!this.env.GITHUB) throw new ApiError(503,'github_not_configured','GitHub connections are not configured.');
    const response=await this.env.GITHUB.get(this.env.GITHUB.idFromName('owner')).fetch(new Request(`https://github${path}`,{method,headers:{'content-type':'application/json'},...(input===undefined?{}:{body:JSON.stringify(input)})}));
    const data=await response.json<Record<string,unknown>>();
    if(!response.ok) {
      const error=data.error as {code?:string;message?:string}|undefined;
      throw new ApiError(response.status,error?.code??'github_unavailable',error?.message??'GitHub could not complete this operation.');
    }
    return data;
  }
  private async requireConnection(input:RuntimeHostToolRequest,run:Run,repository:string|undefined,permission:'read'|'write'):Promise<RuntimeToolResult|undefined> {
    const access={botId:run.botId,repository,permission};
    const authorized=await this.github('/authorize','POST',access);
    this.active();
    if(this.getRunRow(run.id).native_operation_id!==input.runOperationId || terminal.has(this.getRun(run.id).status) || input.signal.aborted) return {operationId:input.operationId,status:'interrupted',error:'Run is no longer active.'};
    if(authorized.authorized===true) return;
    const hash=await fingerprint({name:input.name,arguments:input.arguments});
    this.active();
    if(terminal.has(this.getRun(run.id).status) || this.getRunRow(run.id).native_operation_id!==input.runOperationId || input.signal.aborted) return {operationId:input.operationId,status:'interrupted',error:'Run is no longer active.'};
    const previous=this.ctx.storage.sql.exec<{fingerprint:string;data:string}>("SELECT fingerprint,data FROM connections WHERE operation_id=?",input.operationId).toArray()[0];
    if(previous && previous.fingerprint!==hash) throw new ApiError(409,'idempotency_conflict','Tool arguments changed.');
    const connection:ConnectionRequest=previous?JSON.parse(previous.data):{id:crypto.randomUUID(),botId:run.botId,runId:run.id,nativeOperationId:input.runOperationId,provider:'github',repository,permission,status:'pending',createdAt:timestamp()};
    if(connection.status!=='pending') return {operationId:input.operationId,status:'failed',error:'This connection request is no longer pending. Request access again.'};
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO connections(id,operation_id,fingerprint,data) VALUES(?,?,?,?)",connection.id,input.operationId,hash,JSON.stringify(connection));
    this.updateStatus(run.id,'waiting_connection');
    this.emit('connection.requested',{connection},run.id,`connection:${connection.id}`);
    return {status:'pending_connection',requestId:connection.id,provider:'github',repository,permission,message:'Connect GitHub using the inline card. The host will resume this task after authorization. Do not request a token in chat.'};
  }
  private async startConnection(id:string):Promise<Record<string,unknown>> {
    const connection=this.getConnection(id);
    if(!connection) throw new ApiError(404,'not_found','Connection request not found.');
    if(connection.status!=='pending' || terminal.has(this.getRun(connection.runId).status)) throw new ApiError(409,'connection_inactive','This connection request is no longer active.');
    return this.github('/connect','POST',{...connection,requestId:id,origin:this.env.GITHUB_PUBLIC_ORIGIN});
  }
  private async completeConnection(id:string):Promise<ConnectionRequest> {
    let connection=this.getConnection(id);
    if(!connection) throw new ApiError(404,'not_found','Connection request not found.');
    if(connection.status!=='pending') {
      if(connection.status==='connected') await this.admit(`connection:${id}`);
      return connection;
    }
    const access=await this.github('/authorize','POST',connection);
    if(access.authorized!==true) throw new ApiError(403,'connection_not_authorized','GitHub access has not been granted.');
    this.active();
    let continuation:string|undefined;
    this.ctx.storage.transactionSync(()=>{
      connection=this.getConnection(id)!;
      if(connection.status!=='pending') return;
      const run=this.getRun(connection.runId);
      if(terminal.has(run.status) || (connection.nativeOperationId ? this.getRunRow(run.id).native_operation_id!==connection.nativeOperationId : run.status!=='waiting_connection')) {connection.status='cancelled';this.saveConnection(connection);return;}
      connection.status='connected';this.saveConnection(connection);
      this.emit('connection.updated',{connection},run.id);
      const nativeOperationId=`connection:${id}`;
      const exists=this.ctx.storage.sql.exec("SELECT operation_id FROM submissions WHERE operation_id=?",nativeOperationId).toArray().length;
      if(exists) return;
      const text=`${connection.repository?`GitHub is now connected to your Timber account. This task requested ${connection.repository} (${connection.permission}).`:"GitHub is now connected to the Timber account and available to its bots. Use github_list_repositories to discover repositories authorized in the installation; use the access and permissions granted by GitHub."} Continue the original task. The tool that requested access was NOT executed. You may issue that operation now. Do not repeat previously completed effects. Use the host GitHub tools; credentials are managed by the host.`;
      this.ctx.storage.sql.exec("INSERT INTO submissions(operation_id,run_id,text,subagent_id) VALUES(?,?,?,?)",nativeOperationId,run.id,text,run.subagentId??null);
      this.ctx.storage.sql.exec("UPDATE runs SET native_operation_id=? WHERE id=?",nativeOperationId,run.id);
      this.updateStatus(run.id,'queued');continuation=nativeOperationId;
    });
    if(continuation) await this.admit(continuation);
    return connection;
  }
  private async executeHostTool(input:RuntimeHostToolRequest):Promise<RuntimeToolResult> {
    this.active();
    input=await this.childToolInput(input);
    validateHostArguments(input.name,input.arguments);
    const row=this.findRun(input.runOperationId);
    if(!row) throw new ApiError(409,'run_not_found','Tool has no active run.');
    const run=JSON.parse(row.data) as Run;
    if(row.native_operation_id!==input.runOperationId || terminal.has(run.status) || input.signal.aborted) return {operationId:input.operationId,status:'interrupted',error:'Run is no longer active.'};
    await this.currentBot();
    this.active();
    if(this.getRunRow(run.id).native_operation_id!==input.runOperationId || terminal.has(this.getRun(run.id).status) || input.signal.aborted) return {operationId:input.operationId,status:'interrupted',error:'Run is no longer active.'};
    const args=input.arguments;
    if(typeof args.repository==='string') {
      const repository=args.repository.toLowerCase();
      if(!/^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9._-]{1,100}$/.test(repository) || repository.endsWith('/.') || repository.endsWith('/..')) throw new ApiError(400,'invalid_repository','Use a GitHub repository in owner/name format.');
    }
    const activity={...(input.subagentId?{subagentId:input.subagentId}:{}),...(input.toolCallId?{toolCallId:input.toolCallId}:{}),toolName:input.name,input:hostActivityInput(input.name,args)};
    this.startTool(input.operationId,activity,run.id);
    const completed=(value:unknown):ComputerResult=>({operationId:input.operationId,status:'completed',output:typeof value==='string'?value:JSON.stringify(value)});
    let result:ComputerResult;
    if(input.name==='list_bots') {
      const registry=this.env.WORKSPACE.get(this.env.WORKSPACE.idFromName("owner"));
      const response=await registry.fetch("https://workspace/");
      if(!response.ok) throw new ApiError(503,"bots_unavailable","Bots could not be listed.");
      const {bots}=await response.json<{bots:Bot[]}>();
      result=completed({bots:bots.map(({id,name,createdByBotId})=>({id,name,...(createdByBotId?{createdByBotId}:{})}))});
    } else if(input.name==='create_bot') {
      const value=await agentCoordinatorRequest<{bot:Bot}>(this.env,"/agents/create",{sourceBotId:run.botId,sourceRunId:run.id,operationId:input.operationId,name:args.name,instructions:args.instructions});
      this.emit("agent.named.created",{bot:{id:value.bot.id,name:value.bot.name},operationId:input.operationId,...(input.toolCallId?{toolCallId:input.toolCallId}:{})},run.id,`named:${input.operationId}`);result=completed(value);
    } else if(input.name==='send_to_bot') {
      const value=await agentCoordinatorRequest<{delegation:AgentDelegation}>(this.env,"/agents/send",{sourceBotId:run.botId,sourceRunId:run.id,operationId:input.operationId,targetBotId:args.botId,text:args.text});
      this.emit("delegation.updated",{...value,operationId:input.operationId,...(input.toolCallId?{toolCallId:input.toolCallId}:{})},run.id,`delegation:${input.operationId}`);result=completed(value);
    } else if(input.name==='create_task') {
      if(this.bot().allowTaskCreation!==true) throw new ApiError(403,'task_creation_not_allowed','The owner has not allowed this bot to create tasks.');
      const registry=this.env.WORKSPACE.get(this.env.WORKSPACE.idFromName('owner'));
      const response=await registry.fetch('https://workspace/tasks/bot',{method:'POST',headers:{'content-type':'application/json','x-timber-internal':'task'},body:JSON.stringify({operationId:input.operationId,title:args.title,description:args.description,sourceBotId:run.botId,sourceRunId:run.id})});
      const value=await response.json<{task?:unknown;error?:{code:string;message:string}}>();if(!response.ok)throw new ApiError(response.status,value.error?.code??'task_creation_failed',value.error?.message??'Task could not be created.');
      result=completed(value);
    } else if(input.name==='load_skill') result=completed(args.name==='github-development'?githubDevelopmentSkill:workspaceAppsSkill);
    else if(input.name==='publish_app') {
      const app=await this.apps().publish({name:args.name as string,port:args.port as number,operationId:input.operationId});
      this.emit('workspace.app.updated',{app},run.id);result=completed(app);
    } else if(input.name==='list_apps') result=completed({apps:await this.apps().refresh()});
    else if(input.name==='remove_app') {await this.apps().remove(args.appId as string);this.emit('workspace.app.removed',{appId:args.appId},run.id);result=completed({removed:true});}
    else if(input.name==='github_list_repositories' || (input.name==='github_connect' && args.repository===undefined)) {
      const pending=await this.requireConnection(input,run,undefined,'read');
      if(pending) return pending;
      result=input.name==='github_connect'
        ?completed({connected:true,scope:'account',nextTool:'github_list_repositories',message:'GitHub is connected to your Timber account. Bots use the repository selection and permissions authorized in GitHub.'})
        :completed(await this.github('/repositories','POST',{botId:run.botId,...(args.page===undefined?{}:{page:args.page})}));
    } else {
      const repository=String(args.repository).toLowerCase();
      const permission=input.name==='github_connect'?(args.permission??'read') as 'read'|'write':['github_clone','github_list_pull_requests'].includes(input.name)?'read':'write';
      const pending=await this.requireConnection(input,run,repository,permission);
      if(pending) return pending;
      if(input.name==='github_connect') result=completed({connected:true,repository,permission});
      else if(input.name==='github_clone' || input.name==='github_push') {
        const action=parseAction({type:input.name==='github_clone'?'gitClone':'gitPush',repository,path:args.path,...(args.branch?{branch:args.branch}:{})});
        result=await this.computer.exec(run.botId,input.operationId,action);
      } else {
        const {repository:_,...providerArgs}=args;
        const response=await this.github('/mcp','POST',{botId:run.botId,repository,name:input.name==='github_create_pull_request'?'create_pull_request':'list_pull_requests',args:providerArgs,operationId:input.operationId});
        result=response.status==='completed'?completed(response.data):{operationId:input.operationId,status:response.status==='interrupted'?'interrupted':'failed',error:(response.error as {message?:string}|undefined)?.message??'GitHub could not confirm the operation. Inspect its state before retrying.'};
      }
    }
    this.emit('tool.completed',{operationId:input.operationId,...activity,result},run.id,`tool:${input.operationId}`);
    return result;
  }

  private async readImage(artifactId:string):Promise<{data:string;mimeType:string}> {
    if(!UUID.test(artifactId)) throw new ApiError(404,"not_found","Image not found.");
    const stored=await this.env.FILES.get(`bots/${this.bot().id}/artifacts/${artifactId}`);
    if(!stored || stored.size>5_000_000 || !["image/png","image/jpeg"].includes(stored.httpMetadata?.contentType??"")) throw new ApiError(404,"not_found","Image not found.");
    const bytes=new Uint8Array(await stored.arrayBuffer());
    let binary="";
    for(let start=0;start<bytes.length;start+=8192) binary+=String.fromCharCode(...bytes.subarray(start,start+8192));
    return {data:btoa(binary),mimeType:stored.httpMetadata!.contentType!};
  }
  private saveApproval(approval:Approval):void {if(!this.deleted) this.ctx.storage.sql.exec("UPDATE approvals SET data=? WHERE id=?",JSON.stringify(approval),approval.id);}
  private async decideApproval(id:string,decision:unknown):Promise<Approval> {
    if(this.takingControl) throw new ApiError(409,"computer_busy","Desktop control is being acquired. Retry after the connection is established.");
    this.active();
    if(this.suspending) throw new ApiError(409,"computer_busy","The computer is being suspended. Retry after it stops.");
    if(decision!=="approve" && decision!=="deny") throw new ApiError(400,"invalid_request","decision must be approve or deny.");
    const row=this.ctx.storage.sql.exec<JsonRow>("SELECT data FROM approvals WHERE id=?",id).toArray()[0];
    if(!row) throw new ApiError(404,"not_found","Approval not found.");
    const approval=JSON.parse(row.data) as Approval;
    if(approval.status!=="pending") return approval;
    const run=this.getRun(approval.runId);
    if(terminal.has(run.status)) throw new ApiError(409,"run_inactive","The run is no longer active.");
    if(Date.parse(approval.expiresAt)<=Date.now()) {
      this.invalidateApproval(approval,"This approval expired. Request a new action.");
      throw new ApiError(409,"approval_expired","This approval has expired.");
    }
    if(decision==="deny") {
      approval.status="denied";
      let continuation:string|undefined;
      this.ctx.storage.transactionSync(()=>{
        this.saveApproval(approval);
        this.emit("approval.updated",{approval},approval.runId);
        continuation=this.queueApprovalContinuation(approval);
      });
      if(continuation) await this.admit(continuation);
      return approval;
    }
    approval.status="executing";
    if(approval.action.type==="exec") this.registerProcess(approval.operationId,approval.action,run,approval.toolCallId);
    this.saveApproval(approval);
    this.emit("approval.updated",{approval},approval.runId);
    // Persist the decision before executing; closing the client cannot cancel an accepted action.
    this.ctx.waitUntil(this.finishApproval(approval));
    return approval;
  }
  private invalidateApproval(approval:Approval,reason:string):void {
    approval.status="interrupted";
    approval.result={operationId:approval.operationId,status:"interrupted",error:reason};
    this.saveApproval(approval);
    this.emit("approval.updated",{approval},approval.runId);
    if(!terminal.has(this.getRun(approval.runId).status)) this.updateStatus(approval.runId,"interrupted",reason);
  }
  private invalidatePendingGui():void {
    const approvals=this.ctx.storage.sql.exec<JsonRow>("SELECT data FROM approvals").toArray().map(row=>JSON.parse(row.data) as Approval);
    for(const approval of approvals) if(approval.status==="pending" && gui.has(approval.action.type)) {
      this.invalidateApproval(approval,"The computer changed after this action was requested. Request a new action based on its current screen.");
    }
  }
  private finishApproval(approval:Approval):Promise<void> {
    const existing=this.finishingApprovals.get(approval.id);
    if(existing) return existing;
    const work=this.finishApprovalOnce(approval.id).finally(()=>this.finishingApprovals.delete(approval.id));
    this.finishingApprovals.set(approval.id,work);
    return work;
  }
  private async finishApprovalOnce(id:string):Promise<void> {
    if(this.deleted) return;
    const row=this.ctx.storage.sql.exec<JsonRow>("SELECT data FROM approvals WHERE id=?",id).toArray()[0];
    if(!row) return;
    const approval=JSON.parse(row.data) as Approval;
    // Recovery can hold an older snapshot. A terminal decision is immutable.
    if(approval.status!=="executing") return;
    const agentId=this.getRun(approval.runId).subagentId;
    const activity={...(agentId?{subagentId:agentId}:{}),...(approval.toolCallId?{toolCallId:approval.toolCallId}:{}),actionType:approval.action.type,input:computerActivityInput(approval.action)};
    this.startTool(approval.operationId,activity,approval.runId);
    let result:ComputerResult;
    let providerDiagnostic:string|undefined;
    try {
      const run=this.getRun(approval.runId);
      if(terminal.has(run.status)) {this.invalidateApproval(approval,"The run stopped before this action could be dispatched.");return;}
      result=await this.dispatchComputer(approval.operationId,approval.action,run,approval.toolCallId);
    }
    catch(error) {
      if(this.deleted) return;
      console.error("approval.failure",{code:error instanceof ComputerProviderError?error.code:"computer_unavailable",actionType:approval.action.type});
      if(error instanceof ComputerProviderError) providerDiagnostic=`${error.code}: ${error.publicMessage} The action outcome is unconfirmed. Do not retry automatically.`;
      result={operationId:approval.operationId,status:"interrupted",error:providerDiagnostic??"Could not establish whether the action completed. Do not retry automatically."};
    }
    if(this.deleted) return;
    let continuation:string|undefined;
    this.ctx.storage.transactionSync(()=>{
      const currentRow=this.ctx.storage.sql.exec<JsonRow>("SELECT data FROM approvals WHERE id=?",id).toArray()[0];
      if(!currentRow || (JSON.parse(currentRow.data) as Approval).status!=="executing") return;
      const completed:Approval={...approval,result,status:["completed","running","cancelled"].includes(result.status)?"completed":result.status==="interrupted"?"interrupted":"failed"};
      this.saveApproval(completed);
      this.emit("approval.updated",{approval:completed},approval.runId,`approval-result:${approval.id}`);
      this.emit("tool.completed",{operationId:approval.operationId,...activity,result},approval.runId,`tool:${approval.operationId}`);
      if(result.status==="interrupted") {
        if(!terminal.has(this.getRun(approval.runId).status)) this.updateStatus(approval.runId,"interrupted",providerDiagnostic??"An approved action was interrupted. Check its effects before retrying.");
      } else continuation=this.queueApprovalContinuation(completed);
    });
    if(continuation) await this.admit(continuation);
  }
  /** Called in the same transaction as the decision/result, so a restart cannot
   * leave a finished approval without its durable continuation input. */
  private queueApprovalContinuation(approval:Approval):string|undefined {
    if(this.deleted) return;
    const row=this.getRunRow(approval.runId),run=JSON.parse(row.data) as Run;
    if(terminal.has(run.status)) return;
    const nativeOperationId=`approval:${approval.id}`;
    const existing=this.ctx.storage.sql.exec<Submission>("SELECT * FROM submissions WHERE operation_id=?",nativeOperationId).toArray()[0];
    // A late duplicate must not reset a running/waiting state or rewind the bot
    // from a newer continuation to this older one.
    if(existing) return row.native_operation_id===nativeOperationId?nativeOperationId:undefined;
    const text=approval.status==="denied"
      ? `The user denied action ${approval.id}. Do not execute it. Explain or continue using allowed alternatives.`
      : `The user approved action ${approval.id}. The platform already executed exactly the stored action. Do not repeat it. Result: ${JSON.stringify(approval.result)}.${approval.result?.status==="running"?" The process is still running. Use exec_poll with this processId to observe it, or exec_cancel to stop it; do not issue exec again.":""} Continue the original task.`;
    this.ctx.storage.sql.exec("INSERT INTO submissions (operation_id,run_id,text,subagent_id) VALUES (?,?,?,?)",nativeOperationId,run.id,text,run.subagentId??null);
    this.ctx.storage.sql.exec("UPDATE runs SET native_operation_id=? WHERE id=?",nativeOperationId,run.id);
    this.updateStatus(run.id,"queued");
    return nativeOperationId;
  }
  private async cancelRun(id:string):Promise<Run> {
    const row=this.getRunRow(id),run=JSON.parse(row.data) as Run;
    const cancellation=this.requestCancellation(id);
    const ids=new Set([id]);
    const rows=this.ctx.storage.sql.exec<RunRow>("SELECT * FROM runs").toArray();
    this.includeDescendants(ids,rows);
    for(const runId of ids) this.fenceRun(runId,cancellation);
    for(const child of rows.filter(row=>ids.has(row.id))) {
      const value=JSON.parse(child.data) as Run;
      this.queueRunCancellation(value.subagentId?{subagentId:value.subagentId}:{operationId:child.native_operation_id},cancellation);
    }
    // Cancellation bypasses the provider's action queue, including a command
    // whose initial dispatch has not returned. Fence descendants before awaits.
    await Promise.all([this.flushProcessCancellations(),this.flushRunCancellations()]);
    return this.getRun(id);
  }

  private computerView(request:Request,path:string):Promise<Response> {
    const botId=this.bot().id;
    return this.env.COMPUTER.get(this.env.COMPUTER.idFromName(botId)).fetch(new Request(`https://computer.internal${path}`,{method:request.method,headers:{"x-timber-bot-id":botId,"content-type":"application/json"},body:["GET","HEAD"].includes(request.method)?undefined:request.body}));
  }

  private async suspendComputer():Promise<ComputerStatus> {
    if(this.suspending) return this.suspending;
    const activeRun=this.ctx.storage.sql.exec<{id:string}>("SELECT id FROM runs WHERE json_extract(data,'$.status') IN ('queued','running') LIMIT 1").toArray()[0];
    const activeApproval=this.ctx.storage.sql.exec<{id:string}>("SELECT id FROM approvals WHERE json_extract(data,'$.status')='executing' LIMIT 1").toArray()[0];
    if(activeRun || activeApproval) throw new ApiError(409,"computer_busy","Stop the active run or wait for its action to finish before suspending.");
    this.invalidatePendingGui();
    this.suspending=suspendCloudComputer(this.env.COMPUTER,this.bot().id);
    try {
      const computer=await this.suspending;
      this.emit("computer.suspended",{computer});
      return computer;
    } finally {this.suspending=undefined;}
  }

  private events(request:Request,url:URL):Response {
    const raw=url.searchParams.get("after")??request.headers.get("last-event-id")??"0";
    if(!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new ApiError(400,"invalid_cursor","Invalid event cursor.");
    if(this.streams>=8) throw new ApiError(429,"too_many_streams","Too many open event streams.");
    this.streams++;
    let cursor=Number(raw),closed=false;
    let timer:ReturnType<typeof setInterval>|undefined,deadline:ReturnType<typeof setTimeout>|undefined;
    const encoder=new TextEncoder();
    let controller:ReadableStreamDefaultController<Uint8Array>;
    const cleanup=()=>{
      if(closed) return;
      closed=true;this.streams--;
      this.closeStreams.delete(finish);
      if(timer) clearInterval(timer);if(deadline) clearTimeout(deadline);
      request.signal.removeEventListener("abort",finish);
    };
    const finish=()=>{if(closed) return;cleanup();try{controller.close();}catch{}};
    const pump=()=>{
      if(closed) return;
      if(this.deleted) {finish();return;}
      if(controller.desiredSize!==null && controller.desiredSize<=0) return;
      const rows=this.ctx.storage.sql.exec<{id:number;data:string}>("SELECT id,data FROM events WHERE id>? ORDER BY id LIMIT 100",cursor).toArray();
      let chunk="";
      for(const row of rows) {chunk+=`id: ${row.id}\nevent: event\ndata: ${JSON.stringify({id:row.id,...JSON.parse(row.data)})}\n\n`;cursor=row.id;}
      if(chunk) controller.enqueue(encoder.encode(chunk));
    };
    const stream=new ReadableStream<Uint8Array>({
      start:c=>{
        controller=c;
        this.closeStreams.add(finish);
        controller.enqueue(encoder.encode("retry: 1000\n: connected\n\n"));
        timer=setInterval(pump,500);
        deadline=setTimeout(finish,25_000);
        request.signal.addEventListener("abort",finish,{once:true});
        if(request.signal.aborted) finish();
      },
      pull:()=>pump(),
      cancel:()=>cleanup(),
    });
    return new Response(stream,{headers:{"content-type":"text/event-stream; charset=utf-8","cache-control":"no-cache, no-store","x-content-type-options":"nosniff"}});
  }

  async fetch(request:Request):Promise<Response> {
    try {
      const url=new URL(request.url),path=url.pathname;
      if(path==="/task-delete" && request.method==="POST") {
        if(request.headers.get("x-timber-internal")!=="task-cleanup")throw new ApiError(403,"internal_only","Task cleanup is internal.");
        const taskId=request.headers.get("x-timber-task-id")??"",botId=request.headers.get("x-timber-bot-id")??"";
        await this.deleteTaskConversation(taskId,botId);return json({taskId,deleted:true});
      }
      if(path==="/delete" && request.method==="POST") {
        const id=request.headers.get("x-botspace-bot-id")??"";
        if(!UUID.test(id)) throw new ApiError(403,"internal_only","Missing internal bot identity.");
        await this.deleteBot(id);
        return json({botId:id,deleted:true});
      }
      this.active();
      if(path==="/connections/reconcile" && request.method==="POST" && request.headers.get("x-timber-internal")==="github") {
        await this.currentBot();await this.reconcileConnections(true);
        const pending=this.ctx.storage.sql.exec("SELECT id FROM connections WHERE json_extract(data,'$.status')='pending'").toArray().length;
        return json({pending});
      }
      const completedConnection=/^\/connections\/([^/]+)\/complete$/.exec(path);
      if(completedConnection && request.method==="POST" && request.headers.get("x-timber-internal")==="github") {
        await this.currentBot();
        return json({connection:await this.completeConnection(completedConnection[1])});
      }
      this.configure(request);
      const admissionStatus=/^\/admission\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/.exec(path);
      if(admissionStatus&&request.method==="GET") {
        if(request.headers.get("x-timber-internal")!=="scheduler")throw new ApiError(403,"internal_only","Admission reconciliation is internal.");
        return json({accepted:this.ctx.storage.sql.exec("SELECT 1 FROM runs WHERE operation_id=? LIMIT 1",admissionStatus[1]).toArray().length>0});
      }
      const admissionFence=/^\/admission-fence\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/.exec(path);
      if(admissionFence&&request.method==="POST") {
        if(request.headers.get("x-timber-internal")!=="scheduler")throw new ApiError(403,"internal_only","Admission reconciliation is internal.");
        this.ctx.storage.sql.exec("INSERT OR IGNORE INTO admission_fences(operation_id,created_at) VALUES(?,?)",admissionFence[1],Date.now());
        return json({fenced:true});
      }
      if(path==="/cancel-processes" && request.method==="POST") {
        if(request.headers.get("x-timber-internal")!=="task" || !request.headers.get("x-timber-task-id")) {await consumeUnusedBody(request);throw new ApiError(403,"internal_only","Task process cancellation is internal.");}
        await consumeUnusedBody(request);
        this.ctx.storage.sql.exec("INSERT OR IGNORE INTO task_cancel_fences(task_id,created_at) VALUES(?,?)",request.headers.get("x-timber-task-id"),Date.now());
        this.ctx.storage.sql.exec("UPDATE run_processes SET cancel_requested=1,next_at=0 WHERE status='running'");
        await this.flushProcessCancellations();
        const active=this.ctx.storage.sql.exec("SELECT 1 FROM run_processes WHERE status='running' LIMIT 1").toArray().length>0;
        return json({confirmed:!active});
      }
      if(path==="/summary" && request.method==="GET") return json({summary:this.summary()});
      if(path==="/computer/lease-state" && request.method==="GET") {
        if(request.headers.get("x-timber-internal")!=="scheduler")throw new ApiError(403,"internal_only","Computer lease inspection is internal.");
        return json({computerControlled:await this.computer.controlled?.(this.bot().id)??false});
      }
      if(["/context","/context/compact","/memory"].includes(path)||path.startsWith('/memory/')) return await maintenanceRequest(request,path,this.runtime);
      this.ctx.waitUntil(this.recover());
      if(["/agent-messages","/agent-results","/agent-cancel"].includes(path)) {
        if(request.headers.get("x-timber-internal")!=="agents" || request.method!=="POST") {await consumeUnusedBody(request);throw new ApiError(403,"internal_only","This agent route is internal.");}
        const input=await body(request);
        if(path==="/agent-cancel") {await this.cancelAgentInput(String(input.operationId));return json({cancelled:true});}
        if(path==="/agent-results") {await this.receiveAgentResult(input as unknown as Parameters<BotDO["receiveAgentResult"]>[0]);return json({received:true});}
        const parsed=parseMessage(input);
        const provenance=input.provenance as MessageProvenance,delegation=input.delegation as RunDelegation;
        if(!provenance || !delegation || !UUID.test(delegation.id) || !UUID.test(delegation.sourceBotId) || !UUID.test(delegation.sourceRunId) || !Array.isArray(delegation.path) || delegation.path.at(-1)!==this.bot().id || parsed.operationId!==`delegate:${delegation.id}`) throw new ApiError(400,"invalid_request","Invalid delegated input.");
        return json({run:await this.createRun(parsed,{provenance,delegation})},202);
      }
      if(path==="/agents" && request.method==="GET") return json({agents:await this.runtime.subagents()});
      if(path==="/delegations" && request.method==="GET") return json(await agentCoordinatorRequest(this.env,`/agents/tasks?botId=${this.bot().id}`,undefined,"GET"));
      const agentRoute=/^\/agents\/([^/]+)\/(messages|cancel)$/.exec(path);
      if(agentRoute) {
        if(agentRoute[2]==="cancel" && request.method==="POST") await consumeUnusedBody(request);
        const id=decodeURIComponent(agentRoute[1]);await this.subagent(id);
        if(agentRoute[2]==="messages" && request.method==="GET") return json({messages:await this.runtime.subagentMessages(id)});
        if(agentRoute[2]==="messages" && request.method==="POST") {
          const input=parseMessage(await body(request));
          if(input.mentions?.length || /^(approval|delegate|connection|subagent|agent-result|subagent-report|mention|process-cancel|process-poll|run-cancel):/.test(input.operationId)) throw new ApiError(400,"invalid_request","Use an independent operation ID for the subagent message.");
          const agent=await this.subagent(id),parent=this.findRun(agent.parentOperationId);
          if(terminal.has(agent.status) || this.subagentStopped(id) || !parent) throw new ApiError(409,"agent_inactive","This subagent is no longer active.");
          const run=await this.createRun(input,{subagentId:id,parentRunId:parent.id});
          return json({run,receipt:{operationId:input.operationId,accepted:true}},202);
        }
        if(agentRoute[2]==="cancel" && request.method==="POST") {
          const child=this.childRun(id);
          await this.cancelSubagent(id,child?this.requestCancellation(child.id):undefined);
          return json({agent:await this.subagent(id)});
        }
      }
      if(path==="/connections" && request.method==="GET") {await this.reconcileConnections();return json({connections:this.listConnections()});}
      const connect=/^\/connections\/([^/]+)\/connect$/.exec(path);
      if(connect && request.method==="POST") {await consumeUnusedBody(request);return json(await this.startConnection(connect[1]));}
      if(path==="/apps/refresh" && request.method==="POST") {await consumeUnusedBody(request);return json({apps:await this.apps().refresh()});}
      if(path==="/apps" && request.method==="GET") return json({apps:await this.apps().list()});
      if(path==="/apps" && request.method==="POST") {
        const input=await body(request);
        return json({app:await this.apps().publish(input)});
      }
      const appRoute=/^\/apps\/([^/]+)(\/open)?$/.exec(path);
      if(appRoute && request.method==="DELETE" && !appRoute[2]) {await this.apps().remove(appRoute[1]);return json({deleted:true});}
      if(appRoute && request.method==="POST" && appRoute[2]) return json(await this.apps().open(appRoute[1]));
      const preview=/^\/workspace-app-preview\/([^/]+)$/.exec(path);
      if(preview && request.headers.has("x-timber-preview-path")) return await this.apps().preview(request,preview[1],request.headers.get("x-timber-preview-path")!);
      const upload=/^\/attachments\/([^/]+)$/.exec(path);
      if(upload && UUID.test(upload[1]) && request.method==="PUT") return await uploadChatImage(request,this.env.FILES,this.bot().id,upload[1]);
      if(path==="/messages" && request.method==="GET") {
        return json(this.listMessages(url));
      }
      if(path==="/messages" && request.method==="POST") {const taskId=request.headers.get("x-timber-task-id")??undefined;return json({run:await this.createRun(parseMessage(await body(request)),taskId?{taskId}:undefined)},202);}
      if(path==="/runs" && request.method==="GET") return json(this.listRuns(url));
      const runRoute=/^\/runs\/([^/]+)(\/cancel)?$/.exec(path);
      if(runRoute && UUID.test(runRoute[1])) {
        if(request.method==="GET" && !runRoute[2]) return json({run:this.runView(this.getRunRow(runRoute[1]))});
        if(request.method==="POST" && runRoute[2]) {
          // Cancellation needs no payload, but consuming the accepted HTTP body
          // prevents Workerd from reading the request stream after the response.
          await consumeUnusedBody(request);
          return json({run:await this.cancelRun(runRoute[1])});
        }
      }
      if(path==="/events" && request.method==="GET") return this.events(request,url);
      if(/^\/workspace\/(tree|file|download|projects|changes|diff)$/.test(path) && request.method==="GET") return this.computerView(request,path+url.search);
      if(path==="/computer/live-session" && request.method==="POST") {
        const input=await body(request);
        if(input.mode!=="view" && input.mode!=="control") throw new ApiError(400,"invalid_mode","Choose view or control.");
        if(input.replaces!==undefined && (input.mode!=="control" || typeof input.replaces!=="string" || !UUID.test(input.replaces))) throw new ApiError(400,"invalid_request","A control transfer must reference its current Watch session.");
        if(this.suspending || this.takingControl) throw new ApiError(409,"computer_busy","The computer is changing state. Try again shortly.");
        if(input.mode==="control") {
          const run=this.ctx.storage.sql.exec("SELECT id FROM runs WHERE json_extract(data,'$.status') IN ('queued','running') LIMIT 1").toArray()[0];
          const approval=this.ctx.storage.sql.exec("SELECT id FROM approvals WHERE json_extract(data,'$.status')='executing' LIMIT 1").toArray()[0];
          if(run || approval) throw new ApiError(409,"computer_busy","Stop the active run or wait for its action to finish before taking control. You can watch while the agent works.");
          this.takingControl=true;
        }
        try {
          const response=await this.computerView(new Request(request.url,{method:"POST",body:JSON.stringify({mode:input.mode,...(input.replaces?{replaces:input.replaces}:{})})}),"/desktop");
          if(response.ok && input.mode==="control") this.invalidatePendingGui();
          return response;
        } finally {this.takingControl=false;}
      }
      const desktopSession=/^\/computer\/live-session\/([a-f0-9-]{36})(\/renew)?$/.exec(path);
      if(desktopSession && ((request.method==="POST" && desktopSession[2]) || (request.method==="DELETE" && !desktopSession[2]))) return this.computerView(request,`/desktop/${desktopSession[1]}${desktopSession[2]??""}`);
      if(path==="/computer" && request.method==="GET") return json({computer:await this.computer.status(this.bot().id)});
      if(path==="/computer/suspend" && request.method==="POST") return json({computer:await this.suspendComputer()});
      if(path==="/computer/actions" && request.method==="POST") {
        if(this.suspending) throw new ApiError(409,"computer_busy","The computer is being suspended. Retry after it stops.");
        const input=await body(request),action=parseAction(input.action),op=operationId(input.operationId);
        this.active();
        if(!["readFile","listFiles","screenshot","execPoll","execCancel"].includes(action.type)) this.invalidatePendingGui();
        const result=await this.dispatchComputer(op,action);
        this.emit("computer.action",{operationId:op,actionType:action.type,input:computerActivityInput(action),result},undefined,`direct:${op}`);
        return json({result});
      }
      if(path==="/approvals" && request.method==="GET") {
        const approvals=this.ctx.storage.sql.exec<JsonRow>("SELECT data FROM approvals ORDER BY rowid DESC LIMIT 100").toArray().map(row=>JSON.parse(row.data));
        return json({approvals});
      }
      const approvalRoute=/^\/approvals\/([^/]+)$/.exec(path);
      if(approvalRoute && UUID.test(approvalRoute[1]) && request.method==="POST") {
        const input=await body(request);
        return json({approval:await this.decideApproval(approvalRoute[1],input.decision)});
      }
      throw new ApiError(404,"not_found","Endpoint not found.");
    } catch(error) {return errorResponse(error);}
  }
}
