import type { AgentDelegation, Bot, Message, MessageProvenance, Run, RunStatus } from "@botspace/contracts";
import type { Env } from "./env";
import { ApiError, json } from "./errors";
import { body, fingerprint, parseBotInput, string, UUID } from "./validation";

type JsonRow={data:string};
type Phase="submit"|"observe"|"result"|"cancel"|"done";
type Delivery={delegation:AgentDelegation;text:string;kind:"bot"|"mention";result?:string};
type DeliveryRow={id:string;source_bot_id:string;operation_id:string;fingerprint:string;phase:Phase;attempts:number;next_at:number;data:string};
const terminal=new Set<RunStatus>(["completed","failed","cancelled","interrupted"]);
const maxAttempts=5;
const maxLifetimeMs=24*60*60*1000;

function identifier(value:unknown,name:string):string {
  const result=string(value,name,36);
  if(!UUID.test(result)) throw new ApiError(400,"invalid_request",`${name} must be a bot or run UUID.`);
  return result;
}
function toolOperationId(value:unknown):string {
  const result=string(value,"operationId",160);
  if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(result)) throw new ApiError(400,"invalid_request","Invalid agent operation ID.");
  return result;
}

/** Internal owner-scoped port. Provider credentials never enter its payloads. */
export async function agentCoordinatorRequest<T>(env:Env,path:string,input?:unknown,method="POST"):Promise<T> {
  const registry=env.WORKSPACE.get(env.WORKSPACE.idFromName("owner"));
  const response=await registry.fetch(new Request(`https://workspace${path}`,{method,headers:{"content-type":"application/json","x-timber-internal":"agents"},...(input===undefined?{}:{body:JSON.stringify(input)})}));
  const data=await response.json<T & {error?:{code:string;message:string}}>();
  if(!response.ok) throw new ApiError(response.status,data.error?.code??"agent_coordination_failed",data.error?.message??"The agent operation could not be completed.");
  return data;
}

/** Durable outbox kept in the same object as the authoritative bot registry. */
export class AgentCoordinator {
  private working=new Map<string,Promise<void>>();
  constructor(private ctx:DurableObjectState,private env:Env,private rearm:()=>Promise<void>) {
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS agent_creations (source_bot_id TEXT NOT NULL,operation_id TEXT NOT NULL,fingerprint TEXT NOT NULL,bot_id TEXT NOT NULL,PRIMARY KEY(source_bot_id,operation_id));
      CREATE TABLE IF NOT EXISTS agent_deliveries (id TEXT PRIMARY KEY,source_bot_id TEXT NOT NULL,operation_id TEXT NOT NULL,fingerprint TEXT NOT NULL,phase TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL,data TEXT NOT NULL,UNIQUE(source_bot_id,operation_id));
      CREATE INDEX IF NOT EXISTS agent_deliveries_due ON agent_deliveries(phase,next_at);
    `);
  }
  nextAlarm():number|undefined {
    return this.ctx.storage.sql.exec<{next_at:number}>("SELECT next_at FROM agent_deliveries WHERE phase!='done' ORDER BY next_at LIMIT 1").toArray()[0]?.next_at;
  }
  private bot(id:string):Bot {
    const row=this.ctx.storage.sql.exec<JsonRow>("SELECT data FROM bots WHERE id=?",id).toArray()[0];
    if(!row) throw new ApiError(404,"not_found","Bot not found.");
    return JSON.parse(row.data) as Bot;
  }
  private async botRequest<T>(botId:string,path:string,input?:unknown,method="GET"):Promise<T> {
    const bot=this.bot(botId);
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),30_000);
    try {
      const response=await this.env.BOT.get(this.env.BOT.idFromName(`owner:${botId}`)).fetch(new Request(`https://bot${path}`,{method,signal:controller.signal,headers:{"content-type":"application/json","x-timber-internal":"agents","x-botspace-config":encodeURIComponent(JSON.stringify(bot))},...(input===undefined?{}:{body:JSON.stringify(input)})}));
      if(!response.ok) {
        // BotDO public diagnostics are reviewed, but arbitrary provider responses
        // are never copied into another bot's transcript.
        throw new ApiError(response.status,"agent_delivery_failed","The agent message could not be delivered.");
      }
      return await response.json<T>();
    } finally {clearTimeout(timer);}
  }
  private async source(input:Record<string,unknown>):Promise<{bot:Bot;run:Run;operationId:string}> {
    const botId=identifier(input.sourceBotId,"sourceBotId"),runId=identifier(input.sourceRunId,"sourceRunId");
    const operationId=toolOperationId(input.operationId);
    this.bot(botId);
    const {run}=await this.botRequest<{run:Run}>(botId,`/runs/${runId}`);
    if(run.botId!==botId || run.id!==runId) throw new ApiError(403,"agent_source_mismatch","The agent source run does not belong to this bot.");
    return {bot:this.bot(botId),run,operationId};
  }
  private previousCreation(botId:string,operationId:string,hash:string):Bot|undefined {
    const previous=this.ctx.storage.sql.exec<{fingerprint:string;bot_id:string}>("SELECT fingerprint,bot_id FROM agent_creations WHERE source_bot_id=? AND operation_id=?",botId,operationId).toArray()[0];
    if(!previous) return;
    if(previous.fingerprint!==hash) throw new ApiError(409,"idempotency_conflict","operationId was already used with different input.");
    return this.bot(previous.bot_id);
  }
  private async create(input:Record<string,unknown>):Promise<Response> {
    const botId=identifier(input.sourceBotId,"sourceBotId"),runId=identifier(input.sourceRunId,"sourceRunId"),op=toolOperationId(input.operationId);
    const fields=parseBotInput({name:input.name,instructions:input.instructions});
    const hash=await fingerprint({sourceRunId:runId,name:fields.name,instructions:fields.instructions??""});
    this.bot(botId);
    const previous=this.previousCreation(botId,op,hash);
    if(previous) return json({bot:previous},201);
    const source=await this.source(input);
    // Both the deduplication lookup and policy read follow the only network
    // await, so a concurrent revocation or retry cannot race a new creation.
    const raced=this.previousCreation(botId,op,hash);
    if(raced) return json({bot:raced},201);
    const current=this.bot(botId);
    if(current.allowNamedAgents!==true) throw new ApiError(403,"named_agents_disabled","Enable Allow named agents for this bot before creating a named bot.");
    if(terminal.has(source.run.status)) throw new ApiError(409,"run_inactive","The source run is no longer active.");
    const now=new Date().toISOString();
    const bot:Bot={id:crypto.randomUUID(),name:fields.name!,instructions:fields.instructions??"",runtime:"pi",model:current.model,computerApprovalMode:"ask",allowNamedAgents:false,createdByBotId:botId,createdAt:now,updatedAt:now};
    this.ctx.storage.transactionSync(()=>{
      this.ctx.storage.sql.exec("INSERT INTO bots(id,data) VALUES(?,?)",bot.id,JSON.stringify(bot));
      this.ctx.storage.sql.exec("INSERT INTO agent_creations(source_bot_id,operation_id,fingerprint,bot_id) VALUES(?,?,?,?)",botId,op,hash,bot.id);
    });
    return json({bot},201);
  }
  private previousDelivery(botId:string,operationId:string,hash:string):AgentDelegation|undefined {
    const previous=this.ctx.storage.sql.exec<DeliveryRow>("SELECT * FROM agent_deliveries WHERE source_bot_id=? AND operation_id=?",botId,operationId).toArray()[0];
    if(!previous) return;
    if(previous.fingerprint!==hash) throw new ApiError(409,"idempotency_conflict","operationId was already used with different input.");
    return (JSON.parse(previous.data) as Delivery).delegation;
  }
  private async send(input:Record<string,unknown>):Promise<Response> {
    const botId=identifier(input.sourceBotId,"sourceBotId"),runId=identifier(input.sourceRunId,"sourceRunId"),op=toolOperationId(input.operationId),targetId=identifier(input.targetBotId,"targetBotId");
    const text=string(input.text,"text",32_000);
    if(!text.trim()) throw new ApiError(400,"invalid_request","text cannot be blank.");
    if(input.kind!==undefined && input.kind!=="bot" && input.kind!=="mention") throw new ApiError(400,"invalid_request","Invalid agent message kind.");
    const kind=input.kind==="mention"?"mention":"bot";
    const hash=await fingerprint({sourceRunId:runId,targetBotId:targetId,text,kind});
    this.bot(botId);
    const previous=this.previousDelivery(botId,op,hash);
    if(previous) {await this.rearm();return json({delegation:previous},202);}
    const source=await this.source(input);
    const raced=this.previousDelivery(botId,op,hash);
    if(raced) {await this.rearm();return json({delegation:raced},202);}
    const target=this.bot(targetId);
    if(source.run.status==="cancelled" || (kind!=="mention" && terminal.has(source.run.status))) throw new ApiError(409,"run_inactive","The source run is no longer active.");
    const lineage=source.run.delegation?.path??[botId];
    if(lineage[lineage.length-1]!==botId || lineage.some(id=>!UUID.test(id))) throw new ApiError(409,"invalid_delegation_path","The source delegation path is invalid.");
    if(lineage.includes(targetId)) throw new ApiError(409,"delegation_cycle","A delegation cannot revisit a bot in its path.");
    if(lineage.length>=5) throw new ApiError(409,"delegation_depth","A delegation can have at most four hops.");
    const active=this.ctx.storage.sql.exec<{count:number}>("SELECT COUNT(*) AS count FROM agent_deliveries WHERE source_bot_id=? AND phase!='done'",botId).one().count;
    if(active>=8) throw new ApiError(429,"delegation_limit","This bot already has eight pending delegations. Wait for a result before sending another.");
    const now=new Date().toISOString();
    const delegation:AgentDelegation={id:crypto.randomUUID(),sourceBotId:botId,sourceBotName:source.bot.name,sourceRunId:runId,targetBotId:targetId,targetBotName:target.name,path:[...lineage,targetId],status:"queued",createdAt:now,updatedAt:now};
    const delivery:Delivery={delegation,text,kind};
    this.ctx.storage.sql.exec("INSERT INTO agent_deliveries(id,source_bot_id,operation_id,fingerprint,phase,next_at,data) VALUES(?,?,?,?,?,?,?)",delegation.id,botId,op,hash,"submit",Date.now(),JSON.stringify(delivery));
    // The alarm is durable before acknowledging the receipt. The HTTP request
    // never waits for another model or a reciprocal message.
    await this.rearm();
    this.ctx.waitUntil(this.process(delegation.id));
    return json({delegation},202);
  }
  private row(id:string):DeliveryRow|undefined {return this.ctx.storage.sql.exec<DeliveryRow>("SELECT * FROM agent_deliveries WHERE id=?",id).toArray()[0];}
  private unchanged(row:DeliveryRow):boolean {
    const current=this.row(row.id);
    return current?.phase===row.phase && current.data===row.data;
  }
  private save(delivery:Delivery,phase:Phase,delay=0,attempts=0):void {
    delivery.delegation.updatedAt=new Date().toISOString();
    this.ctx.storage.sql.exec("UPDATE agent_deliveries SET data=?,phase=?,attempts=?,next_at=? WHERE id=?",JSON.stringify(delivery),phase,attempts,Date.now()+delay,delivery.delegation.id);
  }
  private failed(delivery:Delivery,message:string):void {
    delivery.delegation.status="failed";
    delivery.delegation.error=message;
    delivery.result=message;
    this.save(delivery,"result");
  }
  private cancel(delivery:Delivery,message:string,sourceRemoved=false):void {
    delivery.delegation.status="cancelled";
    delivery.delegation.error=message;
    if(sourceRemoved) {
      delivery.text="";delete delivery.result;
      delivery.delegation.sourceBotName="Deleted bot";
      delivery.delegation.targetBotName="";
    }
    this.save(delivery,"cancel");
  }
  private process(id:string):Promise<void> {
    const existing=this.working.get(id);
    if(existing) return existing;
    const work=this.processOnce(id).finally(async()=>{this.working.delete(id);await this.rearm();});
    this.working.set(id,work);
    return work;
  }
  private async processOnce(id:string):Promise<void> {
    const row=this.row(id);
    if(!row || row.phase==="done") return;
    const delivery=JSON.parse(row.data) as Delivery,d=delivery.delegation;
    try {
      if(row.phase==="cancel") {
        try {
          this.bot(d.targetBotId);
          // Cancelling by operation ID also fences an unacknowledged or late
          // initial submission; no unrelated target run can be interrupted.
          await this.botRequest(d.targetBotId,"/agent-cancel",{operationId:`delegate:${d.id}`},"POST");
        } catch(error) {if(!(error instanceof ApiError && error.status===404)) throw error;}
        if(!this.unchanged(row)) return;
        try {this.bot(d.sourceBotId);delivery.result=d.error??"The delegated task was cancelled.";this.save(delivery,"result");}
        catch {this.ctx.storage.sql.exec("DELETE FROM agent_deliveries WHERE id=?",id);}
        return;
      }
      // Deleting the source revokes its outstanding delivery authority.
      this.bot(d.sourceBotId);
      if(row.phase==="submit" || row.phase==="observe") {
        const {run:sourceRun}=await this.botRequest<{run:Run}>(d.sourceBotId,`/runs/${d.sourceRunId}`);
        if(!this.unchanged(row)) return;
        if(sourceRun.status==="cancelled") {
          this.cancel(delivery,"The source run was cancelled.");return;
        }
      }
      if(row.phase==="submit") {
        this.bot(d.targetBotId);
        const provenance:MessageProvenance={kind:delivery.kind,sourceBotId:d.sourceBotId,sourceBotName:d.sourceBotName,sourceRunId:d.sourceRunId,delegationId:d.id};
        const {run}=await this.botRequest<{run:Run}>(d.targetBotId,"/agent-messages",{text:delivery.text,operationId:`delegate:${d.id}`,provenance,delegation:{id:d.id,sourceBotId:d.sourceBotId,sourceRunId:d.sourceRunId,path:d.path}},"POST");
        if(!this.unchanged(row)) return;
        if(run.botId!==d.targetBotId || !UUID.test(run.id)) throw new ApiError(502,"agent_delivery_failed","The target returned an invalid delivery receipt.");
        d.targetRunId=run.id;d.status=run.status;
        this.save(delivery,"observe",1000);
      } else if(row.phase==="observe") {
        if(Date.now()-Date.parse(d.createdAt)>maxLifetimeMs) {
          this.cancel(delivery,"The delegation exceeded its 24-hour lifetime. Cancellation was requested; start a new task to continue.");
          return;
        }
        const {run}=await this.botRequest<{run:Run}>(d.targetBotId,`/runs/${d.targetRunId}`);
        if(!this.unchanged(row)) return;
        d.status=run.status;
        if(terminal.has(run.status)) {
          const {messages}=await this.botRequest<{messages:Message[]}>(d.targetBotId,"/messages");
          if(!this.unchanged(row)) return;
          const answer=messages.filter(message=>message.runId===run.id && message.role==="assistant" && message.kind!=="progress").at(-1)?.text;
          delivery.result=(answer??run.error??`The delegated run ${run.status}.`).slice(0,32_000);
          if(run.error) d.error=run.error;
          this.save(delivery,"result");
        } else this.save(delivery,"observe",run.status.startsWith("waiting_")?15_000:3000);
      } else {
        const provenance:MessageProvenance={kind:"delegation_result",sourceBotId:d.targetBotId,sourceBotName:d.targetBotName,...(d.targetRunId?{sourceRunId:d.targetRunId}:{}),delegationId:d.id};
        await this.botRequest(d.sourceBotId,"/agent-results",{delegation:d,status:d.status,text:delivery.result??"The delegated task finished without a response.",provenance},"POST");
        if(this.unchanged(row)) this.save(delivery,"done");
      }
    } catch(error) {
      if(!this.unchanged(row)) return;
      if(row.phase==="cancel") {
        // Cancellation is safety-critical: retain the durable fence request
        // across transport outages until the exact target acknowledges it.
        this.save(delivery,"cancel",Math.min(60_000,1000*2**Math.min(row.attempts,6)),row.attempts+1);
        return;
      }
      // A removed source has no conversation to notify. A removed target is a
      // terminal, visible failure in the surviving source's conversation.
      try {this.bot(d.sourceBotId);} catch {this.cancel(delivery,"The source bot was deleted.",true);return;}
      const attempts=row.attempts+1;
      if(error instanceof ApiError && error.status===404 && row.phase!=="result") this.failed(delivery,"The target bot or delegated run is no longer available.");
      else if(attempts>=maxAttempts) {
        if(row.phase==="result") {
          d.error="The delegation finished, but its result could not be delivered to the source conversation. Inspect the target conversation.";
          this.save(delivery,"done",0,attempts);
        } else this.cancel(delivery,"The delegated task could not be confirmed after repeated delivery attempts. Cancellation was requested; inspect the target conversation before retrying.");
      } else this.save(delivery,row.phase,1000*2**(attempts-1),attempts);
    }
  }
  async alarm():Promise<void> {
    const due=this.ctx.storage.sql.exec<{id:string}>("SELECT id FROM agent_deliveries WHERE phase!='done' AND next_at<=? ORDER BY next_at LIMIT 8",Date.now()).toArray();
    await Promise.allSettled(due.map(row=>this.process(row.id)));
  }
  forgetBot(id:string):void {
    // Keep only creation identities referring to a deleted child: replaying a
    // previously accepted create returns 404 and cannot resurrect the child.
    this.ctx.storage.sql.exec("DELETE FROM agent_creations WHERE source_bot_id=?",id);
    const deliveries=this.ctx.storage.sql.exec<DeliveryRow>("SELECT * FROM agent_deliveries WHERE source_bot_id=?",id).toArray();
    for(const row of deliveries) {
      if(row.phase==="done") this.ctx.storage.sql.exec("DELETE FROM agent_deliveries WHERE id=?",row.id);
      else this.cancel(JSON.parse(row.data) as Delivery,"The source bot was deleted.",true);
    }
  }
  async fetch(request:Request):Promise<Response> {
    if(request.headers.get("x-timber-internal")!=="agents") throw new ApiError(403,"internal_only","This agent route is internal.");
    const url=new URL(request.url);
    if(url.pathname==="/agents/create" && request.method==="POST") return this.create(await body(request));
    if(url.pathname==="/agents/send" && request.method==="POST") return this.send(await body(request));
    if(url.pathname==="/agents/tasks" && request.method==="GET") {
      const botId=identifier(url.searchParams.get("botId"),"botId");
      this.bot(botId);
      const rows=this.ctx.storage.sql.exec<JsonRow>("SELECT data FROM agent_deliveries WHERE source_bot_id=? OR json_extract(data,'$.delegation.targetBotId')=? ORDER BY rowid DESC LIMIT 100",botId,botId).toArray();
      return json({delegations:rows.map(row=>(JSON.parse(row.data) as Delivery).delegation)});
    }
    throw new ApiError(404,"not_found","Agent route not found.");
  }
}
