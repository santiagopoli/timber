import {env,exports} from 'cloudflare:workers';
import {runInDurableObject} from 'cloudflare:test';
import {expect,it} from 'vitest';
import {createMemoryService} from '@botspace/memory';
import type {Bot,MemoryMutationResult,Message} from '@botspace/contracts';
import type {RuntimeHostToolRequest} from '@botspace/runtime';
import type {Env} from '../apps/api/src/env';
import {dispatchDeviceMemory,snapshotDeviceMemory} from '../apps/api/src/device-memory';
const bindings=env as unknown as Env;
async function bot(){const response=await exports.default.fetch('https://timber.test/v1/bots',{method:'POST',headers:{authorization:'Bearer test-only-botspace-owner-token-000000','content-type':'application/json'},body:JSON.stringify({name:'Central device memory'})});return(await response.json<{bot:Bot}>()).bot;}
const stub=(owner:Bot)=>bindings.BOT.get(bindings.BOT.idFromName(`owner:${owner.id}`));
function request(name:string,args:Record<string,unknown>,extra:Partial<RuntimeHostToolRequest>={}):RuntimeHostToolRequest{return {operationId:crypto.randomUUID(),runOperationId:crypto.randomUUID(),name,arguments:args,signal:new AbortController().signal,...extra};}
async function seed(owner:Bot,message:Partial<Message>={}){const id=crypto.randomUUID();await(await exports.default.fetch(`https://timber.test/v1/bots/${owner.id}/messages`,{headers:{authorization:'Bearer test-only-botspace-owner-token-000000'}})).arrayBuffer();await runInDurableObject(stub(owner),(_instance,state)=>state.storage.sql.exec('INSERT INTO messages(id,source_key,data) VALUES(?,?,?)',id,`input:${id}`,JSON.stringify({id,botId:owner.id,role:'user',text:'I prefer concise replies in Spanish.',createdAt:new Date().toISOString(),...message})));return id;}
const call=(owner:Bot,input:RuntimeHostToolRequest)=>runInDurableObject(stub(owner),(_instance,state)=>dispatchDeviceMemory(state.storage,owner.id,input));
it('device writes and cloud memory APIs share canonical human evidence, durable receipts and bounded future context',async()=>{
 const owner=await bot(),id=await seed(owner),input=request('memory_save',{category:'preference',title:'Response language',content:'Reply concisely in Spanish.',sources:[{messageId:id,quote:'I prefer concise replies in Spanish.'}]});
 const saved=await call(owner,input);expect(saved?.status).toBe('completed');const result=JSON.parse(saved!.output!) as MemoryMutationResult;expect(result.entry.state).toBe('active');expect(result.entry.sources[0]).toMatchObject({messageId:id,role:'user'});expect(await call(owner,input)).toEqual(saved);
 await runInDurableObject(stub(owner),(_instance,state)=>{const memory=createMemoryService({sql:state.storage.sql,transactionSync:work=>state.storage.transactionSync(work)});expect(memory.overview('bot').entries).toHaveLength(1);expect(memory.get('bot',result.entry.id).content).toBe('Reply concisely in Spanish.');expect(snapshotDeviceMemory(state.storage,owner.id)).toContain('Reply concisely in Spanish.');});
 const recalled=await call(owner,request('recall_history',{query:'concise'}));expect(JSON.parse(recalled!.output!).messages[0].id).toBe(id);
});
it('assistant-only facts are suggestions, while preferences require actual human messages',async()=>{
 const owner=await bot(),id=await seed(owner,{role:'assistant',text:'A reusable build procedure runs typecheck before release.'}),args={category:'procedure',title:'Build procedure',content:'Run typecheck before release.',sources:[{messageId:id,quote:'A reusable build procedure runs typecheck before release.'}]};
 const saved=await call(owner,request('memory_save',args));expect(saved?.status).toBe('completed');expect((JSON.parse(saved!.output!) as MemoryMutationResult).entry.state).toBe('suggested');
 expect((await call(owner,request('memory_save',{...args,category:'preference'})))?.status).toBe('failed');
});
it('foreign messages, forged quotes, delegated envelopes and subagents cannot write parent memories',async()=>{
 const owner=await bot(),other=await bot(),id=await seed(owner),foreign=await seed(owner,{botId:other.id}),delegated=await seed(owner,{provenance:{kind:'bot',sourceBotId:other.id,sourceBotName:'Other bot'}}),args={category:'fact',title:'Verified fact',content:'A stable sourced fact.',sources:[{messageId:id,quote:'I prefer concise replies in Spanish.'}]};
 for(const input of [request('memory_save',{...args,sources:[{messageId:foreign,quote:'I prefer concise replies in Spanish.'}]}),request('memory_save',{...args,sources:[{messageId:id,quote:'A forged quote'}]}),request('memory_save',{...args,sources:[{messageId:delegated,quote:'I prefer concise replies in Spanish.'}]}),request('memory_save',args,{subagentId:crypto.randomUUID()}),request('memory_save',{...args,scope:'inherited'})])expect((await call(owner,input))?.status).toBe('failed');
 const list=await call(owner,request('memory_list',{}));expect(JSON.parse(list!.output!).entries).toHaveLength(0);
});
it('pinned owner notes require suggestions, and credentials cannot enter durable memory',async()=>{
 const owner=await bot(),id=await seed(owner);const entry=await runInDurableObject(stub(owner),(_instance,state)=>createMemoryService({sql:state.storage.sql,transactionSync:work=>state.storage.transactionSync(work)}).save('bot',{operationId:crypto.randomUUID(),category:'fact',title:'Owner note',content:'Keep this owner edit.',pinned:true},{actor:'user',sources:[{kind:'user'}]}).entry);
 const update={id:entry.id,expectedRevision:entry.revision,category:'fact',title:'Owner note',content:'Replace the owner note.',sources:[{messageId:id,quote:'I prefer concise replies in Spanish.'}]};expect((await call(owner,request('memory_save',update)))?.status).toBe('failed');expect((await call(owner,request('memory_suggest',update)))?.status).toBe('completed');
 expect((await call(owner,request('memory_save',{category:'fact',title:'Private key',content:'api_key=fixture_private_credential_123456789',sources:[{messageId:id,quote:'I prefer concise replies in Spanish.'}]})))?.status).toBe('failed');
});
