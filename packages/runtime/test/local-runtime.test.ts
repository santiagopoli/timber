/** Portable host adapter tests; run with node --test (real SQLite, no model billing). */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createDeviceRuntime,type DeviceRuntimePort} from '../src/local.ts';
import type {AgentRuntime} from '../src/types.ts';
import type {ExecutionTarget,DeviceAgentInput} from '../../contracts/src/devices.ts';

function fixture(){
  const db=new DatabaseSync(':memory:');
  const storage={sql:{exec(sql:string,...args:unknown[]){const statement=db.prepare(sql),result=statement.all(...args as never[]);return {toArray:()=>result,one:()=>result[0]};}}} as unknown as DurableObjectStorage;
  const nativeCalls:string[]=[],events:unknown[]=[];let target:ExecutionTarget={kind:'device',deviceId:'device-a',workspaceId:'workspace-a',agentMode:'local'};
  const base={operation:async(id:string)=>({operationId:id,status:id==='native-old'?'done':'missing'}),submit:async(_text:string,input:{operationId:string})=>{nativeCalls.push(input.operationId);return {operationId:input.operationId,accepted:true};},pending:async()=>[],scheduleAdmissionRetry:async()=>{},cancel:async()=>false,messages:async()=>[],reconcile:async()=>{},dispose:async()=>{},destroy:async()=>{}} as unknown as AgentRuntime;
  const jobs=new Map<string,DeviceAgentInput>(),submissions:Array<{target:ExecutionTarget;input:DeviceAgentInput}>=[];let state:'queued'|'running'|'done'|'unanswered'='queued';
  const port:DeviceRuntimePort={submit:async(target,input)=>{submissions.push({target,input});jobs.set(input.operationId,input);return {jobId:input.operationId};},operation:async()=>({status:state,text:state==='done'?'Local answer':undefined}),cancel:async()=>{state='unanswered';return true;}};
  const options={base,storage,getTarget:async()=>target,snapshot:async(text:string,input:{operationId:string})=>({operationId:input.operationId,botId:'bot-a',text,instructions:'Only authorized work.',modelSettings:{model:'fixture-model'}}),port,onEvent:async(event:unknown)=>{events.push(event);},pollMs:1};
  const runtime=createDeviceRuntime(options);
  return {runtime,options,db,jobs,submissions,nativeCalls,events,port,setTarget:(next:ExecutionTarget)=>{target=next;},setState:(next:typeof state)=>{state=next;}};
}

test('local admission freezes target and snapshot, refuses conflicting retries, and retains old native operations',async()=>{
  const f=fixture();try{
    assert.deepEqual(await f.runtime.submit('First',{operationId:'local'}),{operationId:'local',accepted:true});
    f.setTarget({kind:'cloud'});assert.equal((await f.runtime.submit('First',{operationId:'local'})).accepted,false);assert.equal(f.submissions.length,1);assert.equal(f.submissions[0]!.target.kind,'device');
    await assert.rejects(f.runtime.submit('Changed',{operationId:'local'}),/operation_conflict/);
    await f.runtime.submit('Native',{operationId:'native-old'});await f.runtime.submit('New cloud',{operationId:'new-cloud'});assert.deepEqual(f.nativeCalls,['native-old','new-cloud']);
    f.setState('done');assert.deepEqual(await f.runtime.wait('local'),{operationId:'local',status:'done',text:'Local answer'});
  }finally{f.db.close();}
});

test('offline input remains pending, Stop does not dispatch an unadmitted job',async()=>{
  const f=fixture();try{
    let attempts=0;f.port.submit=async()=>{attempts++;throw new Error('device offline');};
    await assert.rejects(f.runtime.submit('Offline',{operationId:'offline'}),/offline/);assert.equal(attempts,1);
    assert.equal((await f.runtime.operation('offline')).status,'queued');assert.equal((await f.runtime.pending()).length,1);
    assert.equal(await f.runtime.cancel('offline',{cancellationId:'stop-id'}),true);await f.runtime.reconcile();assert.equal(attempts,1,'Stop never admits new device work');
    assert.deepEqual(await f.runtime.wait('offline'),{operationId:'offline',status:'unanswered',reason:'aborted',cancellationId:'stop-id'});
  }finally{f.db.close();}
});

test('Stop fences a response that returns after external admission was in flight',async()=>{
  const f=fixture();try{
    let release!:()=>void,started!:()=>void,cancellations=0;const gate=new Promise<void>(resolve=>{release=resolve;}),entered=new Promise<void>(resolve=>{started=resolve;});
    f.port.submit=async()=>{started();await gate;return {jobId:'late-job'};};f.port.cancel=async()=>{cancellations++;return true;};
    const submit=f.runtime.submit('Race',{operationId:'race'});await entered;await f.runtime.cancel('race',{cancellationId:'stop-race'});release();await submit;
    assert.equal(cancellations,1);assert.equal((await f.runtime.operation('race')).reason,'aborted');
  }finally{f.db.close();}
});

test('event pagination retains cursor across eviction and drains pages before publishing terminal status',async()=>{
  const f=fixture();try{
    await f.runtime.submit('Paged',{operationId:'paged'});const cursors:number[]=[];
    f.port.operation=async(_job,after=0)=>{cursors.push(after);return {status:'done',text:'Final',events:[{type:'message',data:{id:`message-${after+1}`,role:'assistant',text:`Page ${after+1}`},eventKey:`page-${after+1}`}],eventCursor:after+1,hasMoreEvents:after===0};};
    assert.equal((await f.runtime.operation('paged')).status,'running');
    const reopened=createDeviceRuntime(f.options);assert.equal((await reopened.operation('paged')).status,'done');assert.deepEqual(cursors,[0,1]);assert.equal(f.events.length,2);
  }finally{f.db.close();}
});

test('failed event projection can retry durably and disposal wakes an offline wait',async()=>{
  const f=fixture();try{
    await f.runtime.submit('Events',{operationId:'events'});let failed=true,calls=0;
    f.options.onEvent=async()=>{calls++;if(failed)throw Error('projection unavailable');};
    const event={type:'message',data:{id:'answer',text:'Done',role:'assistant'},eventKey:'answer'};
    await assert.rejects(f.runtime.ingestEvent('events',event),/projection/);failed=false;await f.runtime.ingestEvent('events',event);await f.runtime.ingestEvent('events',event);assert.equal(calls,2);
    f.port.operation=async()=>{throw Error('offline');};const pending=f.runtime.wait('events');await f.runtime.dispose();await assert.rejects(pending,/suspend/);
  }finally{f.db.close();}
});

test('Stop during snapshot fences admission before a local outbox row exists',async()=>{
  const f=fixture();try{
    let started!:()=>void,release!:()=>void;const entered=new Promise<void>(resolve=>{started=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
    const snapshot=f.options.snapshot;f.options.snapshot=async(text,input)=>{started();await gate;return snapshot(text,input);};
    const submit=f.runtime.submit('Preparing',{operationId:'preparing'});await entered;await f.runtime.cancel('preparing',{cancellationId:'stop-before-snapshot'});release();
    assert.equal((await submit).accepted,false);assert.equal(f.submissions.length,0);
    assert.deepEqual(await f.runtime.operation('preparing'),{operationId:'preparing',status:'unanswered',reason:'aborted',cancellationId:'stop-before-snapshot'});
    assert.equal((await f.runtime.wait('preparing')).reason,'aborted');await f.runtime.reconcile();assert.equal((await f.runtime.pending()).length,0);
  }finally{f.db.close();}
});

test('cleanup destroys the native runtime without dispatching a new broad cancellation',async()=>{
  const f=fixture();try{
    let destroyed=0;f.options.base.cancel=async()=>{throw Error('Unexpected broad native cancellation');};f.options.base.destroy=async()=>{destroyed++;};
    const runtime=createDeviceRuntime(f.options);await runtime.destroy();assert.equal(destroyed,1);
  }finally{f.db.close();}
});

test('an offline device releases its observer without losing durable admission, and resumes the same job', {timeout:2000}, async()=>{
  const f=fixture();try{
    await f.runtime.submit('Offline task',{operationId:'offline-device'});
    f.port.operation=async()=>({status:'queued',deviceOnline:false});
    await assert.rejects(f.runtime.wait('offline-device'),{code:'device_wait_pending'});
    assert.equal((await f.runtime.operation('offline-device')).status,'queued');
    assert.equal((await f.runtime.pending()).length,1);
    assert.equal(f.submissions.length,1);
    const recovered=createDeviceRuntime({...f.options,waitWindowMs:1000});
    await assert.rejects(recovered.wait('offline-device'),{code:'device_wait_pending'});
    // Completed remote jobs omit online metadata. Drain their archived events
    // even when this observer previously saw the machine offline.
    f.port.operation=async(_job,after=0)=>({status:'done',text:'Laptop resumed',events:[{type:'message',data:{id:`recovered-${after}`,text:'Recovered event'},eventKey:`recovered-${after}`}],eventCursor:after+1,hasMoreEvents:after===0});
    assert.deepEqual(await recovered.wait('offline-device'),{operationId:'offline-device',status:'done',text:'Laptop resumed'});
    assert.equal(f.submissions.length,1,'Wake-up observes the durable job without resubmission');
  }finally{f.db.close();}
});

test('online local observers also yield after a bounded window while a long job remains running', {timeout:2000}, async()=>{
  const f=fixture();try{
    const runtime=createDeviceRuntime({...f.options,waitWindowMs:10});
    await runtime.submit('Long task',{operationId:'long-device'});
    f.port.operation=async()=>({status:'running',deviceOnline:true});
    await assert.rejects(runtime.wait('long-device'),{code:'device_wait_pending'});
    assert.equal((await runtime.operation('long-device')).status,'running');
    assert.equal((await runtime.pending()).length,1);
    assert.equal(f.submissions.length,1);
    f.port.operation=async()=>({status:'done',text:'Finished',deviceOnline:true});
    assert.equal((await runtime.wait('long-device')).text,'Finished');
  }finally{f.db.close();}
});

test('Stop after an offline yield requests cancellation and waits for acknowledgment without redelivery', {timeout:2000}, async()=>{
  const f=fixture();try{
    await f.runtime.submit('Pending work',{operationId:'stop-after-yield'});
    f.port.operation=async()=>({status:'queued',deviceOnline:false});
    await assert.rejects(f.runtime.wait('stop-after-yield'),{code:'device_wait_pending'});
    let cancellations=0;
    f.port.cancel=async()=>{cancellations++;return false;};
    await f.runtime.cancel('stop-after-yield',{cancellationId:'stop-offline'});
    assert.equal(cancellations,1);
    assert.equal((await f.runtime.operation('stop-after-yield')).status,'queued');
    f.port.operation=async()=>({status:'unanswered',reason:'aborted',deviceOnline:true});
    const recovered=createDeviceRuntime(f.options);
    assert.equal((await recovered.wait('stop-after-yield')).reason,'aborted');
    assert.equal(f.submissions.length,1);
  }finally{f.db.close();}
});
