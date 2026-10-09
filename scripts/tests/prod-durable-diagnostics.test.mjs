import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {BOT_LOOKUP,SCHEMA,FAILURE_QUERY,TASK_QUERY,collectDurable,rows,safeError,summarizeFailures,summarizeTasks} from '../prod-durable-diagnostics.mjs';

const now=Date.parse('2026-10-09T19:45:00Z'),window={from:now-3600_000,to:now};
const row={run_created_at:'2026-10-09T19:34:00Z',run_updated_at:'2026-10-09T19:35:00Z',run_status:'failed',error_code:'model_request_failed',native_reason:'model_error',detail_type:'text',detail_characters:123,detail_signature:'native_json_undefined'};
const sqlResult=(columns,data)=>({success:true,result:{results:[{columns,rows:data,meta:{rows_written:0,rows_read:data.length}}]}});

test('fixed SQL returns failure signatures without projecting raw native detail or user content',()=>{
  for(const sql of [BOT_LOOKUP,SCHEMA,FAILURE_QUERY,TASK_QUERY]){
    assert.match(sql,/^(?:SELECT|WITH) /);
    assert.doesNotMatch(sql,/\b(?:INSERT|UPDATE|DELETE|DROP|ALTER|REPLACE|ATTACH|PRAGMA)\b/i);
    assert.doesNotMatch(sql,/;/);
  }
  assert.match(FAILURE_QUERY,/END AS detail_signature/);
  assert.match(TASK_QUERY,/native_json_undefined/);
  assert.doesNotMatch(TASK_QUERY,/SELECT\s+d\.d\b/);
});

test('real SQLite queries decode native indexed strings and correlate failures to host run timestamps',()=>{
  const db=new DatabaseSync(':memory:');
  try{
    db.exec(`CREATE TABLE pi_submissions(id INTEGER,request_id TEXT,status TEXT,record TEXT);
      CREATE TABLE pi_tasks(id INTEGER,kind TEXT,status TEXT,record TEXT);
      CREATE TABLE submissions(operation_id TEXT,run_id TEXT);
      CREATE TABLE runs(id TEXT,data TEXT);
      CREATE TABLE botspace_runtime_generations(task_id TEXT,operation_id TEXT);`);
    const detail='Value contains a non-JSON undefined at $.private-canary';
    db.prepare('INSERT INTO pi_submissions VALUES(1,?,?,?)').run(JSON.stringify('operation-private-canary'),'unanswered',JSON.stringify({type:'input',requestId:'operation-private-canary',reason:'model_error',detail}));
    db.prepare('INSERT INTO pi_tasks VALUES(2,?,?,?)').run(JSON.stringify('pi.generation'),'terminal',JSON.stringify({kind:'pi.generation',state:{outcome:{status:'failed',error:{message:detail,detail:{reason:'model_error'}}}}}));
    db.prepare('INSERT INTO submissions VALUES(?,?)').run('operation-private-canary','run-private-canary');
    db.prepare('INSERT INTO runs VALUES(?,?)').run('run-private-canary',JSON.stringify({createdAt:row.run_created_at,updatedAt:row.run_updated_at,status:'failed',errorCode:'model_request_failed'}));
    db.prepare('INSERT INTO botspace_runtime_generations VALUES(?,?)').run('2','operation-private-canary');
    const failures=db.prepare(FAILURE_QUERY).all(),tasks=db.prepare(TASK_QUERY).all();
    assert.equal(failures[0].run_updated_at,row.run_updated_at);
    assert.equal(failures[0].detail_signature,'native_json_undefined');
    assert.equal(tasks[0].task_kind,'pi.generation');
    assert.equal(tasks[0].detail_signature,'native_json_undefined');
    assert.doesNotMatch(JSON.stringify({failures,tasks}),/private-canary/);
  }finally{db.close();}
});

test('allowlisted report drops identifiers, credentials, raw details and adversarial fields',()=>{
  const output=summarizeFailures([{...row,detail:'private-canary',prompt:'private-canary',operation_id:'private-canary',api_key:'private-canary'},
    {...row,error_code:'private-canary',run_status:'private-canary',native_reason:'private-canary',detail_type:'private-canary',detail_signature:'private-canary',detail_characters:'private-canary'}],window);
  assert.equal(output.failures[0].signature,'native_json_undefined');
  assert.equal(output.failures[1].signature,'unclassified');
  assert.equal(output.failures[1].errorCode,'unknown');
  assert.doesNotMatch(JSON.stringify(output),/private-canary/);
  assert.equal(summarizeFailures([{...row,run_created_at:'private-canary',run_updated_at:'private-canary'}],window).failures.length,0);
});

test('only timestamp-correlated native tasks within the selected window appear',()=>{
  const result=summarizeTasks([{...row,task_kind:'pi.generation',outcome:'failed'},
    {...row,task_kind:'private-canary',outcome:'private-canary'},
    {...row,run_updated_at:null,run_created_at:null},
    {...row,run_updated_at:'2026-10-08T00:00:00Z'}],window);
  assert.equal(result.tasks.length,2);
  assert.equal(result.outsideWindowOrUnattributed,2);
  assert.equal(result.tasks[0].kind,'pi.generation');
  assert.doesNotMatch(JSON.stringify(result),/private-canary/);
});

test('rejects writes, malformed SQL results and arbitrary upstream error strings',()=>{
  assert.throws(()=>rows({success:true,result:{error:'private-canary',results:[]}}),/durable_diagnostics_query_failed/);
  const payload=sqlResult(['a'],[[1]]);payload.result.results[0].meta.rows_written=1;
  assert.throws(()=>rows(payload),/durable_diagnostics_invalid_response/);
  assert.throws(()=>rows(sqlResult(['a'],[[1,2]])),/durable_diagnostics_invalid_response/);
  assert.equal(safeError(new Error('durable_diagnostics_private_canary')),'durable_diagnostics_failed');
  assert.equal(safeError(new Error('durable_diagnostics_http_403')),'durable_diagnostics_http_403');
});

test('queries only selected deployed namespaces and fixed Polibot SQL, keeping raw responses private',async()=>{
  const ws='a'.repeat(32),bot='b'.repeat(32),id='11111111-2222-4333-8444-555555555555';
  const calls=[];
  const responses=[{success:true,result:[{id:ws,class:'WorkspaceDO',script:'timber-api',use_sqlite:true},{id:bot,class:'BotDO',script:'timber-api',use_sqlite:true},{id:'c'.repeat(32),class:'BotDO',script:'other',use_sqlite:true}]},
    sqlResult(['id'],[[id]]),sqlResult(['name'],['pi_submissions','pi_tasks','runs','submissions','botspace_runtime_generations'].map(x=>[x])),
    sqlResult(Object.keys(row),[Object.values(row)]),sqlResult(Object.keys({...row,task_kind:'pi.generation',outcome:'failed'}),[Object.values({...row,task_kind:'pi.generation',outcome:'failed'})])];
  const result=await collectDurable({now,env:{CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),CLOUDFLARE_API_TOKEN:'secret-canary'},fetcher:async(url,init)=>{
    calls.push({url,init});return Response.json(responses.shift());
  }});
  assert.equal(calls.length,5);
  assert.equal(calls[0].init.method,'GET');
  assert.deepEqual(calls.slice(1).map(c=>JSON.parse(c.init.body).queries[0].sql),[BOT_LOOKUP,SCHEMA,FAILURE_QUERY,TASK_QUERY]);
  assert.deepEqual(calls.slice(1).map(c=>JSON.parse(c.init.body).durable_object_name),['owner',`owner:${id}`,`owner:${id}`,`owner:${id}`]);
  assert.equal(result.failures[0].signature,'native_json_undefined');
  assert.equal(result.nativeTasks.tasks[0].kind,'pi.generation');
  assert.doesNotMatch(JSON.stringify(result),new RegExp(`secret-canary|${id}`));
});

test('HTTP errors never include provider bodies and redirects are not followed',async()=>{
  let options;
  await assert.rejects(()=>collectDurable({now,env:{CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),CLOUDFLARE_API_TOKEN:'secret-canary'},fetcher:async(url,init)=>{
    options=init;return new Response('private-canary',{status:403});
  }}),{message:'durable_diagnostics_http_403'});
  assert.equal(options.redirect,'manual');
});
