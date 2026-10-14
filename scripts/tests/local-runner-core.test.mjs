import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm,readFile,writeFile,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {Journal} from '../../packages/runner/src/journal.mjs';
import {Sessions} from '../../packages/runner/src/sessions.mjs';
import {secureDirectory} from '../../packages/runner/src/credentials.mjs';
async function temporary(work){const dir=await mkdtemp(join(tmpdir(),'timber-runner-core-'));await secureDirectory(dir);const journal=new Journal(dir),sessions=new Sessions(journal);try{await work({dir,journal,sessions});}finally{await sessions.cancelAll();journal.close();await rm(dir,{recursive:true,force:true});}}
function job(action){return {id:randomUUID(),deviceId:'device',botId:'bot',workspaceId:'workspace',scopeId:'scope',operationId:randomUUID(),type:'computer',permission:'host.shell',action,claimToken:'private-claim'};}
async function waitFor(work){for(let index=0;index<100;index++){if(await work())return;await new Promise(resolve=>setTimeout(resolve,20));}throw new Error('Condition did not settle');}
test('a short command returns promptly and a duplicate invocation never repeats its effect',async()=>temporary(async({dir,journal,sessions})=>{
 const action={type:'exec',command:'printf once >> effect.txt',yieldMs:1000},request=job(action);journal.receive(request);journal.state(request.id,'executing');const start=Date.now(),result=await sessions.exec(request,dir,action);assert.equal(result.status,'completed');assert.ok(Date.now()-start<900,'yieldMs must return early once command completes');journal.finish(request.id,{result});
 const duplicate=await sessions.exec(request,dir,action);assert.equal(duplicate.processId,result.processId);assert.equal(await readFile(join(dir,'effect.txt'),'utf8'),'once');assert.equal((await lstat(join(dir,'journal.sqlite'))).mode&0o777,0o600);
}));
test('managed shell yields, polls bounded output and cancels its process group before later effects',async()=>temporary(async({dir,journal,sessions})=>{
 const action={type:'exec',command:'printf started; sleep 2; printf forbidden > late-effect',yieldMs:0},request=job(action);journal.receive(request);journal.state(request.id,'executing');const first=await sessions.exec(request,dir,action);assert.equal(first.status,'running');journal.finish(request.id,{result:first});
 await waitFor(()=>journal.process(first.processId)?.output.includes('started'));const poll=job({type:'execPoll',processId:first.processId});assert.match((await sessions.poll(poll,poll.action)).output,/started/);
 const cancel=job({type:'execCancel',processId:first.processId});const stopped=await sessions.cancel(cancel,cancel.action);assert.equal(stopped.status,'cancelled');assert.equal(journal.job(request.id).result.result.status,'cancelled');
 await new Promise(resolve=>setTimeout(resolve,2100));assert.equal(await readFile(join(dir,'late-effect')).then(()=>true,()=>false),false);
}));
test('a process from another bot or task cannot be read or cancelled, even with a reused operation ID',async()=>temporary(async({dir,journal,sessions})=>{
 const request=job({type:'exec',command:'sleep 5',yieldMs:0});journal.receive(request);const first=await sessions.exec(request,dir,request.action),other={...job({type:'execCancel',processId:first.processId}),botId:'another-bot'};
 await assert.rejects(sessions.cancel(other,other.action),{code:'process_forbidden'});assert.equal(journal.process(first.processId).state,'running');
}));
test('uncertain interrupted effects stay fenced across restart and conflicting job bodies are rejected',async()=>temporary(async({journal})=>{
 const request=job({type:'writeFile',path:'target',content:'once'});journal.receive(request);journal.state(request.id,'executing');journal.recover();assert.equal(journal.job(request.id).result.result.status,'interrupted');assert.equal(journal.pending().length,0);assert.equal(journal.receive(request).state,'settled');assert.throws(()=>journal.receive({...request,action:{...request.action,content:'another'}}),{code:'operation_conflict'});
 const event={type:'message.delta',operationId:'source',data:{delta:'hello'}};journal.event(request.id,event);journal.event(request.id,{...event,data:{delta:' world'}});assert.equal(journal.events()[0].event.data.delta,'hello world');journal.eventAttempted(request.id,1);journal.event(request.id,{...event,data:{delta:' new'}});assert.equal(journal.events().length,2);assert.equal(journal.events()[0].event.data.delta,'hello world','a lost receipt must replay the exact original payload');
}));
test('runner death triggers guardian cancellation and restart consumes its durable terminal receipt without rerunning',async()=>temporary(async({dir,journal,sessions})=>{
 const request=job({type:'exec',command:'printf once >> crash-effect; sleep 2; printf forbidden > orphan-effect',yieldMs:1000}),probe=join(dir,'probe.mjs');
 await writeFile(probe,`import {Journal} from ${JSON.stringify(new URL('../../packages/runner/src/journal.mjs',import.meta.url).href)};import {Sessions} from ${JSON.stringify(new URL('../../packages/runner/src/sessions.mjs',import.meta.url).href)};const journal=new Journal(${JSON.stringify(dir)}),sessions=new Sessions(journal),job=${JSON.stringify(request)};journal.receive(job);journal.state(job.id,'executing');await sessions.exec(job,${JSON.stringify(dir)},job.action);console.log('ready');setInterval(()=>{},1000);`);
 const child=spawn(process.execPath,[probe],{stdio:['ignore','pipe','ignore']});await new Promise((resolve,reject)=>{child.stdout.on('data',chunk=>{if(chunk.toString().includes('ready'))resolve();});child.on('error',reject);});child.kill('SIGKILL');await new Promise(resolve=>child.once('exit',resolve));journal.recover();assert.equal(journal.job(request.id).result.result.status,'interrupted');
 await waitFor(async()=>{await sessions.reconcile();return journal.process(`device-process:${request.id}`)?.state==='cancelled';});assert.equal(await readFile(join(dir,'crash-effect'),'utf8'),'once');assert.equal(journal.job(request.id).result.result.status,'cancelled');assert.equal(journal.pending().length,0);
 await new Promise(resolve=>setTimeout(resolve,1100));assert.equal(await readFile(join(dir,'orphan-effect')).then(()=>true,()=>false),false);
}));
