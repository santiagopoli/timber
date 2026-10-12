import {env} from "cloudflare:workers";
import {runInDurableObject} from "cloudflare:test";
import {describe,it,expect} from "vitest";
import {secureDeployComputerRoute} from "../packages/computer/src/secure-deploy-do";
import type {Env} from "../apps/api/src/env";

const bindings=env as unknown as Env & {REAL_COMPUTER:DurableObjectNamespace};
// Synthetic fixture only; never use a real credential in boundary tests.
const canary="synthetic-shell-private-exclusion-canary";
const request=(botId:string,path:string,body?:object,signal?:AbortSignal)=>new Request(`https://computer.internal${path}`,{method:body?"POST":"GET",headers:{"x-timber-bot-id":botId},...(body?{body:JSON.stringify(body)}:{}),...(signal?{signal}:{})});
function input(botId:string,operationId=crypto.randomUUID()) {
  const planId=crypto.randomUUID(),refId=crypto.randomUUID(),accountId="c".repeat(32);
  const pin={repository:"acme/widget",commit:"a".repeat(40),artifactDigest:`sha256:${"b".repeat(64)}`,artifactPath:"dist/worker.js",accountId,workerName:"widget-test",destination:`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/widget-test`};
  const refs=[{id:refId,revision:1,permissionEpoch:"synthetic-epoch",binding:"synthetic-reference-binding"}];
  return {operationId,pin,refs,authorization:{version:1,ownerId:"owner",botId,runId:crypto.randomUUID(),nativeOperationId:"native-fixture",operationId,pin:{...pin,planId,planRevision:1},planId,planRevision:1,refs,expiresAt:Date.now()+60_000,signature:"synthetic-signature"},credentials:[{refId,revision:1,header:"Authorization",prefix:"Bearer ",value:canary}]};
}
// ComputerDO.fetch can return an immediate Response; normalize without casting
// so the concurrency tests observe both sync and async route completions.
async function fetchResponse(computer:{fetch(request:Request):Response|Promise<Response>},req:Request):Promise<Response>{return computer.fetch(req);}
async function fireAlarm(computer:{alarm?:()=>void|Promise<void>}):Promise<void>{
  if(typeof computer.alarm!=="function")throw new Error("Real ComputerDO must expose alarm cleanup");
  await computer.alarm();
}
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return{promise,resolve};}
async function promptly<T>(promise:Promise<T>):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("Control request waited behind private dispatch")),1_000);})]);}finally{clearTimeout(timer);}
}
async function setup(instance:any,state:DurableObjectState,botId:string,options:{verify?:()=>Promise<Response>;dispatch?:(body:ReturnType<typeof input>)=>Promise<Response>;close?:(operationId:string)=>Promise<Response>;health?:()=>{ok:boolean;bootId:string;desktop:boolean;capabilities:string[]};initiallyStopped?:boolean}={}){
  await state.storage.put("botId",botId);
  const paths:string[]=[],verifications:string[]=[];
  const workspace={idFromName:(name:string)=>name,get:()=>({fetch:async(req:Request)=>{
    const path=new URL(req.url).pathname;
    if(path===`/${botId}`)return Response.json({bot:{id:botId}});
    expect(path).toBe("/keychain/deploy-verify");
    const metadata=await req.text();expect(metadata).not.toContain(canary);verifications.push(metadata);
    return options.verify?options.verify():Response.json({});
  }})};
  Object.defineProperty(instance,"env",{value:{...bindings,WORKSPACE:workspace}});
  Object.defineProperty(instance,"initializeWorkspace",{value:async()=>options.health?options.health():({ok:true,bootId:"private-fixture-boot",desktop:true,capabilities:["shellPty","liveDesktop"]})});
  let running=!options.initiallyStopped;
  Object.defineProperty(instance,"container",{get:()=>({get running(){return running;},async setInactivityTimeout(){},async destroy(){running=false;},getTcpPort(port:number){
    expect(port).toBe(8080);return{fetch:async(url:string)=>{expect(new URL(url).pathname).toBe("/shell/close");return Response.json({ok:true});}};
  }})});
  Object.defineProperty(instance,"call",{value:async(path:string,init:RequestInit={})=>{
    paths.push(path);
    if(path==="/shell/close")return Response.json({ok:true});
    if(path==="/secure-deploy/close" && options.close){
      const metadata=String(init.body);expect(metadata).not.toContain(canary);
      expect(Object.keys(JSON.parse(metadata))).toEqual(["operationId"]);
      return options.close(JSON.parse(metadata).operationId);
    }
    if(path==="/secure-deploy/cancel")return Response.json({operationId:JSON.parse(String(init.body)).operationId,result:"already_dispatched"});
    if(path==="/secure-deploy"){
      const body=JSON.parse(String(init.body)) as ReturnType<typeof input>;
      expect(body.credentials[0].value).toBe(canary);
      return options.dispatch?options.dispatch(body):Response.json({operationId:body.operationId,status:"completed",code:"deploy_accepted",quiescent:true});
    }
    throw new Error("Unexpected private fixture path");
  }});
  return {paths,verifications};
}
async function assertNoCredentialStorage(state:DurableObjectState){
  expect(JSON.stringify([...(await state.storage.list()).entries()])).not.toContain(canary);
}

describe("shell / desktop / private operation mutual exclusion",()=>{
  for(const owner of ["shell","closing-shell","desktop","managed-command"] as const)it(`rejects private capabilities and dispatch while ${owner} owns the workspace`,async()=>{
    const botId=crypto.randomUUID(),stub=bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId));
    await runInDurableObject(stub,async(instance,state)=>{
      const f=await setup(instance,state,botId);
      let sessionId:string|undefined;
      if(owner==="shell" || owner==="closing-shell"){
        const response=await fetchResponse(instance,request(botId,"/shell",{}));expect(response.status).toBe(200);
        ({sessionId}=await response.json<{sessionId:string}>());
        if(owner==="closing-shell"){
          const record=await state.storage.get<Record<string,unknown>>(`shell:${sessionId}`);
          await state.storage.put(`shell:${sessionId}`,{...record,closing:true,expires:Date.now()-1});
        }
      }else if(owner==="desktop"){
        const response=await fetchResponse(instance,request(botId,"/desktop",{mode:"control"}));expect(response.status).toBe(200);
        ({sessionId}=await response.json<{sessionId:string}>());
      }else await state.storage.put("exec-work:fixture-command",{status:"running"});
      const capability=await fetchResponse(instance,request(botId,"/secure-deploy/capabilities"));
      expect(await capability.json()).toMatchObject({secureDeploy:false});
      const body=input(botId),response=await fetchResponse(instance,request(botId,"/secure-deploy",body));
      expect(await response.json()).toEqual({operationId:body.operationId,status:"unavailable",code:"runner_unavailable"});
      expect(f.paths).toEqual([]);expect(f.verifications).toEqual([]);
      await assertNoCredentialStorage(state);
      if(owner==="desktop")expect((await fetchResponse(instance,new Request(`https://computer.internal/desktop/${sessionId}`,{method:"DELETE",headers:{"x-timber-bot-id":botId}}))).status).toBe(200);
      else if(sessionId)expect((await fetchResponse(instance,new Request(`https://computer.internal/shell/${sessionId}`,{method:"DELETE",headers:{"x-timber-bot-id":botId}}))).status).toBe(200);
      else await state.storage.delete("exec-work:fixture-command");
    });
  });

  it("holds new shell/control admission through the private receipt but leaves cancellation responsive",async()=>{
    const botId=crypto.randomUUID(),stub=bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId));
    await runInDurableObject(stub,async(instance,state)=>{
      const entered=deferred(),finish=deferred(),body=input(botId);
      const f=await setup(instance,state,botId,{dispatch:async()=>{entered.resolve();await finish.promise;return Response.json({operationId:body.operationId,status:"completed",code:"deploy_accepted",quiescent:true});}});
      const deploying=fetchResponse(instance,request(botId,"/secure-deploy",body));
      await entered.promise;
      let shellFinished=false,controlFinished=false;
      const shell=fetchResponse(instance,request(botId,"/shell",{})).then(r=>{shellFinished=true;return r;});
      const control=fetchResponse(instance,request(botId,"/desktop",{mode:"control"})).then(r=>{controlFinished=true;return r;});
      try{
        const cancel=await promptly(fetchResponse(instance,request(botId,"/secure-deploy/cancel",{operationId:body.operationId})));
        expect(await cancel.json()).toEqual({operationId:body.operationId,result:"already_dispatched"});
        expect(shellFinished).toBe(false);expect(controlFinished).toBe(false);
        expect((await state.storage.get("privateOperation"))).toMatchObject({operationId:body.operationId});
        await assertNoCredentialStorage(state);
      }finally{finish.resolve();}
      expect(await (await deploying).json()).toEqual({operationId:body.operationId,status:"completed",code:"deploy_accepted"});
      const opened=await shell;expect(opened.status).toBe(200);expect((await control).status).toBe(409);
      expect((await state.storage.get("privateOperation"))).toBeUndefined();
      const grant=await opened.json<{sessionId:string}>();
      expect((await fetchResponse(instance,new Request(`https://computer.internal/shell/${grant.sessionId}`,{method:"DELETE",headers:{"x-timber-bot-id":botId}}))).status).toBe(200);
      expect(f.paths.filter(p=>p==="/secure-deploy")).toHaveLength(1);
    });
  });

  it("rechecks Stop after awaited authority and releases a never-dispatched reservation",async()=>{
    const botId=crypto.randomUUID(),stub=bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId));
    await runInDurableObject(stub,async(instance,state)=>{
      const entered=deferred(),finish=deferred(),abort=new AbortController();
      const f=await setup(instance,state,botId,{verify:async()=>{entered.resolve();await finish.promise;return Response.json({});}});
      const deploying=fetchResponse(instance,request(botId,"/secure-deploy",input(botId),abort.signal));
      await entered.promise;abort.abort();finish.resolve();
      expect(await (await deploying).json()).toMatchObject({status:"unavailable",code:"runner_unavailable"});
      expect(f.paths).toEqual([]);expect(f.verifications).toHaveLength(1);
      expect((await state.storage.get("privateOperation"))).toBeUndefined();
      await assertNoCredentialStorage(state);
    });
  });

  for(const failure of ["transport","malformed","nonOK","duplicate","unproven"] as const)it(`retains the private fence after ${failure} uncertainty, including after cancel`,async()=>{
    const botId=crypto.randomUUID(),stub=bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId));
    await runInDurableObject(stub,async(instance,state)=>{
      const body=input(botId);
      await setup(instance,state,botId,{dispatch:async()=>{
        if(failure==="transport")throw new Error(canary);
        if(failure==="unproven")return Response.json({operationId:body.operationId,status:"completed",code:"deploy_accepted"});
        if(failure==="nonOK")return new Response("private failure",{status:503});
        if(failure==="malformed")return Response.json({operationId:body.operationId,status:"completed",code:"untrusted",output:canary});
        return Response.json({operationId:body.operationId,status:"interrupted",code:"dispatch_already_seen"});
      }});
      const result=await (await fetchResponse(instance,request(botId,"/secure-deploy",body))).text();
      expect(result).not.toContain(canary);expect(JSON.parse(result)).toMatchObject({status:failure==="nonOK"?"unavailable":failure==="unproven"?"completed":"interrupted"});
      const cancel=await promptly(fetchResponse(instance,request(botId,"/secure-deploy/cancel",{operationId:body.operationId})));
      expect(await cancel.json()).toMatchObject({result:"already_dispatched"});
      expect((await state.storage.get("privateOperation"))).toMatchObject({operationId:body.operationId});
      expect((await fetchResponse(instance,request(botId,"/shell",{}))).status).toBe(409);
      expect((await fetchResponse(instance,request(botId,"/desktop",{mode:"control"}))).status).toBe(409);
      const operationId=crypto.randomUUID();
      const checkpoint=await fetchResponse(instance,new Request("https://computer.internal/actions",{method:"POST",body:JSON.stringify({botId,operationId,action:{type:"checkpoint"}})}));
      expect(await checkpoint.json()).toMatchObject({status:"failed"});
      expect(await state.storage.get(`operation:${operationId}`)).toBeUndefined();
      await assertNoCredentialStorage(state);
    });
  });

  it("alarm cleanup retains a lost-response reservation across a simulated boot change until positive proof",async()=>{
    const botId=crypto.randomUUID(),stub=bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId));
    await runInDurableObject(stub,async(instance,state)=>{
      const body=input(botId);let bootId="old-private-boot",readiness=0,quiescent=false;
      const f=await setup(instance,state,botId,{health:()=>{readiness++;return{ok:true,bootId,desktop:true,capabilities:["shellPty","liveDesktop"]};},dispatch:async()=>{throw new Error("Synthetic lost HTTP receipt");},close:async operationId=>Response.json({operationId,quiescent})});
      await state.storage.put("lastActivity",Date.now());
      expect(await (await fetchResponse(instance,request(botId,"/secure-deploy",body))).json()).toMatchObject({status:"interrupted"});
      expect(await state.storage.get("privateOperation")).toEqual({operationId:body.operationId,bootId});
      expect(await state.storage.getAlarm()).not.toBeNull();expect(readiness).toBe(1);
      // No actual eviction is necessary: admission and alarm deliberately read
      // only the persisted marker, not closure/boot-local execution state.
      bootId="replacement-private-boot";
      expect((await fetchResponse(instance,request(botId,"/shell",{}))).status).toBe(409);
      expect(await (await fetchResponse(instance,request(botId,"/secure-deploy/capabilities"))).json()).toMatchObject({secureDeploy:false});
      await fireAlarm(instance);
      expect(await state.storage.get("privateOperation")).toEqual({operationId:body.operationId,bootId:"old-private-boot"});
      expect(await state.storage.getAlarm()).not.toBeNull();expect(readiness).toBe(1);
      expect(f.paths.filter(p=>p==="/secure-deploy/close")).toHaveLength(1);
      quiescent=true;await fireAlarm(instance);
      expect(await state.storage.get("privateOperation")).toBeUndefined();expect(readiness).toBe(1);
      const opened=await fetchResponse(instance,request(botId,"/shell",{}));expect(opened.status).toBe(200);expect(readiness).toBe(2);
      const grant=await opened.json<{sessionId:string}>();
      expect((await fetchResponse(instance,new Request(`https://computer.internal/shell/${grant.sessionId}`,{method:"DELETE",headers:{"x-timber-bot-id":botId}}))).status).toBe(200);
      await assertNoCredentialStorage(state);
    });
  });

  it("alarm can clear a recovered metadata-only reservation when the VM is confirmed stopped, without startup",async()=>{
    const botId=crypto.randomUUID(),stub=bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId));
    await runInDurableObject(stub,async(instance,state)=>{
      let readiness=0;
      const f=await setup(instance,state,botId,{initiallyStopped:true,health:()=>{readiness++;throw new Error("Cleanup must not restore or start a VM");}});
      await state.storage.put({privateOperation:{operationId:crypto.randomUUID(),bootId:"previous-boot"},lastActivity:Date.now()});
      expect((await fetchResponse(instance,request(botId,"/shell",{}))).status).toBe(409);
      await fireAlarm(instance);
      expect(await state.storage.get("privateOperation")).toBeUndefined();expect(readiness).toBe(0);expect(f.paths).toEqual([]);
      await assertNoCredentialStorage(state);
    });
  });

  it("requires authenticated quiescence proof before suspend can clear uncertainty and save",async()=>{
    const botId=crypto.randomUUID(),stub=bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId));
    await runInDurableObject(stub,async(instance,state)=>{
      const body=input(botId);let quiescent=false,saves=0,closes=0;
      await setup(instance,state,botId,{dispatch:async()=>{throw new Error("Synthetic lost private response");},close:async operationId=>{
        expect(operationId).toBe(body.operationId);closes++;
        return Response.json({operationId,quiescent});
      }});
      Object.defineProperty(instance,"saveCheckpoint",{value:async()=>{
        expect(await state.storage.get("privateOperation")).toBeUndefined();saves++;return{id:crypto.randomUUID()};
      }});
      Object.defineProperty(instance,"status",{value:async()=>({state:"stopped"})});
      expect(await (await fetchResponse(instance,request(botId,"/secure-deploy",body))).json()).toMatchObject({status:"interrupted"});
      const suspend=()=>fetchResponse(instance,new Request("https://computer.internal/suspend",{method:"POST",body:JSON.stringify({botId})}));
      expect((await suspend()).status).toBe(409);expect(saves).toBe(0);
      expect(await state.storage.get("privateOperation")).toMatchObject({operationId:body.operationId});
      quiescent=true;expect((await suspend()).status).toBe(200);expect(saves).toBe(1);expect(closes).toBe(2);
      expect(await state.storage.get("privateOperation")).toBeUndefined();await assertNoCredentialStorage(state);
    });
  });

  it("fails closed without a lifecycle hook but never puts cancellation behind that hook",async()=>{
    const botId=crypto.randomUUID(),body=input(botId),paths:string[]=[];
    const computer={active(){},ctx:{storage:{get:async()=>botId}},env:{WORKSPACE:{}},container:{running:true},call:async(path:string)=>{paths.push(path);return Response.json({operationId:body.operationId,result:"cancelled"});}};
    const response=await secureDeployComputerRoute(computer,request(botId,"/secure-deploy",body),"/secure-deploy");
    expect(await response.json()).toEqual({operationId:body.operationId,status:"unavailable",code:"runner_unavailable"});
    expect(paths).toEqual([]);
    const cancel=await secureDeployComputerRoute(computer,request(botId,"/secure-deploy/cancel",{operationId:body.operationId}),"/secure-deploy/cancel",async()=>{throw new Error("Cancellation entered the effect gate");});
    expect(await cancel.json()).toEqual({operationId:body.operationId,result:"cancelled"});expect(paths).toEqual(["/secure-deploy/cancel"]);
  });
});
