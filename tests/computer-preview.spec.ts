import {env} from "cloudflare:workers";
import {runInDurableObject} from "cloudflare:test";
import {afterEach,describe,expect,it,vi} from "vitest";

const bindings=env as unknown as {REAL_COMPUTER:DurableObjectNamespace};
afterEach(()=>vi.restoreAllMocks());

describe("computer app preview forwarding",()=>{
  it("preserves native WebSocket upgrade responses",async()=>{
    const botId=crypto.randomUUID(),stub=bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId));
    await runInDurableObject(stub,async(instance,state)=>{
      await state.storage.put("botId",botId);
      const pair=new WebSocketPair();
      pair[1].accept();
      Object.defineProperty(instance,"container",{get:()=>({running:true,async setInactivityTimeout(){},getTcpPort(){return{fetch:async(request:Request)=>{
        expect(request.headers.get("Upgrade")).toBe("websocket");
        return new Response(null,{status:101,webSocket:pair[0]});
      }}}})});
      const response=await instance.fetch(new Request("https://computer.internal/preview/3000/apps/example/socket",{headers:{"x-timber-bot-id":botId,Upgrade:"websocket"}}));
      expect(response.status).toBe(101);
      expect(response.webSocket).toBe(pair[0]);
      pair[1].close(1000,"test complete");
    });
  });
  it("retains app paths and cookies while removing platform credentials and renewing only a running VM",async()=>{
    const botId=crypto.randomUUID(),stub=bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId));
    await runInDurableObject(stub,async(instance,state)=>{
      await state.storage.put("botId",botId);
      let starts=0,effects=0,renewals=0;
      Object.defineProperty(instance,"container",{get:()=>({running:true,start(){starts++;},async setInactivityTimeout(){renewals++;},getTcpPort(port:number){
        expect(port).toBe(3000);
        return {fetch:async(request:Request)=>{
          effects++;
          expect(request.url).toBe(`http://127.0.0.1:3000/apps/${botId}.app/index?x=1`);
          expect(request.headers.get("Host")).toBe("localhost:3000");
          expect(request.headers.get("authorization")).toBeNull();
          expect(request.headers.get("x-timber-bot-id")).toBeNull();
          expect(request.headers.get("x-botspace-config")).toBeNull();
          expect(request.headers.get("cookie")).toBe("app-session=app-cookie");
          expect(request.headers.get("Origin")).toBe("https://preview.example");
          expect(await request.text()).toBe("app body");
          return new Response("app response");
        }};
      }})});
      const response=await instance.fetch(new Request(`https://computer.internal/preview/3000/apps/${botId}.app/index?x=1`,{
        method:"POST",headers:{"x-timber-bot-id":botId,"authorization":"Bearer platform-owner-secret","x-botspace-config":"private","cookie":"app-session=app-cookie","Origin":"https://preview.example"},body:"app body",
      }));
      expect(await response.text()).toBe("app response");
      expect(effects).toBe(1);
      expect(starts).toBe(0);
      expect(renewals).toBe(1);
      expect(await state.storage.get("lastActivity")).toBeTypeOf("number");
    });
  });

  it("refuses control ports, other bots and stopped computers without booting or probing",async()=>{
    vi.spyOn(console,"error").mockImplementation(()=>{});
    const botId=crypto.randomUUID(),stub=bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId));
    await runInDurableObject(stub,async(instance,state)=>{
      await state.storage.put("botId",botId);
      let starts=0,probes=0;
      Object.defineProperty(instance,"container",{get:()=>({running:false,start(){starts++;},getTcpPort(){probes++;throw new Error("must not forward");}})});
      const request=(port:number,owner=botId)=>instance.fetch(new Request(`https://computer.internal/preview/${port}/app`,{headers:{"x-timber-bot-id":owner}}));
      expect((await request(8080)).status).toBe(400);
      expect((await request(80)).status).toBe(400);
      expect((await request(65536)).status).toBe(400);
      expect((await request(3000,crypto.randomUUID())).status).toBe(403);
      const stopped=await request(3000);
      expect(stopped.status).toBe(503);
      expect(await stopped.json()).toMatchObject({error:{code:"computer_app_not_running"}});
      expect(starts).toBe(0);
      expect(probes).toBe(0);
      expect(await state.storage.get("lastActivity")).toBeUndefined();
    });
  });
});
