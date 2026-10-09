import {env} from 'cloudflare:workers';
import {evictDurableObject,runInDurableObject} from 'cloudflare:test';
import {afterEach,describe,expect,it,vi} from 'vitest';
import type {ComputerResult} from '@botspace/contracts';

const bindings=env as unknown as {REAL_COMPUTER:DurableObjectNamespace;FILES:R2Bucket};
const request=(botId:string,operationId:string,action:object)=>new Request('https://computer/actions',{method:'POST',body:JSON.stringify({botId,operationId,action})});
const post=(botId:string,path:string)=>new Request(`https://computer${path}`,{method:'POST',body:JSON.stringify({botId})});
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};};
const hash=async(bytes:Uint8Array)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),byte=>byte.toString(16).padStart(2,'0')).join('');
afterEach(()=>vi.restoreAllMocks());

function computer() {
  const state={effects:0,archives:0,uploads:0,heads:0,failUploads:0,bootId:'boot',running:true,destroys:0,restore:0,contents:'saved workspace',commandError:undefined as string|undefined};
  const files={async put(key:string,value:ReadableStream,options:R2PutOptions){state.uploads++;if(state.failUploads>0){state.failUploads--;throw new Error('network failure private-detail');}return bindings.FILES.put(key,value,options);},async head(key:string){state.heads++;return bindings.FILES.head(key);},get:(key:string)=>bindings.FILES.get(key)};
  const container={get running(){return state.running;},async setInactivityTimeout(){},async destroy(){state.destroys++;state.running=false;},getTcpPort(){return {async fetch(input:string,init?:RequestInit){
    const path=new URL(input).pathname;
    if(path==='/health') return Response.json({ok:true,bootId:state.bootId,desktop:true,capabilities:['execSessions']});
    if(path==='/actions') {state.effects++;return Response.json({status:state.commandError?'failed':'completed',exitCode:state.commandError?1:0,output:'command output',error:state.commandError});}
    if(path==='/restore') {state.restore++;await new Response(init?.body).arrayBuffer();return Response.json({ok:true});}
    expect(path).toBe('/checkpoint');state.archives++;
    const bytes=new TextEncoder().encode(state.contents);
    // Deliberately unknown stream length, even with a valid HTTP length header.
    const body=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(bytes.subarray(0,3));controller.enqueue(bytes.subarray(3));controller.close();}});
    return new Response(body,{headers:{'Content-Length':String(bytes.byteLength),'X-Content-SHA256':await hash(bytes),'Content-Type':'application/gzip'}});
  }};}};
  return {state,files,container,attach(instance:object){Object.defineProperty(instance,'container',{configurable:true,get:()=>container});Object.defineProperty(instance,'env',{configurable:true,value:{FILES:files}});}};
}

async function due(storage:DurableObjectStorage){const retry=await storage.get<Record<string,unknown>>('checkpointRetry');expect(retry).toBeTruthy();await storage.put('checkpointRetry',{...retry,nextAttemptAt:Date.now()-1});}

function failPointer(storage:DurableObjectStorage,enabled:()=>boolean) {
  const original=storage.transaction.bind(storage);
  return vi.spyOn(storage,'transaction').mockImplementation(callback=>original(txn=>callback(new Proxy(txn,{get(target,key){
    if(key==='put') return (entry:string|Record<string,unknown>,value?:unknown)=>{
      if(entry==='lastCheckpoint' && enabled()) throw new Error('private metadata failure');
      return typeof entry==='string'?target.put(entry,value):target.put(entry);
    };
    const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }}))));
}

describe('checkpoint upload and durable recovery',()=>{
  it('uploads an unknown-length response stream through real R2 with byte and SHA verification',async()=>{
    const bytes=new TextEncoder().encode('native stream'),body=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(bytes);controller.close();}});
    await expect(bindings.FILES.put(`repro/${crypto.randomUUID()}`,body)).rejects.toThrow('known length');
    const botId=crypto.randomUUID(),stub=bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId)),vm=computer();
    await runInDurableObject(stub,async(instance,state)=>{
      vm.attach(instance);
      const result=await (await instance.fetch(request(botId,'capture',{type:'checkpoint'}))).json<ComputerResult>();
      expect(result).toMatchObject({status:'completed',checkpointStatus:'saved'});expect(result.error).toBeUndefined();
      const checkpoint=await state.storage.get<{key:string}>('lastCheckpoint');
      expect(await (await bindings.FILES.get(checkpoint!.key))!.text()).toBe(vm.state.contents);
      expect(await state.storage.get('checkpointRetry')).toBeUndefined();expect(vm.state.uploads).toBe(1);
    });
  });

  it('recovers one transient upload failure without a warning or repeating the command',async()=>{
    const log=vi.spyOn(console,'error').mockImplementation(()=>{});
    const botId=crypto.randomUUID(),stub=bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId)),vm=computer();vm.state.failUploads=1;
    await runInDurableObject(stub,async instance=>{
      vm.attach(instance);
      const result=await (await instance.fetch(request(botId,'one-command',{type:'exec',command:'create files',yieldMs:0}))).json<ComputerResult>();
      expect(result).toMatchObject({status:'completed',checkpointStatus:'saved',checkpointId:expect.any(String)});expect(result.error).toBeUndefined();
      expect(vm.state.effects).toBe(1);expect(vm.state.archives).toBe(2);expect(vm.state.uploads).toBe(2);
      expect(log).toHaveBeenCalledWith('computer.checkpoint_failure',{phase:'archive_upload',cause:'transport'});
      expect(JSON.stringify(log.mock.calls)).not.toContain('private-detail');
    });
  });

  it('persists retries across eviction, escalates continuing failure, and clears only the checkpoint warning on success',async()=>{
    vi.spyOn(console,'error').mockImplementation(()=>{});
    const botId=crypto.randomUUID(),stub=bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId)),vm=computer();vm.state.failUploads=100;vm.state.commandError='Command exited with its original failure';
    await runInDurableObject(stub,async(instance,state)=>{
      vm.attach(instance);
      const result=await (await instance.fetch(request(botId,'failed-command',{type:'exec',command:'write then fail',yieldMs:0}))).json<ComputerResult>();
      expect(result).toMatchObject({status:'failed',checkpointStatus:'pending',error:vm.state.commandError});
      const retry=await state.storage.get<{nextAttemptAt:number}>('checkpointRetry');
      await instance.fetch(post(botId,'/touch'));
      expect(await state.storage.getAlarm()).toBeLessThanOrEqual(retry!.nextAttemptAt);
      await due(state.storage);await instance.alarm!();
      const escalated=await (await instance.fetch(request(botId,'observe-failure',{type:'execPoll',processId:'failed-command',yieldMs:0}))).json<ComputerResult>();
      expect(escalated.checkpointStatus).toBe('pending');expect(escalated.error).toContain('could not be saved durably');expect(escalated.error).toContain(vm.state.commandError!);
      expect(vm.state.effects).toBe(1);
    });
    await evictDurableObject(stub);
    vm.state.failUploads=0;
    await runInDurableObject(stub,async(instance,state)=>{
      vm.attach(instance);await due(state.storage);await instance.alarm!();
      const recovered=await (await instance.fetch(request(botId,'observe-saved',{type:'execPoll',processId:'failed-command',yieldMs:0}))).json<ComputerResult>();
      expect(recovered).toMatchObject({status:'failed',checkpointStatus:'saved',checkpointId:expect.any(String),error:vm.state.commandError});
      expect(await state.storage.get('checkpointRetry')).toBeUndefined();expect(vm.state.effects).toBe(1);
    });
  });

  it('recovers a committed R2 object after pointer-write failure and eviction without uploading again',async()=>{
    const log=vi.spyOn(console,'error').mockImplementation(()=>{});
    const botId=crypto.randomUUID(),stub=bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId)),vm=computer();let candidateId:string|undefined;
    await runInDurableObject(stub,async(instance,state)=>{
      vm.attach(instance);const fault=failPointer(state.storage,()=>true);
      const result=await (await instance.fetch(request(botId,'pointer-window',{type:'exec',command:'one effect',yieldMs:0}))).json<ComputerResult>();
      expect(result).toMatchObject({status:'completed',checkpointStatus:'pending'});expect(result.error).toBeUndefined();
      candidateId=(await state.storage.get<{candidate:{id:string}}>('checkpointRetry'))!.candidate.id;
      expect(vm.state.archives).toBe(1);expect(vm.state.uploads).toBe(1);expect(await state.storage.get('lastCheckpoint')).toBeUndefined();
      expect(log).toHaveBeenCalledWith('computer.checkpoint_failure',{phase:'pointer_publish',cause:'metadata_write'});
      expect(JSON.stringify(log.mock.calls)).not.toContain('private metadata');fault.mockRestore();
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub,async(instance,state)=>{
      vm.attach(instance);await due(state.storage);await instance.alarm!();
      expect(await state.storage.get('lastCheckpoint')).toMatchObject({id:candidateId});
      expect(await state.storage.get('operation:pointer-window')).toMatchObject({result:{checkpointId:candidateId,checkpointStatus:'saved'}});
      expect(await state.storage.get('checkpointRetry')).toBeUndefined();
      expect(vm.state.archives).toBe(1);expect(vm.state.uploads).toBe(1);expect(vm.state.effects).toBe(1);
    });
  });

  it('reconciles an earlier ordinary write when an unrelated later snapshot succeeds',async()=>{
    vi.spyOn(console,'error').mockImplementation(()=>{});
    const botId=crypto.randomUUID(),stub=bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId)),vm=computer();vm.state.failUploads=100;
    const action={type:'writeFile',path:'notes.txt',content:'hello'};
    await runInDurableObject(stub,async instance=>{
      vm.attach(instance);
      expect(await (await instance.fetch(request(botId,'ordinary-write',action))).json()).toMatchObject({status:'completed',checkpointStatus:'pending'});
      vm.state.failUploads=0;
      const saved=await (await instance.fetch(request(botId,'unrelated-snapshot',{type:'checkpoint'}))).json<ComputerResult>();
      const previous=await (await instance.fetch(request(botId,'ordinary-write',action))).json<ComputerResult>();
      expect(previous).toMatchObject({status:'completed',checkpointStatus:'saved',checkpointId:saved.checkpointId});expect(previous.error).toBeUndefined();expect(vm.state.effects).toBe(1);
    });
  });

  it('captures fresh desktop changes before suspend even when an older upload can be recovered',async()=>{
    vi.spyOn(console,'error').mockImplementation(()=>{});
    const botId=crypto.randomUUID(),stub=bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId)),vm=computer();
    await runInDurableObject(stub,async(instance,state)=>{
      vm.attach(instance);const fault=failPointer(state.storage,()=>true);
      await instance.fetch(request(botId,'old-snapshot',{type:'writeFile',path:'file',content:'old'}));fault.mockRestore();
      const old=(await state.storage.get<{candidate:{id:string}}>('checkpointRetry'))!.candidate.id;
      vm.state.contents='new desktop data without any tool revision';
      expect((await instance.fetch(post(botId,'/suspend'))).status).toBe(200);
      const latest=await state.storage.get<{id:string;key:string}>('lastCheckpoint');
      expect(latest!.id).not.toBe(old);expect(await (await bindings.FILES.get(latest!.key))!.text()).toBe(vm.state.contents);
      expect(vm.state.archives).toBe(2);expect(vm.state.destroys).toBe(1);
    });
  });

  it('reports lost uncheckpointed files if the computer was replaced without replaying its action',async()=>{
    vi.spyOn(console,'error').mockImplementation(()=>{});
    const botId=crypto.randomUUID(),stub=bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId)),vm=computer();vm.state.failUploads=100;
    await runInDurableObject(stub,async(instance,state)=>{
      vm.attach(instance);await instance.fetch(request(botId,'lost-work',{type:'exec',command:'one effect',yieldMs:0}));
      vm.state.bootId='replacement';vm.state.failUploads=0;
      await due(state.storage);await instance.alarm!();
      const result=await (await instance.fetch(request(botId,'observe-loss',{type:'execPoll',processId:'lost-work',yieldMs:0}))).json<ComputerResult>();
      expect(result).toMatchObject({status:'completed',checkpointStatus:'failed',error:expect.stringContaining('restarted before')});expect(result.checkpointId).toBeUndefined();
      expect(vm.state.effects).toBe(1);expect(vm.state.restore).toBe(0);expect(vm.state.uploads).toBe(2);
    });
  });

  it('drains an in-flight R2 write before deletion even when its source stream already failed',async()=>{
    vi.spyOn(console,'error').mockImplementation(()=>{});
    const botId=crypto.randomUUID(),stub=bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId)),vm=computer();
    await runInDurableObject(stub,async(instance,state)=>{
      vm.attach(instance);const entered=deferred(),release=deferred(),port=vm.container.getTcpPort();let deleted=false;
      vm.container.getTcpPort=()=>({async fetch(input:string,init?:RequestInit){
        if(new URL(input).pathname==='/checkpoint') return new Response(new ReadableStream({start(controller){controller.error(new Error('source failed'));}}),{headers:{'Content-Length':'10','X-Content-SHA256':'0'.repeat(64)}});
        return port.fetch(input,init);
      }});
      vm.files.put=async key=>{entered.resolve();await release.promise;return (await bindings.FILES.put(key,'late write'))!;};
      const action=instance.fetch(request(botId,'upload-before-delete',{type:'checkpoint'}));await entered.promise;
      const deletion=Promise.resolve(instance.fetch(post(botId,'/delete'))).then(response=>{deleted=true;return response;});
      await new Promise(resolve=>setTimeout(resolve,10));expect(deleted).toBe(false);
      release.resolve();expect((await deletion).status).toBe(200);expect((await action).status).toBe(410);
      expect(await state.storage.list()).toEqual(new Map([['deleted',botId]]));
      const objects=await bindings.FILES.list({prefix:`bots/${botId}/`});expect(objects.objects).toHaveLength(1);
      await bindings.FILES.delete(objects.objects.map(object=>object.key));
      expect((await bindings.FILES.list({prefix:`bots/${botId}/`})).objects).toHaveLength(0);
    });
  });
});
