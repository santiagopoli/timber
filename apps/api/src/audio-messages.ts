import type {AudioAttachment, AudioTranscription, Message, Run} from '@botspace/contracts';
import type {Env} from './env';
import {ApiError, json} from './errors';
import {UUID} from './validation';
import {MAX_AUDIO_BYTES, validateAudio} from './audio-formats';

type AudioMessage = Message & {audio: AudioAttachment & {operationId:string;transcription:AudioTranscription}};
type Row = {operation_id:string;audio_id:string;message_id:string;attempt_id:string;status:AudioTranscription['status'];data:string;run_id:string|null};
type Hooks = {
  active():void;
  botId():string;
  authorize():Promise<void>;
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
export async function uploadAudio(request:Request, files:R2Bucket, botId:string, id:string, active:()=>void, signal?:AbortSignal):Promise<Response> {
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
  active();const key=`bots/${botId}/artifacts/${id}`;
  const same=(object:R2Object|null)=>object?.customMetadata?.chatAudio==='true'&&object.customMetadata.sha256===hash&&object.httpMetadata?.contentType===mimeType;
  const previous=await files.head(key);active();
  if(previous&&!same(previous))throw new ApiError(409,'idempotency_conflict','Audio ID already identifies different content.');
  if(!previous) {
    const result=await files.put(key,bytes,{onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:mimeType},customMetadata:{chatAudio:'true',sha256:hash,durationMs:String(durationMs),extension}});
    if(!result&&!same(await files.head(key)))throw new ApiError(409,'idempotency_conflict','Audio ID already identifies different content.');
  }
  active();return json({audio:{artifactId:id,mimeType,size,durationMs}});
}

/** Paid dispatch is deliberately separate from safe, deduplicated bot admission. */
export class AudioMessages {
  private live=new Map<string,Promise<void>>();
  private controllers=new Set<AbortController>();
  private uploads=new Set<Promise<Response>>();
  constructor(private storage:DurableObjectStorage,private env:Env,private hooks:Hooks) {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS audio_messages(operation_id TEXT PRIMARY KEY,audio_id TEXT NOT NULL,message_id TEXT NOT NULL,attempt_id TEXT NOT NULL,status TEXT NOT NULL,data TEXT NOT NULL,run_id TEXT);
      CREATE TABLE IF NOT EXISTS audio_attempts(attempt_id TEXT PRIMARY KEY,operation_id TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL);`);
  }
  upload(request:Request,id:string):Promise<Response> {
    if(this.uploads.size)throw new ApiError(429,'audio_upload_busy','Another audio upload is in progress. Retry this upload after it finishes.');
    const botId=this.hooks.botId(),controller=new AbortController();this.controllers.add(controller);
    const work=uploadAudio(request,this.env.FILES,botId,id,()=>this.hooks.active(),controller.signal).finally(()=>{this.uploads.delete(work);this.controllers.delete(controller);});
    this.uploads.add(work);return work;
  }
  private row(id:string):Row|undefined {return this.storage.sql.exec<Row>('SELECT * FROM audio_messages WHERE operation_id=?',id).toArray()[0];}
  receipt(id:string):AudioReceipt {
    this.hooks.active();const row=this.row(id);if(!row)throw new ApiError(404,'not_found','Audio message not found.');
    const message=JSON.parse(row.data) as AudioMessage;
    const saved=row.run_id?this.storage.sql.exec<{data:string}>('SELECT data FROM runs WHERE id=?',row.run_id).toArray()[0]:undefined;
    return {message,transcription:message.audio.transcription,...(saved?{run:JSON.parse(saved.data) as Run}:{})};
  }
  async create(input:Record<string,unknown>):Promise<AudioReceipt> {
    if(Object.keys(input).some(key=>!['operationId','audioId','attemptId'].includes(key)))throw new ApiError(400,'invalid_audio_request','Audio messages accept only audio and operation identities.');
    const id=audioId(input.operationId),artifactId=audioId(input.audioId),attemptId=audioId(input.attemptId);
    this.hooks.active();let previous=this.row(id);
    if(previous){if(previous.audio_id!==artifactId||!this.storage.sql.exec('SELECT 1 FROM audio_attempts WHERE attempt_id=? AND operation_id=?',attemptId,id).toArray().length)throw new ApiError(409,'idempotency_conflict','Audio operation already identifies different input.');return this.receipt(id);}
    const file=await this.env.FILES.head(`bots/${this.hooks.botId()}/artifacts/${artifactId}`);this.hooks.active();
    if(!file||file.customMetadata?.chatAudio!=='true')throw new ApiError(400,'invalid_audio_attachment','Audio does not belong to this bot.');
    previous=this.row(id);if(previous)return this.create(input);
    this.checkPendingCapacity();
    if(this.storage.sql.exec('SELECT 1 FROM audio_attempts WHERE attempt_id=?',attemptId).toArray().length)throw new ApiError(409,'idempotency_conflict','Attempt ID was already used.');
    const message:AudioMessage={id:crypto.randomUUID(),botId:this.hooks.botId(),role:'user',text:'',createdAt:stamp(),audio:{operationId:id,artifactId,mimeType:file.httpMetadata!.contentType as AudioAttachment['mimeType'],size:file.size,durationMs:Number(file.customMetadata.durationMs),transcription:{attemptId,status:'pending'}}};
    this.storage.transactionSync(()=>{
      this.storage.sql.exec('INSERT INTO audio_messages(operation_id,audio_id,message_id,attempt_id,status,data) VALUES(?,?,?,?,?,?)',id,artifactId,message.id,attemptId,'pending',JSON.stringify(message));
      this.storage.sql.exec('INSERT INTO audio_attempts VALUES(?,?,?,?)',attemptId,id,'pending',stamp());
      this.hooks.save(message,true);
    });
    await this.schedule(id,0);return this.receipt(id);
  }
  async retry(id:string,input:Record<string,unknown>):Promise<AudioReceipt> {
    if(Object.keys(input).some(key=>!['attemptId','acknowledgePaidRetry'].includes(key)))throw new ApiError(400,'invalid_audio_request','A retry accepts only its attempt identity and cost acknowledgement.');
    audioId(id);const attempt=audioId(input.attemptId);this.hooks.active();
    if(input.acknowledgePaidRetry!==true)throw new ApiError(400,'paid_retry_acknowledgement_required','Confirm that a new transcription attempt may incur another charge.');
    const row=this.row(id);if(!row)throw new ApiError(404,'not_found','Audio message not found.');
    const old=this.storage.sql.exec<{operation_id:string}>('SELECT operation_id FROM audio_attempts WHERE attempt_id=?',attempt).toArray()[0];
    if(old){if(old.operation_id!==id)throw new ApiError(409,'idempotency_conflict','Attempt ID was already used.');return this.receipt(id);}
    if(!['failed','uncertain'].includes(row.status)||this.live.has(id))throw new ApiError(409,'audio_retry_unavailable','This audio is still being processed or has already been transcribed.');
    this.checkPendingCapacity();
    const message=JSON.parse(row.data) as AudioMessage;message.audio.transcription={attemptId:attempt,status:'pending'};
    this.storage.transactionSync(()=>{
      this.storage.sql.exec('INSERT INTO audio_attempts VALUES(?,?,?,?)',attempt,id,'pending',stamp());
      this.storage.sql.exec('UPDATE audio_messages SET attempt_id=?,status=?,data=? WHERE operation_id=?',attempt,'pending',JSON.stringify(message),id);
      this.hooks.save(message,false);
    });
    await this.schedule(id,0);return this.receipt(id);
  }
  private checkPendingCapacity():void {
    if(this.storage.sql.exec<{n:number}>("SELECT COUNT(*) n FROM audio_messages WHERE status IN ('pending','dispatching') OR (status='succeeded' AND run_id IS NULL)").one().n>=32)throw new ApiError(429,'audio_inbox_full','Wait for pending audio messages before sending another.');
  }
  private async schedule(id:string,delay:number):Promise<void> {await this.hooks.schedule(`audio-transcribe:${id}`,delay);}
  private update(row:Row,transcription:AudioTranscription):AudioMessage {
    this.hooks.active();const latest=this.row(row.operation_id);
    if(!latest||latest.attempt_id!==row.attempt_id)throw new Error('stale audio attempt');
    const message=JSON.parse(latest.data) as AudioMessage;message.audio.transcription=transcription;
    if(transcription.status==='succeeded')message.text=transcription.text!;
    this.storage.transactionSync(()=>{
      this.storage.sql.exec('UPDATE audio_messages SET status=?,data=? WHERE operation_id=? AND attempt_id=?',transcription.status,JSON.stringify(message),row.operation_id,row.attempt_id);
      this.storage.sql.exec('UPDATE audio_attempts SET status=? WHERE attempt_id=?',transcription.status,row.attempt_id);
      this.hooks.save(message,false);
    });return message;
  }
  recover():void {
    this.hooks.active();
    for(const row of this.storage.sql.exec<Row>("SELECT * FROM audio_messages WHERE status IN ('pending','dispatching') OR (status='succeeded' AND run_id IS NULL)").toArray()) {
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
    if(row.status==='dispatching'){this.update(row,{attemptId:row.attempt_id,status:'uncertain',errorCode:'audio_transcription_uncertain',error:'The previous transcription outcome is unknown. It was not sent again. An explicit retry may incur another charge.'});return;}
    if(row.status==='succeeded'){await this.admit(row);return;}
    if(row.status!=='pending')return;
    if(!this.env.OPENAI_API_KEY){this.update(row,{attemptId:row.attempt_id,status:'failed',errorCode:'audio_transcription_unconfigured',error:'Audio saved. OpenAI transcription is not configured on the server.'});return;}
    try {await this.hooks.authorize();this.hooks.active();}catch {try {this.hooks.active();await this.schedule(id,1000);}catch{}return;}
    let file:R2ObjectBody|null;
    try {file=await this.env.FILES.get(`bots/${this.hooks.botId()}/artifacts/${row.audio_id}`);this.hooks.active();}
    catch {return this.schedule(id,1000);}
    if(!file||file.customMetadata?.chatAudio!=='true'){this.update(row,{attemptId:row.attempt_id,status:'failed',errorCode:'audio_unavailable',error:'The saved audio is unavailable.'});return;}
    let bytes:ArrayBuffer;
    try {bytes=await file.arrayBuffer();this.hooks.active();if(bytes.byteLength>MAX_AUDIO_BYTES)throw new Error('size');}
    catch {return this.schedule(id,1000);}
    try {await this.hooks.authorize();this.hooks.active();}catch {try {this.hooks.active();await this.schedule(id,1000);}catch{}return;}
    const form=new FormData();form.set('file',new Blob([bytes],{type:file.httpMetadata!.contentType}),`audio.${file.customMetadata.extension}`);form.set('model','gpt-4o-mini-transcribe');form.set('response_format','json');
    const controller=new AbortController();this.controllers.add(controller);
    const timeout=setTimeout(()=>controller.abort(),120_000);
    try {
      // Flush the paid dispatch marker to durable storage before any network I/O.
      this.update(row,{attemptId:row.attempt_id,status:'dispatching'});
      await this.storage.sync();
      // Registry removal precedes final BotDO cleanup. Recheck after the flush
      // yielded, immediately before starting the paid request (without a lease).
      await this.hooks.authorize();this.hooks.active();
      const response=await fetch('https://api.openai.com/v1/audio/transcriptions',{method:'POST',headers:{authorization:`Bearer ${this.env.OPENAI_API_KEY}`},body:form,redirect:'manual',signal:controller.signal});
      try {await this.hooks.authorize();this.hooks.active();}
      catch {await response.body?.cancel().catch(()=>{});throw new Error('authorization');}
      if(!response.ok){await response.body?.cancel();await this.hooks.authorize();this.hooks.active();const uncertain=response.status>=500||response.status<400;this.update(row,{attemptId:row.attempt_id,status:uncertain?'uncertain':'failed',errorCode:uncertain?'audio_transcription_uncertain':'audio_transcription_rejected',error:uncertain?'The transcription outcome is unknown. No automatic retry was made.':'OpenAI did not accept this transcription. Audio was saved; no automatic retry was made.'});return;}
      const reader=response.body?.getReader();if(!reader)throw new Error('response');
      let body='',size=0;const decoder=new TextDecoder();
      try {while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>131_072)throw new Error('response');body+=decoder.decode(part.value,{stream:true});}body+=decoder.decode();}
      finally {await reader.cancel().catch(()=>{});}
      // Reading the provider body yielded too: never publish a late transcript
      // after registry revocation, even if final local cleanup is still pending.
      await this.hooks.authorize();this.hooks.active();
      const value=JSON.parse(body) as {text?:unknown};
      if(typeof value.text!=='string'||!value.text.trim()||value.text.length>32_000||value.text.includes(this.env.OPENAI_API_KEY)){this.update(row,{attemptId:row.attempt_id,status:'failed',errorCode:'audio_transcription_empty_or_invalid',error:'OpenAI returned no usable transcript. The original audio is saved.'});return;}
      // Only real provider text can enter the bot. Never synthesize silence or diagnostics.
      this.update(row,{attemptId:row.attempt_id,status:'succeeded',text:value.text});
      row=this.row(id)!;
    } catch {
      try {if(this.row(id)?.status==='dispatching')this.update(row,{attemptId:row.attempt_id,status:'uncertain',errorCode:'audio_transcription_uncertain',error:'The transcription outcome is unknown. It was not sent again. An explicit retry may incur another charge.'});}catch{/* Deletion is a permanent fence. */}
      return;
    } finally {clearTimeout(timeout);this.controllers.delete(controller);}
    await this.admit(row);
  }
  private async admit(row:Row):Promise<void> {
    if(row.run_id)return;
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
  async stop():Promise<void> {
    for(const controller of this.controllers)controller.abort();
    await Promise.allSettled([...this.live.values(),...this.uploads]);
  }
}
