import {env} from 'cloudflare:workers';
import {evictDurableObject,runInDurableObject} from 'cloudflare:test';
import {afterEach,describe,expect,it,vi} from 'vitest';
import type {ComputerResult} from '@botspace/contracts';

const bindings=env as unknown as {REAL_COMPUTER:DurableObjectNamespace};
const request=(botId:string,operationId:string,action:object)=>new Request('https://computer/actions',{method:'POST',body:JSON.stringify({botId,operationId,action})});
const stop=(botId:string,processId:string)=>new Request('https://computer/exec/cancel',{method:'POST',body:JSON.stringify({botId,processId})});
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};};
async function flush(instance:{alarm?:()=>void|Promise<void>},storage:DurableObjectStorage) {
  await storage.put('checkpointQuietUntil',0);
  const retry=await storage.get<Record<string,unknown>>('checkpointRetry');
  if(retry) await storage.put('checkpointRetry',{...retry,nextAttemptAt:0});
  await instance.alarm!();
}
afterEach(()=>vi.restoreAllMocks());

function machine() {
  const sessions=new Map<string,ComputerResult>();
  const actions:Array<{operationId:string;action:Record<string,unknown>}>=[];
  let checkpoints=0,starts=0,running=true,bootId='same-boot',capabilities=['execSessions'];
  let poll:((processId:string,yieldMs:number)=>Promise<void>)|undefined;
  const container={get running(){return running;},images:{base:'computer'},start(){starts++;running=true;},async destroy(){running=false;},async setInactivityTimeout(){},getTcpPort(){return {async fetch(input:string,init?:RequestInit){
    const path=new URL(input).pathname;
    if(path==='/health') return Response.json({ok:true,desktop:true,bootId,capabilities});
    if(path==='/checkpoint') {checkpoints++;return new Response('x',{headers:{'Content-Length':'1','X-Content-SHA256':'0'.repeat(64)}});}
    if(path==='/restore') return Response.json({ok:true});
    expect(path).toBe('/actions');
    const body=JSON.parse(String(init?.body)) as {operationId:string;action:Record<string,unknown>};actions.push(body);
    const {operationId,action}=body,processId=String(action.processId??operationId);
    if(action.type==='exec' && !sessions.has(processId)) sessions.set(processId,{operationId:processId,processId,status:'running',output:'started\n'});
    if(action.type==='execPoll') await poll?.(processId,Number(action.yieldMs));
    if(action.type==='execCancel') {
      const current=sessions.get(processId);
      if(!current || current.status==='running') sessions.set(processId,{operationId:processId,processId,status:'cancelled',output:current?.output??'',exitCode:-15});
    }
    return Response.json({...sessions.get(processId)??{status:'completed',output:'files'},operationId});
  }};}};
  return {container,sessions,actions,get checkpoints(){return checkpoints;},get starts(){return starts;},set running(value:boolean){running=value;},set bootId(value:string){bootId=value;},set capabilities(value:string[]){capabilities=value;},set poll(value:typeof poll){poll=value;},
    attach(instance:object){Object.defineProperty(instance,'container',{configurable:true,get:()=>container});Object.defineProperty(instance,'env',{configurable:true,value:{FILES:{async put(_key:string,body:ReadableStream){await new Response(body).arrayBuffer();return {size:1};}}}});}};
}

describe('durable execution sessions',()=>{
  it('keeps maintenance and idle checks independent of completed command output history',async()=>{
    const botId=crypto.randomUUID(),stub=bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId)),vm=machine();
    await runInDurableObject(stub,async(instance,state)=>{
      vm.attach(instance);
      const target=instance as unknown as {hasActiveExecutions():Promise<boolean>;needsExecutionMaintenance():Promise<boolean>};
      for(let i=0;i<100;i++) {
        const processId=`old-${i}`,result={operationId:processId,processId,status:'completed',workspaceChanged:false,output:'archived-output'.repeat(1000)};
        await state.storage.put({[`exec-session:${processId}`]:{digest:'old',bootId:'same-boot',dispatched:true,result,checkpoint:'done'},[`operation:${processId}`]:{digest:'old',processId,result}});
      }
      const original=state.storage.list.bind(state.storage);
      const reads=vi.spyOn(state.storage,'list').mockImplementation(options=>{
        expect(options?.prefix).not.toBe('exec-session:');expect(options?.prefix).not.toBe('operation:');
        return original(options);
      });
      try {
        expect(await target.hasActiveExecutions()).toBe(false);expect(await target.needsExecutionMaintenance()).toBe(false);
        await instance.fetch(request(botId,'active',{type:'exec',command:'live-work',yieldMs:0}));
        expect(await state.storage.get('exec-work:active')).toEqual({status:'running',checkpoint:'pending'});
        expect(await target.hasActiveExecutions()).toBe(true);
        vm.sessions.set('active',{operationId:'active',processId:'active',status:'completed',workspaceChanged:false,output:'recorded result'});
        await instance.fetch(request(botId,'poll-active',{type:'execPoll',processId:'active',yieldMs:0}));
        expect(await target.hasActiveExecutions()).toBe(false);expect(await target.needsExecutionMaintenance()).toBe(false);
        expect(await state.storage.get('exec-work:active')).toBeUndefined();
        expect(await state.storage.get('operation:active')).toMatchObject({result:{status:'completed',output:'recorded result'}});
        await instance.fetch(request(botId,'write-indexed',{type:'writeFile',path:'new.txt',content:'new'}));
        expect(await state.storage.get('operation-work:write-indexed')).toMatchObject({effect:false,checkpoint:{bootId:'same-boot'}});
        await flush(instance,state.storage);
        expect(await state.storage.get('operation-work:write-indexed')).toBeUndefined();
        expect(await state.storage.get('operation:write-indexed')).toMatchObject({result:{checkpointStatus:'saved'}});
      } finally {reads.mockRestore();}
    });
  });

  it('migrates legacy command receipts in bounded uncached pages and preserves active recovery',async()=>{
    const botId=crypto.randomUUID(),stub=bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId)),vm=machine();
    await runInDurableObject(stub,async(instance,state)=>{
      vm.attach(instance);await state.storage.delete('journalIndexesV1');
      for(let i=0;i<70;i++) {
        const processId=`legacy-${i}`,result={operationId:processId,processId,status:'completed',output:'exact legacy output',workspaceChanged:false};
        await state.storage.put({[`exec-session:${processId}`]:{digest:'old',bootId:'same-boot',dispatched:true,result,checkpoint:'done'},[`operation:${processId}`]:{digest:'old',processId,result}});
      }
      const result={operationId:'legacy-active',processId:'legacy-active',status:'running',output:'retained partial'};
      await state.storage.put({'exec-session:legacy-active':{digest:'old',bootId:'same-boot',dispatched:true,result,checkpoint:'pending'},'operation:legacy-active':{digest:'old',processId:'legacy-active',result}});
      const target=instance as unknown as {initializeJournalIndexes():Promise<void>};
      const original=state.storage.list.bind(state.storage),sizes:number[]=[];
      const reads=vi.spyOn(state.storage,'list').mockImplementation(async options=>{
        if(options?.prefix==='exec-session:'||options?.prefix==='operation:'){expect(options.limit).toBe(32);expect(options.noCache).toBe(true);}
        const values=await original(options);sizes.push(values.size);return values;
      });
      try {await target.initializeJournalIndexes();}finally{reads.mockRestore();}
      expect(sizes.filter(size=>size===32).length).toBeGreaterThanOrEqual(4);
      expect(await state.storage.get('journalIndexesV1')).toBe(true);
      expect([...await state.storage.list({prefix:'exec-work:'})].map(([key])=>key)).toEqual(['exec-work:legacy-active']);
      expect(await state.storage.get('operation:legacy-69')).toMatchObject({result:{output:'exact legacy output'}});
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub,async(instance,state)=>{
      vm.attach(instance);
      vm.sessions.set('legacy-active',{operationId:'legacy-active',processId:'legacy-active',status:'completed',workspaceChanged:false,output:'retained partial and completion'});
      const result=await (await instance.fetch(request(botId,'observe-legacy',{type:'execPoll',processId:'legacy-active',yieldMs:0}))).json<ComputerResult>();
      expect(result).toMatchObject({status:'completed',output:'retained partial and completion'});
      expect(vm.actions.some(action=>action.action.type==='exec')).toBe(false);
      expect(await state.storage.get('exec-work:legacy-active')).toBeUndefined();
    });
  });

  it.each(['operations','executions'] as const)('resumes interrupted legacy index migration from its durable %s cursor',async phase=>{
    const botId=crypto.randomUUID(),stub=bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId));
    await runInDurableObject(stub,async(instance,state)=>{
      await state.storage.delete('journalIndexesV1');
      for(let i=0;i<70;i++) {
        const processId=`resume-${String(i).padStart(3,'0')}`,result={operationId:processId,processId,status:i===0?'running':'completed',output:'original receipt',workspaceChanged:false};
        await state.storage.put({[`exec-session:${processId}`]:{digest:'old',bootId:'legacy-boot',dispatched:true,result,checkpoint:i===0?'pending':'done'},[`operation:${processId}`]:{digest:'old',processId,result}});
      }
      const target=instance as unknown as {initializeJournalIndexes():Promise<void>};
      const original=state.storage.put.bind(state.storage);
      let interrupted=false;
      const fail=vi.spyOn(state.storage,'put').mockImplementation(async(...args:Parameters<DurableObjectStorage['put']>)=>{
        await Reflect.apply(original,state.storage,args);
        const input=args[0];
        if(!interrupted&&typeof input==='object'&&input&&'journalIndexMigrationV1' in input) {
          const migration=input.journalIndexMigrationV1 as {phase:string;cursor?:string};
          if(migration.phase===phase&&migration.cursor){interrupted=true;throw new Error('Migration acknowledgement lost after page commit');}
        }
      });
      try {await expect(target.initializeJournalIndexes()).rejects.toThrow('Migration acknowledgement lost');}finally{fail.mockRestore();}
      const cursor=await state.storage.get<{phase:string;cursor:string}>('journalIndexMigrationV1');
      expect(cursor).toEqual({phase,cursor:`${phase==='operations'?'operation:':'exec-session:'}resume-031`});
      expect(await state.storage.get('journalIndexesV1')).toBeUndefined();
      if(phase==='executions')expect(await state.storage.get('exec-work:resume-000')).toEqual({status:'running',checkpoint:'pending'});
      // A retry reads the saved boundary rather than visiting page zero again.
      const list=state.storage.list.bind(state.storage),starts:string[]=[];
      const reads=vi.spyOn(state.storage,'list').mockImplementation(options=>{
        if(options?.prefix===(phase==='operations'?'operation:':'exec-session:'))starts.push(options.startAfter??'');
        return list(options);
      });
      try {await target.initializeJournalIndexes();}finally{reads.mockRestore();}
      expect(starts[0]).toBe(cursor!.cursor);
      expect(await state.storage.get('journalIndexesV1')).toBe(true);
      expect(await state.storage.get('journalIndexMigrationV1')).toBeUndefined();
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub,async(_instance,state)=>{
      expect(await state.storage.get('exec-work:resume-000')).toEqual({status:'running',checkpoint:'pending'});
      expect(await state.storage.get('operation:resume-069')).toMatchObject({result:{output:'original receipt'}});
      expect(await state.storage.get('journalIndexesV1')).toBe(true);
      expect(await state.storage.getAlarm()).toBeGreaterThan(Date.now());
    });
  });

  it('settles read-only commands without checkpoint intent, uploads or a pending-save status',async()=>{
    const botId=crypto.randomUUID(),stub=bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId)),vm=machine();
    await runInDurableObject(stub,async(instance,state)=>{
      vm.attach(instance);
      const port=vm.container.getTcpPort();
      vm.container.getTcpPort=()=>({async fetch(input:string,init?:RequestInit){
        if(new URL(input).pathname==='/actions' && JSON.parse(String(init?.body)).action.type==='exec') {
          expect(await state.storage.getAlarm()).toBeGreaterThan(Date.now());
          expect(await state.storage.get('exec-session:read-only')).toMatchObject({result:{status:'running'}});
        }
        return port.fetch(input,init);
      }});
      const action={type:'exec',command:'cd . && grep label report.txt',yieldMs:0};
      await instance.fetch(request(botId,'read-only',action));
      expect(await state.storage.get('checkpointRetry')).toBeUndefined();
      vm.sessions.set('read-only',{operationId:'read-only',processId:'read-only',status:'completed',exitCode:0,output:'label',workspaceChanged:false});
      const result=await (await instance.fetch(request(botId,'observe',{type:'execPoll',processId:'read-only',yieldMs:0}))).json<ComputerResult>();
      expect(result).toMatchObject({status:'completed',workspaceChanged:false});expect(result.checkpointStatus).toBeUndefined();
      expect(await (await instance.fetch(request(botId,'read-only',action))).json()).toEqual({...result,operationId:'read-only'});
      await flush(instance,state.storage);
      expect(await state.storage.get('checkpointRetry')).toBeUndefined();expect(vm.checkpoints).toBe(0);
      expect(vm.actions.filter(value=>value.action.type==='exec')).toHaveLength(1);
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub,async(instance,state)=>{
      vm.attach(instance);
      const result=await (await instance.fetch(request(botId,'after-recovery',{type:'execPoll',processId:'read-only',yieldMs:0}))).json<ComputerResult>();
      expect(result).toMatchObject({status:'completed',workspaceChanged:false});expect(result.checkpointStatus).toBeUndefined();
      expect(await state.storage.get('checkpointRetry')).toBeUndefined();expect(vm.checkpoints).toBe(0);
    });
  });

  it.each([true,undefined])('persists changed or unknown commands before exposing a terminal result (%s)',async workspaceChanged=>{
    const botId=crypto.randomUUID(),stub=bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId)),vm=machine();
    await runInDurableObject(stub,async(instance,state)=>{
      vm.attach(instance);await instance.fetch(request(botId,'writer',{type:'exec',command:'printf x > report.txt',yieldMs:0}));
      vm.sessions.set('writer',{operationId:'writer',processId:'writer',status:'failed',exitCode:1,workspaceChanged,output:'wrote before failure'});
      expect(await (await instance.fetch(request(botId,'observe',{type:'execPoll',processId:'writer',yieldMs:0}))).json()).toMatchObject({status:'failed',checkpointStatus:'pending'});
      expect(await state.storage.get('operation:writer')).toMatchObject({checkpoint:{bootId:'same-boot'},result:{status:'failed',checkpointStatus:'pending'}});
      await flush(instance,state.storage);expect(vm.checkpoints).toBe(1);
    });
  });

  it('a read-only command does not clear pending changes from an earlier write',async()=>{
    const botId=crypto.randomUUID(),stub=bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId)),vm=machine();
    await runInDurableObject(stub,async(instance,state)=>{
      vm.attach(instance);await instance.fetch(request(botId,'write',{type:'writeFile',path:'report.txt',content:'label'}));
      const retry=await state.storage.get('checkpointRetry');expect(retry).toBeTruthy();
      await instance.fetch(request(botId,'read',{type:'exec',command:'cat report.txt',yieldMs:0}));
      vm.sessions.set('read',{operationId:'read',processId:'read',status:'completed',workspaceChanged:false,output:'label'});
      const result=await (await instance.fetch(request(botId,'observe',{type:'execPoll',processId:'read',yieldMs:0}))).json<ComputerResult>();
      expect(result.checkpointStatus).toBeUndefined();expect(await state.storage.get('checkpointRetry')).toEqual(retry);
      await flush(instance,state.storage);expect(vm.checkpoints).toBe(1);
      expect(await state.storage.get('operation:write')).toMatchObject({result:{checkpointStatus:'saved'}});
      expect(await state.storage.get('operation:read')).toMatchObject({result:{workspaceChanged:false}});
      expect((await state.storage.get<{result:ComputerResult}>('operation:read'))!.result.checkpointStatus).toBeUndefined();
    });
  });

  it('omits the execution deadline, excludes yield from deduplication, and accepts explicit deadlines above 120 seconds',async()=>{
    const botId=crypto.randomUUID(),stub=bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId)),vm=machine();
    await runInDurableObject(stub,async(instance,state)=>{
      vm.attach(instance);
      const action={type:'exec',command:'long-running-command',yieldMs:0};
      expect(await (await instance.fetch(request(botId,'long',action))).json()).toMatchObject({operationId:'long',processId:'long',status:'running',output:'started\n'});
      expect(vm.actions[0]!.action).toEqual(action);
      expect(vm.actions[0]!.action).not.toHaveProperty('timeoutMs');
      await instance.fetch(request(botId,'long',{...action,yieldMs:10}));
      expect(vm.actions.filter(value=>value.action.type==='exec')).toHaveLength(1);
      const conflict=await (await instance.fetch(request(botId,'long',{...action,command:'different'}))).json<ComputerResult>();
      expect(conflict).toMatchObject({status:'failed',error:expect.stringContaining('different arguments')});
      await instance.fetch(request(botId,'explicit',{type:'exec',command:'also-long',timeoutMs:9_000_000,yieldMs:0}));
      expect(vm.actions.find(value=>value.operationId==='explicit' && value.action.type==='exec')!.action.timeoutMs).toBe(9_000_000);
      expect(vm.checkpoints).toBe(0);
      expect(await state.storage.getAlarm()).toBeGreaterThan(Date.now());
      const suspend=await instance.fetch(new Request('https://computer/suspend',{method:'POST',body:JSON.stringify({botId})}));
      expect(suspend.status).toBe(409);
      expect(await suspend.json()).toMatchObject({error:{code:'computer_execution_active'}});
    });
  });

  it('lets other actions and Stop proceed while a poll waits, and ignores a late running snapshot',async()=>{
    const botId=crypto.randomUUID(),stub=bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId)),vm=machine();
    await runInDurableObject(stub,async instance=>{
      vm.attach(instance);
      await instance.fetch(request(botId,'running',{type:'exec',command:'sleep forever',yieldMs:0}));
      const waiting=deferred(),release=deferred();
      vm.poll=async(_id,yieldMs)=>{if(yieldMs){waiting.resolve();await release.promise;}};
      const pending=instance.fetch(request(botId,'poll',{type:'execPoll',processId:'running',yieldMs:30_000}));
      await waiting.promise;
      const files=await instance.fetch(request(botId,'files',{type:'listFiles'}));
      expect(files.status).toBe(200);
      const cancelled=await (await instance.fetch(stop(botId,'running'))).json<ComputerResult>();
      expect(cancelled).toMatchObject({status:'cancelled',processId:'running'});
      const control=vm.actions.find(value=>value.action.type==='execCancel')!;
      expect(control.operationId).toMatch(/^exec-cancel:[a-f0-9]{64}$/);
      // The delayed server request can have captured its earlier running state.
      vm.sessions.set('running',{operationId:'running',processId:'running',status:'running',output:'old'});
      release.resolve();
      expect(await (await pending).json()).toMatchObject({status:'cancelled',output:'started\n'});
      expect(vm.checkpoints).toBe(0);
    });
  });

  it('persists a Stop tombstone before startup without starting a computer',async()=>{
    const botId=crypto.randomUUID(),stub=bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId)),vm=machine();vm.running=false;
    await runInDurableObject(stub,async(instance,state)=>{
      vm.attach(instance);
      expect(await (await instance.fetch(stop(botId,'not-started'))).json()).toMatchObject({status:'cancelled',processId:'not-started'});
      expect(await (await instance.fetch(request(botId,'not-started',{type:'exec',command:'must never run'}))).json()).toMatchObject({status:'cancelled'});
      expect(await state.storage.get('exec-cancelled:not-started')).toMatchObject({operationId:'not-started',journal:false});
      expect(vm.starts).toBe(0);expect(vm.actions).toHaveLength(0);
    });
    await evictDurableObject(stub);
    const response=await stub.fetch(request(botId,'not-started',{type:'exec',command:'must never run'}));
    expect(await response.json()).toMatchObject({status:'cancelled'});
  });

  it('requires the new image capability before journaling or dispatching a command',async()=>{
    vi.spyOn(console,'error').mockImplementation(()=>{});
    const botId=crypto.randomUUID(),stub=bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId)),vm=machine();vm.capabilities=[];
    await runInDurableObject(stub,async(instance,state)=>{
      vm.attach(instance);
      const response=await instance.fetch(request(botId,'old-image',{type:'exec',command:'never run'}));
      expect(response.status).toBe(409);expect(await response.json()).toMatchObject({error:{code:'computer_upgrade_required'}});
      expect(await state.storage.get('operation:old-image')).toBeUndefined();
      expect(vm.actions).toHaveLength(0);
    });
  });

  it('fences a start whose computer startup was already awaiting health when Stop arrived',async()=>{
    const botId=crypto.randomUUID(),stub=bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId)),vm=machine();
    await runInDurableObject(stub,async instance=>{
      vm.attach(instance);
      const entered=deferred(),release=deferred(),port=vm.container.getTcpPort();
      vm.container.getTcpPort=()=>({async fetch(input:string,init?:RequestInit){if(new URL(input).pathname==='/health'){entered.resolve();await release.promise;}return port.fetch(input,init);}});
      const starting=instance.fetch(request(botId,'racing-start',{type:'exec',command:'never execute',yieldMs:0}));
      await entered.promise;
      expect(await (await instance.fetch(stop(botId,'racing-start'))).json()).toMatchObject({status:'cancelled'});
      release.resolve();
      expect(await (await starting).json()).toMatchObject({status:'cancelled'});
      expect(vm.actions).toHaveLength(0);
    });
  });

  it('rejects cancellation from another bot before storing a tombstone or signalling a process',async()=>{
    vi.spyOn(console,'error').mockImplementation(()=>{});
    const botId=crypto.randomUUID(),stub=bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId)),vm=machine();
    await runInDurableObject(stub,async(instance,state)=>{
      vm.attach(instance);await instance.fetch(request(botId,'owned',{type:'exec',command:'long',yieldMs:0}));
      expect((await instance.fetch(stop(crypto.randomUUID(),'owned'))).status).toBe(403);
      expect(await state.storage.get('exec-cancelled:owned')).toBeUndefined();
      expect(vm.actions.filter(value=>value.action.type==='execCancel')).toHaveLength(0);
    });
  });

  it.each([true,false])('recovers checkpoint attempt once when its durable pointer exists=%s',async saved=>{
    const botId=crypto.randomUUID(),stub=bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId));
    await runInDurableObject(stub,async(_instance,state)=>{
      await state.storage.delete('journalIndexesV1');
      const result={operationId:'checkpoint-recovery',processId:'checkpoint-recovery',status:'completed',output:'known exit',exitCode:0};
      await state.storage.put({'operation:checkpoint-recovery':{digest:'known',processId:'checkpoint-recovery',result},
        'exec-session:checkpoint-recovery':{digest:'known',bootId:'previous',dispatched:true,result,checkpoint:'attempting',checkpointAttemptId:'attempt-once'},
        ...(saved?{lastCheckpoint:{id:'attempt-once',key:'already-persisted'}}:{})});
    });
    await evictDurableObject(stub);
    // There is no container: an accidental second checkpoint attempt would fail.
    const result=await (await stub.fetch(request(botId,'read-recovered',{type:'execPoll',processId:'checkpoint-recovery'}))).json<ComputerResult>();
    expect(result).toMatchObject({status:'completed',output:'known exit',exitCode:0});
    if(saved) expect(result.checkpointId).toBe('attempt-once');
    else expect(result.error).toContain('could not be confirmed after recovery');
    await runInDurableObject(stub,async(_instance,state)=>{
      expect(await state.storage.get('exec-session:checkpoint-recovery')).toMatchObject({checkpoint:'done'});
      expect(await state.storage.get('operation:checkpoint-recovery')).toMatchObject({result:{...result,operationId:'checkpoint-recovery'}});
    });
  });

  it('recovers the same process after DO eviction and checkpoints a terminal outcome only once',async()=>{
    const botId=crypto.randomUUID(),stub=bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId)),vm=machine();
    await runInDurableObject(stub,async instance=>{vm.attach(instance);await instance.fetch(request(botId,'recover',{type:'exec',command:'one effect',yieldMs:0}));});
    await evictDurableObject(stub);
    await runInDurableObject(stub,async(instance,state)=>{
      vm.attach(instance);
      vm.sessions.set('recover',{operationId:'recover',processId:'recover',status:'completed',output:'final output',exitCode:0});
      const result=await (await instance.fetch(request(botId,'recover',{type:'exec',command:'one effect',yieldMs:0}))).json<ComputerResult>();
      expect(result).toMatchObject({status:'completed',output:'final output',exitCode:0,checkpointStatus:'pending'});
      expect(await (await instance.fetch(request(botId,'another-poll',{type:'execPoll',processId:'recover'}))).json()).toEqual({...result,operationId:'another-poll'});
      expect(vm.checkpoints).toBe(0);
      await flush(instance,state.storage);
      expect(vm.actions.filter(value=>value.action.type==='exec')).toHaveLength(1);expect(vm.checkpoints).toBe(1);
      expect(await state.storage.get('operation:recover')).toMatchObject({result:{...result,checkpointStatus:'saved',checkpointId:expect.any(String)}});
    });
  });

  it.each(['stopped','replaced','server-restarted'] as const)('never relaunches an execution after the computer is %s',async kind=>{
    const botId=crypto.randomUUID(),stub=bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId)),vm=machine();
    await runInDurableObject(stub,async instance=>{
      vm.attach(instance);await instance.fetch(request(botId,'lost',{type:'exec',command:'one effect',yieldMs:0}));
      if(kind==='stopped') vm.running=false;
      else if(kind==='replaced') vm.bootId='different-boot';
      else vm.sessions.set('lost',{operationId:'lost',processId:'lost',status:'interrupted',output:'before restart',error:'Execution interrupted by server restart'});
      expect(await (await instance.fetch(request(botId,'lost',{type:'exec',command:'one effect',yieldMs:0}))).json()).toMatchObject({status:'interrupted',processId:'lost'});
      expect(vm.starts).toBe(0);expect(vm.actions.filter(value=>value.action.type==='exec')).toHaveLength(1);
    });
  });

  it('defers checkpoints until all simultaneous commands finish and checkpoints the batch once',async()=>{
    const botId=crypto.randomUUID(),stub=bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId)),vm=machine();
    await runInDurableObject(stub,async(instance,state)=>{
      vm.attach(instance);
      for(const id of ['first','second']) await instance.fetch(request(botId,id,{type:'exec',command:id,yieldMs:0}));
      vm.sessions.set('first',{operationId:'first',processId:'first',status:'completed',output:'first',exitCode:0});
      const first=await (await instance.fetch(request(botId,'poll-first',{type:'execPoll',processId:'first',yieldMs:0}))).json<ComputerResult>();
      expect(first.status).toBe('completed');expect(first.checkpointId).toBeUndefined();expect(first.checkpointStatus).toBe('pending');expect(first.error).toBeUndefined();expect(vm.checkpoints).toBe(0);
      vm.sessions.set('second',{operationId:'second',processId:'second',status:'completed',output:'second',exitCode:0});
      const second=await (await instance.fetch(request(botId,'poll-second',{type:'execPoll',processId:'second',yieldMs:0}))).json<ComputerResult>();
      expect(second.checkpointStatus).toBe('pending');expect(vm.checkpoints).toBe(0);
      await flush(instance,state.storage);
      const secondSaved=await (await instance.fetch(request(botId,'poll-second-final',{type:'execPoll',processId:'second',yieldMs:0}))).json<ComputerResult>();
      const firstSaved=await (await instance.fetch(request(botId,'poll-first-final',{type:'execPoll',processId:'first',yieldMs:0}))).json<ComputerResult>();
      expect(secondSaved.checkpointId).toBeTruthy();expect(firstSaved.checkpointId).toBe(secondSaved.checkpointId);expect(firstSaved.error).toBeUndefined();expect(vm.checkpoints).toBe(1);
    });
  });

  it('keeps running sessions alive through maintenance alarms and persists their final result',async()=>{
    const botId=crypto.randomUUID(),stub=bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId)),vm=machine();
    await runInDurableObject(stub,async(instance,state)=>{
      vm.attach(instance);await instance.fetch(request(botId,'alarm-process',{type:'exec',command:'long',yieldMs:0}));
      await state.storage.put('lastActivity',Date.now()-1_000_000);
      await instance.alarm!();
      expect(vm.container.running).toBe(true);expect(vm.checkpoints).toBe(0);
      expect(await state.storage.getAlarm()).toBeGreaterThan(Date.now());
      vm.sessions.set('alarm-process',{operationId:'alarm-process',processId:'alarm-process',status:'completed',output:'done',exitCode:0});
      await instance.alarm!();
      expect(await state.storage.get('operation:alarm-process')).toMatchObject({result:{status:'completed',checkpointStatus:'pending'}});
      expect(vm.checkpoints).toBe(0);
      await flush(instance,state.storage);
      expect(await state.storage.get('operation:alarm-process')).toMatchObject({result:{status:'completed',checkpointId:expect.any(String)}});
      expect(vm.checkpoints).toBe(1);expect(vm.container.running).toBe(true);
    });
  });

  it('deduplicates cancel control operations and rejects changed targets',async()=>{
    const botId=crypto.randomUUID(),stub=bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId)),vm=machine();
    await runInDurableObject(stub,async instance=>{
      vm.attach(instance);await instance.fetch(request(botId,'process',{type:'exec',command:'long',yieldMs:0}));
      const action={type:'execCancel',processId:'process'};
      const first=await (await instance.fetch(request(botId,'cancel-id',action))).json();
      expect(await (await instance.fetch(request(botId,'cancel-id',action))).json()).toEqual(first);
      expect(vm.actions.filter(value=>value.action.type==='execCancel')).toHaveLength(1);
      const conflict=await instance.fetch(request(botId,'cancel-id',{...action,processId:'other'}));expect(conflict.status).toBe(409);expect(await conflict.json()).toMatchObject({error:{code:'computer_idempotency_conflict'}});
    });
  });

  it('recovers an admitted cancellation after eviction before its request reached the process',async()=>{
    vi.spyOn(console,'error').mockImplementation(()=>{});
    const botId=crypto.randomUUID(),stub=bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId)),vm=machine();
    await runInDurableObject(stub,async(instance,state)=>{
      vm.attach(instance);await instance.fetch(request(botId,'cancel-recover',{type:'exec',command:'long',yieldMs:0}));
      const port=vm.container.getTcpPort();let fault=true;
      vm.container.getTcpPort=()=>({async fetch(input:string,init?:RequestInit){
        if(new URL(input).pathname==='/actions' && JSON.parse(String(init?.body)).action.type==='execCancel' && fault){fault=false;throw new Error('Transient transport failure');}
        return port.fetch(input,init);
      }});
      expect((await instance.fetch(stop(botId,'cancel-recover'))).status).toBe(503);
      expect(await state.storage.get('exec-cancelled:cancel-recover')).toMatchObject({operationId:'cancel-recover',journal:false});
      expect(vm.sessions.get('cancel-recover')!.status).toBe('running');
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub,async(instance,state)=>{
      vm.attach(instance);await instance.alarm!();await flush(instance,state.storage);
      expect(vm.sessions.get('cancel-recover')!.status).toBe('cancelled');
      expect(await state.storage.get('operation:cancel-recover')).toMatchObject({result:{status:'cancelled',checkpointId:expect.any(String)}});
      expect(vm.actions.filter(value=>value.action.type==='exec')).toHaveLength(1);
      expect(vm.actions.filter(value=>value.action.type==='execCancel')).toHaveLength(1);
    });
  });

  it('does not retry a cancellation that the native journal definitively rejected',async()=>{
    vi.spyOn(console,'error').mockImplementation(()=>{});
    const botId=crypto.randomUUID(),stub=bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId)),vm=machine();
    await runInDurableObject(stub,async(instance,state)=>{
      vm.attach(instance);await instance.fetch(request(botId,'keep-running',{type:'exec',command:'long',yieldMs:0}));
      const port=vm.container.getTcpPort();let rejected=0;
      vm.container.getTcpPort=()=>({async fetch(input:string,init?:RequestInit){
        if(new URL(input).pathname==='/actions' && JSON.parse(String(init?.body)).action.type==='execCancel'){rejected++;return Response.json({error:{code:'computer_idempotency_conflict'}},{status:409});}
        return port.fetch(input,init);
      }});
      const cancel=()=>instance.fetch(request(botId,'native-conflict',{type:'execCancel',processId:'keep-running'}));
      expect((await cancel()).status).toBe(409);
      expect(await state.storage.get('exec-cancelled:keep-running')).toBeUndefined();
      await instance.alarm!();
      expect((await cancel()).status).toBe(409);
      expect(rejected).toBe(1);expect(vm.sessions.get('keep-running')!.status).toBe('running');
    });
  });

  it('persists and recovers the complete 128 KiB native output including Unicode',async()=>{
    const botId=crypto.randomUUID(),stub=bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId)),vm=machine();
    const nativeOutput='prefix: '+('😀'.repeat(32766));
    expect(new TextEncoder().encode(nativeOutput).byteLength).toBe(128*1024);
    let output:string|undefined;
    await runInDurableObject(stub,async instance=>{
      vm.attach(instance);
      vm.sessions.set('large-output',{operationId:'large-output',processId:'large-output',status:'completed',output:nativeOutput,exitCode:0});
      const response=await instance.fetch(request(botId,'large-output',{type:'exec',command:'write lots of output',yieldMs:0}));
      expect(response.status).toBe(200);
      const result=await response.json<ComputerResult>();output=result.output;
      expect(result).toMatchObject({status:'completed',checkpointStatus:'pending'});
      expect(output).toBe(nativeOutput);expect(output).not.toContain('\ufffd');
      expect(new TextEncoder().encode(output).byteLength).toBe(128*1024);
    });
    await evictDurableObject(stub);
    const response=await stub.fetch(request(botId,'recover-large-output',{type:'execPoll',processId:'large-output'}));
    expect(response.status).toBe(200);expect(await response.json()).toMatchObject({status:'completed',output,checkpointStatus:'pending'});
    expect(vm.actions.filter(value=>value.action.type==='exec')).toHaveLength(1);
  });
});
