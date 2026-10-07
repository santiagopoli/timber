import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { WorkspaceApps, parseWorkspaceApp, type WorkspaceApp } from "../apps/api/src/workspace-apps";

const ORIGINS={previewOrigin:"https://preview.test",consoleOrigin:"https://timber.test"};
const bindings=env as unknown as {REAL_COMPUTER:DurableObjectNamespace;BOT:DurableObjectNamespace};
const ownerSecret="owner-api-secret-must-not-reach-preview";
function computer(handler:(request:Request)=>Promise<Response>|Response) {
  return {idFromName:(name:string)=>name,get:()=>({fetch:(input:RequestInfo,init?:RequestInit)=>handler(new Request(input,init))})} as unknown as DurableObjectNamespace;
}
async function isolated(test:(store:DurableObjectStorage,botId:string)=>Promise<void>) {
  const botId=crypto.randomUUID(),stub=bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId));
  await runInDurableObject(stub,async(_instance,state)=>test(state.storage,botId));
}
async function authorize(apps:WorkspaceApps,app:WorkspaceApp) {
  const open=await apps.open(app.id);
  expect(open.actionUrl).toBe(app.url+"__timber_open");
  const response=await apps.preview(new Request(open.actionUrl,{method:"POST",headers:{origin:ORIGINS.consoleOrigin,"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({ticket:open.ticket})}),app.id,app.basePath+"__timber_open");
  expect(response.status).toBe(303);expect(response.headers.get("location")).toBe(app.url);
  const setCookie=response.headers.get("set-cookie")!;
  expect(setCookie).toContain("HttpOnly");expect(setCookie).toContain("SameSite=Lax");expect(setCookie).toContain(`Path=${app.basePath}`);
  return {cookie:setCookie.split(";")[0],open};
}

describe("workspace apps",()=>{
  it("returns a reviewed HTTP error when an opening ticket is replayed through BotDO",async()=>{
    const botId=crypto.randomUUID(),stub=bindings.BOT.get(bindings.BOT.idFromName(`owner:${botId}`));
    await runInDurableObject(stub,async(instance,state)=>{
      const apps=new WorkspaceApps(state.storage,computer(()=>new Response("ready")),botId,ORIGINS);
      const app=await apps.publish({name:"App",port:3000,operationId:"app"}),open=await apps.open(app.id);
      const bot={id:botId,name:"App test",instructions:"",runtime:"pi",model:"@cf/test/mock",createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
      const request=()=>new Request(`https://bot/workspace-app-preview/${app.id}`,{method:"POST",headers:{"x-botspace-config":encodeURIComponent(JSON.stringify(bot)),"x-timber-preview-path":app.basePath+"__timber_open",origin:ORIGINS.consoleOrigin,"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({ticket:open.ticket})});
      expect((await instance.fetch(request())).status).toBe(303);
      const replay=await instance.fetch(request());expect(replay.status).toBe(401);
      expect(await replay.json()).toMatchObject({error:{code:"invalid_app_ticket"}});
    });
  });
  it("publishes multiple independently named apps and keeps stable allocation across model retries",async()=>isolated(async(store,botId)=>{
    const calls:string[]=[];
    const apps=new WorkspaceApps(store,computer(request=>{calls.push(request.url);return new Response("ready");}),botId,ORIGINS);
    const first=await apps.publish({name:"Frontend",port:3000,operationId:"frontend"});
    const admin=await apps.publish({name:"Admin",port:3001,operationId:"admin"});
    expect(first.state).toBe("ready");expect(first.id).not.toBe(admin.id);expect(first.basePath).toContain(botId);
    expect(await apps.publish({name:"Frontend",port:3000,operationId:"frontend"})).toEqual(first);
    expect(await apps.publish({name:"Frontend",port:3000,operationId:"new-turn"})).toEqual(first);
    const probes=calls.length;
    expect(await apps.list()).toHaveLength(2);expect(calls).toHaveLength(probes);
    expect(await apps.refresh()).toHaveLength(2);expect(calls).toHaveLength(probes+2);
    expect(calls[0]).toContain(`/preview/3000${first.basePath}`);
    await expect(apps.publish({name:"Changed",port:3002,operationId:"frontend"})).rejects.toMatchObject({code:"operation_conflict"});
    await expect(apps.publish({name:"Other",port:3000,operationId:"duplicate-port"})).rejects.toMatchObject({code:"app_port_in_use"});
  }));

  it("reports an unavailable app honestly while providing its stable framework base path",async()=>isolated(async(store,botId)=>{
    const apps=new WorkspaceApps(store,computer(()=>new Response("stopped",{status:503})),botId,ORIGINS);
    const app=await apps.publish({name:"Dashboard",port:5173,operationId:"dashboard"});
    expect(app.state).toBe("unavailable");expect(app.url).toBe(ORIGINS.previewOrigin+app.basePath);
    expect((await apps.list())[0]).toEqual(app);
  }));

  it("keeps preview on a separate HTTPS origin and rejects control or arbitrary port inputs",()=>{
    const invalid=[0,80,443,8080,65536,3000.1,"3000"];
    for(const port of invalid) expect(()=>parseWorkspaceApp({name:"App",port,operationId:"app"})).toThrow();
    expect(parseWorkspaceApp({name:"App",port:3000,operationId:"pi-tool:"+"x".repeat(152)}).operationId).toHaveLength(160);
    expect(()=>parseWorkspaceApp({name:" ",port:3000,operationId:"app"})).toThrow();
    expect(()=>new WorkspaceApps({} as DurableObjectStorage,{} as DurableObjectNamespace,crypto.randomUUID(),{previewOrigin:ORIGINS.consoleOrigin,consoleOrigin:ORIGINS.consoleOrigin})).toThrow();
    expect(()=>new WorkspaceApps({} as DurableObjectStorage,{} as DurableObjectNamespace,crypto.randomUUID(),{...ORIGINS,previewOrigin:"http://preview.test"})).toThrow();
  });

  it("requires owner-issued browser access and consumes each opening ticket once",async()=>isolated(async(store,botId)=>{
    const apps=new WorkspaceApps(store,computer(()=>new Response("ready")),botId,ORIGINS);
    const app=await apps.publish({name:"Shop",port:3000,operationId:"shop"});
    expect((await apps.preview(new Request(app.url),app.id,app.basePath)).status).toBe(401);
    const {cookie,open}=await authorize(apps,app);
    expect((await apps.preview(new Request(app.url,{headers:{cookie}}),app.id,app.basePath)).status).toBe(200);
    await expect(apps.preview(new Request(open.actionUrl,{method:"POST",headers:{origin:ORIGINS.consoleOrigin,"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({ticket:open.ticket})}),app.id,app.basePath+"__timber_open")).rejects.toMatchObject({code:"invalid_app_ticket"});
    const records=await store.list();
    expect(JSON.stringify([...records])).not.toContain(open.ticket);
    expect(JSON.stringify([...records])).not.toContain(cookie.split("=")[1]);
  }));

  it("does not accept a browser session or ticket from another app",async()=>isolated(async(store,botId)=>{
    const apps=new WorkspaceApps(store,computer(()=>new Response("ready")),botId,ORIGINS);
    const first=await apps.publish({name:"A",port:3000,operationId:"a"}), second=await apps.publish({name:"B",port:3001,operationId:"b"});
    const {cookie,open}=await authorize(apps,first);
    expect((await apps.preview(new Request(second.url,{headers:{cookie}}),second.id,second.basePath)).status).toBe(401);
    const otherTicket=await apps.open(first.id);
    await expect(apps.preview(new Request(second.url+"__timber_open",{method:"POST",headers:{origin:ORIGINS.consoleOrigin,"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({ticket:otherTicket.ticket})}),second.id,second.basePath+"__timber_open")).rejects.toMatchObject({code:"invalid_app_ticket"});
    expect(open.actionUrl).not.toContain(open.ticket);
  }));

  it("revokes existing sessions and pending tickets without killing the app or recreating it on replay",async()=>isolated(async(store,botId)=>{
    let calls=0;
    const apps=new WorkspaceApps(store,computer(()=>{calls++;return new Response("ready");}),botId,ORIGINS);
    const app=await apps.publish({name:"App",port:3000,operationId:"app"});
    const {cookie}=await authorize(apps,app), before=calls;
    await apps.remove(app.id);
    expect(calls).toBe(before);expect(await apps.list()).toEqual([]);
    await expect(apps.preview(new Request(app.url,{headers:{cookie}}),app.id,app.basePath)).rejects.toMatchObject({code:"app_not_found"});
    await expect(apps.publish({name:"App",port:3000,operationId:"app"})).rejects.toMatchObject({code:"app_not_found"});
  }));

  it("strips control-plane credentials and preserves scoped app traffic and redirects",async()=>isolated(async(store,botId)=>{
    let seen:Request|undefined;
    const apps=new WorkspaceApps(store,computer(request=>{seen=request;return new Response("app",{status:302,headers:{location:"http://localhost:3000/login","set-cookie":"app_session=value; Domain=preview.test; Path=/; HttpOnly","access-control-allow-origin":"*"}});}),botId,ORIGINS);
    const app=await apps.publish({name:"App",port:3000,operationId:"app"});
    const {cookie}=await authorize(apps,app);
    const response=await apps.preview(new Request(app.url+"api?value=1",{method:"POST",headers:{cookie:cookie+"; app_session=value",origin:ORIGINS.previewOrigin,authorization:"Bearer "+ownerSecret,"x-timber-secret":"internal-secret","cf-access-jwt-assertion":"private-jwt"},body:"payload"}),app.id,app.basePath+"api");
    expect(seen!.url).toContain(app.basePath+"api?value=1");
    expect(await seen!.text()).toBe("payload");
    expect(seen!.headers.get("authorization")).toBeNull();expect(seen!.headers.get("cf-access-jwt-assertion")).toBeNull();expect(seen!.headers.get("x-timber-secret")).toBeNull();
    expect(seen!.headers.get("cookie")).toBe("app_session=value");
    expect(response.headers.get("location")).toBe(app.url+"login");
    expect(response.headers.get("set-cookie")).toContain(`Path=${app.basePath}`);expect(response.headers.get("set-cookie")).not.toContain("Domain=");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();expect(response.headers.get("cache-control")).toBe("private, no-store");
  }));

  it("rejects cross-site changes, path escape, and malformed opening requests before reaching the app",async()=>isolated(async(store,botId)=>{
    let calls=0;
    const apps=new WorkspaceApps(store,computer(()=>{calls++;return new Response("ready");}),botId,ORIGINS);
    const app=await apps.publish({name:"App",port:3000,operationId:"app"}),{cookie}=await authorize(apps,app),before=calls;
    expect((await apps.preview(new Request(app.url,{method:"POST",headers:{cookie,origin:"https://attacker.test"},body:"x"}),app.id,app.basePath)).status).toBe(403);
    expect((await apps.preview(new Request(app.url,{method:"POST",headers:{cookie},body:"x"}),app.id,app.basePath)).status).toBe(403);
    expect((await apps.preview(new Request(app.url+"sw.js",{headers:{cookie,"service-worker":"script"}}),app.id,app.basePath+"sw.js")).status).toBe(403);
    await expect(apps.preview(new Request(app.url,{headers:{cookie}}),app.id,app.basePath+"../escape")).rejects.toMatchObject({code:"app_not_found"});
    await expect(apps.preview(new Request(app.url+"__timber_open",{method:"POST",headers:{origin:"https://attacker.test"}}),app.id,app.basePath+"__timber_open")).rejects.toMatchObject({code:"invalid_origin"});
    expect(calls).toBe(before);
  }));

  it("expires browser sessions and opening tickets independently",async()=>isolated(async(store,botId)=>{
    const apps=new WorkspaceApps(store,computer(()=>new Response("ready")),botId,ORIGINS);
    const app=await apps.publish({name:"App",port:3000,operationId:"app"}),{cookie}=await authorize(apps,app),open=await apps.open(app.id);
    for(const [key,record] of await store.list<{appId:string;expiresAt:number}>({prefix:"workspace-app-session:"})) await store.put(key,{...record,expiresAt:Date.now()-1});
    expect((await apps.preview(new Request(app.url,{headers:{cookie}}),app.id,app.basePath)).status).toBe(401);
    for(const [key,record] of await store.list<{appId:string;expiresAt:number}>({prefix:"workspace-app-ticket:"})) await store.put(key,{...record,expiresAt:Date.now()-1});
    await expect(apps.preview(new Request(open.actionUrl,{method:"POST",headers:{origin:ORIGINS.consoleOrigin,"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({ticket:open.ticket})}),app.id,app.basePath+"__timber_open")).rejects.toMatchObject({code:"invalid_app_ticket"});
  }));

  it("preserves an authenticated native WebSocket upgrade without replay",async()=>isolated(async(store,botId)=>{
    let upgrades=0;
    const apps=new WorkspaceApps(store,computer(request=>{
      if(request.headers.get("upgrade")!=="websocket")return new Response("ready");
      upgrades++;const pair=new WebSocketPair();pair[1].accept();pair[1].addEventListener("message",event=>pair[1].send(event.data));
      return new Response(null,{status:101,webSocket:pair[0]});
    }),botId,ORIGINS);
    const app=await apps.publish({name:"App",port:3000,operationId:"app"}),{cookie}=await authorize(apps,app);
    const response=await apps.preview(new Request(app.url+"hmr",{headers:{cookie,origin:ORIGINS.previewOrigin,upgrade:"websocket"}}),app.id,app.basePath+"hmr");
    expect(response.status).toBe(101);expect(upgrades).toBe(1);expect(response.webSocket).not.toBeNull();
    const socket=response.webSocket!;socket.accept();
    const message=new Promise<MessageEvent>(resolve=>socket.addEventListener("message",resolve,{once:true}));
    socket.send("hmr-check");expect((await message).data).toBe("hmr-check");socket.close(1000,"done");
  }));
});
