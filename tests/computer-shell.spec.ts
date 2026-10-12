import {env,exports} from "cloudflare:workers";
import {runInDurableObject} from "cloudflare:test";
import {describe,it,expect} from "vitest";
import {ShellSessions} from "../packages/computer/src/shell";
import {authenticateShellWebSocket,consoleSession} from "../apps/api/src/auth";
import worker from "../apps/api/src/index";
import type {Env} from "../apps/api/src/env";
const bindings=env as unknown as Env & {REAL_COMPUTER:DurableObjectNamespace};
const token="test-only-botspace-owner-token-000000",origin="https://botspace.test";
const internal=(botId:string,path:string,method="GET",body?:object)=>new Request(`https://computer.internal${path}`,{method,headers:{"x-timber-bot-id":botId},...(body?{body:JSON.stringify(body)}:{})});
const upgrade=(protocols:string[],id=crypto.randomUUID(),headers:Record<string,string>={})=>new Request(`${origin}/v1/bots/${id}/computer/shell`,{headers:{upgrade:"websocket",origin,"sec-websocket-protocol":protocols.join(","),...headers}});
async function login(){const response=await consoleSession(new Request(`${origin}/v1/session`,{method:"POST",headers:{authorization:`Bearer ${token}`,"x-timber-client":"console",origin}}),token);return response.headers.get("set-cookie")!.split(";")[0];}
async function until(check:()=>Promise<boolean>){for(let i=0;i<50;i++){if(await check())return;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error("Cleanup was not acknowledged");}

describe("real shell security and lifecycle boundary",()=>{
  it("requires a current owner session in addition to exact-Origin upgrades",async()=>{
    const cookie=await login();
    expect(await authenticateShellWebSocket(upgrade([],undefined,{cookie,"sec-fetch-mode":"websocket","sec-fetch-site":"same-origin"}),token)).toBe("owner");
    await expect(authenticateShellWebSocket(upgrade([]),token)).rejects.toMatchObject({status:401});
    await expect(authenticateShellWebSocket(upgrade([],undefined,{cookie}),`${token}-rotated`)).rejects.toMatchObject({status:401});
    await expect(authenticateShellWebSocket(upgrade([],undefined,{cookie,authorization:"Bearer invalid"}),token)).rejects.toMatchObject({status:401});
    const rejectedHeaders:Record<string,string>[]=[{origin:"null"},{origin:"https://evil.test"},{origin:""},{"sec-fetch-site":"same-site"},{"sec-fetch-mode":"navigate"}];
    for(const headers of rejectedHeaders) {
      await expect(authenticateShellWebSocket(upgrade([],undefined,{cookie,...headers}),token)).rejects.toMatchObject({status:403});
    }
    const withQuery=upgrade([],undefined,{cookie});
    await expect(authenticateShellWebSocket(new Request(`${withQuery.url}?ticket=bad`,withQuery),token)).rejects.toMatchObject({status:403});
  });
  it("consumes tickets exactly once, scopes bots and forwards only private transport credentials",async()=>{
    const botId=crypto.randomUUID(),stub=bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId));
    await runInDurableObject(stub,async(instance,state)=>{
      await state.storage.put("restoredBoot","test-boot");
      Object.defineProperty(instance,"initializeWorkspace",{value:async()=>({ok:true,bootId:"test-boot",desktop:true,capabilities:["shellPty"]})});
      let remote:WebSocket|undefined,stops=0;
      Object.defineProperty(instance,"container",{get:()=>({running:true,async setInactivityTimeout(){},getTcpPort(port:number){expect([6082,8080]).toContain(port);return{fetch:async(request:Request|string,init?:RequestInit)=>{
        const req=typeof request==="string"?new Request(request,init):request;
        expect(req.headers.get("authorization")).toMatch(/^Bearer .+/);
        expect(req.url).not.toContain("ticket");
        if(new URL(req.url).pathname==="/shell/close"){stops++;return Response.json({ok:true});}
        if(new URL(req.url).pathname==="/shell/renew")return Response.json({ok:true});
        expect(req.headers.get("sec-websocket-protocol")).toBe("timber-shell.v1");
        expect(req.headers.get("x-timber-shell-session")).toMatch(/^[a-f0-9-]{36}$/);
        const pair=new WebSocketPair();pair[1].accept();remote=pair[1];return new Response(null,{status:101,webSocket:pair[0]});
      }}}})});
      const created=await instance.fetch(internal(botId,"/shell","POST",{}));expect(created.status).toBe(200);
      const session=await created.json<{sessionId:string;protocols:string[]}>();
      const connect=(id=botId)=>instance.fetch(new Request("https://computer.internal/shell-ws",{headers:{"x-timber-bot-id":id,Upgrade:"websocket","sec-websocket-protocol":session.protocols.join(",")}}));
      expect((await connect(crypto.randomUUID())).status).toBe(403);
      const response=await connect();expect(response.status).toBe(101);expect(response.headers.get("sec-websocket-protocol")).toBe("timber-shell.v1");
      const client=response.webSocket!;client.accept();
      expect(await state.storage.get("checkpointRetry")).toMatchObject({bootId:"test-boot"});
      expect((await connect()).status).toBe(401);
      const output=new Promise<string>(resolve=>client.addEventListener("message",e=>resolve(e.data as string),{once:true}));
      remote!.send(JSON.stringify({type:"output",data:"hello terminal"}));
      expect(JSON.parse(await output)).toEqual({type:"output",data:"hello terminal",seq:1});
      client.send(JSON.stringify({type:"ack",seq:1}));
      const input=new Promise<string>(resolve=>remote!.addEventListener("message",e=>resolve(e.data as string),{once:true}));
      client.send(JSON.stringify({type:"input",data:"\u0003"}));expect(JSON.parse(await input)).toEqual({type:"input",data:"\u0003"});
      expect((await instance.fetch(internal(botId,`/shell/${session.sessionId}/renew`,"POST"))).status).toBe(200);
      expect((await instance.fetch(internal(botId,`/shell/${session.sessionId}`,"DELETE"))).status).toBe(200);
      expect(stops).toBe(1);expect(await state.storage.get(`shell:${session.sessionId}`)).toBeUndefined();
      client.close();remote!.close();
    });
  });
  it("reserves one grant, enforces expiry and keeps failed cleanup fenced",async()=>{
    const botId=crypto.randomUUID(),stub=bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId));
    await runInDurableObject(stub,async(_instance,state)=>{
      let fail=true,stopped=0;
      const sessions=new ShellSessions(state.storage,p=>state.waitUntil(p),async()=>{stopped++;if(fail)throw new Error("test-only transport failure");},async()=>{},async()=>{});
      const first=await sessions.create(botId);
      await expect(sessions.create(botId)).rejects.toMatchObject({status:409});
      await expect(sessions.renew(crypto.randomUUID(),first.sessionId)).rejects.toMatchObject({status:401});
      const record=await state.storage.get<Record<string,unknown>>(`shell:${first.sessionId}`);
      await state.storage.put(`shell:${first.sessionId}`,{...record,used:true,expires:Date.now()-1});
      await expect(sessions.renew(botId,first.sessionId)).rejects.toMatchObject({status:401});
      await expect(sessions.closeAll()).rejects.toThrow();
      expect(await state.storage.get(`shell:${first.sessionId}`)).toMatchObject({closing:true});
      expect(await sessions.active()).toBe(true);expect(stopped).toBe(1);
      fail=false;await sessions.sweep();expect(await sessions.active()).toBe(false);expect(stopped).toBe(2);
    });
  });
  it("fences a delayed upgrade before releasing human-control/checkpoint ownership",async()=>{
    const botId=crypto.randomUUID(),stub=bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId));
    await runInDurableObject(stub,async(_instance,state)=>{
      const closed=new Set<string>();let dispatches=0,entered!:()=>void,proceed!:()=>void;
      const starting=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{proceed=resolve;});
      const sessions=new ShellSessions(state.storage,p=>state.waitUntil(p),async s=>{closed.add(s.id);},async()=>{},async()=>{});
      const grant=await sessions.create(botId);
      const connecting=sessions.connect(botId,upgrade(grant.protocols),async s=>{
        expect(closed.has(s.id)).toBe(true);dispatches++;return new Response(null,{status:409});
      },async()=>{entered();await gate;},async()=>{});
      const outcome=connecting.then(()=>"connected",error=>(error as {code:string}).code);
      await starting;await sessions.release(botId,grant.sessionId);expect(await sessions.active()).toBe(false);
      proceed();expect(await outcome).toBe("shell_unavailable");expect(dispatches).toBe(1);expect(await sessions.active()).toBe(false);
    });
  });
  it("blocks effects/checkpoint/control before journaling and closes before suspend save",async()=>{
    const botId=crypto.randomUUID(),stub=bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId));
    await runInDurableObject(stub,async(instance,state)=>{
      const order:string[]=[];
      Object.defineProperty(instance,"initializeWorkspace",{value:async()=>({ok:true,bootId:"test-boot",desktop:true,capabilities:["shellPty","liveDesktop"]})});
      Object.defineProperty(instance,"container",{get:()=>({running:true,async setInactivityTimeout(){},async destroy(){order.push("destroy");},getTcpPort(){return{fetch:async()=>{order.push("close");return Response.json({ok:true});}}}})});
      Object.defineProperty(instance,"saveCheckpoint",{value:async()=>{expect(await state.storage.list({prefix:"shell:"})).toHaveProperty("size",0);order.push("save");return{id:crypto.randomUUID()};}});
      Object.defineProperty(instance,"status",{value:async()=>({state:"stopped"})});
      const session=await (await instance.fetch(internal(botId,"/shell","POST",{}))).json<{sessionId:string}>();
      const record=await state.storage.get<Record<string,unknown>>(`shell:${session.sessionId}`);await state.storage.put(`shell:${session.sessionId}`,{...record,used:true});
      for(const action of [{type:"exec",command:"touch denied"},{type:"checkpoint"},{type:"writeFile",path:"denied",content:"x"}]) {
        const operationId=crypto.randomUUID();const response=await instance.fetch(new Request("https://computer.internal/actions",{method:"POST",body:JSON.stringify({botId,operationId,action})}));
        expect(await response.json()).toMatchObject({status:"failed",error:expect.stringContaining("No action was executed")});
        expect(await state.storage.get(`operation:${operationId}`)).toBeUndefined();
      }
      expect((await instance.fetch(internal(botId,"/desktop","POST",{mode:"control"}))).status).toBe(409);
      expect((await instance.fetch(new Request("https://computer.internal/suspend",{method:"POST",body:JSON.stringify({botId})}))).status).toBe(200);
      expect(order).toEqual(["close","save","destroy"]);
    });
  });
  it("retries uncertain shell cleanup before acknowledging permanent bot deletion",async()=>{
    const botId=crypto.randomUUID(),stub=bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId));
    await runInDurableObject(stub,async(instance,state)=>{
      let fail=true,running=true;const order:string[]=[];
      Object.defineProperty(instance,"initializeWorkspace",{value:async()=>({ok:true,bootId:"test-boot",desktop:true,capabilities:["shellPty"]})});
      Object.defineProperty(instance,"container",{get:()=>({get running(){return running;},async setInactivityTimeout(){},async destroy(){order.push("destroy");running=false;},getTcpPort(port:number){expect(port).toBe(8080);return{fetch:async()=>{order.push("close");return fail?Response.json({error:{code:"shell_cleanup_pending"}},{status:503}):Response.json({ok:true});}}}})});
      const grant=await (await instance.fetch(internal(botId,"/shell","POST",{}))).json<{sessionId:string}>();
      const record=await state.storage.get<Record<string,unknown>>(`shell:${grant.sessionId}`);await state.storage.put(`shell:${grant.sessionId}`,{...record,used:true});
      const remove=()=>instance.fetch(new Request("https://computer.internal/delete",{method:"POST",body:JSON.stringify({botId})}));
      expect((await remove()).status).toBe(503);expect(order).toEqual(["close"]);expect(await state.storage.get(`shell:${grant.sessionId}`)).toMatchObject({closing:true});
      fail=false;expect((await remove()).status).toBe(200);expect(order).toEqual(["close","close","destroy"]);
      expect(await state.storage.get(`shell:${grant.sessionId}`)).toBeUndefined();expect(await state.storage.get("deleted")).toBe(botId);
      expect((await instance.fetch(internal(botId,"/shell","POST",{}))).status).toBe(410);
    });
  });
  it("bounds output/backpressure and cleans up disconnected sockets",async()=>{
    const botId=crypto.randomUUID(),stub=bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId));
    await runInDurableObject(stub,async(_instance,state)=>{
      let stopped=0,remote:WebSocket|undefined;
      const sessions=new ShellSessions(state.storage,p=>state.waitUntil(p),async()=>{stopped++;},async()=>{},async()=>{});
      const start=async()=>{
        const session=await sessions.create(botId);
        const response=await sessions.connect(botId,upgrade(session.protocols),async()=>{const pair=new WebSocketPair();pair[1].accept();remote=pair[1];return new Response(null,{status:101,webSocket:pair[0]});},async()=>{},async()=>{});
        response.webSocket!.accept();return response.webSocket!;
      };
      const client=await start();
      for(let i=0;i<40;i++)remote!.send(JSON.stringify({type:"output",data:"x".repeat(8192)}));
      await until(async()=>stopped===1);expect(await sessions.active()).toBe(false);client.close();remote!.close();
      const second=await start();second.close();await until(async()=>stopped===2);expect(await sessions.active()).toBe(false);remote!.close();
    });
  });
  it("distinguishes a modern starting bridge from an obsolete image",async()=>{
    const botId=crypto.randomUUID(),stub=bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId));
    await runInDurableObject(stub,async(instance)=>{
      Object.defineProperty(instance,"initializeWorkspace",{value:async()=>({ok:true,desktop:true,capabilities:["shellPtySupported"]})});
      let ready=true,probes=0;
      Object.defineProperty(instance,"health",{value:async()=>{probes++;return{ok:true,desktop:true,capabilities:["shellPtySupported",...(ready?["shellPty"]:[])]};}});
      const response=await instance.fetch(internal(botId,"/shell","POST",{}));expect(response.status).toBe(200);expect(probes).toBe(1);
      const grant=await response.json<{sessionId:string}>();await instance.fetch(internal(botId,`/shell/${grant.sessionId}`,"DELETE"));
      ready=false;const unavailable=await instance.fetch(internal(botId,"/shell","POST",{}));expect(unavailable.status).toBe(503);expect(await unavailable.json()).toMatchObject({error:{code:"shell_unavailable"}});
    });
  });
  it("never offers a fallback on old images and blocks public access to the bridge",async()=>{
    const botId=crypto.randomUUID(),stub=bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId));
    await runInDurableObject(stub,async(instance)=>{
      Object.defineProperty(instance,"initializeWorkspace",{value:async()=>({ok:true,desktop:true,capabilities:["workspace"]})});
      expect(await (await instance.fetch(internal(botId,"/shell","POST",{}))).json()).toMatchObject({error:{code:"computer_upgrade_required"}});
      expect((await instance.fetch(internal(botId,"/preview/6082/"))).status).toBe(400);
    });
  });
  it("returns a credential-free wss URL and scoped protocols through authenticated grant admission",async()=>{
    const created=await exports.default.fetch(`${origin}/v1/bots`,{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:JSON.stringify({name:"Shell grant"})});
    const {bot}=await created.json<{bot:{id:string}}>();
    const grant={sessionId:crypto.randomUUID(),protocols:["timber-shell.v1",`timber-shell-ticket.${crypto.randomUUID()}${crypto.randomUUID()}`],expiresAt:new Date(Date.now()+60_000).toISOString()};
    const fakeBots={idFromName:(name:string)=>bindings.BOT.idFromName(name),get:()=>({fetch:async(request:Request)=>{
      expect(new URL(request.url).pathname).toBe("/computer/shell-session");
      expect(request.headers.has("authorization")).toBe(false);expect(request.headers.has("cookie")).toBe(false);
      await request.text();return Response.json(grant);
    }})} as unknown as DurableObjectNamespace;
    const response=await worker.fetch(new Request(`${origin}/v1/bots/${bot.id}/computer/shell-session`,{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:"{}"}),{...bindings,BOT:fakeBots});
    expect(response.status).toBe(200);expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({...grant,url:`wss://botspace.test/v1/bots/${bot.id}/computer/shell`});
  });
  it("validates auth, registry membership and Origin at the actual API gateway",async()=>{
    const created=await exports.default.fetch(`${origin}/v1/bots`,{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:JSON.stringify({name:"Shell boundary"})});
    const {bot}=await created.json<{bot:{id:string}}>();
    for(const path of ["computer/shell-session","computer/shell-session/00000000-0000-0000-0000-000000000000/renew"])expect((await exports.default.fetch(`${origin}/v1/bots/${bot.id}/${path}`,{method:"POST"})).status).toBe(401);
    const cookie=await login();
    const call=(request:Request)=>worker.fetch(request,{...bindings,COMPUTER:bindings.REAL_COMPUTER});
    expect((await call(upgrade([],bot.id))).status).toBe(401);
    expect((await call(upgrade([],bot.id,{cookie,origin:"https://evil.test"}))).status).toBe(403);
    expect((await call(upgrade([],crypto.randomUUID(),{cookie}))).status).toBe(404);
    expect((await call(upgrade(["timber-shell.v1","timber-shell-ticket.invalid"],bot.id,{cookie}))).status).toBe(401);
  });
});
