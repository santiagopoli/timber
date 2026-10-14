import type {Bot,DeviceJob,ExecutionTarget,Message,Run} from '@botspace/contracts';
import type {AgentRuntime,RuntimeEvent,RuntimeTools} from '@botspace/runtime';
import {createDeviceRuntime,handleDeviceAgentRequest,type DeviceAgentRuntime} from '../../../packages/runtime/src/local';
import {deviceRequest} from './devices';
import {createDeviceInference} from './device-inference';
import {localMemoryTools,snapshotDeviceMemory} from './device-memory';
import {hostTools} from './host-tools';
import {ApiError,json} from './errors';
import {body,parseAction} from './validation';
import type {Env} from './env';
import {createBudget,parseRuntimeLimit} from '../../../packages/runtime/src/budget';

export interface DeviceBotHooks {
  bot():Bot; taskId():string|undefined;
  run(operationId:string):Run|undefined;
  stopped(runId:string):boolean;
  computerActive(job:DeviceJob):boolean;
  tools:RuntimeTools;
  project(event:RuntimeEvent):Promise<void>;
  authorize():Promise<Bot>;
}
/** The laptop schedules Pi; Timber owns identity, policies, model access and memory. */
export function createDeviceBotRuntime(env:Env,storage:DurableObjectStorage,base:AgentRuntime,hooks:DeviceBotHooks) {
  let inference:ReturnType<typeof createDeviceInference>|undefined;
  const modelTransport=()=>inference??=createDeviceInference(env,storage);
  const budget=createBudget(storage,{generation:parseRuntimeLimit(env.BOTSPACE_MAX_GENERATIONS,'BOTSPACE_MAX_GENERATIONS'),tool:parseRuntimeLimit(env.BOTSPACE_MAX_TOOL_CALLS,'BOTSPACE_MAX_TOOL_CALLS')});
  let runtime:DeviceAgentRuntime;
  runtime=createDeviceRuntime({base,storage,
    getTarget:async operationId=>hooks.run(operationId)?.executionTarget??hooks.bot().executionTarget,
    snapshot:async(text,input,target)=>{
      await hooks.authorize();
      const bot=hooks.bot(),run=hooks.run(input.operationId);
      if(!run||hooks.stopped(run.id))throw new ApiError(409,'run_cancelled','The run was stopped.');
      const modelSettings=input.modelSettings??{model:bot.model,reasoningEffort:bot.reasoningEffort,fast:bot.fast};
      await modelTransport().snapshot(input.operationId,modelSettings);
      if(input.images?.length)modelTransport().assertImages(input.operationId);
      const recent=storage.sql.exec<{data:string}>('SELECT data FROM messages ORDER BY rowid DESC LIMIT 64').toArray().reverse().map(row=>JSON.parse(row.data) as Message);
      let remaining=48_000;
      const context=recent.filter(message=>message.runId!==run.id&&['user','assistant','system'].includes(message.role)).reverse().flatMap(message=>{
        if(remaining<=0)return [];
        const text=message.text.slice(-Math.min(remaining,8000));remaining-=text.length;
        const source=message.runId?storage.sql.exec<{native_operation_id:string}>('SELECT native_operation_id FROM runs WHERE id=?',message.runId).toArray()[0]:undefined;
        return [{role:message.role as 'user'|'assistant'|'system',text,...(source?{operationId:source.native_operation_id}:{})}];
      }).reverse();
      const memory=await snapshotDeviceMemory(storage,bot.id);
      if(hooks.stopped(run.id))throw new ApiError(409,"run_cancelled","The run was stopped.");
      return {operationId:input.operationId,nativeOperationId:input.operationId,botId:bot.id,runId:run.id,
        ...(hooks.taskId()?{taskId:hooks.taskId()}:{}),text,modelSettings,context,images:input.images,
        sessionId:hooks.taskId()?`task:${hooks.taskId()}`:`bot:${bot.id}`,
        instructions:[bot.instructions,'Timber stores your durable memory. Use the memory tools to cite original conversation evidence. Machine permission grants never imply user intent. For substantial work on another permitted machine, use list_machines and create_task with its executionTarget. Never request account secrets in chat.',memory].filter(Boolean).join('\n\n'),
        tools:[...new Map([...hostTools,...localMemoryTools].map(tool=>[tool.name,tool])).values()].filter(tool=>!['publish_app','list_apps','github_clone','github_push','secure_worker_deploy_capabilities','secure_worker_deploy'].includes(tool.name)).map(tool=>({...tool,replay:'unsafe' as const})),
      };
    },
    port:{
      submit:async(target,input)=>{
        if(!input.runId||hooks.stopped(input.runId))throw new ApiError(409,"run_cancelled","The run was stopped.");
        const {job}=await deviceRequest<{job:DeviceJob}>(env,'/jobs',{deviceId:target.deviceId,workspaceId:target.workspaceId,botId:input.botId,scopeId:input.taskId??input.botId,taskId:input.taskId,nativeOperationId:input.operationId,operationId:input.operationId,type:'agent',agent:input,approval:{authorized:true,mode:'automatic'}},'agent');
        return {jobId:job.id};
      },
      operation:async(jobId,after=0)=>{
        const {job,events}=await deviceRequest<{job:DeviceJob;events:Array<{sequence:number;event:RuntimeEvent}>}>(env,`/jobs/${jobId}?after=${after}`);
        const page={eventCursor:events.at(-1)?.sequence??after,hasMoreEvents:events.length===100};
        const projected=events.map(({sequence,event})=>({...event,eventKey:`device:${jobId}:${sequence}`}));
        if(job.state==='completed')return {status:'done',...job.agentResult,events:projected,...page};
        if(['failed','cancelled','interrupted'].includes(job.state))return {status:'unanswered',reason:job.state==='cancelled'?'aborted':job.state,...job.agentResult,events:projected,...page};
        const {device}=await deviceRequest<{device:import('@botspace/contracts').Device}>(env,`/devices/${job.deviceId}`);
        return {status:job.state==='running'?'running':'queued',events:projected,...page,deviceOnline:device.online};
      },
      cancel:async jobId=>{const {job}=await deviceRequest<{job:DeviceJob}>(env,`/jobs/${jobId}/cancel`,{});return ['cancelled','completed','failed','interrupted'].includes(job.state);},
    },onEvent:event=>hooks.project(event),
  });
  async function fetch(request:Request):Promise<Response>{
    if(request.headers.get('x-timber-internal')!=='device-runtime'||request.method!=='POST')throw new ApiError(403,'internal_only','Machine callbacks are internal.');
    const {job:untrustedJob,payload:untrustedPayload}=await body(request,new URL(request.url).pathname.endsWith('/inference')?32_000_000:300_000),job=untrustedJob as DeviceJob,payload=untrustedPayload as Record<string,unknown>;
    if(new URL(request.url).pathname==='/device-runtime/check') {
      if(!job||job.botId!==hooks.bot().id||job.taskId!==hooks.taskId())return json({active:false});
      try {await hooks.authorize();
        if(job.type==='agent'){
          const run=hooks.run(job.operationId),target=run?.executionTarget;
          return json({active:Boolean(runtime.localInput(job.operationId)&&run&&!hooks.stopped(run.id)&&!['completed','failed','cancelled','interrupted'].includes(run.status)&&target?.kind==='device'&&target.deviceId===job.deviceId&&target.workspaceId===job.workspaceId)});
        }
        return json({active:hooks.computerActive(job)});
      }catch{return json({active:false});}
    }
    if(!job||job.botId!==hooks.bot().id||job.taskId!==hooks.taskId()||job.type!=='agent'||!payload||typeof payload!=='object')throw new ApiError(403,'device_scope_mismatch','Machine callback scope does not match.');
    const input=runtime.localInput(job.operationId),run=hooks.run(job.operationId);
    if(!input||!run||hooks.stopped(run.id))throw new ApiError(409,'device_job_inactive','The local run is no longer active.');
    const target=run.executionTarget;
    if(target?.kind!=='device'||target.deviceId!==job.deviceId||target.workspaceId!==job.workspaceId)throw new ApiError(403,'device_scope_mismatch','Machine execution target does not match.');
    const kind=new URL(request.url).pathname.split('/').pop();
    if(kind==='snapshot')return json({context:input.context,instructions:input.instructions,modelSettings:input.modelSettings});
    if(kind!=='event'&&['completed','failed','cancelled','interrupted'].includes(run.status))throw new ApiError(409,'device_job_inactive','The local run is no longer active.');
    if(!['event','tool','inference'].includes(kind??''))throw new ApiError(404,'not_found','Machine callback not found.');
    if(kind==='tool')budget(job.operationId,'tool',String(payload.operationId));
    if(kind==='inference'){
      const context=payload.context as {messages?:unknown[]};
      if(!context||!Array.isArray(context.messages)||context.messages.length>4096||payload.options!==undefined&&(!payload.options||typeof payload.options!=='object'||Array.isArray(payload.options)))throw new ApiError(400,'invalid_device_inference','Invalid local inference context.');
      budget(job.operationId,'generation',crypto.randomUUID());
    }
    if(kind==='event') {
      const event=payload.event as RuntimeEvent;
      if(event.type.startsWith('subagent.'))throw new ApiError(400,'device_subagent_unsupported','Use a persistent task for delegated machine work.');
      payload.event={...event,eventKey:`device:${job.id}:${payload.sequence}`};
    }
    return handleDeviceAgentRequest(kind as 'event'|'tool'|'inference',payload,{input,
      inference:(context,options,signal)=>modelTransport().stream(job.operationId,context,options,signal),
      tools:{...hooks.tools,execute:request=>hooks.tools.execute({...request,action:parseAction(request.action)})},
      onEvent:event=>runtime.ingestEvent(job.operationId,event),
    },request.signal);
  }
  return {runtime,fetch};
}
