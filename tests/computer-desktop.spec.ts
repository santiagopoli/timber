import {env,exports} from "cloudflare:workers";
import {runInDurableObject} from "cloudflare:test";
import {describe,it,expect} from "vitest";
import {DesktopSessions} from "../packages/computer/src/live";
import worker from "../apps/api/src/index";
import type {Env} from "../apps/api/src/env";
const bindings=env as unknown as Env & {REAL_COMPUTER:DurableObjectNamespace};
const token="test-only-botspace-owner-token-000000";
const internal=(botId:string,path:string,method="GET",body?:object)=>new Request(`https://computer.internal${path}`,{method,headers:{"x-timber-bot-id":botId},...(body?{body:JSON.stringify(body)}:{})});
describe("live desktop and workspace boundary",()=>{
  it("uses single-use bot-bound tickets, private transport credentials and closes revoked sockets",async()=>{
    const botId=crypto.randomUUID(),stub=bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId));
    await runInDurableObject(stub,async(instance,state)=>{
      Object.defineProperty(instance,"ensureReady",{value:async()=>({ok:true,desktop:true,capabilities:["workspace","liveDesktop"]})});
      let chosenPort=0;
      let remote:WebSocket|undefined;
      Object.defineProperty(instance,"container",{get:()=>({running:true,async setInactivityTimeout(){},getTcpPort(port:number){chosenPort=port;return{fetch:async(request:Request)=>{
        expect(request.headers.get("authorization")).toMatch(/^Bearer .+/);
        expect(request.headers.get("sec-websocket-protocol")).toBe("binary");
        expect(request.url).not.toContain("ticket");
        const pair=new WebSocketPair();pair[1].accept();remote=pair[1];
        return new Response(null,{status:101,webSocket:pair[0]});
      }}}})});
      const created=await instance.fetch(internal(botId,"/desktop","POST",{mode:"view"}));
      expect(created.status).toBe(200);
      const session=await created.json<{sessionId:string;protocols:string[]}>();
      const connect=(id=botId)=>instance.fetch(new Request("https://computer.internal/desktop-ws",{headers:{"x-timber-bot-id":id,Upgrade:"websocket","Sec-WebSocket-Protocol":session.protocols.join(",")}}));
      expect((await connect(crypto.randomUUID())).status).toBe(403);
      const response=await connect();expect(response.status).toBe(101);expect(chosenPort).toBe(6080);
      const client=response.webSocket!;client.binaryType="arraybuffer";client.accept();
      expect((await connect()).status).toBe(401);
      const binary=new Promise<ArrayBuffer>(resolve=>client.addEventListener("message",e=>resolve(e.data as ArrayBuffer),{once:true}));
      remote!.send(new Uint8Array([82,70,66]));expect([...new Uint8Array(await binary)]).toEqual([82,70,66]);
      expect((await instance.fetch(internal(botId,`/desktop/${session.sessionId}`,"DELETE"))).status).toBe(200);
      expect(await state.storage.get(`desktop:${session.sessionId}`)).toBeUndefined();
      client.close();remote!.close();
    });
  });
  it("enforces exclusive control, expiry and blocks effects before journaling",async()=>{
    const botId=crypto.randomUUID(),stub=bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId));
    await runInDurableObject(stub,async(instance,state)=>{
      Object.defineProperty(instance,"ensureReady",{value:async()=>({ok:true,desktop:true,capabilities:["liveDesktop"]})});
      const create=()=>instance.fetch(internal(botId,"/desktop","POST",{mode:"control"}));
      const first=await create();expect(first.status).toBe(200);
      const {sessionId}=await first.json<{sessionId:string}>();
      expect((await create()).status).toBe(409);
      const op=crypto.randomUUID();
      const response=await instance.fetch(new Request("https://computer.internal/actions",{method:"POST",body:JSON.stringify({botId,operationId:op,action:{type:"exec",command:"touch forbidden"}})}));
      expect(await response.json()).toMatchObject({status:"failed",error:expect.stringContaining("No action was executed")});
      expect(await state.storage.get(`operation:${op}`)).toBeUndefined();
      const value=await state.storage.get<Record<string,unknown>>(`desktop:${sessionId}`);
      await state.storage.put(`desktop:${sessionId}`,{...value,expires:Date.now()-1});
      expect((await instance.fetch(internal(botId,`/desktop/${sessionId}/renew`,"POST"))).status).toBe(401);
      const second=await create();expect(second.status).toBe(200);
      const next=await second.json<{sessionId:string}>();
      await instance.fetch(internal(botId,`/desktop/${next.sessionId}`,"DELETE"));
    });
  });
  it("waits for a new image's desktop bridge without reporting an obsolete image",async()=>{
    const botId=crypto.randomUUID(),stub=bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId));
    await runInDurableObject(stub,async(instance)=>{
      let probes=0;
      Object.defineProperty(instance,"ensureReady",{value:async()=>({ok:true,desktop:true,capabilities:["workspace"]})});
      Object.defineProperty(instance,"health",{value:async()=>{probes++;return {ok:true,desktop:true,capabilities:["workspace","liveDesktop"]};}});
      const response=await instance.fetch(internal(botId,"/desktop","POST",{mode:"view"}));
      expect(response.status).toBe(200);expect(probes).toBe(1);
      const session=await response.json<{sessionId:string}>();
      await instance.fetch(internal(botId,`/desktop/${session.sessionId}`,"DELETE"));
    });
  });
  it("caps viewers and checks old-image capability before exposing files",async()=>{
    const botId=crypto.randomUUID(),stub=bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId));
    await runInDurableObject(stub,async(instance,state)=>{
      const sessions=new DesktopSessions(state.storage,p=>state.waitUntil(p));
      for(let i=0;i<4;i++)await sessions.create(botId,"view");
      await expect(sessions.create(botId,"view")).rejects.toMatchObject({status:429});
      await sessions.closeAll();
      Object.defineProperty(instance,"ensureReady",{value:async()=>({ok:true,desktop:true,capabilities:[]})});
      expect((await instance.fetch(internal(botId,"/workspace/tree"))).status).toBe(409);
      expect((await instance.fetch(internal(botId,"/desktop","POST",{mode:"view"}))).status).toBe(409);
    });
  });
  it("serves workspace downloads as attachments with isolation headers and never proxies desktop ports as apps",async()=>{
    const botId=crypto.randomUUID(),stub=bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId));
    await runInDurableObject(stub,async(instance,state)=>{
      await state.storage.put("botId",botId);
      Object.defineProperty(instance,"ensureReady",{value:async()=>({ok:true,desktop:true,capabilities:["workspace"]})});
      Object.defineProperty(instance,"call",{value:async(path:string)=>{expect(path).toBe("/workspace/download?path=index.html");return new Response("<script>bad()</script>",{headers:{"content-type":"text/html"}});}});
      const response=await instance.fetch(internal(botId,"/workspace/download?path=index.html"));
      expect(response.status).toBe(200);expect(response.headers.get("content-disposition")).toContain("attachment");expect(response.headers.get("content-security-policy")).toContain("sandbox");
      for(const port of [8080,5900,5901,6080,6081])expect((await instance.fetch(internal(botId,`/preview/${port}/`))).status).toBe(400);
      expect((await instance.fetch(internal(crypto.randomUUID(),"/workspace/tree"))).status).toBe(403);
    });
  });
  it("requires owner authorization for reads/grants and same-origin WebSocket upgrades",async()=>{
    const created=await exports.default.fetch("https://botspace.test/v1/bots",{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:JSON.stringify({name:"Desktop boundaries"})});
    const {bot}=await created.json<{bot:{id:string}}>();
    for(const tail of ["workspace/tree","workspace/download?path=x","computer/live-session"]){
      const response=await exports.default.fetch(`https://botspace.test/v1/bots/${bot.id}/${tail}`,{method:tail.includes("session")?"POST":"GET"});expect(response.status).toBe(401);
    }
    for(const origin of ["https://evil.example","null",""]){
      const response=await worker.fetch(new Request(`https://botspace.test/v1/bots/${bot.id}/computer/live`,{headers:{upgrade:"websocket",origin}}),{...bindings,COMPUTER:bindings.REAL_COMPUTER});expect(response.status).toBe(403);
    }
    const response=await worker.fetch(new Request(`https://botspace.test/v1/bots/${bot.id}/computer/live`,{headers:{upgrade:"websocket",origin:"https://botspace.test","sec-websocket-protocol":"binary,timber-ticket.invalid"}}),{...bindings,COMPUTER:bindings.REAL_COMPUTER});expect(response.status).toBe(401);
  });
});
