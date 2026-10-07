import {env} from "cloudflare:workers";
import {runInDurableObject} from "cloudflare:test";
import {afterEach,describe,expect,it,vi} from "vitest";
import type {ComputerResult} from "@botspace/contracts";
import {parseAction} from "../apps/api/src/validation";

const bindings=env as unknown as {REAL_COMPUTER:DurableObjectNamespace};
const capability="private-test-repository-capability-00000000";
afterEach(()=>vi.restoreAllMocks());

describe("managed Git computer transport",()=>{
  it("validates exact repository and branch identities and strips private transport from public actions",()=>{
    expect(parseAction({type:"gitClone",repository:"owner/repo",path:"repo",gitTransport:{token:capability}})).toEqual({type:"gitClone",repository:"owner/repo",path:"repo"});
    for(const branch of ["-force","a..b","a//b","a.lock","refs/.hidden","x/"]) {
      expect(()=>parseAction({type:"gitPush",repository:"owner/repo",path:"repo",branch})).toThrow();
    }
    for(const repository of ["owner/..","https://github.com/owner/repo","owner/repo.git/other"]) {
      expect(()=>parseAction({type:"gitClone",repository,path:"repo"})).toThrow();
    }
    expect(()=>parseAction({type:"gitPush",repository:"owner/repo",path:"repo"})).toThrow();
  });
  it("keeps a transient capability outside stable operation identity and revokes it after one effect",async()=>{
    const botId=crypto.randomUUID(),stub=bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId));
    await runInDurableObject(stub,async(instance,state)=>{
      const brokerCalls:string[]=[];
      let effects=0;
      const github={idFromName:(name:string)=>name,get:(name:string)=>{
        expect(name).toBe("owner");
        return {fetch:async(input:string,init:RequestInit)=>{
          const path=new URL(input).pathname;
          brokerCalls.push(`${init.method} ${path}`);
          if(init.method==="POST") {
            expect(JSON.parse(init.body as string)).toEqual({botId,repository:"owner/private",permission:"write"});
            return Response.json({id:"capability-id",url:"https://timber.example/github/git/owner/private.git",token:capability});
          }
          return Response.json({revoked:true});
        }};
      }};
      const container={running:true,async setInactivityTimeout(){},getTcpPort(){return{fetch:async(input:string,init:RequestInit)=>{
        if(new URL(input).pathname==="/health") return Response.json({ok:true,bootId:"boot",desktop:false,capabilities:["gitClone","gitPush"]});
        const body=JSON.parse(init.body as string);
        expect(body.gitTransport).toEqual({url:"https://timber.example/github/git/owner/private.git",token:capability});
        expect(body.action).toEqual({type:"gitPush",repository:"owner/private",path:"repo",branch:"timber/change"});
        effects++;
        return Response.json({status:"completed",output:"Branch pushed"});
      }}}};
      Object.defineProperty(instance,"container",{get:()=>container});
      Object.defineProperty(instance,"env",{value:{GITHUB:github}});
      const submit=()=>instance.fetch(new Request("https://computer.internal/actions",{method:"POST",body:JSON.stringify({botId,operationId:"push-branch",action:{type:"gitPush",repository:"owner/private",path:"repo",branch:"timber/change"}})}));
      const first=await (await submit()).json<ComputerResult>();
      expect(first.status).toBe("completed");
      expect(await (await submit()).json()).toEqual(first);
      expect(effects).toBe(1);
      expect(brokerCalls).toEqual(["POST /git-capability","DELETE /git-capability/capability-id"]);
      expect(JSON.stringify(await state.storage.get("operation:push-branch"))).not.toContain(capability);
    });
  });

  it("rejects old running images before journaling, restarting, or requesting credentials",async()=>{
    vi.spyOn(console,"error").mockImplementation(()=>{});
    const botId=crypto.randomUUID(),stub=bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId));
    await runInDurableObject(stub,async(instance,state)=>{
      let effects=0,restarts=0;
      const container={running:true,async setInactivityTimeout(){},start(){restarts++;},destroy(){restarts++;},getTcpPort(){return{fetch:async(input:string)=>{
        if(new URL(input).pathname!=="/health") effects++;
        return Response.json({ok:true,bootId:"old-image",desktop:true});
      }}}};
      Object.defineProperty(instance,"container",{get:()=>container});
      const response=await instance.fetch(new Request("https://computer.internal/actions",{method:"POST",body:JSON.stringify({botId,operationId:"not-executed",action:{type:"gitClone",repository:"owner/private",path:"repo"}})}));
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({error:{code:"computer_upgrade_required"}});
      expect(await state.storage.get("operation:not-executed")).toBeUndefined();
      expect(effects).toBe(0);
      expect(restarts).toBe(0);
    });
  });

  it("revokes a capability after uncertain transport failure without exposing it or replaying",async()=>{
    vi.spyOn(console,"error").mockImplementation(()=>{});
    const botId=crypto.randomUUID(),stub=bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId));
    await runInDurableObject(stub,async(instance)=>{
      let revoked=0,effects=0;
      Object.defineProperty(instance,"env",{value:{GITHUB:{idFromName:()=>"owner",get:()=>({fetch:async(_input:string,init:RequestInit)=>{
        if(init.method==="DELETE") {revoked++;return Response.json({revoked:true});}
        return Response.json({id:"temporary",url:"https://timber.example/github/git/owner/repo.git",token:capability});
      }})}}});
      Object.defineProperty(instance,"container",{get:()=>({running:true,async setInactivityTimeout(){},getTcpPort(){return{fetch:async(input:string)=>{
        if(new URL(input).pathname==="/health") return Response.json({ok:true,bootId:"boot",desktop:false,capabilities:["gitPush"]});
        effects++;
        throw new Error(capability);
      }}}})});
      const submit=()=>instance.fetch(new Request("https://computer.internal/actions",{method:"POST",body:JSON.stringify({botId,operationId:"uncertain-push",action:{type:"gitPush",repository:"owner/repo",path:"repo",branch:"change"}})}));
      const result=await (await submit()).json<ComputerResult>();
      expect(result.status).toBe("interrupted");
      expect(JSON.stringify(result)).not.toContain(capability);
      expect(await (await submit()).json()).toEqual(result);
      expect(effects).toBe(1);
      expect(revoked).toBe(1);
    });
  });

  it("reports a denied capability as not executed instead of an uncertain computer effect",async()=>{
    vi.spyOn(console,"error").mockImplementation(()=>{});
    const botId=crypto.randomUUID(),stub=bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId));
    await runInDurableObject(stub,async(instance)=>{
      let effects=0;
      Object.defineProperty(instance,"env",{value:{GITHUB:{idFromName:()=>"owner",get:()=>({fetch:async()=>new Response("Revoked",{status:403})})}}});
      Object.defineProperty(instance,"container",{get:()=>({running:true,async setInactivityTimeout(){},getTcpPort(){return{fetch:async(input:string)=>{
        if(new URL(input).pathname==="/health") return Response.json({ok:true,bootId:"boot",desktop:false,capabilities:["gitPush"]});
        effects++;
        return Response.json({status:"completed"});
      }}}})});
      const response=await instance.fetch(new Request("https://computer.internal/actions",{method:"POST",body:JSON.stringify({botId,operationId:"revoked-push",action:{type:"gitPush",repository:"owner/repo",path:"repo",branch:"change"}})}));
      const result=await response.json<ComputerResult>();
      expect(result.status).toBe("failed");
      expect(result.error).toContain("No Git action was executed");
      expect(effects).toBe(0);
    });
  });
});
