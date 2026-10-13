import {env,exports} from 'cloudflare:workers';
import {evictDurableObject,runDurableObjectAlarm,runInDurableObject} from 'cloudflare:test';
import {expect,it} from 'vitest';
import type {Bot,Run,Task,TaskUpdate,Message,BotEvent} from '@botspace/contracts';
import type {Env} from '../apps/api/src/env';
const bindings=env as unknown as Env,token='test-only-botspace-owner-token-000000';
async function api(path:string,input?:unknown,method=input===undefined?'GET':'POST') {
 const response=await exports.default.fetch(`https://timber.test${path}`,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},...(input===undefined?{}:{body:JSON.stringify(input)})});
 const payload=await response.arrayBuffer();return new Response(payload,{status:response.status,headers:response.headers});
}
const registry=()=>bindings.WORKSPACE.get(bindings.WORKSPACE.idFromName('owner'));
const botDO=(id:string)=>bindings.BOT.get(bindings.BOT.idFromName(`owner:${id}`));
async function creator() {
 const owner=(await(await api('/v1/bots',{name:'Task report bot',allowTaskCreation:true})).json<{bot:Bot}>()).bot;
 const run=(await(await api(`/v1/bots/${owner.id}/messages`,{operationId:crypto.randomUUID(),text:'fixture:approval'})).json<{run:Run}>()).run;
 return {owner,run};
}
async function create(owner:Bot,run:Run,extra:Record<string,unknown>={}) {
 const input={operationId:crypto.randomUUID(),title:'Independent task',description:'fixture:approval',sourceBotId:owner.id,sourceRunId:run.id,startImmediately:false,...extra};
 const response=await registry().fetch('https://workspace/tasks/bot',{method:'POST',headers:{'content-type':'application/json','x-timber-internal':'task'},body:JSON.stringify(input)});
 const payload=await response.arrayBuffer();expect(response.status).toBe(201);return {task:(JSON.parse(new TextDecoder().decode(payload)) as {task:Task}).task,input};
}
async function flush() {await runInDurableObject(registry(),instance=>(instance as unknown as {deliverTaskUpdates():Promise<void>}).deliverTaskUpdates());}
async function events(id:string) {return runInDurableObject(botDO(id),(_instance,state)=>state.storage.sql.exec<{data:string}>("SELECT data FROM events WHERE json_extract(data,'$.type')='task.updated' ORDER BY id").toArray().map(row=>JSON.parse(row.data) as BotEvent));}
async function notify(owner:Bot,update:TaskUpdate) {const response=await botDO(owner.id).fetch('https://bot/task-updates',{method:'POST',headers:{'content-type':'application/json','x-timber-internal':'task','x-botspace-config':encodeURIComponent(JSON.stringify(owner))},body:JSON.stringify(update)});await response.arrayBuffer();return response.status;}
it('durably reports task transitions once after registry eviction, without duplicating creation or ordinary activity',async()=>{
 const {owner,run}=await creator(),{task,input}=await create(owner,run);expect(task.statusVersion).toBe(1);
 await evictDurableObject(registry());expect(await runDurableObjectAlarm(registry())).toBe(true);
 expect(await events(owner.id)).toHaveLength(1);expect((await events(owner.id))[0]).toMatchObject({runId:run.id,data:{task:{id:task.id,status:'pending',statusVersion:1}}});
 const replay=await registry().fetch('https://workspace/tasks/bot',{method:'POST',headers:{'content-type':'application/json','x-timber-internal':'task'},body:JSON.stringify(input)});await replay.arrayBuffer();expect(replay.status).toBe(200);
 await flush();expect(await events(owner.id)).toHaveLength(1);
 const same=await registry().fetch(`https://workspace/tasks/${task.id}`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({status:'pending'})});await same.arrayBuffer();await flush();expect(await events(owner.id)).toHaveLength(1);
 const cancelled=await api(`/v1/tasks/${task.id}/cancel`,{});expect(cancelled.status).toBe(200);await flush();
 expect((await events(owner.id)).map(event=>(event.data.task as Task).status)).toEqual(['pending','cancelled']);
 expect((await(await api(`/v1/bots/${owner.id}/messages`)).json<{messages:Message[]}>()).messages.some(message=>message.text==='fixture:approval'&&message.runId!==run.id)).toBe(false);
},60000);
it('terminal task reports are transcript-only, deduplicated and visible in bounded future agent context',async()=>{
 const {owner,run}=await creator(),{task}=await create(owner,run);await flush();
 const update:TaskUpdate={task:{...task,status:'completed',statusVersion:2},notificationId:`task-update:${task.id}:2`,result:'Finished the task and verified the change.'};
 expect(await notify(owner,update)).toBe(200);expect(await notify(owner,update)).toBe(200);
 const messages=(await(await api(`/v1/bots/${owner.id}/messages`)).json<{messages:Message[]}>()).messages;
 expect(messages.filter(message=>message.text===update.result)).toHaveLength(1);
 const committed=(await events(owner.id)).find(event=>event.data.notificationId===update.notificationId);expect(committed?.data).toMatchObject({result:update.result,messageId:messages.find(message=>message.text===update.result)?.id});
 expect(messages.some(message=>message.id===committed?.data.messageId)).toBe(true);
 const runs=(await(await api(`/v1/bots/${owner.id}/runs`)).json<{runs:Run[]}>()).runs;expect(runs).toHaveLength(1);
 const context=await runInDurableObject(botDO(owner.id),instance=>(instance as unknown as {taskContext():string}).taskContext());expect(context).toContain(update.result);expect(context).toContain(task.id);
 expect(await notify(owner,{...update,task:{...task,statusVersion:1},notificationId:`task-update:${task.id}:1`})).toBe(200);
 const latest=await runInDurableObject(botDO(owner.id),instance=>(instance as unknown as {taskContext():string}).taskContext());expect(latest).toContain('completed');
},60000);
it('task update recipient rejects another bot and suppresses terminal reports after source Stop',async()=>{
 const {owner,run}=await creator(),other=await creator(),{task}=await create(owner,run);await flush();
 const update:TaskUpdate={task:{...task,status:'completed',statusVersion:2},notificationId:`task-update:${task.id}:2`,result:'Late report should not reopen the stopped chat.'};
 expect(await notify(other.owner,update)).toBe(403);
 expect((await api(`/v1/bots/${owner.id}/runs/${run.id}/cancel`,{})).status).toBe(200);
 expect(await notify(owner,update)).toBe(200);
 const messages=(await(await api(`/v1/bots/${owner.id}/messages`)).json<{messages:Message[]}>()).messages;expect(messages.some(message=>message.text===update.result)).toBe(false);
 const runs=(await(await api(`/v1/bots/${owner.id}/runs`)).json<{runs:Run[]}>()).runs;expect(runs).toHaveLength(1);expect(runs[0]?.status).toBe('cancelled');
},60000);
it('a lost acknowledgment retries the durable task update without repeating its result or event',async()=>{
 const {owner,run}=await creator(),{task}=await create(owner,run);
 type Receiver={receiveTaskUpdate(input:TaskUpdate):void;fixtureReceive?:Receiver['receiveTaskUpdate']};
 await runInDurableObject(botDO(owner.id),instance=>{const target=instance as unknown as Receiver;target.fixtureReceive=target.receiveTaskUpdate;target.receiveTaskUpdate=function(input){this.fixtureReceive!(input);throw new Error('Fixture lost response after committed task update');};});
 await flush();expect(await events(owner.id)).toHaveLength(1);
 expect(await runInDurableObject(registry(),(_instance,state)=>state.storage.sql.exec('SELECT id FROM task_updates WHERE task_id=?',task.id).toArray().length)).toBe(1);
 await runInDurableObject(botDO(owner.id),instance=>{const target=instance as unknown as Receiver;target.receiveTaskUpdate=target.fixtureReceive!;delete target.fixtureReceive;});
 await evictDurableObject(registry());expect(await runDurableObjectAlarm(registry())).toBe(true);
 expect(await events(owner.id)).toHaveLength(1);expect(await runInDurableObject(registry(),(_instance,state)=>state.storage.sql.exec('SELECT id FROM task_updates WHERE task_id=?',task.id).toArray().length)).toBe(0);
},60000);
it('scheduler completion delivers the exact child final answer while keeping its commands out of bot chat',async()=>{
 const {owner,run}=await creator(),{task}=await create(owner,run);
 await expect.poll(async()=>{const response=await api(`/v1/bots/${owner.id}/approvals`);return(await response.json<{approvals:Array<{id:string}>}>()).approvals.length;}).toBe(1);
 const approvals=(await(await api(`/v1/bots/${owner.id}/approvals`)).json<{approvals:Array<{id:string}>}>()).approvals;
 expect((await api(`/v1/bots/${owner.id}/approvals/${approvals[0]!.id}`,{decision:'approve'})).status).toBe(200);
 await expect.poll(async()=> (await(await api(`/v1/bots/${owner.id}/runs/${run.id}`)).json<{run:Run}>()).run.status).toBe('completed');
 await runInDurableObject(registry(),(_instance,state)=>state.storage.sql.exec('UPDATE task_slots SET updated_at=? WHERE bot_id=?',Date.now()-6000,owner.id));
 expect((await api(`/v1/tasks/${task.id}/start`,{})).status).toBe(202);
 await expect.poll(async()=> (await(await api(`/v1/tasks/${task.id}/approvals`)).json<{approvals:unknown[]}>()).approvals.length).toBe(1);
 const childApproval=(await(await api(`/v1/tasks/${task.id}/approvals`)).json<{approvals:Array<{id:string}>}>()).approvals[0]!;
 expect((await api(`/v1/tasks/${task.id}/approvals/${childApproval.id}`,{decision:'approve'})).status).toBe(200);
 await expect.poll(async()=> (await(await api(`/v1/tasks/${task.id}/runs`)).json<{activeRuns:Run[]}>()).activeRuns.length).toBe(0);
 expect(await runDurableObjectAlarm(registry())).toBe(true);
 const child=(await(await api(`/v1/tasks/${task.id}/messages`)).json<{messages:Message[]}>()).messages;
 const expected=[...child].reverse().find(message=>message.role==='assistant'&&message.kind==='final')!.text;
 const main=(await(await api(`/v1/bots/${owner.id}/messages`)).json<{messages:Message[]}>()).messages;
 expect(main.some(message=>message.text===expected&&message.runId===run.id)).toBe(true);
 expect((await events(owner.id)).at(-1)?.data.task).toMatchObject({status:'completed'});
 const childRunIds=(await(await api(`/v1/tasks/${task.id}/runs`)).json<{runs:Run[]}>()).runs.map(item=>item.id);
 expect(main.some(message=>message.runId&&childRunIds.includes(message.runId))).toBe(false);
},60000);
it('bot-created task reports stay in the exact originating task conversation',async()=>{
 const owner=(await(await api('/v1/bots',{name:'Task origin isolation',allowTaskCreation:true})).json<{bot:Bot}>()).bot;
 const parent=(await(await api('/v1/tasks',{operationId:crypto.randomUUID(),title:'Origin task',description:'fixture:approval',botId:owner.id})).json<{task:Task}>()).task;
 await expect.poll(async()=> (await(await api(`/v1/tasks/${parent.id}/runs`)).json<{activeRuns:Run[]}>()).activeRuns.some(run=>run.status==='waiting_approval')).toBe(true);
 const source=(await(await api(`/v1/tasks/${parent.id}/runs`)).json<{activeRuns:Run[]}>()).activeRuns[0]!;
 const {task}=await create(owner,source,{sourceTaskId:parent.id});expect(task.sourceTaskId).toBe(parent.id);
 await evictDurableObject(registry());expect(await runDurableObjectAlarm(registry())).toBe(true);
 const target=bindings.BOT.get(bindings.BOT.idFromName(`owner:task:${parent.id}`));
 const updates=await runInDurableObject(target,(_instance,state)=>state.storage.sql.exec<{data:string}>("SELECT data FROM events WHERE json_extract(data,'$.type')='task.updated'").toArray().map(row=>JSON.parse(row.data) as BotEvent));
 expect(updates).toHaveLength(1);expect(updates[0]).toMatchObject({runId:source.id,data:{task:{id:task.id,sourceTaskId:parent.id}}});expect(await events(owner.id)).toHaveLength(0);
 expect((await(await api(`/v1/bots/${owner.id}/messages`)).json<{messages:Message[]}>()).messages).toHaveLength(0);
},60000);
it('a long-running older task returns to recent context on completion, while stale reports cannot promote old tasks',async()=>{
 const {owner,run}=await creator(),tasks:Task[]=[];
 for(let index=0;index<9;index++)tasks.push((await create(owner,run,{title:`Task context ${index}`})).task);
 await flush();
 const context=()=>runInDurableObject(botDO(owner.id),instance=>(instance as unknown as {taskContext():string}).taskContext());
 expect(await context()).not.toContain(tasks[0]!.id);
 const completed:TaskUpdate={task:{...tasks[0]!,status:'completed',statusVersion:2},notificationId:`task-update:${tasks[0]!.id}:2`,result:'The oldest long-running task just completed with the verified result.'};
 expect(await notify(owner,completed)).toBe(200);
 expect(await context()).toContain(completed.result);expect(await context()).toContain(tasks[0]!.id);
 const before=await runInDurableObject(botDO(owner.id),(_instance,state)=>state.storage.sql.exec<{task_id:string;updated_sequence:number}>('SELECT task_id,updated_sequence FROM task_reports ORDER BY updated_sequence DESC').toArray());
 const stale:TaskUpdate={task:tasks[1]!,notificationId:`task-update:${tasks[1]!.id}:1`};expect(await notify(owner,stale)).toBe(200);expect(await notify(owner,completed)).toBe(200);
 const after=await runInDurableObject(botDO(owner.id),(_instance,state)=>state.storage.sql.exec<{task_id:string;updated_sequence:number}>('SELECT task_id,updated_sequence FROM task_reports ORDER BY updated_sequence DESC').toArray());
 expect(after).toEqual(before);expect(await context()).not.toContain(tasks[1]!.id);
 const plans=await runInDurableObject(botDO(owner.id),(_instance,state)=>({
  context:state.storage.sql.exec<{detail:string}>('EXPLAIN QUERY PLAN SELECT data FROM task_reports ORDER BY updated_sequence DESC LIMIT 8').toArray().map(row=>row.detail),
  sequence:state.storage.sql.exec<{detail:string}>('EXPLAIN QUERY PLAN SELECT MAX(updated_sequence) FROM task_reports').toArray().map(row=>row.detail),
 }));expect(plans.context.join(' ')).toContain('task_reports_recency_idx');expect(plans.context.join(' ')).not.toContain('TEMP B-TREE');expect(plans.sequence.join(' ')).toContain('task_reports_recency_idx');
},60000);
it('existing task reports migrate to indexed recency without losing versions or results',async()=>{
 const {owner,run}=await creator(),{task}=await create(owner,run);await flush();
 const completed:TaskUpdate={task:{...task,status:'completed',statusVersion:2},notificationId:`task-update:${task.id}:2`,result:'Preserve this task result through migration.'};expect(await notify(owner,completed)).toBe(200);
 await runInDurableObject(botDO(owner.id),(_instance,state)=>{
  state.storage.sql.exec('DROP INDEX task_reports_recency_idx');state.storage.sql.exec('ALTER TABLE task_reports DROP COLUMN updated_sequence');
 });
 await evictDurableObject(botDO(owner.id));
 const recovered=await runInDurableObject(botDO(owner.id),(instance,state)=>({
  context:(instance as unknown as {taskContext():string}).taskContext(),
  report:state.storage.sql.exec<{version:number;updated_sequence:number}>('SELECT version,updated_sequence FROM task_reports WHERE task_id=?',task.id).one(),
 }));expect(recovered.context).toContain(completed.result);expect(recovered.report).toEqual({version:2,updated_sequence:1});
 const {task:next}=await create(owner,run);await flush();
 const reports=await runInDurableObject(botDO(owner.id),(_instance,state)=>state.storage.sql.exec<{task_id:string;updated_sequence:number}>('SELECT task_id,updated_sequence FROM task_reports ORDER BY updated_sequence DESC').toArray());
 expect(reports).toEqual([{task_id:next.id,updated_sequence:2},{task_id:task.id,updated_sequence:1}]);
},60000);
