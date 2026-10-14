import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm,readFile,writeFile,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Runner} from '../../packages/runner/src/worker.mjs';
import {Journal} from '../../packages/runner/src/journal.mjs';
import {secureDirectory} from '../../packages/runner/src/credentials.mjs';
import {RunnerError} from '../../packages/runner/src/errors.mjs';
const all=['diagnostics','files.read','files.write','host.shell','agent.run'];
function job(action,extra={}){return {id:randomUUID(),deviceId:'device',botId:'bot',workspaceId:'workspace',scopeId:'scope',operationId:randomUUID(),type:'computer',permission:action?.type==='writeFile'?'files.write':action?.type==='exec'?'host.shell':['execPoll','execCancel','diagnostics'].includes(action?.type)?'diagnostics':'files.read',grantEpoch:'epoch',claimToken:'fixture-private-claim',action,approval:{authorized:true,mode:'approved'},...extra};}
async function waitFor(work){for(let index=0;index<100;index++){if(await work())return;await new Promise(resolve=>setTimeout(resolve,20));}throw new Error('Condition did not settle');}
async function setup(work,{agentRunner,approvalMode='ask'}={}){
 const dir=await mkdtemp(join(tmpdir(),'timber-runner-worker-')),state=join(dir,'.runner');await secureDirectory(state);const server={jobs:[],cancellations:[],results:[],events:[],starts:[],device:{id:'device',status:'online',grants:[{botId:'bot',workspaceIds:['workspace'],permissions:all,epoch:'epoch'}]},failStart:0,failResult:0};
 const client={request:async(path,body)=>{if(path.endsWith('/jobs/poll')){const jobs=server.jobs.splice(0),cancellations=server.cancellations.splice(0);return {jobs,cancellations,device:structuredClone(server.device)};}if(path.endsWith('/start')){server.starts.push(body);if(server.failStart-->0)throw new RunnerError('offline','Offline fixture');return {ok:true};}if(path.endsWith('/result')){server.results.push(body);if(server.failResult-->0)throw new RunnerError('offline','Lost receipt fixture');return {ok:true};}if(path.endsWith('/agent/event')){server.events.push(body);return {ok:true};}throw new Error('Unexpected device route');}};
 const config={url:'https://timber.example',deviceId:'device',permissions:all,approvalMode,workspaces:[{id:'workspace',name:'Fixture',path:dir}]},runner=new Runner({stateDir:state,config,client,...(agentRunner?{agentRunner}:{})});
 try{await work({dir,state,server,runner,client,config});}finally{await runner.stop();runner.journal.close();await rm(dir,{recursive:true,force:true});}
}
test('current workspace grants and local ask approval prevent mutations before any filesystem or process effect',async()=>setup(async({dir,server,runner})=>{
 const unapproved=job({type:'writeFile',path:'forbidden.txt',content:'must not write'},{approval:{authorized:true,mode:'automatic'}}),stale=job({type:'exec',command:'printf forbidden > shell-effect',yieldMs:0},{grantEpoch:'old-epoch'});server.jobs.push(unapproved,stale);await runner.poll();await waitFor(()=>runner.active.size===0);await runner.flush();assert.equal(await readFile(join(dir,'forbidden.txt')).then(()=>true,()=>false),false);assert.equal(await readFile(join(dir,'shell-effect')).then(()=>true,()=>false),false);assert.equal(server.starts.length,0);assert.equal(runner.journal.job(unapproved.id).result.result.status,'failed');
 const allowed=job({type:'writeFile',path:'allowed.txt',content:'approved'});server.jobs.push(allowed);await runner.poll();await waitFor(()=>runner.active.size===0);assert.equal(await readFile(join(dir,'allowed.txt'),'utf8'),'approved');assert.equal(server.starts.length,1);
}));
test('a lost start acknowledgment retries only admission, and a lost result acknowledgment retries only its exact durable receipt',async()=>setup(async({dir,server,runner})=>{
 const request=job({type:'exec',command:'printf once >> effect.txt',yieldMs:1000});server.failStart=1;server.jobs.push(request);await runner.poll();await waitFor(()=>runner.active.size===0);assert.equal(runner.journal.job(request.id).state,'accepted');assert.equal(await readFile(join(dir,'effect.txt')).then(()=>true,()=>false),false);
 await runner.poll();await waitFor(()=>runner.active.size===0);server.failResult=1;await runner.flush();assert.equal(runner.journal.outbox().length,1);await runner.flush();assert.equal(await readFile(join(dir,'effect.txt'),'utf8'),'once');assert.equal(server.starts.length,2);assert.equal(server.results.length,2);assert.deepEqual(server.results[0],server.results[1]);
}));
test('agent jobs run in the background while their independently granted computer jobs are serviced',async()=>{
 let release,started=false;const pending=new Promise(resolve=>{release=resolve;});
 await setup(async({dir,server,runner})=>{
  const agent=job(undefined,{type:'agent',permission:'agent.run',approval:{authorized:true,mode:'automatic'},agent:{operationId:'agent-op',text:'Work locally',instructions:'Keep effects authorized',modelSettings:{model:'fixture-model'}}});server.jobs.push(agent);await runner.poll();await waitFor(()=>started);assert.equal(runner.active.has(agent.id),true);
  const effect=job({type:'writeFile',path:'tool-result.txt',content:'separate computer effect'});server.jobs.push(effect);await runner.poll();await waitFor(()=>runner.journal.job(effect.id)?.state==='settled');assert.equal(await readFile(join(dir,'tool-result.txt'),'utf8'),'separate computer effect');assert.equal(runner.active.has(agent.id),true);release();await waitFor(()=>runner.active.size===0);await runner.flush();assert.equal(runner.journal.job(agent.id).result.agentResult.status,'done');assert.equal(server.events[0].sequence,1);assert.equal(server.events[0].event.eventKey,'native-entry-fixture');
 },{agentRunner:async(_job,options)=>{started=true;await options.emit({type:'message',eventKey:'native-entry-fixture',data:{id:'entry',role:'assistant',text:'Agent working'}});await pending;return {status:'done',text:'Finished',kind:'final'};}});
});
test('a cancellation of an already reported running exec posts its confirmed terminal receipt, including after revocation',async()=>setup(async({server,runner})=>{
 const request=job({type:'exec',command:'printf started; sleep 30',yieldMs:0});server.jobs.push(request);await runner.poll();await waitFor(()=>runner.journal.job(request.id)?.state==='settled');await runner.flush();assert.equal(runner.journal.job(request.id).result.result.status,'running');
 server.device.status='revoked';server.cancellations.push({jobId:request.id,operationId:request.operationId});await assert.rejects(runner.poll(),{code:'device_revoked'});assert.equal(runner.journal.job(request.id).result.result.status,'cancelled');assert.equal(server.results.at(-1).result.status,'cancelled');assert.equal(runner.sessions.live.size,0);
}));
test('restart returns an unknown effect receipt without re-executing even when the server repeats the job',async()=>setup(async({dir,state,server,runner})=>{
 const request=job({type:'writeFile',path:'must-not-replay',content:'unsafe repeat'});runner.journal.receive(request);runner.journal.state(request.id,'executing');runner.journal.recover();server.jobs.push(request);await runner.poll();assert.equal(server.starts.length,0);assert.equal(server.results[0].result.status,'interrupted');assert.equal(await readFile(join(dir,'must-not-replay')).then(()=>true,()=>false),false);assert.equal((await lstat(join(state,'journal.sqlite'))).mode&0o777,0o600);
}));
test('pending event reporting cannot block computer polling or cancellation terminal acknowledgments',async()=>{
 let started=false,agentRelease;const agentPending=new Promise(resolve=>{agentRelease=resolve;});
 await setup(async({dir,server,runner,client})=>{
  const original=client.request;let eventRelease,eventEntered=false;const eventPending=new Promise(resolve=>{eventRelease=resolve;});client.request=async(path,body,options)=>{if(path.endsWith('/agent/event')){eventEntered=true;await eventPending;}return original(path,body,options);};
  const agent=job(undefined,{type:'agent',permission:'agent.run',agent:{operationId:'background-agent',text:'Work',instructions:'Keep effects scoped',modelSettings:{model:'fixture'}}});server.jobs.push(agent);await runner.poll();await waitFor(()=>started);void runner.flush();await waitFor(()=>eventEntered);
  const effect=job({type:'writeFile',path:'poster-concurrent',content:'computer stayed available'});server.jobs.push(effect);const start=Date.now();await runner.poll();assert.ok(Date.now()-start<500);await waitFor(()=>runner.journal.job(effect.id)?.state==='settled');assert.equal(await readFile(join(dir,'poster-concurrent'),'utf8'),'computer stayed available');
  const cancellation=runner.cancel({jobId:agent.id,operationId:agent.operationId});agentRelease();await cancellation;assert.equal(runner.journal.hasEvents(agent.id),false);eventRelease();await runner.flush();await runner.flush();assert.ok(server.results.some(result=>result.agentResult?.reason==='aborted'));
 },{agentRunner:async(_job,options)=>{started=true;await options.emit({type:'message.delta',data:{delta:'working'}});await agentPending;options.signal.throwIfAborted();return {status:'done',text:'done'};}});
});
test('foreground Stop fences aborted agent activity so a revoked event route cannot hold its terminal acknowledgment',async()=>{
 let started=false;
 await setup(async({server,runner,client})=>{
  const original=client.request;client.request=async(path,body,options)=>{if(path.endsWith('/agent/event'))throw new RunnerError('device_revoked','Revoked event fixture');return original(path,body,options);};
  const agent=job(undefined,{type:'agent',permission:'agent.run',agent:{operationId:'stopped-agent',text:'Work',instructions:'Keep effects scoped',modelSettings:{model:'fixture'}}});server.jobs.push(agent);await runner.poll();await waitFor(()=>started);
  await runner.stop();assert.equal(runner.journal.hasEvents(agent.id),false);await runner.flush();assert.equal(server.results.at(-1).agentResult.reason,'aborted');assert.equal(runner.journal.outbox().length,0);
 },{agentRunner:async(_job,options)=>{started=true;await options.emit({type:'message.delta',data:{delta:'working'}});await new Promise(resolve=>options.signal.addEventListener('abort',resolve,{once:true}));await options.emit({type:'run.aborted',data:{operationId:_job.operationId}});options.signal.throwIfAborted();}});
});
