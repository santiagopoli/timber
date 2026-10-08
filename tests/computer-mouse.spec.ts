import {env} from "cloudflare:workers";
import {runInDurableObject} from "cloudflare:test";
import {describe,expect,it} from "vitest";
import type {ComputerAction,ComputerResult,ComputerStatus} from "@botspace/contracts";

const bindings=env as unknown as {REAL_COMPUTER:DurableObjectNamespace};
const actions:ComputerAction[]=[
  {type:"move",x:200,y:300},
  {type:"doubleClick",x:200,y:300,button:"right"},
  {type:"drag",fromX:200,fromY:300,toX:500,toY:400,durationMs:700},
];
const request=(path:string,botId:string,extra={})=>new Request(`https://computer.internal${path}`,{method:"POST",body:JSON.stringify({botId,...extra})});

describe("native mouse capabilities",()=>{
  it("only advertises extended mouse tools after the actual computer reports them",async()=>{
    const botId=crypto.randomUUID(),stub=bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId));
    await runInDurableObject(stub,async instance=>{
      let capabilities:string[]=[],desktop=true;
      Object.defineProperty(instance,"container",{get:()=>({running:true,getTcpPort(){return {fetch:async()=>Response.json({ok:true,bootId:"existing",desktop,capabilities})};}})});
      const status=async()=>(await instance.fetch(request("/status",botId))).json<ComputerStatus>();
      expect((await status()).capabilities).not.toContain("move");
      capabilities=["move","doubleClick","drag"];
      expect((await status()).capabilities).toEqual(expect.arrayContaining(capabilities));
      desktop=false;
      expect((await status()).capabilities).not.toContain("drag");
    });
  });

  it.each(actions)("rejects old images before dispatch/journaling, then executes $type once",async action=>{
    const botId=crypto.randomUUID(),stub=bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId));
    await runInDurableObject(stub,async(instance,state)=>{
      let capabilities:string[]=[];
      const dispatched:unknown[]=[];
      Object.defineProperty(instance,"container",{get:()=>({
        running:true,async setInactivityTimeout(){},
        getTcpPort(){return {fetch:async(input:string,init?:RequestInit)=>{
          if(new URL(input).pathname==="/health") return Response.json({ok:true,bootId:"existing",desktop:true,capabilities});
          dispatched.push(JSON.parse(init!.body as string).action);
          return Response.json({status:"completed",output:"native gesture delivered"});
        }};},
      })});
      const operationId=`mouse-${action.type}`;
      const execute=()=>instance.fetch(request("/actions",botId,{operationId,action}));
      const unavailable=await execute();
      expect(unavailable.status).toBe(409);
      expect(await unavailable.json()).toMatchObject({error:{code:"computer_upgrade_required"}});
      expect(await state.storage.get(`operation:${operationId}`)).toBeUndefined();
      expect(dispatched).toEqual([]);
      capabilities=[action.type];
      const completed=await (await execute()).json<ComputerResult>();
      expect(completed.status).toBe("completed");
      expect(await (await execute()).json()).toEqual(completed);
      expect(dispatched).toEqual([action]);
    });
  });
});
