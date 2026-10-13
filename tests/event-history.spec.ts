import {env,exports} from "cloudflare:workers";
import {runInDurableObject} from "cloudflare:test";
import {describe,expect,it} from "vitest";
import type {Bot,BotEvent,Run} from "@botspace/contracts";
import type {Env} from "../apps/api/src/env";
const bindings=env as unknown as Env;
const headers={authorization:"Bearer test-only-botspace-owner-token-000000","content-type":"application/json"};
const api=(path:string,init:RequestInit={})=>exports.default.fetch(`https://timber.test${path}`,{...init,headers});
const stub=(bot:Bot)=>bindings.BOT.get(bindings.BOT.idFromName(`owner:${bot.id}`));
async function create():Promise<Bot>{const response=await api('/v1/bots',{method:'POST',body:JSON.stringify({name:'event-history'})});expect(response.status).toBe(201);const {bot}=await response.json<{bot:Bot}>();await (await api(`/v1/bots/${bot.id}/messages`)).text();return bot;}
async function seed(bot:Bot,count:number,output='') {return runInDurableObject(stub(bot),(_instance,state)=>{const ids:number[]=[];for(let i=0;i<count;i++){state.storage.sql.exec('INSERT INTO events(source_key,data) VALUES(?,?)',`seed:${i}`,JSON.stringify({botId:bot.id,type:'tool.completed',createdAt:'2026-10-01T00:00:00.000Z',data:{sequence:i,output}}));ids.push(state.storage.sql.exec<{id:number}>('SELECT last_insert_rowid() AS id').one().id);}return ids;});}
async function page(bot:Bot,query=''){const response=await api(`/v1/bots/${bot.id}/events?format=json${query}`);expect(response.status).toBe(200);return response.json<{events:BotEvent[];nextCursor:string|null}>();}
async function stream(bot:Bot,query:string,until:(events:BotEvent[])=>boolean){const response=await api(`/v1/bots/${bot.id}/events?${query}`);expect(response.status).toBe(200);const reader=response.body!.getReader(),decoder=new TextDecoder();let buffer='',events:BotEvent[]=[],maxChunk=0;try{while(!until(events)){const chunk=await reader.read();if(chunk.done)break;maxChunk=Math.max(maxChunk,chunk.value.length);buffer+=decoder.decode(chunk.value,{stream:true});const frames=buffer.split('\n\n');buffer=frames.pop()!;for(const frame of frames){const line=frame.split('\n').find(value=>value.startsWith('data: '));if(line)events.push(JSON.parse(line.slice(6)));}}}finally{await reader.cancel();}return {events,maxChunk};}
describe('bounded durable event history',()=>{
  it('requires auth and bot membership for JSON history',async()=>{const bot=await create();const denied=await exports.default.fetch(`https://timber.test/v1/bots/${bot.id}/events?format=json`);expect(denied.status).toBe(401);await denied.text();const missing=await api(`/v1/bots/${crypto.randomUUID()}/events?format=json`);expect(missing.status).toBe(404);await missing.text();});
  it('pages stable newest events chronologically while retaining the full archive',async()=>{const bot=await create(),ids=await seed(bot,205);const newest=await page(bot);expect(newest.events.map(event=>event.id)).toEqual(ids.slice(-100));const cursor=newest.nextCursor;expect(cursor).toBe(String(ids[105]));await runInDurableObject(stub(bot),(_instance,state)=>{state.storage.sql.exec('INSERT INTO events(data) VALUES(?)',JSON.stringify({botId:bot.id,type:'new',data:{},createdAt:new Date().toISOString()}));});const older=await page(bot,`&before=${cursor}`);expect(older.events.map(event=>event.id)).toEqual(ids.slice(5,105));const oldest=await page(bot,`&before=${older.nextCursor}`);expect(oldest.events.map(event=>event.id)).toEqual(ids.slice(0,5));expect(oldest.nextCursor).toBeNull();});
  it('returns indexed activity across hundreds of streamed deltas with stable filtered pagination',async()=>{
    const bot=await create();
    const activity=await runInDurableObject(stub(bot),(_instance,state)=>{
      const result:number[]=[];
      for(let i=0;i<503;i++) {
        const type=i===0?'tool.started':i===251?'tool.completed':i===502?'task.updated':'message.delta';
        state.storage.sql.exec('INSERT INTO events(data) VALUES(?)',JSON.stringify({botId:bot.id,type,createdAt:new Date().toISOString(),data:{sequence:i,delta:'text'}}));
        if(type!=='message.delta')result.push(state.storage.sql.exec<{id:number}>('SELECT last_insert_rowid() AS id').one().id);
      }
      return result;
    });
    const all=await page(bot,'&view=activity');
    expect(all.events.map(event=>event.id)).toEqual(activity);expect(all.nextCursor).toBeNull();
    const newest=await page(bot,'&view=activity&limit=2');
    expect(newest.events.map(event=>event.id)).toEqual(activity.slice(1));expect(newest.nextCursor).toBe(String(activity[1]));
    const older=await page(bot,`&view=activity&limit=2&before=${newest.nextCursor}`);
    expect(older.events.map(event=>event.id)).toEqual(activity.slice(0,1));expect(older.nextCursor).toBeNull();
    const full=await page(bot);expect(full.events).toHaveLength(100);expect(full.events.filter(event=>event.type==='message.delta')).toHaveLength(99);
    for(const view of ['','all','private','tools']){const response=await api(`/v1/bots/${bot.id}/events?format=json&view=${view}`);expect(response.status).toBe(400);await response.text();}
  });
  it('validates bounded JSON pages and SSE tails without opening invalid streams',async()=>{const bot=await create();for(const query of ['limit=0','limit=101','limit=1.1','before=0','before=-1','before=9007199254740992']){const r=await api(`/v1/bots/${bot.id}/events?format=json&${query}`);expect(r.status,query).toBe(400);await r.text();}for(const value of ['0','101','1.1','nope','']){const r=await api(`/v1/bots/${bot.id}/events?tail=${value}`);expect(r.status,value).toBe(400);await r.text();}});
  it('bootstraps only the requested tail and restores full active partial text at the same cursor',async()=>{const bot=await create(),ids=await seed(bot,205);const run:Run={id:crypto.randomUUID(),botId:bot.id,operationId:'live-partial',status:'running',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};await runInDurableObject(stub(bot),(_instance,state)=>{state.storage.sql.exec('INSERT INTO runs(id,operation_id,fingerprint,native_operation_id,data) VALUES(?,?,?,?,?)',run.id,run.operationId,'fixture',run.operationId,JSON.stringify(run));state.storage.sql.exec('INSERT INTO runtime_stream_state(run_id,text) VALUES(?,?)',run.id,'Complete partial including older omitted deltas');});const result=await stream(bot,'after=0&tail=10',events=>events.some(event=>event.type==='stream.snapshot'));expect(result.events.filter(event=>event.type!=='stream.snapshot').map(event=>event.id)).toEqual(ids.slice(-10));expect(result.events.at(-1)).toMatchObject({id:ids.at(-1),type:'stream.snapshot',data:{latestEventId:ids.at(-1),historyTruncated:true,nextCursor:String(ids[195]),partials:[{runId:run.id,text:'Complete partial including older omitted deltas'}]}});const archive=await page(bot,`&before=${ids[195]}`);expect(archive.events).toHaveLength(100);});
  it('reconnects after the durable cursor without a new tail snapshot or lost events',async()=>{const bot=await create(),ids=await seed(bot,20);const result=await stream(bot,`after=${ids[15]}&tail=1`,events=>events.length>=4);expect(result.events.map(event=>event.id)).toEqual(ids.slice(16));expect(result.events.some(event=>event.type==='stream.snapshot')).toBe(false);});
  it('backpressures large tool events instead of buffering the whole tail in one chunk',async()=>{const bot=await create(),ids=await seed(bot,20,'x'.repeat(90_000));const result=await stream(bot,'after=0&tail=20',events=>events.some(event=>event.type==='stream.snapshot'));expect(result.events.filter(event=>event.type!=='stream.snapshot').map(event=>event.id)).toEqual(ids);expect(result.maxChunk).toBeLessThan(128*1024);});
});
