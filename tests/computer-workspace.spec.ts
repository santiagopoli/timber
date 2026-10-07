import {env} from "cloudflare:workers";
import {runInDurableObject} from "cloudflare:test";
import {afterEach,describe,expect,it,vi} from "vitest";

const bindings=env as unknown as {REAL_COMPUTER:DurableObjectNamespace};
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};};
const post=(botId:string,path:string,extra={})=>new Request(`https://computer${path}`,{method:"POST",body:JSON.stringify({botId,...extra})});
const read=(botId:string,kind="tree")=>new Request(`https://computer/workspace/${kind}`,{headers:{"x-timber-bot-id":botId}});
const health=(bootId="boot-1")=>Response.json({ok:true,bootId,desktop:true,capabilities:["workspace","liveDesktop"]});
afterEach(()=>vi.restoreAllMocks());

describe("workspace inspection alongside computer effects",()=>{
  it("returns all read-only views while exec remains pending, without starting or probing again",async()=>{
    const botId=crypto.randomUUID(),stub=bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId));
    await runInDurableObject(stub,async(instance,state)=>{
      const entered=deferred(),release=deferred();let probes=0,starts=0,effects=0,finished=false;
      Object.defineProperty(instance,"container",{get:()=>({running:true,start(){starts++;},async setInactivityTimeout(){},getTcpPort(){return {async fetch(input:string){
        const path=new URL(input).pathname;
        if(path==="/health"){probes++;return health();}
        if(path==="/actions"){effects++;entered.resolve();await release.promise;return Response.json({status:"completed",output:"done"});}
        if(path==="/checkpoint") return new Response(null,{status:503});
        return Response.json({path,entries:[{name:"README.md"}]});
      }};}})});
      await state.storage.put("botId",botId);
      const action=Promise.resolve(instance.fetch(post(botId,"/actions",{operationId:"long-exec",action:{type:"exec",command:"long running task"}}))).then(value=>{finished=true;return value;});
      await entered.promise;
      try {
        for(const kind of ["tree","file","download","projects","changes","diff"]){
          const response=await instance.fetch(read(botId,kind));
          expect(response.status).toBe(200);expect(await response.json()).toMatchObject({path:`/workspace/${kind}`});
          expect(response.headers.get("cache-control")).toBe("private, no-store");
          expect(finished).toBe(false);
        }
        expect(probes).toBe(1);expect(starts).toBe(0);expect(effects).toBe(1);
        expect((await instance.fetch(read(crypto.randomUUID()))).status).toBe(403);
        const desktopRequest=(path:string,body?:object)=>new Request(`https://computer${path}`,{method:"POST",headers:{"x-timber-bot-id":botId},...(body?{body:JSON.stringify(body)}:{})});
        const view=await instance.fetch(desktopRequest("/desktop",{mode:"view"}));
        expect(view.status).toBe(200);
        const session=await view.json<{sessionId:string}>();
        expect((await instance.fetch(desktopRequest(`/desktop/${session.sessionId}/renew`))).status).toBe(200);
        expect(finished).toBe(false);expect(probes).toBe(1);
        await instance.fetch(new Request(`https://computer/desktop/${session.sessionId}`,{method:"DELETE",headers:{"x-timber-bot-id":botId}}));
      } finally {release.resolve();await action;}
    });
  });

  it("shares cold startup and keeps reads behind checkpoint restoration",async()=>{
    const botId=crypto.randomUUID(),stub=bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId));
    await runInDurableObject(stub,async(instance,state)=>{
      const restoring=deferred(),release=deferred();let running=false,starts=0,reads=0,probes=0;
      Object.defineProperty(instance,"env",{value:{FILES:{async get(){return {size:1,body:new Response("x").body};}}}});
      await state.storage.put({botId,lastCheckpoint:{key:"test-checkpoint",sha256:"0".repeat(64)}});
      Object.defineProperty(instance,"container",{get:()=>({get running(){return running;},images:{base:"test-image"},start(){starts++;running=true;},async setInactivityTimeout(){},getTcpPort(){return {async fetch(input:string,init:RequestInit){
        const path=new URL(input).pathname;
        if(path==="/health"){probes++;return health();}
        if(path==="/restore"){await new Response(init.body).arrayBuffer();restoring.resolve();await release.promise;return Response.json({ok:true});}
        reads++;return Response.json({entries:[{name:"restored.txt"}]});
      }};}})});
      const first=instance.fetch(read(botId));await restoring.promise;
      const second=instance.fetch(read(botId,"projects"));
      await new Promise(resolve=>setTimeout(resolve,10));
      expect(reads).toBe(0);expect(starts).toBe(1);
      release.resolve();expect((await first).status).toBe(200);expect((await second).status).toBe(200);
      expect(reads).toBe(2);expect(probes).toBe(1);expect(starts).toBe(1);
    });
  });

  it("waits for an inspection before suspending and restores before the next inspection",async()=>{
    const botId=crypto.randomUUID(),stub=bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId));
    await runInDurableObject(stub,async(instance,state)=>{
      const reading=deferred(),releaseRead=deferred(),checkpointing=deferred(),releaseCheckpoint=deferred();
      let running=true,starts=0,destroys=0,reads=0,restores=0;
      Object.defineProperty(instance,"env",{value:{FILES:{async put(){return {size:1};},async get(){return {size:1,body:new Response("x").body};}}}});
      Object.defineProperty(instance,"container",{get:()=>({get running(){return running;},images:{base:"test-image"},start(){running=true;starts++;},async destroy(){running=false;destroys++;},async setInactivityTimeout(){},getTcpPort(){return {async fetch(input:string,init:RequestInit){
        const path=new URL(input).pathname;
        if(path==="/health")return health(`boot-${starts}`);
        if(path==="/checkpoint"){checkpointing.resolve();await releaseCheckpoint.promise;return new Response("x",{headers:{"Content-Length":"1","X-Content-SHA256":"0".repeat(64)}});}
        if(path==="/restore"){await new Response(init.body).arrayBuffer();restores++;return Response.json({ok:true});}
        reads++;if(reads===1){reading.resolve();await releaseRead.promise;}
        return Response.json({entries:[]});
      }};}})});
      await state.storage.put("botId",botId);
      const first=instance.fetch(read(botId));await reading.promise;
      const suspend=instance.fetch(post(botId,"/suspend"));
      await new Promise(resolve=>setTimeout(resolve,10));expect(destroys).toBe(0);
      releaseRead.resolve();await first;await checkpointing.promise;
      const next=instance.fetch(read(botId,"projects"));
      await new Promise(resolve=>setTimeout(resolve,10));expect(reads).toBe(1);
      releaseCheckpoint.resolve();expect((await suspend).status).toBe(200);expect((await next).status).toBe(200);
      expect(destroys).toBe(1);expect(starts).toBe(1);expect(restores).toBe(1);expect(reads).toBe(2);
    });
  });

  it("aborts an active inspection and fences queued reads before deletion completes",async()=>{
    vi.spyOn(console,"error").mockImplementation(()=>{});
    const botId=crypto.randomUUID(),stub=bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId));
    await runInDurableObject(stub,async(instance,state)=>{
      const entered=deferred();let reads=0,running=true;
      Object.defineProperty(instance,"container",{get:()=>({get running(){return running;},async destroy(){running=false;},async setInactivityTimeout(){},getTcpPort(){return {async fetch(input:string,init:RequestInit){
        if(new URL(input).pathname==="/health")return health();
        reads++;entered.resolve();return new Promise<Response>((_resolve,reject)=>init.signal!.addEventListener("abort",()=>reject(new Error("deleted")),{once:true}));
      }};}})});
      await state.storage.put("botId",botId);
      const first=instance.fetch(read(botId));await entered.promise;
      const second=instance.fetch(read(botId,"projects"));
      expect((await instance.fetch(post(botId,"/delete"))).status).toBe(200);
      expect((await first).status).toBe(503);expect((await second).status).toBe(410);expect(reads).toBe(1);
      expect(await state.storage.list()).toEqual(new Map([["deleted",botId]]));
    });
  });
});
