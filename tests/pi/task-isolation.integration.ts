import {env,exports} from 'cloudflare:workers';
import {runDurableObjectAlarm,runInDurableObject} from 'cloudflare:test';
import {afterEach,expect,it} from 'vitest';
import type {Bot,Task,Run,Approval} from '@botspace/contracts';
import type {Env} from '../../apps/api/src/env';
import {computerName} from '@botspace/computer';
import {computerFixtureControl} from '../fixtures/worker';
import {inferenceFixtureControl} from './worker';
const bindings=env as unknown as Env;
async function api<T>(path:string,input?:unknown){const r=await exports.default.fetch(`https://timber.test${path}`,{method:input===undefined?'GET':'POST',headers:{authorization:'Bearer test-only-botspace-owner-token-000000','content-type':'application/json'},...(input===undefined?{}:{body:JSON.stringify(input)})});const value=await r.json<T>();expect(r.ok).toBe(true);return value;}
const registry=()=>bindings.WORKSPACE.get(bindings.WORKSPACE.idFromName('owner'));
afterEach(()=>{delete computerFixtureControl.isolatedTasks;delete inferenceFixtureControl.gate;delete inferenceFixtureControl.matches;});
it('a slow native task does not block a sibling task or the named conversation',async()=>{
 computerFixtureControl.isolatedTasks=true;
 const {bot}=await api<{bot:Bot}>('/v1/bots',{name:'Independent native work',allowTaskCreation:true});
 let release!:()=>void;inferenceFixtureControl.matches='isolated-task-held';inferenceFixtureControl.gate=new Promise<void>(resolve=>{release=resolve;});
 try{
  const {task:first}=await api<{task:Task}>('/v1/tasks',{operationId:crypto.randomUUID(),title:'Slow model task',description:'isolated-task-held request-exec',botId:bot.id});
  await expect.poll(async()=>(await api<{activeRuns:Run[]}>(`/v1/tasks/${first.id}/runs`)).activeRuns.some(r=>r.status==='running')).toBe(true);
  const {task:second}=await api<{task:Task}>('/v1/tasks',{operationId:crypto.randomUUID(),title:'Independent command',description:'request-exec sibling approval',botId:bot.id});
  await expect.poll(async()=>(await api<{activeRuns:Run[]}>(`/v1/tasks/${second.id}/runs`)).activeRuns.some(r=>r.status==='waiting_approval')).toBe(true);
  const main=await api<{run:Run}>(`/v1/bots/${bot.id}/messages`,{operationId:crypto.randomUUID(),text:'Give a small independent answer'});
  await expect.poll(async()=>(await api<{run:Run}>(`/v1/bots/${bot.id}/runs/${main.run.id}`)).run.status).toBe('completed');
  expect((await api<{run:Run}>(`/v1/bots/${bot.id}/runs/${main.run.id}`)).run.coordinatorMode).not.toBe(true);
  const {approvals}=await api<{approvals:Approval[]}>(`/v1/tasks/${second.id}/approvals`);
  await api(`/v1/tasks/${second.id}/approvals/${approvals[0].id}`,{decision:'approve'});
  await expect.poll(async()=>(await api<{activeRuns:Run[]}>(`/v1/tasks/${second.id}/runs`)).activeRuns.length).toBe(0);
  await runInDurableObject(bindings.COMPUTER.get(bindings.COMPUTER.idFromName(computerName(bot.id,second.id))),(_,state)=>expect(state.storage.sql.exec('SELECT 1 FROM effects').toArray()).toHaveLength(1));
  await runInDurableObject(bindings.COMPUTER.get(bindings.COMPUTER.idFromName(bot.id)),(_,state)=>expect(state.storage.sql.exec('SELECT 1 FROM effects').toArray()).toHaveLength(0));
  expect((await api<{activeRuns:Run[]}>(`/v1/tasks/${first.id}/runs`)).activeRuns.some(r=>r.status==='running')).toBe(true);
 }finally{release();}
});
it('native task continuations reuse their own computer and keep their siblings independent',async()=>{
 computerFixtureControl.isolatedTasks=true;
 const {bot}=await api<{bot:Bot}>('/v1/bots',{name:'Continuing task environments',allowTaskCreation:true,computerApprovalMode:'automatic'});
 const {task:first}=await api<{task:Task}>('/v1/tasks',{operationId:crypto.randomUUID(),title:'First effect',description:'request-exec first effect',botId:bot.id});
 await expect.poll(async()=>(await api<{runs:Run[]}>(`/v1/tasks/${first.id}/runs`)).runs[0]?.status).toBe('completed');
 expect(await runDurableObjectAlarm(registry())).toBe(true);
 const {task:second}=await api<{task:Task}>('/v1/tasks',{operationId:crypto.randomUUID(),title:'Second effect',description:'request-exec second effect',botId:bot.id});
 await expect.poll(async()=>(await api<{runs:Run[]}>(`/v1/tasks/${second.id}/runs`)).runs[0]?.status).toBe('completed');
 expect(await runDurableObjectAlarm(registry())).toBe(true);
 await api(`/v1/tasks/${first.id}/continue`,{operationId:crypto.randomUUID(),text:'request-exec continue first task'});
 await expect.poll(async()=>(await api<{activeRuns:Run[]}>(`/v1/tasks/${first.id}/runs`)).activeRuns.length).toBe(0);
 const counts=await Promise.all([first,second].map(task=>runInDurableObject(bindings.COMPUTER.get(bindings.COMPUTER.idFromName(computerName(bot.id,task.id))),(_,state)=>state.storage.sql.exec<{n:number}>('SELECT COUNT(*) n FROM effects').one().n)));
 expect(counts).toEqual([2,1]);
});
