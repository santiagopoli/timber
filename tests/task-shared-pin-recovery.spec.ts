import {env,exports} from "cloudflare:workers";
import {evictDurableObject,runInDurableObject} from "cloudflare:test";
import {expect,it} from "vitest";
import type {Bot,Task,Run} from "@botspace/contracts";
import type {Env} from "../apps/api/src/env";
import {computerFixtureControl} from "./fixtures/worker";
const bindings=env as unknown as Env;
const registry=()=>bindings.WORKSPACE.get(bindings.WORKSPACE.idFromName("owner"));
const root=(bot:Bot)=>bindings.BOT.get(bindings.BOT.idFromName(`owner:${bot.id}`));
async function api(path:string,input?:unknown,method=input===undefined?"GET":"POST") {
 const r=await exports.default.fetch(`https://timber.test${path}`,{method,headers:{authorization:"Bearer test-only-botspace-owner-token-000000","content-type":"application/json"},...(input===undefined?{}:{body:JSON.stringify(input)})});
 const data=await r.json<any>();return {status:r.status,data};
}
async function bot(){const r=await api("/v1/bots",{name:"Reviewed blockers"});expect(r.status).toBe(201);return r.data.bot as Bot;}
async function task(owner:Bot,description="fixture:approval",startImmediately=true){const r=await api("/v1/tasks",{operationId:crypto.randomUUID(),title:"Reviewed task",description,botId:owner.id,startImmediately});expect(r.status).toBe(201);return r.data.task as Task;}
async function slot(owner:Bot){return runInDurableObject(registry(),(_,state)=>state.storage.sql.exec<{task_id:string;token:string;generation:number;payload:string}>("SELECT task_id,token,generation,payload FROM task_slots WHERE bot_id=?",owner.id).toArray()[0]);}
async function reconcile(){await runInDurableObject(registry(),async instance=>{await (instance as unknown as {reconcileComputerSlots():Promise<void>}).reconcileComputerSlots();});}
async function effects(owner:Bot){return runInDurableObject(bindings.COMPUTER.get(bindings.COMPUTER.idFromName(owner.id)),(_,state)=>state.storage.sql.exec<{id:string}>("SELECT id FROM effects").toArray().map(row=>row.id));}
async function terminal(id:string,status:string){for(let n=0;n<100;n++){const r=await api(`/v1/tasks/${id}/runs`);if(r.data.runs[0]?.status===status)return r.data.runs[0] as Run;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error(`Missing ${status} task result`);}
// Own fixture namespace so graceful eviction does not wait unrelated test gates.
 it("retains an uncertain shared GUI pin through native reconciliation, Stop and eviction until exact journal recovery",async()=>{
  const owner=await bot(),submitted=await api(`/v1/bots/${owner.id}/messages`,{operationId:crypto.randomUUID(),text:"fixture:gui-approval"});
  let saved=submitted.data.run as Run;for(let n=0;n<100&&saved.status!=="waiting_approval";n++){await new Promise(resolve=>setTimeout(resolve,5));saved=(await api(`/v1/bots/${owner.id}/runs/${saved.id}`)).data.run;}expect(saved.status).toBe("waiting_approval");
  const op=crypto.randomUUID(),input={operationId:op,action:{type:"key",key:"Escape"}};
  computerFixtureControl.failure={status:503,body:{error:{code:"computer_unavailable"}}};
  let next!:Task;
  try {
    expect((await api(`/v1/bots/${owner.id}/computer/actions`,input)).status).toBe(503);
    expect((await api(`/v1/bots/${owner.id}/computer/actions`,input)).status).toBe(503);
    expect((await api(`/v1/bots/${owner.id}/computer/queued-actions`)).data.actions).toEqual([]);
    const held=await slot(owner),admission=await runInDurableObject(registry(),(_,state)=>state.storage.sql.exec<{token:string;payload:string}>("SELECT token,payload FROM computer_admissions WHERE bot_id=? AND operation_id=?",owner.id,op).one());
    const changedPin=await registry().fetch(`https://workspace/tasks/bot-slot/${owner.id}/direct-dispatch`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({lease:{key:op,token:held!.token,generation:held!.generation,admissionToken:admission.token},operationId:op,action:{type:"key",key:"Enter"}})});
    expect(changedPin.status).toBe(409);expect((await changedPin.json<any>()).error.code).toBe("operation_id_conflict");
    await runInDurableObject(registry(),(_,state)=>expect(state.storage.sql.exec<{payload:string}>("SELECT payload FROM computer_admissions WHERE token=?",admission.token).one().payload).toBe(admission.payload));

    let originalFetch!: (request:Request)=>Promise<Response>;
    await runInDurableObject(registry(),instance=>{const target=instance as unknown as {fetch(request:Request):Promise<Response>};originalFetch=target.fetch;target.fetch=request=>new URL(request.url).pathname.endsWith("/direct-dispatch")?Promise.resolve(Response.json({error:{code:"fixture_fence_unavailable"}},{status:503})):originalFetch.call(target,request);});
    try {const failedFence=await api(`/v1/bots/${owner.id}/computer/actions`,input);expect(failedFence.status).toBe(503);expect(failedFence.data.preEffectRejected).not.toBe(true);}
    finally {await runInDurableObject(registry(),instance=>{(instance as unknown as {fetch(request:Request):Promise<Response>}).fetch=originalFetch;});}
    await runInDurableObject(registry(),(_,state)=>expect(state.storage.sql.exec("SELECT 1 FROM computer_admissions WHERE bot_id=? AND payload IS NOT NULL",owner.id).toArray()).toHaveLength(1));

    expect((await api(`/v1/bots/${owner.id}/computer/actions`,{...input,action:{type:"key",key:"Enter"}})).data.error.code).toBe("operation_id_conflict");
    await api(`/v1/bots/${owner.id}/runs/${saved.id}/cancel`,{});
    await runInDurableObject(registry(),async(instance,state)=>{state.storage.sql.exec("UPDATE computer_admissions SET created_at=? WHERE bot_id=?",Date.now()-61_000,owner.id);await (instance as unknown as {reconcileAdmissions():Promise<void>}).reconcileAdmissions();expect(state.storage.sql.exec("SELECT 1 FROM computer_admissions WHERE bot_id=? AND payload IS NOT NULL",owner.id).toArray()).toHaveLength(1);});
    await runInDurableObject(root(owner),(_,state)=>expect(state.storage.sql.exec("SELECT 1 FROM cancelled_agent_inputs WHERE operation_id=?",op).toArray()).toHaveLength(0));
    next=await task(owner);expect(next.status).toBe("queued");expect((await slot(owner))?.task_id).toBe("@bot");
  } finally {delete computerFixtureControl.failure;}
  await evictDurableObject(root(owner));await evictDurableObject(registry());await reconcile();
  expect(await effects(owner)).toContain(op);
  await runInDurableObject(registry(),(_,state)=>{expect(state.storage.sql.exec("SELECT 1 FROM computer_admissions WHERE bot_id=? AND payload IS NOT NULL",owner.id).toArray()).toHaveLength(0);state.storage.sql.exec("UPDATE task_slots SET updated_at=? WHERE bot_id=?",Date.now()-6000,owner.id);});
  await reconcile();await terminal(next.id,"waiting_approval");expect((await slot(owner))?.task_id).toBe(next.id);
 });
