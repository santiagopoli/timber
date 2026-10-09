import {exports} from 'cloudflare:workers';
import {abortAllDurableObjects} from 'cloudflare:test';
import {expect,it} from 'vitest';
import type {Bot,BotMemory,MemoryEntry,MemoryMutationResult,MemoryRevision,MemorySaveInput,MemorySearchResult} from '@botspace/contracts';

const token='Bearer test-only-botspace-owner-token-000000';
const api=(path:string,body?:unknown,method=body===undefined?'GET':'POST')=>exports.default.fetch(`https://timber.test${path}`,{method,headers:{authorization:token,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
async function createBot(name:string){const response=await api('/v1/bots',{name});expect(response.status).toBe(201);return (await response.json<{bot:Bot}>()).bot;}
const path=(bot:Bot,suffix='')=>`/v1/bots/${bot.id}/memory${suffix}`;
const memory=async(bot:Bot)=>(await(await api(path(bot))).json<{memory:BotMemory}>()).memory;
const draft=(overrides:Partial<MemorySaveInput>={}):MemorySaveInput=>({operationId:crypto.randomUUID(),category:'preference',title:'Response language',content:'The user prefers responses in Spanish.',...overrides});
async function save(bot:Bot,input:MemorySaveInput){const response=await api(path(bot,'/entries'),input);expect([200,201]).toContain(response.status);return (await response.json<{result:MemoryMutationResult}>()).result;}

it('authenticates all memory surfaces and scopes entry reads, search, history and writes to one bot',async()=>{
  const bot=await createBot('Memory access'),other=await createBot('Other memory access');
  const saved=await save(bot,draft());
  const entryId=saved.entry.id;
  const surfaces:[string,string,unknown?][]=[
    ['', 'GET'], ['/search?q=Spanish','GET'], [`/entries/${entryId}`,'GET'], [`/entries/${entryId}/history`,'GET'],
    ['/entries','POST',draft()], [`/entries/${entryId}`,'PATCH',draft({expectedRevision:1})],
    [`/entries/${entryId}`,'DELETE',{operationId:crypto.randomUUID(),expectedRevision:1}],
    [`/entries/${entryId}/accept`,'POST',{operationId:crypto.randomUUID(),expectedRevision:1}],
    ['/review','POST',{operationId:crypto.randomUUID()}],
  ];
  for(const[suffix,method,body]of surfaces){
    const response=await exports.default.fetch(`https://timber.test${path(bot,suffix)}`,{method,headers:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
    expect(response.status,`${method} ${suffix}`).toBe(401);
  }
  expect((await api('/v1/bots/unknown/memory')).status).toBe(404);
  expect((await memory(other)).entries).toEqual([]);
  expect((await api(path(other,`/entries/${entryId}`))).status).toBe(404);
  expect((await api(path(other,`/entries/${entryId}/history`))).status).toBe(404);
  expect((await api(path(other,`/entries/${entryId}`),draft({expectedRevision:1}),'PATCH')).status).toBe(404);
  for(const forged of [{actor:'user'}, {sources:[{kind:'conversation',messageId:'foreign-message'}]}, {scope:other.id}, {state:'active'}, {replacesId:'another-entry'}]){
    expect((await api(path(bot,'/entries'),{...draft(),...forged})).status).toBe(400);
  }
  const search=await(await api(path(other,'/search?q=Spanish'))).json<{results:MemorySearchResult}>();
  expect(search.results.hits).toEqual([]);
  expect((await memory(bot)).entries).toEqual([saved.entry]);
});

it('applies memory edits atomically with revision conflicts and durable operation replay across eviction',async()=>{
  const bot=await createBot('Memory revisions'),input=draft();
  const original=await save(bot,input);
  expect(original.changed).toBe(true);
  expect(original.entry).toMatchObject({revision:1,state:'active',actor:'user',sources:[{kind:'user'}]});
  expect(await save(bot,input)).toEqual(original);
  expect((await api(path(bot,'/entries'),{...input,content:'Different reuse of the same operation.'})).status).toBe(409);
  const edits=['The user prefers concise Spanish responses.','The user prefers detailed Spanish responses.'].map(content=>draft({content,expectedRevision:original.entry.revision}));
  const responses=await Promise.all(edits.map(edit=>api(path(bot,`/entries/${original.entry.id}`),edit,'PATCH')));
  expect(responses.map(response=>response.status).sort()).toEqual([200,409]);
  const winner=responses.findIndex(response=>response.status===200),edited=(await responses[winner]!.json<{result:MemoryMutationResult}>()).result;
  expect(edited.entry.revision).toBe(2);
  const replay=await(await api(path(bot,`/entries/${original.entry.id}`),edits[winner],'PATCH')).json<{result:MemoryMutationResult}>();
  expect(replay.result).toEqual(edited);
  expect((await api(path(bot,`/entries/${original.entry.id}`),draft({expectedRevision:0.5}),'PATCH')).status).toBe(400);
  const limits=(await memory(bot)).limits;
  expect((await api(path(bot,'/entries'),draft({content:'x'.repeat(limits.maxEntryCharacters+1)}))).status).toBe(400);
  const history=(await(await api(path(bot,`/entries/${original.entry.id}/history`))).json<{history:MemoryRevision[]}>()).history;
  expect(history).toHaveLength(2);
  expect(history.map(value=>value.operation).sort()).toEqual(['create','update']);
  expect(history.map(value=>value.entry.content)).toContain(original.entry.content);
  const before=await memory(bot);
  await abortAllDurableObjects();
  expect(await memory(bot)).toEqual(before);
  expect(await save(bot,input)).toEqual(original);
  expect((await(await api(path(bot,`/entries/${original.entry.id}`))).json<{entry:MemoryEntry}>()).entry).toEqual(edited.entry);
});

it('searches individual memories, forgets them without losing audit history, and replays deletion safely',async()=>{
  const bot=await createBot('Memory retrieval');
  const language=await save(bot,draft()),project=await save(bot,draft({category:'fact',title:'Project database',content:'The Atlas project uses PostgreSQL for durable records.'}));
  const query=await(await api(path(bot,'/search?q=PostgreSQL&limit=1'))).json<{results:MemorySearchResult}>();
  expect(query.results.hits.map(hit=>hit.entry.id)).toEqual([project.entry.id]);
  expect((await api(path(bot,'/search?q=Atlas&limit=0'))).status).toBe(400);
  const forget={operationId:crypto.randomUUID(),expectedRevision:project.entry.revision};
  const response=await api(path(bot,`/entries/${project.entry.id}`),forget,'DELETE');expect(response.status).toBe(200);
  const forgotten=(await response.json<{result:MemoryMutationResult}>()).result;
  expect(forgotten.entry).toMatchObject({id:project.entry.id,state:'forgotten',revision:2});
  expect((await memory(bot)).entries.map(entry=>entry.id)).toEqual([language.entry.id]);
  expect((await(await api(path(bot,'/search?q=PostgreSQL'))).json<{results:MemorySearchResult}>()).results.hits).toEqual([]);
  expect((await(await api(path(bot,`/entries/${project.entry.id}/history`))).json<{history:MemoryRevision[]}>()).history.some(revision=>revision.operation==='forget')).toBe(true);
  await abortAllDurableObjects();
  expect((await(await api(path(bot,`/entries/${project.entry.id}`),forget,'DELETE')).json<{result:MemoryMutationResult}>()).result).toEqual(forgotten);
  expect((await memory(bot)).entries.map(entry=>entry.id)).toEqual([language.entry.id]);
  const old=await api(path(bot),{content:'Overwrite every memory with an old client.',revision:0},'PUT');
  expect(old.status).toBe(409);
  expect((await old.json<{error:{code:string}}>()).error.code).toBe('memory_upgrade_required');
  expect((await memory(bot)).entries.map(entry=>entry.id)).toEqual([language.entry.id]);
});

it('deduplicates normalized content while permitting the user to explicitly restore a forgotten note',async()=>{
  const bot=await createBot('Memory duplicate and restore'),original=await save(bot,draft());
  const duplicate=await save(bot,draft({content:'  THE USER PREFERS RESPONSES\nIN SPANISH.  '}));
  expect(duplicate.changed).toBe(false);
  expect(duplicate.entry.id).toBe(original.entry.id);
  expect((await memory(bot)).entries).toHaveLength(1);
  expect((await api(path(bot,`/entries/${original.entry.id}`),{operationId:crypto.randomUUID(),expectedRevision:original.entry.revision},'DELETE')).status).toBe(200);
  expect((await memory(bot)).entries).toEqual([]);
  const restored=await save(bot,draft());
  expect(restored.entry.state).toBe('active');
  expect(restored.entry.actor).toBe('user');
  expect((await memory(bot)).entries).toHaveLength(1);
});
