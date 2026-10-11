import {env, exports} from 'cloudflare:workers';
import {runInDurableObject} from 'cloudflare:test';
import {afterEach,describe,it,expect,vi} from 'vitest';
import type {AudioTranscription,Message,Run} from '@botspace/contracts';
import type {Env} from '../apps/api/src/env';
import {AudioMessages} from '../apps/api/src/audio-messages';
const token='test-only-botspace-owner-token-000000';
const api=(path:string,init:RequestInit={})=>exports.default.fetch(`https://botspace.test${path}`,{...init,headers:{authorization:`Bearer ${token}`,'content-type':'application/json',...init.headers}});
function wav():Uint8Array {const b=new Uint8Array(44+3200),v=new DataView(b.buffer),s=(offset:number,text:string)=>b.set(new TextEncoder().encode(text),offset);s(0,'RIFF');v.setUint32(4,b.length-8,true);s(8,'WAVE');s(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,16000,true);v.setUint32(28,32000,true);v.setUint16(32,2,true);v.setUint16(34,16,true);s(36,'data');v.setUint32(40,3200,true);return b;}
async function bot(){return (await (await api('/v1/bots',{method:'POST',body:JSON.stringify({name:'Audio'})})).json<{bot:{id:string}}>()).bot;}
const upload=(id:string,audioId:string,bytes=wav(),type='audio/wav')=>api(`/v1/bots/${id}/audio/${audioId}`,{method:'PUT',headers:{'content-type':type},body:bytes});
afterEach(()=>vi.unstubAllGlobals());

describe('authenticated immutable audio API',()=>{
  it('checks auth, membership, HTTP encoding, magic/MIME, size and immutable IDs',async()=>{
    const b=await bot(),other=await bot(),id=crypto.randomUUID();
    expect((await exports.default.fetch(`https://botspace.test/v1/bots/${b.id}/audio/${id}`,{method:'PUT',body:wav()})).status).toBe(401);
    expect((await upload(crypto.randomUUID(),id)).status).toBe(404);
    expect((await upload(b.id,id,new Uint8Array([1,2]),'audio/wav')).status).toBe(400);
    expect((await upload(b.id,id,wav(),'audio/mpeg')).status).toBe(400);
    expect((await api(`/v1/bots/${b.id}/audio/${id}`,{method:'PUT',headers:{'content-type':'audio/wav','content-encoding':'gzip'},body:wav()})).status).toBe(400);
    expect((await upload(b.id,id,new Uint8Array(20_000_001))).status).toBe(413);
    const first=await upload(b.id,id);expect(first.status).toBe(200);expect(await first.json()).toMatchObject({audio:{artifactId:id,mimeType:'audio/wav',size:3244,durationMs:100}});
    expect((await upload(b.id,id)).status).toBe(200);
    const changed=wav();changed[44]=1;expect((await upload(b.id,id,changed)).status).toBe(409);
    expect((await api(`/v1/bots/${other.id}/artifacts/${id}`)).status).toBe(404);
    const bytes=await api(`/v1/bots/${b.id}/artifacts/${id}`);expect(bytes.headers.get('cache-control')).toBe('private, no-store');expect(new Uint8Array(await bytes.arrayBuffer())).toEqual(wav());
    expect((await api(`/v1/bots/${other.id}/audio-messages`,{method:'POST',body:JSON.stringify({audioId:id,operationId:crypto.randomUUID(),attemptId:crypto.randomUUID()})})).status).toBe(400);
  });
  it('retains and deduplicates original audio when transcription is unconfigured; retry requires fresh IDs and acknowledged cost',async()=>{
    const b=await bot(),audioId=crypto.randomUUID(),operationId=crypto.randomUUID(),attemptId=crypto.randomUUID();await upload(b.id,audioId);
    const payload={audioId,operationId,attemptId},path=`/v1/bots/${b.id}/audio-messages`;
    const send=()=>api(path,{method:'POST',body:JSON.stringify(payload)});
    expect((await send()).status).toBe(202);expect((await send()).status).toBe(202);
    const stub=(env as unknown as Env).BOT.get((env as unknown as Env).BOT.idFromName(`owner:${b.id}`));
    await runInDurableObject(stub,async(instance)=>{await (instance as unknown as {audio():AudioMessages}).audio().process(operationId);});
    const receipt=await (await api(`${path}/${operationId}`)).json<{message:Message;transcription:AudioTranscription}>();
    expect(receipt.message.text).toBe('');expect(receipt.transcription).toMatchObject({attemptId,status:'failed',errorCode:'audio_transcription_unconfigured'});
    const messages=await (await api(`/v1/bots/${b.id}/messages`)).json<{messages:Message[]}>();expect(messages.messages.filter(m=>m.role==='user')).toHaveLength(1);expect(messages.messages[0].audio?.artifactId).toBe(audioId);
    const runs=await (await api(`/v1/bots/${b.id}/runs`)).json<{runs:Run[]}>();expect(runs.runs).toHaveLength(0);
    expect((await api(`${path}/${operationId}/retry`,{method:'POST',body:JSON.stringify({attemptId:crypto.randomUUID()})})).status).toBe(400);
    // An old attempt's duplicate receipt is safe; it does not pay again.
    expect((await api(`${path}/${operationId}/retry`,{method:'POST',body:JSON.stringify({attemptId,acknowledgePaidRetry:true})})).status).toBe(202);
    expect((await api(path,{method:'POST',body:JSON.stringify({...payload,attemptId:crypto.randomUUID()})})).status).toBe(409);
    expect((await api(`/v1/bots/${b.id}/messages`,{method:'POST',body:JSON.stringify({text:'override',operationId:`audio:${operationId}`})})).status).toBe(400);
  });
  it('hands a successful transcript to actual BotDO admission once without a second user bubble',async()=>{
    const b=await bot(),audioId=crypto.randomUUID(),operationId=crypto.randomUUID(),attemptId=crypto.randomUUID();await upload(b.id,audioId);
    await api(`/v1/bots/${b.id}/audio-messages`,{method:'POST',body:JSON.stringify({audioId,operationId,attemptId})});
    const stub=(env as unknown as Env).BOT.get((env as unknown as Env).BOT.idFromName(`owner:${b.id}`));
    await runInDurableObject(stub,async(instance,state)=>{
      const audio=(instance as unknown as {audio():AudioMessages}).audio();
      (audio as unknown as {env:Env}).env={...(env as unknown as Env),OPENAI_API_KEY:'mock-key-not-real'};
      const fetch=vi.fn(async()=>Response.json({text:'Provider transcription input.'}));vi.stubGlobal('fetch',fetch);
      await audio.process(operationId);
      // Simulate losing only the post-admission journal pointer. The ordinary
      // BotDO receipt must reconcile under the same native input identity.
      state.storage.sql.exec('UPDATE audio_messages SET run_id=NULL WHERE operation_id=?',operationId);
      await audio.process(operationId);expect(fetch).toHaveBeenCalledTimes(1);
      const received=await state.storage.get<{text:string}>(`fixture-runtime:audio:${operationId}`);expect(received?.text).toBe('Provider transcription input.');
      expect(state.storage.sql.exec<{n:number}>("SELECT COUNT(*) n FROM messages WHERE json_extract(data,'$.role')='user'").one().n).toBe(1);
      expect(state.storage.sql.exec<{n:number}>('SELECT COUNT(*) n FROM runs WHERE operation_id=?',`audio:${operationId}`).one().n).toBe(1);
    });
    const result=await (await api(`/v1/bots/${b.id}/messages`)).json<{messages:Message[]}>();const user=result.messages.find(m=>m.role==='user');expect(user).toMatchObject({text:'Provider transcription input.',runId:expect.any(String),audio:{artifactId:audioId,transcription:{status:'succeeded'}}});
  });
  it.each(['flush','response'] as const)('actual live registry revocation at %s prevents paid dispatch or late transcript publication before local cleanup',async boundary=>{
    const b=await bot(),audioId=crypto.randomUUID(),operationId=crypto.randomUUID(),attemptId=crypto.randomUUID();await upload(b.id,audioId);
    await api(`/v1/bots/${b.id}/audio-messages`,{method:'POST',body:JSON.stringify({audioId,operationId,attemptId})});
    const bindings=env as unknown as Env,stub=bindings.BOT.get(bindings.BOT.idFromName(`owner:${b.id}`));
    await runInDurableObject(stub,async(instance,state)=>{
      const target=instance as unknown as {audio():AudioMessages;env:Env},audio=target.audio();(audio as unknown as {env:Env}).env={...target.env,OPENAI_API_KEY:'mock-key-not-real'};
      // DO stubs must be created inside the issuing DO's I/O context, not in
      // the outer test runner. Otherwise a fixture I/O error masks revocation.
      const workspace=target.env.WORKSPACE.get(target.env.WORKSPACE.idFromName('owner'));let revoked=false;
      const revoke=async()=>{
        await runInDurableObject(workspace,(_,owner)=>{owner.storage.sql.exec('INSERT INTO bot_deletions(id,next_at) VALUES(?,?)',b.id,Date.now()+86_400_000);owner.storage.sql.exec('DELETE FROM bots WHERE id=?',b.id);});
        const removed=await workspace.fetch(`https://workspace/${b.id}`);expect(removed.status).toBe(404);await removed.body?.cancel();revoked=true;
      };
      if(boundary==='flush') (audio as unknown as {storage:DurableObjectStorage}).storage=new Proxy(state.storage,{get(storage,key){if(key==='sync')return async()=>{await storage.sync();await revoke();};const value=Reflect.get(storage,key,storage);return typeof value==='function'?value.bind(storage):value;}});
      const fetch=vi.fn(async()=>{if(boundary==='response')await revoke();return Response.json({text:'Must not be published after membership removal.'});});vi.stubGlobal('fetch',fetch);
      await audio.process(operationId);expect(revoked).toBe(true);expect(fetch).toHaveBeenCalledTimes(boundary==='flush'?0:1);expect(audio.receipt(operationId).transcription.status).toBe('uncertain');expect(audio.receipt(operationId).message.text).toBe('');
      expect(state.storage.sql.exec<{n:number}>('SELECT COUNT(*) n FROM runs').one().n).toBe(0);
      // Deletion's durable owner fence is set but local cleanup is deferred.
      // Actual registry revocation alone must fence the paid effect/completion.
      expect(await target.env.FILES.head(`bots/${b.id}/artifacts/${audioId}`)).not.toBeNull();
      audio.recover();await audio.process(operationId);expect(fetch).toHaveBeenCalledTimes(boundary==='flush'?0:1);
    });
    vi.unstubAllGlobals();expect((await api(`/v1/bots/${b.id}/audio-messages/${operationId}`)).status).toBe(404);
  });
  it('deletion fences late admission and removes original audio bytes',async()=>{
    const b=await bot(),audioId=crypto.randomUUID(),operationId=crypto.randomUUID(),attemptId=crypto.randomUUID();await upload(b.id,audioId);
    await api(`/v1/bots/${b.id}/audio-messages`,{method:'POST',body:JSON.stringify({audioId,operationId,attemptId})});
    const deleted=await api(`/v1/bots/${b.id}`,{method:'DELETE'});expect(deleted.status).toBe(200);
    expect((await api(`/v1/bots/${b.id}/audio-messages/${operationId}`)).status).toBe(404);
    expect((await api(`/v1/bots/${b.id}/audio/${audioId}`,{method:'PUT',headers:{'content-type':'audio/wav'},body:wav()})).status).toBe(404);
    expect(await (env as unknown as Env).FILES.head(`bots/${b.id}/artifacts/${audioId}`)).toBeNull();
    const stub=(env as unknown as Env).BOT.get((env as unknown as Env).BOT.idFromName(`owner:${b.id}`));
    expect((await stub.fetch('https://bot/audio-messages/'+operationId)).status).toBe(404);
  });
});

async function journalTest(work:(journal:AudioMessages,state:DurableObjectState,bid:string,admissions:Message[],make:()=>AudioMessages)=>Promise<void>){
  const b=await bot(),stub=(env as unknown as Env).BOT.get((env as unknown as Env).BOT.idFromName(`owner:${b.id}`));
  await runInDurableObject(stub,async(_,state)=>{
    const admissions:Message[]=[];let live=true;
    const make=()=>new AudioMessages(state.storage,{...(env as unknown as Env),OPENAI_API_KEY:'test-key-no-real-secret'},{
      active:()=>{if(!live)throw new Error('deleted');},botId:()=>b.id,authorize:async()=>{},
      save:(message)=>state.storage.sql.exec('INSERT INTO messages(id,source_key,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',message.id,`test-audio:${message.audio!.operationId}`,JSON.stringify(message)),
      admit:async(message,operationId)=>{admissions.push(message);const run:Run={id:crypto.randomUUID(),botId:b.id,operationId,model:'@cf/test/mock',status:'queued',createdAt:message.createdAt,updatedAt:message.createdAt};state.storage.sql.exec('INSERT OR IGNORE INTO runs(id,operation_id,fingerprint,native_operation_id,data) VALUES(?,?,?,?,?)',run.id,operationId,'test',operationId,JSON.stringify(run));message.runId=run.id;state.storage.sql.exec('UPDATE messages SET data=? WHERE id=?',JSON.stringify(message),message.id);return run;},
      schedule:async()=>{},waitUntil:()=>{},
    });
    await work(make(),state,b.id,admissions,make);live=false;
  });
}
async function fixture(journal:AudioMessages,bid:string){const audioId=crypto.randomUUID(),operationId=crypto.randomUUID(),attemptId=crypto.randomUUID();await journal.upload(new Request('https://bot/audio',{method:'PUT',headers:{'content-type':'audio/wav'},body:wav()}),audioId);await journal.create({audioId,operationId,attemptId});return {audioId,operationId,attemptId};}

describe('paid audio journal without real API calls',()=>{
  it('persists dispatch before exact multipart POST; admits provider transcript only once across replays/recovery',async()=>journalTest(async(journal,state,bid,admissions,make)=>{
    const input=await fixture(journal,bid),fetch=vi.fn(async(url:RequestInfo|URL,init?:RequestInit)=>{
      expect(String(url)).toBe('https://api.openai.com/v1/audio/transcriptions');expect(init?.method).toBe('POST');expect(init?.redirect).toBe('manual');expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-key-no-real-secret');
      expect(state.storage.sql.exec<{status:string}>('SELECT status FROM audio_messages WHERE operation_id=?',input.operationId).one().status).toBe('dispatching');
      const form=init?.body as FormData;expect(form.get('model')).toBe('gpt-4o-mini-transcribe');expect(form.get('response_format')).toBe('json');expect([...form.keys()].sort()).toEqual(['file','model','response_format']);
      const file=form.get('file') as File;expect(file.type).toBe('audio/wav');expect(file.name).toBe('audio.wav');expect(new Uint8Array(await file.arrayBuffer())).toEqual(wav());
      return Response.json({text:'  Real words from provider.  '});
    });vi.stubGlobal('fetch',fetch);
    await Promise.all([journal.process(input.operationId),journal.process(input.operationId)]);await journal.process(input.operationId);make().recover();await make().process(input.operationId);
    expect(fetch).toHaveBeenCalledTimes(1);expect(admissions).toHaveLength(1);expect(admissions[0].text).toBe('  Real words from provider.  ');expect(journal.receipt(input.operationId)).toMatchObject({message:{runId:expect.any(String),audio:{transcription:{status:'succeeded'}}},run:{operationId:`audio:${input.operationId}`}});
    await expect(journal.retry(input.operationId,{attemptId:crypto.randomUUID(),acknowledgePaidRetry:true})).rejects.toMatchObject({code:'audio_retry_unavailable'});
  }));
  it('never automatically repeats uncertain dispatch; an acknowledged fresh retry creates one new attempt',async()=>journalTest(async(journal,state,bid,admissions,make)=>{
    const input=await fixture(journal,bid),fetch=vi.fn(async()=>{throw new Error('private-provider-secret');});vi.stubGlobal('fetch',fetch);
    await journal.process(input.operationId);expect(journal.receipt(input.operationId).transcription.status).toBe('uncertain');
    make().recover();await make().process(input.operationId);await journal.create(input);expect(fetch).toHaveBeenCalledTimes(1);expect(admissions).toHaveLength(0);expect(JSON.stringify(journal.receipt(input.operationId))).not.toContain('private-provider-secret');
    const retry={attemptId:crypto.randomUUID(),acknowledgePaidRetry:true};await journal.retry(input.operationId,retry);await journal.retry(input.operationId,retry);await journal.process(input.operationId);expect(fetch).toHaveBeenCalledTimes(2);
    expect(state.storage.sql.exec<{n:number}>('SELECT COUNT(*) n FROM audio_attempts').one().n).toBe(2);
  }));
  it('recovered dispatch marker becomes uncertain with no network call',async()=>journalTest(async(journal,state,bid,admissions,make)=>{
    const input=await fixture(journal,bid);state.storage.sql.exec("UPDATE audio_messages SET status='dispatching' WHERE operation_id=?",input.operationId);
    const fetch=vi.fn();vi.stubGlobal('fetch',fetch);const recovered=make();recovered.recover();await recovered.process(input.operationId);
    expect(recovered.receipt(input.operationId).transcription.status).toBe('uncertain');expect(fetch).not.toHaveBeenCalled();expect(admissions).toHaveLength(0);
  }));
  it('rejects empty/invalid/oversized provider output and hides upstream failures; no diagnostic reaches bot input',async()=>{
    for(const response of [Response.json({text:'  '}),Response.json({text:42}),Response.json({text:'x'.repeat(32_001)}),Response.json({error:{message:'private-upstream-body'}},{status:400}),Response.json({error:'private-upstream-body'},{status:503}),new Response('{invalid')]) {
      await journalTest(async(journal,state,bid,admissions,make)=>{const input=await fixture(journal,bid),fetch=vi.fn(async()=>response);vi.stubGlobal('fetch',fetch);await journal.process(input.operationId);make().recover();await make().process(input.operationId);expect(fetch).toHaveBeenCalledTimes(1);expect(admissions).toHaveLength(0);expect(journal.receipt(input.operationId).message.text).toBe('');expect(JSON.stringify(journal.receipt(input.operationId))).not.toContain('private-upstream-body');});
    }
  });
  it('safe admission recovery never calls transcription again after successful paid output',async()=>journalTest(async(journal,state,bid,admissions,make)=>{
    const input=await fixture(journal,bid),fetch=vi.fn(async()=>Response.json({text:'Saved transcript.'}));vi.stubGlobal('fetch',fetch);
    let tries=0;const original=journal as unknown as {hooks:{admit:(message:Message,operationId:string)=>Promise<Run>}};
    const admit=original.hooks.admit;original.hooks.admit=async(message,id)=>{if(++tries===1)throw new Error('inbox full');return admit(message,id);};
    await journal.process(input.operationId);expect(journal.receipt(input.operationId).transcription.status).toBe('succeeded');expect(journal.receipt(input.operationId).run).toBeUndefined();
    await journal.process(input.operationId);expect(fetch).toHaveBeenCalledTimes(1);expect(admissions).toHaveLength(1);expect(tries).toBe(2);
  }));
  it('a revoked membership check prevents paid dispatch while preserving the audio receipt',async()=>journalTest(async(journal,state,bid,admissions)=>{
    const input=await fixture(journal,bid),fetch=vi.fn();vi.stubGlobal('fetch',fetch);
    (journal as unknown as {hooks:{authorize():Promise<void>}}).hooks.authorize=async()=>{throw new Error('not a live member');};
    await journal.process(input.operationId);expect(fetch).not.toHaveBeenCalled();expect(admissions).toHaveLength(0);expect(journal.receipt(input.operationId).transcription.status).toBe('pending');
  }));
  it('rechecks live membership after the durable paid marker flush, before any charge',async()=>journalTest(async(journal,state,bid,admissions,make)=>{
    const input=await fixture(journal,bid),fetch=vi.fn();vi.stubGlobal('fetch',fetch);
    let checks=0;(journal as unknown as {hooks:{authorize():Promise<void>}}).hooks.authorize=async()=>{if(++checks===3)throw new Error('revoked while sync yielded');};
    await journal.process(input.operationId);expect(checks).toBe(3);expect(fetch).not.toHaveBeenCalled();expect(admissions).toHaveLength(0);
    expect(journal.receipt(input.operationId).message.text).toBe('');expect(journal.receipt(input.operationId).transcription.status).toBe('uncertain');
    make().recover();await make().process(input.operationId);expect(fetch).not.toHaveBeenCalled();
  }));
  it('discards a provider response when membership is revoked while the paid request is in flight',async()=>journalTest(async(journal,state,bid,admissions,make)=>{
    const input=await fixture(journal,bid);let authorized=true;
    (journal as unknown as {hooks:{authorize():Promise<void>}}).hooks.authorize=async()=>{if(!authorized)throw new Error('revoked');};
    const fetch=vi.fn(async()=>{authorized=false;return Response.json({text:'Must not be published.'});});vi.stubGlobal('fetch',fetch);
    await journal.process(input.operationId);expect(fetch).toHaveBeenCalledTimes(1);expect(admissions).toHaveLength(0);expect(journal.receipt(input.operationId).message.text).toBe('');expect(journal.receipt(input.operationId).transcription.status).toBe('uncertain');
    make().recover();await make().process(input.operationId);expect(fetch).toHaveBeenCalledTimes(1);
  }));
  it('rechecks membership after reading an asynchronous response body, before saving success',async()=>journalTest(async(journal,state,bid,admissions)=>{
    const input=await fixture(journal,bid);let authorized=true;
    (journal as unknown as {hooks:{authorize():Promise<void>}}).hooks.authorize=async()=>{if(!authorized)throw new Error('revoked');};
    const body=new ReadableStream<Uint8Array>({pull(controller){authorized=false;controller.enqueue(new TextEncoder().encode(JSON.stringify({text:'Must not be published.'})));controller.close();}},{highWaterMark:0});
    const fetch=vi.fn(async()=>new Response(body,{headers:{'content-type':'application/json'}}));vi.stubGlobal('fetch',fetch);
    await journal.process(input.operationId);expect(fetch).toHaveBeenCalledTimes(1);expect(admissions).toHaveLength(0);expect(journal.receipt(input.operationId).message.text).toBe('');expect(journal.receipt(input.operationId).transcription.status).toBe('uncertain');
  }));
  it('requires live membership again before admitting a successfully saved transcript',async()=>journalTest(async(journal,state,bid,admissions,make)=>{
    const input=await fixture(journal,bid);let checks=0;
    (journal as unknown as {hooks:{authorize():Promise<void>}}).hooks.authorize=async()=>{if(++checks===6)throw new Error('revoked before admission');};
    const fetch=vi.fn(async()=>Response.json({text:'Saved real transcript.'}));vi.stubGlobal('fetch',fetch);
    await journal.process(input.operationId);expect(fetch).toHaveBeenCalledTimes(1);expect(admissions).toHaveLength(0);expect(journal.receipt(input.operationId).transcription.status).toBe('succeeded');expect(journal.receipt(input.operationId).run).toBeUndefined();
    const recovered=make();(recovered as unknown as {hooks:{authorize():Promise<void>}}).hooks.authorize=async()=>{throw new Error('still revoked');};await recovered.process(input.operationId);expect(fetch).toHaveBeenCalledTimes(1);expect(admissions).toHaveLength(0);
  }));
  it('the deletion fence blocks a late successful provider response and waits for in-flight work',async()=>journalTest(async(journal,state,bid,admissions)=>{
    const input=await fixture(journal,bid);let resolve!:(response:Response)=>void;
    const response=new Promise<Response>(r=>{resolve=r;});let dispatched!:()=>void;const dispatch=new Promise<void>(r=>{dispatched=r;});
    vi.stubGlobal('fetch',vi.fn(async()=>{dispatched();return response;}));const process=journal.process(input.operationId);await dispatch;
    (journal as unknown as {hooks:{active():void}}).hooks.active=()=>{throw new Error('deleted');};
    let stopped=false;const stop=journal.stop().then(()=>{stopped=true;});await Promise.resolve();expect(stopped).toBe(false);
    resolve(Response.json({text:'Must not survive deletion.'}));await process;await stop;expect(admissions).toHaveLength(0);
    const saved=JSON.parse(state.storage.sql.exec<{data:string}>('SELECT data FROM messages WHERE id=(SELECT message_id FROM audio_messages WHERE operation_id=?)',input.operationId).one().data) as Message;expect(saved.text).toBe('');
  }));

  it('deletion cancels a stalled upload before cleanup so a delayed client cannot recreate bytes',async()=>journalTest(async(journal,state,bid)=>{
    const id=crypto.randomUUID(),stream=new ReadableStream<Uint8Array>({start(){}});
    const result=journal.upload(new Request('https://bot/audio',{method:'PUT',headers:{'content-type':'audio/wav'},body:stream}),id).catch(error=>error);
    await Promise.resolve();(journal as unknown as {hooks:{active():void}}).hooks.active=()=>{throw new Error('deleted');};
    await journal.stop();expect(await result).toMatchObject({code:'not_found'});expect(await (env as unknown as Env).FILES.head(`bots/${bid}/artifacts/${id}`)).toBeNull();
  }));

  it('bounds fragmented upload bookkeeping independently of the raw byte limit',async()=>journalTest(async(journal,state,bid)=>{
    const id=crypto.randomUUID(),bytes=new Uint8Array(10_000);bytes.set(wav().subarray(0,44));const view=new DataView(bytes.buffer);view.setUint32(4,bytes.length-8,true);view.setUint32(40,bytes.length-44,true);
    const stream=new ReadableStream<Uint8Array>({start(controller){for(const byte of bytes)controller.enqueue(new Uint8Array([byte]));controller.close();}});
    const result=await journal.upload(new Request('https://bot/audio',{method:'PUT',headers:{'content-type':'audio/wav'},body:stream}),id);expect(result.status).toBe(200);expect(await result.json()).toMatchObject({audio:{size:10_000,durationMs:312}});
    expect((await (env as unknown as Env).FILES.head(`bots/${bid}/artifacts/${id}`))?.size).toBe(bytes.length);
  }));

});
