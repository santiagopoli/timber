import {env, exports} from 'cloudflare:workers';
import {runInDurableObject} from 'cloudflare:test';
import {describe,it,expect} from 'vitest';
import type {Env} from '../apps/api/src/env';
import {parseMessage} from '../apps/api/src/validation';
const token='test-only-botspace-owner-token-000000';
const api=(path:string,init:RequestInit={})=>exports.default.fetch(`https://botspace.test${path}`,{...init,headers:{authorization:`Bearer ${token}`,'content-type':'application/json',...init.headers}});
const png=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='),char=>char.charCodeAt(0));
async function bot() {return (await (await api('/v1/bots',{method:'POST',body:JSON.stringify({name:'Images'})})).json<{bot:{id:string}}>()).bot;}
const upload=(id:string,imageId:string,bytes:Uint8Array=png,type='image/png')=>api(`/v1/bots/${id}/attachments/${imageId}`,{method:'PUT',headers:{'content-type':type},body:bytes});
describe('chat image attachments',()=>{
  it('validates image-only inputs and bounds references',()=>{
    const id=crypto.randomUUID();expect(parseMessage({text:'',operationId:'image-test',attachments:[id]}).attachments).toEqual([id]);
    for(const attachments of [[id,id],['https://other/image'],Array.from({length:5},()=>crypto.randomUUID())]) expect(()=>parseMessage({text:'',operationId:'test',attachments})).toThrow();
    expect(()=>parseMessage({text:'',operationId:'test'})).toThrow();
  });
  it('requires auth and rejects invalid, mismatched and oversized image bytes',async()=>{
    const b=await bot(),id=crypto.randomUUID();
    expect((await exports.default.fetch(`https://botspace.test/v1/bots/${b.id}/attachments/${id}`,{method:'PUT',body:png})).status).toBe(401);
    expect((await upload(b.id,id,new Uint8Array([1,2,3]))).status).toBe(400);
    expect((await upload(b.id,id,png,'image/jpeg')).status).toBe(400);
    expect((await upload(b.id,id,new Uint8Array(5_000_001))).status).toBe(413);
  });
  it('persists scoped images, deduplicates uploads/messages and delivers model image bytes',async()=>{
    const b=await bot(),other=await bot(),id=crypto.randomUUID(),operationId=crypto.randomUUID();
    expect((await upload(b.id,id)).status).toBe(200);
    expect((await upload(b.id,id)).status).toBe(200);
    const changed=png.slice();changed[changed.length-1]^=1;
    expect((await upload(b.id,id,changed)).status).toBe(409);
    expect((await api(`/v1/bots/${other.id}/artifacts/${id}`)).status).toBe(404);
    const payload={text:'',operationId,attachments:[id]};
    expect((await api(`/v1/bots/${other.id}/messages`,{method:'POST',body:JSON.stringify(payload)})).status).toBe(400);
    const path=`/v1/bots/${b.id}/messages`,send=()=>api(path,{method:'POST',body:JSON.stringify(payload)});
    expect((await send()).status).toBe(202);expect((await send()).status).toBe(202);
    const stub=(env as unknown as Env).BOT.get((env as unknown as Env).BOT.idFromName(`owner:${b.id}`));
    const received=await runInDurableObject(stub,async(_,state)=>state.storage.get<{images:{data:string;mimeType:string}[]}>(`fixture-runtime:${operationId}`));
    expect(received?.images[0].mimeType).toBe('image/png');expect(atob(received!.images[0].data).length).toBe(png.length);
    for(let attempt=0;attempt<100;attempt++) {
      const state=await api(`/v1/bots/${b.id}/runs`);const runs=await state.json<{runs:{status:string}[]}>();
      if(runs.runs.every(run=>['completed','failed'].includes(run.status))) break;
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    
    const result=await (await api(path)).json<{messages:{role:string;attachments?:{artifactId:string}[]}[]}>();
    const users=result.messages.filter(message=>message.role==='user');expect(users).toHaveLength(1);expect(users[0].attachments?.[0].artifactId).toBe(id);
    expect((await api(path,{method:'POST',body:JSON.stringify({...payload,attachments:[]})})).status).toBe(400);
    expect((await api(path,{method:'POST',body:JSON.stringify({...payload,text:'Changed'})})).status).toBe(409);
  });
});
