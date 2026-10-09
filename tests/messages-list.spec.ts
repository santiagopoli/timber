import {env,exports} from 'cloudflare:workers';
import {evictDurableObject,runInDurableObject} from 'cloudflare:test';
import {expect,it} from 'vitest';
import type {Bot,Message,MessagePage} from '@botspace/contracts';
const bindings=env as unknown as {BOT:DurableObjectNamespace};
const headers={authorization:'Bearer test-only-botspace-owner-token-000000','content-type':'application/json'};
const api=(path:string,init:RequestInit={})=>exports.default.fetch(`https://timber.test${path}`,{...init,headers});
const stub=(bot:Bot)=>bindings.BOT.get(bindings.BOT.idFromName(`owner:${bot.id}`));
async function createBot(){return (await(await api('/v1/bots',{method:'POST',body:JSON.stringify({name:'Archive paging'})})).json<{bot:Bot}>()).bot;}
async function seed(bot:Bot,start:number,count:number){
  const messages=Array.from({length:count},(_,offset)=>({id:crypto.randomUUID(),botId:bot.id,role:offset%2?'assistant':'user',text:`Retained message ${start+offset}`,createdAt:'2026-10-01T00:00:00.000Z'} satisfies Message));
  await runInDurableObject(stub(bot),(_instance,state)=>{for(const message of messages)state.storage.sql.exec('INSERT INTO messages(id,source_key,data) VALUES(?,?,?)',message.id,message.id,JSON.stringify(message));});
  return messages;
}
async function page(bot:Bot,query=''){const response=await api(`/v1/bots/${bot.id}/messages${query}`);expect(response.status).toBe(200);return response.json<MessagePage>();}
it('seamlessly pages every public message beyond the legacy 500 bound without truncation or insertion drift after eviction',async()=>{
  const bot=await createBot(),all=await seed(bot,0,1207);
  const legacy=await page(bot);expect(legacy.messages).toEqual(all.slice(-500));expect(legacy.nextCursor).not.toBeNull();
  let value=await page(bot,'?limit=100'),history=value.messages;
  await seed(bot,1207,3);await evictDurableObject(stub(bot));
  while(value.nextCursor){value=await page(bot,`?limit=100&before=${value.nextCursor}`);history=[...value.messages,...history];}
  expect(history).toEqual(all);expect(new Set(history.map(message=>message.id)).size).toBe(1207);
  expect((await page(bot)).messages.at(-1)?.text).toBe('Retained message 1209');
});
it('protects transcript pages with owner authentication, bot isolation and strict bounds',async()=>{
  const bot=await createBot(),other=await createBot();await seed(bot,0,2);
  expect((await exports.default.fetch(`https://timber.test/v1/bots/${bot.id}/messages?before=2`)).status).toBe(401);
  expect((await api(`/v1/bots/${crypto.randomUUID()}/messages?before=2`)).status).toBe(404);
  expect(await page(other)).toEqual({messages:[],nextCursor:null});
  for(const query of ['limit=','limit=0','limit=501','limit=-1','limit=1.5','limit=1e2','limit=Infinity','before=','before=0','before=-1','before=1.5','before=1e2','before=9007199254740992','before=garbage']){
    const response=await api(`/v1/bots/${bot.id}/messages?${query}`);expect(response.status,query).toBe(400);await response.text();
  }
  expect(await page(bot,'?before=1')).toEqual({messages:[],nextCursor:null});
});
