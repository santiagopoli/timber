import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {PERFORMANCE_SCHEMA,PERFORMANCE_TASKS,PERFORMANCE_RUNS,PERFORMANCE_TOOLS,PERFORMANCE_NATIVE,PERFORMANCE_PROCESSES,PERFORMANCE_DELIVERIES,PERFORMANCE_WAKES,PERFORMANCE_RECOVERY,PERFORMANCE_USAGE,summarizePerformance,performanceTaskMetadata} from '../prod-performance-diagnostics.mjs';
import {collectDurable,PRIVATE_PROGRESS_MESSAGES,PRIVATE_PROGRESS_FAILURES,PRIVATE_PROGRESS_GOAL} from '../prod-durable-diagnostics.mjs';
import {PERFORMANCE_ACTIVITY,summarizeActivity} from '../prod-performance-diagnostics.mjs';

const now=Date.parse('2026-10-12T10:00:00Z'),window={from:now-86_400_000,to:now};
const created='2026-10-12T09:00:00.000Z',updated='2026-10-12T09:30:00.000Z';
test('performance queries measure real SQLite receipts without projecting conversation or tool content',()=>{
 const db=new DatabaseSync(':memory:');
 try{
  db.exec('CREATE TABLE cf_agents_jobs(capability TEXT,fn TEXT,time INTEGER,running INTEGER,execution_started_at INTEGER,recovery_loop INTEGER);CREATE TABLE pi_documents(id INTEGER,kind TEXT,scope_kind TEXT,owner_id INTEGER,retired_at INTEGER);CREATE TABLE pi_document_revisions(document_id INTEGER,seq INTEGER,kind TEXT,content TEXT);CREATE TABLE bots(id TEXT,data TEXT);CREATE TABLE tasks(id TEXT,data TEXT); CREATE TABLE task_slots(bot_id TEXT,task_id TEXT,updated_at INTEGER); CREATE TABLE computer_admissions(bot_id TEXT,payload TEXT);CREATE TABLE runs(id TEXT,data TEXT);CREATE TABLE admission_sources(run_id TEXT,kind TEXT);CREATE TABLE submissions(operation_id TEXT,run_id TEXT);CREATE TABLE botspace_runtime_budget(operation_id TEXT,kind TEXT,item_id TEXT);CREATE TABLE events(id INTEGER,source_key TEXT,data TEXT);CREATE TABLE pi_tasks(id INTEGER,status TEXT,record TEXT,conversation_id INTEGER);CREATE TABLE pi_submissions(request_id TEXT,status TEXT,conversation_id INTEGER,id INTEGER);CREATE TABLE run_processes(status TEXT,dispatch_state TEXT,cancel_requested INTEGER,result TEXT);CREATE TABLE pi_entries(id INTEGER,record TEXT)');
  for(const sql of [PERFORMANCE_SCHEMA,PERFORMANCE_TASKS,PERFORMANCE_RUNS,PERFORMANCE_TOOLS,PERFORMANCE_NATIVE,PERFORMANCE_PROCESSES,PERFORMANCE_DELIVERIES,PERFORMANCE_WAKES,PERFORMANCE_RECOVERY,PERFORMANCE_USAGE]){assert.match(sql,/^(SELECT|WITH) /);assert.doesNotMatch(sql,/\b(INSERT|UPDATE|DELETE|DROP|ALTER|REPLACE|ATTACH|PRAGMA)\b/i);assert.doesNotMatch(sql,/;/);}
  db.prepare('INSERT INTO pi_documents(kind) VALUES(?)').run(JSON.stringify('timber.subagent-waits'));
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
  assert.equal(db.prepare(PERFORMANCE_SCHEMA).all().length,12);assert.equal(report.runs[0].retries,1);assert.equal(report.runs[0].generations,1);assert.equal(report.tools[0].durationMs,1_800_000);assert.equal(report.tools[0].tool,'exec');assert.equal(report.modelResponses[0].inputTokens,120000);assert.equal(report.nativeTasks[0].attempt,2);
  assert.doesNotMatch(JSON.stringify(report),/canary/);assert.doesNotMatch(JSON.stringify(performanceTaskMetadata(db.prepare(PERFORMANCE_TASKS).get())),/canary/);
  event(4,'key:start','tool.started',updated,{operationId:'key-canary',actionType:'key',input:{key:'Ctrl+C'}});
  event(5,'tool:key-canary','tool.completed',updated,{result:{status:'completed',output:'private-canary'}});
  event(6,'write:start','tool.started',updated,{operationId:'write-canary',actionType:'writeFile',input:{path:'/workspace/private-canary.sh',content:'private-canary'}});
  event(7,'tool:write-canary','tool.completed',updated,{result:{status:'interrupted',error:'Execution session is unavailable; private-canary'}});
  const actions=summarizePerformance({tools:db.prepare(PERFORMANCE_TOOLS).all()},window).tools;
  assert.equal(actions[0].fileKind,'shell');assert.equal(actions[0].writtenCharacters,14);assert.equal(actions[0].failureKind,'session_unavailable');assert.equal(actions[1].keyKind,'ctrl+c');
  const totals=summarizeActivity(db.prepare(PERFORMANCE_ACTIVITY).all(),window);
  assert.equal(totals.find(row=>row.tool==='writeFile').interrupted,1);assert.equal(totals.find(row=>row.tool==='key').actions,1);assert.equal(totals.find(row=>row.tool==='exec').durationMs,1_800_000);
  assert.doesNotMatch(JSON.stringify({actions,totals}),/canary/);
  db.exec('CREATE TABLE messages(data TEXT)');
  db.prepare('INSERT INTO messages VALUES(?)').run(JSON.stringify({role:'assistant',text:'public progress',createdAt:updated}));
  db.prepare('INSERT INTO messages VALUES(?)').run(JSON.stringify({role:'system',text:'private reasoning canary'}));
  assert.equal(JSON.parse(db.prepare(PRIVATE_PROGRESS_MESSAGES).get().detail)[0].text,'public progress');
  assert.equal(JSON.parse(db.prepare(PRIVATE_PROGRESS_MESSAGES).get().detail).length,1);
  assert.equal(JSON.parse(db.prepare(PRIVATE_PROGRESS_GOAL).get().detail).title,'private-canary');
  event(8,'failed:start','tool.started',updated,{operationId:'failed-canary',actionType:'exec',input:{command:'false',timeoutMs:10000,yieldMs:1000}});
  event(9,'tool:failed-canary','tool.completed',updated,{result:{status:'failed',exitCode:1,output:'bounded failure',error:'Command timed out; its process group was terminated.'}});
  assert.equal(JSON.parse(db.prepare(PRIVATE_PROGRESS_FAILURES).get().detail)[0].command,'false');
  const deadlines=summarizePerformance({tools:db.prepare(PERFORMANCE_TOOLS).all()},window).tools;
  assert.equal(deadlines[0].deadlineMs,10000);assert.equal(deadlines[0].yieldMs,1000);assert.equal(deadlines[0].failureKind,'timeout');
  assert.equal(summarizeActivity(db.prepare(PERFORMANCE_ACTIVITY).all(),window).find(row=>row.tool==='exec').timedOut,1);
 }finally{db.close();}
});
test('performance summary drops arbitrary labels, private fields and invalid timestamps',()=>{
 const row={created_at:created,updated_at:updated,started_at:created,finished_at:updated,timestamp:now,status:'private-canary',tool:'private-canary',kind:'private-canary',phase:'private-canary',stop_reason:'private-canary',secret:'private-canary',generations:'private-canary',output_tokens:'private-canary',file_kind:'private-canary',key_kind:'private-canary',failure_kind:'private-canary',written_characters:'private-canary'};
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
test('inference diagnostics retain progress timestamps without provider bodies or prompt material',async()=>{
 const {PERFORMANCE_REQUESTS,summarizeInferenceRequests}=await import('../prod-performance-diagnostics.mjs');
 const db=new DatabaseSync(':memory:');try{
  db.exec('CREATE TABLE timber_inference_requests(id INTEGER,source TEXT,phase TEXT,started_at INTEGER,last_progress_at INTEGER,bytes INTEGER,http_status INTEGER,idle INTEGER,estimated_tokens INTEGER)');
  db.prepare('INSERT INTO timber_inference_requests VALUES(1,?,?,?,?,?,?,?,?)').run('chatgpt','streaming',now-1000,now,500,200,0,110000);
  const report=summarizeInferenceRequests(db.prepare(PERFORMANCE_REQUESTS).all());assert.equal(report[0].lastProgressAt,new Date(now).toISOString());assert.equal(report[0].estimatedTokens,110000);
  assert.doesNotMatch(JSON.stringify(summarizeInferenceRequests([{source:'private-canary',phase:'private-canary',secret:'private-canary'}])),/private-canary/);
 }finally{db.close();}
});
test('queued conversations without native wake tables remain inspectable without inventing zero recovery counts',async()=>{
 const ws='a'.repeat(32),bot='b'.repeat(32),id='10000000-0000-4000-8000-000000000001',task='20000000-0000-4000-8000-000000000002';
 const core=['runs','submissions','events','botspace_runtime_budget','pi_tasks','pi_entries'];
 const result=await collectDurable({now,env:{CLOUDFLARE_ACCOUNT_ID:ws,CLOUDFLARE_API_TOKEN:'private-canary',DIAGNOSTIC_SCOPE:'performance'},fetcher:async(url,init)=>{
  if(init.method==='GET')return Response.json({success:true,result:[{id:ws,class:'WorkspaceDO',script:'timber-api',use_sqlite:true},{id:bot,class:'BotDO',script:'timber-api',use_sqlite:true}]});
  const input=JSON.parse(init.body),sql=input.queries[0].sql;
  assert.ok(![PERFORMANCE_WAKES,PERFORMANCE_RECOVERY,PERFORMANCE_DELIVERIES,PERFORMANCE_PROCESSES,PERFORMANCE_RUNS].includes(sql),'must not query absent lazy tables');
  const records=sql.includes('SELECT id FROM bots')?[{id}]:sql===PERFORMANCE_SCHEMA?core.map(name=>({name})):sql===PERFORMANCE_TASKS?[{id:task,status:'queued',holder:'none',created_at:created,updated_at:updated}]:[];
  const columns=records.length?Object.keys(records[0]):[];
  return Response.json({success:true,result:{results:[{columns,rows:records.map(row=>columns.map(name=>row[name])),meta:{rows_written:0}}]}});
 }});
 assert.equal(result.tasks[0].status,'queued');assert.equal(result.tasks[0].scheduler.holder,'none');
 assert.deepEqual(result.tasks[0].execution.unavailable,['runs','wakes','recovery','processes','deliveries']);
 assert.doesNotMatch(JSON.stringify(result),new RegExp(`canary|${id}|${task}`));
});

test('queued child delivery diagnostics distinguish an idle recipient without disclosing its identity or inputs',()=>{
 const db=new DatabaseSync(':memory:');
 try{
  db.exec('CREATE TABLE pi_tasks(id INTEGER,status TEXT,record TEXT,conversation_id INTEGER);CREATE TABLE pi_submissions(request_id TEXT,status TEXT,conversation_id INTEGER,id INTEGER);CREATE TABLE pi_entries(id INTEGER,record TEXT);CREATE TABLE pi_documents(id INTEGER,kind TEXT,scope_kind TEXT,owner_id INTEGER,retired_at INTEGER);CREATE TABLE pi_document_revisions(document_id INTEGER,seq INTEGER,kind TEXT,content TEXT)');
  db.prepare('INSERT INTO pi_tasks VALUES(?,?,?,?)').run(1,'running',JSON.stringify({kind:'timber.subagent-delivery',input:{operationId:'private-canary'},state:{checkpoint:{phase:'deliver'}}}),1);
  db.prepare('INSERT INTO pi_submissions(request_id,status,conversation_id,id) VALUES(?,?,?,?)').run(JSON.stringify('private-canary'),'queued',2,5);
  const idle=summarizePerformance({deliveries:db.prepare(PERFORMANCE_DELIVERIES).all()},window).deliveries[0];
  assert.equal(idle.recipientActiveTasks,0);assert.equal(idle.recipientIsRoot,false);assert.equal(idle.submissionStatus,'queued');assert.doesNotMatch(JSON.stringify(idle),/canary/);
  db.prepare('INSERT INTO pi_documents VALUES(?,?,?,?,?)').run(10,JSON.stringify('pi.live'),'conversation',2,null);
  db.prepare('INSERT INTO pi_documents VALUES(?,?,?,?,?)').run(11,JSON.stringify('pi.inbox'),'conversation',2,null);
  db.prepare('INSERT INTO pi_document_revisions VALUES(?,?,?,?)').run(10,1,'base',JSON.stringify({run:{taskId:3,inputs:[77]}}));
  db.prepare('INSERT INTO pi_document_revisions VALUES(?,?,?,?)').run(11,1,'base',JSON.stringify({items:[{id:5,mode:'steer',content:'private-canary'}]}));
  db.prepare('INSERT INTO pi_tasks VALUES(?,?,?,?)').run(3,'terminal',JSON.stringify({kind:'pi.generation'}),2);
  const orphan=summarizePerformance({deliveries:db.prepare(PERFORMANCE_DELIVERIES).all()},window).deliveries[0];
  assert.equal(orphan.recipientLiveRun,true);assert.equal(orphan.recipientControllerStatus,'terminal');assert.equal(orphan.recipientInboxMatches,true);assert.doesNotMatch(JSON.stringify(orphan),/canary/);
  db.prepare('INSERT INTO pi_document_revisions VALUES(?,?,?,?)').run(10,2,'delta',JSON.stringify([{op:'remove',path:'/run'}]));
  assert.equal(summarizePerformance({deliveries:db.prepare(PERFORMANCE_DELIVERIES).all()},window).deliveries[0].recipientLiveRun,null,'a stored base cannot be mistaken for the current state after a delta');
  db.prepare('INSERT INTO pi_tasks VALUES(?,?,?,?)').run(2,'running',JSON.stringify({kind:'pi.generation'}),2);
  const busy=summarizePerformance({deliveries:db.prepare(PERFORMANCE_DELIVERIES).all()},window).deliveries[0];assert.equal(busy.recipientActiveTasks,1);
 }finally{db.close();}
});

test('includes active tasks from every bot before newer completed history without exporting names',()=>{
 const db=new DatabaseSync(':memory:');
 try {
  db.exec('CREATE TABLE bots(id TEXT,data TEXT);CREATE TABLE tasks(id TEXT,data TEXT);CREATE TABLE task_slots(bot_id TEXT,task_id TEXT,updated_at INTEGER);CREATE TABLE computer_admissions(bot_id TEXT,payload TEXT)');
  db.prepare('INSERT INTO bots VALUES(?,?)').run('named',JSON.stringify({name:'private-other-bot'}));
  db.prepare('INSERT INTO bots VALUES(?,?)').run('root',JSON.stringify({name:'Polibot'}));
  for(const [id,botId,status] of [['working','named','running'],['waiting','named','queued'],['new-complete','root','completed']])
   db.prepare('INSERT INTO tasks VALUES(?,?)').run(id,JSON.stringify({botId,status,createdAt:created,updatedAt:updated,title:'private-task-canary'}));
  const rows=db.prepare(PERFORMANCE_TASKS).all();
  assert.deepEqual(rows.map(row=>row.id),['waiting','working','new-complete']);
  assert.doesNotMatch(JSON.stringify(rows.map(performanceTaskMetadata)),/private|named|working|waiting/);
 } finally {db.close();}
});
