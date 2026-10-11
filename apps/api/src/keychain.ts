import type { ComputerResult, SecretMetadata, SecureInputRequest } from '@botspace/contracts';
export type {SecretMetadata,SecureInputRequest} from '@botspace/contracts';
import {ApiError} from './errors';
import {object, operationId, string, UUID} from './validation';

type Row = {id:string;data:string;envelope:string|null};
type Envelope = {iv:string;ciphertext:string};
const encoder=new TextEncoder();
const encode=(bytes:Uint8Array)=>btoa(Array.from(bytes,b=>String.fromCharCode(b)).join(''));
const decode=(value:string)=>Uint8Array.from(atob(value),c=>c.charCodeAt(0));
const invalid=(message:string):never=>{throw new ApiError(400,'invalid_secure_input',message);};
const now=()=>new Date().toISOString();

export function secretDestination(value:unknown):string {
  const input=string(value,'origin',250);
  let url:URL;try {url=new URL(input);} catch {return invalid('Use a public HTTPS origin, for example https://api.example.com.');}
  if(url.protocol!=='https:' || url.username || url.password || url.search || url.hash || url.pathname!=='/' || url.port || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(url.hostname) || /(?:^|\.)(?:localhost|local|internal|test|invalid|onion)$/.test(url.hostname)) return invalid('Use a public HTTPS origin without a path, credentials or port.');
  return url.origin;
}
function secretName(value:unknown):string {
  const name=string(value,'name',80).trim();if(!name||/[\x00-\x1f\x7f]/.test(name))invalid('Use a short, single-line name.');return name;
}
function metadata(value:Record<string,unknown>,unbound=false) {
  const name=secretName(value.name??'Private input');
  if(unbound&&!value.origin)return {name,origin:'',header:'',prefix:''};
  const origin=secretDestination(value.origin),header=string(value.header??'Authorization','header',80);
  if(!/^[A-Za-z][A-Za-z0-9-]{0,79}$/.test(header)||/^(?:accept|host|cookie|set-cookie|content-.+|connection|transfer-encoding|proxy-.+|sec-.+|cf-.+|x-forwarded-.+)$/i.test(header))invalid('Use an authentication header such as Authorization or X-API-Key.');
  const prefix=string(value.prefix??'Bearer ','prefix',32,0);
  if(!/^[A-Za-z0-9 ._-]*$/.test(prefix))invalid('The header prefix contains unsupported characters.');
  return {name,origin,header,prefix};
}

/** The only plaintext boundary is an authenticated write and one scoped HTTPS request.
 * No reveal endpoint, runtime value lookup, workspace file or checkpoint contains a secret. */
export class OwnerKeychain {
  private key?:Promise<CryptoKey>;
  constructor(private storage:DurableObjectStorage,private ownerId:string,private master:string|undefined,private active:()=>void) {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS keychain_entries(id TEXT PRIMARY KEY,data TEXT NOT NULL,envelope TEXT);
      CREATE TABLE IF NOT EXISTS keychain_writes(operation_id TEXT PRIMARY KEY,digest TEXT NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS keychain_names(operation_id TEXT PRIMARY KEY,digest TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS secure_input_requests(id TEXT PRIMARY KEY,operation_id TEXT UNIQUE NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS keychain_grants(secret_id TEXT NOT NULL,bot_id TEXT NOT NULL,data TEXT NOT NULL,signature TEXT NOT NULL,PRIMARY KEY(secret_id,bot_id));
      CREATE TABLE IF NOT EXISTS keychain_calls(operation_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,result TEXT);`);
  }
  private root():Uint8Array {
    if(!this.master||!/^[a-f0-9]{64}$/i.test(this.master))throw new ApiError(503,'keychain_unavailable','Secure credential storage is not configured.');
    return Uint8Array.from(this.master.match(/../g)!,x=>parseInt(x,16));
  }
  private encryptionKey():Promise<CryptoKey> {
    return this.key??=(async()=>crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:encoder.encode(this.ownerId),info:encoder.encode('timber.owner-keychain.v1')},await crypto.subtle.importKey('raw',this.root(),'HKDF',false,['deriveKey']),{name:'AES-GCM',length:256},false,['encrypt','decrypt']))();
  }
  private async digest(value:unknown):Promise<string> {
    const key=await crypto.subtle.importKey('raw',this.root(),{name:'HMAC',hash:'SHA-256'},false,['sign']);
    return encode(new Uint8Array(await crypto.subtle.sign('HMAC',key,encoder.encode(JSON.stringify(['timber.keychain.write.v1',this.ownerId,value])))));
  }
  private aad(entry:SecretMetadata):Uint8Array {return encoder.encode(JSON.stringify([this.ownerId,entry.id,entry.revision,entry.name,entry.origin,entry.header,entry.prefix]));}
  private row(id:string):Row|undefined{return this.storage.sql.exec<Row>('SELECT id,data,envelope FROM keychain_entries WHERE id=?',id).toArray()[0];}
  private grantRow(id:string,botId:string){return this.storage.sql.exec<{data:string;signature:string}>('SELECT data,signature FROM keychain_grants WHERE secret_id=? AND bot_id=?',id,botId).toArray()[0];}
  private matches(entry:SecretMetadata,grant:Record<string,unknown>){return entry.origin===grant.origin&&entry.header===grant.header&&entry.prefix===grant.prefix;}
  private async prepareGrant(entry:SecretMetadata,botId:string){const data=JSON.stringify({secretId:entry.id,botId,origin:entry.origin,header:entry.header,prefix:entry.prefix,epoch:crypto.randomUUID()});return {data,signature:await this.digest(['permission',data])};}
  private writeGrant(id:string,botId:string,grant:{data:string;signature:string}){this.storage.sql.exec('INSERT INTO keychain_grants(secret_id,bot_id,data,signature) VALUES(?,?,?,?) ON CONFLICT(secret_id,bot_id) DO UPDATE SET data=excluded.data,signature=excluded.signature',id,botId,grant.data,grant.signature);}
  list(botId?:string):SecretMetadata[] {
    return this.storage.sql.exec<Row>('SELECT id,data,envelope FROM keychain_entries WHERE envelope IS NOT NULL ORDER BY rowid DESC').toArray().map(row=>{
      const entry:SecretMetadata=JSON.parse(row.data),botIds=this.storage.sql.exec<{bot_id:string;data:string}>('SELECT bot_id,data FROM keychain_grants WHERE secret_id=?',entry.id).toArray().filter(grant=>this.matches(entry,JSON.parse(grant.data))).map(grant=>grant.bot_id);
      return {...entry,botIds};
    }).filter(entry=>!botId||entry.botIds.includes(botId));
  }
  async permitted(botId:string):Promise<SecretMetadata[]> {
    const entries=this.list(botId),allowed=await Promise.all(entries.map(async entry=>{try{await this.requireAccess(entry.id,botId);return true;}catch{return false;}}));
    return entries.filter((_entry,index)=>allowed[index]);
  }
  async requireAccess(id:string,botId:string):Promise<string>{
    const stored=this.row(id),grant=this.grantRow(id,botId);
    if(!stored?.envelope||!grant||JSON.parse(grant.data).secretId!==id||JSON.parse(grant.data).botId!==botId||!this.matches(JSON.parse(stored.data),JSON.parse(grant.data))||grant.signature!==await this.digest(['permission',grant.data]))throw new ApiError(403,'credential_access_denied','This bot does not have permission to use that private input. Ask the owner to grant access from their keychain.');
    if(this.grantRow(id,botId)?.data!==grant.data)throw new ApiError(409,'credential_changed','Permission changed.');
    return JSON.parse(grant.data).epoch;
  }
  permissionEpoch(id:string,botId:string):string|undefined{const row=this.grantRow(id,botId);return row?JSON.parse(row.data).epoch:undefined;}
  async grantAccess(id:string,botId:string,allowed:boolean,check:()=>void=()=>{}):Promise<void>{
    if(!allowed){this.storage.sql.exec('DELETE FROM keychain_grants WHERE secret_id=? AND bot_id=?',id,botId);return;}
    const row=this.row(id);if(!row?.envelope)throw new ApiError(404,'credential_unavailable','Private input is unavailable.');
    const grant=await this.prepareGrant(JSON.parse(row.data),botId);this.active();check();
    if(this.row(id)?.envelope!==row.envelope)throw new ApiError(409,'credential_changed','Private input changed.');
    this.writeGrant(id,botId,grant);
  }
  forgetBot(botId:string){this.storage.sql.exec('DELETE FROM keychain_grants WHERE bot_id=?',botId);for(const request of this.requests())if(request.botId===botId&&request.status==='pending'){request.status='cancelled';this.setRequest(request);}}
  requests():SecureInputRequest[] {return this.storage.sql.exec<{data:string}>("SELECT data FROM secure_input_requests ORDER BY (json_extract(data,'$.status')='pending') DESC,rowid DESC LIMIT 116").toArray().map(row=>JSON.parse(row.data));}
  request(id:string):SecureInputRequest|undefined {const row=this.storage.sql.exec<{data:string}>('SELECT data FROM secure_input_requests WHERE id=?',id).toArray()[0];return row?JSON.parse(row.data):undefined;}
  setRequest(item:SecureInputRequest):void {this.storage.sql.exec('UPDATE secure_input_requests SET data=? WHERE id=?',JSON.stringify(item),item.id);}
  hasPending(runId:string):boolean {return this.storage.sql.exec("SELECT id FROM secure_input_requests WHERE json_extract(data,'$.runId')=? AND json_extract(data,'$.status')='pending' LIMIT 1",runId).toArray().length>0;}
  requestInput(op:string,args:Record<string,unknown>,runId:string,nativeOperationId:string,botId?:string):SecureInputRequest {
    this.root();
    const details={...metadata(args,true),purpose:string(args.purpose,'purpose',500),...(args.secretId?{secretId:string(args.secretId,'secretId',36)}:{})};
    const secret=details.secretId?this.row(details.secretId):undefined;
    if(secret){const existingName=(JSON.parse(secret.data) as SecretMetadata).name;if(existingName!=='Private input'||!args.name)details.name=existingName;}
    if(details.secretId&&!secret?.envelope)throw new ApiError(404,'credential_unavailable','Private input is unavailable or revoked.');
    if(details.secretId&&!details.origin)invalid('The agent must configure an HTTPS destination before requesting access.');
    const prior=this.storage.sql.exec<{data:string}>('SELECT data FROM secure_input_requests WHERE operation_id=?',op).toArray()[0];
    if(prior) {const item:SecureInputRequest=JSON.parse(prior.data);if(Object.entries(details).some(([k,v])=>item[k as keyof SecureInputRequest]!==v))throw new ApiError(409,'idempotency_conflict','Secure request changed.');return item;}
    if(this.storage.sql.exec<{n:number}>("SELECT COUNT(*) AS n FROM secure_input_requests WHERE json_extract(data,'$.status')='pending'").one().n>=16)throw new ApiError(429,'keychain_full','Too many pending secure inputs.');
    const item:SecureInputRequest={...details,...(botId?{botId,...(details.secretId?{permissionEpoch:this.permissionEpoch(details.secretId,botId)}:{})}:{}),...(secret?{expectedRevision:(JSON.parse(secret.data) as SecretMetadata).revision}:{}),id:crypto.randomUUID(),runId,nativeOperationId,status:'pending',createdAt:now()};
    this.storage.sql.exec('INSERT INTO secure_input_requests(id,operation_id,data) VALUES(?,?,?)',item.id,op,JSON.stringify(item));return item;
  }
  /** Batch encryption completes before an atomic commit. The caller fences Stop/deletion
   * and persists any continuation in the same synchronous transaction. */
  async save(input:Record<string,unknown>,commit:(entries:SecretMetadata[],replay:boolean)=>void,grantBotId?:string,authorizeExisting=false):Promise<SecretMetadata[]> {
    const op=operationId(input.operationId),values=input.entries;
    if(!Array.isArray(values)||!values.length||values.length>4)invalid('Add between one and four secure inputs.');
    const entries=(values as unknown[]).map(value=>{const item=object(value),details=metadata(item,true),secret=string(item.value,'private input',16_000);const id=item.id===undefined?crypto.randomUUID():string(item.id,'id',36);if(!UUID.test(id))invalid('Invalid credential ID.');if(item.id!==undefined&&(!Number.isInteger(item.expectedRevision)||Number(item.expectedRevision)<1))invalid('Replacing a private input requires its current revision.');return {id,expectedRevision:item.expectedRevision,inherit:item.id!==undefined&&item.origin===undefined,...details,secret};});
    if(new Set(entries.map(item=>item.id)).size!==entries.length)invalid('Duplicate secure inputs.');
    const digest=await this.digest(input);this.active();
    const existing=()=>this.storage.sql.exec<{digest:string;data:string}>('SELECT digest,data FROM keychain_writes WHERE operation_id=?',op).toArray()[0];
    const replay=()=>{const prior=existing();if(!prior)return;if(prior.digest!==digest)throw new ApiError(409,'idempotency_conflict','This secure submission has already been used with different data.');const saved:SecretMetadata[]=JSON.parse(prior.data);commit(saved,true);return saved;};
    const prior=this.storage.transactionSync(replay);if(prior)return prior;
    const prepared=await Promise.all(entries.map(async item=>{
      const stored=this.row(item.id),old:SecretMetadata|undefined=stored?JSON.parse(stored.data):undefined;
      if(item.expectedRevision!==undefined && (!stored?.envelope||old?.revision!==item.expectedRevision))throw new ApiError(409,'credential_changed','Credential changed or was revoked. Refresh the keychain.');
      const entry:SecretMetadata={id:item.id,name:item.inherit&&old?old.name:item.name,origin:item.inherit&&old?old.origin:item.origin,header:item.inherit&&old?old.header:item.header,prefix:item.inherit&&old?old.prefix:item.prefix,revision:(old?.revision??0)+1,createdAt:old?.createdAt??now(),updatedAt:now()};
      const iv=crypto.getRandomValues(new Uint8Array(12));
      const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:this.aad(entry)},await this.encryptionKey(),encoder.encode(item.secret));
      const grant=grantBotId&&(item.expectedRevision===undefined||authorizeExisting)?await this.prepareGrant(entry,grantBotId):undefined;
      return {entry,grant,expectedRevision:item.expectedRevision,envelope:{iv:encode(iv),ciphertext:encode(new Uint8Array(encrypted))}};
    }));
    this.active();
    return this.storage.transactionSync(()=>{
      const again=replay();if(again)return again;
      if(this.list().length+prepared.filter(item=>item.expectedRevision===undefined).length>100)throw new ApiError(429,'keychain_full','Your keychain can store up to 100 private inputs.');
      for(const {entry,expectedRevision} of prepared){const stored=this.row(entry.id);if(expectedRevision===undefined?Boolean(stored):!stored?.envelope||JSON.parse(stored.data).revision!==expectedRevision)throw new ApiError(409,'credential_changed','Credential changed or was revoked. Refresh the keychain.');}
      const result=prepared.map(item=>item.entry);
      // The caller must be able to reject stale requests before any write commits.
      commit(result,false);
      for(const {entry,envelope} of prepared)this.storage.sql.exec('INSERT INTO keychain_entries(id,data,envelope) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,envelope=excluded.envelope',entry.id,JSON.stringify(entry),JSON.stringify(envelope));
      for(const item of prepared)if(item.grant&&grantBotId)this.writeGrant(item.entry.id,grantBotId,item.grant);
      this.storage.sql.exec('INSERT INTO keychain_writes(operation_id,digest,data) VALUES(?,?,?)',op,digest,JSON.stringify(result));
      return result;
    });
  }
  async rename(op:string,id:string,input:Record<string,unknown>,check:()=>void|Promise<void>=()=>{},botId?:string):Promise<SecretMetadata> {
    const name=secretName(input.name),revision=input.expectedRevision;
    if(!UUID.test(id)||!Number.isInteger(revision)||Number(revision)<1)invalid('Renaming requires the input ID and current revision.');
    const permission=botId?await this.requireAccess(id,botId):undefined;
    const key=`${botId??'owner'}:${op}`,digest=await this.digest(['rename',id,name,revision]);this.active();
    const replay=()=>{const prior=this.storage.sql.exec<{digest:string}>('SELECT digest FROM keychain_names WHERE operation_id=?',key).toArray()[0];if(prior&&prior.digest!==digest)throw new ApiError(409,'idempotency_conflict','This rename operation has already been used with different data.');return !!prior;};
    const stored=this.row(id);if(!stored?.envelope)throw new ApiError(404,'credential_unavailable','Private input is unavailable or revoked.');
    const entry:SecretMetadata=JSON.parse(stored.data);
    if(replay())return entry;
    if(entry.revision!==revision)throw new ApiError(409,'credential_changed','Private input changed. Refresh the keychain.');
    if(botId&&entry.name!=='Private input')return entry;
    if(botId&&name==='Private input')invalid('Choose a descriptive name from the conversation.');
    const envelope:Envelope=JSON.parse(stored.envelope),updated={...entry,name,revision:entry.revision+1,updatedAt:now()};
    const clear=new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:decode(envelope.iv),additionalData:this.aad(entry)},await this.encryptionKey(),decode(envelope.ciphertext)));
    const iv=crypto.getRandomValues(new Uint8Array(12));let encrypted:ArrayBuffer;
    try{encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:this.aad(updated)},await this.encryptionKey(),clear);}finally{clear.fill(0);}
    await check();this.active();
    return this.storage.transactionSync(()=>{
      const latest=this.row(id);
      if(botId&&this.permissionEpoch(id,botId)!==permission)throw new ApiError(409,'credential_changed','Permission changed.');
      if(replay()&&latest?.envelope)return JSON.parse(latest.data) as SecretMetadata;
      if(!latest?.envelope||latest.envelope!==stored.envelope)throw new ApiError(409,'credential_changed','Private input changed or was removed.');
      const result={...updated,...((JSON.parse(latest.data) as SecretMetadata).lastUsedAt?{lastUsedAt:(JSON.parse(latest.data) as SecretMetadata).lastUsedAt}:{})};
      this.storage.sql.exec('UPDATE keychain_entries SET data=?,envelope=? WHERE id=?',JSON.stringify(result),JSON.stringify({iv:encode(iv),ciphertext:encode(new Uint8Array(encrypted))}),id);
      this.storage.sql.exec('INSERT INTO keychain_names(operation_id,digest) VALUES(?,?)',key,digest);
      return result;
    });
  }
  revoke(id:string):void {const stored=this.row(id);if(!stored)throw new ApiError(404,'not_found','Credential not found.');this.storage.sql.exec('UPDATE keychain_entries SET envelope=NULL WHERE id=?',id);this.storage.sql.exec('DELETE FROM keychain_grants WHERE secret_id=?',id);}
  async authorize(request:SecureInputRequest,commit:(entries:SecretMetadata[],replay:boolean)=>void):Promise<SecretMetadata[]> {
    if(request.botId&&request.secretId&&await this.requireAccess(request.secretId,request.botId)!==request.permissionEpoch)throw new ApiError(409,'credential_changed','Permission changed.');
    const stored=request.secretId?this.row(request.secretId):undefined;
    if(!stored?.envelope)throw new ApiError(404,'credential_unavailable','Private input is unavailable or revoked.');
    const entry:SecretMetadata=JSON.parse(stored.data),envelope:Envelope=JSON.parse(stored.envelope);
    if(entry.revision!==request.expectedRevision)throw new ApiError(409,'credential_changed','Private input changed. Ask the bot to request access again.');
    const value=new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:decode(envelope.iv),additionalData:this.aad(entry)},await this.encryptionKey(),decode(envelope.ciphertext)));
    this.active();
    return this.save({operationId:`authorize:${request.id}`,entries:[{id:entry.id,expectedRevision:request.expectedRevision,name:request.name,origin:request.origin,header:request.header,prefix:request.prefix,value}]},(entries,replay)=>{if(!replay&&request.botId&&request.secretId&&this.permissionEpoch(request.secretId,request.botId)!==request.permissionEpoch)throw new ApiError(409,'credential_changed','Permission changed.');commit(entries,replay);},request.botId,true);
  }
  async call(op:string,args:Record<string,unknown>,signal:AbortSignal,canDispatch:()=>void|Promise<void>=()=>{},botId?:string):Promise<ComputerResult> {
    const id=string(args.secretId,'secretId',36),path=string(args.path,'path',2000),method=String(args.method??'GET').toUpperCase();
    if(!['GET','POST','PUT','PATCH','DELETE'].includes(method))invalid('Unsupported HTTP method.');
    if(!path.startsWith('/')||path.startsWith('//')||path.includes('\\')||/[\x00-\x20\x7f]/.test(path))invalid('Use an absolute path within the authorized origin.');
    const payload=args.body===undefined?undefined:string(args.body,'body',32_000,0);if(method==='GET'&&payload!==undefined)invalid('GET cannot include a body.');
    const stored=this.row(id);if(!stored?.envelope)throw new ApiError(404,'credential_unavailable','Credential is unavailable or revoked.');
    const permission=botId?await this.requireAccess(id,botId):undefined;
    const entry:SecretMetadata=JSON.parse(stored.data);
    if(!entry.origin)throw new ApiError(409,'credential_unconfigured','Use configure_secret to prepare this private input for the intended service. The user only confirms access; do not ask them to configure headers or URLs.');
    const url=new URL(path,entry.origin);if(url.origin!==entry.origin||url.hash)invalid('The destination must match the authorized origin.');
    const headers:Record<string,string>={accept:'application/json',...(payload===undefined?{}:{'content-type':'application/json'})};
    const publicHeaders=args.headers===undefined?{}:object(args.headers);
    if(Object.keys(publicHeaders).length>16)invalid('Use at most 16 public headers.');
    for(const [name,value] of Object.entries(publicHeaders)) {
      if(!/^[A-Za-z][A-Za-z0-9-]{0,79}$/.test(name)||name.toLowerCase()===entry.header.toLowerCase()||/^(?:authorization|cookie|set-cookie|host|content-.+|connection|transfer-encoding|proxy-.+|sec-.+|cf-.+|x-forwarded-.+)$/i.test(name)||typeof value!=='string'||value.length>1000||/[^\x20-\x7e]/.test(value))invalid('Use public API configuration headers only. Authentication headers are managed by the keychain.');
      headers[name.toLowerCase()]=value as string;
    }
    const digest=await this.digest(args);this.active();signal.throwIfAborted();
    const prior=this.storage.sql.exec<{fingerprint:string;result:string|null}>('SELECT fingerprint,result FROM keychain_calls WHERE operation_id=?',op).toArray()[0];
    if(prior){if(prior.fingerprint!==digest)throw new ApiError(409,'idempotency_conflict','Request arguments changed.');return prior.result?JSON.parse(prior.result):{operationId:op,status:'interrupted',error:'The authenticated request may have been sent. Inspect the service before making another request.'};}
    const envelope:Envelope=JSON.parse(stored.envelope);
    const clear=await crypto.subtle.decrypt({name:'AES-GCM',iv:decode(envelope.iv),additionalData:this.aad(entry)},await this.encryptionKey(),decode(envelope.ciphertext));
    const value=new TextDecoder().decode(clear);
    if(/[^\x20-\x7e]/.test(value)||value.length>8192)throw new ApiError(422,'credential_format','This private input cannot be used as a single HTTP authentication header. Request the specific API key in a new secure input.');
    this.active();signal.throwIfAborted();
    await canDispatch();signal.throwIfAborted();
    if(botId&&this.permissionEpoch(id,botId)!==permission)throw new ApiError(409,'credential_changed','Permission was revoked before dispatch.');
    if(this.row(id)?.envelope!==stored.envelope)throw new ApiError(409,'credential_changed','Credential changed before the request was sent.');
    // No await between the second replay fence and dispatch registration.
    if(this.storage.sql.exec('SELECT operation_id FROM keychain_calls WHERE operation_id=?',op).toArray().length)return {operationId:op,status:'interrupted',error:'This authenticated request is already being handled.'};
    this.storage.sql.exec('INSERT INTO keychain_calls(operation_id,fingerprint) VALUES(?,?)',op,digest);
    let result:ComputerResult;
    const timeout=new AbortController(),timer=setTimeout(()=>timeout.abort(),30_000);
    try {
      const response=await fetch(url,{method,headers:{...headers,[entry.header]:entry.prefix+value},body:payload,redirect:'manual',signal:AbortSignal.any([signal,timeout.signal])});
      if(response.status>=300&&response.status<400){await response.body?.cancel();result={operationId:op,status:'failed',error:'The service redirected the request. Credentials were not forwarded.'};}
      else {
        const reader=response.body?.getReader();let output='',size=0;const decoder=new TextDecoder();
        if(reader)while(true){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.length;if(size>64_000){await reader.cancel();throw new Error('Response too large');}output+=decoder.decode(chunk.value,{stream:true});}output+=decoder.decode();
        const variants=[value,encode(encoder.encode(value)),encodeURIComponent(value),JSON.stringify(value).slice(1,-1)];
        const redact=(text:string)=>{for(const token of variants.filter(Boolean).sort((a,b)=>b.length-a.length))text=text.split(token).join('[redacted]');return text;};
        // Service-issued tokens are also excluded when providers return JSON credentials.
        try{output=JSON.stringify(JSON.parse(output),(key,v)=>/token|secret|password|authorization|api[_-]?key|private[_-]?key|cookie/i.test(key)?'[redacted]':typeof v==='string'?redact(v):v);}catch{output=redact(output);}
        output=redact(output);
        result={operationId:op,status:response.ok?'completed':'failed',output:JSON.stringify({status:response.status,body:output}),...(!response.ok?{error:`The service returned HTTP ${response.status}.`}:{})};
      }
    }catch{result={operationId:op,status:'interrupted',error:'The authenticated request could not be confirmed. It may have reached the service; inspect its state before retrying.'};}
    finally{clearTimeout(timer);}
    this.active();
    this.storage.sql.exec('UPDATE keychain_calls SET result=? WHERE operation_id=?',JSON.stringify(result),op);
    const latest=this.row(id);if(latest?.envelope===stored.envelope)this.storage.sql.exec('UPDATE keychain_entries SET data=? WHERE id=?',JSON.stringify({...entry,lastUsedAt:now()}),id);
    return result;
  }
}

/** Bot-local projection only. Private values live exclusively in the owner store. */
export class SecureInputRequests {
  constructor(private storage:DurableObjectStorage){storage.sql.exec('CREATE TABLE IF NOT EXISTS secure_input_requests(id TEXT PRIMARY KEY,data TEXT NOT NULL)');}
  requests():SecureInputRequest[]{return this.storage.sql.exec<{data:string}>('SELECT data FROM secure_input_requests').toArray().map(row=>JSON.parse(row.data));}
  setRequest(item:SecureInputRequest){this.storage.sql.exec('INSERT INTO secure_input_requests(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',item.id,JSON.stringify(item));}
  hasPending(runId:string){return this.storage.sql.exec("SELECT id FROM secure_input_requests WHERE json_extract(data,'$.runId')=? AND json_extract(data,'$.status')='pending' LIMIT 1",runId).toArray().length>0;}
}
