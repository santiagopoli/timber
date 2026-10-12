import {env,exports} from 'cloudflare:workers';
import {runInDurableObject,evictDurableObject} from 'cloudflare:test';
import {describe,expect,it} from 'vitest';
import type {Bot,Task,SecureInputRequest,Message,Run} from '@botspace/contracts';
import type {Env} from '../apps/api/src/env';
import type {OwnerKeychainCoordinator} from '../apps/api/src/owner-keychain';
const bindings=env as unknown as Env,headers={authorization:'Bearer test-only-botspace-owner-token-000000','content-type':'application/json'};
const api=async(path:string,method='GET',body?:unknown)=>{const r=await exports.default.fetch(`https://timber.test/v1${path}`,{method,headers,...(body===undefined?{}:{body:JSON.stringify(body)})});return new Response(await r.text(),{status:r.status,headers:r.headers});};
const owner=()=>bindings.WORKSPACE.get(bindings.WORKSPACE.idFromName('owner'));
const taskStub=(id:string)=>bindings.BOT.get(bindings.BOT.idFromName(`owner:task:${id}`));
async function bot(){return (await (await api('/bots','POST',{name:'Shared chat parity'})).json<{bot:Bot}>()).bot;}
async function task(b:Bot,description='fixture:secret',startImmediately=true){const r=await api('/tasks','POST',{operationId:crypto.randomUUID(),botId:b.id,title:'Parity',description,startImmediately});expect(r.status).toBe(201);return (await r.json<{task:Task}>()).task;}
async function secure(t:Task){for(let i=0;i<100;i++){const r=await api(`/tasks/${t.id}/keychain`);expect(r.status).toBe(200);const value=await r.json<{requests:SecureInputRequest[]}>();if(value.requests.length)return value.requests[0];await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('Task secure request absent');}
describe('shared task conversation backend controls',()=>{
  it('routes secure input to the exact task after eviction, without entering the ordinary bot transcript',async()=>{
    const b=await bot(),t=await task(b),request=await secure(t);expect(request.taskId).toBe(t.id);expect(request.botId).toBe(b.id);
    expect((await (await api(`/bots/${b.id}/keychain`)).json<{requests:SecureInputRequest[]}>()).requests.some(item=>item.id===request.id)).toBe(false);
    await evictDurableObject(taskStub(t.id));
    const input={requestId:request.id,operationId:crypto.randomUUID(),entries:[{value:'private-task-fixture'}]};
    expect((await api(`/tasks/${t.id}/keychain`,'POST',input)).status).toBe(200);
    expect((await api(`/tasks/${t.id}/keychain`,'POST',input)).status).toBe(200);
    await runInDurableObject(taskStub(t.id),(_i,state)=>{expect(state.storage.sql.exec<{n:number}>('SELECT COUNT(*) n FROM submissions WHERE operation_id=?',`secure:${request.id}`).one().n).toBe(1);});
    await runInDurableObject(bindings.BOT.get(bindings.BOT.idFromName(`owner:${b.id}`)),(_i,state)=>{expect(state.storage.sql.exec<{n:number}>('SELECT COUNT(*) n FROM messages').one().n).toBe(0);expect(state.storage.sql.exec<{n:number}>('SELECT COUNT(*) n FROM submissions').one().n).toBe(0);});
    expect(JSON.stringify(await (await api(`/tasks/${t.id}/messages`)).json())).not.toContain('private-task-fixture');
  });
  it('rejects a sibling task request and a forged assigned bot before saving or using a credential',async()=>{
    const b=await bot(),other=await bot(),t=await task(b),sibling=await task(b,'Pending',false),request=await secure(t);
    const wrong=await api(`/tasks/${sibling.id}/keychain`,'POST',{operationId:crypto.randomUUID(),requestId:request.id,entries:[{value:'must-not-save'}]});expect(wrong.status).toBe(400);
    await runInDurableObject(owner(),async(instance)=>{
      const coordinator=(instance as unknown as {keychain:OwnerKeychainCoordinator}).keychain;
      await expect(coordinator.tool({name:'list_secrets',botId:other.id,taskId:t.id,runId:request.runId,nativeOperationId:request.nativeOperationId,operationId:'forged-task'},new AbortController().signal)).rejects.toMatchObject({code:'task_mismatch'});
    });
    expect((await api(`/tasks/${t.id}/cancel`,'POST')).status).toBe(200);
    const stopped=await api(`/tasks/${t.id}/keychain`,'POST',{operationId:crypto.randomUUID(),requestId:request.id,entries:[{value:'must-not-save'}]});expect(stopped.status).toBe(409);
    const unauthorized=await exports.default.fetch(`https://timber.test/v1/tasks/${t.id}/memory`);expect(unauthorized.status).toBe(401);await unauthorized.text();
  });
  it('routes context and memory controls to the task runtime while preserving bot isolation',async()=>{
    const b=await bot(),t=await task(b,'Pending',false);await api(`/tasks/${t.id}/messages`);
    await runInDurableObject(taskStub(t.id),(instance)=>{
      const runtime=(instance as unknown as {runtime:Record<string,unknown>}).runtime;
      runtime.contextStatus=async()=>({scope:'task-only'});runtime.memory=async()=>({scope:'task-only'});
      runtime.saveMemory=async(input:unknown)=>({scope:'task-only',input});
    });
    expect(await (await api(`/tasks/${t.id}/context`)).json()).toEqual({context:{scope:'task-only'}});
    expect(await (await api(`/tasks/${t.id}/memory`)).json()).toEqual({memory:{scope:'task-only'}});
    const saved=await api(`/tasks/${t.id}/memory/entries`,'POST',{operationId:crypto.randomUUID(),category:'fact',title:'Task note',content:'Only this task'});expect(saved.status).toBe(201);expect(await saved.json()).toMatchObject({result:{scope:'task-only'}});
    const denied=await api(`/tasks/${crypto.randomUUID()}/context`);expect(denied.status).toBe(404);
  });

  it.each(['images','image-only','mentions'] as const)('preserves continuation %s in the isolated task receipt and rejects changed replays',async kind=>{
    const b=await bot(),mentioned=await bot(),t=await task(b,'Initial',false),imageId=crypto.randomUUID();
    await bindings.FILES.put(`bots/${b.id}/artifacts/${imageId}`,new Uint8Array([1,2,3]),{httpMetadata:{contentType:'image/png'},customMetadata:{chatImage:'true'}});
    await runInDurableObject(owner(),(_i,state)=>{const row=state.storage.sql.exec<{data:string}>('SELECT data FROM tasks WHERE id=?',t.id).one();state.storage.sql.exec('UPDATE tasks SET data=? WHERE id=?',JSON.stringify({...JSON.parse(row.data),status:'completed'}),t.id);});
    const input={operationId:crypto.randomUUID(),text:kind==='image-only'?'':'Continue this task',...(kind!=='mentions'?{attachments:[imageId]}:{mentions:[mentioned.id]})};
    const continued=await api(`/tasks/${t.id}/continue`,'POST',input);expect(continued.status).toBe(202);
    const replay=await api(`/tasks/${t.id}/continue`,'POST',input);expect(replay.status).toBe(202);
    const changed=await api(`/tasks/${t.id}/continue`,'POST',{...input,...(kind!=='mentions'?{attachments:[crypto.randomUUID()]}:{mentions:[b.id]})});expect(changed.status).toBe(409);
    const history=(await (await api(`/tasks/${t.id}/messages`)).json<{messages:Message[]}>()).messages;
    const message=history.find(item=>item.role==='user'&&item.text===input.text);expect(message).toMatchObject(kind!=='mentions'?{attachments:[{artifactId:imageId,mimeType:'image/png'}]}:{mentions:[mentioned.id]});
    expect(history.filter(item=>item.role==='user'&&item.text===input.text)).toHaveLength(1);
    if(kind==='mentions'){const target=(await (await api(`/bots/${mentioned.id}/messages`)).json<{messages:Message[]}>()).messages;expect(target.some(item=>item.provenance?.sourceRunId===message!.runId&&item.provenance?.kind==='mention')).toBe(true);}
    expect((await (await api(`/bots/${b.id}/messages`)).json<{messages:Message[]}>()).messages).toHaveLength(0);
  });

});
