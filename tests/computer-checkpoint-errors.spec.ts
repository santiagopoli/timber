import {env} from "cloudflare:workers";
import {runInDurableObject} from "cloudflare:test";
import {afterEach,describe,expect,it,vi} from "vitest";
import type {ComputerResult} from "@botspace/contracts";

const bindings=env as unknown as {REAL_COMPUTER:DurableObjectNamespace};
const request=(botId:string,operationId:string,action:object)=>new Request("https://computer/actions",{method:"POST",body:JSON.stringify({botId,operationId,action})});
afterEach(()=>vi.restoreAllMocks());

describe("checkpoint failures preserve known computer outcomes",()=>{
  it.each([
    ["Workspace changed during checkpoint; stop background writers and retry","computer_checkpoint_changed","Background processes changed workspace files"],
    ["Workspace exceeds checkpoint limit (256 MiB, 10000 entries)","computer_checkpoint_limit","256 MiB or 10,000 entries"],
    ["Compressed checkpoint exceeds limit","computer_checkpoint_limit","256 MiB or 10,000 entries"],
    ["Checkpoint contains an escaping symlink: private-secret-path","computer_checkpoint_nonportable","external symlink or a special file"],
    ["Checkpoint contains a nonportable special file: private-secret-path","computer_checkpoint_nonportable","external symlink or a special file"],
    ["arbitrary private-secret-path provider response","computer_checkpoint_failed","could not create a workspace checkpoint"],
  ])("classifies %s without replaying the completed action or leaking paths",async(message,code,detail)=>{
    const log=vi.spyOn(console,"error").mockImplementation(()=>{});
    const botId=crypto.randomUUID(),stub=bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId));
    await runInDurableObject(stub,async(instance,state)=>{
      let effects=0,checkpoints=0,uploads=0,recovered=false;
      Object.defineProperty(instance,"env",{value:{FILES:{async put(_key:string,body:ReadableStream){await new Response(body).arrayBuffer();uploads++;return {size:1};}}}});
      Object.defineProperty(instance,"container",{get:()=>({running:true,async setInactivityTimeout(){},getTcpPort(){return {async fetch(input:string){
        const path=new URL(input).pathname;
        if(path==="/health")return Response.json({ok:true,bootId:"known",desktop:true,capabilities:["execSessions"]});
        if(path==="/actions"){effects++;return Response.json({status:"completed",exitCode:0,output:"Source files created"});}
        expect(path).toBe("/checkpoint");checkpoints++;
        return recovered?new Response("x",{headers:{"content-length":"1","x-content-sha256":"0".repeat(64)}}):Response.json({error:message},{status:400});
      }};}})});
      const action={type:"exec",command:"create source files"};
      const result=await (await instance.fetch(request(botId,"write-once",action))).json<ComputerResult>();
      expect(result).toMatchObject({status:"completed",exitCode:0,output:"Source files created",error:expect.stringContaining(detail!)});
      expect(result.checkpointId).toBeUndefined();expect(result.error).not.toContain("private-secret-path");
      expect(log).toHaveBeenCalledWith("computer.failure",{stage:"checkpoint",code});
      expect(JSON.stringify(log.mock.calls)).not.toContain("private-secret-path");
      expect(await state.storage.get("lastCheckpoint")).toBeUndefined();expect(uploads).toBe(0);
      // Re-requesting the original operation returns its actual result, never its effect.
      expect(await (await instance.fetch(request(botId,"write-once",action))).json()).toEqual(result);
      expect(effects).toBe(1);expect(checkpoints).toBe(1);
      recovered=true;
      const saved=await (await instance.fetch(request(botId,"save-existing-files",{type:"checkpoint"}))).json<ComputerResult>();
      expect(saved.status).toBe("completed");expect(saved.checkpointId).toBeTruthy();
      expect(effects).toBe(1);expect(checkpoints).toBe(2);expect(uploads).toBe(1);
      expect(await state.storage.get("lastCheckpoint")).toMatchObject({id:saved.checkpointId});
    });
  });

  it("returns the actionable checkpoint failure instead of claiming an unknown command outcome",async()=>{
    vi.spyOn(console,"error").mockImplementation(()=>{});
    const botId=crypto.randomUUID(),stub=bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId));
    await runInDurableObject(stub,async instance=>{
      Object.defineProperty(instance,"container",{get:()=>({running:true,async setInactivityTimeout(){},getTcpPort(){return {async fetch(input:string){
        if(new URL(input).pathname==="/health")return Response.json({ok:true,bootId:"known",desktop:true,capabilities:["execSessions"]});
        return Response.json({error:"Workspace changed during checkpoint; stop background writers and retry"},{status:400});
      }};}})});
      const result=await (await instance.fetch(request(botId,"checkpoint-only",{type:"checkpoint"}))).json<ComputerResult>();
      expect(result.status).toBe("failed");expect(result.error).toContain("Background processes changed");
      expect(result.error).not.toContain("action may have completed");
    });
  });

  it("retains a timeout exit and partial output when checkpoint also fails",async()=>{
    vi.spyOn(console,"error").mockImplementation(()=>{});
    const botId=crypto.randomUUID(),stub=bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId));
    await runInDurableObject(stub,async instance=>{
      Object.defineProperty(instance,"container",{get:()=>({running:true,async setInactivityTimeout(){},getTcpPort(){return {async fetch(input:string){
        const path=new URL(input).pathname;
        if(path==="/health")return Response.json({ok:true,bootId:"known",desktop:true,capabilities:["execSessions"]});
        if(path==="/actions")return Response.json({status:"failed",exitCode:-9,output:"partial install",error:"Command timed out; its process group was terminated. External effects may have occurred."});
        return Response.json({error:"Workspace changed during checkpoint; stop background writers and retry"},{status:400});
      }};}})});
      const result=await (await instance.fetch(request(botId,"timed-out-install",{type:"exec",command:"install dependencies"}))).json<ComputerResult>();
      expect(result).toMatchObject({status:"failed",exitCode:-9,output:"partial install"});
      expect(result.error).toContain("Command timed out");expect(result.error).toContain("Background processes changed");
    });
  });
});
