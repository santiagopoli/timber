import type { SecureDeployCapabilities,SecureDeployReceipt } from './secure-deploy';
const WRANGLER_VERSION='4.147.0',WRANGLER_BUILD_ID='wrangler-4.147.0-timber-no-retry-v1',WRANGLER_DIGEST='sha256:07f2d4392dbaa8944bd2a73dc1bcbef481840fddb65b6e6bd5c697e000163511';
const CODE=new Set(['deploy_accepted','runner_failed','runner_interrupted','runner_unavailable','dispatch_already_seen','invalid_request','invalid_authorization','invalid_pin','invalid_refs','artifact_not_found','artifact_invalid','artifact_digest_mismatch']);
const falseCaps=():SecureDeployCapabilities=>({secureDeploy:false,isolationVersion:'uid-ptrace-v1',privateCredentialChannel:false,noShellEnv:false,noBuildCredentialInheritance:false,outputRedaction:true,canaryVersion:'cross-uid-proc-env-v1'});
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{'cache-control':'no-store'}});
/** Private ComputerDO dispatch boundary. This intentionally does not journal request bodies. */
export async function secureDeployComputerRoute(computer:any,request:Request,path:string):Promise<Response>{
 computer.active();const botId=request.headers.get('x-timber-bot-id')??'';
 if(!/^[A-Za-z0-9_-]{1,100}$/.test(botId))throw new Error('computer_invalid_request');
 const owner=await computer.ctx.storage.get('botId');
 if(path==='/secure-deploy/capabilities'&&request.method==='GET'){
  const namespace=computer.env.WORKSPACE;if(!namespace)return json(falseCaps());
  try{
   // The owner Worker calls capabilities only after checking its owner registry; repeat that check here before first use of this bot-scoped ComputerDO.
   const registry=namespace.get(namespace.idFromName('owner'));
   const attest=async()=>{const r=await registry.fetch(new Request(`https://workspace/${botId}`,{headers:{'x-timber-internal':'computer'}}));if(!r.ok){void r.body?.cancel();return false}const record=await r.json() as {bot?:{id?:unknown}};return record.bot?.id===botId};
   if(!(await attest()))return json(falseCaps());
   if(owner&&owner!==botId)return json(falseCaps());
   if(!owner)await computer.ctx.storage.transaction(async(tx:any)=>{const current=await tx.get('botId');if(current&&current!==botId)throw new Error('computer_owner_mismatch');if(!current)await tx.put('botId',botId)});
   // ensureReady serializes startup and restores the persisted workspace checkpoint before probing; capability admission still runs before API decrypts any reference.
   await computer.ensureReady(botId);computer.active();
   if(await computer.ctx.storage.get('botId')!==botId||!(await attest()))return json(falseCaps());
   request.signal.throwIfAborted();
   const response=await computer.call('/secure-deploy/capabilities',{signal:AbortSignal.any([request.signal,AbortSignal.timeout(15_000)])});if(!response.ok)return json(falseCaps());
   const raw=await response.json() as Record<string,unknown>,cliVersion=raw.cliVersion===WRANGLER_VERSION?WRANGLER_VERSION:undefined,cliBuildId=raw.cliBuildId===WRANGLER_BUILD_ID?WRANGLER_BUILD_ID:undefined,cliDigest=raw.cliDigest===WRANGLER_DIGEST?WRANGLER_DIGEST:undefined,noAutomaticRetry=raw.noAutomaticRetry===true,ok=raw.secureDeploy===true&&raw.isolationVersion==='uid-ptrace-v1'&&raw.privateCredentialChannel===true&&raw.noShellEnv===true&&raw.noBuildCredentialInheritance===true&&raw.outputRedaction===true&&raw.canaryVersion==='cross-uid-proc-env-v1'&&cliVersion===WRANGLER_VERSION&&cliBuildId===WRANGLER_BUILD_ID&&cliDigest===WRANGLER_DIGEST&&noAutomaticRetry;
   return json({secureDeploy:ok,isolationVersion:'uid-ptrace-v1',privateCredentialChannel:ok,noShellEnv:ok,noBuildCredentialInheritance:ok,outputRedaction:true,canaryVersion:'cross-uid-proc-env-v1',...(ok?{cliVersion,cliBuildId,cliDigest,noAutomaticRetry:true}:{})});
  }catch{return json(falseCaps())}
 }
 if(!owner||owner!==botId)throw new Error('computer_owner_mismatch');
 if(path==='/secure-deploy/cancel'&&request.method==='POST'){
  const body=await request.json().catch(()=>undefined) as {operationId?:unknown}|undefined;
  if(!body||Object.keys(body).length!==1||typeof body.operationId!=='string'||!/^[A-Za-z0-9:_.-]{1,160}$/.test(body.operationId))return json({operationId:typeof body?.operationId==='string'?body.operationId:'',result:'unknown'});
  if(!computer.container?.running)return json({operationId:body.operationId,result:'unknown'});
  try{const response=await computer.call('/secure-deploy/cancel',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({operationId:body.operationId}),signal:request.signal});const receipt=await response.json() as {operationId?:unknown;result?:unknown};return json({operationId:body.operationId,result:receipt.operationId===body.operationId&&(receipt.result==='cancelled'||receipt.result==='already_dispatched')?receipt.result:'unknown'});}catch{return json({operationId:body.operationId,result:'unknown'})}
 }
 if(path!=='/secure-deploy'||request.method!=='POST')throw new Error('computer_invalid_request');
 const size=Number(request.headers.get('content-length')??0);if(Number.isFinite(size)&&size>64_000)return json({operationId:'',status:'rejected',code:'invalid_request'});
 const input=await request.json().catch(()=>undefined) as Record<string,any>|undefined;
 const invalid=()=>json({operationId:typeof input?.operationId==='string'?input.operationId:'',status:'rejected',code:'invalid_request'});
 if(!input||Object.keys(input).length!==5||Object.keys(input).some(k=>!['operationId','authorization','pin','refs','credentials'].includes(k))||typeof input.operationId!=='string'||!/^[A-Za-z0-9:_.-]{1,160}$/.test(input.operationId)||!input.authorization||typeof input.authorization!=='object'||!input.pin||typeof input.pin!=='object'||!Array.isArray(input.refs)||!Array.isArray(input.credentials))return invalid();
 const auth=input.authorization as Record<string,any>,pin=input.pin as Record<string,any>,id=input.operationId;
 const authKeys=['version','ownerId','botId','taskId','runId','nativeOperationId','operationId','pin','planId','planRevision','refs','expiresAt','signature'];
 if(Object.keys(auth).some(k=>!authKeys.includes(k))||auth.taskId!==undefined&&!(typeof auth.taskId==='string'&&/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/.test(auth.taskId))||auth.version!==1||auth.ownerId!=='owner'||auth.botId!==botId||auth.operationId!==id||typeof auth.runId!=='string'||typeof auth.nativeOperationId!=='string'||typeof auth.planId!=='string'||!Number.isSafeInteger(auth.planRevision)||auth.planRevision<1||!Number.isSafeInteger(auth.expiresAt)||auth.expiresAt<=Date.now()||typeof auth.signature!=='string'||!auth.signature)return json({operationId:id,status:'rejected',code:'invalid_authorization'});
 const pinKeys=['repository','commit','artifactDigest','artifactPath','accountId','workerName','destination'];
 if(Object.keys(pin).some(k=>!pinKeys.includes(k))||!auth.pin||pinKeys.some(k=>pin[k]!==auth.pin[k])||auth.pin.planId!==auth.planId||auth.pin.planRevision!==auth.planRevision||!/^([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})$/.test(pin.repository)||pin.repository.split('/').some((x:string)=>x==='.'||x==='..'||x.includes('..'))||!/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(pin.commit)||!/^sha256:[a-f0-9]{64}$/.test(pin.artifactDigest)||typeof pin.artifactPath!=='string'||pin.artifactPath.length>512||! /^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(pin.artifactPath)||pin.artifactPath.startsWith('.')||pin.artifactPath.split('/').some((x:string)=>x==='.'||x==='..')||!/^[a-f0-9]{32}$/.test(pin.accountId)||!/^[a-z0-9][a-z0-9-]{0,62}$/.test(pin.workerName)||pin.destination!==`https://api.cloudflare.com/client/v4/accounts/${pin.accountId}/workers/scripts/${pin.workerName}`)return json({operationId:id,status:'rejected',code:'invalid_pin'});
 if(!Array.isArray(auth.refs)||auth.refs.length<1||auth.refs.length>2||input.refs.length!==auth.refs.length||input.credentials.length!==auth.refs.length)return json({operationId:id,status:'rejected',code:'invalid_refs'});
 for(let i=0;i<auth.refs.length;i++){
  const ref=auth.refs[i] as Record<string,unknown>,wire=input.refs[i] as Record<string,unknown>,cred=input.credentials[i] as Record<string,unknown>;
  if(Object.keys(ref).some(k=>!['id','revision','permissionEpoch','binding'].includes(k))||wire.id!==ref.id||wire.revision!==ref.revision||wire.permissionEpoch!==ref.permissionEpoch||wire.binding!==ref.binding||Object.keys(cred).some(k=>!['refId','revision','header','prefix','value'].includes(k))||cred.refId!==ref.id||cred.revision!==ref.revision||typeof cred.header!=='string'||typeof cred.prefix!=='string'||typeof cred.value!=='string'||cred.value.length<1||cred.value.length>8192||/[\x00-\x1f\x7f]/.test(cred.value))return json({operationId:id,status:'rejected',code:'invalid_refs'});
 }
 const credentials=input.credentials as Array<{header:string;prefix:string}>;const headers=credentials.map(x=>x.header.toLowerCase());
 const authFormat=(headers.length===1&&headers[0]==='authorization'&&credentials[0].prefix==='Bearer ')||(headers.length===2&&headers[0]==='x-auth-key'&&headers[1]==='x-auth-email'&&credentials.every(x=>x.prefix===''));
 if(!authFormat||!computer.env.WORKSPACE)return json({operationId:id,status:'rejected',code:'invalid_refs'});
 // Ensure/start is an awaited boundary. The signed Workspace authority check below binds the current plan, refs, run and native Stop fence.
 try{await computer.ensureReady(botId)}catch{return json({operationId:id,status:'unavailable',code:'runner_unavailable'})}
 computer.active();request.signal.throwIfAborted();if(auth.expiresAt<=Date.now())return json({operationId:id,status:'rejected',code:'invalid_authorization'});
 let authority:Response;try{authority=await computer.env.WORKSPACE.get(computer.env.WORKSPACE.idFromName('owner')).fetch(new Request('https://workspace/keychain/deploy-verify',{method:'POST',headers:{'content-type':'application/json','x-timber-internal':'computer'},body:JSON.stringify({authorization:auth})}))}catch{return json({operationId:id,status:'rejected',code:'invalid_authorization'})}
 const authorized=authority.ok;void authority.body?.cancel();
 // Linearization point: after fresh owner authority response, check local liveness and expiry; no await before private channel invocation.
 computer.active();request.signal.throwIfAborted();if(!authorized||auth.expiresAt<=Date.now())return json({operationId:id,status:'rejected',code:'invalid_authorization'});
 const dispatched=computer.call('/secure-deploy',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input),signal:request.signal});
 try{const response=await dispatched;if(!response.ok)return json({operationId:id,status:'unavailable',code:'runner_unavailable'});const raw=await response.json() as Record<string,unknown>;const statuses=new Set(['completed','failed','interrupted','rejected','unavailable']);if(raw.operationId!==id||!statuses.has(String(raw.status))||typeof raw.code!=='string'||!CODE.has(raw.code))return json({operationId:id,status:'interrupted',code:'runner_interrupted'});const result:SecureDeployReceipt={operationId:id,status:raw.status as SecureDeployReceipt['status'],code:raw.code};return json(result)}catch{return json({operationId:id,status:'interrupted',code:'runner_interrupted'})}
}
