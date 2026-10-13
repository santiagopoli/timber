import type {AudioAttachment, AudioTranscription, Message, Run} from '@botspace/contracts';
import type {Env} from './env';
import {ApiError, json} from './errors';
import {UUID} from './validation';
import {MAX_AUDIO_BYTES, validateAudio} from './audio-formats';

type AudioMessage = Message & {audio: AudioAttachment & {operationId:string;transcription:AudioTranscription}};
type Destination = 'message'|'dictation';
export type DictationReceipt = {operationId:string;audioId:string;transcription:Omit<AudioTranscription,'status'>&{status:AudioTranscription['status']|'cancelled'}};
type Row = {mode:Destination;expires_at:number;operation_id:string;audio_id:string;message_id:string;attempt_id:string;status:AudioTranscription['status']|'cancelled';data:string;run_id:string|null};
type UploadRow = {audio_id:string;discarded:number;expires_at:number;next_at:number|null};
const UPLOAD_TTL=86_400_000,CLEANUP_BATCH=32,CLEANUP_RETRY=60_000;
type Hooks = {
  active():void;
  botId():string;
  artifactPrefix?():string;
  authorize():Promise<void>;
  authorizeCleanup?():Promise<void>;
  save(message:Message, initial:boolean):void;
  admit(message:Message, operationId:string):Promise<Run>;
  schedule(operationId:string, delayMs:number):Promise<void>;
  waitUntil(work:Promise<unknown>):void;
};
export type AudioReceipt = {message:Message;transcription:AudioTranscription;run?:Run};
const stamp=()=>new Date().toISOString();
const invalid=()=>new ApiError(400,'invalid_audio_request','Audio, operation and attempt IDs must be UUIDs.');
export function audioId(value:unknown):string {if(typeof value!=='string'||!UUID.test(value))throw invalid();return value;}

/** Only container validation; original bytes are never decoded, rewritten or public. */
export async function uploadAudio(request:Request, files:R2Bucket, botId:string, id:string, active:()=>void, signal?:AbortSignal, authorize?:()=>Promise<void>, artifactPrefix?:string):Promise<Response> {
  active();
  if(request.headers.has('content-encoding') && request.headers.get('content-encoding')!=='identity')throw new ApiError(400,'audio_encoding_unsupported','Compressed HTTP uploads are not supported.');
  const reader=request.body?.getReader();if(!reader)throw new ApiError(400,'invalid_audio','An audio file is required.');
  const cancel=()=>{void reader.cancel().catch(()=>{});};signal?.addEventListener('abort',cancel,{once:true});
  // Coalesce network fragments into bounded slabs. Retaining every tiny read
  // would allow chunk-object overhead to exceed the nominal audio byte bound.
  let size=0,reads=0,used=0;const slabs:Uint8Array[]=[];let slab:Uint8Array|undefined;
  try {while(true) {
    const part=await reader.read();if(signal?.aborted)throw new ApiError(404,'not_found','Bot not found.');active();if(part.done)break;
    size+=part.value.length;if(size>MAX_AUDIO_BYTES)throw new ApiError(413,'audio_too_large','Audio must be at most 20 MB.');
    if(++reads>100_000)throw new ApiError(400,'invalid_audio','The audio upload has too many chunks.');
    let pos=0;while(pos<part.value.length) {
      if(!slab||used===slab.length){slab=new Uint8Array(Math.min(65_536,MAX_AUDIO_BYTES-slabs.length*65_536));slabs.push(slab);used=0;}
      const length=Math.min(slab.length-used,part.value.length-pos);slab.set(part.value.subarray(pos,pos+length),used);used+=length;pos+=length;
    }
  }} finally {signal?.removeEventListener('abort',cancel);await reader.cancel().catch(()=>{});}
  const bytes=new Uint8Array(size);let offset=0;for(const block of slabs){const length=Math.min(block.length,size-offset);bytes.set(block.subarray(0,length),offset);offset+=length;}
  const {mimeType,durationMs,extension}=validateAudio(bytes,request.headers.get('content-type')??'');
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
  await authorize?.();active();const key=`${artifactPrefix??`bots/${botId}/artifacts`}/${id}`;
  const same=(object:R2Object|null)=>object?.customMetadata?.chatAudio==='true'&&object.customMetadata.sha256===hash&&object.httpMetadata?.contentType===mimeType;
  const previous=await files.head(key);await authorize?.();active();
  if(previous&&!same(previous))throw new ApiError(409,'idempotency_conflict','Audio ID already identifies different content.');
  if(!previous) {
    const result=await files.put(key,bytes,{onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:mimeType},customMetadata:{chatAudio:'true',sha256:hash,durationMs:String(durationMs),extension}});
    if(!result&&!same(await files.head(key)))throw new ApiError(409,'idempotency_conflict','Audio ID already identifies different content.');
  }
  await authorize?.();active();return json({audio:{artifactId:id,mimeType,size,durationMs}});
}

/** Paid dispatch is deliberately separate from safe, deduplicated bot admission. */
export class AudioMessages {
  private live=new Map<string,Promise<void>>();
  private locks=new Map<string,Promise<void>>();
  private cleanup?:Promise<void>;
  private controllers=new Set<AbortController>();
  private uploads=new Set<Promise<Response>>();
  private dictationControllers=new Map<string,AbortController>();
  constructor(private storage:DurableObjectStorage,private env:Env,private hooks:Hooks) {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS audio_messages(operation_id TEXT PRIMARY KEY,audio_id TEXT NOT NULL,message_id TEXT NOT NULL,attempt_id TEXT NOT NULL,status TEXT NOT NULL,data TEXT NOT NULL,run_id TEXT);
      CREATE TABLE IF NOT EXISTS audio_attempts(attempt_id TEXT PRIMARY KEY,operation_id TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audio_uploads(audio_id TEXT PRIMARY KEY,discarded INTEGER NOT NULL DEFAULT 0,expires_at INTEGER NOT NULL,next_at INTEGER);
      CREATE INDEX IF NOT EXISTS audio_uploads_cleanup ON audio_uploads(next_at);
      CREATE TABLE IF NOT EXISTS dictation_cancellations(operation_id TEXT PRIMARY KEY,created_at INTEGER NOT NULL);`);
    const columns=storage.sql.exec<{name:string}>('PRAGMA table_info(audio_messages)').toArray();
    if(!columns.some(column=>column.name==='mode'))storage.sql.exec("ALTER TABLE audio_messages ADD COLUMN mode TEXT NOT NULL DEFAULT 'message'");
    if(!columns.some(column=>column.name==='expires_at'))storage.sql.exec('ALTER TABLE audio_messages ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0');
  }
  private locked<T>(id:string,work:()=>Promise<T>):Promise<T> {
    const result=(this.locks.get(id)??Promise.resolve()).then(work);
    const tail=result.then(()=>{},()=>{});this.locks.set(id,tail);
    void tail.then(()=>{if(this.locks.get(id)===tail)this.locks.delete(id);});return result;
  }
  private uploadRow(id:string):UploadRow|undefined {return this.storage.sql.exec<UploadRow>('SELECT * FROM audio_uploads WHERE audio_id=?',id).toArray()[0];}
  private key(id:string):string {return `${this.hooks.artifactPrefix?.()??`bots/${this.hooks.botId()}/artifacts`}/${id}`;}
  private referenced(id:string):boolean {return !!this.storage.sql.exec("SELECT 1 FROM audio_messages WHERE audio_id=? AND (mode='message' OR (status!='cancelled' AND expires_at>?)) LIMIT 1",id,Date.now()).toArray().length;}
  private cancelled(id:string):boolean {return !!this.storage.sql.exec('SELECT 1 FROM dictation_cancellations WHERE operation_id=?',id).toArray().length;}
  private current(row:Row):void {
    this.hooks.active();const latest=this.row(row.operation_id);
    if(!latest||latest.attempt_id!==row.attempt_id)throw new Error('stale audio attempt');
    if(row.mode==='dictation'&&(this.cancelled(row.operation_id)||latest.status==='cancelled'||latest.expires_at<=Date.now()))throw new Error('cancelled dictation');
  }
  private mode(row:Row|undefined,destination:Destination):void {if(row&&row.mode!==destination)throw new ApiError(409,'idempotency_conflict','Audio operation already identifies another destination.');}
  private usable(id:string):void {
    const row=this.uploadRow(id);
    if(row&&(row.discarded||!this.referenced(id)&&row.expires_at<=Date.now()))throw new ApiError(410,'audio_upload_discarded','This audio draft expired or was discarded. Attach or record a new draft.');
  }
  access(id:string):void {audioId(id);this.hooks.active();this.usable(id);}
  private async scheduleCleanup():Promise<void> {
    this.hooks.active();const next=this.storage.sql.exec<{next:number|null}>('SELECT MIN(next_at) next FROM audio_uploads').one().next;
    if(next!==null)await this.hooks.schedule('audio-transcribe:upload-cleanup',Math.max(0,next-Date.now()));
  }
  upload(request:Request,id:string):Promise<Response> {
    audioId(id);this.hooks.active();
    if(this.uploads.size)throw new ApiError(429,'audio_upload_busy','Another audio upload is in progress. Retry this upload after it finishes.');
    const botId=this.hooks.botId(),controller=new AbortController();this.controllers.add(controller);
    const active=()=>{if(controller.signal.aborted)throw new ApiError(404,'not_found','Bot not found.');this.hooks.active();};
    const work=this.locked(id,async()=>{
      active();await this.hooks.authorize();active();this.usable(id);
      if(!this.uploadRow(id)&&!this.referenced(id))this.storage.sql.exec('INSERT INTO audio_uploads(audio_id,expires_at,next_at) VALUES(?,?,?)',id,Date.now()+UPLOAD_TTL,Date.now()+UPLOAD_TTL);
      // Candidate and its recovery wake must be durable before the first R2 write.
      await this.scheduleCleanup();await this.storage.sync();active();this.usable(id);
      return uploadAudio(request,this.env.FILES,botId,id,active,controller.signal,()=>this.hooks.authorize(),this.hooks.artifactPrefix?.());
    }).finally(()=>{this.uploads.delete(work);this.controllers.delete(controller);});
    this.uploads.add(work);return work;
  }
  async discard(id:string):Promise<{audioId:string;discarded:true}> {
    audioId(id);return this.locked(id,async()=>{await (this.hooks.authorizeCleanup?.()??this.hooks.authorize());this.hooks.active();await this.discardLocked(id);return {audioId:id,discarded:true};});
  }
  private async discardLocked(id:string,finalSweep=false):Promise<void> {
    this.hooks.active();if(this.referenced(id))throw new ApiError(409,'audio_already_referenced','Saved audio messages cannot be discarded as drafts.');
    const key=this.key(id),file=await this.env.FILES.head(key);this.hooks.active();
    if(file&&file.customMetadata?.chatAudio!=='true')throw new ApiError(400,'invalid_audio_attachment','This artifact is not an audio draft.');
    this.storage.sql.exec('INSERT INTO audio_uploads(audio_id,discarded,expires_at,next_at) VALUES(?,1,?,?) ON CONFLICT(audio_id) DO UPDATE SET discarded=1,next_at=excluded.next_at',id,Date.now(),Date.now());
    // Keep a permanent tombstone, including when the R2 outcome is lost.
    await this.storage.sync();this.hooks.active();
    try {
      // A missing HEAD must not erase an image admitted concurrently in the
      // shared artifact namespace. Confirmed audio cannot be overwritten by
      // the image uploader's conditional immutable PUT.
      if(file)await this.env.FILES.delete(key);this.hooks.active();
      this.storage.sql.exec('UPDATE audio_uploads SET next_at=? WHERE audio_id=?',finalSweep?null:Date.now()+UPLOAD_TTL,id);
      await this.scheduleCleanup();
    }
    catch(error){this.hooks.active();this.storage.sql.exec('UPDATE audio_uploads SET next_at=? WHERE audio_id=?',Date.now()+CLEANUP_RETRY,id);await this.scheduleCleanup();throw error;}
  }
  processCleanup():Promise<void> {
    this.hooks.active();if(this.cleanup)return this.cleanup;
    const work=(async()=>{
      const due=this.storage.sql.exec<UploadRow>('SELECT * FROM audio_uploads WHERE next_at<=? ORDER BY next_at LIMIT ?',Date.now(),CLEANUP_BATCH).toArray();
      for(const candidate of due)await this.locked(candidate.audio_id,async()=>{
        this.hooks.active();const row=this.uploadRow(candidate.audio_id);if(!row||row.next_at===null||row.next_at>Date.now())return;
        for(const expired of this.storage.sql.exec<Row>("SELECT * FROM audio_messages WHERE audio_id=? AND mode='dictation' AND status!='cancelled' AND expires_at<=?",row.audio_id,Date.now()).toArray())this.cancelRow(expired.operation_id);
        if(this.referenced(row.audio_id)){
          const message=this.storage.sql.exec("SELECT 1 FROM audio_messages WHERE audio_id=? AND mode='message' LIMIT 1",row.audio_id).toArray().length;
          const next=message?null:this.storage.sql.exec<{next:number|null}>("SELECT MIN(expires_at) next FROM audio_messages WHERE audio_id=? AND mode='dictation' AND status!='cancelled' AND expires_at>?",row.audio_id,Date.now()).one().next;
          this.storage.sql.exec('UPDATE audio_uploads SET next_at=? WHERE audio_id=?',next,row.audio_id);return;
        }
        try {await this.discardLocked(row.audio_id,true);}
        catch(error) {
          this.hooks.active();
          if(error instanceof ApiError&&error.code==='invalid_audio_attachment')this.storage.sql.exec('UPDATE audio_uploads SET discarded=1,next_at=NULL WHERE audio_id=?',row.audio_id);
          else this.storage.sql.exec('UPDATE audio_uploads SET next_at=? WHERE audio_id=?',Date.now()+CLEANUP_RETRY,row.audio_id);
        }
      });
      await this.scheduleCleanup();
    })().finally(()=>{this.cleanup=undefined;});this.cleanup=work;return work;
  }
  private row(id:string):Row|undefined {return this.storage.sql.exec<Row>('SELECT * FROM audio_messages WHERE operation_id=?',id).toArray()[0];}
  receipt(id:string):AudioReceipt;
  receipt(id:string,destination:'dictation'):DictationReceipt;
  receipt(id:string,destination:Destination='message'):AudioReceipt|DictationReceipt {
    this.hooks.active();const row=this.row(id);if(!row){if(this.cancelled(id))throw new ApiError(destination==='dictation'?410:409,destination==='dictation'?'dictation_cancelled':'idempotency_conflict','This operation identifies a cancelled dictation.');throw new ApiError(404,'not_found','Audio message not found.');}
    this.mode(row,destination);
    if(destination==='dictation'&&row.status!=='cancelled'&&row.expires_at<=Date.now()){this.cancelRow(id);return this.receipt(id,'dictation');}
    const message=JSON.parse(row.data) as AudioMessage;
    if(destination==='dictation')return {operationId:id,audioId:row.audio_id,transcription:message.audio.transcription};
    const saved=row.run_id?this.storage.sql.exec<{data:string}>('SELECT data FROM runs WHERE id=?',row.run_id).toArray()[0]:undefined;
    return {message,transcription:message.audio.transcription,...(saved?{run:JSON.parse(saved.data) as Run}:{})};
  }
  create(input:Record<string,unknown>):Promise<AudioReceipt>;
  create(input:Record<string,unknown>,destination:'dictation'):Promise<DictationReceipt>;
  create(input:Record<string,unknown>,destination:Destination='message'):Promise<AudioReceipt|DictationReceipt> {
    const id=audioId(input.audioId);return this.locked(id,()=>this.createLocked(input,destination));
  }
  private getReceipt(id:string,destination:Destination):AudioReceipt|DictationReceipt {return destination==='dictation'?this.receipt(id,'dictation'):this.receipt(id);}
  private async createLocked(input:Record<string,unknown>,destination:Destination):Promise<AudioReceipt|DictationReceipt> {
    if(Object.keys(input).some(key=>!['operationId','audioId','attemptId'].includes(key)))throw new ApiError(400,'invalid_audio_request','Audio messages accept only audio and operation identities.');
    const id=audioId(input.operationId),artifactId=audioId(input.audioId),attemptId=audioId(input.attemptId);
    this.hooks.active();let previous=this.row(id);this.mode(previous,destination);
    if(this.cancelled(id)&&!previous&&destination==='message')throw new ApiError(409,'idempotency_conflict','Audio operation already identifies another destination.');
    if(this.cancelled(id)&&!previous)throw new ApiError(410,'dictation_cancelled','This dictation was cancelled. Record a new draft.');
    if(previous){if(previous.audio_id!==artifactId||!this.storage.sql.exec('SELECT 1 FROM audio_attempts WHERE attempt_id=? AND operation_id=?',attemptId,id).toArray().length)throw new ApiError(409,'idempotency_conflict','Audio operation already identifies different input.');return this.getReceipt(id,destination);}
    await this.hooks.authorize();this.hooks.active();this.usable(artifactId);
    const file=await this.env.FILES.head(this.key(artifactId));this.hooks.active();this.usable(artifactId);
    if(!file||file.customMetadata?.chatAudio!=='true')throw new ApiError(400,'invalid_audio_attachment','Audio does not belong to this bot.');
    await this.hooks.authorize();this.hooks.active();this.usable(artifactId);
    previous=this.row(id);if(previous)return this.createLocked(input,destination);
    if(this.cancelled(id)&&destination==='message')throw new ApiError(409,'idempotency_conflict','Audio operation already identifies another destination.');
    if(this.cancelled(id))throw new ApiError(410,'dictation_cancelled','This dictation was cancelled. Record a new draft.');
    this.checkPendingCapacity();
    if(this.storage.sql.exec('SELECT 1 FROM audio_attempts WHERE attempt_id=?',attemptId).toArray().length)throw new ApiError(409,'idempotency_conflict','Attempt ID was already used.');
    const message:AudioMessage={id:crypto.randomUUID(),botId:this.hooks.botId(),role:'user',text:'',createdAt:stamp(),audio:{operationId:id,artifactId,mimeType:file.httpMetadata!.contentType as AudioAttachment['mimeType'],size:file.size,durationMs:Number(file.customMetadata.durationMs),transcription:{attemptId,status:'pending'}}};
    this.storage.transactionSync(()=>{
      this.storage.sql.exec('INSERT INTO audio_messages(operation_id,audio_id,message_id,attempt_id,status,data,mode,expires_at) VALUES(?,?,?,?,?,?,?,?)',id,artifactId,message.id,attemptId,'pending',JSON.stringify(message),destination,Date.now()+UPLOAD_TTL);
      this.storage.sql.exec('INSERT INTO audio_attempts VALUES(?,?,?,?)',attemptId,id,'pending',stamp());
      if(destination==='message')this.hooks.save(message,true);
      this.storage.sql.exec('UPDATE audio_uploads SET next_at=? WHERE audio_id=?',destination==='dictation'?Date.now()+UPLOAD_TTL:null,artifactId);
    });
    await this.schedule(id,0);return this.getReceipt(id,destination);
  }
  retry(id:string,input:Record<string,unknown>):Promise<AudioReceipt>;
  retry(id:string,input:Record<string,unknown>,destination:'dictation'):Promise<DictationReceipt>;
  async retry(id:string,input:Record<string,unknown>,destination:Destination='message'):Promise<AudioReceipt|DictationReceipt> {
    if(Object.keys(input).some(key=>!['attemptId','acknowledgePaidRetry'].includes(key)))throw new ApiError(400,'invalid_audio_request','A retry accepts only its attempt identity and cost acknowledgement.');
    audioId(id);const attempt=audioId(input.attemptId);this.hooks.active();
    if(input.acknowledgePaidRetry!==true)throw new ApiError(400,'paid_retry_acknowledgement_required','Confirm that a new transcription attempt may incur another charge.');
    await this.hooks.authorize();this.hooks.active();
    const row=this.row(id);if(!row)throw new ApiError(404,'not_found','Audio message not found.');this.mode(row,destination);
    if(destination==='dictation'&&(this.cancelled(id)||row.expires_at<=Date.now()))throw new ApiError(410,'dictation_cancelled','This dictation was cancelled or expired.');
    const old=this.storage.sql.exec<{operation_id:string}>('SELECT operation_id FROM audio_attempts WHERE attempt_id=?',attempt).toArray()[0];
    if(old){if(old.operation_id!==id)throw new ApiError(409,'idempotency_conflict','Attempt ID was already used.');return this.getReceipt(id,destination);}
    if(!['failed','uncertain'].includes(row.status)||this.live.has(id))throw new ApiError(409,'audio_retry_unavailable','This audio is still being processed or has already been transcribed.');
    this.checkPendingCapacity();
    const message=JSON.parse(row.data) as AudioMessage;message.audio.transcription={attemptId:attempt,status:'pending'};
    this.storage.transactionSync(()=>{
      this.storage.sql.exec('INSERT INTO audio_attempts VALUES(?,?,?,?)',attempt,id,'pending',stamp());
      this.storage.sql.exec('UPDATE audio_messages SET attempt_id=?,status=?,data=? WHERE operation_id=?',attempt,'pending',JSON.stringify(message),id);
      if(row.mode==='message')this.hooks.save(message,false);
    });
    await this.schedule(id,0);return this.getReceipt(id,destination);
  }
  private checkPendingCapacity():void {
    if(this.storage.sql.exec<{n:number}>("SELECT COUNT(*) n FROM audio_messages WHERE status IN ('pending','dispatching') OR (mode='message' AND status='succeeded' AND run_id IS NULL)").one().n>=32)throw new ApiError(429,'audio_inbox_full','Wait for pending audio messages before sending another.');
  }
  private async schedule(id:string,delay:number):Promise<void> {await this.hooks.schedule(`audio-transcribe:${id}`,delay);}
  private update(row:Row,transcription:AudioTranscription):AudioMessage {
    this.current(row);const latest=this.row(row.operation_id)!;
    const message=JSON.parse(latest.data) as AudioMessage;message.audio.transcription=transcription;
    if(transcription.status==='succeeded')message.text=transcription.text!;
    this.storage.transactionSync(()=>{
      this.storage.sql.exec('UPDATE audio_messages SET status=?,data=? WHERE operation_id=? AND attempt_id=?',transcription.status,JSON.stringify(message),row.operation_id,row.attempt_id);
      this.storage.sql.exec('UPDATE audio_attempts SET status=? WHERE attempt_id=?',transcription.status,row.attempt_id);
      if(row.mode==='message')this.hooks.save(message,false);
    });return message;
  }
  recover():void {
    this.hooks.active();
    this.hooks.waitUntil(this.scheduleCleanup().catch(()=>{}));
    for(const row of this.storage.sql.exec<Row>("SELECT * FROM audio_messages WHERE status IN ('pending','dispatching') OR (mode='message' AND status='succeeded' AND run_id IS NULL)").toArray()) {
      if(row.mode==='dictation'&&(this.cancelled(row.operation_id)||row.expires_at<=Date.now())){this.cancelRow(row.operation_id);continue;}
      if(this.live.has(row.operation_id))continue;
      if(row.status==='dispatching')this.update(row,{attemptId:row.attempt_id,status:'uncertain',errorCode:'audio_transcription_uncertain',error:'The previous transcription outcome is unknown. It was not sent again. An explicit retry may incur another charge.'});
      else this.hooks.waitUntil(this.schedule(row.operation_id,0).catch(()=>{}));
    }
  }
  process(id:string):Promise<void> {
    this.hooks.active();const previous=this.live.get(id);if(previous)return previous;
    if(this.live.size)return this.schedule(id,1000);
    const work=this.processOnce(id).finally(()=>this.live.delete(id));this.live.set(id,work);return work;
  }
  private async processOnce(id:string):Promise<void> {
    let row=this.row(id);if(!row)return;
    if(row.mode==='dictation'&&(this.cancelled(id)||row.status==='cancelled'||row.expires_at<=Date.now())){this.cancelRow(id);return;}
    const active=()=>this.current(row!);
    if(row.status==='dispatching'){this.update(row,{attemptId:row.attempt_id,status:'uncertain',errorCode:'audio_transcription_uncertain',error:'The previous transcription outcome is unknown. It was not sent again. An explicit retry may incur another charge.'});return;}
    if(row.status==='succeeded'){await this.admit(row);return;}
    if(row.status!=='pending')return;
    if(!this.env.OPENAI_API_KEY){this.update(row,{attemptId:row.attempt_id,status:'failed',errorCode:'audio_transcription_unconfigured',error:'Audio saved. OpenAI transcription is not configured on the server.'});return;}
    try {await this.hooks.authorize();active();}catch {try {active();await this.schedule(id,1000);}catch{}return;}
    let file:R2ObjectBody|null;
    try {file=await this.env.FILES.get(this.key(row.audio_id));active();}
    catch {return this.schedule(id,1000);}
    if(!file||file.customMetadata?.chatAudio!=='true'){this.update(row,{attemptId:row.attempt_id,status:'failed',errorCode:'audio_unavailable',error:'The saved audio is unavailable.'});return;}
    let bytes:ArrayBuffer;
    try {bytes=await file.arrayBuffer();active();if(bytes.byteLength>MAX_AUDIO_BYTES)throw new Error('size');}
    catch {return this.schedule(id,1000);}
    try {await this.hooks.authorize();active();}catch {try {active();await this.schedule(id,1000);}catch{}return;}
    const form=new FormData();form.set('file',new Blob([bytes],{type:file.httpMetadata!.contentType}),`audio.${file.customMetadata.extension}`);form.set('model','gpt-4o-mini-transcribe');form.set('response_format','json');
    const controller=new AbortController();this.controllers.add(controller);if(row.mode==='dictation')this.dictationControllers.set(id,controller);
    const timeout=setTimeout(()=>controller.abort(),120_000);
    try {
      // Flush the paid dispatch marker to durable storage before any network I/O.
      this.update(row,{attemptId:row.attempt_id,status:'dispatching'});
      await this.storage.sync();
      // Registry removal precedes final BotDO cleanup. Recheck after the flush
      // yielded, immediately before starting the paid request (without a lease).
      await this.hooks.authorize();active();
      const response=await fetch('https://api.openai.com/v1/audio/transcriptions',{method:'POST',headers:{authorization:`Bearer ${this.env.OPENAI_API_KEY}`},body:form,redirect:'manual',signal:controller.signal});
      try {await this.hooks.authorize();active();}
      catch {await response.body?.cancel().catch(()=>{});throw new Error('authorization');}
      if(!response.ok){await response.body?.cancel();await this.hooks.authorize();active();const uncertain=response.status>=500||response.status<400;this.update(row,{attemptId:row.attempt_id,status:uncertain?'uncertain':'failed',errorCode:uncertain?'audio_transcription_uncertain':'audio_transcription_rejected',error:uncertain?'The transcription outcome is unknown. No automatic retry was made.':'OpenAI did not accept this transcription. Audio was saved; no automatic retry was made.'});return;}
      const reader=response.body?.getReader();if(!reader)throw new Error('response');
      const cancelBody=()=>{void reader.cancel().catch(()=>{});};controller.signal.addEventListener('abort',cancelBody,{once:true});
      let body='',size=0;const decoder=new TextDecoder();
      try {while(true){const part=await reader.read();active();if(controller.signal.aborted)throw new Error("aborted");if(part.done)break;size+=part.value.length;if(size>131_072)throw new Error('response');body+=decoder.decode(part.value,{stream:true});}body+=decoder.decode();}
      finally {controller.signal.removeEventListener('abort',cancelBody);await reader.cancel().catch(()=>{});}
      // Reading the provider body yielded too: never publish a late transcript
      // after registry revocation, even if final local cleanup is still pending.
      await this.hooks.authorize();active();
      const value=JSON.parse(body) as {text?:unknown};
      if(typeof value.text!=='string'||!value.text.trim()||value.text.length>32_000||value.text.includes(this.env.OPENAI_API_KEY)){this.update(row,{attemptId:row.attempt_id,status:'failed',errorCode:'audio_transcription_empty_or_invalid',error:'OpenAI returned no usable transcript. The original audio is saved.'});return;}
      // Only real provider text can enter the bot. Never synthesize silence or diagnostics.
      this.update(row,{attemptId:row.attempt_id,status:'succeeded',text:value.text});
      row=this.row(id)!;
    } catch {
      try {if(this.row(id)?.status==='dispatching')this.update(row,{attemptId:row.attempt_id,status:'uncertain',errorCode:'audio_transcription_uncertain',error:'The transcription outcome is unknown. It was not sent again. An explicit retry may incur another charge.'});}catch{/* Deletion is a permanent fence. */}
      return;
    } finally {clearTimeout(timeout);this.controllers.delete(controller);this.dictationControllers.delete(id);}
    await this.admit(row);
  }
  private async admit(row:Row):Promise<void> {
    if(row.mode==='dictation'||row.run_id)return;
    try {
      await this.hooks.authorize();this.hooks.active();const message=JSON.parse(row.data) as AudioMessage;
      // Admission commits the original message/run association atomically. If
      // only this journal pointer was lost, reconcile it without reopening a
      // configuration failure or asking the normal inbox to submit again.
      const committed=this.storage.sql.exec<{data:string}>('SELECT data FROM messages WHERE id=?',row.message_id).toArray()[0];
      const saved=committed?JSON.parse(committed.data) as Message:undefined;
      if(saved?.runId && this.storage.sql.exec('SELECT 1 FROM runs WHERE id=? AND operation_id=?',saved.runId,`audio:${row.operation_id}`).toArray().length) {
        this.storage.sql.exec('UPDATE audio_messages SET run_id=?,data=? WHERE operation_id=? AND attempt_id=?',saved.runId,JSON.stringify(saved),row.operation_id,row.attempt_id);return;
      }
      const run=await this.hooks.admit(message,`audio:${row.operation_id}`);this.hooks.active();
      // Bot admission atomically associates the original message with its run.
      const updated=JSON.parse(this.storage.sql.exec<{data:string}>('SELECT data FROM messages WHERE id=?',row.message_id).one().data) as Message;
      this.storage.sql.exec('UPDATE audio_messages SET run_id=?,data=? WHERE operation_id=? AND attempt_id=?',run.id,JSON.stringify(updated),row.operation_id,row.attempt_id);
    } catch {try {this.hooks.active();await this.schedule(row.operation_id,1000);}catch{/* deleted */}}
  }
  private cancelRow(id:string):void {
    this.hooks.active();const row=this.row(id);this.mode(row,'dictation');
    this.storage.transactionSync(()=>{
      this.storage.sql.exec('INSERT OR IGNORE INTO dictation_cancellations VALUES(?,?)',id,Date.now());
      if(row) {
        const message=JSON.parse(row.data) as AudioMessage;message.text='';
        message.audio.transcription={attemptId:row.attempt_id,status:'cancelled'} as unknown as AudioTranscription;
        this.storage.sql.exec("UPDATE audio_messages SET status='cancelled',data=? WHERE operation_id=?",JSON.stringify(message),id);
        this.storage.sql.exec("UPDATE audio_attempts SET status='cancelled' WHERE attempt_id=?",row.attempt_id);
        this.storage.sql.exec('UPDATE audio_uploads SET next_at=? WHERE audio_id=?',Date.now(),row.audio_id);
      }
    });
    this.dictationControllers.get(id)?.abort();
  }
  async cancel(id:string):Promise<DictationReceipt|{operationId:string;cancelled:true}> {
    audioId(id);await (this.hooks.authorizeCleanup?.()??this.hooks.authorize());this.hooks.active();this.cancelRow(id);
    await this.storage.sync();await this.scheduleCleanup();
    return this.row(id)?this.receipt(id,'dictation'):{operationId:id,cancelled:true};
  }
  async cancelPendingDictations():Promise<void> {
    this.hooks.active();
    for(const row of this.storage.sql.exec<Row>("SELECT * FROM audio_messages WHERE mode='dictation' AND status IN ('pending','dispatching')").toArray())this.cancelRow(row.operation_id);
    await this.storage.sync();await this.scheduleCleanup();
  }
  async stop():Promise<void> {
    for(const controller of this.controllers)controller.abort();
    await Promise.allSettled([...this.live.values(),...this.uploads,...this.locks.values(),...(this.cleanup?[this.cleanup]:[])]);
  }
}
