import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ComputerAction, ComputerResult } from "@botspace/contracts";

const bindings = env as unknown as {REAL_COMPUTER: DurableObjectNamespace};
async function digest(action: ComputerAction) {
  const data = new TextEncoder().encode(JSON.stringify(action, Object.keys(action).sort()));
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", data)), byte => byte.toString(16).padStart(2, "0")).join("");
}
async function action(stub: DurableObjectStub, botId: string, operationId: string, value: ComputerAction) {
  const response = await stub.fetch("https://computer.internal/actions", {
    method: "POST", body: JSON.stringify({botId, operationId, action: value}),
  });
  expect(response.status).toBe(200);
  return response.json<ComputerResult>();
}

describe("real ComputerDO journal recovery without a container", () => {
  it("returns an actionable 503 before journaling an action when its container is not configured", async () => {
    const botId = crypto.randomUUID();
    const stub = bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId));
    const response = await stub.fetch("https://computer.internal/actions", {
      method: "POST", body: JSON.stringify({botId, operationId: "not-started", action: {type: "listFiles"}}),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({error: {code: "computer_not_configured", message: "The cloud computer binding is not configured."}});
    const record = await runInDurableObject(stub, (_instance, state) => state.storage.get("operation:not-started"));
    expect(record).toBeUndefined();
  });

  it("does not replay an action whose outcome was unknown before object eviction", async () => {
    const botId = crypto.randomUUID();
    const stub = bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId));
    const request: ComputerAction = {type: "exec", command: "external-side-effect"};
    const hash = await digest(request);
    await runInDurableObject(stub, async (_instance, state) => {
      // These raw rows simulate the journal produced before compact indexes.
      await state.storage.delete("journalIndexesV1");
      await state.storage.put("operation:unknown-action", {digest: hash});
    });
    await evictDurableObject(stub);
    const result = await action(stub, botId, "unknown-action", request);
    expect(result.status).toBe("interrupted");
    expect(result.error).toContain("Inspect effects");
    expect(await action(stub, botId, "unknown-action", request)).toEqual(result);
    // There is no container in this suite: trying to run the command would fail,
    // rather than return this previously persisted interrupted journal result.
    const changed = await action(stub, botId, "unknown-action", {type: "exec", command: "different-side-effect"});
    expect(changed.status).toBe("failed");
    expect(changed.error).toContain("different arguments");
  });

  it("returns a completed result after eviction without starting a fresh computer", async () => {
    const botId = crypto.randomUUID();
    const stub = bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId));
    const request: ComputerAction = {type: "writeFile", path: "notes.txt", content: "done"};
    const result: ComputerResult = {operationId: "completed-action", status: "completed", output: "already done", checkpointId: "saved-checkpoint"};
    const hash = await digest(request);
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("operation:completed-action", {digest: hash, result});
    });
    await evictDurableObject(stub);
    expect(await action(stub, botId, "completed-action", request)).toEqual(result);
  });
});

it('reconciles a lost browser receipt without starting a computer, replaying its click or exposing its output',async()=>{
 const botId=crypto.randomUUID(),stub=bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId));
 const original:ComputerAction={type:'click',x:10,y:20};
 await runInDurableObject(stub,async(_,state)=>{
  await state.storage.put('operation:click-receipt',{digest:await digest(original),result:{operationId:'click-receipt',status:'completed',output:'private-browser-output-canary'}});
  await state.storage.put('browserFence',{operationId:'click-receipt',bootId:'prior-boot'});
 });
 const result=await action(stub,botId,'recover-click',{type:'browserRecover',previousOperationId:'click-receipt'});
 expect(result.status).toBe('completed');expect(JSON.parse(result.output!)).toMatchObject({state:'settled',status:'completed',inspectBeforeRetry:true});
 expect(result.output).not.toContain('private-browser-output-canary');
 await runInDurableObject(stub,async(_,state)=>expect(await state.storage.get('browserFence')).toBeUndefined());
 expect(await action(stub,botId,'click-receipt',original)).toMatchObject({status:'completed',output:'private-browser-output-canary'});
});

it('fences a browser request not yet accepted by ComputerDO and refuses its delayed original delivery',async()=>{
 const botId=crypto.randomUUID(),stub=bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId));
 const recovered=await action(stub,botId,'fence-recovery',{type:'browserRecover',previousOperationId:'late-browser-click'});
 expect(JSON.parse(recovered.output!)).toMatchObject({state:'not_executed',operationId:'late-browser-click'});
 const late=await action(stub,botId,'late-browser-click',{type:'click',x:1,y:1});
 expect(late.status).toBe('interrupted');expect(late.error).toContain('fenced');
});

it('does not infer a restart or release a browser fence when an old receipt has no boot identity',async()=>{
 const botId=crypto.randomUUID(),stub=bindings.REAL_COMPUTER.get(bindings.REAL_COMPUTER.idFromName(botId));
 await runInDurableObject(stub,async(instance,state)=>{
  await state.storage.put('operation:legacy-browser',{digest:'old',result:{operationId:'legacy-browser',status:'interrupted'}});
  const provider=instance as unknown as {health:()=>Promise<unknown>;reconcileBrowser:(id:string)=>Promise<Record<string,unknown>>},savedHealth=provider.health;
  const descriptor=Object.getOwnPropertyDescriptor(instance,'container');
  Object.defineProperty(instance,'container',{configurable:true,value:{running:true}});
  provider.health=async()=>({bootId:'current-boot',capabilities:['browserReceipts']});
  try {
   expect(await provider.reconcileBrowser('legacy-browser')).toMatchObject({state:'unavailable'});
   expect(await state.storage.get('browserFence')).toEqual({operationId:'legacy-browser',bootId:''});
  } finally {provider.health=savedHealth;if(descriptor)Object.defineProperty(instance,'container',descriptor);else Reflect.deleteProperty(instance,'container');}
 });
});
