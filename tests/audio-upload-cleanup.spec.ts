import {env,exports} from 'cloudflare:workers';
import {runInDurableObject} from 'cloudflare:test';
import {expect,it,vi,afterEach} from 'vitest';
import type {Env} from '../apps/api/src/env';
import {AudioMessages} from '../apps/api/src/audio-messages';
const bindings=env as unknown as Env,token='test-only-botspace-owner-token-000000';
const api=(path:string,method='GET',body?:unknown)=>exports.default.fetch(`https://botspace.test${path}`,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
function wav(){const b=new Uint8Array(3244),v=new DataView(b.buffer),s=(p:number,t:string)=>b.set(new TextEncoder().encode(t),p);s(0,'RIFF');v.setUint32(4,3236,true);s(8,'WAVE');s(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,16000,true);v.setUint32(28,32000,true);v.setUint16(32,2,true);v.setUint16(34,16,true);s(36,'data');v.setUint32(40,3200,true);return b;}
const request=()=>new Request('https://bot/audio',{method:'PUT',headers:{'content-type':'audio/wav'},body:wav()});
async function bot(){return(await(await api('/v1/bots','POST',{name:'Upload cleanup fixture'})).json<{bot:{id:string}}>()).bot;}
const input=(id:string)=>({audioId:id,operationId:crypto.randomUUID(),attemptId:crypto.randomUUID()});
function defer(){let resolve!:()=>void;return {promise:new Promise<void>(r=>{resolve=r;}),resolve:()=>resolve()};}
afterEach(()=>vi.unstubAllGlobals());
async function inside(work:(journal:AudioMessages,state:DurableObjectState,id:string,scheduled:[string,number][],make:(files?:R2Bucket)=>AudioMessages)=>Promise<void>){
 const b=await bot(),stub=bindings.BOT.get(bindings.BOT.idFromName(`owner:${b.id}`));
 await runInDurableObject(stub,async(_,state)=>{
  const scheduled:[string,number][]=[];
  const make=(files=bindings.FILES)=>new AudioMessages(state.storage,{...bindings,FILES:files,OPENAI_API_KEY:undefined},{active:()=>{},botId:()=>b.id,authorize:async()=>{},save:()=>{},admit:async()=>{throw new Error('No inference/admission in cleanup fixtures');},schedule:async(id,delay)=>{scheduled.push([id,delay]);},waitUntil:work=>{void work;}});
  await work(make(),state,b.id,scheduled,make);
 });
}
function proxy(files:R2Bucket,overrides:Record<string,unknown>):R2Bucket{return new Proxy(files,{get(bucket,name){if(typeof name==='string'&&name in overrides)return overrides[name];const value=Reflect.get(bucket,name,bucket);return typeof value==='function'?value.bind(bucket):value;}});}

it('journals before uncertain R2 PUT and recovers expired orphan bytes with permanent admission/upload/access fences',async()=>inside(async(_,state,bid,scheduled,make)=>{
 const id=crypto.randomUUID(),key=`bots/${bid}/artifacts/${id}`;
 const files=proxy(bindings.FILES,{put:async(...args:Parameters<R2Bucket['put']>)=>{
  expect(state.storage.sql.exec('SELECT 1 FROM audio_uploads WHERE audio_id=?',id).toArray()).toHaveLength(1);
  expect(scheduled.some(([key])=>key==='audio-transcribe:upload-cleanup')).toBe(true);
  await bindings.FILES.put(...args);throw new Error('lost PUT receipt');
 }});
 await expect(make(files).upload(request(),id)).rejects.toThrow('lost PUT receipt');expect(await bindings.FILES.head(key)).not.toBeNull();
 state.storage.sql.exec('UPDATE audio_uploads SET expires_at=0,next_at=0 WHERE audio_id=?',id);
 const restored=make();await expect(restored.create(input(id))).rejects.toMatchObject({code:'audio_upload_discarded'});restored.recover();await restored.processCleanup();
 expect(await bindings.FILES.head(key)).toBeNull();expect(()=>restored.access(id)).toThrow();
 await expect(restored.upload(request(),id)).rejects.toMatchObject({code:'audio_upload_discarded'});await expect(restored.create(input(id))).rejects.toMatchObject({code:'audio_upload_discarded'});
 expect(state.storage.sql.exec<{n:number}>('SELECT COUNT(*) n FROM audio_messages').one().n).toBe(0);
 expect(state.storage.sql.exec<{discarded:number}>('SELECT discarded FROM audio_uploads WHERE audio_id=?',id).one().discarded).toBe(1);
}));

it('serializes pending upload, message admission and discard without deleting an admitted original',async()=>inside(async(_,state,bid,_scheduled,make)=>{
 const id=crypto.randomUUID(),key=`bots/${bid}/artifacts/${id}`,reached=defer(),release=defer();
 const journal=make(proxy(bindings.FILES,{put:async(...args:Parameters<R2Bucket['put']>)=>{reached.resolve();await release.promise;return bindings.FILES.put(...args);}}));
 const uploading=journal.upload(request(),id);await reached.promise;
 let createDone=false,discardDone=false;const payload=input(id),creating=journal.create(payload).then(value=>{createDone=true;return value;});
 const discarding=journal.discard(id).catch(error=>{discardDone=true;return error;});await Promise.resolve();expect(createDone).toBe(false);expect(discardDone).toBe(false);
 release.resolve();await uploading;expect((await creating).message.audio?.artifactId).toBe(id);expect(await discarding).toMatchObject({code:'audio_already_referenced'});
 state.storage.sql.exec('UPDATE audio_uploads SET expires_at=0,next_at=0 WHERE audio_id=?',id);await journal.processCleanup();
 expect(await bindings.FILES.head(key)).not.toBeNull();expect(journal.receipt(payload.operationId).transcription.status).toBe('pending');journal.access(id);
 expect((await journal.create(payload)).message.id).toBe(journal.receipt(payload.operationId).message.id);
}));

it('a queued discard before admission tombstones the identity and rejects delayed creates',async()=>inside(async(journal,state,bid)=>{
 const id=crypto.randomUUID();await journal.upload(request(),id);
 const deleting=journal.discard(id),creating=journal.create(input(id)).catch(error=>error);
 expect(await deleting).toEqual({audioId:id,discarded:true});expect(await creating).toMatchObject({code:'audio_upload_discarded'});
 expect(await bindings.FILES.head(`bots/${bid}/artifacts/${id}`)).toBeNull();expect(await journal.discard(id)).toEqual({audioId:id,discarded:true});
 expect(state.storage.sql.exec<{n:number}>('SELECT COUNT(*) n FROM audio_attempts').one().n).toBe(0);
}));

it('retains deletion journal on R2 failure and recovers in bounded batches without paid calls',async()=>inside(async(_,state,bid,scheduled,make)=>{
 const id=crypto.randomUUID(),key=`bots/${bid}/artifacts/${id}`,normal=make();await normal.upload(request(),id);
 const failing=make(proxy(bindings.FILES,{delete:async()=>{throw new Error('temporary R2 failure');}}));
 await expect(failing.discard(id)).rejects.toThrow('temporary R2 failure');expect(await bindings.FILES.head(key)).not.toBeNull();
 expect(state.storage.sql.exec<{discarded:number;next_at:number}>('SELECT discarded,next_at FROM audio_uploads WHERE audio_id=?',id).one()).toMatchObject({discarded:1,next_at:expect.any(Number)});
 state.storage.sql.exec('UPDATE audio_uploads SET next_at=0 WHERE audio_id=?',id);const restored=make();restored.recover();await restored.processCleanup();expect(await bindings.FILES.head(key)).toBeNull();
 for(let i=0;i<34;i++)state.storage.sql.exec('INSERT INTO audio_uploads(audio_id,expires_at,next_at) VALUES(?,0,0)',crypto.randomUUID());
 const fetch=vi.fn();vi.stubGlobal('fetch',fetch);await restored.processCleanup();
 expect(state.storage.sql.exec<{n:number}>('SELECT COUNT(*) n FROM audio_uploads WHERE next_at=0').one().n).toBe(2);expect(scheduled.at(-1)).toEqual(['audio-transcribe:upload-cleanup',0]);
 await restored.processCleanup();expect(state.storage.sql.exec<{n:number}>('SELECT COUNT(*) n FROM audio_uploads WHERE next_at IS NOT NULL').one().n).toBe(0);expect(fetch).not.toHaveBeenCalled();
}));

it('DELETE is authenticated, bot isolated, and never deletes an image using the shared artifact namespace',async()=>{
 const own=await bot(),other=await bot(),id=crypto.randomUUID(),path=`/v1/bots/${own.id}/audio/${id}`;
 expect((await exports.default.fetch(`https://botspace.test${path}`,{method:'DELETE'})).status).toBe(401);
 expect((await exports.default.fetch(`https://botspace.test${path}`,{method:'PUT',headers:{authorization:`Bearer ${token}`,'content-type':'audio/wav'},body:wav()})).status).toBe(200);
 expect((await api(`/v1/bots/${other.id}/audio/${id}`,'DELETE')).status).toBe(200);expect(await bindings.FILES.head(`bots/${own.id}/artifacts/${id}`)).not.toBeNull();
 expect((await api(path,'DELETE')).status).toBe(200);expect((await api(`/v1/bots/${own.id}/artifacts/${id}`)).status).toBe(404);
 // Simulate an arbitrarily late object write: tombstone still denies its bytes.
 await bindings.FILES.put(`bots/${own.id}/artifacts/${id}`,wav(),{httpMetadata:{contentType:'audio/wav'},customMetadata:{chatAudio:'true'}});
 expect((await api(`/v1/bots/${own.id}/artifacts/${id}`)).status).toBe(404);
 const image=crypto.randomUUID(),key=`bots/${own.id}/artifacts/${image}`;await bindings.FILES.put(key,new Uint8Array([1,2,3]),{httpMetadata:{contentType:'image/png'},customMetadata:{chatImage:'true'}});
 expect((await api(`/v1/bots/${own.id}/audio/${image}`,'DELETE')).status).toBe(400);expect(await bindings.FILES.head(key)).not.toBeNull();
 expect((await exports.default.fetch(`https://botspace.test/v1/bots/${own.id}/audio/${image}`,{method:'PUT',headers:{authorization:`Bearer ${token}`,'content-type':'audio/wav'},body:wav()})).status).toBe(409);
 const stub=bindings.BOT.get(bindings.BOT.idFromName(`owner:${own.id}`));
 await runInDurableObject(stub,async(instance,state)=>{
  state.storage.sql.exec('UPDATE audio_uploads SET expires_at=0,next_at=0 WHERE audio_id=?',image);
  await(instance as unknown as {audio():AudioMessages}).audio().processCleanup();
  expect(state.storage.sql.exec<{discarded:number;next_at:number|null}>('SELECT discarded,next_at FROM audio_uploads WHERE audio_id=?',image).one()).toEqual({discarded:1,next_at:null});
 });
 expect(await bindings.FILES.head(key)).not.toBeNull();
});

it('a missing audio HEAD never deletes an image that lands while the tombstone flush yields',async()=>inside(async(journal,state,bid)=>{
 const id=crypto.randomUUID(),key=`bots/${bid}/artifacts/${id}`;let inserted=false;
 (journal as unknown as {storage:DurableObjectStorage}).storage=new Proxy(state.storage,{get(storage,name){
  if(name==='sync')return async()=>{await storage.sync();if(!inserted){inserted=true;await bindings.FILES.put(key,new Uint8Array([9,8,7]),{httpMetadata:{contentType:'image/png'},customMetadata:{chatImage:'true'}});}};
  const value=Reflect.get(storage,name,storage);return typeof value==='function'?value.bind(storage):value;
 }});
 expect(await journal.discard(id)).toEqual({audioId:id,discarded:true});expect((await bindings.FILES.head(key))?.customMetadata?.chatImage).toBe('true');
 state.storage.sql.exec('UPDATE audio_uploads SET next_at=0 WHERE audio_id=?',id);await journal.processCleanup();
 expect((await bindings.FILES.head(key))?.customMetadata?.chatImage).toBe('true');expect(state.storage.sql.exec<{next_at:number|null}>('SELECT next_at FROM audio_uploads WHERE audio_id=?',id).one().next_at).toBeNull();
}));
