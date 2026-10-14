import {env,exports} from 'cloudflare:workers';
import {runInDurableObject} from 'cloudflare:test';
import {describe,it,expect} from 'vitest';
import type {Bot,Device,DeviceJob,Run,Task} from '@botspace/contracts';
import {deviceProofHeaders} from '../packages/contracts/src/devices';
import type {Env} from '../apps/api/src/env';
const bindings=env as unknown as Env;
const owner={'authorization':'Bearer test-only-botspace-owner-token-000000','content-type':'application/json'};
async function api(path:string,input?:unknown,method=input===undefined?'GET':'POST'){
  const response=await exports.default.fetch(`https://timber.test${path}`,{method,headers:owner,...input===undefined?{}:{body:JSON.stringify(input)}});
  return new Response(await response.text(),{status:response.status});
}
async function machine(){
  const keys=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']) as CryptoKeyPair;
  const paired=await exports.default.fetch('https://timber.test/v1/device-connect/pairings',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'Integration Mac',platform:'darwin',version:'test',publicKey:await crypto.subtle.exportKey('jwk',keys.publicKey),workspaces:[{id:'project',name:'Project',path:'/Users/owner/project',capabilities:['files.read','files.write','host.shell','agent.run','diagnostics']}]})});
  expect(paired.status).toBe(201);const {code}=await paired.json<{code:string}>();
  const approved=await api('/v1/devices/pairings/approve',{code});expect(approved.status).toBe(200);
  const {device}=await approved.json<{device:Device}>();
  async function signed(tail:string,input:unknown={}){
    const path=`/v1/device-connect/${device.id}/${tail}`,body=JSON.stringify(input),proof=await deviceProofHeaders(keys.privateKey,{id:device.id,path,method:'POST',body});
    const response=await exports.default.fetch(`https://timber.test${path}`,{method:'POST',headers:{'content-type':'application/json',...proof},body});
    return new Response(await response.text(),{status:response.status});
  }
  const created=await api('/v1/bots',{name:'Local Pi integration',model:'@cf/zai-org/glm-4.7-flash'});expect(created.status).toBe(201);
  const {bot}=await created.json<{bot:Bot}>();
  const target={kind:'device',deviceId:device.id,workspaceId:'project',agentMode:'local'};
  expect((await api(`/v1/devices/${device.id}/grants`,{botId:bot.id,workspaceIds:['project'],permissions:['files.read','files.write','host.shell','agent.run','diagnostics']})).status).toBe(200);
  expect((await api(`/v1/bots/${bot.id}`,{executionTarget:target},'PATCH')).status).toBe(200);
  return {device,bot,target,signed};
}
describe('owned machine BotDO integration',()=>{
  it('queues real local Pi admission offline, projects signed results into Timber and rejects cross-run callbacks',async()=>{
    const {bot,device,target,signed}=await machine(),operationId=crypto.randomUUID();
    const receipt=await api(`/v1/bots/${bot.id}/messages`,{operationId,text:'Inspect my project'});expect(receipt.status).toBe(202);
    const {run}=await receipt.json<{run:Run}>();expect(run.executionTarget).toEqual(target);
    // Selecting a machine never starts a Cloudflare computer or uses cloud Pi.
    expect((await api(`/v1/bots/${bot.id}/computer`)).status).toBe(200);
    const botStub=bindings.BOT.get(bindings.BOT.idFromName(`owner:${bot.id}`));
    let admitted=false;
    for(let attempt=0;attempt<40&&!admitted;attempt++){await new Promise(resolve=>setTimeout(resolve,50));admitted=await runInDurableObject(botStub,(_instance,state)=>state.storage.sql.exec('SELECT 1 FROM timber_local_runtime_operations WHERE operation_id=?',operationId).toArray().length===1);}
    if(!admitted){const diagnostic=await api(`/v1/bots/${bot.id}/runs/${run.id}`);throw new Error(await diagnostic.text());}
    const polled=await signed('jobs/poll');expect(polled.status).toBe(200);
    const {jobs}=await polled.json<{jobs:DeviceJob[]}>();expect(jobs).toHaveLength(1);const job=jobs[0];expect(job.type).toBe('agent');expect(job.agent?.botId).toBe(bot.id);
    expect((await signed(`jobs/${job.id}/start`,{claimToken:job.claimToken})).status).toBe(200);
    const event={type:'run.started',eventKey:'test:start',data:{}};
    expect((await signed(`jobs/${job.id}/agent/event`,{claimToken:job.claimToken,sequence:1,event})).status).toBe(200);
    expect((await signed(`jobs/${job.id}/agent/event`,{claimToken:job.claimToken,sequence:1,event})).status).toBe(200);
    const denied=await api(`/v1/bots/${bot.id}/device-runtime/tool`,{job,payload:{}});expect(denied.status).toBe(404);
    expect((await signed(`jobs/${job.id}/result`,{claimToken:job.claimToken,agentResult:{status:'done',text:'Project inspected.',kind:'final'}})).status).toBe(200);
    let latest:Run=run;
    for(let attempt=0;attempt<30&&latest.status!=='completed';attempt++){await new Promise(resolve=>setTimeout(resolve,50));latest=(await (await api(`/v1/bots/${bot.id}/runs/${run.id}`)).json<{run:Run}>()).run;}
    expect(latest.status).toBe('completed');
    const messages=await (await api(`/v1/bots/${bot.id}/messages`)).json<{messages:Array<{text:string}>}>();expect(messages.messages.some(message=>message.text==='Project inspected.')).toBe(true);
    expect((await signed(`jobs/${job.id}/agent/tool`,{claimToken:job.claimToken,name:'read_file',operationId:`pi-local-tool:${'a'.repeat(64)}`,arguments:{path:'README.md'}})).status).toBe(409);
  },30000);
  it('freezes task location independently of later bot edits and requires grants for task overrides',async()=>{
    const {bot,target,device}=await machine();
    const created=await api('/v1/tasks',{operationId:crypto.randomUUID(),title:'Laptop task',description:'Inspect project',botId:bot.id,startImmediately:false});expect(created.status).toBe(201);
    const {task}=await created.json<{task:Task}>();expect(task.executionTarget).toEqual(target);
    expect((await api(`/v1/bots/${bot.id}`,{executionTarget:{kind:'cloud'}},'PATCH')).status).toBe(200);
    const status=await (await api(`/v1/tasks/${task.id}/computer`)).json<{computer:{provider:string;deviceId:string}}>();expect(status.computer.provider).toBe('device');expect(status.computer.deviceId).toBe(device.id);
    const other=await (await api('/v1/bots',{name:'No grants'})).json<{bot:Bot}>();
    expect((await api('/v1/tasks',{operationId:crypto.randomUUID(),title:'Unauthorized',description:'',botId:other.bot.id,startImmediately:false,executionTarget:target})).status).toBe(403);
    expect((await api(`/v1/tasks/${task.id}/workspace/tree`)).status).toBe(409);
  },30000);
  it('routes cloud Pi computer actions to the permitted machine with an explicit approval receipt',async()=>{
    const {bot,target,signed}=await machine();
    expect((await api(`/v1/bots/${bot.id}`,{executionTarget:{...target,agentMode:'cloud'}},'PATCH')).status).toBe(200);
    const receipt=await api(`/v1/bots/${bot.id}/messages`,{operationId:crypto.randomUUID(),text:'fixture:approval'});expect(receipt.status).toBe(202);
    let approvals:Array<{id:string;status:string}>=[];
    for(let attempt=0;attempt<40&&!approvals.length;attempt++){await new Promise(resolve=>setTimeout(resolve,25));approvals=(await (await api(`/v1/bots/${bot.id}/approvals`)).json<{approvals:Array<{id:string;status:string}>}>()).approvals;}
    expect(approvals[0]?.status).toBe('pending');
    const decision=api(`/v1/bots/${bot.id}/approvals/${approvals[0].id}`,{decision:'approve'});
    let jobs:DeviceJob[]=[];
    for(let attempt=0;attempt<40&&!jobs.length;attempt++){await new Promise(resolve=>setTimeout(resolve,25));jobs=(await (await signed('jobs/poll')).json<{jobs:DeviceJob[]}>()).jobs;}
    expect(jobs).toHaveLength(1);const job=jobs[0];expect(job.action).toEqual({type:'exec',command:'printf original-approved-command'});expect(job.approval?.mode).toBe('approved');expect(job.nativeOperationId).toBeTruthy();
    expect((await signed(`jobs/${job.id}/start`,{claimToken:job.claimToken})).status).toBe(200);
    expect((await signed(`jobs/${job.id}/result`,{claimToken:job.claimToken,result:{operationId:job.operationId,status:'completed',output:'original-approved-command',exitCode:0}})).status).toBe(200);
    expect((await decision).status).toBe(200);
    const cloud=bindings.COMPUTER.get(bindings.COMPUTER.idFromName(bot.id));
    await runInDurableObject(cloud,(_instance,state)=>expect(state.storage.sql.exec('SELECT * FROM effects').toArray()).toHaveLength(0));
  },30000);
});
