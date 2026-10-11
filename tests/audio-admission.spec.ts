import {env,exports} from 'cloudflare:workers';
import {runInDurableObject} from 'cloudflare:test';
import {afterEach,it,expect,vi} from 'vitest';
import type {Bot,Message,Run} from '@botspace/contracts';
import type {Env} from '../apps/api/src/env';
import type {AgentRuntime} from '../packages/runtime/src/types';
import {ModelConfigurationError} from '../packages/runtime/src/model-settings';
import {AudioMessages} from '../apps/api/src/audio-messages';
const bindings=env as unknown as Env;
const api=(path:string,method='GET',body?:unknown)=>exports.default.fetch(`https://botspace.test${path}`,{method,headers:{authorization:'Bearer test-only-botspace-owner-token-000000','content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
const text='Recorded user input.';
function wav():Uint8Array {const bytes=new Uint8Array(3244),v=new DataView(bytes.buffer),s=(p:number,t:string)=>bytes.set(new TextEncoder().encode(t),p);s(0,'RIFF');v.setUint32(4,3236,true);s(8,'WAVE');s(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,16000,true);v.setUint32(28,32000,true);v.setUint16(32,2,true);v.setUint16(34,16,true);s(36,'data');v.setUint32(40,3200,true);return bytes;}
afterEach(()=>vi.unstubAllGlobals());
type Internals={runtime:AgentRuntime;audio():AudioMessages};
async function failedAudio(){
  const {bot}=await(await api('/v1/bots','POST',{name:'Audio configuration repair'})).json<{bot:Bot}>();
  const audioId=crypto.randomUUID(),operationId=crypto.randomUUID(),attemptId=crypto.randomUUID(),nativeId=`audio:${operationId}`;
  expect((await exports.default.fetch(`https://botspace.test/v1/bots/${bot.id}/audio/${audioId}`,{method:'PUT',headers:{authorization:'Bearer test-only-botspace-owner-token-000000','content-type':'audio/wav'},body:wav()})).status).toBe(200);
  expect((await api(`/v1/bots/${bot.id}/audio-messages`,'POST',{audioId,operationId,attemptId})).status).toBe(202);
  const stub=bindings.BOT.get(bindings.BOT.idFromName(`owner:${bot.id}`));
  let submits=0,restore!:()=>void;
  const paid=vi.fn(async()=>Response.json({text}));vi.stubGlobal('fetch',paid);
  const run=await runInDurableObject(stub,async(instance,state)=>{
    const target=instance as unknown as Internals,original=target.runtime,audio=target.audio();
    (audio as unknown as {env:Env}).env={...bindings,OPENAI_API_KEY:'fixture-key-not-real'};
    target.runtime={...original,submit:async()=>{submits++;throw new ModelConfigurationError('model_unavailable');}};
    restore=()=>{target.runtime={...original,submit:async(value,input)=>{submits++;return original.submit(value,input);}};};
    await audio.process(operationId);
    const receipt=audio.receipt(operationId);expect(receipt.transcription.status).toBe('succeeded');expect(receipt.run).toMatchObject({status:'failed',admissionRetryable:true});
    // Recovery of the post-admission journal pointer must not implicitly reset
    // a model configuration failure. Only the owner's later delivery retry can.
    state.storage.sql.exec('UPDATE audio_messages SET run_id=NULL WHERE operation_id=?',operationId);
    await audio.process(operationId);expect(submits).toBe(1);expect(audio.receipt(operationId).run).toMatchObject({status:'failed',admissionRetryable:true});
    return audio.receipt(operationId).run!;
  });
  return {bot,operationId,nativeId,run,paid,restore,getSubmits:()=>submits,stub};
}

it('repairs an unadmitted audio run through normal immutable delivery retry without paying for another transcription',async()=>{
  const state=await failedAudio();
  const altered=await api(`/v1/bots/${state.bot.id}/messages`,'POST',{text:'Different instruction',operationId:state.nativeId});expect(altered.status).toBe(409);expect(state.getSubmits()).toBe(1);
  expect((await api(`/v1/bots/${state.bot.id}`,'PATCH',{model:'@cf/test/repaired'})).status).toBe(200);
  state.restore();
  const retry=await api(`/v1/bots/${state.bot.id}/messages`,'POST',{text,operationId:state.nativeId});expect(retry.status).toBe(202);expect((await retry.json<{run:Run}>()).run.id).toBe(state.run.id);
  await expect.poll(async()=>(await(await api(`/v1/bots/${state.bot.id}/runs/${state.run.id}`)).json<{run:Run}>()).run.status).toBe('completed');
  expect(state.getSubmits()).toBe(2);expect(state.paid).toHaveBeenCalledTimes(1);
  const history=(await(await api(`/v1/bots/${state.bot.id}/messages`)).json<{messages:Message[]}>()).messages;
  expect(history.filter(message=>message.role==='user')).toHaveLength(1);expect(history.find(message=>message.role==='user')?.audio?.transcription.status).toBe('succeeded');
  expect((await api(`/v1/bots/${state.bot.id}/messages`,'POST',{text,operationId:state.nativeId})).status).toBe(202);expect(state.getSubmits()).toBe(2);expect(state.paid).toHaveBeenCalledTimes(1);
});

it('does not revive a stopped audio input when normal delivery is explicitly retried',async()=>{
  const state=await failedAudio();expect((await api(`/v1/bots/${state.bot.id}/runs/${state.run.id}/cancel`,'POST',{})).status).toBe(200);state.restore();
  const retry=await api(`/v1/bots/${state.bot.id}/messages`,'POST',{text,operationId:state.nativeId});expect(retry.status).toBe(202);
  const {run}=await retry.json<{run:Run}>();expect(run.id).toBe(state.run.id);expect(run.cancellation).toBeDefined();expect(run.admissionRetryable).not.toBe(true);
  expect(state.getSubmits()).toBe(1);expect(state.paid).toHaveBeenCalledTimes(1);
});
