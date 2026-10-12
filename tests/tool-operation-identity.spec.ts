import {env,exports} from 'cloudflare:workers';
import {evictDurableObject,runInDurableObject} from 'cloudflare:test';
import {expect,it} from 'vitest';
import type {Bot,Run,Approval} from '@botspace/contracts';
import type {Env} from '../apps/api/src/env';
import type {RuntimeToolRequest,RuntimeToolResult} from '../packages/runtime/src/types';
const bindings=env as unknown as Env;
const stub=(bot:Bot)=>bindings.BOT.get(bindings.BOT.idFromName(`owner:${bot.id}`));
type IdentityInput={taskId:string;callId:string;legacyOperationId:string};
type Internals={toolOperationId(input:IdentityInput):Promise<string>;executeTool(input:RuntimeToolRequest):Promise<RuntimeToolResult>;finishApproval(approval:Approval):Promise<void>};
async function activeBot(mode='automatic') {
 const response=await exports.default.fetch('https://timber.test/v1/bots',{method:'POST',headers:{authorization:'Bearer test-only-botspace-owner-token-000000','content-type':'application/json'},body:JSON.stringify({name:'Tool namespace bot',computerApprovalMode:mode})});expect(response.status).toBe(201);
 const {bot}=await response.json<{bot:Bot}>();await(await exports.default.fetch(`https://timber.test/v1/bots/${bot.id}/messages`,{headers:{authorization:'Bearer test-only-botspace-owner-token-000000'}})).arrayBuffer();
 await(await bindings.WORKSPACE.get(bindings.WORKSPACE.idFromName('owner')).fetch(`https://workspace/tasks/bot-slot/${bot.id}`,{method:'POST'})).arrayBuffer();
 const now=new Date().toISOString(),run:Run={id:crypto.randomUUID(),botId:bot.id,operationId:crypto.randomUUID(),status:'running',createdAt:now,updatedAt:now};
 await runInDurableObject(stub(bot),(_instance,state)=>{state.storage.sql.exec('INSERT INTO runs(id,operation_id,fingerprint,native_operation_id,data) VALUES(?,?,?,?,?)',run.id,run.operationId,'fixture',run.operationId,JSON.stringify(run));state.storage.sql.exec('INSERT INTO submissions(operation_id,run_id,text,admitted) VALUES(?,?,?,1)',run.operationId,run.id,'Inspect operation identity');});return {bot,run};
}
it('new tool identities are conversation scoped, durable, opaque and use indexed legacy-admission checks',async()=>{
 const first=await activeBot(),second=await activeBot(),input={taskId:'17',callId:'functions.exec:0',legacyOperationId:'pi-tool:17:functions.exec:0'};
 const resolve=(bot:Bot)=>runInDurableObject(stub(bot),instance=>(instance as unknown as Internals).toolOperationId(input));
 const one=await resolve(first.bot),two=await resolve(second.bot);expect(one).toMatch(/^pi-tool-v2:[0-9a-f]{64}$/);expect(one).not.toBe(two);
 await evictDurableObject(stub(first.bot));expect(await resolve(first.bot)).toBe(one);
 const plans=await runInDurableObject(stub(first.bot),(_instance,state)=>[
  state.storage.sql.exec<{detail:string}>('EXPLAIN QUERY PLAN SELECT 1 FROM computer_operations WHERE operation_id=?',input.legacyOperationId).toArray(),
  state.storage.sql.exec<{detail:string}>('EXPLAIN QUERY PLAN SELECT 1 FROM approvals WHERE operation_id=?',input.legacyOperationId).toArray(),
  state.storage.sql.exec<{detail:string}>('EXPLAIN QUERY PLAN SELECT 1 FROM events WHERE source_key IN (?,?) LIMIT 1',`tool-start:${input.legacyOperationId}`,`tool:${input.legacyOperationId}`).toArray(),
 ]);for(const plan of plans){expect(plan.map(row=>row.detail).join(' ')).toContain('INDEX');expect(plan.map(row=>row.detail).join(' ')).not.toMatch(/SCAN (?:computer_operations|approvals|events)/);}
});
it('a legacy pending approval retains its exact effect identity through upgrade and recovery without replaying the command',async()=>{
 const {bot,run}=await activeBot('ask'),input={taskId:'17',callId:'call-legacy',legacyOperationId:'pi-tool:17:call-legacy'};
 await runInDurableObject(stub(bot),async(instance,state)=>{
  const target=instance as unknown as Internals;
  const requested=await target.executeTool({operationId:input.legacyOperationId,runOperationId:run.operationId,toolCallId:input.callId,action:{type:'exec',command:'printf legacy-effect-once'},signal:new AbortController().signal});expect(requested.status).toBe('pending_approval');
  expect(await target.toolOperationId(input)).toBe(input.legacyOperationId);
  const approval=JSON.parse(state.storage.sql.exec<{data:string}>('SELECT data FROM approvals WHERE operation_id=?',input.legacyOperationId).one().data) as Approval;
  approval.status='executing';state.storage.sql.exec('UPDATE approvals SET data=? WHERE id=?',JSON.stringify(approval),approval.id);await target.finishApproval(approval);
  const receipt=JSON.parse(state.storage.sql.exec<{data:string}>('SELECT data FROM approvals WHERE operation_id=?',input.legacyOperationId).one().data) as Approval;expect(receipt.status).toBe('completed');
  // Exercise an old invocation retry after its original owner journal already
  // settled. It returns that receipt, never a newly namespaced command effect.
  expect(await target.toolOperationId(input)).toBe(input.legacyOperationId);await target.finishApproval(approval);expect(receipt.operationId).toBe(input.legacyOperationId);expect(state.storage.sql.exec('SELECT operation_id FROM computer_operations WHERE operation_id=?',input.legacyOperationId).toArray()).toHaveLength(1);
 });
 await evictDurableObject(stub(bot));expect(await runInDurableObject(stub(bot),instance=>(instance as unknown as Internals).toolOperationId(input))).toBe(input.legacyOperationId);
 const computer=bindings.COMPUTER.get(bindings.COMPUTER.idFromName(bot.id));expect(await runInDurableObject(computer,(_instance,state)=>state.storage.sql.exec<{id:string}>('SELECT id FROM effects').toArray().map(row=>row.id))).toEqual([input.legacyOperationId]);
});
it('an uncertain legacy host admission pins its old ID locally while another conversation gets a fresh namespace',async()=>{
 const {bot,run}=await activeBot(),other=await activeBot(),input={taskId:'19',callId:'call-host',legacyOperationId:'pi-tool:19:call-host'};
 await runInDurableObject(stub(bot),(_instance,state)=>state.storage.sql.exec('INSERT INTO events(source_key,data) VALUES(?,?)',`tool-start:${input.legacyOperationId}`,JSON.stringify({botId:bot.id,runId:run.id,type:'tool.started',data:{operationId:input.legacyOperationId,toolName:'create_task'},createdAt:new Date().toISOString()})));
 expect(await runInDurableObject(stub(bot),instance=>(instance as unknown as Internals).toolOperationId(input))).toBe(input.legacyOperationId);
 expect(await runInDurableObject(stub(other.bot),instance=>(instance as unknown as Internals).toolOperationId(input))).not.toBe(input.legacyOperationId);
});
