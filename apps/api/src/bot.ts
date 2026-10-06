import { DurableObject } from "cloudflare:workers";
import type { Approval, Bot, BotEvent, ComputerAction, ComputerResult, ComputerStatus, Message, Run, RunPage, RunStatus } from "@botspace/contracts";
import { createCloudComputerProvider, touchCloudComputer, suspendCloudComputer, ComputerProviderError } from "@botspace/computer";
import { createPiRuntime, type AgentRuntime, type RuntimeApprovalContext, type RuntimeApprovalSummary, type RuntimeToolResult } from "@botspace/runtime";
import type { Env } from "./env";
import { ApiError, errorResponse, json } from "./errors";
import { body, fingerprint, operationId, parseAction, parseMessage, UUID } from "./validation";

type JsonRow = {data:string};
type RunRow = JsonRow & {id:string;operation_id:string;fingerprint:string;native_operation_id:string};
type Submission = {operation_id:string;run_id:string;text:string;admitted:number};
type AdmissionRetry = {attempts:number;next_at:number};
type RuntimeProjection = {type:string;data:Record<string,unknown>;operationId?:string;eventKey?:string};
const terminal = new Set<RunStatus>(["completed","failed","cancelled","interrupted"]);
const automatic = new Set<ComputerAction["type"]>(["readFile","listFiles","screenshot","checkpoint"]);
const gui = new Set<ComputerAction["type"]>(["navigate","click","type","key","scroll"]);
const timestamp = ()=>new Date().toISOString();
const legacyAdmissionFailure="The agent runtime could not accept this run.";
const admissionPending="Message saved. Delivery to the agent is being retried.";
const admissionExhausted="Message saved, but delivery to the agent could not be confirmed. Retry this message to resume delivery.";
const maxAdmissionAttempts=5;

export class BotDO extends DurableObject<Env> {
  private runtime:AgentRuntime;
  private computer:ReturnType<typeof createCloudComputerProvider>;
  private admitting=new Map<string,Promise<void>>();
  private observing=new Set<string>();
  private recovering?:Promise<void>;
  private finishingApprovals=new Map<string,Promise<void>>();
  private streams=0;
  private lastComputerTouch=0;
  private suspending?:Promise<ComputerStatus>;

  constructor(ctx:DurableObjectState,env:Env) {
    super(ctx,env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS config (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL, native_operation_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS runs_status_idx ON runs (json_extract(data,'$.status'));
      CREATE TABLE IF NOT EXISTS submissions (operation_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, text TEXT NOT NULL, admitted INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS admission_retries (operation_id TEXT PRIMARY KEY, attempts INTEGER NOT NULL, next_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, source_key TEXT UNIQUE, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS approvals_status_expiry_idx ON approvals (json_extract(data,'$.status'),json_extract(data,'$.expiresAt'));
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, source_key TEXT UNIQUE, data TEXT NOT NULL);
    `);
    this.computer=createCloudComputerProvider(env.COMPUTER);
    this.runtime=createPiRuntime({
      owner:this,
      storage:ctx.storage,
      ai:env.AI,
      ...(env.CHATGPT?{chatgpt:{fetch:async(request:Request)=>{
        const url=new URL(request.url);
        if(url.href!=="https://api.openai.com/v1/responses" || request.method!=="POST") throw new Error("Unsupported ChatGPT inference route");
        const connection=env.CHATGPT!.get(env.CHATGPT!.idFromName("owner"));
        return connection.fetch(new Request("https://chatgpt/responses",{method:"POST",headers:{"content-type":"application/json"},body:request.body,signal:request.signal}));
      }}}:{}),
      getBot:async()=>this.currentBot(),
      getApprovalContext:async()=>this.approvalContext(),
      onAdmissionRetry:async(operationId)=>this.admit(operationId),
      tools:{
        execute:async(input)=>this.executeTool(input),
        readImage:async(artifactId)=>this.readImage(artifactId),
      },
      onEvent:async(event)=>this.project(event),
    });
  }

  private bot():Bot {
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
    type PageRow = {cursor:number;data:string};
    // One extra row determines whether another page exists, without COUNT(*) or OFFSET.
    const rows=before===undefined
      ? this.ctx.storage.sql.exec<PageRow>("SELECT rowid AS cursor,data FROM runs ORDER BY rowid DESC LIMIT ?",limit+1).toArray()
      : this.ctx.storage.sql.exec<PageRow>("SELECT rowid AS cursor,data FROM runs WHERE rowid<? ORDER BY rowid DESC LIMIT ?",before,limit+1).toArray();
    const page=rows.slice(0,limit);
    // Active runs can be older than the requested page. Admission permits at most 16.
    const activeRows=this.ctx.storage.sql.exec<JsonRow>("SELECT data FROM runs WHERE json_extract(data,'$.status') IN ('queued','running','waiting_approval') ORDER BY rowid DESC LIMIT 16").toArray();
    return {
      runs:page.map(row=>JSON.parse(row.data) as Run),
      activeRuns:activeRows.map(row=>JSON.parse(row.data) as Run),
      nextCursor:rows.length>limit?String(page[page.length-1].cursor):null,
    };
  }
  private findRun(nativeOperationId:string):RunRow|undefined {
    return this.ctx.storage.sql.exec<RunRow>("SELECT runs.* FROM runs JOIN submissions ON submissions.run_id=runs.id WHERE submissions.operation_id=?",nativeOperationId).toArray()[0];
  }
  private saveRun(run:Run):void {this.ctx.storage.sql.exec("UPDATE runs SET data=? WHERE id=?",JSON.stringify(run),run.id);}
  private emit(type:string,data:Record<string,unknown>,runId?:string,sourceKey?:string):void {
    const event:Omit<BotEvent,"id">={botId:this.bot().id,type,data,createdAt:timestamp(),...(runId?{runId}:{})};
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO events (source_key,data) VALUES (?,?)",sourceKey??null,JSON.stringify(event));
  }
  private addMessage(message:Message,sourceKey:string):void {
    const existed=this.ctx.storage.sql.exec<{id:string}>("SELECT id FROM messages WHERE source_key=?",sourceKey).toArray()[0];
    if(existed) return;
    this.ctx.storage.sql.exec("INSERT INTO messages (id,source_key,data) VALUES (?,?,?)",message.id,sourceKey,JSON.stringify(message));
    this.emit("message.created",{message},message.runId,`message:${sourceKey}`);
  }
  private updateStatus(runId:string,status:RunStatus,error?:string):void {
    const run=this.getRun(runId);
    if(run.status===status && run.error===error) return;
    const updated:Run={...run,status,updatedAt:timestamp(),...(error?{error}:{})};
    if(!error) delete updated.error;
    this.saveRun(updated);
    this.emit("run.updated",{run:updated},runId);
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
    const row=event.operationId?this.findRun(event.operationId):undefined;
    if(!row) return;
    const run=JSON.parse(row.data) as Run;
    // Do not expose raw provider error strings, which may contain request details.
    const data=event.type==="runtime.error"?{message:"The runtime reported an error."}:event.data;
    this.emit(event.type,data,run.id,event.eventKey?`runtime:${event.eventKey}`:undefined);
    if(row.native_operation_id!==event.operationId) return;
    // A durable terminal event may provide a safe diagnostic after wait() already
    // projected a generic error. It must never undo user cancellation or success.
    const genericInterruption=run.status==="interrupted" && ["The agent run was interrupted before a final answer.","The agent run was interrupted."].includes(run.error??"");
    const enrichFailure=event.type==="run.failed" && typeof event.data.publicMessage==="string" && (run.status==="failed" || genericInterruption);
    if(terminal.has(run.status) && !enrichFailure) return;
    if(Date.now()-this.lastComputerTouch>60_000) {
      this.lastComputerTouch=Date.now();
      this.ctx.waitUntil(touchCloudComputer(this.env.COMPUTER,run.botId).catch(()=>{}));
    }
    if(event.type==="run.started" && !this.hasPendingApproval(run.id)) this.updateStatus(run.id,"running");
    if(event.type==="run.completed") await this.completeOperation(event.operationId!,"done",typeof event.data.text==="string"?event.data.text:undefined);
    if(event.type==="run.failed") {
      if(this.hasPendingApproval(run.id)) this.updateStatus(run.id,"waiting_approval");
      else {
        const failure=this.operationFailure(typeof event.data.reason==="string"?event.data.reason:undefined,typeof event.data.publicMessage==="string"?event.data.publicMessage:undefined);
        this.updateStatus(run.id,failure.status,failure.error);
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
  private async completeOperation(nativeOperationId:string,status:string,text?:string,reason?:string):Promise<void> {
    const row=this.findRun(nativeOperationId);
    if(!row) return;
    const run=JSON.parse(row.data) as Run;
    if(text) this.addMessage({id:crypto.randomUUID(),botId:run.botId,runId:run.id,role:"assistant",text,createdAt:timestamp()},`answer:${nativeOperationId}`);
    if(row.native_operation_id!==nativeOperationId || terminal.has(run.status)) return;
    if(this.hasPendingApproval(run.id)) {this.updateStatus(run.id,"waiting_approval");return;}
    // The provider checkpoints file mutations before returning their results.
    // Read-only/GUI turns must not stop a warm browser just to copy its profile.
    if(status==="done") this.updateStatus(run.id,"completed");
    else {const failure=this.operationFailure(reason);this.updateStatus(run.id,failure.status,failure.error);}
  }

  private async createRun(input:{text:string;operationId:string}):Promise<Run> {
    const hash=await fingerprint({text:input.text});
    if(input.operationId.startsWith("approval:") || input.operationId.startsWith("delegate:")) throw new ApiError(400,"reserved_operation_id","This operationId prefix is reserved.");
    const existing=this.ctx.storage.sql.exec<RunRow>("SELECT * FROM runs WHERE operation_id=?",input.operationId).toArray()[0];
    if(existing) {
      if(existing.fingerprint!==hash) throw new ApiError(409,"idempotency_conflict","operationId was already used with different input.");
      const run=JSON.parse(existing.data) as Run;
      const submission=this.ctx.storage.sql.exec<Submission>("SELECT * FROM submissions WHERE operation_id=?",existing.native_operation_id).toArray()[0];
      // An explicit retry can reopen only a known input-delivery failure. Model,
      // tool, cancellation and interrupted-effect outcomes remain terminal.
      if(submission && !submission.admitted && ((run.status==="failed" && run.error===legacyAdmissionFailure) || (run.status==="queued" && run.error===admissionExhausted))) {
        this.ctx.storage.transactionSync(()=>{
          this.ctx.storage.sql.exec("DELETE FROM admission_retries WHERE operation_id=?",existing.native_operation_id);
          this.updateStatus(run.id,"queued");
        });
      }
      await this.admit(existing.native_operation_id);
      return this.getRun(existing.id);
    }
    if(this.suspending) throw new ApiError(409,"computer_busy","The computer is being suspended. Retry after it stops.");
    const activeCount=this.ctx.storage.sql.exec<{total:number}>("SELECT COUNT(*) AS total FROM runs WHERE json_extract(data,'$.status') IN ('queued','running','waiting_approval')").toArray()[0].total;
    if(activeCount>=16) throw new ApiError(429,"too_many_runs","This bot already has 16 active runs.");
    const now=timestamp();
    const run:Run={id:crypto.randomUUID(),botId:this.bot().id,operationId:input.operationId,status:"queued",createdAt:now,updatedAt:now};
    this.ctx.storage.transactionSync(()=>{
      this.ctx.storage.sql.exec("INSERT INTO runs (id,operation_id,fingerprint,native_operation_id,data) VALUES (?,?,?,?,?)",run.id,input.operationId,hash,input.operationId,JSON.stringify(run));
      this.ctx.storage.sql.exec("INSERT INTO submissions (operation_id,run_id,text) VALUES (?,?,?)",input.operationId,run.id,input.text);
      this.addMessage({id:crypto.randomUUID(),botId:run.botId,runId:run.id,role:"user",text:input.text,createdAt:now},`input:${input.operationId}`);
      this.emit("run.updated",{run},run.id,`created:${run.id}`);
    });
    await this.admit(input.operationId);
    return this.getRun(run.id);
  }

  /** This outbox only admits durable inputs. Pi owns all execution and tool recovery. */
  private admit(nativeOperationId:string):Promise<void> {
    const existing=this.admitting.get(nativeOperationId);
    if(existing) return existing;
    const operation=this.admitOnce(nativeOperationId).finally(()=>this.admitting.delete(nativeOperationId));
    this.admitting.set(nativeOperationId,operation);
    return operation;
  }
  private async admitOnce(nativeOperationId:string):Promise<void> {
    const submission=this.ctx.storage.sql.exec<Submission>("SELECT * FROM submissions WHERE operation_id=?",nativeOperationId).toArray()[0];
    if(!submission) return;
    const row=this.getRunRow(submission.run_id),run=JSON.parse(row.data) as Run;
    if(row.native_operation_id!==nativeOperationId || terminal.has(run.status) || run.status==="waiting_approval") return;
    const retry=this.ctx.storage.sql.exec<AdmissionRetry>("SELECT attempts,next_at FROM admission_retries WHERE operation_id=?",nativeOperationId).toArray()[0];
    if(!submission.admitted && retry && (retry.attempts>=maxAdmissionAttempts || retry.next_at>Date.now())) return;
    try {
      if(!submission.admitted) {
        await this.runtime.submit(submission.text,{operationId:nativeOperationId});
        this.ctx.storage.sql.exec("UPDATE submissions SET admitted=1 WHERE operation_id=?",nativeOperationId);
        this.ctx.storage.sql.exec("DELETE FROM admission_retries WHERE operation_id=?",nativeOperationId);
        const current=this.getRunRow(run.id),latest=JSON.parse(current.data) as Run;
        if(current.native_operation_id===nativeOperationId && latest.status==="queued" && [admissionPending,admissionExhausted].includes(latest.error??"")) this.updateStatus(run.id,"queued");
      }
      this.observe(nativeOperationId);
    } catch {
      // Admission may settle after an approval replaced this native input or the
      // user cancelled it. A stale failure cannot terminate the newer input.
      if(!this.canAdmit(nativeOperationId,run.id)) return;
      // A lost receipt does not mean Pi rejected the input. Reconcile its durable
      // record before retrying the same idempotent input; never restart a tool.
      let known:Awaited<ReturnType<AgentRuntime["operation"]>>|undefined;
      try {known=await this.runtime.operation(nativeOperationId);} catch {/* Keep delivery unconfirmed. */}
      if(!this.canAdmit(nativeOperationId,run.id)) return;
      if(known && known.status!=="missing") {
        this.ctx.storage.sql.exec("UPDATE submissions SET admitted=1 WHERE operation_id=?",nativeOperationId);
        this.ctx.storage.sql.exec("DELETE FROM admission_retries WHERE operation_id=?",nativeOperationId);
        if(known.status==="done" || known.status==="unanswered") await this.completeOperation(nativeOperationId,known.status,known.text,known.reason);
        else {this.updateStatus(run.id,known.status==="running"?"running":"queued");this.observe(nativeOperationId);}
        return;
      }
      const attempts=(retry?.attempts??0)+1,delayMs=1000*2**(attempts-1);
      this.ctx.storage.sql.exec("INSERT INTO admission_retries(operation_id,attempts,next_at) VALUES(?,?,?) ON CONFLICT(operation_id) DO UPDATE SET attempts=excluded.attempts,next_at=excluded.next_at",nativeOperationId,attempts,Date.now()+delayMs);
      this.updateStatus(run.id,"queued",attempts<maxAdmissionAttempts?admissionPending:admissionExhausted);
      if(attempts<maxAdmissionAttempts) await this.runtime.scheduleAdmissionRetry(nativeOperationId,delayMs);
    }
  }
  private canAdmit(nativeOperationId:string,runId:string):boolean {
    const current=this.getRunRow(runId),run=JSON.parse(current.data) as Run;
    return current.native_operation_id===nativeOperationId && !terminal.has(run.status) && run.status!=="waiting_approval";
  }
  private observe(nativeOperationId:string):void {
    if(this.observing.has(nativeOperationId)) return;
    this.observing.add(nativeOperationId);
    this.ctx.waitUntil((async()=>{
      try {
        const result=await this.runtime.wait(nativeOperationId);
        await this.completeOperation(nativeOperationId,result.status,result.text,result.reason);
      } catch {const row=this.findRun(nativeOperationId);if(row?.native_operation_id===nativeOperationId) {const run=JSON.parse(row.data) as Run;if(!terminal.has(run.status) && run.status!=="waiting_approval") this.updateStatus(run.id,"interrupted","The agent run was interrupted.");}}
      finally {this.observing.delete(nativeOperationId);}
    })());
  }
  private recover():Promise<void> {
    if(this.recovering) return this.recovering;
    this.recovering=(async()=>{
      const rows=this.ctx.storage.sql.exec<RunRow>("SELECT * FROM runs").toArray();
      for(const row of rows) {
        const run=JSON.parse(row.data) as Run;
        if(!terminal.has(run.status) && run.status!=="waiting_approval") await this.admit(row.native_operation_id);
      }
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
  private async executeTool(input:{operationId:string;runOperationId:string;action:ComputerAction;signal?:AbortSignal}):Promise<RuntimeToolResult> {
    const row=this.findRun(input.runOperationId);
    if(!row) throw new ApiError(409,"run_not_found","Tool has no active run.");
    const run=JSON.parse(row.data) as Run;
    if(terminal.has(run.status) || input.signal?.aborted) return {operationId:input.operationId,status:"interrupted",error:"Run is no longer active."};
    const action=parseAction(input.action);
    const hash=await fingerprint(action);
    const existing=this.existingToolDecision(input.operationId,hash);
    if(existing) return existing;
    const bot=await this.currentBot();
    if(terminal.has(this.getRun(run.id).status) || input.signal?.aborted) return {operationId:input.operationId,status:"interrupted",error:"Run is no longer active."};
    // Another invocation may have persisted this exact decision while the
    // registry read was pending. Recheck before dispatching under fresh policy.
    const concurrentDecision=this.existingToolDecision(input.operationId,hash);
    if(concurrentDecision) return concurrentDecision;
    if(automatic.has(action.type) || bot.computerApprovalMode==="automatic") {
      const result=await this.computer.exec(run.botId,input.operationId,action);
      this.emit("tool.completed",{operationId:input.operationId,actionType:action.type,result},run.id,`tool:${input.operationId}`);
      return result;
    }
    const now=Date.now();
    const approval:Approval={id:crypto.randomUUID(),botId:run.botId,runId:run.id,operationId:input.operationId,action,status:"pending",createdAt:new Date(now).toISOString(),expiresAt:new Date(now+(gui.has(action.type)?5*60*1000:24*60*60*1000)).toISOString()};
    this.ctx.storage.sql.exec("INSERT INTO approvals (id,operation_id,fingerprint,data) VALUES (?,?,?,?)",approval.id,input.operationId,hash,JSON.stringify(approval));
    this.updateStatus(run.id,"waiting_approval");
    this.emit("approval.created",{approval},run.id,`approval:${approval.id}`);
    return {status:"pending_approval",approvalId:approval.id,message:"The exact action needs user approval. Stop and wait for the decision."};
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
  private saveApproval(approval:Approval):void {this.ctx.storage.sql.exec("UPDATE approvals SET data=? WHERE id=?",JSON.stringify(approval),approval.id);}
  private async decideApproval(id:string,decision:unknown):Promise<Approval> {
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
    const row=this.ctx.storage.sql.exec<JsonRow>("SELECT data FROM approvals WHERE id=?",id).toArray()[0];
    if(!row) return;
    const approval=JSON.parse(row.data) as Approval;
    // Recovery can hold an older snapshot. A terminal decision is immutable.
    if(approval.status!=="executing") return;
    let result:ComputerResult;
    let providerDiagnostic:string|undefined;
    try {result=await this.computer.exec(approval.botId,approval.operationId,approval.action);}
    catch(error) {
      console.error("approval.failure",{code:error instanceof ComputerProviderError?error.code:"computer_unavailable",actionType:approval.action.type});
      if(error instanceof ComputerProviderError) providerDiagnostic=`${error.code}: ${error.publicMessage} The action outcome is unconfirmed. Do not retry automatically.`;
      result={operationId:approval.operationId,status:"interrupted",error:providerDiagnostic??"Could not establish whether the action completed. Do not retry automatically."};
    }
    let continuation:string|undefined;
    this.ctx.storage.transactionSync(()=>{
      const currentRow=this.ctx.storage.sql.exec<JsonRow>("SELECT data FROM approvals WHERE id=?",id).toArray()[0];
      if(!currentRow || (JSON.parse(currentRow.data) as Approval).status!=="executing") return;
      const completed:Approval={...approval,result,status:result.status==="completed"?"completed":result.status==="interrupted"?"interrupted":"failed"};
      this.saveApproval(completed);
      this.emit("approval.updated",{approval:completed},approval.runId,`approval-result:${approval.id}`);
      this.emit("tool.completed",{operationId:approval.operationId,actionType:approval.action.type,result},approval.runId,`tool:${approval.operationId}`);
      if(result.status==="interrupted") {
        if(!terminal.has(this.getRun(approval.runId).status)) this.updateStatus(approval.runId,"interrupted",providerDiagnostic??"An approved action was interrupted. Check its effects before retrying.");
      } else continuation=this.queueApprovalContinuation(completed);
    });
    if(continuation) await this.admit(continuation);
  }
  /** Called in the same transaction as the decision/result, so a restart cannot
   * leave a finished approval without its durable continuation input. */
  private queueApprovalContinuation(approval:Approval):string|undefined {
    const row=this.getRunRow(approval.runId),run=JSON.parse(row.data) as Run;
    if(terminal.has(run.status)) return;
    const nativeOperationId=`approval:${approval.id}`;
    const existing=this.ctx.storage.sql.exec<Submission>("SELECT * FROM submissions WHERE operation_id=?",nativeOperationId).toArray()[0];
    // A late duplicate must not reset a running/waiting state or rewind the bot
    // from a newer continuation to this older one.
    if(existing) return row.native_operation_id===nativeOperationId?nativeOperationId:undefined;
    const text=approval.status==="denied"
      ? `The user denied action ${approval.id}. Do not execute it. Explain or continue using allowed alternatives.`
      : `The user approved action ${approval.id}. The platform already executed exactly the stored action. Do not repeat it. Result: ${JSON.stringify(approval.result)}. Continue the original task.`;
    this.ctx.storage.sql.exec("INSERT INTO submissions (operation_id,run_id,text) VALUES (?,?,?)",nativeOperationId,run.id,text);
    this.ctx.storage.sql.exec("UPDATE runs SET native_operation_id=? WHERE id=?",nativeOperationId,run.id);
    this.updateStatus(run.id,"queued");
    return nativeOperationId;
  }
  private async cancelRun(id:string):Promise<Run> {
    const row=this.getRunRow(id),run=JSON.parse(row.data) as Run;
    if(terminal.has(run.status)) return run;
    this.updateStatus(id,"cancelled");
    const pending=this.ctx.storage.sql.exec<JsonRow>("SELECT data FROM approvals").toArray().map(row=>JSON.parse(row.data) as Approval);
    for(const approval of pending) if(approval.runId===id && approval.status==="pending") {
      approval.status="denied";this.saveApproval(approval);this.emit("approval.updated",{approval},id);
    }
    await this.runtime.cancel(row.native_operation_id);
    return this.getRun(id);
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
      if(timer) clearInterval(timer);if(deadline) clearTimeout(deadline);
      request.signal.removeEventListener("abort",finish);
    };
    const finish=()=>{if(closed) return;cleanup();try{controller.close();}catch{}};
    const pump=()=>{
      if(closed) return;
      if(controller.desiredSize!==null && controller.desiredSize<=0) return;
      const rows=this.ctx.storage.sql.exec<{id:number;data:string}>("SELECT id,data FROM events WHERE id>? ORDER BY id LIMIT 100",cursor).toArray();
      let chunk="";
      for(const row of rows) {chunk+=`id: ${row.id}\nevent: event\ndata: ${JSON.stringify({id:row.id,...JSON.parse(row.data)})}\n\n`;cursor=row.id;}
      if(chunk) controller.enqueue(encoder.encode(chunk));
    };
    const stream=new ReadableStream<Uint8Array>({
      start:c=>{
        controller=c;
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
      this.configure(request);
      this.ctx.waitUntil(this.recover());
      const url=new URL(request.url),path=url.pathname;
      if(path==="/messages" && request.method==="GET") {
        const messages=this.ctx.storage.sql.exec<JsonRow>("SELECT data FROM messages ORDER BY rowid DESC LIMIT 500").toArray().reverse().map(row=>JSON.parse(row.data));
        return json({messages});
      }
      if(path==="/messages" && request.method==="POST") return json({run:await this.createRun(parseMessage(await body(request)))},202);
      if(path==="/runs" && request.method==="GET") return json(this.listRuns(url));
      const runRoute=/^\/runs\/([^/]+)(\/cancel)?$/.exec(path);
      if(runRoute && UUID.test(runRoute[1])) {
        if(request.method==="GET" && !runRoute[2]) return json({run:this.getRun(runRoute[1])});
        if(request.method==="POST" && runRoute[2]) return json({run:await this.cancelRun(runRoute[1])});
      }
      if(path==="/events" && request.method==="GET") return this.events(request,url);
      if(path==="/computer" && request.method==="GET") return json({computer:await this.computer.status(this.bot().id)});
      if(path==="/computer/suspend" && request.method==="POST") return json({computer:await this.suspendComputer()});
      if(path==="/computer/actions" && request.method==="POST") {
        if(this.suspending) throw new ApiError(409,"computer_busy","The computer is being suspended. Retry after it stops.");
        const input=await body(request),action=parseAction(input.action),op=operationId(input.operationId);
        if(!["readFile","listFiles","screenshot"].includes(action.type)) this.invalidatePendingGui();
        const result=await this.computer.exec(this.bot().id,op,action);
        this.emit("computer.action",{operationId:op,actionType:action.type,result},undefined,`direct:${op}`);
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
