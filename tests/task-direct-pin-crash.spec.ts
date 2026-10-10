import {env,exports} from "cloudflare:workers";
import {abortAllDurableObjects,runInDurableObject} from "cloudflare:test";
import {expect,it} from "vitest";
import type {Bot} from "@botspace/contracts";
import type {Env} from "../apps/api/src/env";
import {computerFixtureControl} from "./fixtures/worker";
const bindings=env as unknown as Env;
const registry=()=>bindings.WORKSPACE.get(bindings.WORKSPACE.idFromName("owner"));
async function api(path:string,input?:unknown) {
 const response=await exports.default.fetch(`https://timber.test${path}`,{method:input===undefined?"GET":"POST",headers:{authorization:"Bearer test-only-botspace-owner-token-000000","content-type":"application/json"},...(input===undefined?{}:{body:JSON.stringify(input)})});
 return {status:response.status,data:await response.json<any>()};
}
async function bot(){const result=await api("/v1/bots",{name:"Owner pin crash"});expect(result.status).toBe(201);return result.data.bot as Bot;}
async function slot(owner:Bot){return runInDurableObject(registry(),(_,state)=>state.storage.sql.exec<{task_id:string;token:string;generation:number}>("SELECT task_id,token,generation FROM task_slots WHERE bot_id=?",owner.id).toArray()[0]);}
async function reconcile(){await runInDurableObject(registry(),async instance=>{await (instance as unknown as {reconcileComputerSlots():Promise<void>}).reconcileComputerSlots();});}
async function effects(owner:Bot){return runInDurableObject(bindings.COMPUTER.get(bindings.COMPUTER.idFromName(owner.id)),(_,state)=>state.storage.sql.exec<{id:string}>("SELECT id FROM effects").toArray().map(row=>row.id));}
// Isolated fixture namespace: abrupt restart must not kill unrelated test gates.
 it("recovers a crash-left exact owner poll pin without leaking its lease or inventing another observation",async()=>{
  const owner=await bot(),op=crypto.randomUUID();computerFixtureControl.execSession={command:"Pinned poll",pollsBeforeComplete:0};
  try {expect((await api(`/v1/bots/${owner.id}/computer/actions`,{operationId:op,action:{type:"exec",command:"Pinned poll"}})).data.result.status).toBe("running");} finally {delete computerFixtureControl.execSession;}
  const poll={operationId:crypto.randomUUID(),action:{type:"execPoll",processId:op}},held=await slot(owner);
  const pin=await registry().fetch(`https://workspace/tasks/bot-slot/${owner.id}/direct-dispatch`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({lease:{key:op,token:held!.token,generation:held!.generation},...poll})});expect(pin.status).toBe(200);await pin.arrayBuffer();
  // A crash must not wait for unrelated scheduler requests to drain.
  // Computer session/effects and the exact dispatch pin all survive in SQL.
  await abortAllDurableObjects();await reconcile();
  expect(await effects(owner)).toContain(poll.operationId);expect(await slot(owner)).toBeUndefined();
  await runInDurableObject(registry(),(_,state)=>expect(state.storage.sql.exec("SELECT 1 FROM computer_admissions WHERE bot_id=?",owner.id).toArray()).toHaveLength(0));
 });
