import {env,exports} from 'cloudflare:workers';
import {runInDurableObject} from 'cloudflare:test';
import {describe,it,expect} from 'vitest';
import type {Bot} from '@botspace/contracts';
import type {Env} from '../apps/api/src/env';
import {parseMessage} from '../apps/api/src/validation';
const token='test-only-botspace-owner-token-000000';
const api=(path:string,init:RequestInit={})=>exports.default.fetch(`https://botspace.test${path}`,{...init,headers:{authorization:`Bearer ${token}`,'content-type':'application/json',...init.headers}});
async function createBot():Promise<Bot>{return (await (await api('/v1/bots',{method:'POST',body:JSON.stringify({name:'Audio scope'})})).json<{bot:Bot}>()).bot;}

describe('audio main-conversation scope',()=>{
  it('authenticates before explicitly rejecting task and agent audio endpoints',async()=>{
    const bot=await createBot(),taskId=crypto.randomUUID(),audioId=crypto.randomUUID();
    const paths=[`/v1/tasks/${taskId}/audio/${audioId}`,`/v1/tasks/${taskId}/audio-messages`,`/v1/tasks/${taskId}/agents/child/audio-messages`,`/v1/bots/${bot.id}/agents/child/audio/${audioId}`,`/v1/bots/${bot.id}/agents/child/audio-messages`];
    for(const path of paths){
      expect((await exports.default.fetch(`https://botspace.test${path}`,{method:'POST',body:'{}'})).status).toBe(401);
      const response=await api(path,{method:'POST',body:'{}'});expect(response.status).toBe(400);expect(await response.json()).toMatchObject({error:{code:'audio_scope_unsupported'}});
    }
    expect(await (env as unknown as Env).FILES.head(`bots/${bot.id}/artifacts/${audioId}`)).toBeNull();
  });
  it('rejects audio fields through shared text-message validation instead of silently dropping them',async()=>{
    for(const key of ['audio','audioId','transcription','attemptId'])expect(()=>parseMessage({text:'Do not drop this recording.',operationId:crypto.randomUUID(),[key]:crypto.randomUUID()})).toThrowError('Audio cannot be submitted through a text-message endpoint.');
    const bot=await createBot(),response=await api(`/v1/bots/${bot.id}/messages`,{method:'POST',body:JSON.stringify({text:'Caption',operationId:crypto.randomUUID(),audioId:crypto.randomUUID()})});
    expect(response.status).toBe(400);expect(await response.json()).toMatchObject({error:{code:'audio_message_route_required'}});
    expect(await (await api(`/v1/bots/${bot.id}/messages`)).json()).toMatchObject({messages:[]});
  });
  it('fences audio inside an actual task Durable Object even if an internal caller bypasses the gateway',async()=>{
    const bot=await createBot(),taskId=crypto.randomUUID(),audioId=crypto.randomUUID(),operationId=crypto.randomUUID(),attemptId=crypto.randomUUID();
    const bindings=env as unknown as Env,stub=bindings.BOT.get(bindings.BOT.idFromName(`owner:task:${taskId}`));
    const headers={'x-botspace-config':encodeURIComponent(JSON.stringify(bot)),'x-timber-task-id':taskId,'content-type':'application/json'};
    // Namespace identity fences a task even before its task_identity row exists.
    const withoutIdentity=await stub.fetch(new Request('https://task/audio-messages',{method:'POST',headers:{'x-botspace-config':headers['x-botspace-config'],'content-type':'application/json'},body:JSON.stringify({audioId,operationId,attemptId})}));
    expect(withoutIdentity.status).toBe(400);expect(await withoutIdentity.json()).toMatchObject({error:{code:'audio_scope_unsupported'}});
    for(const path of [`/audio/${audioId}`,'/audio-messages',`/audio-messages/${operationId}`,`/audio-messages/${operationId}/retry`]){
      const response=await stub.fetch(new Request(`https://task${path}`,{method:'POST',headers,body:JSON.stringify({audioId,operationId,attemptId})}));expect(response.status).toBe(400);expect(await response.json()).toMatchObject({error:{code:'audio_scope_unsupported'}});
    }
    await runInDurableObject(stub,async(instance,state)=>{
      expect(()=>(instance as unknown as {audio():unknown}).audio()).toThrowError("Audio messages are supported only in a bot's main conversation.");
      expect(state.storage.sql.exec<{n:number}>('SELECT COUNT(*) n FROM messages').one().n).toBe(0);
      expect(state.storage.sql.exec<{n:number}>('SELECT COUNT(*) n FROM runs').one().n).toBe(0);
      expect(state.storage.sql.exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name='audio_messages'").toArray()).toHaveLength(0);
    });
    expect(await bindings.FILES.head(`bots/${bot.id}/artifacts/${audioId}`)).toBeNull();
  });
});
