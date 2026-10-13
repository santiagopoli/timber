import {env,exports} from 'cloudflare:workers';
import {runInDurableObject} from 'cloudflare:test';
import {afterEach,describe,expect,it,vi} from 'vitest';
import type {Bot,Task} from '@botspace/contracts';
import type {Env} from '../apps/api/src/env';
import {AudioMessages,type DictationReceipt} from '../apps/api/src/audio-messages';
const bindings=env as unknown as Env,token='test-only-botspace-owner-token-000000';
const api=async(path:string,init:RequestInit={})=>{
  const response=await exports.default.fetch(`https://botspace.test${path}`,{...init,headers:{authorization:`Bearer ${token}`,'content-type':'application/json',...init.headers}});
  return new Response(await response.arrayBuffer(),{status:response.status,headers:response.headers});
};
function wav(){const b=new Uint8Array(3244),v=new DataView(b.buffer),s=(o:number,t:string)=>b.set(new TextEncoder().encode(t),o);s(0,'RIFF');v.setUint32(4,b.length-8,true);s(8,'WAVE');s(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,16000,true);v.setUint32(28,32000,true);v.setUint16(32,2,true);v.setUint16(34,16,true);s(36,'data');v.setUint32(40,3200,true);return b;}
const ids=()=>({audioId:crypto.randomUUID(),operationId:crypto.randomUUID(),attemptId:crypto.randomUUID()});
const post=(path:string,value:unknown)=>api(path,{method:'POST',body:JSON.stringify(value)});
const upload=(base:string,id:string,task=false)=>api(`${base}/${task?'dictation-audio':'audio'}/${id}`,{method:'PUT',headers:{'content-type':'audio/wav'},body:wav()});
async function bot(){return (await (await post('/v1/bots',{name:'Draft dictation'})).json<{bot:Bot}>()).bot;}
async function task(b:Bot){const response=await post('/v1/tasks',{botId:b.id,operationId:crypto.randomUUID(),title:'Draft task',description:'',startImmediately:false});expect(response.status).toBe(201);return (await response.json<{task:Task}>()).task;}
const stub=(id:string,task=false)=>bindings.BOT.get(bindings.BOT.idFromName(task?`owner:task:${id}`:`owner:${id}`));
afterEach(()=>vi.unstubAllGlobals());
type Harness={journal:AudioMessages;state:DurableObjectState;bid:string;save:ReturnType<typeof vi.fn>;admit:ReturnType<typeof vi.fn>;make:(authorize?:()=>Promise<void>)=>AudioMessages};
async function harness(work:(h:Harness)=>Promise<void>){
  const b=await bot();await runInDurableObject(stub(b.id),async(_,state)=>{
    const save=vi.fn(),admit=vi.fn(async()=>{throw new Error('Dictation must never admit');});
    const make=(authorize:()=>Promise<void>=async()=>{})=>new AudioMessages(state.storage,{...bindings,OPENAI_API_KEY:'fixture-key-not-real'},{active:()=>{},botId:()=>b.id,authorize,save,admit,schedule:async()=>{},waitUntil:()=>{}});
    await work({journal:make(),make,state,bid:b.id,save,admit});
    expect(save).not.toHaveBeenCalled();expect(admit).not.toHaveBeenCalled();
    for(const table of ['messages','runs','submissions'])expect(state.storage.sql.exec<{n:number}>(`SELECT COUNT(*) n FROM ${table}`).one().n).toBe(0);
  });
}
async function fixture(journal:AudioMessages){const input=ids();await journal.upload(new Request('https://bot/audio',{method:'PUT',headers:{'content-type':'audio/wav'},body:wav()}),input.audioId);await journal.create(input,'dictation');return input;}

describe('draft-only paid transcription journal with fixture responses',()=>{
  it('journals destination and dispatch before one paid request; success/replay/recovery never saves messages or admits runs',async()=>harness(async({journal,state,make})=>{
    const input=await fixture(journal),fetch=vi.fn(async()=>{
      expect(state.storage.sql.exec<{mode:string;status:string}>('SELECT mode,status FROM audio_messages WHERE operation_id=?',input.operationId).one()).toEqual({mode:'dictation',status:'dispatching'});
      return Response.json({text:'Editable provider transcript.'});
    });vi.stubGlobal('fetch',fetch);
    await journal.process(input.operationId);await journal.process(input.operationId);
    const recovered=make();recovered.recover();await recovered.process(input.operationId);
    expect(await recovered.create(input,'dictation')).toEqual({operationId:input.operationId,audioId:input.audioId,transcription:{attemptId:input.attemptId,status:'succeeded',text:'Editable provider transcript.'}});
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(recovered.retry(input.operationId,{attemptId:crypto.randomUUID(),acknowledgePaidRetry:true},'dictation')).rejects.toMatchObject({code:'audio_retry_unavailable'});
  }));
  it('conflicts across destination modes on create/get/retry/delete without affecting a saved audio message',async()=>{
    const b=await bot(),input=ids(),base=`/v1/bots/${b.id}`;await upload(base,input.audioId);
    expect((await post(`${base}/dictations`,input)).status).toBe(202);
    expect((await post(`${base}/audio-messages`,input)).status).toBe(409);
    expect((await api(`${base}/audio-messages/${input.operationId}`)).status).toBe(409);
    expect((await post(`${base}/audio-messages/${input.operationId}/retry`,{attemptId:crypto.randomUUID(),acknowledgePaidRetry:true})).status).toBe(409);
    const messageInput=ids();await upload(base,messageInput.audioId);
    expect((await post(`${base}/audio-messages`,messageInput)).status).toBe(202);
    expect((await post(`${base}/dictations`,messageInput)).status).toBe(409);
    expect((await api(`${base}/dictations/${messageInput.operationId}`,{method:'DELETE'})).status).toBe(409);
    expect((await api(`${base}/audio/${messageInput.audioId}`,{method:'DELETE'})).status).toBe(409);
    expect(await bindings.FILES.head(`bots/${b.id}/artifacts/${messageInput.audioId}`)).not.toBeNull();
  });
  it('uncertain requests do not pay again on replay/recovery; explicit new attempt plus acknowledgement pays once',async()=>harness(async({journal,make,state})=>{
    const input=await fixture(journal),fetch=vi.fn(async():Promise<Response>=>{throw new Error('private-provider-error');});vi.stubGlobal('fetch',fetch);
    await journal.process(input.operationId);expect(journal.receipt(input.operationId,'dictation').transcription.status).toBe('uncertain');
    const recovered=make();recovered.recover();await recovered.process(input.operationId);await recovered.create(input,'dictation');expect(fetch).toHaveBeenCalledTimes(1);
    await expect(recovered.retry(input.operationId,{attemptId:crypto.randomUUID()},'dictation')).rejects.toMatchObject({code:'paid_retry_acknowledgement_required'});
    const retry={attemptId:crypto.randomUUID(),acknowledgePaidRetry:true};await recovered.retry(input.operationId,retry,'dictation');await recovered.retry(input.operationId,retry,'dictation');
    fetch.mockImplementation(async()=>Response.json({text:'Recovered text.'}));await recovered.process(input.operationId);
    expect(fetch).toHaveBeenCalledTimes(2);expect(state.storage.sql.exec<{n:number}>('SELECT COUNT(*) n FROM audio_attempts').one().n).toBe(2);
    expect(JSON.stringify(recovered.receipt(input.operationId,'dictation'))).not.toContain('private-provider-error');
  }));
  it('interrupted dispatch remains uncertain after recovery without network',async()=>harness(async({journal,state,make})=>{
    const input=await fixture(journal);state.storage.sql.exec("UPDATE audio_messages SET status='dispatching' WHERE operation_id=?",input.operationId);
    const fetch=vi.fn();vi.stubGlobal('fetch',fetch);const recovered=make();recovered.recover();await recovered.process(input.operationId);
    expect(recovered.receipt(input.operationId,'dictation').transcription.status).toBe('uncertain');expect(fetch).not.toHaveBeenCalled();
  }));
  it('permanently cancels before create, before dispatch and after success; no late retry resurrection',async()=>harness(async({journal,make})=>{
    const unknown=ids();await journal.cancel(unknown.operationId);
    await journal.upload(new Request('https://bot/audio',{method:'PUT',headers:{'content-type':'audio/wav'},body:wav()}),unknown.audioId);
    await expect(journal.create(unknown,'dictation')).rejects.toMatchObject({code:'dictation_cancelled'});
    const pending=await fixture(journal);await journal.cancel(pending.operationId);
    const fetch=vi.fn(async()=>Response.json({text:'Text before cancel.'}));vi.stubGlobal('fetch',fetch);await journal.process(pending.operationId);expect(fetch).not.toHaveBeenCalled();
    const success=await fixture(journal);await journal.process(success.operationId);await journal.cancel(success.operationId);
    expect(journal.receipt(success.operationId,'dictation').transcription).toEqual({attemptId:success.attemptId,status:'cancelled'});
    await expect(make().retry(success.operationId,{attemptId:crypto.randomUUID(),acknowledgePaidRetry:true},'dictation')).rejects.toMatchObject({code:'dictation_cancelled'});
    expect(await make().create(success,'dictation')).toMatchObject({transcription:{status:'cancelled'}});
    await make().process(success.operationId);expect(fetch).toHaveBeenCalledTimes(1);
  }));
  it.each(['response','body'] as const)('abort + cancellation tombstone discards late provider %s text',async boundary=>harness(async({journal,make})=>{
    const input=await fixture(journal);let signal:AbortSignal|undefined;
    const fetch=vi.fn(async(_url:RequestInfo|URL,init?:RequestInit)=>{
      signal=init?.signal??undefined;
      if(boundary==='response'){await journal.cancel(input.operationId);return Response.json({text:'Never inserted.'});}
      const stream=new ReadableStream<Uint8Array>({async pull(controller){await journal.cancel(input.operationId);try{controller.enqueue(new TextEncoder().encode('{"text":"Never inserted."}'));controller.close();}catch{/* cancelled body */}}},{highWaterMark:0});
      return new Response(stream);
    });vi.stubGlobal('fetch',fetch);await journal.process(input.operationId);
    expect(signal?.aborted).toBe(true);expect(journal.receipt(input.operationId,'dictation').transcription).toEqual({attemptId:input.attemptId,status:'cancelled'});
    make().recover();await make().process(input.operationId);expect(fetch).toHaveBeenCalledTimes(1);
  }));
  it.each(['response','body'] as const)('live authorization revocation at provider %s never publishes text or pays again',async boundary=>harness(async({make})=>{
    let revoked=false;const journal=make(async()=>{if(revoked)throw new Error('membership revoked');}),input=await fixture(journal);
    const fetch=vi.fn(async()=>{
      if(boundary==='response'){revoked=true;return Response.json({text:'Never published.'});}
      return new Response(new ReadableStream<Uint8Array>({pull(controller){revoked=true;controller.enqueue(new TextEncoder().encode('{"text":"Never published."}'));controller.close();}},{highWaterMark:0}));
    });vi.stubGlobal('fetch',fetch);await journal.process(input.operationId);
    expect(journal.receipt(input.operationId,'dictation').transcription).toMatchObject({status:'uncertain'});expect(journal.receipt(input.operationId,'dictation').transcription.text).toBeUndefined();
    await journal.process(input.operationId);expect(fetch).toHaveBeenCalledTimes(1);
  }));
  it('Stop cancels pending/dispatching drafts but retains completed editable receipts',async()=>harness(async({journal})=>{
    const completed=await fixture(journal);vi.stubGlobal('fetch',vi.fn(async()=>Response.json({text:'Retain this result.'})));await journal.process(completed.operationId);
    const pending=await fixture(journal);await journal.cancelPendingDictations();
    expect(journal.receipt(pending.operationId,'dictation').transcription.status).toBe('cancelled');
    expect(journal.receipt(completed.operationId,'dictation').transcription.text).toBe('Retain this result.');
  }));
  it('cancel/TTL release only dictation references while protecting message/image artifacts',async()=>harness(async({journal,bid,state})=>{
    const input=await fixture(journal);await journal.cancel(input.operationId);await journal.processCleanup();
    expect(await bindings.FILES.head(`bots/${bid}/artifacts/${input.audioId}`)).toBeNull();
    const expired=await fixture(journal);state.storage.sql.exec('UPDATE audio_messages SET expires_at=? WHERE operation_id=?',Date.now()-1,expired.operationId);state.storage.sql.exec('UPDATE audio_uploads SET next_at=? WHERE audio_id=?',Date.now()-1,expired.audioId);await journal.processCleanup();
    expect(journal.receipt(expired.operationId,'dictation').transcription.status).toBe('cancelled');expect(await bindings.FILES.head(`bots/${bid}/artifacts/${expired.audioId}`)).toBeNull();
    const imageId=crypto.randomUUID();await bindings.FILES.put(`bots/${bid}/artifacts/${imageId}`,'image fixture',{customMetadata:{chatImage:'true'}});
    await expect(journal.discard(imageId)).rejects.toMatchObject({code:'invalid_audio_attachment'});expect(await bindings.FILES.head(`bots/${bid}/artifacts/${imageId}`)).not.toBeNull();
  }));
  it('legacy journal rows default to message destination after schema migration',async()=>{
    const b=await bot();await runInDurableObject(stub(b.id),(_,state)=>{
      state.storage.sql.exec('DROP TABLE IF EXISTS audio_messages');state.storage.sql.exec('CREATE TABLE audio_messages(operation_id TEXT PRIMARY KEY,audio_id TEXT NOT NULL,message_id TEXT NOT NULL,attempt_id TEXT NOT NULL,status TEXT NOT NULL,data TEXT NOT NULL,run_id TEXT)');
      const input=ids();state.storage.sql.exec('INSERT INTO audio_messages VALUES(?,?,?,?,?,?,NULL)',input.operationId,input.audioId,crypto.randomUUID(),input.attemptId,'failed','{}');
      new AudioMessages(state.storage,bindings,{active:()=>{},botId:()=>b.id,authorize:async()=>{},save:()=>{},admit:async()=>{throw new Error('not used');},schedule:async()=>{},waitUntil:()=>{}});
      expect(state.storage.sql.exec<{mode:string}>('SELECT mode FROM audio_messages WHERE operation_id=?',input.operationId).one().mode).toBe('message');
    });
  });
});

describe('owner-scoped main and task dictation routes',()=>{
  it('supports canonical draft create/get/delete without a run, and preserves normal editable text admission later',async()=>{
    const b=await bot(),base=`/v1/bots/${b.id}`,input=ids();expect((await upload(base,input.audioId)).status).toBe(200);
    const response=await post(`${base}/dictations`,input);expect(response.status).toBe(202);const receipt=await response.json<DictationReceipt>();
    expect(receipt.operationId).toBe(input.operationId);expect(receipt.audioId).toBe(input.audioId);expect(receipt).not.toHaveProperty('message');expect(receipt).not.toHaveProperty('run');
    expect((await api(`${base}/dictations/${input.operationId}`)).status).toBe(200);
    expect(await (await api(`${base}/messages`)).json()).toMatchObject({messages:[]});
    expect(await (await api(`${base}/runs`)).json()).toMatchObject({runs:[]});
    expect((await api(`${base}/dictations/${input.operationId}`,{method:'DELETE'})).status).toBe(200);
    const sent=await post(`${base}/messages`,{operationId:crypto.randomUUID(),text:'User-edited dictation sent explicitly.'});expect(sent.status).toBe(202);expect(await sent.json()).toHaveProperty('run');
  });
  it('enforces authentication, bot/task upload isolation and permanent pre-create cancellation without dispatch',async()=>{
    const b=await bot(),t=await task(b),other=await task(b),main=`/v1/bots/${b.id}`,base=`/v1/tasks/${t.id}`,input=ids();
    const unauthorized=await exports.default.fetch(`https://botspace.test${base}/dictations`,{method:'POST',body:JSON.stringify(input)});expect(unauthorized.status).toBe(401);await unauthorized.text();
    expect((await upload(base,input.audioId,true)).status).toBe(200);
    expect(await bindings.FILES.head(`bots/${b.id}/tasks/${t.id}/dictation-audio/${input.audioId}`)).not.toBeNull();expect(await bindings.FILES.head(`bots/${b.id}/artifacts/${input.audioId}`)).toBeNull();
    expect((await post(`${main}/dictations`,input)).status).toBe(400);
    expect((await post(`/v1/tasks/${other.id}/dictations`,input)).status).toBe(400);
    expect((await post(`${base}/dictations`,input)).status).toBe(202);expect(await (await api(`${base}/messages`)).json()).toMatchObject({messages:[]});
    expect(await (await api(`${main}/messages`)).json()).toMatchObject({messages:[]});
    expect((await api(`${base}/dictations/${input.operationId}`,{method:'DELETE'})).status).toBe(200);
    expect((await api(`${base}/dictation-audio/${input.audioId}`,{method:'DELETE'})).status).toBe(200);
    const next=ids();expect((await api(`${base}/dictations/${next.operationId}`,{method:'DELETE'})).status).toBe(200);await upload(base,next.audioId,true);
    expect((await post(`${base}/dictations`,next)).status).toBe(410);
    expect((await post(`${base}/audio-messages`,next)).status).toBe(400);
    expect((await post(`/v1/tasks/${t.id}/cancel`,{})).status).toBe(200);
    expect((await post(`${base}/dictations`,ids())).status).toBe(409);
    expect((await api(`${base}/dictation-audio/${next.audioId}`,{method:'DELETE'})).status).toBe(200);
  });
  it('rechecks task assignment/live bot authority before transcription effects',async()=>{
    const b=await bot(),t=await task(b),base=`/v1/tasks/${t.id}`,input=ids();await upload(base,input.audioId,true);
    const otherBot=await bot(),direct=await stub(t.id,true).fetch(new Request('https://task/dictations',{method:'POST',headers:{'x-botspace-config':encodeURIComponent(JSON.stringify(otherBot)),'x-timber-task-id':t.id,'content-type':'application/json'},body:JSON.stringify(input)}));
    expect([403,404]).toContain(direct.status);await direct.text();
    expect((await api(`/v1/bots/${b.id}`,{method:'DELETE'})).status).toBe(200);
    expect((await post(`${base}/dictations`,input)).status).toBe(404);
    expect(await bindings.FILES.head(`bots/${b.id}/tasks/${t.id}/dictation-audio/${input.audioId}`)).toBeNull();
  });
});
