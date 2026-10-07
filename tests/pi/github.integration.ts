import { env, exports } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import type { Bot, ConnectionRequest, Message, Run } from '@botspace/contracts';
import type { Env } from '../../apps/api/src/env';

const bindings=env as unknown as Env;
const api=(path:string,body?:unknown)=>exports.default.fetch(`https://botspace.test${path}`,{
  method:body===undefined?'GET':'POST',
  headers:{authorization:'Bearer test-only-botspace-owner-token-000000','content-type':'application/json'},
  ...(body===undefined?{}:{body:JSON.stringify(body)}),
});

it('resumes actual BotDO and Pi after a verified GitHub callback and saves the final answer without another user message',async()=>{
  const inference=bindings.CHATGPT!.get(bindings.CHATGPT!.idFromName('owner'));
  const beforeCalls=await runInDurableObject(inference,(_instance,state)=>state.storage.sql.exec<{total:number}>('SELECT COUNT(*) AS total FROM inference_calls').one().total);
  const created=await api('/v1/bots',{name:'GitHub native continuation'});
  expect(created.status).toBe(201);
  const {bot}=await created.json<{bot:Bot}>();
  const submitted=await api(`/v1/bots/${bot.id}/messages`,{text:'request-github-connect',operationId:crypto.randomUUID()});
  expect(submitted.status).toBe(202);
  const {run}=await submitted.json<{run:Run}>();
  const botStub=bindings.BOT.get(bindings.BOT.idFromName(`owner:${bot.id}`));
  const storedRun=()=>runInDurableObject(botStub,(_instance,state)=>JSON.parse(state.storage.sql.exec<{data:string}>('SELECT data FROM runs WHERE id=?',run.id).one().data) as Run);
  // Inspect durable state directly: these reads cannot call BotDO.recover/admit.
  await expect.poll(async()=>(await storedRun()).status).toBe('waiting_connection');
  const connection=await runInDurableObject(botStub,(_instance,state)=>JSON.parse(state.storage.sql.exec<{data:string}>('SELECT data FROM connections').one().data) as ConnectionRequest);
  expect(connection).toMatchObject({provider:'github',repository:'owner/private',permission:'write',status:'pending',runId:run.id});
  await expect.poll(()=>runInDurableObject(botStub,(_instance,state)=>state.storage.sql.exec<{approval:string}>('SELECT approval FROM botspace_runtime_pauses WHERE operation_id=?',run.operationId).toArray().map(row=>JSON.parse(row.approval)))).toEqual([expect.objectContaining({status:'pending_connection',requestId:connection.id})]);
  expect(await runInDurableObject(inference,(_instance,state)=>state.storage.sql.exec<{total:number}>('SELECT COUNT(*) AS total FROM inference_calls').one().total)).toBe(beforeCalls+1);

  const github=bindings.GITHUB!.get(bindings.GITHUB!.idFromName('owner'));
  type GitHubInternals={notify(flow:{botId:string;requestId:string;repository:string;permission:'read'|'write'}):Promise<boolean>};
  const flow={botId:bot.id,requestId:connection.id,repository:connection.repository,permission:connection.permission};
  await runInDurableObject(github,async(instance,state)=>{
    // OAuth is external to this test. Persist exactly its verified grant shape;
    // all following authorization checks, notification, host and Pi are real.
    const revision=crypto.randomUUID();
    await state.storage.put({
      connection:{connected:true,revision,app:{id:123,slug:'timber-test'},account:{id:456,login:'fixture-owner'}},
      [`grant:${bot.id}:${connection.repository}`]:{botId:bot.id,repository:connection.repository,permission:'write',installationId:789,revision},
    });
    expect(await (instance as unknown as GitHubInternals).notify(flow)).toBe(true);
  });
  await expect.poll(async()=>(await storedRun()).status).toBe('completed');
  await runInDurableObject(github,async instance=>{expect(await (instance as unknown as GitHubInternals).notify(flow)).toBe(true);});

  const {messages}=await (await api(`/v1/bots/${bot.id}/messages`)).json<{messages:Message[]}>();
  expect(messages.filter(message=>message.role==='user')).toHaveLength(1);
  expect(messages.filter(message=>message.role==='assistant')).toEqual([expect.objectContaining({kind:'final',text:'Hello from ChatGPT via the real Pi harness.'})]);
  await runInDurableObject(botStub,(_instance,state)=>{
    const continuation=state.storage.sql.exec<{operation_id:string;admitted:number}>('SELECT operation_id,admitted FROM submissions WHERE operation_id LIKE ?','connection:%').toArray();
    expect(continuation).toEqual([{operation_id:`connection:${connection.id}`,admitted:1}]);
    expect(JSON.parse(state.storage.sql.exec<{data:string}>('SELECT data FROM connections WHERE id=?',connection.id).one().data).status).toBe('connected');
  });
  const calls=await runInDurableObject(inference,(_instance,state)=>state.storage.sql.exec<{input:string}>('SELECT input FROM inference_calls WHERE id>? ORDER BY id',beforeCalls).toArray());
  expect(calls).toHaveLength(2);
  expect(calls[1]!.input).toContain('pending_connection');
  expect(calls[1]!.input).toContain('The tool that requested access was NOT executed');
  const computer=bindings.COMPUTER.get(bindings.COMPUTER.idFromName(bot.id));
  expect(await runInDurableObject(computer,(_instance,state)=>state.storage.sql.exec('SELECT id FROM effects').toArray())).toHaveLength(0);
});
