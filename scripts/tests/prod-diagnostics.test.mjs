import {test} from 'node:test';
import assert from 'node:assert/strict';
import {collect, queryBody, summarize, timeframe} from '../prod-diagnostics.mjs';
const now = Date.parse('2026-10-09T15:00:00Z');
const env = {CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),CLOUDFLARE_API_TOKEN:'secret-token',DIAGNOSTIC_HOURS:'6'};
const event = overrides => ({timestamp:now-1000,$metadata:{id:'one',service:'timber-api',level:'error'},$workers:{scriptName:'timber-api',entrypoint:'ComputerDO',eventType:'fetch',outcome:'exception'},source:{message:'computer.failure',code:'computer_lifecycle_failed',stage:'request'},...overrides});
test('restricts historical query to the production worker and a bounded UTC window',()=>{
  const window = timeframe({},now), query = queryBody(window);
  assert.equal(window.to-window.from,6*3600_000);
  assert.deepEqual(query.parameters.filters,[{key:'$metadata.service',operation:'eq',type:'string',value:'timber-api'}]);
  assert.equal(query.dry,true);assert.equal(query.limit,200);
  for(const hours of [0,25,'abc',1.5]) assert.throws(()=>timeframe({hours},now));
  assert.throws(()=>timeframe({end:'2026-10-09T15:00:00-07:00'},now));
  assert.throws(()=>timeframe({end:'2026-09-01T15:00:00Z'},now));
});
test('exports only fixed diagnostic labels while discarding credentials, URLs, messages and other services',()=>{
  const secret = 'PRIVATE_TOKEN_PERSON_PROMPT_AND_COMMAND';
  const report=summarize([event({$metadata:{id:secret,service:'timber-api',level:'error',error:`${secret} computer_lifecycle_failed`,url:`https://host/${secret}`,statusCode:503,duration:120000},source:{message:['computer.failure',{code:'computer_lifecycle_failed',stage:'request'}],headers:{Authorization:secret},body:{prompt:secret},output:secret}}),event({$workers:{scriptName:'other-worker'},source:{message:secret}})],timeframe({},now));
  assert.equal(report.sampledEvents,1);assert.equal(report.ignoredEvents,1);
  assert.deepEqual(report.counts.diagnosticCodes,{computer_lifecycle_failed:1});
  assert.deepEqual(report.counts.stages,{request:1});assert.deepEqual(report.counts.httpStatuses,{'503':1});
  assert.equal(JSON.stringify(report).includes(secret),false);
  assert.equal(JSON.stringify(report).includes('https://host'),false);
});
test('uses CI token without sending it to redirects or including raw provider errors',async()=>{
  let request;
  const report=await collect({env,now,fetcher:async(url,init)=>{request={url,init};return Response.json({success:true,result:{events:{events:[event()]}}});}});
  assert.equal(request.init.headers.Authorization,'Bearer secret-token');assert.equal(request.init.redirect,'manual');
  assert.equal(new URL(request.url).origin,'https://api.cloudflare.com');assert.equal(report.sampledEvents,1);
  await assert.rejects(collect({env,now,fetcher:async()=>new Response('Authorization: PRIVATE_SECRET',{status:403})}),{message:'diagnostics_cloudflare_http_403'});
  await assert.rejects(collect({env,now,fetcher:async()=>{throw new Error('PRIVATE_SECRET');}}),{message:'diagnostics_cloudflare_transport_failed'});
  await assert.rejects(collect({env,now,fetcher:async()=>Response.json({success:false,errors:[{message:'PRIVATE_SECRET'}]})}),{message:'diagnostics_cloudflare_query_rejected'});
});
test('bounds pagination, deduplicates events and reports sampling truncation',async()=>{
  let calls=0;
  const report=await collect({env,now,fetcher:async(_url,init)=>{
    calls++;const query=JSON.parse(init.body);assert.ok(calls===1||query.offset);
    return Response.json({success:true,result:{events:{events:Array.from({length:200},(_,index)=>event({$metadata:{id:`${calls}:${index}`,service:'timber-api',level:'error'}}))}}});
  }});
  assert.equal(calls,5);assert.equal(report.sampledEvents,1000);assert.equal(report.truncated,true);
});
test('preserves legacy CI key authentication and rejects oversized responses without echoing them',async()=>{
  const legacy={...env,CLOUDFLARE_API_TOKEN:'',CLOUDFLARE_API_KEY:'legacy-secret',CLOUDFLARE_EMAIL:'private@example.test'};
  await collect({env:legacy,now,fetcher:async(_url,init)=>{assert.equal(init.headers['X-Auth-Key'],'legacy-secret');assert.equal(init.headers.Authorization,undefined);return Response.json({success:true,result:{events:{events:[]}}});}});
  await assert.rejects(collect({env,now,fetcher:async()=>new Response('x'.repeat(4*1024*1024+1))}),{message:'diagnostics_response_too_large'});
});

test('correlates fixed HTTP entrypoints and categorized model failures without retaining raw log details',()=>{
  const privateValue='PRIVATE_MODEL_BOT_TOKEN_PROMPT';
  const report=summarize([
    event({timestamp:now-5000,$workers:{scriptName:'timber-api',entrypoint:'ChatGPTAuthDO',eventType:'fetch',outcome:'ok'},$metadata:{service:'timber-api',statusCode:400,level:'warn'},source:{event:'model.failure',errorCode:'model_fast_unsupported',stage:'request',status:400,model:privateValue,botId:privateValue,message:privateValue}}),
    event({timestamp:now-1000,$workers:{scriptName:'timber-api',entrypoint:'BotDO',eventType:'fetch',outcome:'ok'},$metadata:{service:'timber-api',statusCode:200,level:'warn'},source:{message:JSON.stringify({event:'model.failure',errorCode:'model_fast_unsupported',stage:'runtime',status:400,prompt:privateValue})}}),
    event({timestamp:now-3000,$workers:{scriptName:'timber-api',entrypoint:privateValue,eventType:'fetch',outcome:'ok'},$metadata:{service:'timber-api',statusCode:403,level:'warn'},source:{event:privateValue,errorCode:privateValue,stage:privateValue,status:privateValue}}),
  ],timeframe({},now));
  assert.deepEqual(report.counts.httpStatusesByEntrypoint,{ChatGPTAuthDO:{'400':1},BotDO:{'200':1},unspecified:{'403':1}});
  assert.deepEqual(report.counts.modelFailureHttpStatuses,{'400':2});
  assert.deepEqual(report.counts.diagnosticCodes,{model_fast_unsupported:2});
  assert.deepEqual(report.counts.logTypes,{'model.failure':2});
  assert.deepEqual(report.counts.stages,{request:1,runtime:1});
  assert.deepEqual(report.observedWindow,{from:'2026-10-09T14:59:55.000Z',to:'2026-10-09T14:59:59.000Z'});
  assert.deepEqual(report.diagnosticWindows,{model_fast_unsupported:{from:'2026-10-09T14:59:55.000Z',to:'2026-10-09T14:59:59.000Z'}});
  assert.equal(JSON.stringify(report).includes(privateValue),false);
});

test('keeps observed time coverage empty for rejected events and filters arbitrary model log categories',()=>{
  const window=timeframe({},now);
  const rejected=summarize([event({timestamp:'private-invalid-time'}),event({timestamp:now+1})],window);
  assert.equal(rejected.observedWindow,null);assert.deepEqual(rejected.diagnosticWindows,{});
  const report=summarize([event({source:{event:'model.failure',errorCode:'arbitrary_private_provider_error',stage:'private_stage',status:999}})],window);
  assert.deepEqual(report.counts.diagnosticCodes,{});assert.deepEqual(report.counts.stages,{});assert.deepEqual(report.counts.modelFailureHttpStatuses,{});
  assert.equal(JSON.stringify(report).includes('arbitrary_private_provider_error'),false);
});
