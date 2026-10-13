import {env,exports} from 'cloudflare:workers';
import {runInDurableObject} from 'cloudflare:test';
import {expect,it} from 'vitest';
import type {Bot,Task,Run,ComputerResult} from '@botspace/contracts';
import type {RuntimeHostToolRequest} from '../packages/runtime/src/types';
import type {Env} from '../apps/api/src/env';
const bindings=env as unknown as Env;
const headers={authorization:'Bearer test-only-botspace-owner-token-000000','content-type':'application/json'};
async function api(path:string,input?:unknown){const response=await exports.default.fetch(`https://test${path}`,{headers,method:input===undefined?'GET':'POST',...(input===undefined?{}:{body:JSON.stringify(input)})});return {status:response.status,data:await response.json<any>()};}
async function setup(){
 const {data:{bot}}=await api('/v1/bots',{name:'Progress inspector'});
 const {data:{task}}=await api('/v1/tasks',{botId:bot.id,title:'Inspect without restart',description:'Work independently',operationId:crypto.randomUUID(),startImmediately:false});
 expect((await api(`/v1/tasks/${task.id}/progress`)).status).toBe(200);
 return {bot:bot as Bot,task:task as Task,stub:bindings.BOT.get(bindings.BOT.idFromName(`owner:task:${task.id}`))};
}
it('shows stale actual activity, native waits, failures and paged conversation without starting work',async()=>{
 const {bot,task,stub}=await setup(),at=new Date(Date.now()-8*3_600_000).toISOString(),runId=crypto.randomUUID();
 await runInDurableObject(stub,(_,state)=>{
  const run:Run={id:runId,botId:bot.id,operationId:'fixture-progress',model:bot.model,status:'running',createdAt:at,updatedAt:at};
  state.storage.sql.exec('INSERT INTO runs(id,operation_id,fingerprint,native_operation_id,data) VALUES(?,?,?,?,?)',runId,run.operationId,'fixture',run.operationId,JSON.stringify(run));
  for(let n=1;n<=3;n++)state.storage.sql.exec('INSERT INTO messages(id,source_key,data) VALUES(?,?,?)',`m${n}`,`m${n}`,JSON.stringify({id:`m${n}`,botId:bot.id,runId,role:'assistant',text:`Progress ${n}`,createdAt:at}));
  const insert=(type:string,data:unknown)=>state.storage.sql.exec('INSERT INTO events(source_key,data) VALUES(?,?)',crypto.randomUUID(),JSON.stringify({type,botId:bot.id,runId,createdAt:at,data}));
  insert('tool.started',{toolName:'exec',input:{command:'npm test'}});
  insert('tool.completed',{toolName:'exec',result:{status:'failed',exitCode:1,error:'Test failed',output:'Expected true'}});
  insert('tool.started',{toolName:'wait_subagent'});
  state.storage.sql.exec('CREATE TABLE pi_tasks(id INTEGER,status TEXT,record TEXT)');
  state.storage.sql.exec('CREATE TABLE pi_entries(id INTEGER,record TEXT)');
  state.storage.sql.exec('INSERT INTO pi_entries VALUES(?,?)',1,JSON.stringify({model:[{content:[{id:'wait',name:'wait_subagent',arguments:{private:'native-content-canary'}}]}]}));
  state.storage.sql.exec('INSERT INTO pi_tasks VALUES(?,?,?)',2,'running',JSON.stringify({kind:'pi.tool',input:{assistant:1,callId:'wait'},state:{checkpoint:{phase:'execute',arguments:{subagentId:'child'}}}}));
 });
 await runInDurableObject(stub,(_,state)=>state.storage.sql.exec('INSERT INTO events(source_key,data) VALUES(?,?)','new-user-input',JSON.stringify({type:'message.created',botId:bot.id,createdAt:new Date().toISOString(),data:{message:{role:'user',text:'Any update?'}}})));
 const first=await api(`/v1/tasks/${task.id}/progress?limit=2`);
 expect(first.status).toBe(200);expect(first.data).toMatchObject({lastActivityAt:at,observation:'no_recent_activity',execution:[{kind:'pi.tool',tool:'wait_subagent',subagentId:'child'}]});
 expect(first.data.idleForMs).toBeGreaterThanOrEqual(8*3_600_000);expect(first.data.messages.map((m:any)=>m.text)).toEqual(['Progress 2','Progress 3']);
 expect(first.data.activity).toContainEqual(expect.objectContaining({tool:'exec',status:'failed',exitCode:1,error:'Test failed',output:'Expected true'}));
 expect(JSON.stringify(first.data)).not.toContain('native-content-canary');
 const older=await api(`/v1/tasks/${task.id}/progress?limit=2&before=${first.data.nextCursor}`);expect(older.data.messages.map((m:any)=>m.text)).toEqual(['Progress 1']);expect(older.data.nextCursor).toBeNull();
 await runInDurableObject(stub,(_,state)=>{expect(state.storage.sql.exec('SELECT * FROM runs').toArray()).toHaveLength(1);expect(state.storage.sql.exec('SELECT * FROM submissions').toArray()).toHaveLength(0);expect(state.storage.sql.exec('SELECT * FROM computer_operations').toArray()).toHaveLength(0);});
 expect((await api(`/v1/tasks/${task.id}/progress?limit=21`)).status).toBe(400);
 expect((await api(`/v1/tasks/${task.id}/progress?before=oops`)).status).toBe(400);
 const unauthenticated=await exports.default.fetch(`https://test/v1/tasks/${task.id}/progress`);expect(unauthenticated.status).toBe(401);await unauthenticated.text();
});
it('allows a computerless coordinator to inspect its own tasks and rejects another bot’s task',async()=>{
 const {bot,task}=await setup(),other=await setup();
 await api(`/v1/bots/${bot.id}/messages`); // Initialize only the transcript/config.
 const root=bindings.BOT.get(bindings.BOT.idFromName(`owner:${bot.id}`)),op=crypto.randomUUID(),runId=crypto.randomUUID();
 await runInDurableObject(root,(_,state)=>{const at=new Date().toISOString();state.storage.sql.exec('INSERT INTO runs(id,operation_id,fingerprint,native_operation_id,data) VALUES(?,?,?,?,?)',runId,op,'fixture',op,JSON.stringify({id:runId,botId:bot.id,operationId:op,model:bot.model,status:'running',createdAt:at,updatedAt:at,coordinatorMode:true}));state.storage.sql.exec('INSERT INTO submissions(operation_id,run_id,text,admitted) VALUES(?,?,?,1)',op,runId,'Inspect progress');});
 const call=(name:string,args:Record<string,unknown>)=>runInDurableObject(root,async instance=>(instance as unknown as {executeHostTool(input:RuntimeHostToolRequest):Promise<ComputerResult>}).executeHostTool({name,arguments:args,operationId:crypto.randomUUID(),runOperationId:op,signal:new AbortController().signal}));
 const list=await call('list_tasks',{});expect(list.status).toBe('completed');expect(JSON.parse(list.output!).tasks.map((t:any)=>t.id)).toEqual([task.id]);
 const inspected=await call('inspect_task',{taskId:task.id});expect(inspected.status).toBe('completed');expect(JSON.parse(inspected.output!)).toMatchObject({task:{id:task.id},progress:{observation:'idle'}});
 await expect(call('inspect_task',{taskId:other.task.id})).rejects.toThrow('Task not found for this bot');
 const registry=bindings.WORKSPACE.get(bindings.WORKSPACE.idFromName('owner'));
 const unmarked=await registry.fetch(`https://workspace/tasks/inspect/${bot.id}`);expect(unmarked.status).toBe(403);await unmarked.text();
 await runInDurableObject(root,(_,state)=>{expect(state.storage.sql.exec('SELECT * FROM computer_operations').toArray()).toHaveLength(0);expect(state.storage.sql.exec('SELECT * FROM execution_claims').toArray()).toHaveLength(0);});
});
it('coordinates queued messages and completed-task continuations without duplicate inputs or cross-bot access',async()=>{
 const {bot,task,stub}=await setup(),other=await setup(),registry=bindings.WORKSPACE.get(bindings.WORKSPACE.idFromName('owner'));
 await api(`/v1/bots/${bot.id}/messages`);
 const root=bindings.BOT.get(bindings.BOT.idFromName(`owner:${bot.id}`)),sourceOp=crypto.randomUUID();
 const source=await api(`/v1/bots/${bot.id}/messages`,{operationId:sourceOp,text:'fixture:approval'}),runId=source.data.run.id;
 for(let i=0;i<100;i++){const current=await api(`/v1/bots/${bot.id}/runs/${runId}`);if(current.data.run.status==='waiting_approval')break;await new Promise(resolve=>setTimeout(resolve,5));}
 expect((await api(`/v1/bots/${bot.id}/runs/${runId}`)).data.run.status).toBe('waiting_approval');
 await runInDurableObject(root,(_,state)=>{const row=state.storage.sql.exec<{data:string}>('SELECT data FROM runs WHERE id=?',runId).one();state.storage.sql.exec('UPDATE runs SET data=? WHERE id=?',JSON.stringify({...JSON.parse(row.data),coordinatorMode:true}),runId);});
 const call=(taskId:string,text:string,op:string)=>runInDurableObject(root,async instance=>(instance as unknown as {executeHostTool(input:RuntimeHostToolRequest):Promise<ComputerResult>}).executeHostTool({name:'message_task',arguments:{taskId,text},operationId:op,runOperationId:sourceOp,signal:new AbortController().signal}));
 const status=async(value:string)=>runInDurableObject(registry,(_,state)=>{const row=state.storage.sql.exec<{data:string}>('SELECT data FROM tasks WHERE id=?',task.id).one();state.storage.sql.exec('UPDATE tasks SET data=? WHERE id=?',JSON.stringify({...JSON.parse(row.data),status:value}),task.id);});
 await runInDurableObject(stub,(_,state)=>state.storage.sql.exec('INSERT INTO messages(id,source_key,data) VALUES(?,?,?)','large-progress','large-progress',JSON.stringify({id:'large-progress',botId:bot.id,role:'assistant',text:'Observed progress '.repeat(300),createdAt:new Date().toISOString()})));
 await status('queued');const op=crypto.randomUUID(),message='Apply this correction when you can';
 const result=await call(task.id,message,op);expect(result.status).toBe('completed');const receipt=JSON.parse(result.output!);expect(receipt.run.status).toBe('queued');expect(receipt.progress).toMatchObject({observedAt:expect.any(String),messages:expect.any(Array)});expect(receipt.progress.messages.find((m:any)=>m.id==='large-progress')).toMatchObject({truncated:true,text:expect.any(String)});expect(receipt.progress.messages.find((m:any)=>m.id==='large-progress').text).toHaveLength(1200);
 await runInDurableObject(stub,(_,state)=>{
  state.storage.sql.exec('CREATE TABLE pi_tasks(id INTEGER,status TEXT,record TEXT)');state.storage.sql.exec('CREATE TABLE pi_entries(id INTEGER,record TEXT)');
  state.storage.sql.exec('INSERT INTO pi_tasks VALUES(1,?,?)','running','malformed native diagnostic fixture');
 });
 const acceptedWithUnavailableSnapshot=await call(task.id,message,op);
 expect(JSON.parse(acceptedWithUnavailableSnapshot.output!)).toMatchObject({run:{id:receipt.run.id},progress:{observation:'unavailable'}});
 await runInDurableObject(stub,(_,state)=>{expect(state.storage.sql.exec('SELECT 1 FROM submissions WHERE operation_id=?',op).toArray()).toHaveLength(1);state.storage.sql.exec('DROP TABLE pi_tasks');state.storage.sql.exec('DROP TABLE pi_entries');});
 await status('completed');const repeat=await call(task.id,message,op);expect(repeat).toMatchObject({status:'completed'});expect(JSON.parse(repeat.output!).run.id).toBe(receipt.run.id);
 await expect(call(task.id,'Changed instructions',op)).rejects.toThrow('different instructions');
 await expect(call(other.task.id,message,crypto.randomUUID())).rejects.toThrow('Task not found for this bot');
 const next=crypto.randomUUID(),continued=await call(task.id,'Continue the remaining work',next);expect(JSON.parse(continued.output!).task.id).toBe(task.id);
 const repeated=await call(task.id,'Continue the remaining work',next);expect(JSON.parse(repeated.output!).task.startOperationId).toBe(JSON.parse(continued.output!).task.startOperationId);
 await runInDurableObject(stub,(_,state)=>expect(state.storage.sql.exec('SELECT 1 FROM submissions WHERE operation_id=?',op).toArray()).toHaveLength(1));
 await status('cancelled');await expect(call(task.id,message,crypto.randomUUID())).rejects.toThrow('Cancelled tasks');
 const unmarked=await registry.fetch('https://workspace/tasks/message',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});expect(unmarked.status).toBe(403);await unmarked.text();
});
