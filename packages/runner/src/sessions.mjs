import {fork} from 'node:child_process';
import {mkdir,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {dirname,join} from 'node:path';
import {boundedOutput} from './journal.mjs';
import {RunnerError} from './errors.mjs';
export class Sessions {
 constructor(journal,{hostPath=new URL('./session-host.mjs',import.meta.url)}={}){this.journal=journal;this.hostPath=hostPath;this.live=new Map();this.receipts=join(dirname(journal.path),'process-receipts');}
 async exec(job,cwd,action){
  if(typeof action.command!=='string'||!action.command.trim()||Buffer.byteLength(action.command)>65536||action.timeoutMs!==undefined&&(!Number.isSafeInteger(action.timeoutMs)||action.timeoutMs<1)||action.yieldMs!==undefined&&(!Number.isInteger(action.yieldMs)||action.yieldMs<0||action.yieldMs>30000))throw new RunnerError('invalid_command','Invalid command, execution deadline or yield interval.');
  const id=`device-process:${job.id}`,existing=this.journal.process(id);if(existing){this.authorize(job,existing);return this.receipt(job.operationId,id);}
  await mkdir(this.receipts,{recursive:true,mode:0o700});
  this.journal.startProcess(id,job.id);let finish;const done=new Promise(resolve=>{finish=resolve;});
  const child=fork(this.hostPath,[],{stdio:['ignore','ignore','ignore','ipc']});const session={child,done,output:'',finish};this.live.set(id,session);
  child.on('message',message=>{
   if(message.type==='output'){session.output=boundedOutput(session.output+message.data);this.journal.output(id,session.output);}
   if(message.type==='failed'||message.type==='exited'){
    const state=message.cancelled?'cancelled':message.type==='failed'?'failed':message.code===0?'completed':'failed';this.journal.endProcess(id,state,message.code,message.cancelled);this.completeOriginal(id);this.live.delete(id);finish();
   }
  });
  child.once('error',()=>{this.journal.endProcess(id,'failed',null);this.completeOriginal(id);this.live.delete(id);finish();});
  child.once('exit',()=>{if(this.live.has(id)){this.journal.endProcess(id,'interrupted',null);this.completeOriginal(id);this.live.delete(id);finish();}});
  child.send({type:'start',command:action.command,cwd,timeoutMs:action.timeoutMs,processId:id,jobId:job.id,receiptPath:join(this.receipts,`${job.id}.json`)});
  await this.wait(session.done,action.yieldMs??1000);return this.receipt(job.operationId,id);
 }
 async wait(done,milliseconds){if(!Number.isInteger(milliseconds)||milliseconds<0||milliseconds>30000)throw new RunnerError('invalid_yield','yieldMs must be between 0 and 30000.');let timer;try{await Promise.race([done,new Promise(resolve=>{timer=setTimeout(resolve,milliseconds);})]);}finally{clearTimeout(timer);}}
 receipt(operationId,id){const row=this.journal.process(id);if(!row)return {operationId,processId:id,status:'interrupted',processKnown:false,error:'This execution session is unavailable; do not restart the command automatically.'};return {operationId,processId:id,status:row.state,processKnown:row.state!=='interrupted',output:row.output,...(row.exit_code!==null?{exitCode:row.exit_code}:{}),...(row.state==='interrupted'?{error:'The runner lost this process session. Inspect recorded output and effects before taking another action.'}:{})};}
 async poll(job,action){const row=this.journal.process(action.processId);if(row)this.authorize(job,row);const session=this.live.get(action.processId);if(session)await this.wait(session.done,action.yieldMs??0);return this.receipt(job.operationId,action.processId);}
 authorize(job,row){const original=this.journal.job(row.job_id)?.job;if(!original||original.botId!==job.botId||original.workspaceId!==job.workspaceId||(original.scopeId??original.taskId??original.botId)!==(job.scopeId??job.taskId??job.botId))throw new RunnerError('process_forbidden','This process belongs to another job scope.');}
 async cancel(job,action){const row=this.journal.process(action.processId);if(!row)return this.receipt(job.operationId,action.processId);this.authorize(job,row);const session=this.live.get(action.processId);if(session){session.child.send({type:'cancel'});await this.wait(session.done,5000);}return this.receipt(job.operationId,action.processId);}
 async cancelAll(){await Promise.all([...this.live.values()].map(async session=>{session.child.send({type:'cancel'});await this.wait(session.done,5000);}));}
 async cancelJob(jobId){for(const [id,session] of this.live)if(this.journal.process(id)?.job_id===jobId){session.child.send({type:'cancel'});await this.wait(session.done,5000);}}
 completeOriginal(id){const row=this.journal.process(id),original=row?this.journal.job(row.job_id):undefined;if(original?.result?.result?.status==='running')this.journal.finish(original.id,{result:this.receipt(original.job.operationId,id)});}
 async reconcile(){
  for(const row of this.journal.processesPending()){
   if(this.live.has(row.id))continue;
   try{const file=await open(join(this.receipts,`${row.job_id}.json`),constants.O_RDONLY|constants.O_NOFOLLOW);let receipt;try{const stat=await file.stat();if(!stat.isFile()||stat.size>131072||(stat.mode&0o077)!==0)continue;receipt=JSON.parse(await file.readFile('utf8'));}finally{await file.close();}
    if(receipt.processId!==row.id||receipt.jobId!==row.job_id||!['completed','failed','cancelled'].includes(receipt.status))continue;
    this.journal.output(row.id,receipt.output??'');this.journal.endProcess(row.id,receipt.status,receipt.exitCode,receipt.cancelled);
    const original=this.journal.job(row.job_id);if(original)this.journal.finish(row.job_id,{result:this.receipt(original.job.operationId,row.id)});
   }catch{/* Without an exact durable guardian receipt, the outcome remains unknown. */}
  }
 }
}
