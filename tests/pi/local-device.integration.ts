import {env,exports} from 'cloudflare:workers';
import {runInDurableObject} from 'cloudflare:test';
import {expect,it} from 'vitest';
import type {AssistantMessageEvent} from '@earendil-works/pi-ai';
import type {Bot,Device,DeviceJob,Message,Run} from '@botspace/contracts';
import {deviceProofHeaders} from '../../packages/contracts/src/devices';
import type {Env} from '../../apps/api/src/env';

const bindings=env as unknown as Env;
const owner={'authorization':'Bearer test-only-botspace-owner-token-000000','content-type':'application/json'};
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=';
const api=(path:string,input?:unknown,method=input===undefined?'GET':'POST')=>exports.default.fetch(`https://timber.test${path}`,{method,headers:owner,...input===undefined?{}:{body:JSON.stringify(input)}});
async function until<T>(read:()=>Promise<T>,accept:(value:T)=>boolean){
  let value=await read();for(let i=0;i<100&&!accept(value);i++){await new Promise(resolve=>setTimeout(resolve,20));value=await read();}expect(value).toSatisfy(accept);return value;
}
async function machine(){
  const keys=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']) as CryptoKeyPair;
  const pairing=await exports.default.fetch('https://timber.test/v1/device-connect/pairings',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'Pi fixture computer',platform:'darwin',version:'test',publicKey:await crypto.subtle.exportKey('jwk',keys.publicKey),workspaces:[{id:'project',name:'Fixture project',path:'/Users/fixture/project',capabilities:['files.read','files.write','host.shell','agent.run','diagnostics']}]})});
  expect(pairing.status).toBe(201);
  const {code}=await pairing.json<{code:string}>(),approval=await api('/v1/devices/pairings/approve',{code});expect(approval.status).toBe(200);
  const {device}=await approval.json<{device:Device}>();
  const created=await api('/v1/bots',{name:'Local native inference',model:'gpt-6.1-sol',reasoningEffort:'high',fast:true});expect(created.status).toBe(201);
  const {bot}=await created.json<{bot:Bot}>();
  const target={kind:'device',deviceId:device.id,workspaceId:'project',agentMode:'local'};
  expect((await api(`/v1/devices/${device.id}/grants`,{botId:bot.id,workspaceIds:['project'],permissions:['files.read','files.write','host.shell','agent.run','diagnostics']})).status).toBe(200);
  expect((await api(`/v1/bots/${bot.id}`,{executionTarget:target},'PATCH')).status).toBe(200);
  const signed=async(tail:string,input:unknown={})=>{
    const path=`/v1/device-connect/${device.id}/${tail}`,body=JSON.stringify(input),proof=await deviceProofHeaders(keys.privateKey,{id:device.id,path,method:'POST',body});
    return exports.default.fetch(`https://timber.test${path}`,{method:'POST',headers:{'content-type':'application/json',...proof},body});
  };
  const operationId=crypto.randomUUID(),receipt=await api(`/v1/bots/${bot.id}/messages`,{operationId,text:'Answer using the admitted model.'});expect(receipt.status).toBe(202);
  const {run}=await receipt.json<{run:Run}>();expect(run.executionTarget).toEqual(target);
  const jobs=await until(async()=>{
    const response=await signed('jobs/poll');expect(response.status).toBe(200);return (await response.json<{jobs:DeviceJob[]}>()).jobs;
  },jobs=>jobs.some(job=>job.type==='agent'));
  const job=jobs.find(job=>job.type==='agent')!;expect(job.agent?.operationId).toBe(operationId);
  expect((await signed(`jobs/${job.id}/start`,{claimToken:job.claimToken})).status).toBe(200);
  return {bot,run,job,signed};
}
async function infer(job:DeviceJob,signed:Awaited<ReturnType<typeof machine>>['signed'],text:string,image=false){
  const response=await signed(`jobs/${job.id}/agent/inference`,{
    claimToken:job.claimToken,
    context:{systemPrompt:job.agent!.instructions,messages:[{role:'user',content:[{type:'text',text},...image?[{type:'image',data:png,mimeType:'image/png'}]:[]],timestamp:Date.now()}]},
    // Account credentials and settings belong to the admitted server snapshot.
    options:{apiKey:'fixture-client-key',headers:{authorization:'fixture-client-auth'},model:'untrusted-model',reasoning:'low',maxTokens:999999},
  });
  expect(response.status).toBe(200);expect(response.headers.get('content-type')).toBe('application/x-ndjson');
  const events=(await response.text()).trim().split('\n').map(line=>JSON.parse(line) as AssistantMessageEvent);
  expect(events.some(event=>event.type==='text_delta')).toBe(true);
  const done=events.find(event=>event.type==='done');expect(done?.type).toBe('done');
  if(done?.type!=='done')throw Error('The actual model transport did not finish a normalized answer');
  expect(done.message.stopReason).toBe('stop');
  return done.message.content.filter(part=>part.type==='text').map(part=>part.text).join('');
}

it('uses the real pinned ChatGPT transport for signed local inference, including large context and images, then publishes its answer once',async()=>{
  const {bot,run,job,signed}=await machine();
  // A later settings edit cannot change this operation's provider configuration.
  expect((await api(`/v1/bots/${bot.id}`,{reasoningEffort:'low',fast:false},'PATCH')).status).toBe(200);
  const marker=`local-device-context-${crypto.randomUUID()}`,text=marker+'x'.repeat(320000);
  const answer=await infer(job,signed,text,true);expect(answer).toBe('Hello from ChatGPT via the real Pi harness.');
  const calls=await runInDurableObject(bindings.CHATGPT!.get(bindings.CHATGPT!.idFromName('owner')),(_instance,state)=>state.storage.sql.exec<{input:string}>('SELECT input FROM inference_calls').toArray().map(row=>JSON.parse(row.input) as Record<string,unknown>));
  const payload=calls.find(call=>JSON.stringify(call).includes(marker))!;expect(payload).toBeDefined();
  expect(payload.model).toBe('gpt-6.1-sol');expect(payload.reasoning).toEqual(expect.objectContaining({effort:'high'}));expect(payload.service_tier).toBe('fast');
  expect(JSON.stringify(payload)).toContain(text);expect(JSON.stringify(payload)).toContain(`data:image/png;base64,${png}`);
  expect(JSON.stringify(payload)).not.toContain('fixture-client-key');expect(JSON.stringify(payload)).not.toContain('fixture-client-auth');expect(JSON.stringify(payload)).not.toContain('untrusted-model');
  const event={type:'message',eventKey:'native-fixture-answer',data:{id:`local-pi:${'a'.repeat(64)}:10:0`,role:'assistant',kind:'final',text:answer,createdAt:new Date().toISOString()}};
  expect((await signed(`jobs/${job.id}/agent/event`,{claimToken:job.claimToken,sequence:1,event})).status).toBe(200);
  expect((await signed(`jobs/${job.id}/agent/event`,{claimToken:job.claimToken,sequence:1,event})).status).toBe(200);
  expect((await signed(`jobs/${job.id}/result`,{claimToken:job.claimToken,agentResult:{status:'done',text:answer,kind:'final'}})).status).toBe(200);
  await until(async()=>(await (await api(`/v1/bots/${bot.id}/runs/${run.id}`)).json<{run:Run}>()).run,value=>value.status==='completed');
  const {messages}=await (await api(`/v1/bots/${bot.id}/messages`)).json<{messages:Message[]}>();expect(messages.filter(message=>message.role==='assistant'&&message.text===answer)).toHaveLength(1);
  expect((await signed(`jobs/${job.id}/agent/inference`,{claimToken:job.claimToken,context:{messages:[]}})).status).toBe(409);
},30000);

it('normalizes a provider failure through the signed inference relay without returning raw provider details',async()=>{
  const {job,signed}=await machine();
  const response=await signed(`jobs/${job.id}/agent/inference`,{claimToken:job.claimToken,context:{messages:[{role:'user',content:'request-sse-server-error',timestamp:Date.now()}]}});
  expect(response.status).toBe(200);const body=await response.text();expect(body).not.toContain('Private fixture provider details');
  const events=body.trim().split('\n').map(line=>JSON.parse(line) as AssistantMessageEvent),error=events.find(event=>event.type==='error');
  expect(error?.type).toBe('error');if(error?.type==='error')expect(error.error.errorMessage).toContain('model_provider_unavailable');
  expect((await signed(`jobs/${job.id}/result`,{claimToken:job.claimToken,agentResult:{status:'unanswered',reason:'error',errorCode:'model_provider_unavailable'}})).status).toBe(200);
},30000);
