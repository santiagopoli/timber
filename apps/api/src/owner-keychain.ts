import type {Bot,SecretMetadata,SecureInputRequest} from '@botspace/contracts';
import type {Env} from './env';
import {OwnerKeychain} from './keychain';
import {ApiError,json} from './errors';
import {body,object,string,operationId,UUID} from './validation';

/** Owner-owned values and permissions. Bots receive references and sanitized
 * results. Durable delivery receipts bridge the owner store and bot runtimes. */
export class OwnerKeychainCoordinator {
  readonly store:OwnerKeychain;
  constructor(private ctx:DurableObjectState,private env:Env,private rearm:()=>Promise<void>){
    this.store=new OwnerKeychain(ctx.storage,'owner',env.CHATGPT_CREDENTIAL_KEY,()=>{});
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS keychain_deliveries(request_id TEXT PRIMARY KEY,data TEXT NOT NULL,next_at INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0)');
  }
  private bot(id:string):Bot {
    const row=this.ctx.storage.sql.exec<{data:string}>('SELECT data FROM bots WHERE id=?',id).toArray()[0];
    if(!row)throw new ApiError(404,'not_found','Bot not found.');return JSON.parse(row.data);
  }
  private async botRequest(botId:string,path:string,input:unknown,taskId?:string):Promise<Response>{
    const bot=this.bot(botId);
    if(taskId)this.assertTask(botId,taskId);
    return this.env.BOT.get(this.env.BOT.idFromName(taskId?`owner:task:${taskId}`:`owner:${botId}`)).fetch(`https://bot/_keychain/${path}`,{method:'POST',headers:{'content-type':'application/json','x-botspace-config':encodeURIComponent(JSON.stringify(bot)),...(taskId?{'x-timber-task-id':taskId}:{})},body:JSON.stringify(input)});
  }
  private assertTask(botId:string,taskId:string):{status:string} {
    if(!UUID.test(taskId))throw new ApiError(400,'invalid_request','Invalid task identity.');
    const row=this.ctx.storage.sql.exec<{data:string}>('SELECT data FROM tasks WHERE id=?',taskId).toArray()[0];
    if(!row||JSON.parse(row.data).botId!==botId)throw new ApiError(403,'task_mismatch','This task belongs to another bot.');
    return JSON.parse(row.data);
  }
  private async assertRun(request:SecureInputRequest):Promise<void>{
    if(request.taskId&&request.botId&&['completed','failed','cancelled','cancelling'].includes(this.assertTask(request.botId,request.taskId).status))throw new ApiError(409,'secure_input_inactive','The task is no longer active.');
    if(!request.botId)throw new ApiError(409,'secure_input_inactive','Request has no bot.');
    const response=await this.botRequest(request.botId,'check',{runId:request.runId,nativeOperationId:request.nativeOperationId},request.taskId);
    await response.text();
    if(!response.ok)throw new ApiError(409,'secure_input_inactive','The task is no longer active.');
  }
  nextAlarm():number|undefined{return this.ctx.storage.sql.exec<{next_at:number}>('SELECT next_at FROM keychain_deliveries ORDER BY next_at LIMIT 1').toArray()[0]?.next_at;}
  async alarm():Promise<void>{for(const row of this.ctx.storage.sql.exec<{request_id:string}>('SELECT request_id FROM keychain_deliveries WHERE next_at<=? LIMIT 8',Date.now()).toArray())await this.deliver(row.request_id);}
  forgetBot(botId:string){this.store.forgetBot(botId);this.ctx.storage.sql.exec("DELETE FROM keychain_deliveries WHERE json_extract(data,'$.request.botId')=?",botId);}
  private async deliver(id:string):Promise<void>{
    const row=this.ctx.storage.sql.exec<{data:string;attempts:number}>('SELECT data,attempts FROM keychain_deliveries WHERE request_id=?',id).toArray()[0];if(!row)return;
    const input=JSON.parse(row.data) as {request:SecureInputRequest;entries:SecretMetadata[]};
    try{
      this.bot(input.request.botId!);
      if(input.request.taskId&&['completed','failed','cancelled','cancelling'].includes(this.assertTask(input.request.botId!,input.request.taskId).status)){this.ctx.storage.sql.exec('DELETE FROM keychain_deliveries WHERE request_id=?',id);return;}
      const response=await this.botRequest(input.request.botId!,'resume',input,input.request.taskId);
      await response.text();
      if(!response.ok)throw new Error('Delivery unavailable');
      this.ctx.storage.sql.exec('DELETE FROM keychain_deliveries WHERE request_id=?',id);
    }catch{
      if(!this.ctx.storage.sql.exec('SELECT id FROM bots WHERE id=?',input.request.botId!).toArray().length){this.ctx.storage.sql.exec('DELETE FROM keychain_deliveries WHERE request_id=?',id);return;}
      const attempts=row.attempts+1;this.ctx.storage.sql.exec('UPDATE keychain_deliveries SET attempts=?,next_at=? WHERE request_id=?',attempts,Date.now()+Math.min(60_000,1000*2**Math.min(attempts,6)),id);
    }finally{await this.rearm();}
  }
  private commitRequest(id:string,entries:SecretMetadata[],replay:boolean):void {
    const request=this.store.request(id);if(!request)throw new ApiError(404,'not_found','Secure input request not found.');
    this.bot(request.botId!);
    if(replay)return;
    if(request.taskId&&['completed','failed','cancelled','cancelling'].includes(this.assertTask(request.botId!,request.taskId).status))throw new ApiError(409,'secure_input_inactive','The task is no longer active.');
    if(request.status!=='pending')throw new ApiError(409,'secure_input_inactive','The request is no longer pending.');
    request.status='saved';this.store.setRequest(request);
    this.ctx.storage.sql.exec('INSERT INTO keychain_deliveries(request_id,data,next_at) VALUES(?,?,?)',id,JSON.stringify({request,entries}),Date.now());
  }
  async tool(input:Record<string,unknown>,signal:AbortSignal):Promise<Response>{
    const botId=string(input.botId,'botId',36);this.bot(botId);
    const name=string(input.name,'name',40),args=object(input.arguments??{}),op=string(input.operationId,'operationId',200);
    const taskId=input.taskId===undefined?undefined:string(input.taskId,'taskId',36);if(taskId)this.assertTask(botId,taskId);
    const runId=string(input.runId,'runId',36),nativeOperationId=string(input.nativeOperationId,'nativeOperationId',128);
    if(name==='cancel'){
      for(const request of this.store.requests())if(request.botId===botId&&request.taskId===taskId&&request.runId===runId&&request.status==='pending'){request.status='cancelled';this.store.setRequest(request);}
      return json({cancelled:true});
    }
    await this.assertRun({botId,...(taskId?{taskId}:{}),runId,nativeOperationId} as SecureInputRequest);
    if(name==='list_secrets')return json({secrets:await this.store.permitted(botId)});
    if(name==='name_secret'){
      const entry=await this.store.rename(op,string(args.secretId,'secretId',36),args,async()=>{await this.assertRun({botId,...(taskId?{taskId}:{}),runId,nativeOperationId} as SecureInputRequest);signal.throwIfAborted();},botId);
      return json({secret:entry});
    }
    if(name==='request_secret'||name==='configure_secret'){
      if(name==='configure_secret')await this.store.requireAccess(string(args.secretId,'secretId',36),botId);
      return json({request:this.store.requestInput(`${taskId?`task:${taskId}:`:""}${botId}:${op}`,args,runId,nativeOperationId,botId,taskId)});
    }
    if(name==='secret_request'){
      const result=await this.store.call(`${botId}:${op}`,args,signal,async()=>{this.bot(botId);await this.assertRun({botId,...(taskId?{taskId}:{}),runId,nativeOperationId} as SecureInputRequest);},botId);
      return json({...result,operationId:op});
    }
    throw new ApiError(404,'not_found','Tool not found.');
  }
  async fetch(request:Request):Promise<Response>{
    const path=new URL(request.url).pathname,botId=request.headers.get('x-keychain-bot')??undefined,taskId=request.headers.get('x-keychain-task')??undefined;
    if(taskId){if(!botId)throw new ApiError(403,'task_mismatch','Missing assigned bot.');this.assertTask(botId,taskId);}
    if(botId)this.bot(botId);
    if(path==='/keychain'&&request.method==='GET')return json({entries:this.store.list(),requests:this.store.requests().filter(item=>!botId||item.botId===botId&&item.taskId===taskId)});
    if(path==='/keychain'&&request.method==='POST'){
      let input=await body(request);if(Object.keys(input).some(key=>!['entries','operationId','requestId'].includes(key)))throw new ApiError(400,'invalid_secure_input','Unsupported input fields.');
      const requestId=input.requestId;let pending:SecureInputRequest|undefined;
      if(requestId!==undefined){
        if(typeof requestId!=='string'||!UUID.test(requestId))throw new ApiError(400,'invalid_secure_input','Invalid secure request.');
        pending=this.store.request(requestId);
        if(!pending||pending.secretId||botId&&(pending.botId!==botId||pending.taskId!==taskId))throw new ApiError(400,'invalid_secure_input','Invalid secure request.');
        if(pending.status==='pending')await this.assertRun(pending);
        if(!Array.isArray(input.entries)||input.entries.length!==1)throw new ApiError(400,'invalid_secure_input','One input is required.');
        const item=object(input.entries[0]);if(item.id!==undefined)throw new ApiError(400,'invalid_secure_input','A new input is required.');
        input={...input,entries:[{value:item.value,name:pending.name,origin:pending.origin,header:pending.header,prefix:pending.prefix}]};
      }
      const entries=await this.store.save(input,(saved,replay)=>{if(botId)this.bot(botId);if(typeof requestId==='string')this.commitRequest(requestId,saved,replay);},pending?.botId??botId);
      if(typeof requestId==='string'){await this.rearm();await this.deliver(requestId);}
      return json({entries:this.store.list().filter(entry=>entries.some(saved=>saved.id===entry.id))});
    }
    const authorization=/^\/keychain\/requests\/([^/]+)\/authorize$/.exec(path);
    if(authorization&&request.method==='POST'){
      const pending=this.store.request(authorization[1]);if(!pending?.secretId||botId&&(pending.botId!==botId||pending.taskId!==taskId))throw new ApiError(404,'not_found','Request not found.');
      if(pending.status!=='saved'){await this.assertRun(pending);await this.store.authorize(pending,(entries,replay)=>this.commitRequest(pending.id,entries,replay));}
      await this.rearm();await this.deliver(pending.id);return json({entries:this.store.list().filter(entry=>entry.id===pending.secretId)});
    }
    const permission=/^\/keychain\/([^/]+)\/permissions$/.exec(path);
    if(permission&&request.method==='POST'){
      const input=await body(request),target=string(input.botId,'botId',36);this.bot(target);if(typeof input.allowed!=='boolean')throw new ApiError(400,'invalid_secure_input','Choose whether this bot has access.');
      await this.store.grantAccess(permission[1],target,input.allowed,()=>{this.bot(target);});return json({entries:this.store.list()});
    }
    const secret=/^\/keychain\/([^/]+)$/.exec(path);
    if(secret&&request.method==='PATCH'){
      const input=await body(request);if(Object.keys(input).some(key=>!['name','expectedRevision','operationId'].includes(key)))throw new ApiError(400,'invalid_secure_input','Only the name can be changed here.');
      const entry=await this.store.rename(operationId(input.operationId),secret[1],input,()=>{if(botId)this.bot(botId);});
      return json({entries:this.store.list().filter(item=>item.id===entry.id)});
    }
    if(secret&&request.method==='DELETE'){this.store.revoke(secret[1]);return json({revoked:true});}
    throw new ApiError(404,'not_found','Keychain endpoint not found.');
  }
}
