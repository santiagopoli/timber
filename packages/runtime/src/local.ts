import {isModelErrorCode,modelFailure} from '../../contracts/src/model-errors.ts';
import type {DeviceAgentInput,ExecutionTarget} from '@botspace/contracts';
import type {AgentRuntime,RuntimeEvent,RuntimeOperation,RuntimeOperationResult,RuntimeTools} from './types.js';
import type {AssistantMessageEventStream,TranscriptContext,SimpleStreamOptions} from '@earendil-works/pi-ai';

export type LocalTarget=Extract<ExecutionTarget,{kind:'device'}>;
export interface DeviceRuntimePort {
  /** Stable operationId deduplicates a response lost after durable admission. */
  submit(target:LocalTarget,input:DeviceAgentInput):Promise<{jobId:string}>;
  operation(jobId:string,after?:number):Promise<Omit<RuntimeOperation,'operationId'> & {events?:RuntimeEvent[];eventCursor?:number;hasMoreEvents?:boolean;deviceOnline?:boolean}>;
  cancel(jobId:string,input:{cancellationId?:string}):Promise<boolean>;
}
export interface DeviceRuntimeOptions {
  base:AgentRuntime;storage:Pick<DurableObjectStorage,'sql'>;
  getTarget(operationId:string):Promise<ExecutionTarget|undefined>;
  snapshot(text:string,input:Parameters<AgentRuntime['submit']>[1],target:LocalTarget):Promise<DeviceAgentInput>;
  port:DeviceRuntimePort;onEvent?(event:RuntimeEvent):void|Promise<void>;pollMs?:number;waitWindowMs?:number;
}
export interface DeviceAgentRuntime extends AgentRuntime {
  ingestEvent(operationId:string,event:RuntimeEvent):Promise<void>;
  localInput(operationId:string):DeviceAgentInput|undefined;
}
type Row={operation_id:string;target:string;job_id:string|null;status:string;result:string|null;event_cursor:number};
const terminal=(status:string)=>status==='done'||status==='unanswered';
const sha256=async(value:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),byte=>byte.toString(16).padStart(2,'0')).join('');

/** Durable host outbox for real owned-machine Pi; native CF work stays native. */
export function createDeviceRuntime(options:DeviceRuntimeOptions):DeviceAgentRuntime {
  const {base,storage,port}=options,sql=storage.sql;
  sql.exec('CREATE TABLE IF NOT EXISTS timber_local_runtime_operations(operation_id TEXT PRIMARY KEY,target TEXT NOT NULL,job_id TEXT,status TEXT NOT NULL,result TEXT,fingerprint TEXT NOT NULL,event_cursor INTEGER NOT NULL DEFAULT 0)');
  sql.exec('CREATE TABLE IF NOT EXISTS timber_local_runtime_stops(operation_id TEXT PRIMARY KEY,result TEXT NOT NULL)');
  sql.exec('CREATE TABLE IF NOT EXISTS timber_local_runtime_payloads(operation_id TEXT NOT NULL,part INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(operation_id,part))');
  sql.exec('CREATE TABLE IF NOT EXISTS timber_local_runtime_events(operation_id TEXT NOT NULL,event_key TEXT NOT NULL,event TEXT NOT NULL,published INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(operation_id,event_key))');
  sql.exec('CREATE INDEX IF NOT EXISTS timber_local_runtime_pending ON timber_local_runtime_operations(status)');
  const pendingRows=()=>sql.exec<Row>("SELECT operation_id,target,job_id,status,result,event_cursor FROM timber_local_runtime_operations WHERE status IN ('queued','running')").toArray();
  let closing=false,suspended=false;
  const wakeups=new Set<()=>void>();
  const wake=()=>{for(const resolve of [...wakeups])resolve();};
  const sleep=()=>new Promise<void>(resolve=>{const done=()=>{clearTimeout(timer);wakeups.delete(done);resolve();};const timer=setTimeout(done,options.pollMs??1000);wakeups.add(done);});
  const row=(id:string)=>sql.exec<Row>('SELECT operation_id,target,job_id,status,result,event_cursor FROM timber_local_runtime_operations WHERE operation_id=?',id).toArray()[0];
  const stop=(id:string)=>sql.exec<{result:string}>('SELECT result FROM timber_local_runtime_stops WHERE operation_id=?',id).toArray()[0];
  const localInput=(id:string):DeviceAgentInput|undefined=>{
    if(!row(id))return undefined;
    const parts=sql.exec<{data:string}>('SELECT data FROM timber_local_runtime_payloads WHERE operation_id=? ORDER BY part',id).toArray();return JSON.parse(parts.map(part=>part.data).join('')) as DeviceAgentInput;
  };
  const availability=new Map<string,boolean>();
  const admissions=new Map<string,Promise<{jobId:string}>>();
  const admit=async(id:string)=>{
    const record=row(id);if(!record)throw new Error('Local runtime input is missing');
    if(record.job_id)return {jobId:record.job_id};
    if(terminal(record.status)||closing)throw new Error('Local runtime admission was stopped');
    const running=admissions.get(id);if(running)return running;
    const admission=port.submit(JSON.parse(record.target) as LocalTarget,localInput(id)!).then(async receipt=>{
      sql.exec('UPDATE timber_local_runtime_operations SET job_id=? WHERE operation_id=?',receipt.jobId,id);
      const current=row(id);if(current?.status==='unanswered'&&JSON.parse(current.result!).reason==='aborted')await port.cancel(receipt.jobId,{cancellationId:JSON.parse(current.result!).cancellationId});
      return receipt;
    }).finally(()=>admissions.delete(id));admissions.set(id,admission);return admission;
  };
  const ingestEvent=async(operationId:string,event:RuntimeEvent)=>{
    if(!row(operationId))throw new Error('Unknown local runtime operation');
    // The port/BotDO already authorizes device, job and claim; model content
    // cannot choose a different host operation or an event deduplication scope.
    const normalized={...event,operationId},encoded=JSON.stringify(normalized);
    const key=event.eventKey??`digest:${await sha256(encoded)}`;
    const prior=sql.exec<{event:string;published:number}>('SELECT event,published FROM timber_local_runtime_events WHERE operation_id=? AND event_key=?',operationId,key).toArray()[0];
    if(prior?.published)return;
    if(!prior)sql.exec('INSERT INTO timber_local_runtime_events(operation_id,event_key,event) VALUES(?,?,?)',operationId,key,encoded);
    await options.onEvent?.(prior?JSON.parse(prior.event) as RuntimeEvent:normalized);
    sql.exec('UPDATE timber_local_runtime_events SET published=1 WHERE operation_id=? AND event_key=?',operationId,key);
  };
  const operation=async(id:string):Promise<RuntimeOperation>=>{
    const record=row(id);if(!record){const native=await base.operation(id);return native.status==='missing'&&stop(id)?{operationId:id,...JSON.parse(stop(id)!.result)}:native;}
    if(terminal(record.status))return {operationId:id,...JSON.parse(record.result!)} as RuntimeOperation;
    if(!record.job_id)return {operationId:id,status:'queued'};
    const current=await port.operation(record.job_id,record.event_cursor);
    for(const event of current.events??[])await ingestEvent(id,event);
    const {events:_,eventCursor,hasMoreEvents,deviceOnline,...result}=current;
    if(terminal(current.status))availability.delete(id);else if(deviceOnline!==undefined)availability.set(id,deviceOnline);
    if(eventCursor!==undefined&&Number.isSafeInteger(eventCursor)&&eventCursor>=record.event_cursor)sql.exec('UPDATE timber_local_runtime_operations SET event_cursor=? WHERE operation_id=?',eventCursor,id);
    if(hasMoreEvents)return {operationId:id,status:'running'};
    if(result.status==='missing')return {operationId:id,status:record.status as 'queued'|'running'};
    sql.exec('UPDATE timber_local_runtime_operations SET status=?,result=? WHERE operation_id=?',result.status,terminal(result.status)?JSON.stringify(result):null,id);
    return {operationId:id,...result};
  };
  const cancelLocal=async(id?:string,cancelOptions?:{cancellationId?:string})=>{
    const local=pendingRows().filter(record=>!id||record.operation_id===id);let cancelled=false;
    for(const record of local){
      if(!record.job_id){sql.exec('UPDATE timber_local_runtime_operations SET status=?,result=? WHERE operation_id=?','unanswered',JSON.stringify({status:'unanswered',reason:'aborted',...(cancelOptions?.cancellationId?{cancellationId:cancelOptions.cancellationId}:{})}),record.operation_id);cancelled=true;continue;}
      cancelled=await port.cancel(record.job_id,cancelOptions??{})||cancelled;await operation(record.operation_id);
    }
    wake();return {cancelled,local};
  };
  return {
    ...base,localInput,ingestEvent,operation,
    failureDiagnostic(id){const record=row(id);if(!record)return base.failureDiagnostic?.(id);if(record.result){const data=JSON.parse(record.result);if(isModelErrorCode(data.errorCode))return modelFailure(data.errorCode);}return undefined;},
    async submit(text,input){
      const prior=row(input.operationId);
      if(closing)throw new Error('Local runtime is stopping');
      const fingerprintFor=(target:LocalTarget)=>sha256(JSON.stringify({text,modelSettings:input.modelSettings,images:input.images,target}));
      if(prior){const priorFingerprint=sql.exec<{fingerprint:string}>('SELECT fingerprint FROM timber_local_runtime_operations WHERE operation_id=?',input.operationId).toArray()[0]!.fingerprint;if(priorFingerprint!==await fingerprintFor(JSON.parse(prior.target)))throw new Error('operation_conflict');if(!terminal(prior.status))await admit(input.operationId);return {operationId:input.operationId,accepted:false};}
      if(stop(input.operationId))return {operationId:input.operationId,accepted:false};
      // Configuration changes must never migrate an operation already owned
      // by native CF Pi, even if the bot now targets the laptop.
      if((await base.operation(input.operationId)).status!=='missing'){if(stop(input.operationId))return {operationId:input.operationId,accepted:false};return base.submit(text,input);}
      const target=await options.getTarget(input.operationId);
      if(stop(input.operationId))return {operationId:input.operationId,accepted:false};
      if(!target||target.kind!=='device'||target.agentMode!=='local')return base.submit(text,input);
      const snapshot=await options.snapshot(text,input,target);
      if(snapshot.operationId!==input.operationId)throw new Error('Local input identity does not match');
      const serialized=JSON.stringify(snapshot),fingerprint=await fingerprintFor(target);
      const concurrent=row(input.operationId);if(concurrent){const existing=sql.exec<{fingerprint:string}>('SELECT fingerprint FROM timber_local_runtime_operations WHERE operation_id=?',input.operationId).toArray()[0]!.fingerprint;if(existing!==fingerprint)throw new Error('operation_conflict');if(!terminal(concurrent.status))await admit(input.operationId);return {operationId:input.operationId,accepted:false};}
      if(stop(input.operationId))return {operationId:input.operationId,accepted:false};
      if(closing)throw new Error('Local runtime is stopping');
      // Snapshot commits synchronously before external delivery. Chunks remain
      // under the Workers SQLite per-value limit, including image inputs.
      sql.exec('INSERT INTO timber_local_runtime_operations(operation_id,target,status,fingerprint) VALUES(?,?,?,?)',input.operationId,JSON.stringify(target),'queued',fingerprint);
      for(let offset=0,part=0;offset<serialized.length;offset+=16_000,part++)sql.exec('INSERT INTO timber_local_runtime_payloads(operation_id,part,data) VALUES(?,?,?)',input.operationId,part,serialized.slice(offset,offset+16_000));
      try{await admit(input.operationId);}catch(error){if(stop(input.operationId)||((error as {code?:string})?.code==='run_cancelled')){sql.exec('UPDATE timber_local_runtime_operations SET status=?,result=? WHERE operation_id=?','unanswered',stop(input.operationId)?.result??JSON.stringify({status:'unanswered',reason:'aborted'}),input.operationId);return {operationId:input.operationId,accepted:false};}await base.scheduleAdmissionRetry(input.operationId,1000);throw error;}
      await base.scheduleAdmissionRetry(input.operationId,1000);
      return {operationId:input.operationId,accepted:true};
    },
    async wait(id):Promise<RuntimeOperationResult>{
      if(!row(id)){if(stop(id))return {operationId:id,...JSON.parse(stop(id)!.result)} as RuntimeOperationResult;return base.wait(id);}
      const deadline=Date.now()+(options.waitWindowMs??20_000);
      for(;;){
        try{const stored=row(id);if(stored&&terminal(stored.status))return {operationId:id,...JSON.parse(stored.result!)} as RuntimeOperationResult;if(closing||suspended)throw new Error('local_runtime_suspended');await admit(id);const value=await operation(id);if(terminal(value.status))return value as RuntimeOperationResult;if(availability.get(id)===false||Date.now()>=deadline)throw Object.assign(new Error('Owned-machine observation is pending'),{code:'device_wait_pending'});}
        catch(error){if((error as {code?:string})?.code==='device_wait_pending')throw error;if(Date.now()>=deadline)throw Object.assign(new Error('Owned-machine observation is pending'),{code:'device_wait_pending'});if(closing||suspended)throw new Error('local_runtime_suspended');/* Offline stays pending. */}
        await sleep();
      }
    },
    async pending(){const native=await base.pending(),local=pendingRows().map(record=>({operationId:record.operation_id,status:record.status==='running'?'running' as const:'queued' as const}));return [...native,...local];},
    async cancel(id,cancelOptions){
      if(id)sql.exec('INSERT OR IGNORE INTO timber_local_runtime_stops(operation_id,result) VALUES(?,?)',id,JSON.stringify({status:'unanswered',reason:'aborted',...(cancelOptions?.cancellationId?{cancellationId:cancelOptions.cancellationId}:{})}));
      const {cancelled,local}=await cancelLocal(id,cancelOptions);
      const nativeCancelled=(!id||!local.length)?await base.cancel(id,cancelOptions):false;return cancelled||nativeCancelled;
    },
    async messages(){
      const native=await base.messages(),projected=sql.exec<{event:string}>('SELECT event FROM timber_local_runtime_events').toArray().map(record=>JSON.parse(record.event) as RuntimeEvent).filter(event=>event.type==='message').map(event=>event.data as unknown as Awaited<ReturnType<AgentRuntime['messages']>>[number]);
      const known=new Set(native.map(message=>message.id));return [...native,...projected.filter(message=>!known.has(message.id))];
    },
    async reconcile(){await base.reconcile();for(const record of pendingRows())try{await admit(record.operation_id);await operation(record.operation_id);}catch{await base.scheduleAdmissionRetry(record.operation_id,1000);}},
    async dispose(){suspended=true;wake();await base.dispose();},
    async destroy(){closing=true;wake();await cancelLocal();if(pendingRows().length)throw new Error('Local device work is still stopping');await base.destroy();},
  };
}

export interface DeviceAgentHandlerOptions {
  input:DeviceAgentInput;
  inference(context:TranscriptContext,options:SimpleStreamOptions,signal:AbortSignal):AssistantMessageEventStream|Promise<AssistantMessageEventStream>;
  tools:RuntimeTools;onEvent(event:RuntimeEvent):Promise<void>|void;
}
const computerActions:Record<string,string>={exec:'exec',exec_poll:'execPoll',exec_cancel:'execCancel',read_file:'readFile',write_file:'writeFile',list_files:'listFiles',browser_navigate:'navigate',desktop_screenshot:'screenshot',desktop_click:'click',desktop_move:'move',desktop_double_click:'doubleClick',desktop_drag:'drag',desktop_type:'type',desktop_key:'key',desktop_scroll:'scroll',checkpoint:'checkpoint',browser_recover:'browserRecover'};
/** Call only behind DeviceDO proof/grant/job-scope validation, never owner routes. */
export async function handleDeviceAgentRequest(kind:'inference'|'tool'|'event',payload:Record<string,unknown>,options:DeviceAgentHandlerOptions,signal:AbortSignal):Promise<Response> {
  if(kind==='event'){
    const event=payload.event as RuntimeEvent;
    if(!event||typeof event.type!=='string'||!event.data||typeof event.data!=='object')throw new Error('Invalid local agent event');
    await options.onEvent({...event,operationId:options.input.operationId});return Response.json({accepted:true});
  }
  if(kind==='tool'){
    const name=payload.name,operationId=payload.operationId,arguments_=payload.arguments;
    if(typeof name!=='string'||typeof operationId!=='string'||!/^pi-local-tool:[a-f0-9]{64}$/.test(operationId)||!arguments_||typeof arguments_!=='object'||Array.isArray(arguments_))throw new Error('Invalid local agent tool');
    const common={operationId,runOperationId:options.input.operationId,...(typeof payload.toolCallId==='string'?{toolCallId:payload.toolCallId}:{}),signal};
    const actionType=computerActions[name];
    const result=actionType?await options.tools.execute({...common,action:{...arguments_ as object,type:actionType} as Parameters<RuntimeTools['execute']>[0]['action']}):await options.tools.call?.({...common,name,arguments:arguments_ as Record<string,unknown>});
    if(!result)throw new Error('Local agent capability unavailable');return Response.json(result);
  }
  const context=payload.context as TranscriptContext;
  if(!context||!Array.isArray(context.messages))throw new Error('Invalid local inference context');
  const upstream=await options.inference(context,(payload.options??{}) as SimpleStreamOptions,signal),encoder=new TextEncoder();
  const body=new ReadableStream<Uint8Array>({async start(controller){try{for await(const event of upstream){signal.throwIfAborted();controller.enqueue(encoder.encode(JSON.stringify(event)+'\n'));}controller.close();}catch(error){controller.error(error);}},cancel(){}});
  return new Response(body,{headers:{'content-type':'application/x-ndjson','cache-control':'no-store'}});
}
