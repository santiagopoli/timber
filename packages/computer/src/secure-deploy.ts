/** Private deploy management protocol. This API is deliberately separate from ComputerAction/exec. */
export type SecretRef=Readonly<{id:string;revision:number}>;
export type DeployPin=Readonly<{repository:string;commit:string;artifactDigest:`sha256:${string}`;artifactPath:string;accountId:string;workerName:string;destination:string;planId?:string;planRevision?:number}>;
export type DeployCredential=Readonly<{refId:string;revision:number;header:string;prefix:string;value:string}>;
export type DeployRequest=Readonly<{operationId:string;ownerId:string;botId:string;taskId?:string;runId:string;expectedRevision?:number;refs:readonly SecretRef[];pin:DeployPin}>;
export type DeployRecord=Readonly<{operationId:string;fingerprint:string;state:'admitting'|'dispatching'|'completed'|'failed'|'uncertain'|'cancelled';pin:DeployPin;errorCode?:string}>;
export type SecureDeployAuthorization=Readonly<{version:1;ownerId:string;botId:string;taskId?:string;runId:string;nativeOperationId:string;operationId:string;pin:DeployPin;planId:string;planRevision:number;refs:readonly Readonly<{id:string;revision:number;permissionEpoch:string;binding:string}>[];expiresAt:number;signature:string}>;
export type SecureDeployReceipt=Readonly<{operationId:string;status:'completed'|'failed'|'interrupted'|'rejected'|'unavailable';code:string}>;
export type SecureDeployCapabilities=Readonly<{secureDeploy:boolean;isolationVersion?:string;privateCredentialChannel?:boolean;noShellEnv?:boolean;noBuildCredentialInheritance?:boolean;outputRedaction?:boolean;canaryVersion?:string;cliVersion?:string;cliBuildId?:string;cliDigest?:`sha256:${string}`;noAutomaticRetry?:boolean}>;
const WRANGLER_VERSION='4.147.0';
const WRANGLER_BUILD_ID='wrangler-4.147.0-timber-no-retry-v1';
const WRANGLER_DIGEST='sha256:07f2d4392dbaa8944bd2a73dc1bcbef481840fddb65b6e6bd5c697e000163511';
export interface SecureDeployHost {
 capabilities():Promise<SecureDeployCapabilities>;
 /** Exactly one private dispatch. Credentials are passed only inside this request and never retained. */
 dispatchTrusted(input:{operationId:string;authorization:SecureDeployAuthorization;pin:DeployPin;refs:SecureDeployAuthorization['refs'];credentials:readonly DeployCredential[];signal:AbortSignal}):Promise<SecureDeployReceipt>;
 cancel(operationId:string):Promise<'cancelled'|'already_dispatched'|'unknown'>;
}
export interface SecureDeployAuthority {
 assertCurrent(request:DeployRequest):Promise<void>;
 /** Decrypt only after all plan/run/reference fences and call the one private dispatch after the final checks. */
 withAuthorization<T>(request:DeployRequest,dispatch:(authorization:SecureDeployAuthorization,credentials:readonly DeployCredential[],beforeDispatch:()=>void)=>Promise<T>):Promise<T>;
}
export interface SecureDeployJournal {
 get(operationId:string):Promise<DeployRecord|undefined>;
 put(record:DeployRecord):Promise<void>;
 /** Atomic durable reservation, unique across coordinator instances. */
 reserve(operationId:string,fingerprint:string):Promise<'reserved'|'same'|'conflict'>;
}
export interface SecureWorkerDeployProvider {
 capabilities(botId:string,signal?:AbortSignal):Promise<SecureDeployCapabilities>;
 dispatch(botId:string,input:{operationId:string;authorization:SecureDeployAuthorization;pin:DeployPin;refs:SecureDeployAuthorization['refs'];credentials:readonly DeployCredential[];signal:AbortSignal}):Promise<SecureDeployReceipt>;
 cancel(botId:string,operationId:string):Promise<'cancelled'|'already_dispatched'|'unknown'>;
}
export interface SecureDeployBinding {fetch(request:Request):Promise<Response>}
const OP=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CODES=new Set(['deploy_accepted','runner_failed','runner_interrupted','runner_unavailable','dispatch_already_seen','invalid_request','invalid_authorization','invalid_pin','invalid_refs','artifact_not_found','artifact_invalid','artifact_digest_mismatch']);
const fail=(code:string):never=>{throw Object.assign(new Error(code),{code})};
function validRepo(s:string):boolean{return s.length<=202&&s.split('/').length===2&&s.split('/').every(x=>/^[A-Za-z0-9_.-]{1,100}$/.test(x)&&x!=='.'&&x!=='..'&&!x.includes('..'))}
function validPath(s:string):boolean{return s.length<=512&&/^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(s)&&!s.startsWith('.')&&s.split('/').every(x=>x!=='.'&&x!=='..')}
function validate(r:DeployRequest):void{
 if(!r||Object.keys(r).some(k=>!['operationId','ownerId','botId','taskId','runId','expectedRevision','refs','pin'].includes(k))||!OP.test(r.operationId)||!(r.ownerId==='owner'||UUID.test(r.ownerId))||!UUID.test(r.botId)||r.taskId!==undefined&&!UUID.test(r.taskId)||!UUID.test(r.runId))fail('deploy_invalid_request');
 if(!Array.isArray(r.refs)||r.refs.length<1||r.refs.length>4||new Set(r.refs.map(x=>x?.id)).size!==r.refs.length||r.refs.some(x=>!x||Object.keys(x).some(k=>!['id','revision'].includes(k))||!UUID.test(x.id)||!Number.isSafeInteger(x.revision)||x.revision<1))fail('deploy_invalid_request');
 const p=r.pin;if(!p||Object.keys(p).some(k=>!['repository','commit','artifactDigest','artifactPath','accountId','workerName','destination','planId','planRevision'].includes(k))||p.planId!==undefined&&!UUID.test(p.planId)||p.planRevision!==undefined&&(!Number.isSafeInteger(p.planRevision)||p.planRevision<1)||!validRepo(p.repository)||!/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(p.commit)||!/^sha256:[a-f0-9]{64}$/.test(p.artifactDigest)||!validPath(p.artifactPath)||!/^[a-f0-9]{32}$/.test(p.accountId)||! /^[a-z0-9][a-z0-9-]{0,62}$/.test(p.workerName)||p.destination!==`https://api.cloudflare.com/client/v4/accounts/${p.accountId}/workers/scripts/${p.workerName}`)fail('deploy_invalid_pin');
}
function freezeRequest(r:DeployRequest):DeployRequest{return Object.freeze({operationId:r.operationId,ownerId:r.ownerId,botId:r.botId,...(r.taskId?{taskId:r.taskId}:{}),runId:r.runId,expectedRevision:r.expectedRevision,refs:Object.freeze(r.refs.map(x=>Object.freeze({id:x.id,revision:x.revision}))),pin:Object.freeze({...r.pin})})}
export function secureDeployCanonical(input:DeployRequest):string {const r=freezeRequest(input);return 'timber.secure-deploy-fingerprint.v2\0'+JSON.stringify({operationId:r.operationId,ownerId:r.ownerId,botId:r.botId,...(r.taskId?{taskId:r.taskId}:{}),runId:r.runId,expectedRevision:r.expectedRevision??null,refs:r.refs,pin:r.pin})}
function capabilityShape(x:Record<string,unknown>):SecureDeployCapabilities{return{secureDeploy:x.secureDeploy===true,isolationVersion:typeof x.isolationVersion==='string'?x.isolationVersion:undefined,privateCredentialChannel:x.privateCredentialChannel===true,noShellEnv:x.noShellEnv===true,noBuildCredentialInheritance:x.noBuildCredentialInheritance===true,outputRedaction:x.outputRedaction===true,canaryVersion:typeof x.canaryVersion==='string'?x.canaryVersion:undefined,cliVersion:typeof x.cliVersion==='string'?x.cliVersion:undefined,cliBuildId:typeof x.cliBuildId==='string'?x.cliBuildId:undefined,cliDigest:typeof x.cliDigest==='string'?x.cliDigest as `sha256:${string}`:undefined,noAutomaticRetry:x.noAutomaticRetry===true}}
async function internal(binding:DurableObjectNamespace,botId:string,path:string,body?:unknown,signal?:AbortSignal):Promise<Record<string,unknown>>{
 const response=await binding.get(binding.idFromName(botId)).fetch(new Request(`https://computer.internal${path}`,{method:body===undefined?'GET':'POST',headers:{'x-timber-bot-id':botId,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),...(signal?{signal}:{}),redirect:'manual'}));
 if(response.redirected||response.status>=300&&response.status<400||!response.ok){await response.body?.cancel();return fail('secure_deploy_host_unavailable')}
 try{return await response.json() as Record<string,unknown>}catch{return fail('secure_deploy_host_unavailable')}
}
function receiptShape(x:Record<string,unknown>,id:string):SecureDeployReceipt {if(x.operationId!==id||!['completed','failed','interrupted','rejected','unavailable'].includes(String(x.status))||typeof x.code!=='string'||!CODES.has(x.code))return fail('deploy_outcome_unknown');return{operationId:id,status:x.status as SecureDeployReceipt['status'],code:x.code}}
export function createCloudSecureWorkerDeployProvider(binding:DurableObjectNamespace):SecureWorkerDeployProvider{return{
 async capabilities(botId,signal){if(!UUID.test(botId))fail('deploy_invalid_request');return capabilityShape(await internal(binding,botId,'/secure-deploy/capabilities',undefined,signal))},
 async dispatch(botId,input){if(!UUID.test(botId)||botId!==input.authorization.botId)fail('deploy_invalid_request');const {signal,...rest}=input;const pin={repository:input.pin.repository,commit:input.pin.commit,artifactDigest:input.pin.artifactDigest,artifactPath:input.pin.artifactPath,accountId:input.pin.accountId,workerName:input.pin.workerName,destination:input.pin.destination};const body={...rest,pin};return receiptShape(await internal(binding,botId,'/secure-deploy',body,signal),input.operationId)},
 async cancel(botId,operationId){if(!UUID.test(botId)||!OP.test(operationId))return'unknown';try{const x=await internal(binding,botId,'/secure-deploy/cancel',{operationId});if(x.operationId!==operationId)return'unknown';return x.result==='cancelled'||x.result==='already_dispatched'?x.result:'unknown'}catch{return'unknown'}}
}}
export class SecureDeployCoordinator {
 private active=new Map<string,{controller:AbortController;dispatchPossible:boolean}>();
 private host:SecureDeployHost;
 private authority:SecureDeployAuthority;
 private journal:SecureDeployJournal;
 private maxActive:number;
 private fingerprint?:(canonical:string)=>Promise<string>;
 constructor(host:SecureDeployHost,authority:SecureDeployAuthority,journal:SecureDeployJournal,maxActive=1,fingerprint?:(canonical:string)=>Promise<string>){this.host=host;this.authority=authority;this.journal=journal;this.maxActive=maxActive;this.fingerprint=fingerprint;if(!Number.isSafeInteger(maxActive)||maxActive<1||maxActive>4||typeof journal.reserve!=='function'||!fingerprint)fail('deploy_invalid_request')}
 async deploy(input:DeployRequest,externalSignal?:AbortSignal):Promise<DeployRecord>{
  validate(input);externalSignal?.throwIfAborted();const request=freezeRequest(input);if(this.active.has(request.operationId)||this.active.size>=this.maxActive)fail('deploy_admission_full');
  const slot={controller:new AbortController(),dispatchPossible:false};this.active.set(request.operationId,slot);const onAbort=()=>{slot.controller.abort();if(slot.dispatchPossible)void this.host.cancel(request.operationId).catch(()=>{});};externalSignal?.addEventListener('abort',onAbort,{once:true});if(externalSignal?.aborted)onAbort();let fingerprint='',ownsReservation=false;
  const record=(state:DeployRecord['state'],errorCode?:string):DeployRecord=>({operationId:request.operationId,fingerprint,state,pin:request.pin,...(errorCode?{errorCode}:{})});
  const check=async()=>{slot.controller.signal.throwIfAborted();await this.authority.assertCurrent(request);slot.controller.signal.throwIfAborted()};
  try{
   fingerprint=await this.fingerprint!(secureDeployCanonical(request));const reservation=await this.journal.reserve(request.operationId,fingerprint);
   if(reservation==='conflict')return record('failed','deploy_idempotency_conflict');ownsReservation=reservation==='reserved';
   if(!ownsReservation){await check();const prior=await this.journal.get(request.operationId);await check();if(prior&&prior.fingerprint!==fingerprint)return record('failed','deploy_idempotency_conflict');if(!prior||['admitting','dispatching'].includes(prior.state))return record('uncertain','deploy_outcome_unknown');return record(prior.state,prior.errorCode&&CODES.has(prior.errorCode)?prior.errorCode:undefined)}
   await check();const caps=await this.host.capabilities();slot.controller.signal.throwIfAborted();if(!caps.secureDeploy||caps.isolationVersion!=='uid-ptrace-v1'||!caps.privateCredentialChannel||!caps.noShellEnv||!caps.noBuildCredentialInheritance||!caps.outputRedaction||caps.canaryVersion!=='cross-uid-proc-env-v1'||caps.cliVersion!==WRANGLER_VERSION||caps.cliBuildId!==WRANGLER_BUILD_ID||caps.cliDigest!==WRANGLER_DIGEST||caps.noAutomaticRetry!==true)fail('secure_deploy_host_unsupported');
   await check();await this.journal.put(record('dispatching'));await check();
   const result=await this.authority.withAuthorization(request,async(authorization,credentials,beforeDispatch)=>{slot.controller.signal.throwIfAborted();beforeDispatch();slot.dispatchPossible=true;return this.host.dispatchTrusted({operationId:request.operationId,authorization,pin:request.pin,refs:authorization.refs,credentials,signal:slot.controller.signal})});
   if(slot.controller.signal.aborted||result.operationId!==request.operationId)fail('deploy_outcome_unknown');
   if(result.status==='completed'&&result.code==='deploy_accepted'){await this.authority.assertCurrent(request);const saved=record('completed');await this.journal.put(saved);await this.authority.assertCurrent(request);return saved}
   if(['interrupted','unavailable'].includes(result.status))fail('deploy_outcome_unknown');
   if(result.status==='rejected') {const saved=record('failed','deploy_authorization_changed');await this.journal.put(saved);return saved}
   const saved=record('failed','deploy_failed');await this.journal.put(saved);return saved;
  }catch(error){const proposed=(error as {code?:unknown})?.code;const code=typeof proposed==='string'&&['secure_deploy_host_unsupported','secure_deploy_host_unavailable','deploy_cancelled','deploy_outcome_unknown','deploy_artifact_mismatch','deploy_invalid_pin','deploy_invalid_request','deploy_admission_full','deploy_idempotency_conflict','deploy_authorization_changed','deploy_failed'].includes(proposed)?proposed:'deploy_failed';const saved=slot.dispatchPossible?record('uncertain','deploy_outcome_unknown'):slot.controller.signal.aborted?record('cancelled','deploy_cancelled'):record('failed',code);if(ownsReservation)await this.journal.put(saved);return saved
  }finally{externalSignal?.removeEventListener('abort',onAbort);this.active.delete(request.operationId)}
 }
 async cancel(operationId:string):Promise<'cancelled'|'already_dispatched'|'unknown'>{const slot=this.active.get(operationId);if(!slot)return'unknown';slot.controller.abort();try{const r=await this.host.cancel(operationId);if(slot.dispatchPossible)return r==='cancelled'?'cancelled':'already_dispatched';return r==='already_dispatched'||r==='cancelled'?r:'unknown'}catch{return slot.dispatchPossible?'already_dispatched':'unknown'}}
 get activeCount():number{return this.active.size}
}
export function memorySecureDeployJournal():SecureDeployJournal{const rows=new Map<string,DeployRecord>(),locks=new Map<string,string>();return{async get(id){const x=rows.get(id);return x?Object.freeze({...x,pin:Object.freeze({...x.pin})}):undefined},async reserve(id,fp){const old=locks.get(id);if(old)return old===fp?'same':'conflict';locks.set(id,fp);return'reserved'},async put(r){rows.set(r.operationId,Object.freeze({...r,pin:Object.freeze({...r.pin})}))}}}
