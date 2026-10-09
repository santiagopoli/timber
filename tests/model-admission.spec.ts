import {env,exports} from 'cloudflare:workers';
import {abortAllDurableObjects,runInDurableObject} from 'cloudflare:test';
import {expect,it} from 'vitest';
import type {Bot,Message,Run,ModelSettings} from '@botspace/contracts';
import type {AgentRuntime} from '../packages/runtime/src/types';
import {ModelConfigurationError,createModelSettings} from '../packages/runtime/src/model-settings';
import type {Env} from '../apps/api/src/env';

const bindings=env as unknown as Env;
const api=(path:string,method='GET',body?:unknown)=>exports.default.fetch(`https://botspace.test${path}`,{method,headers:{authorization:'Bearer test-only-botspace-owner-token-000000','content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
const stubFor=(bot:Bot)=>bindings.BOT.get(bindings.BOT.idFromName(`owner:${bot.id}`));
type Internals={runtime:AgentRuntime;admit(id:string):Promise<void>};
async function setup(){const {bot}=await(await api('/v1/bots','POST',{name:'Model admission'})).json<{bot:Bot}>();await(await api(`/v1/bots/${bot.id}/messages`)).text();return bot;}
async function send(bot:Bot,operationId=crypto.randomUUID()){const response=await api(`/v1/bots/${bot.id}/messages`,'POST',{text:'Keep this saved input',operationId});expect(response.status).toBe(202);return(await response.json<{run:Run}>()).run;}
const current=async(bot:Bot,run:Run)=>(await(await api(`/v1/bots/${bot.id}/runs/${run.id}`)).json<{run:Run}>()).run;
const complete=async(bot:Bot,run:Run)=>expect.poll(async()=>(await current(bot,run)).status).toBe('completed');
const messages=async(bot:Bot)=>(await(await api(`/v1/bots/${bot.id}/messages`)).json<{messages:Message[]}>()).messages;

it('preserves actionable configuration failure through eviction and retries only the unadmitted input with corrected settings',async()=>{
  const bot=await setup();let calls=0;
  await runInDurableObject(stubFor(bot),instance=>{
    const target=instance as unknown as Internals;
    target.runtime={...target.runtime,submit:async()=>{calls++;throw new ModelConfigurationError('model_unavailable');}};
  });
  const run=await send(bot);
  expect(run).toMatchObject({status:'failed',admissionRetryable:true,error:expect.stringContaining('Choose an available model')});
  expect(calls).toBe(1);
  await abortAllDurableObjects();
  expect(await current(bot,run)).toMatchObject({admissionRetryable:true,error:run.error});
  expect((await api(`/v1/bots/${bot.id}`,'PATCH',{model:'@cf/test/repaired'})).status).toBe(200);
  const selections:ModelSettings[]=[];
  await runInDurableObject(stubFor(bot),instance=>{
    const target=instance as unknown as Internals,original=target.runtime;
    target.runtime={...original,submit:async(text,input)=>{selections.push(input.modelSettings!);return original.submit(text,input);}};
  });
  expect((await send(bot,run.operationId)).id).toBe(run.id);await complete(bot,run);
  expect(selections).toEqual([{model:'@cf/test/repaired',fast:false}]);
  expect(await current(bot,run)).not.toHaveProperty('error');
  expect(await current(bot,run)).not.toHaveProperty('admissionRetryable');
  const updates=await runInDurableObject(stubFor(bot),(_instance,state)=>state.storage.sql.exec<{data:string}>("SELECT data FROM events WHERE json_extract(data,'$.type')='run.updated'").toArray().map(row=>JSON.parse(row.data).data.run as Run));
  expect(updates.some(value=>value.id===run.id&&value.admissionRetryable===true)).toBe(true);
  expect(updates.filter(value=>value.id===run.id).at(-1)).not.toHaveProperty('admissionRetryable');
  const history=await messages(bot);expect(history.filter(message=>message.role==='user')).toHaveLength(1);expect(history.filter(message=>message.role==='assistant')).toHaveLength(1);
  await send(bot,run.operationId);expect(selections).toHaveLength(1);
});

it('keeps catalogue failures specific through bounded automatic retries and recovers the same message',async()=>{
  const bot=await setup();let available=false,calls=0;const delays:number[]=[];
  await runInDurableObject(stubFor(bot),instance=>{
    const target=instance as unknown as Internals,original=target.runtime;
    target.runtime={...original,submit:async(text,input)=>{calls++;if(!available)throw new ModelConfigurationError('model_catalog_unavailable');return original.submit(text,input);},scheduleAdmissionRetry:async(_id,delay)=>{delays.push(delay);}};
  });
  const run=await send(bot);expect(run).toMatchObject({status:'queued',admissionRetryable:true});expect(run.error).toContain('catalogue is temporarily unavailable');
  for(let i=0;i<6;i++)await runInDurableObject(stubFor(bot),async(instance,state)=>{state.storage.sql.exec('UPDATE admission_retries SET next_at=0 WHERE operation_id=?',run.operationId);await(instance as unknown as Internals).admit(run.operationId);});
  expect(calls).toBe(5);expect(delays).toEqual([1000,2000,4000,8000]);expect((await current(bot,run)).error).toBe(run.error);
  available=true;await send(bot,run.operationId);await complete(bot,run);
  expect(calls).toBe(6);expect((await messages(bot)).filter(message=>message.role==='user')).toHaveLength(1);
});

it('does not turn an admitted receipt into a configuration retry or revive an explicitly stopped input',async()=>{
  const bot=await setup();let calls=0;
  await runInDurableObject(stubFor(bot),instance=>{
    const target=instance as unknown as Internals,original=target.runtime;
    target.runtime={...original,submit:async(text,input)=>{calls++;await original.submit(text,input);throw new ModelConfigurationError('model_unavailable');}};
  });
  const run=await send(bot);await complete(bot,run);await send(bot,run.operationId);expect(calls).toBe(1);
  expect(await runInDurableObject(stubFor(bot),(_instance,state)=>state.storage.sql.exec('SELECT * FROM configuration_admissions').toArray())).toEqual([]);
  await runInDurableObject(stubFor(bot),instance=>{
    const target=instance as unknown as Internals;target.runtime={...target.runtime,submit:async()=>{calls++;throw new ModelConfigurationError('chatgpt_not_connected');}};
  });
  const stopped=await send(bot);expect(stopped.error).toContain('Connect ChatGPT');
  await(await api(`/v1/bots/${bot.id}/runs/${stopped.id}/cancel`,'POST',{})).text();
  await send(bot,stopped.operationId);expect(calls).toBe(2);expect((await current(bot,stopped)).cancellation).toBeDefined();expect(await current(bot,stopped)).not.toHaveProperty('admissionRetryable');
});

it('classifies missing connections, provider catalogue failures and unsupported settings before native submission with fixed safe messages',async()=>{
  const bot=await setup();
  await runInDurableObject(stubFor(bot),async(_instance,state)=>{
    const model={id:'selectable',name:'Selectable',provider:'openai' as const,reasoningEfforts:['adaptive'],supportsFast:false};
    let catalog={connected:false,defaultModel:'selectable',models:[model],error:undefined as string|undefined};
    const settings=createModelSettings(state.storage,{fetch:async()=>new Response(),models:async()=>catalog},()=>{throw new Error('No cloud inference expected');});
    await expect(settings.configure({model:'selectable'})).rejects.toMatchObject({code:'chatgpt_not_connected',retryable:false});
    catalog={...catalog,connected:true,error:'private provider payload'};
    await expect(settings.configure({model:'selectable'})).rejects.toMatchObject({code:'model_catalog_unavailable',retryable:true,message:expect.not.stringContaining('private')});
    catalog.error=undefined;
    await expect(settings.configure({model:'missing'})).rejects.toMatchObject({code:'model_unavailable'});
    await expect(settings.configure({model:'selectable',reasoningEffort:'high'})).rejects.toMatchObject({code:'reasoning_unsupported'});
    await expect(settings.configure({model:'selectable',fast:true})).rejects.toMatchObject({code:'fast_unsupported'});
    expect(state.storage.sql.exec('SELECT * FROM timber_model_configs').toArray()).toEqual([]);
  });
});
