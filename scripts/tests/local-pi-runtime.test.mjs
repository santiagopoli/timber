import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {runAgentJob,proxyProvider} from '../../packages/runner/src/pi-runtime.mjs';

const usage={input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
const message=(content,stopReason='stop')=>({role:'assistant',content,stopReason,api:'openai-responses',provider:'timber-cloud',model:'fixture-model',usage,timestamp:Date.now()});
const response=content=>new Response(JSON.stringify({type:'done',reason:content.stopReason,message:content})+'\n');
const job=id=>({id:`job-${id}`,type:'agent',deviceId:'fixture-device',workspaceId:'fixture-workspace',botId:'fixture-bot',claimToken:'fixture-claim',agent:{operationId:id,botId:'fixture-bot',text:'Inspect the fixture workspace.',instructions:'You are a fixture agent.',modelSettings:{model:'fixture-model'}}});
async function temporary(work){const dir=await mkdtemp(join(tmpdir(),'timber-local-pi-'));try{await work(dir);}finally{await rm(dir,{recursive:true,force:true});}}

test('portable Pi actually infers, runs a real subprocess via scoped tools, and persists deduplicated conversation',()=>temporary(async dir=>{
  let requests=0,effects=0;const events=[],contexts=[],journal=new Map();
  const executeTool=async({name,arguments:args,operationId})=>{
    if(journal.has(operationId))return journal.get(operationId);
    assert.equal(name,'exec');effects++;
    const output=await new Promise((resolve,reject)=>{const child=spawn('/bin/sh',['-c',args.command],{cwd:dir});let text='';child.stdout.on('data',chunk=>{text+=chunk;});child.on('error',reject);child.on('exit',code=>code===0?resolve(text):reject(Error('fixture command failed')));});
    const result={operationId,status:'completed',exitCode:0,output};journal.set(operationId,result);return result;
  };
  const options={stateDir:dir,workspace:dir,executeTool,emit:async event=>{events.push(event);},inference:async context=>{contexts.push(context);requests++;
    return response(requests===1?message([{type:'text',text:'Checking the real file.'},{type:'toolCall',id:'fixture-call',name:'exec',arguments:{command:"printf 'real-effect' >> effect.txt; cat effect.txt"}}],'toolUse'):message([{type:'text',text:'The file contains real-effect.'}]));
  }};
  assert.deepEqual(await runAgentJob(job('first'),options),{status:'done',kind:'final',text:'The file contains real-effect.'});
  assert.equal(await readFile(join(dir,'effect.txt'),'utf8'),'real-effect');assert.equal(effects,1);assert.equal(requests,2);
  assert.ok(events.some(event=>event.type==='tool.started'));assert.ok(events.some(event=>event.type==='tool.completed'));assert.ok(events.some(event=>event.type==='message'&&event.data.role==='assistant'));
  await runAgentJob(job('first'),options);assert.equal(requests,2,'reopening a settled durable input never calls the model again');assert.equal(effects,1);
  await runAgentJob({...job('second'),agent:{...job('second').agent,text:'Follow up without repeating the command.',context:[{role:'user',text:job('first').agent.text,operationId:'first'},{role:'assistant',text:'The file contains real-effect.',operationId:'first'},{role:'user',text:'Cloud handoff decision not present in this local archive.',operationId:'cloud-handoff'}]}},options);
  assert.equal(requests,3);assert.ok(contexts.at(-1).messages.some(value=>value.role==='toolResult'&&JSON.stringify(value).includes('real-effect')),'the local SQLite conversation retains prior tool receipts');
  assert.ok(!JSON.stringify(contexts.at(-1).messages.filter(message=>message.role==='system')).includes(job('first').agent.text),'represented local turns are not duplicated in the system handoff context');
  assert.ok(JSON.stringify(contexts.at(-1).messages.filter(message=>message.role==='system')).includes('Cloud handoff decision'),'missing cloud turns remain available to the local model');
  assert.equal(effects,1,'new conversational turn never replays the prior command');
}));

test('local host pause settles as progress without another model generation or command',()=>temporary(async dir=>{
  let calls=0;
  const result=await runAgentJob(job('approval'),{stateDir:dir,emit:async()=>{},inference:async()=>{calls++;return response(message([{type:'text',text:'Approval is needed.'},{type:'toolCall',id:'approval-call',name:'exec',arguments:{command:'fixture unsafe command'}}],'toolUse'));},executeTool:async()=>({status:'pending_approval',approvalId:'fixture-approval'})});
  assert.equal(result.status,'done');assert.equal(result.kind,'progress');assert.equal(calls,1,'pending approval is a durable pause, not a polling inference loop');
}));

test('explicit cancel aborts inference, settles durably and never reruns it on reopen',()=>temporary(async dir=>{
  const controller=new AbortController();let requested,requests=0;const started=new Promise(resolve=>{requested=resolve;});
  const options={stateDir:dir,emit:async()=>{},signal:controller.signal,inference:async(_context,_options,signal)=>{requests++;requested();return new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason||Error('aborted')),{once:true});});}};
  const pending=runAgentJob(job('cancelled'),options);await started;controller.abort();
  assert.match((await pending).reason,/abort/);assert.equal(requests,1);
  await runAgentJob(job('cancelled'),{...options,signal:undefined,inference:async()=>{throw Error('cancelled inference replayed');}});assert.equal(requests,1);
}));

test('a malformed or truncated inference stream becomes a safe model error',async()=>{
  const provider=proxyProvider('fixture-model',async()=>new Response('{"type":"text_delta","delta":"partial"}\n'));
  const result=await provider.streamSimple(provider.getModels()[0],{messages:[]}).result();
  assert.equal(result.stopReason,'error');assert.equal(result.errorMessage,'model_connection_interrupted');
});

test('a process crash after an unsafe effect never repeats it when durable Pi reopens', {timeout:15000},()=>temporary(async dir=>{
  const moduleURL=new URL('../../packages/runner/src/pi-runtime.mjs',import.meta.url).href;
  const childSource=`import{runAgentJob}from${JSON.stringify(moduleURL)};import{appendFile,writeFile}from'node:fs/promises';
const job=${JSON.stringify(job('crashed'))};const stateDir=${JSON.stringify(dir)};
const usage=${JSON.stringify(usage)};
await runAgentJob(job,{stateDir,emit:async()=>{},inference:async()=>new Response(JSON.stringify({type:'done',reason:'toolUse',message:{role:'assistant',content:[{type:'toolCall',id:'crash-call',name:'exec',arguments:{command:'fixture-effect'}}],stopReason:'toolUse',api:'openai-responses',provider:'timber-cloud',model:'fixture-model',usage,timestamp:Date.now()}})+'\\n'),executeTool:async request=>{await appendFile(stateDir+'/effect-count.txt','once\\n');await writeFile(stateDir+'/accepted-operation.txt',request.operationId);process.send({started:true});return new Promise(()=>{});}});`;
  const childPath=join(dir,'crash-fixture.mjs');await writeFile(childPath,childSource);
  const child=spawn(process.execPath,[childPath],{stdio:['ignore','ignore','pipe','ipc']});let errors='';child.stderr.on('data',chunk=>{errors+=chunk;});
  try {
    await new Promise((resolve,reject)=>{child.once('message',resolve);child.once('error',reject);child.once('exit',code=>{if(code!==null)reject(Error(`fixture exited early ${code}: ${errors}`));});});
    const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGKILL');await exited;
    let effects=0;
    const result=await runAgentJob(job('crashed'),{stateDir:dir,emit:async()=>{},executeTool:async()=>{effects++;throw Error('unsafe effect was replayed');},inference:async()=>response(message([{type:'text',text:'Inspect the interrupted effect before requesting more work.'}]))});
    assert.equal(effects,0);assert.equal(await readFile(join(dir,'effect-count.txt'),'utf8'),'once\n');assert.ok(['done','unanswered'].includes(result.status));
  }finally{if(child.exitCode===null)child.kill('SIGKILL');}
}));
