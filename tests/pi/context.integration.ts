import {env,exports} from 'cloudflare:workers';
import {abortAllDurableObjects,runInDurableObject} from 'cloudflare:test';
import {expect,it} from 'vitest';
import {PiHarness} from 'agents/harness/pi';
import {AssistantEntry,defineDocFamily,ROOT_CONVERSATION_ID,UserEntry,type Harness} from '@earendil-works/pi-durable';
import type {Bot,BotContextStatus,BotMemory,CompactionReceipt,Message,Run,Subagent} from '@botspace/contracts';
import type {AgentRuntime} from '@botspace/runtime';
import type {Env} from '../../apps/api/src/env';
import {inferenceFixtureControl} from './worker';

const bindings=env as unknown as Env;
const token='Bearer test-only-botspace-owner-token-000000';
const api=(path:string,body?:unknown,method=body===undefined?'GET':'POST')=>exports.default.fetch(`https://timber.test${path}`,{method,headers:{authorization:token,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
const stub=(bot:Bot)=>bindings.BOT.get(bindings.BOT.idFromName(`owner:${bot.id}`));
const runtime=(instance:unknown)=>(instance as {runtime:AgentRuntime}).runtime;
const background={abortSignal:undefined,value:()=>undefined,toString:()=>'[maintenance test]'};
async function createBot(name:string){return (await (await api('/v1/bots',{name})).json<{bot:Bot}>()).bot;}
const context=async(bot:Bot)=>(await (await api(`/v1/bots/${bot.id}/context`)).json<{context:BotContextStatus}>()).context;
const memory=async(bot:Bot)=>(await (await api(`/v1/bots/${bot.id}/memory`)).json<{memory:BotMemory}>()).memory;
const messages=async(bot:Bot)=>(await (await api(`/v1/bots/${bot.id}/messages`)).json<{messages:Message[]}>()).messages;
async function until<T>(read:()=>Promise<T>,accept:(value:T)=>boolean){let value=await read();for(let i=0;i<400&&!accept(value);i++){await new Promise(resolve=>setTimeout(resolve,10));value=await read();}expect(value).toSatisfy(accept);return value;}
async function say(bot:Bot,text:string){const {run}=await (await api(`/v1/bots/${bot.id}/messages`,{text,operationId:crypto.randomUUID()})).json<{run:Run}>();await until(async()=>(await(await api(`/v1/bots/${bot.id}/runs/${run.id}`)).json<{run:Run}>()).run,value=>value.status==='completed');}
async function withNative<T>(bot:Bot,work:(native:Harness,agent:AgentRuntime)=>Promise<T>):Promise<T>{
  return runInDurableObject(stub(bot),async instance=>{
    const agent=runtime(instance),original=PiHarness.prototype.pi;
    let native:Harness|undefined;
    PiHarness.prototype.pi=async function(){const value=await original.call(this);native=value;return value;};
    try{await agent.contextStatus();return await work(native!,agent);}finally{PiHarness.prototype.pi=original;}
  });
}
async function seedArchive(bot:Bot,usage=10){
  await withNative(bot,async native=>native.commit(async tx=>{
    for(let i=0;i<8;i++){
      await tx.appendEntry(UserEntry,ROOT_CONVERSATION_ID,{model:[{role:'user',content:`Archive fact ${i}: `+'retained historical context '.repeat(1250),timestamp:Date.now()}]});
      await tx.appendEntry(AssistantEntry,ROOT_CONVERSATION_ID,{model:[{role:'assistant',api:'openai-responses',provider:'openai',model:'gpt-6.1-sol',content:[{type:'text',text:`Recorded fact ${i}.`}],stopReason:'stop',timestamp:Date.now(),usage:{input:i===7?usage:10,output:8,cacheRead:0,cacheWrite:0,totalTokens:(i===7?usage:10)+8,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}}]});
    }
  },background));
}

it('protects editable durable memory with auth, bot isolation, validation and atomic revisions across eviction',async()=>{
  const bot=await createBot('Memory owner'),other=await createBot('Other memory owner');
  expect((await exports.default.fetch(`https://timber.test/v1/bots/${bot.id}/memory`)).status).toBe(401);
  expect((await api('/v1/bots/unknown/memory')).status).toBe(404);
  expect(await memory(bot)).toEqual({content:'',revision:0,maxCharacters:16000});
  const updates=await Promise.all(['Prefer concise answers.','Use Spanish.'].map(content=>api(`/v1/bots/${bot.id}/memory`,{content,revision:0},'PUT')));
  expect(updates.map(value=>value.status).sort()).toEqual([200,409]);
  for(const response of updates)expect(response.headers.get('content-type')).toContain('application/json');
  const saved=await memory(bot);expect(saved.revision).toBe(1);expect((await memory(other)).content).toBe('');
  expect((await api(`/v1/bots/${bot.id}/memory`,{content:'bad',revision:0.1},'PUT')).status).toBe(400);
  expect((await api(`/v1/bots/${bot.id}/memory`,{content:'x'.repeat(16001),revision:1},'PUT')).status).toBe(400);
  await abortAllDurableObjects();expect(await memory(bot)).toEqual(saved);
  await say(bot,'Use the durable preferences.');
  const payloads=await runInDurableObject(bindings.CHATGPT!.get(bindings.CHATGPT!.idFromName('owner')),(_instance,state)=>state.storage.sql.exec<{input:string}>('SELECT input FROM inference_calls').toArray().map(row=>row.input));
  expect(payloads.some(input=>input.includes(saved.content))).toBe(true);
});

it('manually compacts an idle native conversation once while retaining every archived and public message after recovery',async()=>{
  const bot=await createBot('Manual context');await say(bot,'A public message before context maintenance.');await seedArchive(bot);
  const before=await runInDurableObject(stub(bot),instance=>runtime(instance).messages());
  const publicBefore=await messages(bot),activeBefore=(await context(bot)).activeEntries;
  const input={operationId:crypto.randomUUID(),instructions:'Retain exact decisions and facts.'};
  const response=await api(`/v1/bots/${bot.id}/context/compact`,input);expect(response.status).toBe(202);
  const first=(await response.json<{compaction:CompactionReceipt}>()).compaction;
  const settled=await until(()=>context(bot),value=>value.compactions.some(item=>item.id===first.id&&item.status==='completed'));
  expect(settled.activeEntries).toBeLessThan(activeBefore);
  expect(settled.historyRetained).toBe(true);
  const detail=settled.compactions.find(item=>item.id===first.id)!;
  expect(detail.createdAt).toBe(first.createdAt);expect(Number.isFinite(Date.parse(detail.createdAt!))).toBe(true);
  expect(Number.isFinite(Date.parse(detail.startedAt!))).toBe(true);expect(Number.isFinite(Date.parse(detail.summaryCreatedAt!))).toBe(true);
  expect(detail.summarizedEntries).toBeGreaterThan(0);expect(detail.estimatedTokensBefore).toBeGreaterThan(0);expect(detail.firstKeptEntryId).toBeGreaterThan(0);
  expect(JSON.stringify(detail)).not.toContain('Retain exact decisions');expect(JSON.stringify(detail)).not.toContain('<summary>');
  expect((await (await api(`/v1/bots/${bot.id}/context/compact`,input)).json<{compaction:CompactionReceipt}>()).compaction.id).toBe(first.id);
  expect((await api(`/v1/bots/${bot.id}/context/compact`,{...input,instructions:'Different request'})).status).toBe(409);
  await abortAllDurableObjects();
  expect((await context(bot)).compactions.filter(item=>item.reason==='manual')).toEqual([detail]);
  expect(await runInDurableObject(stub(bot),instance=>runtime(instance).messages())).toEqual(before);
  expect(await messages(bot)).toEqual(publicBefore);
  await say(bot,'Continue after manual compaction.');
  expect((await messages(bot)).filter(message=>message.role==='user').map(message=>message.text)).toEqual(['A public message before context maintenance.','Continue after manual compaction.']);
});

it('native threshold compaction runs automatically and keeps the immutable transcript',async()=>{
  const bot=await createBot('Automatic context');await say(bot,'Prepare automatic context maintenance.');await seedArchive(bot,1_045_000);
  const before=await runInDurableObject(stub(bot),instance=>runtime(instance).messages());
  await say(bot,'Continue when the prior provider reports a nearly full context.');
  const status=await until(()=>context(bot),value=>value.compactions.some(item=>item.reason==='threshold'&&item.status==='completed'));
  expect(status.compactions.find(item=>item.reason==='threshold')).toEqual(expect.objectContaining({startedAt:expect.any(String),summaryCreatedAt:expect.any(String),summarizedEntries:expect.any(Number)}));
  expect(status.automatic).toBe(true);expect(status.activeEntries).toBeLessThan(before.length);
  const after=await runInDurableObject(stub(bot),instance=>runtime(instance).messages());
  expect(after.filter(message=>before.some(prior=>prior.id===message.id))).toEqual(before);
  expect(after.some(message=>message.text.includes('<summary>'))).toBe(false);
});

it('returns unchanged for an empty manual compaction without creating a model generation',async()=>{
  const bot=await createBot('Empty context'),input={operationId:crypto.randomUUID()};
  const response=await api(`/v1/bots/${bot.id}/context/compact`,input);expect(response.status).toBe(202);
  const status=await until(()=>context(bot),value=>value.compactions[0]?.status==='unchanged');
  expect(status.compactions).toHaveLength(1);expect(status.compactions[0]?.summaryApplied).toBe(false);
  expect(await messages(bot)).toEqual([]);
});

it('recovers a native compaction interrupted during the provider call with the original request identity',async()=>{
  const bot=await createBot('Recover context');await say(bot,'Prepare recoverable maintenance.');await seedArchive(bot);
  const before=await runInDurableObject(stub(bot),instance=>runtime(instance).messages());
  const summaryCalls=()=>runInDurableObject(bindings.CHATGPT!.get(bindings.CHATGPT!.idFromName('owner')),(_instance,state)=>state.storage.sql.exec<{input:string}>('SELECT input FROM inference_calls').toArray().filter(row=>row.input.includes('structured context checkpoint summary')).length);
  const callsBefore=await summaryCalls();
  let release!:()=>void;inferenceFixtureControl.matches='structured context checkpoint summary';inferenceFixtureControl.gate=new Promise(resolve=>{release=resolve;});
  const input={operationId:crypto.randomUUID()};
  try{
    const admitted=(await(await api(`/v1/bots/${bot.id}/context/compact`,input)).json<{compaction:CompactionReceipt}>()).compaction;
    await until(()=>context(bot),status=>status.compactions.some(item=>item.id===admitted.id&&item.status==='running'));
    await until(summaryCalls,count=>count>callsBefore);
    await abortAllDurableObjects();delete inferenceFixtureControl.gate;delete inferenceFixtureControl.matches;release();
    expect((await(await api(`/v1/bots/${bot.id}/context/compact`,input)).json<{compaction:CompactionReceipt}>()).compaction.id).toBe(admitted.id);
    const status=await until(()=>context(bot),value=>value.compactions[0]?.status==='completed');expect(status.compactions).toHaveLength(1);
    expect(await runInDurableObject(stub(bot),instance=>runtime(instance).messages())).toEqual(before);
  }finally{delete inferenceFixtureControl.gate;delete inferenceFixtureControl.matches;release();}
});

it('recall_history paginates matching archived entries without dropping matches inside a storage page',async()=>{
  const bot=await createBot('Recall history');await say(bot,'Prepare searchable history.');await seedArchive(bot);
  await say(bot,'request-recall-maintenance');
  const payloads=await runInDurableObject(bindings.CHATGPT!.get(bindings.CHATGPT!.idFromName('owner')),(_instance,state)=>state.storage.sql.exec<{input:string}>('SELECT input FROM inference_calls').toArray().map(row=>JSON.parse(row.input) as {input:Record<string,unknown>[]}));
  const final=payloads.filter(payload=>JSON.stringify(payload.input.filter(item=>item.role==='user').at(-1)).includes('request-recall-maintenance')).at(-1)!;
  const recalls=final.input.filter(item=>item.type==='function_call_output').map(item=>JSON.parse(String(item.output)));
  expect(recalls).toHaveLength(2);expect(recalls[0].messages).toHaveLength(1);expect(recalls[1].messages).toHaveLength(1);
  expect(recalls[0].messages[0].text).toContain('Archive fact 7:');expect(recalls[1].messages[0].text).toContain('Archive fact 6:');
  expect(recalls[0].nextCursor).toBeTruthy();expect(recalls[1].nextCursor).toBeTruthy();
});

it('a stale native summary finishes unchanged instead of remaining running after a newer context replaces it',async()=>{
  const bot=await createBot('Superseded context');await say(bot,'Prepare superseded maintenance.');await seedArchive(bot);
  const before=await runInDurableObject(stub(bot),instance=>runtime(instance).messages());
  const summaryCalls=()=>runInDurableObject(bindings.CHATGPT!.get(bindings.CHATGPT!.idFromName('owner')),(_instance,state)=>state.storage.sql.exec<{input:string}>('SELECT input FROM inference_calls').toArray().filter(row=>row.input.includes('structured context checkpoint summary')).length);
  const callsBefore=await summaryCalls();
  let release!:()=>void;inferenceFixtureControl.matches='structured context checkpoint summary';inferenceFixtureControl.gate=new Promise(resolve=>{release=resolve;});
  try{
    await api(`/v1/bots/${bot.id}/context/compact`,{operationId:crypto.randomUUID()});
    await until(summaryCalls,count=>count>callsBefore);
    await withNative(bot,async native=>{const own=await native.conversation(ROOT_CONVERSATION_ID,background);await own!.reset(undefined,background);});
    delete inferenceFixtureControl.gate;delete inferenceFixtureControl.matches;release();
    const status=await until(()=>context(bot),value=>value.compactions[0]?.status==='unchanged');
    expect(status.compactions[0]?.summaryApplied).toBe(false);
    expect(await runInDurableObject(stub(bot),instance=>runtime(instance).messages())).toEqual(before);
  }finally{delete inferenceFixtureControl.gate;delete inferenceFixtureControl.matches;release();}
});

it('native child memory tools inherit root notes read-only and retain their own isolated notes and history',async()=>{
  const bot=await createBot('Child memory');
  const rootNotes='Root policy: preserve exact paths.';
  expect((await api(`/v1/bots/${bot.id}/memory`,{content:rootNotes,revision:0},'PUT')).status).toBe(200);
  await say(bot,'request-parent-maintenance');
  const children=await until(async()=>(await(await api(`/v1/bots/${bot.id}/agents`)).json<{agents:Subagent[]}>()).agents,value=>value[0]?.status==='completed');
  expect(children).toHaveLength(1);expect((await memory(bot)).content).toBe(rootNotes);
  const payloads=await runInDurableObject(bindings.CHATGPT!.get(bindings.CHATGPT!.idFromName('owner')),(_instance,state)=>state.storage.sql.exec<{input:string}>('SELECT input FROM inference_calls').toArray().map(row=>JSON.parse(row.input) as {input:Record<string,unknown>[]}));
  const results=payloads.flatMap(payload=>payload.input.filter(item=>item.type==='function_call_output').map(item=>{try{return JSON.parse(String(item.output));}catch{return {};}}));
  expect(results).toContainEqual(expect.objectContaining({memory:expect.objectContaining({content:'',revision:0}),inherited:expect.objectContaining({content:rootNotes})}));
  expect(results).toContainEqual(expect.objectContaining({memory:expect.objectContaining({content:'Child-specific verified fact.',revision:1}),inherited:expect.objectContaining({content:rootNotes})}));
  expect(results.some(result=>result.messages?.some((message:{text:string})=>message.text==='request-child-maintenance'))).toBe(true);
  await abortAllDurableObjects();expect((await memory(bot)).content).toBe(rootNotes);
  const childHistory=(await(await api(`/v1/bots/${bot.id}/agents/${children[0]!.id}/messages`)).json<{messages:Message[]}>()).messages;
  expect(childHistory.some(message=>message.text==='Child memory retained; parent notes are read-only.')).toBe(true);
});

it('retains every compaction beyond twenty with stable native identities and honest metadata across recovery and bot isolation',async()=>{
  const bot=await createBot('All compactions'),other=await createBot('Isolated compactions');
  const ids:string[]=[];
  for(let i=0;i<25;i++){
    const input={operationId:crypto.randomUUID()};
    const response=await api(`/v1/bots/${bot.id}/context/compact`,input);
    expect(response.status).toBe(202);const receipt=(await response.json<{compaction:CompactionReceipt}>()).compaction;ids.push(receipt.id);
    await until(()=>context(bot),value=>value.compactions.some(item=>item.id===receipt.id&&item.status==='unchanged'));
  }
  const before=await context(bot);expect(before.compactions.map(item=>item.id)).toEqual(ids.slice().reverse());
  expect(before.compactions).toHaveLength(25);for(const receipt of before.compactions){expect(receipt.createdAt).toEqual(expect.any(String));expect(receipt.startedAt).toBeUndefined();expect(receipt.summaryCreatedAt).toBeUndefined();expect(receipt.historyRetained).toBe(true);}
  expect((await context(other)).compactions).toEqual([]);
  expect((await exports.default.fetch(`https://timber.test/v1/bots/${bot.id}/context`)).status).toBe(401);
  expect((await api(`/v1/bots/${crypto.randomUUID()}/context`)).status).toBe(404);
  await abortAllDurableObjects();expect((await context(bot)).compactions).toEqual(before.compactions);
});

it('reports historical applied summary timestamps but does not fabricate missing legacy request or start metadata',async()=>{
  const bot=await createBot('Legacy compaction');await say(bot,'Historical public input.');await seedArchive(bot);
  const response=await api(`/v1/bots/${bot.id}/context/compact`,{operationId:crypto.randomUUID()});
  const {compaction}=await response.json<{compaction:CompactionReceipt}>();
  const settled=await until(()=>context(bot),value=>value.compactions.some(item=>item.id===compaction.id&&item.status==='completed'));
  const original=settled.compactions.find(item=>item.id===compaction.id)!;
  // A legacy task has no Timber metadata document. Keep its native task and immutable summary intact.
  const legacy=defineDocFamily<{createdAt?:string;startedAt?:string},string>({kind:'timber.compact-details',version:1,scope:'conversation',history:'latest',fork:'initial',family:true,initial:()=>({})});
  await withNative(bot,native=>native.commit(tx=>tx.retireDoc(legacy,ROOT_CONVERSATION_ID,compaction.id.slice('compact:'.length)),background));
  await abortAllDurableObjects();
  const receipt=(await context(bot)).compactions.find(item=>item.id===compaction.id)!;
  expect(receipt).toEqual({id:original.id,reason:'manual',status:'completed',summaryApplied:true,historyRetained:true,summaryCreatedAt:original.summaryCreatedAt,firstKeptEntryId:original.firstKeptEntryId});
  expect(receipt.createdAt).toBeUndefined();expect(receipt.startedAt).toBeUndefined();expect(receipt.summaryCreatedAt).toEqual(expect.any(String));
  expect(JSON.stringify(receipt)).not.toContain('<summary>');expect(JSON.stringify(receipt)).not.toContain('Archive fact');
});
