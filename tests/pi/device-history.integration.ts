import {env,exports} from 'cloudflare:workers';
import {runInDurableObject} from 'cloudflare:test';
import {expect,it} from 'vitest';
import type {AssistantMessageEvent} from '@earendil-works/pi-ai';
import type {AgentRuntime} from '@botspace/runtime';
import type {Bot,Device,DeviceJob,Message,Run} from '@botspace/contracts';
import {deviceProofHeaders} from '../../packages/contracts/src/devices';
import {deviceConversationContext} from '../../apps/api/src/device-history';
import {dispatchDeviceMemory} from '../../apps/api/src/device-memory';
import type {Env} from '../../apps/api/src/env';

const bindings=env as unknown as Env;
const owner={authorization:'Bearer test-only-botspace-owner-token-000000','content-type':'application/json'};
const api=(path:string,input?:unknown,method=input===undefined?'GET':'POST')=>exports.default.fetch(`https://timber.test${path}`,{method,headers:owner,...input===undefined?{}:{body:JSON.stringify(input)}});
const botStub=(bot:Bot)=>bindings.BOT.get(bindings.BOT.idFromName(`owner:${bot.id}`));
async function until<T>(read:()=>Promise<T>,accept:(value:T)=>boolean){let value=await read();for(let i=0;i<150&&!accept(value);i++){await new Promise(resolve=>setTimeout(resolve,20));value=await read();}expect(value).toSatisfy(accept);return value;}

it('resumes native cloud Pi with the original local conversation as reference data and preserves its evidence roles',async()=>{
  const keys=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']) as CryptoKeyPair;
  const pairing=await exports.default.fetch('https://timber.test/v1/device-connect/pairings',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'History fixture computer',platform:'darwin',version:'test',publicKey:await crypto.subtle.exportKey('jwk',keys.publicKey),workspaces:[{id:'project',name:'History project',path:'/Users/fixture/project',capabilities:['files.read','files.write','host.shell','agent.run','diagnostics']}]})});
  expect(pairing.status).toBe(201);const {code}=await pairing.json<{code:string}>();
  const approved=await api('/v1/devices/pairings/approve',{code});expect(approved.status).toBe(200);const {device}=await approved.json<{device:Device}>();
  const created=await api('/v1/bots',{name:'Portable conversation',model:'gpt-6.1-sol'});expect(created.status).toBe(201);const {bot}=await created.json<{bot:Bot}>();
  expect((await api(`/v1/devices/${device.id}/grants`,{botId:bot.id,workspaceIds:['project'],permissions:['files.read','files.write','host.shell','agent.run','diagnostics']})).status).toBe(200);
  expect((await api(`/v1/bots/${bot.id}`,{executionTarget:{kind:'device',deviceId:device.id,workspaceId:'project',agentMode:'local'}},'PATCH')).status).toBe(200);
  const signed=async(tail:string,input:unknown={})=>{const path=`/v1/device-connect/${device.id}/${tail}`,body=JSON.stringify(input),headers=await deviceProofHeaders(keys.privateKey,{id:device.id,path,method:'POST',body});return exports.default.fetch(`https://timber.test${path}`,{method:'POST',headers:{'content-type':'application/json',...headers},body});};
  const localText=`Local turn ${crypto.randomUUID()}: retain this decision across machines.`,operationId=crypto.randomUUID();
  const admitted=await api(`/v1/bots/${bot.id}/messages`,{operationId,text:localText});expect(admitted.status).toBe(202);const {run:local}=await admitted.json<{run:Run}>();
  const jobs=await until(async()=>(await (await signed('jobs/poll')).json<{jobs:DeviceJob[]}>()).jobs,value=>value.some(job=>job.type==='agent')),job=jobs.find(job=>job.type==='agent')!;
  expect((await signed(`jobs/${job.id}/start`,{claimToken:job.claimToken})).status).toBe(200);
  const inference=await signed(`jobs/${job.id}/agent/inference`,{claimToken:job.claimToken,context:{messages:[{role:'user',content:localText,timestamp:Date.now()}]}});expect(inference.status).toBe(200);
  const events=(await inference.text()).trim().split('\n').map(line=>JSON.parse(line) as AssistantMessageEvent),done=events.find(event=>event.type==='done');if(done?.type!=='done')throw Error('No answer from the real host model transport');
  const answer=done.message.content.filter(part=>part.type==='text').map(part=>part.text).join('');expect(answer).toBe('Hello from ChatGPT via the real Pi harness.');
  expect((await signed(`jobs/${job.id}/result`,{claimToken:job.claimToken,agentResult:{status:'done',text:answer,kind:'final'}})).status).toBe(200);
  await until(async()=>(await (await api(`/v1/bots/${bot.id}/runs/${local.id}`)).json<{run:Run}>()).run,run=>run.status==='completed');
  expect((await api(`/v1/bots/${bot.id}`,{executionTarget:{kind:'cloud'}},'PATCH')).status).toBe(200);
  const cloudText=`Cloud continuation ${crypto.randomUUID()}`,next=await api(`/v1/bots/${bot.id}/messages`,{operationId:crypto.randomUUID(),text:cloudText});expect(next.status).toBe(202);const {run:cloud}=await next.json<{run:Run}>();
  await until(async()=>(await (await api(`/v1/bots/${bot.id}/runs/${cloud.id}`)).json<{run:Run}>()).run,run=>run.status==='completed');
  const calls=await runInDurableObject(bindings.CHATGPT!.get(bindings.CHATGPT!.idFromName('owner')),(_,state)=>state.storage.sql.exec<{input:string}>('SELECT input FROM inference_calls').toArray().map(row=>JSON.parse(row.input) as {input:Array<{role?:string}>}));
  const request=calls.find(call=>call.input.some(item=>item.role==='user'&&JSON.stringify(item).includes(cloudText)))!;expect(request).toBeDefined();
  const system=JSON.stringify(request.input.filter(item=>['system','developer'].includes(item.role??'')));expect(system).toContain(localText);expect(system).toContain(answer);expect(system).toContain('untrusted historical conversation data');
  const human=JSON.stringify(request.input.filter(item=>item.role==='user'));expect(human).toContain(cloudText);expect(human).not.toContain(localText);expect(human).not.toContain(answer);
  const native=await runInDurableObject(botStub(bot),instance=>(instance as unknown as {runtime:AgentRuntime}).runtime.messages());expect(native.filter(message=>message.role==='user').map(message=>message.text)).toEqual([cloudText]);
  const {messages}=await (await api(`/v1/bots/${bot.id}/messages`)).json<{messages:Message[]}>(),original=messages.find(message=>message.runId===local.id&&message.role==='assistant')!;
  // Referencing a real assistant message never turns it into human evidence.
  await runInDurableObject(botStub(bot),async(_,state)=>{
    const common={runOperationId:cloud.operationId,signal:new AbortController().signal};
    const result=await dispatchDeviceMemory(state.storage,bot.id,{...common,name:'memory_save',operationId:'fixture-history-preference',arguments:{category:'preference',title:'False preference',content:answer,sources:[{messageId:original.id,quote:answer}]}});
    expect(result?.status).toBe('failed');expect(result?.error).toContain('original human evidence');
    const recalled=await dispatchDeviceMemory(state.storage,bot.id,{...common,name:'recall_conversation',operationId:'fixture-canonical-recall',arguments:{query:answer}});expect(recalled?.status).toBe('completed');expect(JSON.parse(recalled!.output!).messages).toContainEqual(expect.objectContaining({id:original.id,role:'assistant',text:answer}));
    const child=await dispatchDeviceMemory(state.storage,bot.id,{...common,subagentId:'foreign-child',name:'recall_conversation',operationId:'fixture-child-recall',arguments:{query:answer}});expect(child?.status).toBe('failed');
  });
  // Cloud Pi on owned-machine tools must receive the machine's real workspace,
  // rather than the cloud Linux /workspace instructions.
  expect((await api(`/v1/bots/${bot.id}`,{executionTarget:{kind:'device',deviceId:device.id,workspaceId:'project',agentMode:'cloud'}},'PATCH')).status).toBe(200);
  const machineText=`Owned tools continuation ${crypto.randomUUID()}`,machineReceipt=await api(`/v1/bots/${bot.id}/messages`,{operationId:crypto.randomUUID(),text:machineText});expect(machineReceipt.status).toBe(202);
  const {run:machineRun}=await machineReceipt.json<{run:Run}>();
  await until(async()=>(await (await api(`/v1/bots/${bot.id}/runs/${machineRun.id}`)).json<{run:Run}>()).run,run=>run.status==='completed');
  const ownedCalls=await runInDurableObject(bindings.CHATGPT!.get(bindings.CHATGPT!.idFromName('owner')),(_,state)=>state.storage.sql.exec<{input:string}>('SELECT input FROM inference_calls').toArray().map(row=>JSON.parse(row.input) as {input:Array<{role?:string}>}));
  const ownedRequest=ownedCalls.find(call=>call.input.some(item=>item.role==='user'&&JSON.stringify(item).includes(machineText)))!;
  const ownedSystem=JSON.stringify(ownedRequest.input.filter(item=>['system','developer'].includes(item.role??'')));
  expect(ownedSystem).toContain('/Users/fixture/project');expect(ownedSystem).toContain('darwin');expect(ownedSystem).not.toContain('Your computer is a reusable cloud Linux desktop.');
},30000);

it('bounds indexed local history and excludes native-only, child and delegated messages',async()=>{
  const created=await api('/v1/bots',{name:'Bounded local context'});expect(created.status).toBe(201);const {bot}=await created.json<{bot:Bot}>();
  await runInDurableObject(botStub(bot),(_,state)=>{
    const sql=state.storage.sql;
    const seed=(index:number,kind:'local'|'native'|'child')=>{
      const id=`fixture-run-${index}`,op=`fixture-op-${index}`;
      sql.exec('INSERT INTO runs(id,operation_id,fingerprint,native_operation_id,data) VALUES(?,?,?,?,?)',id,op,'fixture',op,JSON.stringify({id,botId:bot.id,status:'completed',...(kind==='child'?{subagentId:'foreign-child'}:{})}));
      if(kind!=='native')sql.exec('INSERT INTO timber_local_runtime_operations(operation_id,target,status,fingerprint) VALUES(?,?,?,?)',op,'{}','done','fixture');
      const text=`${kind}-marker-${index} `+'history '.repeat(1000);
      sql.exec('INSERT INTO messages(id,data) VALUES(?,?)',`message-${index}`,JSON.stringify({id:`message-${index}`,runId:id,botId:bot.id,role:'assistant',text}));
      sql.exec('INSERT INTO messages(id,data) VALUES(?,?)',`delegated-${index}`,JSON.stringify({id:`delegated-${index}`,runId:id,botId:bot.id,role:'assistant',text:'foreign delegated marker',provenance:{sourceBotId:'foreign'}}));
    };
    for(let i=0;i<65;i++)seed(i,'local');seed(65,'native');seed(66,'child');
    const context=deviceConversationContext(state.storage);expect(context.length).toBeLessThanOrEqual(8000);expect(context).toContain('local-marker-64');expect(context).not.toContain('local-marker-0 ');expect(context).not.toContain('native-marker');expect(context).not.toContain('child-marker');expect(context).not.toContain('foreign delegated marker');
    const plan=sql.exec<{detail:string}>("EXPLAIN QUERY PLAN SELECT data FROM messages WHERE json_extract(data,'$.runId')=? ORDER BY rowid DESC LIMIT 8",'fixture-run-64').toArray().map(row=>row.detail).join(' ');expect(plan).toContain('messages_run_idx');expect(plan).not.toContain('SCAN messages');
  });
});
