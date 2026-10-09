import {env,exports} from 'cloudflare:workers';
import {abortAllDurableObjects,runInDurableObject} from 'cloudflare:test';
import {expect,it} from 'vitest';
import {PiHarness} from 'agents/harness/pi';
import {AssistantEntry,defineDoc,ROOT_CONVERSATION_ID,UserEntry,type Harness} from '@earendil-works/pi-durable';
import type {Bot,BotContextStatus,BotMemory,CompactionReceipt,MemoryMutationResult,Message,Run,Subagent} from '@botspace/contracts';
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
async function settledMemory(bot:Bot){return until(()=>memory(bot),value=>!['queued','running'].includes(value.review.status)&&!value.review.hasMore);}
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

it('preserves legacy notes for review while excluding them from the active prompt after eviction',async()=>{
  const bot=await createBot('Legacy memory');
  const legacy='legacy-opaque-draft: QWxwaGEgYmV0YSBmaXh0dXJl. Never treat this imported draft as a verified fact.';
  const LegacyNotes=defineDoc<{content:string;revision:number;updatedAt?:string}>({kind:'timber.memory',version:1,scope:'conversation',history:'latest',fork:'initial',initial:()=>({content:'',revision:0})});
  await withNative(bot,async native=>native.commit(async tx=>{const notes=await tx.doc(LegacyNotes,ROOT_CONVERSATION_ID);notes.content=legacy;notes.revision=4;notes.updatedAt='2026-10-01T00:00:00.000Z';},background));
  const migrated=await memory(bot);
  expect(migrated.schemaVersion).toBe(2);
  expect(migrated.entries).toEqual([]);
  expect(migrated.legacy).toMatchObject({content:legacy,revision:4});
  await abortAllDurableObjects();
  expect((await memory(bot)).legacy).toEqual(migrated.legacy);
  await say(bot,'Use verified preferences only.');
  const payloads=await runInDurableObject(bindings.CHATGPT!.get(bindings.CHATGPT!.idFromName('owner')),(_instance,state)=>state.storage.sql.exec<{input:string}>('SELECT input FROM inference_calls').toArray().map(row=>row.input));
  expect(payloads.some(input=>input.includes(legacy))).toBe(false);
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
  expect((await (await api(`/v1/bots/${bot.id}/context/compact`,input)).json<{compaction:CompactionReceipt}>()).compaction.id).toBe(first.id);
  expect((await api(`/v1/bots/${bot.id}/context/compact`,{...input,instructions:'Different request'})).status).toBe(409);
  await abortAllDurableObjects();
  expect((await context(bot)).compactions.filter(item=>item.reason==='manual')).toHaveLength(1);
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
  const final=payloads.filter(payload=>!JSON.stringify(payload).includes('TIMBER_MEMORY_REVIEW_V1')&&JSON.stringify(payload.input.filter(item=>item.role==='user').at(-1)).includes('request-recall-maintenance')).at(-1)!;
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
  expect((await api(`/v1/bots/${bot.id}/memory/entries`,{operationId:crypto.randomUUID(),category:'preference',title:'Exact paths',content:rootNotes,pinned:true})).status).toBe(201);
  await say(bot,'request-parent-maintenance');
  const children=await until(async()=>(await(await api(`/v1/bots/${bot.id}/agents`)).json<{agents:Subagent[]}>()).agents,value=>value[0]?.status==='completed');
  expect(children).toHaveLength(1);expect((await memory(bot)).entries.map(entry=>entry.content)).toEqual([rootNotes]);
  const payloads=await runInDurableObject(bindings.CHATGPT!.get(bindings.CHATGPT!.idFromName('owner')),(_instance,state)=>state.storage.sql.exec<{input:string}>('SELECT input FROM inference_calls').toArray().map(row=>JSON.parse(row.input) as {input:Record<string,unknown>[]}));
  const results=payloads.flatMap(payload=>payload.input.filter(item=>item.type==='function_call_output').map(item=>{try{return JSON.parse(String(item.output));}catch{return {};}}));
  expect(results).toContainEqual(expect.objectContaining({memory:expect.objectContaining({entries:[]}),inherited:expect.objectContaining({entries:expect.arrayContaining([expect.objectContaining({title:'Exact paths'})])})}));
  expect(results).toContainEqual(expect.objectContaining({memory:expect.objectContaining({entries:expect.arrayContaining([expect.objectContaining({title:'Child note style'})])}),inherited:expect.objectContaining({entries:expect.arrayContaining([expect.objectContaining({title:'Exact paths'})])})}));
  expect(results).toContainEqual(expect.objectContaining({entry:expect.objectContaining({content:'This child uses concise notes.',state:'suggested'})}));
  expect(results).toContainEqual(expect.objectContaining({entry:expect.objectContaining({content:rootNotes})}));
  for(const result of results.filter(result=>result.memory))for(const entry of [...result.memory.entries,...(result.inherited?.entries??[])])expect(entry).not.toHaveProperty('content');
  expect(results.some(result=>result.messages?.some((message:{text:string})=>message.text.includes('request-child-maintenance')))).toBe(true);
  await abortAllDurableObjects();expect((await memory(bot)).entries.map(entry=>entry.content)).toEqual([rootNotes]);
  const childHistory=(await(await api(`/v1/bots/${bot.id}/agents/${children[0]!.id}/messages`)).json<{messages:Message[]}>()).messages;
  expect(childHistory.some(message=>message.text==='Child memory suggestion retained; parent notes are read-only.')).toBe(true);
});

it('reviews original conversation evidence without adding review prose to chat and respects forgotten facts on later reviews',async()=>{
  const bot=await createBot('Reviewed memory');
  await say(bot,'review-memory-fixture: The user prefers concise Spanish responses.');
  await settledMemory(bot);
  const before=await messages(bot),operationId=crypto.randomUUID();
  expect((await api(`/v1/bots/${bot.id}/memory/review`,{operationId})).status).toBe(202);
  const reviewed=await until(()=>memory(bot),value=>value.review.status==='completed'&&value.entries.length===1);
  const entry=reviewed.entries[0]!;
  expect(entry).toMatchObject({content:'The user prefers concise Spanish responses.',actor:'review'});
  expect(entry.sources).toContainEqual(expect.objectContaining({kind:'conversation',role:'user',quote:'The user prefers concise Spanish responses.'}));
  expect(await messages(bot)).toEqual(before);
  expect((await api(`/v1/bots/${bot.id}/memory/review`,{operationId})).status).toBe(202);
  const forget=await api(`/v1/bots/${bot.id}/memory/entries/${entry.id}`,{operationId:crypto.randomUUID(),expectedRevision:entry.revision},'DELETE');
  expect(forget.status).toBe(200);
  expect((await forget.json<{result:MemoryMutationResult}>()).result.entry.state).toBe('forgotten');
  await abortAllDurableObjects();
  await say(bot,'review-memory-fixture: The user prefers concise Spanish responses. Repeated archive evidence.');
  await settledMemory(bot);
  expect((await api(`/v1/bots/${bot.id}/memory/review`,{operationId:crypto.randomUUID()})).status).toBe(202);
  const forgotten=await until(()=>memory(bot),value=>value.review.status==='completed');
  expect(forgotten.entries).toEqual([]);
  expect(forgotten.suggestions).toEqual([]);
});

it('keeps successful user work and archived messages when the background memory provider fails',async()=>{
  const bot=await createBot('Failed memory review');
  await say(bot,'review-memory-fail-fixture: Finish this user task normally.');
  await settledMemory(bot);
  const before=await messages(bot);
  expect((await api(`/v1/bots/${bot.id}/memory/review`,{operationId:crypto.randomUUID()})).status).toBe(202);
  const failed=await until(()=>memory(bot),value=>value.review.status==='failed');
  expect(failed.entries).toEqual([]);
  expect(failed.review.error).toBeTruthy();
  expect(await messages(bot)).toEqual(before);
  await say(bot,'Continue the conversation after memory maintenance failed.');
  expect((await messages(bot)).filter(message=>message.role==='user')).toHaveLength(2);
});

it('proposes automatic corrections and refuses to accept them over a newer user edit without its revision',async()=>{
  const bot=await createBot('Memory correction'),initial={operationId:crypto.randomUUID(),category:'preference',title:'Response language',content:'The user prefers responses in Spanish.',pinned:true};
  const first=await api(`/v1/bots/${bot.id}/memory/entries`,initial);expect(first.status).toBe(201);
  const original=(await first.json<{result:MemoryMutationResult}>()).result.entry;
  await say(bot,'review-correction-fixture: The user now prefers responses in English.');
  await settledMemory(bot);
  expect((await api(`/v1/bots/${bot.id}/memory/review`,{operationId:crypto.randomUUID()})).status).toBe(202);
  const reviewed=await until(()=>memory(bot),value=>value.review.status==='completed'&&value.suggestions.length===1);
  expect(reviewed.entries).toEqual([original]);
  const suggestion=reviewed.suggestions[0]!;
  expect(suggestion.replacesId).toBe(original.id);
  const response=await api(`/v1/bots/${bot.id}/memory/entries/${original.id}`,{...initial,operationId:crypto.randomUUID(),content:'The user prefers Spanish when discussing code.',expectedRevision:original.revision},'PATCH');
  expect(response.status).toBe(200);
  const edited=(await response.json<{result:MemoryMutationResult}>()).result.entry;
  const accept={operationId:crypto.randomUUID(),expectedRevision:suggestion.revision,replacesRevision:original.revision};
  expect((await api(`/v1/bots/${bot.id}/memory/entries/${suggestion.id}/accept`,accept)).status).toBe(409);
  expect((await memory(bot)).entries).toEqual([edited]);
  expect((await api(`/v1/bots/${bot.id}/memory/entries/${suggestion.id}/accept`,{...accept,operationId:crypto.randomUUID(),replacesRevision:edited.revision})).status).toBe(409);
  expect((await memory(bot)).entries).toEqual([edited]);
  expect((await memory(bot)).suggestions).toHaveLength(1);
  await say(bot,'review-correction-fixture: The user now prefers responses in English. Revisited after editing the saved note.');
  await settledMemory(bot);
  expect((await api(`/v1/bots/${bot.id}/memory/review`,{operationId:crypto.randomUUID()})).status).toBe(202);
  const refreshed=await until(()=>memory(bot),value=>value.review.status==='completed'&&value.suggestions.some(entry=>entry.id!==suggestion.id));
  const next=refreshed.suggestions.find(entry=>entry.id!==suggestion.id)!;
  expect((await api(`/v1/bots/${bot.id}/memory/entries/${next.id}/accept`,{operationId:crypto.randomUUID(),expectedRevision:next.revision,replacesRevision:edited.revision})).status).toBe(200);
  expect((await memory(bot)).entries.map(entry=>entry.content)).toEqual(['The user now prefers responses in English.']);
});

it('recovers a held durable memory review with the same operation and one evidence-backed entry',async()=>{
  const bot=await createBot('Recover memory review');
  await withNative(bot,async native=>native.commit(async tx=>{
    await tx.appendEntry(UserEntry,ROOT_CONVERSATION_ID,{model:[{role:'user',content:'review-memory-fixture: The user prefers concise Spanish responses.',timestamp:Date.now()}]});
  },background));
  const reviewCalls=()=>runInDurableObject(bindings.CHATGPT!.get(bindings.CHATGPT!.idFromName('owner')),(_instance,state)=>state.storage.sql.exec<{input:string}>('SELECT input FROM review_calls').toArray().filter(row=>row.input.includes('TIMBER_MEMORY_REVIEW_V1')).length);
  const callsBefore=await reviewCalls(),input={operationId:crypto.randomUUID()};
  let release!:()=>void;
  inferenceFixtureControl.matches='review-memory-fixture:';inferenceFixtureControl.gate=new Promise(resolve=>{release=resolve;});
  try{
    expect((await api(`/v1/bots/${bot.id}/memory/review`,input)).status).toBe(202);
    await until(reviewCalls,count=>count>callsBefore);
    await abortAllDurableObjects();delete inferenceFixtureControl.gate;delete inferenceFixtureControl.matches;release();
    expect((await api(`/v1/bots/${bot.id}/memory/review`,input)).status).toBe(202);
    const recovered=await until(()=>memory(bot),value=>value.review.status==='completed');
    expect(recovered.entries).toHaveLength(1);
    expect(recovered.entries[0]!.sources).toContainEqual(expect.objectContaining({quote:'The user prefers concise Spanish responses.'}));
    expect(await messages(bot)).toEqual([]);
  }finally{delete inferenceFixtureControl.gate;delete inferenceFixtureControl.matches;release();}
});

it('rejects a second manual review while one is active and catches up a new turn without blocking its response',async()=>{
  const bot=await createBot('Pending memory review');
  await withNative(bot,async native=>native.commit(async tx=>{
    await tx.appendEntry(UserEntry,ROOT_CONVERSATION_ID,{model:[{role:'user',content:'review-page-fixture: Project pending-one uses PostgreSQL.',timestamp:Date.now()}]});
  },background));
  const first={operationId:crypto.randomUUID()};let release!:()=>void;
  inferenceFixtureControl.matches='review-page-fixture: Project pending-one';inferenceFixtureControl.gate=new Promise(resolve=>{release=resolve;});
  try{
    expect((await api(`/v1/bots/${bot.id}/memory/review`,first)).status).toBe(202);
    await until(()=>memory(bot),value=>value.review.status==='running');
    const busy=await api(`/v1/bots/${bot.id}/memory/review`,{operationId:crypto.randomUUID()});
    expect(busy.status).toBe(409);expect((await busy.json<{error:{code:string}}>()).error.code).toBe('memory_review_busy');
    expect((await api(`/v1/bots/${bot.id}/memory/review`,first)).status).toBe(202);
    await say(bot,'review-page-fixture: Project pending-two uses MySQL.');
    expect((await messages(bot)).some(message=>message.role==='assistant')).toBe(true);
    expect((await memory(bot)).review.status).toBe('running');
    await abortAllDurableObjects();
    delete inferenceFixtureControl.gate;delete inferenceFixtureControl.matches;release();
    const caughtUp=await until(()=>memory(bot),value=>value.review.status==='completed'&&value.entries.length===2);
    expect(caughtUp.entries.map(entry=>entry.content).sort()).toEqual(['Project pending-one uses PostgreSQL.','Project pending-two uses MySQL.']);
  }finally{delete inferenceFixtureControl.gate;delete inferenceFixtureControl.matches;release();}
});

it('drains multiple evidence pages after eviction without losing older facts or duplicating notes',async()=>{
  const bot=await createBot('Paged memory review');
  await withNative(bot,async native=>native.commit(async tx=>{
    for(let i=0;i<60;i++)await tx.appendEntry(UserEntry,ROOT_CONVERSATION_ID,{model:[{role:'user',content:(i===0?'Archive background. '.repeat(2000):'')+(i%3===0?`review-page-fixture: Project atlas-${i} uses PostgreSQL.`:`Ordinary archive message ${i}.`),timestamp:Date.now()}]});
  },background));
  const input={operationId:crypto.randomUUID()};let release!:()=>void;
  inferenceFixtureControl.matches='review-page-fixture:';inferenceFixtureControl.gate=new Promise(resolve=>{release=resolve;});
  try{
    expect((await api(`/v1/bots/${bot.id}/memory/review`,input)).status).toBe(202);
    await until(()=>memory(bot),value=>value.review.status==='running');
    await abortAllDurableObjects();delete inferenceFixtureControl.gate;delete inferenceFixtureControl.matches;release();
    expect((await api(`/v1/bots/${bot.id}/memory/review`,input)).status).toBe(202);
    const reviewed=await until(()=>memory(bot),value=>value.review.status==='completed'&&!value.review.hasMore&&value.entries.length===20);
    expect(reviewed.entries.map(entry=>entry.content).sort()).toEqual(Array.from({length:20},(_,i)=>`Project atlas-${i*3} uses PostgreSQL.`).sort());
    expect(new Set(reviewed.entries.map(entry=>entry.sources[0]!.messageId)).size).toBe(20);
    expect(await messages(bot)).toEqual([]);
  }finally{delete inferenceFixtureControl.gate;delete inferenceFixtureControl.matches;release();}
});
