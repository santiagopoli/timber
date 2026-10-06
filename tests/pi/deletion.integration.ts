import { env, exports } from "cloudflare:workers";
import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import type { Bot, Run } from "@botspace/contracts";
import type { Env } from "../../apps/api/src/env";

const bindings=env as unknown as Env;
const api=(path:string,method="GET",body?:unknown)=>exports.default.fetch(`https://botspace.test${path}`,{
  method,headers:{authorization:"Bearer test-only-botspace-owner-token-000000","content-type":"application/json"},
  ...(body===undefined?{}:{body:JSON.stringify(body)}),
});
it("erases the actual Pi transcript and durable jobs and never reopens them after a deleted bot restarts",async()=>{
  const {bot}=await (await api("/v1/bots","POST",{name:"Delete actual Pi"})).json<{bot:Bot}>();
  const {run}=await (await api(`/v1/bots/${bot.id}/messages`,"POST",{text:"Remember this private text then respond",operationId:crypto.randomUUID()})).json<{run:Run}>();
  for(let i=0;i<100;i++) {
    const current=(await (await api(`/v1/bots/${bot.id}/runs/${run.id}`)).json<{run:Run}>()).run;
    if(current.status==="completed") break;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  const deleted=await api(`/v1/bots/${bot.id}`,"DELETE");
  expect(deleted.status).toBe(200);expect(await deleted.json()).toEqual({botId:bot.id,deleted:true});
  const inspect=()=>runInDurableObject(bindings.BOT.get(bindings.BOT.idFromName(`owner:${bot.id}`)),async(_instance,state)=>{
    const tables=state.storage.sql.exec<{name:string}>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name!='bot_deletion'").toArray();
    for(const {name} of tables) expect(state.storage.sql.exec<{total:number}>(`SELECT COUNT(*) AS total FROM "${name.replace(/"/g,'""')}"`).one().total).toBe(0);
    expect(await state.storage.list()).toEqual(new Map());
    expect(await state.storage.getAlarm()).toBeNull();
  });
  await inspect();
  await abortAllDurableObjects();
  expect((await bindings.BOT.get(bindings.BOT.idFromName(`owner:${bot.id}`)).fetch("https://bot/messages",{headers:{"x-botspace-config":encodeURIComponent(JSON.stringify(bot))}})).status).toBe(404);
  await inspect();
  expect((await api(`/v1/bots/${bot.id}`,"DELETE")).status).toBe(200);
});
