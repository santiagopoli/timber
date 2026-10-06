import { env } from "cloudflare:workers";
import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";

const bindings=env as unknown as {REAL_COMPUTER:DurableObjectNamespace;FILES:R2Bucket};
const request=(botId:string,path:string,extra={})=>new Request(`https://computer${path}`,{method:"POST",body:JSON.stringify({botId,...extra})});
afterEach(()=>vi.restoreAllMocks());

it("stops and erases the real computer journal and credentials while preserving a non-revivable deletion marker",async()=>{
  const botId=crypto.randomUUID();let stub=bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId));
  await runInDurableObject(stub,async(instance,state)=>{
    let running=true,destroys=0;
    Object.defineProperty(instance,"container",{get:()=>({get running(){return running;},async destroy(){running=false;destroys++;}})});
    await state.storage.put({botId,"operation:old":{digest:"old",result:{output:"private output"}},lastCheckpoint:{key:"private checkpoint"},lastActivity:Date.now()});
    await state.storage.setAlarm(Date.now()+60_000);
    expect((await instance.fetch(request(botId,"/delete"))).status).toBe(200);
    expect((await instance.fetch(request(botId,"/delete"))).status).toBe(200);
    expect(destroys).toBe(1);expect(running).toBe(false);
    expect(await state.storage.list()).toEqual(new Map([["deleted",botId]]));
    expect(await state.storage.getAlarm()).toBeNull();
  });
  await abortAllDurableObjects();stub=bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId));
  expect((await stub.fetch(request(botId,"/actions",{operationId:"revive",action:{type:"exec",command:"must not execute"}}))).status).toBe(410);
  expect((await stub.fetch(request(botId,"/touch"))).status).toBe(410);
  expect((await stub.fetch(request(botId,"/delete"))).status).toBe(200);
  expect(await runInDurableObject(stub,(_instance,state)=>state.storage.list())).toEqual(new Map([["deleted",botId]]));
});

it("aborts an in-flight computer request and fences queued effects before acknowledging deletion",async()=>{
  vi.spyOn(console,"error").mockImplementation(()=>{});
  const botId=crypto.randomUUID(),stub=bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId));
  await runInDurableObject(stub,async(instance,state)=>{
    let running=true,effects=0,enter!:()=>void;
    const entered=new Promise<void>(resolve=>{enter=resolve;});
    Object.defineProperty(instance,"container",{get:()=>({
      get running(){return running;},async destroy(){running=false;},async setInactivityTimeout(){},
      getTcpPort(){return {async fetch(input:string,init:RequestInit){
        if(new URL(input).pathname==="/health") return Response.json({ok:true,bootId:"existing",desktop:true});
        effects++;enter();
        return new Promise<Response>((_resolve,reject)=>{init.signal!.addEventListener("abort",()=>reject(new Error("Stopped")),{once:true});});
      }};},
    })});
    await state.storage.put("restoredBoot","existing");
    const action=instance.fetch(request(botId,"/actions",{operationId:"active",action:{type:"listFiles"}}));
    await entered;
    const queued=instance.fetch(request(botId,"/actions",{operationId:"queued",action:{type:"exec",command:"must not execute"}}));
    expect((await instance.fetch(request(botId,"/delete"))).status).toBe(200);
    expect((await action).status).toBe(410);expect((await queued).status).toBe(410);
    expect(effects).toBe(1);expect(running).toBe(false);
    expect(await state.storage.list()).toEqual(new Map([["deleted",botId]]));
  });
});

it("does not acknowledge computer deletion while an already dispatched artifact upload can still finish",async()=>{
  vi.spyOn(console,"error").mockImplementation(()=>{});
  const botId=crypto.randomUUID(),stub=bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId));
  await runInDurableObject(stub,async(instance,state)=>{
    let running=true,enter!:()=>void,release!:()=>void,deleted=false;
    const entered=new Promise<void>(resolve=>{enter=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
    const files={put:async(key:string,value:ReadableStream,options:R2PutOptions)=>{enter();await gate;return bindings.FILES.put(key,value,options);}};
    Object.defineProperty(instance,"env",{value:{FILES:files}});
    Object.defineProperty(instance,"container",{get:()=>({
      get running(){return running;},async destroy(){running=false;},async setInactivityTimeout(){},
      getTcpPort(){return {async fetch(input:string){
        const path=new URL(input).pathname;
        if(path==="/health") return Response.json({ok:true,bootId:"existing",desktop:true});
        if(path==="/actions") return Response.json({status:"completed",artifactName:`${crypto.randomUUID()}.png`});
        return new Response("test screenshot",{headers:{"content-type":"image/png"}});
      }};},
    })});
    await state.storage.put("restoredBoot","existing");
    const action=instance.fetch(request(botId,"/actions",{operationId:"screenshot",action:{type:"screenshot"}}));
    await entered;
    const deletion=Promise.resolve(instance.fetch(request(botId,"/delete"))).then(response=>{deleted=true;return response;});
    await new Promise(resolve=>setTimeout(resolve,10));expect(deleted).toBe(false);
    release();expect((await deletion).status).toBe(200);expect((await action).status).toBe(410);
    expect((await bindings.FILES.list({prefix:`bots/${botId}/`})).objects).toHaveLength(1);
    expect(await state.storage.list()).toEqual(new Map([["deleted",botId]]));
    // Workspace performs the R2 sweep only after this completion boundary.
    await bindings.FILES.delete((await bindings.FILES.list({prefix:`bots/${botId}/`})).objects.map(object=>object.key));
  });
});
