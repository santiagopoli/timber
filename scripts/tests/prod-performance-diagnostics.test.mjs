import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {PERFORMANCE_SCHEMA,PERFORMANCE_TASKS,PERFORMANCE_RUNS,PERFORMANCE_TOOLS,PERFORMANCE_NATIVE,PERFORMANCE_PROCESSES,PERFORMANCE_DELIVERIES,PERFORMANCE_WAKES,PERFORMANCE_RECOVERY,PERFORMANCE_USAGE,summarizePerformance,performanceTaskMetadata} from '../prod-performance-diagnostics.mjs';
import {collectDurable} from '../prod-durable-diagnostics.mjs';

const now=Date.parse('2026-10-12T10:00:00Z'),window={from:now-86_400_000,to:now};
const created='2026-10-12T09:00:00.000Z',updated='2026-10-12T09:30:00.000Z';
test('performance queries measure real SQLite receipts without projecting conversation or tool content',()=>{
 const db=new DatabaseSync(':memory:');
 try{
  db.exec('CREATE TABLE cf_agents_jobs(capability TEXT,fn TEXT,time INTEGER,running INTEGER,execution_started_at INTEGER,recovery_loop INTEGER);CREATE TABLE pi_documents(kind TEXT);CREATE TABLE bots(id TEXT,data TEXT);CREATE TABLE tasks(id TEXT,data TEXT);CREATE TABLE runs(id TEXT,data TEXT);CREATE TABLE admission_sources(run_id TEXT,kind TEXT);CREATE TABLE submissions(operation_id TEXT,run_id TEXT);CREATE TABLE botspace_runtime_budget(operation_id TEXT,kind TEXT,item_id TEXT);CREATE TABLE events(id INTEGER,source_key TEXT,data TEXT);CREATE TABLE pi_tasks(id INTEGER,status TEXT,record TEXT,conversation_id INTEGER);CREATE TABLE pi_submissions(request_id TEXT,status TEXT,conversation_id INTEGER);CREATE TABLE run_processes(status TEXT,dispatch_state TEXT,cancel_requested INTEGER,result TEXT);CREATE TABLE pi_entries(id INTEGER,record TEXT)');
  for(const sql of [PERFORMANCE_SCHEMA,PERFORMANCE_TASKS,PERFORMANCE_RUNS,PERFORMANCE_TOOLS,PERFORMANCE_NATIVE,PERFORMANCE_PROCESSES,PERFORMANCE_DELIVERIES,PERFORMANCE_WAKES,PERFORMANCE_RECOVERY,PERFORMANCE_USAGE]){assert.match(sql,/^(SELECT|WITH) /);assert.doesNotMatch(sql,/\b(INSERT|UPDATE|DELETE|DROP|ALTER|REPLACE|ATTACH|PRAGMA)\b/i);assert.doesNotMatch(sql,/;/);}
  db.prepare('INSERT INTO pi_documents VALUES(?)').run(JSON.stringify('timber.subagent-waits'));
  db.prepare('INSERT INTO bots VALUES(?,?)').run('bot-canary',JSON.stringify({name:'Polibot'}));
  db.prepare('INSERT INTO tasks VALUES(?,?)').run('task-canary',JSON.stringify({botId:'bot-canary',title:'private-canary',status:'running',createdAt:created,updatedAt:updated}));
  db.prepare('INSERT INTO runs VALUES(?,?)').run('run-canary',JSON.stringify({status:'running',createdAt:created,updatedAt:updated,error:'private-canary'}));
  db.prepare('INSERT INTO submissions VALUES(?,?)').run('operation-canary','run-canary');
  for(const kind of ['tool','generation'])db.prepare('INSERT INTO botspace_runtime_budget VALUES(?,?,?)').run('operation-canary',kind,'item-canary');
  const event=(id,key,type,at,data)=>db.prepare('INSERT INTO events VALUES(?,?,?)').run(id,key,JSON.stringify({type,createdAt:at,runId:'run-canary',data}));
  event(1,'start:canary','tool.started',created,{operationId:'tool-canary',actionType:'exec',input:{command:'private-canary'}});
  event(2,'tool:tool-canary','tool.completed',updated,{result:{status:'completed',exitCode:0,output:'private-canary',checkpointStatus:'saved'}});
  event(3,'retry:canary','run.retrying',updated,{error:'private-canary'});
  db.prepare('INSERT INTO pi_tasks(id,status,record) VALUES(?,?,?)').run(1,'running',JSON.stringify({kind:'pi.generation',state:{checkpoint:{phase:'request',attempt:2,messages:'private-canary'}}}));
  db.prepare('INSERT INTO pi_entries VALUES(?,?)').run(1,JSON.stringify({kind:'pi.assistant',model:[{timestamp:now-1000,content:'private-canary',stopReason:'toolUse',usage:{input:120000,output:200,cacheRead:100000}}]}));
  const report=summarizePerformance({runs:db.prepare(PERFORMANCE_RUNS).all(),tools:db.prepare(PERFORMANCE_TOOLS).all(),native:db.prepare(PERFORMANCE_NATIVE).all(),wakes:db.prepare(PERFORMANCE_WAKES).all(),recovery:db.prepare(PERFORMANCE_RECOVERY).all(),processes:db.prepare(PERFORMANCE_PROCESSES).all(),deliveries:db.prepare(PERFORMANCE_DELIVERIES).all(),usage:db.prepare(PERFORMANCE_USAGE).all()},window);
  assert.equal(report.recovery[0].waitGraphs,1);
  assert.equal(db.prepare(PERFORMANCE_SCHEMA).all().length,6);assert.equal(report.runs[0].retries,1);assert.equal(report.runs[0].generations,1);assert.equal(report.tools[0].durationMs,1_800_000);assert.equal(report.tools[0].tool,'exec');assert.equal(report.modelResponses[0].inputTokens,120000);assert.equal(report.nativeTasks[0].attempt,2);
  assert.doesNotMatch(JSON.stringify(report),/canary/);assert.doesNotMatch(JSON.stringify(performanceTaskMetadata(db.prepare(PERFORMANCE_TASKS).get())),/canary/);
 }finally{db.close();}
});
test('performance summary drops arbitrary labels, private fields and invalid timestamps',()=>{
 const row={created_at:created,updated_at:updated,started_at:created,finished_at:updated,timestamp:now,status:'private-canary',tool:'private-canary',kind:'private-canary',phase:'private-canary',stop_reason:'private-canary',secret:'private-canary',generations:'private-canary',output_tokens:'private-canary'};
 const result=summarizePerformance({runs:[row],tools:[row],native:[row],usage:[row]},window);
 assert.doesNotMatch(JSON.stringify(result),/canary/);assert.equal(result.tools[0].tool,'unknown');
 assert.equal(summarizePerformance({runs:[{...row,created_at:'invalid',updated_at:'invalid'}]},window).runs.length,0);
});
test('performance inspection visits only selected registered task conversations and keeps routing IDs private',async()=>{
 const ws='a'.repeat(32),bot='b'.repeat(32),id='10000000-0000-4000-8000-000000000001',task='20000000-0000-4000-8000-000000000002',calls=[];
 const result=await collectDurable({now,env:{CLOUDFLARE_ACCOUNT_ID:ws,CLOUDFLARE_API_TOKEN:'secret-canary',DIAGNOSTIC_SCOPE:'performance'},fetcher:async(url,init)=>{
  if(init.method==='GET')return Response.json({success:true,result:[{id:ws,class:'WorkspaceDO',script:'timber-api',use_sqlite:true},{id:bot,class:'BotDO',script:'timber-api',use_sqlite:true}]});
  const input=JSON.parse(init.body),sql=input.queries[0].sql;calls.push(input);
  const records=sql.includes("SELECT id FROM bots")?[{id}]:sql===PERFORMANCE_SCHEMA?input.durable_object_name.includes(':task:')?[]:['runs','submissions','events','botspace_runtime_budget','pi_tasks','pi_entries'].map(name=>({name})):sql===PERFORMANCE_TASKS?[{id:task,status:'pending',created_at:created,updated_at:updated}]:[];
  const columns=records.length?Object.keys(records[0]):[];
  return Response.json({success:true,result:{results:[{columns,rows:records.map(row=>columns.map(name=>row[name])),meta:{rows_written:0}}]}});
 }});
 assert.equal(result.tasks[0].execution.initialized,false);assert.ok(calls.some(call=>call.durable_object_name===`owner:task:${task}`));assert.doesNotMatch(JSON.stringify(result),new RegExp(`canary|${id}|${task}`));
});
