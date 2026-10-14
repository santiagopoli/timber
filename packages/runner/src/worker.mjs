import {homedir} from 'node:os';
import {join} from 'node:path';
import {Journal} from './journal.mjs';
import {Sessions} from './sessions.mjs';
import {Files} from './workspaces.mjs';
import {diagnostics} from './diagnostics.mjs';
import {RunnerError,publicError} from './errors.mjs';
import {runAgentJob} from './pi-runtime.mjs';
export function requiredPermission(job){if(job.type==='agent')return 'agent.run';const type=job.action?.type;return ['diagnostics','execPoll','execCancel'].includes(type)?'diagnostics':['readFile','listFiles'].includes(type)?'files.read':type==='writeFile'?'files.write':type==='exec'?'host.shell':null;}
export class Runner {
 constructor({stateDir,config,client,journal=new Journal(stateDir),agentRunner=runAgentJob}){
  this.stateDir=stateDir;this.config=config;this.client=client;this.journal=journal;this.agentRunner=agentRunner;this.sessions=new Sessions(journal);
  this.files=new Files(config.workspaces,{protectedRoots:[stateDir,join(homedir(),'Library','Keychains')]});this.active=new Map();this.device=undefined;this.stopped=false;this.flushing=undefined;
 }
 authorize(job){
  const required=requiredPermission(job),grant=this.device?.grants.find(item=>item.botId===job.botId&&item.epoch===job.grantEpoch&&item.workspaceIds.includes(job.workspaceId));
  if(job.deviceId!==this.config.deviceId||this.device?.status==='revoked'||!required||required!==job.permission||!this.config.permissions.includes(required)||!grant?.permissions.includes(required))throw new RunnerError('permission_denied','This job has no current matching bot, workspace and local permission grant.');
  this.files.root(job.workspaceId);
  if(['files.write','host.shell'].includes(required)) {
   if(job.approval?.authorized!==true||!['approved','automatic'].includes(job.approval.mode)||this.config.approvalMode!=='automatic'&&job.approval.mode!=='approved')throw new RunnerError('approval_required','This action has not received the required host and local approval.');
  }
  if(!job.claimToken)throw new RunnerError('invalid_claim','This job has no dispatch claim.');
 }
 async poll(){
  const page=await this.client.request(`/v1/device-connect/${this.config.deviceId}/jobs/poll`,{},{signal:this.runSignal});this.device=page.device;
  if(this.device.status==='revoked'){for(const item of this.active.values())this.journal.fenceEvents(item.job.id);for(const cancellation of page.cancellations??[])await this.cancel(cancellation);await this.stop();await this.sessions.reconcile();await this.flush();throw new RunnerError('device_revoked','Device access was revoked.');}
  for(const item of this.active.values())try{this.authorize(item.job);}catch{this.journal.fenceEvents(item.job.id);item.controller.abort();await this.sessions.cancelJob(item.job.id);}
  for(const job of page.jobs)this.journal.receive(job);
  for(const cancellation of page.cancellations??[])await this.cancel(cancellation);
  for(const row of this.journal.pending())if(row.job.deviceId===this.config.deviceId&&row.state==='accepted'&&!this.active.has(row.id))this.launch(row.job);
  await this.sessions.reconcile();void this.flush().catch(()=>{});
 }
 launch(job){
  const controller=new AbortController(),item={job,controller};this.active.set(job.id,item);
  const running=this.execute(job,controller.signal).catch(error=>{
   const row=this.journal.job(job.id);if(row?.state==='settled')return;
   if(error.code==='offline'&&row?.state==='accepted')return;
   const safe=publicError(error),aborted=controller.signal.aborted;
   this.journal.finish(job.id,job.type==='agent'?{agentResult:{status:'unanswered',reason:aborted?'aborted':safe.code,text:safe.message}}:{result:{operationId:job.operationId,status:aborted?(row?.state==='executing'?'interrupted':'cancelled'):'failed',error:aborted?'The owner cancelled this job. Inspect any recorded effects before requesting another action.':safe.message}});
  }).finally(()=>{this.active.delete(job.id);});
  item.done=running;
 }
 async execute(job,signal){
  this.authorize(job);await this.client.request(`/v1/device-connect/${job.deviceId}/jobs/${job.id}/start`,{claimToken:job.claimToken});
  this.authorize(job);signal.throwIfAborted();await this.files.safe(job.workspaceId,'.');this.journal.state(job.id,'executing');
  if(job.type==='agent'){
   const result=await this.agentRunner(job,{stateDir:join(this.stateDir,'agents'),workspace:this.files.root(job.workspaceId),workspaceId:job.workspaceId,signal,
    request:(path,body,options)=>this.client.request(path,{...body,claimToken:job.claimToken},options),
    emit:async event=>{this.journal.event(job.id,event);},
   });this.journal.finish(job.id,{agentResult:result});return;
  }
  const action=job.action;let result;
  if(action.type==='exec')result=await this.sessions.exec(job,this.files.root(job.workspaceId),action);
  else if(action.type==='execPoll')result=await this.sessions.poll(job,action);
  else if(action.type==='execCancel')result=await this.sessions.cancel(job,action);
  else if(action.type==='readFile')result={operationId:job.operationId,status:'completed',output:await this.files.read(job.workspaceId,action.path)};
  else if(action.type==='listFiles')result={operationId:job.operationId,status:'completed',output:await this.files.list(job.workspaceId,action.path)};
  else if(action.type==='writeFile')result={operationId:job.operationId,status:'completed',output:await this.files.write(job.workspaceId,action.path,action.content),workspaceChanged:true,checkpointStatus:'saved'};
  else if(action.type==='diagnostics')result={operationId:job.operationId,status:'completed',output:JSON.stringify(await diagnostics(action,this.files,job.workspaceId))};
  else throw new RunnerError('unsupported_action','This computer action is not available on the local runner.');
  this.journal.finish(job.id,{result});
 }
 async cancel({jobId,operationId}){
  const row=this.journal.job(jobId);if(!row||row.job.operationId!==operationId)return;
  this.journal.fenceEvents(jobId);
  const active=this.active.get(jobId);active?.controller.abort();await this.sessions.cancelJob(jobId);
  if(row.result?.result?.status==='running'){
   const result=this.sessions.receipt(operationId,row.result.result.processId);this.journal.finish(jobId,{result});
  }
  if(active)await active.done;
  else if(row.state!=='settled')this.journal.finish(jobId,row.job.type==='agent'?{agentResult:{status:'unanswered',reason:'aborted'}}:{result:{operationId,status:'cancelled',error:'The owner cancelled this local job.'}});
 }
 flush(){if(this.flushing)return this.flushing;const pending=this.flushOnce().finally(()=>{this.flushing=undefined;});this.flushing=pending;return pending;}
 async flushOnce(){
  const blocked=new Set();
  for(const item of this.journal.events()){
   if(blocked.has(item.job_id))continue;const job=this.journal.job(item.job_id)?.job;if(!job||job.deviceId!==this.config.deviceId)continue;
   this.journal.eventAttempted(item.job_id,item.sequence);
   try{await this.client.request(`/v1/device-connect/${job.deviceId}/jobs/${job.id}/agent/event`,{claimToken:job.claimToken,sequence:item.sequence,event:item.event},{timeoutMs:5000});this.journal.eventReported(item.job_id,item.sequence);}catch{blocked.add(item.job_id);}
  }
  for(const row of this.journal.outbox()){
   if(row.job.deviceId!==this.config.deviceId||this.journal.hasEvents(row.id))continue;
   try{await this.client.request(`/v1/device-connect/${row.job.deviceId}/jobs/${row.id}/result`,{claimToken:row.job.claimToken,...row.result},{timeoutMs:5000});this.journal.reported(row.id);}catch{/* Retry precisely this persisted receipt, never the effect. */}
  }
 }
 async run({signal,intervalMs=1000,onOffline=()=>{}}={}){
  this.journal.recover();this.runSignal=signal;let backoff=intervalMs,advertised=false;
  while(!this.stopped&&!signal?.aborted){
   try{if(!advertised){await this.client.request(`/v1/device-connect/${this.config.deviceId}/heartbeat`,{version:this.config.version??'0.1.0',workspaces:this.config.workspaces},{signal});advertised=true;}await this.poll();backoff=intervalMs;}catch(error){if(error.code==='device_revoked'){for(const item of this.active.values())this.journal.fenceEvents(item.job.id);for(const row of this.journal.outbox())if(row.job.deviceId===this.config.deviceId)this.journal.fenceEvents(row.id);await this.stop();await this.flush();throw error;}onOffline();backoff=Math.min(30000,Math.max(intervalMs,backoff*2));}
   await new Promise(resolve=>{const done=()=>{clearTimeout(timer);signal?.removeEventListener('abort',done);resolve();},timer=setTimeout(done,backoff);signal?.addEventListener('abort',done,{once:true});});
  }
  await this.stop();await this.sessions.reconcile();await this.flush();
 }
 async stop(){this.stopped=true;for(const item of this.active.values()){this.journal.fenceEvents(item.job.id);item.controller.abort();}await this.sessions.cancelAll();await Promise.all([...this.active.values()].map(item=>item.done));}
}
