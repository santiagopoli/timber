/** Bounded coordinator for an isolated deploy host. The shared ComputerDO is not such a host. */
export type SecretRef=Readonly<{id:string;revision:number}>;
export type DeployPin=Readonly<{repository:string;commit:string;artifactDigest:`sha256:${string}`;accountId:string;workerName:string;destination:string;planId?:string;planRevision?:number}>;
export type DeployRequest=Readonly<{operationId:string;ownerId:string;botId:string;runId:string;expectedRevision?:number;refs:readonly SecretRef[];pin:DeployPin}>;
export type DeployOutput=Readonly<{status:'completed'|'failed'|'uncertain'|'cancelled';output:string;errorCode?:string}>;
export type DeployRecord=Readonly<{operationId:string;fingerprint:string;state:'building'|'dispatching'|'completed'|'failed'|'uncertain'|'cancelled';pin:DeployPin;errorCode?:string}>;
export type SecureDeployAuthorization=Readonly<{version:1;ownerId:string;botId:string;runId:string;operationId:string;pin:DeployPin;planId?:string;planRevision?:number;expiresAt:number;refs:readonly Readonly<{id:string;revision:number;permissionEpoch:string;binding:string}>[];signature:string}>;
export interface SecureDeployHost{
 capabilities():Promise<{secureDeploy:boolean;isolationVersion?:string;privateCredentialChannel?:boolean;noShellEnv?:boolean;noBuildCredentialInheritance?:boolean;outputRedaction?:boolean}>;
 build(input:{repository:string;commit:string;artifactDigest:string;signal:AbortSignal}):Promise<{artifactDigest:string;buildAttestation:string}>;
 dispatchTrusted(input:{operationId:string;ownerId:string;botId:string;runId:string;pin:DeployPin;buildAttestation:string;refs:readonly SecretRef[];authorization?:SecureDeployAuthorization;signal:AbortSignal}):Promise<{status:'completed'|'failed';output:string;redacted:true;errorCode?:string}>;
 cancel(operationId:string):Promise<'cancelled'|'already_dispatched'|'unknown'>;
}
export interface SecureDeployAuthority{assertCurrent(request:DeployRequest):Promise<void>}
export interface SecureDeployJournal{
 get(operationId:string):Promise<DeployRecord|undefined>;
 put(record:DeployRecord):Promise<void>;
 /** Atomic durable operation reservation; implementations must enforce unique operationId across instances. */
 reserve(operationId:string,fingerprint:string):Promise<'reserved'|'same'|'conflict'>;
}
export interface SecureDeployBinding{fetch(request:Request):Promise<Response>}
const OP=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/,UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,SHA=/^sha256:[a-f0-9]{64}$/,NAME=/^[a-z0-9][a-z0-9-]{0,62}$/,ERRORS=new Set(['secure_deploy_host_unsupported','secure_deploy_host_unavailable','deploy_cancelled','deploy_outcome_unknown','deploy_artifact_mismatch','deploy_invalid_pin','deploy_invalid_request','deploy_admission_full','deploy_idempotency_conflict','deploy_authorization_changed','deploy_failed']);
const fail=(code:string):never=>{throw Object.assign(new Error(code),{code})};
function validRepo(s:string):boolean{return s.length<=202&&s.split('/').length===2&&s.split('/').every(x=>/^[A-Za-z0-9_.-]{1,100}$/.test(x)&&x!=='.'&&x!=='..'&&!x.includes('..'))}
function validate(r:DeployRequest):void{
 if(!r||Object.keys(r).some(k=>!['operationId','ownerId','botId','runId','expectedRevision','refs','pin'].includes(k))||!OP.test(r.operationId)||!(r.ownerId==='owner'||UUID.test(r.ownerId))||!UUID.test(r.botId)||!UUID.test(r.runId))fail('deploy_invalid_request');
 if(!Array.isArray(r.refs)||r.refs.length<1||r.refs.length>4||new Set(r.refs.map(x=>x?.id)).size!==r.refs.length||r.refs.some(x=>!x||Object.keys(x).some(k=>!['id','revision'].includes(k))||!UUID.test(x.id)||!Number.isSafeInteger(x.revision)||x.revision<1))fail('deploy_invalid_request');
 const p=r.pin;if(!p||Object.keys(p).some(k=>!['repository','commit','artifactDigest','accountId','workerName','destination','planId','planRevision'].includes(k))||p.planId!==undefined&&!UUID.test(p.planId)||p.planRevision!==undefined&&(!Number.isSafeInteger(p.planRevision)||p.planRevision<1)||!validRepo(p.repository)||!/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(p.commit)||!SHA.test(p.artifactDigest)||!/^[a-f0-9]{32}$/i.test(p.accountId)||!NAME.test(p.workerName)||p.destination!==`https://api.cloudflare.com/client/v4/accounts/${p.accountId}/workers/scripts/${p.workerName}`)fail('deploy_invalid_pin');
}
function freezeRequest(r:DeployRequest):DeployRequest {
 const p=r.pin;
 const pin=Object.freeze({repository:p.repository,commit:p.commit,artifactDigest:p.artifactDigest,accountId:p.accountId,workerName:p.workerName,destination:p.destination,...(p.planId===undefined?{}:{planId:p.planId}),...(p.planRevision===undefined?{}:{planRevision:p.planRevision})});
 const refs=Object.freeze(r.refs.map(x=>Object.freeze({id:x.id,revision:x.revision})).sort((a,b)=>a.id.localeCompare(b.id)));
 return Object.freeze({operationId:r.operationId,ownerId:r.ownerId,botId:r.botId,runId:r.runId,expectedRevision:r.expectedRevision,refs,pin});
}
/** One canonical domain shared by the owner journal and coordinator. */
export function secureDeployCanonical(input:DeployRequest):string {
 const r=freezeRequest(input);
 return 'timber.secure-deploy-fingerprint.v1\0'+JSON.stringify({operationId:r.operationId,ownerId:r.ownerId,botId:r.botId,runId:r.runId,expectedRevision:r.expectedRevision??null,refs:r.refs,pin:r.pin});
}
async function bindingJson(binding:SecureDeployBinding,path:string,body?:unknown,signal?:AbortSignal):Promise<Record<string,unknown>>{const response=await binding.fetch(new Request(`https://secure-deploy.internal${path}`,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),...(signal?{signal}:{}),redirect:'manual'}));if(response.redirected||response.status>=300&&response.status<400){await response.body?.cancel();return fail('secure_deploy_host_unavailable')}if(!response.ok){await response.body?.cancel();return fail('secure_deploy_host_unavailable')}try{return await response.json() as Record<string,unknown>}catch{return fail('secure_deploy_host_unavailable')}}
export function createPrivateServiceDeployHost(binding:SecureDeployBinding):SecureDeployHost{return{async capabilities(){const x=await bindingJson(binding,'/internal/capabilities');return{secureDeploy:x.secureDeploy===true,isolationVersion:typeof x.isolationVersion==='string'?x.isolationVersion:undefined,privateCredentialChannel:x.privateCredentialChannel===true,noShellEnv:x.noShellEnv===true,noBuildCredentialInheritance:x.noBuildCredentialInheritance===true,outputRedaction:x.outputRedaction===true}},async build(i){const x=await bindingJson(binding,'/internal/build',{repository:i.repository,commit:i.commit,artifactDigest:i.artifactDigest},i.signal);if(x.artifactDigest!==i.artifactDigest||typeof x.buildAttestation!=='string')return fail('deploy_artifact_mismatch');return{artifactDigest:i.artifactDigest,buildAttestation:x.buildAttestation}},async dispatchTrusted(i){const x=await bindingJson(binding,'/internal/dispatch',{operationId:i.operationId,ownerId:i.ownerId,botId:i.botId,runId:i.runId,pin:i.pin,buildAttestation:i.buildAttestation,refs:i.refs,authorization:i.authorization},i.signal);if(x.status!=='completed'&&x.status!=='failed')return fail('deploy_outcome_unknown');return{status:x.status,output:'',redacted:true}},async cancel(id){const x=await bindingJson(binding,'/internal/cancel',{operationId:id});return x.result==='cancelled'||x.result==='already_dispatched'?x.result:'unknown'}}}
export interface SecureWorkerDeployProvider{capabilities(botId:string):Promise<{secureDeploy:boolean;isolationVersion?:string;privateCredentialChannel?:boolean;noShellEnv?:boolean;noBuildCredentialInheritance?:boolean;outputRedaction?:boolean}>;build(botId:string,input:{repository:string;commit:string;artifactDigest:string;signal:AbortSignal}):Promise<{artifactDigest:string;buildAttestation:string}>;dispatch(botId:string,input:{operationId:string;ownerId:string;botId:string;runId:string;pin:DeployPin;buildAttestation:string;refs:readonly SecretRef[];authorization:SecureDeployAuthorization;signal:AbortSignal}):Promise<{status:'completed'|'failed';output:string;redacted:true;errorCode?:string}>;cancel(botId:string,operationId:string):Promise<'cancelled'|'already_dispatched'|'unknown'>}
/** Transport intentionally never enables the shared ComputerDO, even if an optional binding is present. */
export function createCloudSecureWorkerDeployProvider(binding:DurableObjectNamespace):SecureWorkerDeployProvider {
 const unavailable=()=>fail('secure_deploy_host_unsupported');
 return {
  async capabilities(botId) {
   if(!UUID.test(botId))fail('deploy_invalid_request');
   // Exercise the private provider route, but never trust an advertisement to enable this VM.
   try {
    const response=await binding.get(binding.idFromName(botId)).fetch(new Request('https://computer.internal/secure-worker-deploy/capabilities',{headers:{'x-timber-bot-id':botId},redirect:'manual'}));
    await response.body?.cancel();
   } catch { fail('secure_deploy_host_unavailable'); }
   return {secureDeploy:false};
  },
  async build(){return unavailable()},async dispatch(){return unavailable()},async cancel(){return 'unknown'}
 };
}
export class SecureDeployCoordinator {
 private active=new Map<string,{controller:AbortController;dispatchPossible:boolean}>();
 private readonly host:SecureDeployHost;
 private readonly authority:SecureDeployAuthority;
 private readonly journal:SecureDeployJournal;
 private readonly maxActive:number;
 private readonly fingerprint:(canonical:string)=>Promise<string>;
 constructor(host:SecureDeployHost,authority:SecureDeployAuthority,journal:SecureDeployJournal,maxActive=2,fingerprint?:(canonical:string)=>Promise<string>) {
  if(!Number.isSafeInteger(maxActive)||maxActive<1||maxActive>8)throw new Error('deploy_invalid_limit');
  if(typeof journal.reserve!=='function'||!fingerprint)fail('deploy_invalid_request');
  this.host=host;this.authority=authority;this.journal=journal;this.maxActive=maxActive;this.fingerprint=fingerprint!;
 }
 async deploy(input:DeployRequest):Promise<DeployRecord> {
  validate(input);
  const request=freezeRequest(input);
  if(this.active.has(request.operationId)||this.active.size>=this.maxActive)fail('deploy_admission_full');
  const slot={controller:new AbortController(),dispatchPossible:false};
  this.active.set(request.operationId,slot); // No await before local admission.
  let fingerprint='',ownsReservation=false;
  const record=(state:DeployRecord['state'],errorCode?:string):DeployRecord=>({operationId:request.operationId,fingerprint,state,pin:request.pin,...(errorCode?{errorCode}:{})});
  const check=async()=>{slot.controller.signal.throwIfAborted();await this.authority.assertCurrent(request);slot.controller.signal.throwIfAborted()};
  try {
   fingerprint=await this.fingerprint(secureDeployCanonical(request));
   const reservation=await this.journal.reserve(request.operationId,fingerprint);
   if(reservation==='conflict')return record('failed','deploy_idempotency_conflict');
   ownsReservation=reservation==='reserved';
   if(!ownsReservation) {
    await check();
    const prior=await this.journal.get(request.operationId);
    await check();
    if(prior&&prior.fingerprint!==fingerprint)return record('failed','deploy_idempotency_conflict');
    // A reservation without a receipt is still an in-flight/unknown operation, NOT permission to dispatch.
    if(!prior||['admitting','reserved','building','dispatching'].includes(prior.state))return record('uncertain','deploy_outcome_unknown');
    return record(prior.state,prior.errorCode&&ERRORS.has(prior.errorCode)?prior.errorCode:undefined);
   }
   await check();
   const caps=await this.host.capabilities();
   slot.controller.signal.throwIfAborted();
   if(!caps.secureDeploy||!caps.isolationVersion||!caps.privateCredentialChannel||!caps.noShellEnv||!caps.noBuildCredentialInheritance||!caps.outputRedaction)fail('secure_deploy_host_unsupported');
   await check();
   await this.journal.put(record('building'));
   slot.controller.signal.throwIfAborted();
   const build=await this.host.build({repository:request.pin.repository,commit:request.pin.commit,artifactDigest:request.pin.artifactDigest,signal:slot.controller.signal});
   await check();
   if(build.artifactDigest!==request.pin.artifactDigest||typeof build.buildAttestation!=='string'||!build.buildAttestation||build.buildAttestation.length>4096)fail('deploy_artifact_mismatch');
   await this.journal.put(record('dispatching'));
   await check();
   slot.dispatchPossible=true; // No await between final local fence and crossing the host boundary.
   const result=await this.host.dispatchTrusted({operationId:request.operationId,ownerId:request.ownerId,botId:request.botId,runId:request.runId,pin:request.pin,buildAttestation:build.buildAttestation,refs:request.refs,signal:slot.controller.signal});
   // Discard ALL provider stdout/stderr and arbitrary error fields, even if marked redacted.
   if(result.status!=='completed'&&result.status!=='failed')fail('deploy_outcome_unknown');
   await this.authority.assertCurrent(request);
   const receipt=record(result.status,typeof result.errorCode==='string'&&ERRORS.has(result.errorCode)?result.errorCode:undefined);
   await this.journal.put(receipt);
   await this.authority.assertCurrent(request);
   return receipt;
  } catch(error) {
   const proposed=(error as {code?:unknown})?.code;
   const code=typeof proposed==='string'&&ERRORS.has(proposed)?proposed:'deploy_failed';
   const receipt=slot.dispatchPossible?record('uncertain','deploy_outcome_unknown'):slot.controller.signal.aborted?record('cancelled','deploy_cancelled'):record('failed',code);
   // Non-owning retries/conflicts cannot overwrite another operation's receipt.
   if(ownsReservation)await this.journal.put(receipt);
   return receipt;
  } finally {this.active.delete(request.operationId)}
 }
 async cancel(operationId:string):Promise<'cancelled'|'already_dispatched'|'unknown'> {
  const slot=this.active.get(operationId);if(!slot)return 'unknown';
  if(slot.dispatchPossible)return 'already_dispatched';
  slot.controller.abort();
  // Local abort now guarantees this coordinator cannot cross dispatch later.
  try {const result=await this.host.cancel(operationId);return result==='already_dispatched'?'already_dispatched':result==='cancelled'?'cancelled':'unknown'}catch{return 'unknown'}
 }
 get activeCount():number{return this.active.size}
}
export const unsupportedSecureDeployHost:SecureDeployHost={async capabilities(){return{secureDeploy:false}},async build(){throw Error('secure_deploy_host_unsupported')},async dispatchTrusted(){throw Error('secure_deploy_host_unsupported')},async cancel(){return'unknown'}};
export function memorySecureDeployJournal():SecureDeployJournal{const rows=new Map<string,DeployRecord>(),locks=new Map<string,string>();return{async get(id){const x=rows.get(id);return x?Object.freeze({...x,pin:Object.freeze({...x.pin})}):undefined},async reserve(id,fp){const old=locks.get(id);if(old)return old===fp?'same':'conflict';locks.set(id,fp);return'reserved'},async put(record){const copy=Object.freeze({...record,pin:Object.freeze({...record.pin})});rows.set(record.operationId,copy)}}}
