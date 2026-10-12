import type {Bot,SecretMetadata,SecureInputRequest} from '@botspace/contracts';
import {SecureDeployCoordinator,createCloudComputerProvider,type SecureDeployHost,type SecureDeployAuthorization,type DeployRequest,type DeployRecord} from '@botspace/computer';
import type {SecureWorkerDeployEnvelope} from './keychain';
import type {Env} from './env';
import {OwnerKeychain} from './keychain';
import {ApiError,json} from './errors';
import {body,object,string,operationId,UUID} from './validation';

/** Owner-owned values and permissions. Bots receive references and sanitized
 * results. Durable delivery receipts bridge the owner store and bot runtimes. */
export class OwnerKeychainCoordinator {
  readonly store:OwnerKeychain;
  private readonly activeDeploys=new Map<string,string>();
  constructor(private ctx:DurableObjectState,private env:Env,private rearm:()=>Promise<void>){
    this.store=new OwnerKeychain(ctx.storage,'owner',env.CHATGPT_CREDENTIAL_KEY,()=>{});
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS keychain_deliveries(request_id TEXT PRIMARY KEY,data TEXT NOT NULL,next_at INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS secure_worker_deploy_plans(id TEXT PRIMARY KEY,bot_id TEXT NOT NULL,revision INTEGER NOT NULL,data TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1); CREATE TABLE IF NOT EXISTS secure_worker_deploy_plan_ops(operation_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,plan_id TEXT NOT NULL); CREATE TABLE IF NOT EXISTS secure_worker_deployments(bot_id TEXT NOT NULL,operation_id TEXT NOT NULL,fingerprint TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(bot_id,operation_id))');
    ctx.storage.sql.exec("UPDATE secure_worker_deployments SET data=json_set(data,'$.state','uncertain','$.errorCode','deploy_outcome_unknown') WHERE json_extract(data,'$.state') IN ('reserved','admitting','building','dispatching')");
  }
  private bot(id:string):Bot {
    const row=this.ctx.storage.sql.exec<{data:string}>('SELECT data FROM bots WHERE id=?',id).toArray()[0];
    if(!row)throw new ApiError(404,'not_found','Bot not found.');return JSON.parse(row.data);
  }
  private async botRequest(botId:string,path:string,input:unknown):Promise<Response>{
    const bot=this.bot(botId);
    return this.env.BOT.get(this.env.BOT.idFromName(`owner:${botId}`)).fetch(`https://bot/_keychain/${path}`,{method:'POST',headers:{'content-type':'application/json','x-botspace-config':encodeURIComponent(JSON.stringify(bot))},body:JSON.stringify(input)});
  }
  private async assertRun(request:SecureInputRequest):Promise<void>{
    if(!request.botId)throw new ApiError(409,'secure_input_inactive','Request has no bot.');
    const response=await this.botRequest(request.botId,'check',{runId:request.runId,nativeOperationId:request.nativeOperationId});
    await response.text();
    if(!response.ok)throw new ApiError(409,'secure_input_inactive','The task is no longer active.');
  }
  async verifySecureDeploy(request:Request):Promise<Response>{
    if(request.headers.get('x-timber-internal')!=='computer')throw new ApiError(403,'internal_only','Secure deploy authority is internal.');
    if(request.method!=='POST')throw new ApiError(405,'method_not_allowed','Method not allowed.');
    const input=await body(request);const envelope=input.authorization as SecureWorkerDeployEnvelope;
    if(Object.keys(input).some(key=>key!=='authorization')||!envelope)throw new ApiError(400,'deploy_invalid_request','Invalid deploy authority request.');
    await this.store.assertSecureDeployEnvelopeCurrent(envelope);
    const planRow=()=>this.ctx.storage.sql.exec<{revision:number;data:string;active:number;bot_id:string}>('SELECT revision,data,active,bot_id FROM secure_worker_deploy_plans WHERE id=?',envelope.planId).toArray()[0];
    const checkPlan=()=>{this.bot(envelope.botId);const saved=planRow();if(!saved?.active||saved.bot_id!==envelope.botId||saved.revision!==envelope.planRevision)throw new ApiError(409,'deploy_authorization_changed','Deploy plan changed or was revoked.');const plan=JSON.parse(saved.data) as {id:string;revision:number;pin:DeployRequest['pin'];refs:Array<{id:string;revision:number}>};const keys=['repository','commit','artifactDigest','artifactPath','accountId','workerName','destination'];if(envelope.pin.planId!==envelope.planId||envelope.pin.planRevision!==envelope.planRevision||keys.some(key=>envelope.pin[key as keyof typeof envelope.pin]!==plan.pin[key as keyof typeof plan.pin])||JSON.stringify(envelope.refs.map(r=>({id:r.id,revision:r.revision})))!==JSON.stringify(plan.refs))throw new ApiError(409,'deploy_authorization_changed','Deploy plan binding changed.');return saved.data;};
    const initialPlan=checkPlan();await this.store.assertSecureDeployEnvelopeCurrent(envelope);const finalReferenceGuard=await this.store.deployReferenceFence(envelope.refs,envelope.botId);checkPlan();
    await this.assertRun({botId:envelope.botId,runId:envelope.runId,nativeOperationId:envelope.nativeOperationId} as SecureInputRequest);
    if(envelope.expiresAt<=Date.now()||checkPlan()!==initialPlan)throw new ApiError(409,'deploy_authorization_changed','Deploy plan changed or authorization expired.');finalReferenceGuard();return json({authorized:true});
  }
  nextAlarm():number|undefined{return this.ctx.storage.sql.exec<{next_at:number}>('SELECT next_at FROM keychain_deliveries ORDER BY next_at LIMIT 1').toArray()[0]?.next_at;}
  async alarm():Promise<void>{for(const row of this.ctx.storage.sql.exec<{request_id:string}>('SELECT request_id FROM keychain_deliveries WHERE next_at<=? LIMIT 8',Date.now()).toArray())await this.deliver(row.request_id);}
  forgetBot(botId:string){this.store.forgetBot(botId);this.ctx.storage.sql.exec("DELETE FROM keychain_deliveries WHERE json_extract(data,'$.request.botId')=?",botId);}
  private async deliver(id:string):Promise<void>{
    const row=this.ctx.storage.sql.exec<{data:string;attempts:number}>('SELECT data,attempts FROM keychain_deliveries WHERE request_id=?',id).toArray()[0];if(!row)return;
    const input=JSON.parse(row.data) as {request:SecureInputRequest;entries:SecretMetadata[]};
    try{
      this.bot(input.request.botId!);
      const response=await this.botRequest(input.request.botId!,'resume',input);
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
    if(request.status!=='pending')throw new ApiError(409,'secure_input_inactive','The request is no longer pending.');
    request.status='saved';this.store.setRequest(request);
    this.ctx.storage.sql.exec('INSERT INTO keychain_deliveries(request_id,data,next_at) VALUES(?,?,?)',id,JSON.stringify({request,entries}),Date.now());
  }
  async tool(input:Record<string,unknown>,signal:AbortSignal):Promise<Response>{
    const botId=string(input.botId,'botId',36);this.bot(botId);
    const name=string(input.name,'name',40),args=object(input.arguments??{}),op=string(input.operationId,'operationId',200);
    const runId=string(input.runId,'runId',36),nativeOperationId=string(input.nativeOperationId,'nativeOperationId',128);
    if(name==='cancel'){
      for(const request of this.store.requests())if(request.botId===botId&&request.runId===runId&&request.status==='pending'){request.status='cancelled';this.store.setRequest(request);}
      return json({cancelled:true});
    }
    await this.assertRun({botId,runId,nativeOperationId} as SecureInputRequest);
    if(name==='list_secrets')return json({secrets:await this.store.permitted(botId)});
    if(name==='name_secret'){
      const entry=await this.store.rename(op,string(args.secretId,'secretId',36),args,async()=>{await this.assertRun({botId,runId,nativeOperationId} as SecureInputRequest);signal.throwIfAborted();},botId);
      return json({secret:entry});
    }
    if(name==='request_secret'||name==='configure_secret'){
      if(name==='configure_secret')await this.store.requireAccess(string(args.secretId,'secretId',36),botId);
      return json({request:this.store.requestInput(`${botId}:${op}`,args,runId,nativeOperationId,botId)});
    }
    if(name==='secure_worker_deploy_capabilities'){
      if(Object.keys(args).length)throw new ApiError(400,'deploy_invalid_request','Capability probes do not accept arguments.');
      return await this.secureWorkerDeployCapabilities(botId,runId,nativeOperationId,signal);
    }
    if(name==='secure_worker_deploy'){
      if(signal.aborted)throw new ApiError(409,'run_inactive','The task is no longer active.');
      return await this.secureWorkerDeploy(botId,runId,nativeOperationId,op,args,signal);
    }
    if(name==='secret_request'){
      const result=await this.store.call(`${botId}:${op}`,args,signal,async()=>{this.bot(botId);await this.assertRun({botId,runId,nativeOperationId} as SecureInputRequest);},botId);
      return json({...result,operationId:op});
    }
    throw new ApiError(404,'not_found','Tool not found.');
  }
  private planInput(input:Record<string,unknown>):{botId:string;pin:DeployRequest['pin'];refs:Array<{id:string;revision:number}>}{
    const exact=(v:Record<string,unknown>,keys:string[])=>{if(Object.keys(v).some(k=>!keys.includes(k)))throw new ApiError(400,'deploy_invalid_request','Unsupported deploy plan fields.');};
    exact(input,['operationId','botId','repository','commit','artifactDigest','artifactPath','accountId','workerName','refs']);
    const botId=string(input.botId,'botId',36);this.bot(botId);
    const repository=string(input.repository,'repository',202),parts=repository.split('/');if(parts.length!==2||parts.some(x=>!/^[A-Za-z0-9_.-]{1,100}$/.test(x)||x==='.'||x==='..'||x.includes('..')))throw new ApiError(400,'deploy_invalid_pin','Repository must be owner/name without dot path components.');
    const commit=string(input.commit,'commit',64),artifactDigest=string(input.artifactDigest,'artifactDigest',71),artifactPath=string(input.artifactPath,'artifactPath',512),accountId=string(input.accountId,'accountId',32),workerName=string(input.workerName,'workerName',63);
    if(!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)||!/^([A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/.test(artifactPath)||artifactPath.startsWith('.')||artifactPath.split('/').some(x=>!x||x==='.'||x==='..')||!/^sha256:[a-f0-9]{64}$/.test(artifactDigest)||!/^[a-f0-9]{32}$/.test(accountId)||!/^[a-z0-9][a-z0-9-]{0,62}$/.test(workerName))throw new ApiError(400,'deploy_invalid_pin','Invalid immutable deploy pin.');
    if(!Array.isArray(input.refs)||input.refs.length<1||input.refs.length>4)throw new ApiError(400,'deploy_invalid_request','Select one to four Cloudflare references.');
    const refs=input.refs.map(v=>{const r=object(v);exact(r,['id','revision']);if(typeof r.id!=='string'||!UUID.test(r.id)||!Number.isSafeInteger(r.revision)||Number(r.revision)<1)throw new ApiError(400,'deploy_invalid_request','Invalid reference.');return{id:r.id,revision:Number(r.revision)}});if(new Set(refs.map(r=>r.id)).size!==refs.length)throw new ApiError(400,'deploy_invalid_request','References must be distinct.');
    const pin={repository,commit,artifactDigest:artifactDigest as `sha256:${string}`,artifactPath,accountId,workerName,destination:`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${workerName}`};return{botId,pin,refs};
  }
  private cloudCredential(entry:SecretMetadata):boolean{return entry.origin==='https://api.cloudflare.com'&&((entry.header.toLowerCase()==='authorization'&&entry.prefix==='Bearer ')||(['x-auth-key','x-auth-email'].includes(entry.header.toLowerCase())&&entry.prefix===''));}
  private async createDeployPlan(input:Record<string,unknown>):Promise<Response>{
    const op=string(input.operationId,'operationId',128);if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(op))throw new ApiError(400,'deploy_invalid_request','Invalid operation ID.');const {botId,pin,refs}=this.planInput(input);const entries=[] as SecretMetadata[];for(const r of refs){const entry=this.store.list().find(x=>x.id===r.id);if(!entry||entry.revision!==r.revision||!this.cloudCredential(entry))throw new ApiError(409,'credential_changed','A Cloudflare reference is missing, stale or out of scope.');await this.store.requireAccess(r.id,botId);entries.push(entry);}const headers=entries.map(x=>x.header.toLowerCase());const valid=(headers.length===1&&headers[0]==='authorization'&&entries[0].prefix==='Bearer ')||(headers.length===2&&headers.includes('x-auth-key')&&headers.includes('x-auth-email')&&entries.every(x=>x.prefix===''));if(!valid)throw new ApiError(400,'secure_deploy_credential_scope','Use one Cloudflare bearer token or the legacy key and email pair.');if(headers.length===2)refs.sort((a,b)=>entries.find(x=>x.id===a.id)!.header.toLowerCase()==='x-auth-key'?-1:1);const guard=await this.store.deployReferenceFence(refs,botId);const fingerprint=await this.store.fingerprint(['timber.secure-deploy-plan.v1',botId,pin,refs]);guard();this.bot(botId);const existing=this.ctx.storage.sql.exec<{fingerprint:string;plan_id:string}>('SELECT fingerprint,plan_id FROM secure_worker_deploy_plan_ops WHERE operation_id=?',op).toArray()[0];if(existing){if(existing.fingerprint!==fingerprint)throw new ApiError(409,'deploy_plan_operation_conflict','operationId was already used for different plan details.');const p=this.ctx.storage.sql.exec<{data:string}>('SELECT data FROM secure_worker_deploy_plans WHERE id=?',existing.plan_id).toArray()[0];return json({plan:JSON.parse(p.data)});}
    const id=crypto.randomUUID(),plan={id,revision:1,botId,pin,refs,createdAt:new Date().toISOString()};this.ctx.storage.sql.exec("INSERT INTO secure_worker_deploy_plans(id,bot_id,revision,data,active) VALUES(?,?,1,?,1)",id,botId,JSON.stringify(plan));this.ctx.storage.sql.exec('INSERT INTO secure_worker_deploy_plan_ops(operation_id,fingerprint,plan_id) VALUES(?,?,?)',op,fingerprint,id);return json({plan},201);
  }
  private async secureWorkerDeployCapabilities(botId:string,runId:string,nativeOperationId:string,signal:AbortSignal):Promise<Response>{
    const current=()=>{this.bot(botId);signal.throwIfAborted();};
    current();await this.assertRun({botId,runId,nativeOperationId} as SecureInputRequest);current();
    const provider=createCloudComputerProvider(this.env.COMPUTER);
    if(!provider.secureDeployCapabilities)throw new ApiError(503,'secure_deploy_host_unavailable','Computer deploy capability is unavailable.');
    const capability=await provider.secureDeployCapabilities(botId,signal);
    current();await this.assertRun({botId,runId,nativeOperationId} as SecureInputRequest);current();
    // Deliberately return a metadata allowlist only; this path never loads keychain entries.
    return json({capability:{
      secureDeploy:capability.secureDeploy===true,
      isolationVersion:typeof capability.isolationVersion==='string'?capability.isolationVersion:undefined,
      privateCredentialChannel:capability.privateCredentialChannel===true,
      noShellEnv:capability.noShellEnv===true,
      noBuildCredentialInheritance:capability.noBuildCredentialInheritance===true,
      outputRedaction:capability.outputRedaction===true,
      canaryVersion:typeof capability.canaryVersion==='string'?capability.canaryVersion:undefined
    }});
  }

  private async secureWorkerDeploy(botId:string,runId:string,nativeOperationId:string,operationId:string,args:Record<string,unknown>,signal:AbortSignal):Promise<Response>{
    if(Object.keys(args).some(k=>!['planId','expectedRevision'].includes(k))||typeof args.planId!=='string'||!UUID.test(args.planId)||!Number.isSafeInteger(args.expectedRevision)||Number(args.expectedRevision)<1)throw new ApiError(400,'deploy_invalid_request','Select an owner-created deploy plan and current revision.');
    const row=this.ctx.storage.sql.exec<{revision:number;data:string;active:number;bot_id:string}>("SELECT revision,data,active,bot_id FROM secure_worker_deploy_plans WHERE id=?",args.planId).toArray()[0];if(!row||!row.active||row.bot_id!==botId)throw new ApiError(404,'deploy_plan_unavailable','Deploy plan is unavailable.');if(row.revision!==args.expectedRevision)throw new ApiError(409,'deploy_plan_changed','Deploy plan revision is stale.');
    const plan=JSON.parse(row.data) as {id:string;revision:number;botId:string;pin:DeployRequest['pin'];refs:Array<{id:string;revision:number}>};
    const request:DeployRequest=Object.freeze({operationId,ownerId:'owner',botId,runId,expectedRevision:plan.revision,refs:Object.freeze(plan.refs.map(r=>Object.freeze({...r}))),pin:Object.freeze({...plan.pin,planId:plan.id,planRevision:plan.revision})});
    const key=`${botId}:${operationId}`;
    if(this.activeDeploys.has(key))throw new ApiError(409,'secure_deploy_pending','This operation is already being admitted.');
    if(this.activeDeploys.size>=8||[...this.activeDeploys.values()].filter(x=>x===botId).length>=4)throw new ApiError(429,'secure_deploy_queue_full','Secure deploy admission is full.');
    this.activeDeploys.set(key,botId);
    try {
      const expiry=Date.now()+10*60_000;
      const planFence=()=>{
        this.bot(botId);signal.throwIfAborted();
        const latest=this.ctx.storage.sql.exec<{revision:number;active:number;data:string}>('SELECT revision,active,data FROM secure_worker_deploy_plans WHERE id=?',plan.id).toArray()[0];
        if(!latest?.active||latest.revision!==plan.revision||latest.data!==row.data)throw new ApiError(409,'deploy_authorization_changed','Deploy plan changed or was revoked.');
      };
      const authority={
        assertCurrent:async(current:DeployRequest)=>{
          planFence();await this.assertRun({botId,runId,nativeOperationId} as SecureInputRequest);planFence();
          const guard=await this.store.deployReferenceFence(current.refs,botId);planFence();guard();
        },
        withAuthorization:async<T>(current:DeployRequest,dispatch:(authorization:SecureDeployAuthorization,credentials:readonly {refId:string;revision:number;header:string;prefix:string;value:string}[],beforeDispatch:()=>void)=>Promise<T>):Promise<T>=>{
          planFence();await this.assertRun({botId,runId,nativeOperationId} as SecureInputRequest);planFence();
          const authorization=await this.store.secureWorkerDeployEnvelope({ownerId:'owner',botId,runId,operationId,nativeOperationId,pin:current.pin,planId:plan.id,planRevision:plan.revision,expiresAt:Math.min(Date.now()+55_000,expiry),refs:current.refs});
          const refGuard=await this.store.deployReferenceFence(current.refs,botId);planFence();refGuard();
          return this.store.withSecureWorkerDeployCredentials(authorization,async credentials=>{
            await this.assertRun({botId,runId,nativeOperationId} as SecureInputRequest);
            const lastGuard=await this.store.deployReferenceFence(current.refs,botId);planFence();lastGuard();signal.throwIfAborted();
            const result=await dispatch(authorization,credentials,()=>{planFence();lastGuard();signal.throwIfAborted();});
            planFence();await this.assertRun({botId,runId,nativeOperationId} as SecureInputRequest);planFence();
            lastGuard();
            return result;
          });
        }
      };
      const provider=createCloudComputerProvider(this.env.COMPUTER);
      if(!provider.secureDeploy||!provider.secureDeployCapabilities)throw new ApiError(503,'secure_deploy_host_unavailable','Computer deploy provider is unavailable.');
      const host:SecureDeployHost={capabilities:()=>provider.secureDeployCapabilities!(botId),dispatchTrusted:x=>provider.secureDeploy!(botId,x as Parameters<NonNullable<typeof provider.secureDeploy>>[1]),cancel:id=>provider.secureDeployCancel!(botId,id)};
      const journal={
        get:async(id:string)=>{const saved=this.ctx.storage.sql.exec<{data:string}>('SELECT data FROM secure_worker_deployments WHERE bot_id=? AND operation_id=?',botId,id).toArray()[0];return saved?JSON.parse(saved.data) as DeployRecord:undefined},
        reserve:async(id:string,fp:string)=>{
          const previous=this.ctx.storage.sql.exec<{fingerprint:string}>('SELECT fingerprint FROM secure_worker_deployments WHERE bot_id=? AND operation_id=?',botId,id).toArray()[0];
          if(previous)return previous.fingerprint===fp?'same' as const:'conflict' as const;
          const count=this.ctx.storage.sql.exec<{n:number}>("SELECT COUNT(*) AS n FROM secure_worker_deployments WHERE json_extract(data,'$.state') IN ('admitting','dispatching')").one().n;
          if(count>=8)throw new ApiError(429,'deploy_admission_full','Secure deploy admission is full.');
          this.ctx.storage.sql.exec('INSERT INTO secure_worker_deployments(bot_id,operation_id,fingerprint,data) VALUES(?,?,?,?)',botId,id,fp,JSON.stringify({operationId:id,fingerprint:fp,state:'admitting',pin:request.pin}));
          return 'reserved' as const;
        },
        put:async(receipt:DeployRecord)=>{this.ctx.storage.sql.exec('UPDATE secure_worker_deployments SET data=? WHERE bot_id=? AND operation_id=? AND fingerprint=?',JSON.stringify(receipt),botId,receipt.operationId,receipt.fingerprint)}
      };
      const result=await new SecureDeployCoordinator(host,authority,journal,1,value=>this.store.fingerprint(value)).deploy(request,signal);
      const status=result.state==='completed'?'completed':result.state==='cancelled'?'cancelled':result.state==='uncertain'?'interrupted':'failed';
      return json({operationId,status,...(status==='completed'?{}:{error:status==='interrupted'?'The deploy outcome is unknown. No automatic retry was attempted.':result.errorCode==='secure_deploy_host_unsupported'?'This Computer does not report a ready isolated deploy runner. No credential was sent.':'The secure deploy did not complete.'})});
    } finally {this.activeDeploys.delete(key)}
  }

  async fetch(request:Request):Promise<Response>{
    const path=new URL(request.url).pathname,botId=request.headers.get('x-keychain-bot')??undefined;
    if(botId)this.bot(botId);
    if(path==='/keychain/deploy-capabilities'){
      if(botId)throw new ApiError(403,'owner_only','Deploy capability checks are owner-managed.');
      if(request.method!=='GET')throw new ApiError(405,'method_not_allowed','Method not allowed.');
      const target=new URL(request.url).searchParams.get('botId');if(!target||!UUID.test(target))throw new ApiError(400,'deploy_invalid_request','Select a bot.');this.bot(target);
      const computer=createCloudComputerProvider(this.env.COMPUTER);if(!computer.secureDeployCapabilities)throw new ApiError(503,'secure_deploy_host_unavailable','Computer deploy capability is unavailable.');const capability=await computer.secureDeployCapabilities(target);
      return json({capability});
    }
    if(path==='/keychain'&&request.method==='GET')return json({entries:this.store.list(),requests:this.store.requests().filter(item=>!botId||item.botId===botId)});
    if(path==='/keychain/deploy-plans'){if(botId)throw new ApiError(403,'owner_only','Deploy plans are owner-managed.');if(request.method==='GET'){const plans=this.ctx.storage.sql.exec<{data:string}>('SELECT data FROM secure_worker_deploy_plans WHERE active=1 ORDER BY rowid DESC').toArray().map(x=>JSON.parse(x.data));return json({plans});}if(request.method==='POST'){const input=await body(request);const response=await this.createDeployPlan(input);return response;}throw new ApiError(405,'method_not_allowed','Method not allowed.');}
    const deployPlan=/^\/keychain\/deploy-plans\/([0-9a-f-]{36})$/.exec(path);if(deployPlan){if(botId)throw new ApiError(403,'owner_only','Deploy plans are owner-managed.');if(request.method!=='DELETE')throw new ApiError(405,'method_not_allowed','Method not allowed.');const input=await body(request);if(Object.keys(input).some(k=>!['expectedRevision','operationId'].includes(k))||typeof input.operationId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.operationId)||!Number.isSafeInteger(input.expectedRevision)||Number(input.expectedRevision)<1)throw new ApiError(400,'deploy_invalid_request','Invalid plan revocation.');const row=this.ctx.storage.sql.exec<{revision:number;active:number}>('SELECT revision,active FROM secure_worker_deploy_plans WHERE id=?',deployPlan[1]).toArray()[0];if(!row)throw new ApiError(404,'deploy_plan_unavailable','Deploy plan unavailable.');if(!row.active)return json({revoked:true,revision:row.revision});if(row.revision!==input.expectedRevision)throw new ApiError(409,'deploy_plan_changed','Deploy plan revision is stale.');this.ctx.storage.sql.exec('UPDATE secure_worker_deploy_plans SET active=0,revision=revision+1 WHERE id=? AND revision=?',deployPlan[1],row.revision);return json({revoked:true,revision:row.revision+1});}
    if(path==='/keychain'&&request.method==='POST'){
      let input=await body(request);if(Object.keys(input).some(key=>!['entries','operationId','requestId'].includes(key)))throw new ApiError(400,'invalid_secure_input','Unsupported input fields.');
      const requestId=input.requestId;let pending:SecureInputRequest|undefined;
      if(requestId!==undefined){
        if(typeof requestId!=='string'||!UUID.test(requestId))throw new ApiError(400,'invalid_secure_input','Invalid secure request.');
        pending=this.store.request(requestId);
        if(!pending||pending.secretId||botId&&pending.botId!==botId)throw new ApiError(400,'invalid_secure_input','Invalid secure request.');
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
      const pending=this.store.request(authorization[1]);if(!pending?.secretId||botId&&pending.botId!==botId)throw new ApiError(404,'not_found','Request not found.');
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
