import { env, exports } from 'cloudflare:workers';
import { abortAllDurableObjects, reset, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { HarnessProbe } from './worker.js';
import { createBudget } from '../src/budget.js';
import { PiHarness } from 'agents/harness/pi';
let probeId: string;
beforeEach(() => { probeId = crypto.randomUUID(); });
const request = (path: string, input?: unknown) => exports.default.fetch(`https://test${path}`, { headers: { 'content-type': 'application/json', 'x-probe-id': probeId }, ...(input ? { method: 'POST', body: JSON.stringify(input) } : {}) });
afterEach(async () => { await reset(); });
async function configureLimits(limits: { maxGenerations?: number; maxToolCalls?: number }) {
  const stub = (env as unknown as { PROBE: DurableObjectNamespace<HarnessProbe> }).PROBE.getByName(probeId);
  await runInDurableObject(stub, (_instance, state) => {
    for (const [key, value] of Object.entries(limits)) state.storage.sql.exec('INSERT OR REPLACE INTO config(key,value) VALUES(?,?)', key, JSON.stringify(value));
  });
  await abortAllDurableObjects();
}
it('runs a visible temporary Pi conversation, attributes its tools and keeps its context across eviction', async () => {
  const namespace = (env as unknown as { PROBE: DurableObjectNamespace<HarnessProbe> }).PROBE;
  let stub = namespace.getByName(probeId);
  await request('/submit', { text: 'request-subagent', operationId: 'parent-with-child' });
  await request('/wait?id=parent-with-child');
  await expect.poll(() => runInDurableObject(stub, async instance => (await instance.runtime.subagents())[0]?.status)).toBe('completed');
  const child = await runInDurableObject(stub, async (instance, state) => {
    const agents = await instance.runtime.subagents();
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ name: 'Reader', parentOperationId: 'parent-with-child', status: 'completed', result: 'Hello from the real Pi harness.' });
    const tools = state.storage.sql.exec<{ input: string }>('SELECT input FROM tool_calls').toArray().map(row => JSON.parse(row.input));
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ runOperationId: 'parent-with-child', subagentId: agents[0]!.id, subagentOperationId: agents[0]!.operationId, action: { type: 'readFile' } });
    const root = await instance.runtime.messages();
    expect(root.filter(message => message.role === 'user').map(message => message.text)).toEqual(['request-subagent']);
    const messages = await instance.runtime.subagentMessages(agents[0]!.id);
    expect(messages.filter(message => message.role === 'user').map(message => message.text)).toEqual(['child-fixture-read']);
    const events = state.storage.sql.exec<{ event: string }>('SELECT event FROM projected').toArray().map(row => JSON.parse(row.event));
    expect(events).toContainEqual(expect.objectContaining({ type: 'subagent.created', operationId: 'parent-with-child', data: expect.objectContaining({operationId: agents[0]!.operationId, toolCallId: 'call-spawn-1'}) }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'subagent.tool.completed', data: expect.objectContaining({ subagentId: agents[0]!.id, status: 'completed' }) }));
    return agents[0]!;
  });
  await abortAllDurableObjects();
  stub = namespace.getByName(probeId);
  await runInDurableObject(stub, async instance => {
    expect((await instance.runtime.subagents())[0]).toMatchObject({ id: child.id, status: 'completed' });
    const input = { operationId: 'child-followup' };
    expect(await instance.runtime.sendSubagent(child.id, 'child-fixture-message', input)).toMatchObject({ accepted: true });
    expect(await instance.runtime.sendSubagent(child.id, 'child-fixture-message', input)).toMatchObject({ accepted: false });
  });
  await expect.poll(() => runInDurableObject(stub, async instance => (await instance.runtime.subagents())[0]?.status)).toBe('completed');
  await runInDurableObject(stub, async (instance, state) => {
    expect((await instance.runtime.subagentMessages(child.id)).filter(message => message.role === 'user')).toHaveLength(2);
    expect(state.storage.sql.exec('SELECT input FROM tool_calls').toArray()).toHaveLength(1);
  });
});
it('pauses and resumes the child alone for approval, then cascades parent cancellation', async () => {
  const stub = (env as unknown as { PROBE: DurableObjectNamespace<HarnessProbe> }).PROBE.getByName(probeId);
  await request('/submit', { text: 'request-subagent child-exec', operationId: 'parent-approval-child' });
  await request('/wait?id=parent-approval-child');
  await expect.poll(() => runInDurableObject(stub, async instance => (await instance.runtime.subagents())[0]?.status)).toBe('waiting_approval');
  await request('/host-context', { mode: 'automatic' });
  const child = await runInDurableObject(stub, async instance => {
    const child = (await instance.runtime.subagents())[0]!;
    await instance.runtime.sendSubagent(child.id, 'The recorded action was approved and executed. Continue from its result.', { operationId: 'child-approved' });
    return child;
  });
  await expect.poll(() => runInDurableObject(stub, async instance => (await instance.runtime.subagents())[0]?.status)).toBe('completed');
  await runInDurableObject(stub, async instance => {
    await instance.runtime.cancel('parent-approval-child');
    expect((await instance.runtime.subagents())[0]?.status).toBe('cancelled');
    await expect(instance.runtime.sendSubagent(child.id, 'late message', { operationId: 'late-child-message' })).rejects.toThrow('cancelled');
  });
});
it('charges child generations to the durable parent budget', async () => {
  await configureLimits({ maxGenerations: 1 });
  const stub = (env as unknown as { PROBE: DurableObjectNamespace<HarnessProbe> }).PROBE.getByName(probeId);
  await request('/submit', { text: 'request-subagent', operationId: 'limited-parent' });
  await request('/wait?id=limited-parent');
  await expect.poll(() => runInDurableObject(stub, async instance => (await instance.runtime.subagents())[0]?.status)).toBe('failed');
  await runInDurableObject(stub, (_instance, state) => {
    expect(state.storage.sql.exec('SELECT input FROM calls').toArray()).toHaveLength(1);
    expect(state.storage.sql.exec('SELECT input FROM tool_calls').toArray()).toHaveLength(0);
    expect(state.storage.sql.exec('SELECT operation_id FROM botspace_runtime_budget WHERE kind=\'generation\'').toArray()).toEqual([{ operation_id: 'limited-parent' }]);
  });
});
it('queues a child followup without changing its active tool attribution', async () => {
  const stub = (env as unknown as { PROBE: DurableObjectNamespace<HarnessProbe> }).PROBE.getByName(probeId);
  await runInDurableObject(stub, instance => { instance.heldTool = new Promise(resolve => { instance.releaseHeldTool = resolve; }); });
  try {
    await request('/submit', { text: 'request-subagent', operationId: 'parent-queued-child' });
    await request('/wait?id=parent-queued-child');
    await expect.poll(() => runInDurableObject(stub, (_instance, state) => state.storage.sql.exec('SELECT id FROM tool_calls').toArray().length)).toBe(1);
    await runInDurableObject(stub, async instance => {
      const before = (await instance.runtime.subagents())[0]!;
      await instance.runtime.sendSubagent(before.id, 'child-fixture-message', { operationId: 'queued-child-followup' });
      expect((await instance.runtime.subagents())[0]).toMatchObject({ operationId: before.operationId, status: 'running' });
      await expect(instance.runtime.sendSubagent(before.id, 'conflicting text', { operationId: 'queued-child-followup' })).rejects.toThrow('another subagent message');
      instance.releaseHeldTool?.();
    });
    await expect.poll(() => runInDurableObject(stub, async instance => {
      const child = (await instance.runtime.subagents())[0];
      return child?.operationId === 'queued-child-followup' && child.status;
    })).toBe('completed');
  } finally { await runInDurableObject(stub, instance => instance.releaseHeldTool?.()); }
});
it('attends a new root request and spawns its own child while an earlier child is still working', async () => {
  const namespace = (env as unknown as { PROBE: DurableObjectNamespace<HarnessProbe> }).PROBE;
  let stub = namespace.getByName(probeId);
  await runInDurableObject(stub, instance => { instance.heldTool = new Promise(resolve => { instance.releaseHeldTool = resolve; }); });
  try {
    await request('/submit', {text: 'request-subagent-wait', operationId: 'original-task'});
    await expect.poll(() => runInDurableObject(stub, (_instance, state) => state.storage.sql.exec<{event:string}>('SELECT event FROM projected').toArray().map(row => JSON.parse(row.event)).some(event => event.type === 'tool.started' && event.data.toolName === 'wait_subagent'))).toBe(true);
    await request('/submit', {text: 'request-subagent second-task', operationId: 'new-independent-task'});
    await expect.poll(() => runInDurableObject(stub, async instance => (await instance.runtime.subagents()).length)).toBe(2);
    const answers = await Promise.all(['original-task', 'new-independent-task'].map(async operationId => (await request(`/wait?id=${operationId}`)).json<{status:string;answerId:string;answerOperationId:string}>()));
    expect(answers[0]).toMatchObject({status: 'done', answerOperationId: 'new-independent-task'});
    expect(answers[1]).toMatchObject({status: 'done', answerId: answers[0]!.answerId, answerOperationId: 'new-independent-task'});
    await runInDurableObject(stub, async (instance, state) => {
      const children = await instance.runtime.subagents();
      expect(children.map(child => ({parent:child.parentOperationId,status:child.status}))).toEqual([{parent:'original-task',status:'running'},{parent:'new-independent-task',status:'running'}]);
      const events = state.storage.sql.exec<{event:string}>('SELECT event FROM projected').toArray().map(row => JSON.parse(row.event));
      expect(events.filter(event => event.type === 'tool.started' && event.data.toolName === 'spawn_subagent').map(event => event.operationId)).toEqual(['original-task','new-independent-task']);
      expect(events.filter(event => event.type === 'run.completed').map(event => event.data.answerId)).toEqual([answers[0]!.answerId,answers[0]!.answerId]);
      const root = await instance.runtime.messages();
      expect(root.filter(message => message.role === 'assistant' && message.kind === 'final')).toHaveLength(1);
      expect(root.some(message => message.role === 'tool' && message.text.includes('"reason":"new_input"'))).toBe(true);
      instance.releaseHeldTool?.();
    });
    await expect.poll(() => runInDurableObject(stub, async instance => (await instance.runtime.subagents()).every(child => child.status === 'completed'))).toBe(true);
    await abortAllDurableObjects();
    stub = namespace.getByName(probeId);
    await runInDurableObject(stub, async instance => {
      for (const operationId of ['original-task','new-independent-task']) {
        expect(await instance.runtime.operation(operationId)).toMatchObject({status:'done',answerId:answers[0]!.answerId,answerOperationId:'new-independent-task'});
      }
    });
  } finally { await runInDurableObject(stub, instance => instance.releaseHeldTool?.()); }
});
it('stops an older joined task without aborting the newer root input or its child', async () => {
  const stub = (env as unknown as { PROBE: DurableObjectNamespace<HarnessProbe> }).PROBE.getByName(probeId);
  await runInDurableObject(stub, instance => { instance.abortHeldTool = true; instance.heldTool = new Promise(resolve => { instance.releaseHeldTool = resolve; }); });
  try {
    await request('/submit', {text: 'request-subagent-wait', operationId: 'older-joined-task'});
    const waits = () => runInDurableObject(stub, (_instance, state) => state.storage.sql.exec<{event:string}>('SELECT event FROM projected').toArray().map(row => JSON.parse(row.event)).filter(event => event.type === 'tool.started' && event.data.toolName === 'wait_subagent'));
    await expect.poll(async () => (await waits()).length).toBe(1);
    await request('/submit', {text: 'request-subagent-wait second-task', operationId: 'newer-joined-task'});
    // Fixture call IDs are reusable across turns; inspect native pending state
    // and the latest child to establish that the second input has been placed.
    await expect.poll(() => runInDurableObject(stub, async instance => {
      const children = await instance.runtime.subagents();
      return children.length === 2 && children.every(child => child.status === 'running');
    })).toBe(true);
    await runInDurableObject(stub, async instance => {
      expect(await instance.runtime.cancel('older-joined-task')).toBe(true);
      expect(await instance.runtime.operation('older-joined-task')).toMatchObject({status:'unanswered',reason:'aborted'});
      expect(await instance.runtime.operation('newer-joined-task')).toMatchObject({status:'running'});
      const children = await instance.runtime.subagents();
      expect(children.find(child => child.parentOperationId === 'older-joined-task')?.status).toBe('cancelled');
      expect(children.find(child => child.parentOperationId === 'newer-joined-task')?.status).toBe('running');
      instance.releaseHeldTool?.();
    });
    expect(await (await request('/wait?id=newer-joined-task')).json()).toMatchObject({status:'done',answerOperationId:'newer-joined-task'});
    expect(await (await request('/wait?id=older-joined-task')).json()).toMatchObject({status:'unanswered',reason:'aborted'});
    await expect.poll(() => runInDurableObject(stub, async instance => (await instance.runtime.subagents()).find(child => child.parentOperationId === 'newer-joined-task')?.status)).toBe('completed');
  } finally { await runInDurableObject(stub, instance => instance.releaseHeldTool?.()); }
});
it('recovers an in-flight child without repeating an unsafe computer action', async () => {
  const namespace = (env as unknown as { PROBE: DurableObjectNamespace<HarnessProbe> }).PROBE;
  let stub = namespace.getByName(probeId);
  await request('/host-context', { mode: 'automatic' });
  await runInDurableObject(stub, instance => { instance.heldTool = new Promise(() => {}); });
  await request('/submit', { text: 'request-subagent child-exec', operationId: 'parent-recovery-child' });
  await request('/wait?id=parent-recovery-child');
  await expect.poll(() => runInDurableObject(stub, (_instance, state) => state.storage.sql.exec('SELECT id FROM tool_calls').toArray().length)).toBe(1);
  await abortAllDurableObjects();
  stub = namespace.getByName(probeId);
  await runInDurableObject(stub, (_instance, state) => { state.storage.sql.exec("UPDATE cf_agents_jobs SET time=0 WHERE capability IN ('pi-harness','botspace-subagents')"); });
  await runDurableObjectAlarm(stub);
  await expect.poll(() => runInDurableObject(stub, async instance => (await instance.runtime.subagents())[0]?.status)).toBe('completed');
  await runInDurableObject(stub, (_instance, state) => { expect(state.storage.sql.exec('SELECT id FROM tool_calls').toArray()).toHaveLength(1); });
});
it('bounds recursive temporary delegation at three levels', async () => {
  const stub = (env as unknown as { PROBE: DurableObjectNamespace<HarnessProbe> }).PROBE.getByName(probeId);
  await request('/submit', { text: 'request-subagent nested', operationId: 'nested-parent' });
  await request('/wait?id=nested-parent');
  await expect.poll(() => runInDurableObject(stub, async instance => (await instance.runtime.subagents()).length)).toBe(3);
  await expect.poll(() => runInDurableObject(stub, async instance => (await instance.runtime.subagents()).every(agent => agent.status === 'completed'))).toBe(true);
  await runInDurableObject(stub, async instance => {
    const agents = await instance.runtime.subagents();
    expect(agents.every(agent => agent.parentOperationId === 'nested-parent')).toBe(true);
    expect(agents.filter(agent => agent.parentSubagentId)).toHaveLength(2);
  });
});
it('bounds live temporary agents and releases their slots only after cancellation or completion', async () => {
  const stub = (env as unknown as { PROBE: DurableObjectNamespace<HarnessProbe> }).PROBE.getByName(probeId);
  await runInDurableObject(stub, instance => { instance.heldTool = new Promise(resolve => { instance.releaseHeldTool = resolve; }); });
  try {
    for (let index = 0; index < 9; index++) {
      await request('/submit', { text: 'request-subagent', operationId: `parent-cap-${index}` });
      await request(`/wait?id=parent-cap-${index}`);
    }
    await runInDurableObject(stub, async instance => {
      expect(await instance.runtime.subagents()).toHaveLength(8);
      instance.releaseHeldTool?.();
    });
    await expect.poll(() => runInDurableObject(stub, async instance => (await instance.runtime.subagents()).every(agent => agent.status === 'completed'))).toBe(true);
  } finally { await runInDurableObject(stub, instance => instance.releaseHeldTool?.()); }
});
it('delivers sibling messages and lets the root message, wait for and cancel a prior task’s child', async () => {
  const stub = (env as unknown as { PROBE: DurableObjectNamespace<HarnessProbe> }).PROBE.getByName(probeId);
  await request('/submit', { text: 'request-subagent-peers', operationId: 'peer-parent' });
  await request('/wait?id=peer-parent');
  await expect.poll(() => runInDurableObject(stub, async instance => (await instance.runtime.subagents()).length)).toBe(2);
  const target = await runInDurableObject(stub, async instance => (await instance.runtime.subagents()).find(agent => agent.name === 'Reader')!);
  await expect.poll(() => runInDurableObject(stub, async instance => (await instance.runtime.subagentMessages(target.id)).filter(message => message.role === 'user').length)).toBe(2);
  await runInDurableObject(stub, async (instance, state) => {
    expect(await instance.runtime.subagentMessages(target.id)).toContainEqual(expect.objectContaining({ role: 'user', text: 'Message from Messenger:\nA public coordination message.' }));
    const events = state.storage.sql.exec<{event: string}>('SELECT event FROM projected').toArray().map(row => JSON.parse(row.event));
    expect(events).toContainEqual(expect.objectContaining({type: 'subagent.message.sent', data: expect.objectContaining({sourceSubagentId: expect.any(String), targetSubagentId: target.id, sourceName: 'Messenger', targetName: 'Reader', text: 'A public coordination message.', operationId: expect.any(String), toolCallId: 'call-agent-communication'})}));
  });
  await runInDurableObject(stub, instance => instance.runtime.sendSubagent(target.id, 'child-fixture-peer:parent', {operationId: 'child-to-root-message'}));
  await expect.poll(() => runInDurableObject(stub, (_instance, state) => state.storage.sql.exec<{event: string}>('SELECT event FROM projected').toArray().map(row => JSON.parse(row.event)).filter(event => event.type === 'subagent.message.sent' && event.data.sourceSubagentId === target.id && event.data.targetName === 'Ada').length)).toBe(1);
  for (const action of ['message', 'wait', 'cancel']) {
    await request('/submit', { text: `request-${action}-existing:${target.id}`, operationId: `later-root-${action}` });
    expect(await (await request(`/wait?id=later-root-${action}`)).json()).toMatchObject({ status: 'done' });
  }
  await runInDurableObject(stub, async (instance, state) => {
    expect((await instance.runtime.subagents()).find(agent => agent.id === target.id)?.status).toBe('cancelled');
    expect(await instance.runtime.subagentMessages(target.id)).toContainEqual(expect.objectContaining({ role: 'user', text: 'Message from parent:\nA public coordination message.' }));
    const events = state.storage.sql.exec<{event: string}>('SELECT event FROM projected').toArray().map(row => JSON.parse(row.event));
    const sent = events.filter(event => event.type === 'subagent.message.sent');
    expect(sent).toHaveLength(3);
    expect(new Set(sent.map(event => event.eventKey)).size).toBe(3);
    const fromRoot = sent.find(event => event.data.sourceName === 'Ada');
    expect(fromRoot.data).toMatchObject({targetSubagentId: target.id, targetName: 'Reader', text: 'A public coordination message.'});
    expect(fromRoot.data).not.toHaveProperty('sourceSubagentId');
    const toRoot = sent.find(event => event.data.targetName === 'Ada');
    expect(toRoot.data).not.toHaveProperty('targetSubagentId');
    const reports = state.storage.sql.exec<{input: string}>('SELECT input FROM child_reports').toArray().map(row => JSON.parse(row.input));
    expect(reports).toContainEqual(expect.objectContaining({operationId: toRoot.data.operationId, subagentId: target.id}));
  });
});
it('durably retries a rejected parent report across eviction without repeating child work', async () => {
  const namespace = (env as unknown as { PROBE: DurableObjectNamespace<HarnessProbe> }).PROBE;
  let stub = namespace.getByName(probeId);
  await runInDurableObject(stub, (_instance, state) => { state.storage.sql.exec('INSERT INTO config(key,value) VALUES(?,?)', 'failChildReportOnce', 'true'); });
  await request('/submit', { text: 'request-subagent', operationId: 'parent-report-retry' });
  await request('/wait?id=parent-report-retry');
  await expect.poll(() => runInDurableObject(stub, (_instance, state) => state.storage.sql.exec('SELECT id FROM child_report_attempts').toArray().length)).toBe(1);
  const before = await runInDurableObject(stub, (_instance, state) => ({
    calls: state.storage.sql.exec('SELECT id FROM calls').toArray().length,
    tools: state.storage.sql.exec('SELECT id FROM tool_calls').toArray().length,
  }));
  await abortAllDurableObjects();
  stub = namespace.getByName(probeId);
  await runInDurableObject(stub, (_instance, state) => { state.storage.sql.exec("UPDATE cf_agents_jobs SET time=0 WHERE capability IN ('pi-harness','botspace-subagents')"); });
  await runDurableObjectAlarm(stub);
  await expect.poll(() => runInDurableObject(stub, (_instance, state) => state.storage.sql.exec('SELECT id FROM child_reports').toArray().length), { timeout: 5_000 }).toBe(1);
  await runInDurableObject(stub, (_instance, state) => {
    const attempts = state.storage.sql.exec<{input:string}>('SELECT input FROM child_report_attempts').toArray().map(row => JSON.parse(row.input));
    expect(attempts).toHaveLength(2);
    expect(attempts[0].operationId).toMatch(/^subagent-report:[a-f0-9]{64}$/);
    expect(attempts[1]).toEqual(attempts[0]);
    expect(state.storage.sql.exec('SELECT id FROM calls').toArray()).toHaveLength(before.calls);
    expect(state.storage.sql.exec('SELECT id FROM tool_calls').toArray()).toHaveLength(before.tools);
  });
});
it('retries a transient native child admission failure with the same durable input', async () => {
  const original = PiHarness.prototype.enqueue;
  const admissions: string[] = [];
  PiHarness.prototype.enqueue = async function(session, input, options) {
    if (session !== '1') {
      admissions.push(options.operationId!);
      if (admissions.length === 1) throw new Error('Fixture child admission failed before receipt');
    }
    return original.call(this, session, input, options);
  };
  const stub = (env as unknown as { PROBE: DurableObjectNamespace<HarnessProbe> }).PROBE.getByName(probeId);
  try {
    await request('/submit', { text: 'request-subagent', operationId: 'parent-admission-retry' });
    await request('/wait?id=parent-admission-retry');
    await expect.poll(() => runInDurableObject(stub, async instance => (await instance.runtime.subagents())[0]?.status), { timeout: 5_000 }).toBe('completed');
    expect(admissions).toHaveLength(2);
    expect(admissions[1]).toBe(admissions[0]);
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec('SELECT id FROM tool_calls').toArray()).toHaveLength(1);
    });
  } finally { PiHarness.prototype.enqueue = original; }
});
it('retries a transient shutdown failure without reopening admission', async () => {
  const stub = (env as unknown as { PROBE: DurableObjectNamespace<HarnessProbe> }).PROBE.getByName(probeId);
  await request('/submit', { text: 'hello', operationId: 'before-deletion' });
  await request('/wait?id=before-deletion');
  await runInDurableObject(stub, async (instance, state) => {
    const deleteAlarm = state.storage.deleteAlarm.bind(state.storage);
    let fail = true;
    state.storage.deleteAlarm = async () => {
      if (fail) { fail = false; throw new Error('fixture transient alarm failure'); }
      return deleteAlarm();
    };
    try {
      await expect(instance.runtime.destroy()).rejects.toThrow('fixture transient alarm failure');
      await expect(instance.runtime.submit('late', { operationId: 'after-deletion' })).rejects.toThrow('destroyed');
      await instance.runtime.destroy();
      expect(await state.storage.getAlarm()).toBeNull();
    } finally { state.storage.deleteAlarm = deleteAlarm; }
  });
});
it('keeps tool-calling commentary classified as progress when approval pauses a native run', async () => {
  await request('/submit', { text: 'request-multistep-recovery', operationId: 'approval-commentary', chatgpt: true });
  expect(await (await request('/wait?id=approval-commentary')).json()).toMatchObject({ status: 'done', text: 'Working on fixture round 1.', kind: 'progress' });
  const state = await (await request('/inspect')).json<{ events: { event: string }[] }>();
  expect(state.events.map(row => JSON.parse(row.event))).toContainEqual(expect.objectContaining({
    type: 'run.completed', operationId: 'approval-commentary', data: { text: 'Working on fixture round 1.', kind: 'progress', answerId: expect.any(String), answerOperationId: 'approval-commentary' },
  }));
});
it('reports a reasoning-only final response as a failure without repeating completed tools', async () => {
  await request('/host-context', { mode: 'automatic' });
  await request('/submit', { text: 'request-exec empty-final-after-exec', operationId: 'empty-final', chatgpt: true });
  expect(await (await request('/wait?id=empty-final')).json()).toMatchObject({ status: 'unanswered', reason: 'model_error' });
  const state = await (await request('/inspect')).json<{ calls: unknown[]; toolCalls: unknown[]; messages: unknown[]; events: { event: string }[] }>();
  expect(state.calls).toHaveLength(4);
  expect(state.toolCalls).toHaveLength(1);
  const events = state.events.map(row => JSON.parse(row.event));
  expect(events).toContainEqual(expect.objectContaining({ type: 'run.failed', data: expect.objectContaining({ errorCode: 'model_empty_response' }) }));
  expect(events.some(event => event.type === 'run.completed')).toBe(false);
  expect(JSON.stringify({ messages: state.messages, events })).not.toContain('Private fixture reasoning');
});
it.each([false, true])('continues a running exec through its process ID with cancel=%s', async cancel => {
  await request('/host-context', {mode: 'automatic'});
  await request('/submit', {text: cancel ? 'request-cancel-resumable-exec' : 'request-resumable-exec', operationId: 'managed-exec', chatgpt: true});
  expect(await (await request('/wait?id=managed-exec')).json()).toMatchObject({status: 'done', text: cancel ? 'The managed command was cancelled.' : 'The managed command completed.'});
  const state = await (await request('/inspect')).json<{toolCalls: {input: string}[]; calls: {input: string}[]; events: {event: string}[]}>();
  const tools = state.toolCalls.map(row => JSON.parse(row.input));
  expect(tools.map(tool => tool.action.type)).toEqual(['exec', cancel ? 'execCancel' : 'execPoll']);
  expect(tools[0].action).toEqual({type: 'exec', command: 'fixture managed command', yieldMs: 1000});
  expect(tools[1].action.processId).toBe(tools[0].operationId);
  expect(tools[1].operationId).not.toBe(tools[0].operationId);
  const events = state.events.map(row => JSON.parse(row.event));
  expect(events).toContainEqual(expect.objectContaining({type: 'tool.completed', data: expect.objectContaining({status: 'running', processId: tools[0].operationId})}));
  expect(events).toContainEqual(expect.objectContaining({type: 'tool.completed', data: expect.objectContaining({status: cancel ? 'cancelled' : 'completed', processId: tools[0].operationId})}));
  expect(events.some(event => event.type === 'run.failed')).toBe(false);
});
it('recovers after a saved running exec result by polling without launching the command again', async () => {
  const namespace = (env as unknown as {PROBE: DurableObjectNamespace<HarnessProbe>}).PROBE;
  let stub = namespace.getByName(probeId);
  await request('/host-context', {mode: 'automatic'});
  await runInDurableObject(stub, instance => {
    instance.holdInferenceAfterToolCount = 1;
    instance.heldInference = new Promise(() => {});
  });
  await request('/submit', {text: 'request-resumable-exec', operationId: 'recover-managed-exec', chatgpt: true});
  await expect.poll(() => runInDurableObject(stub, (_instance, state) => state.storage.sql.exec('SELECT id FROM calls').toArray().length)).toBe(2);
  await abortAllDurableObjects();
  stub = namespace.getByName(probeId);
  await runInDurableObject(stub, (_instance, state) => {state.storage.sql.exec("UPDATE cf_agents_jobs SET time=0 WHERE capability='pi-harness'");});
  await runDurableObjectAlarm(stub);
  expect(await runInDurableObject(stub, instance => instance.runtime.wait('recover-managed-exec'))).toMatchObject({status: 'done', text: 'The managed command completed.'});
  await runInDurableObject(stub, (_instance, state) => {
    const calls = state.storage.sql.exec<{input: string}>('SELECT input FROM tool_calls').toArray().map(row => JSON.parse(row.input));
    expect(calls.map(call => call.action.type)).toEqual(['exec', 'execPoll']);
    expect(calls[1].action.processId).toBe(calls[0].operationId);
    expect(calls[0].action).not.toHaveProperty('timeoutMs');
  });
});
it.each(['recover-empty-once','recover-incomplete-once','recover-stream-once'])('recovers %s after a saved tool result without another user message or tool execution',async failure=>{
  await request('/host-context',{mode:'automatic'});
  const stub=(env as unknown as {PROBE:DurableObjectNamespace<HarnessProbe>}).PROBE.getByName(probeId);
  if(failure==='recover-empty-once') await runInDurableObject(stub,instance=>{instance.toolFailure=true;});
  await request('/submit',{text:`request-exec ${failure}`,operationId:'recover-result',chatgpt:true});
  const result=await (await request('/wait?id=recover-result')).json<{status:string;text:string}>();
  expect(result.status).toBe('done');
  expect(result.text).toContain(failure==='recover-empty-once'?'command failed with exit 1':'Hello from ChatGPT');
  const state=await (await request('/inspect')).json<{calls:{input:string}[];toolCalls:unknown[];messages:{role:string;kind?:string;text:string}[];events:{event:string}[]}>();
  expect(state.calls).toHaveLength(3);expect(state.toolCalls).toHaveLength(1);
  for(const call of state.calls.slice(1)) expect(JSON.parse(call.input).input.filter((item:{type:string})=>item.type==='function_call_output')).toHaveLength(1);
  expect(state.messages.filter(message=>message.role==='user')).toHaveLength(1);
  expect(state.messages.filter(message=>message.kind==='final')).toHaveLength(1);
  const events=state.events.map(row=>JSON.parse(row.event));
  expect(events).toContainEqual(expect.objectContaining({type:'run.retrying',operationId:'recover-result',data:expect.objectContaining({attempt:1,maxRetries:2})}));
  expect(events.some(event=>event.type==='run.failed')).toBe(false);
  expect(events).toContainEqual(expect.objectContaining({type:'run.completed',operationId:'recover-result'}));
});
it('lets the model explain a reached tool budget instead of silently terminating on prior commentary',async()=>{
  await configureLimits({maxToolCalls:24});
  await request('/submit',{text:'request-tool-budget',operationId:'tool-budget-answer',chatgpt:true});
  expect(await (await request('/wait?id=tool-budget-answer')).json()).toMatchObject({status:'done',kind:'final',text:'I reached the tool limit; 24 reads completed. Continue to inspect more files.'});
  const state=await (await request('/inspect')).json<{calls:{input:string}[];toolCalls:unknown[]}>();
  expect(state.calls).toHaveLength(2);expect(state.toolCalls).toHaveLength(24);
  const results=JSON.parse(state.calls[1]!.input).input.filter((item:{type:string})=>item.type==='function_call_output');
  expect(results).toHaveLength(25);expect(results.at(-1).output).toContain('reached its tool budget');
});
it('continues multiple delayed tool rounds after a hard restart without another user message', async () => {
  const namespace = (env as unknown as { PROBE: DurableObjectNamespace<HarnessProbe> }).PROBE;
  let stub = namespace.getByName(probeId);
  await request('/host-context', { mode: 'automatic' });
  await runInDurableObject(stub, instance => {
    instance.toolDelayMs = 600;
    instance.holdInferenceAfterToolCount = 2;
    instance.heldInference = new Promise(() => {});
  });
  await request('/submit', { text: 'request-multistep-recovery', operationId: 'multistep-recovery', chatgpt: true });
  await expect.poll(() => runInDurableObject(stub, (_instance, state) =>
    state.storage.sql.exec('SELECT id FROM calls').toArray().length,
  ), { timeout: 5_000 }).toBe(2);
  await runInDurableObject(stub, (_instance, state) => {
    expect(state.storage.sql.exec('SELECT id FROM tool_calls').toArray()).toHaveLength(2);
    expect(state.storage.sql.exec('SELECT event FROM projected').toArray().some(row => JSON.parse(row.event as string).type === 'run.completed')).toBe(false);
  });
  // The first two effects have settled. Lose only the subsequent inference attempt.
  await abortAllDurableObjects();
  stub = namespace.getByName(probeId);
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec("UPDATE cf_agents_jobs SET time=0 WHERE capability='pi-harness'");
  });
  await runDurableObjectAlarm(stub);
  const result = await runInDurableObject(stub, instance => instance.runtime.wait('multistep-recovery'));
  const finalAnswer = 'Completed both commands, opened the page, and checked the screenshot.';
  expect(result).toMatchObject({ status: 'done', text: finalAnswer });
  await runInDurableObject(stub, async (instance, state) => {
    const tools = state.storage.sql.exec<{ input: string }>('SELECT input FROM tool_calls').toArray().map(row => JSON.parse(row.input));
    expect(tools.map(tool => tool.action.type)).toEqual(['exec', 'exec', 'navigate', 'screenshot']);
    expect(new Set(tools.map(tool => tool.operationId)).size).toBe(4);
    const messages = await instance.runtime.messages();
    expect(messages.filter(message => message.role === 'user')).toHaveLength(1);
    expect(messages).toContainEqual(expect.objectContaining({ role: 'assistant', text: finalAnswer }));
    expect(messages.filter(message => message.kind === 'progress')).toHaveLength(3);
    expect(messages).toContainEqual(expect.objectContaining({ role: 'assistant', text: finalAnswer, kind: 'final' }));
    const events = state.storage.sql.exec<{ event: string }>('SELECT event FROM projected').toArray().map(row => JSON.parse(row.event));
    expect(events).toContainEqual(expect.objectContaining({ type: 'run.completed', operationId: 'multistep-recovery', data: { text: finalAnswer, kind: 'final', answerId: expect.any(String), answerOperationId: 'multistep-recovery' } }));
    for (const tool of tools) expect(events).toContainEqual(expect.objectContaining({
      type: 'tool.completed', operationId: 'multistep-recovery',
      data: expect.objectContaining({ operationId: tool.operationId, toolCallId: tool.toolCallId, status: 'completed' }),
    }));
    const lastRequest = JSON.parse(state.storage.sql.exec<{ input: string }>('SELECT input FROM calls ORDER BY id DESC LIMIT 1').one().input);
    expect(lastRequest.input.filter((item: { type: string }) => item.type === 'function_call_output')).toHaveLength(4);
    expect(JSON.stringify(lastRequest.input)).toContain('data:image/png;base64,aW1hZ2U=');
  });
});
it('permanently fences admission and alarms while deletion waits boundedly for an in-flight tool', async () => {
  const stub = (env as unknown as { PROBE: DurableObjectNamespace<HarnessProbe> }).PROBE.getByName(probeId);
  await request('/host-context', { mode: 'automatic' });
  await runInDurableObject(stub, instance => {
    // Simulate a dispatched computer RPC that cannot be retracted by aborting Pi.
    instance.heldTool = new Promise(resolve => { instance.releaseHeldTool = resolve; });
  });
  try {
    await request('/submit', { text: 'request-exec', operationId: 'deleting-active', chatgpt: true });
    await expect.poll(() => runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec('SELECT id FROM tool_calls').toArray().length,
    )).toBe(1);
    await request('/submit', { text: 'This queued message must never run', operationId: 'deleting-queued' });
    await runInDurableObject(stub, instance => instance.runtime.scheduleAdmissionRetry('deleting-unadmitted', 60_000));
    await expect(runInDurableObject(stub, instance => instance.runtime.destroy())).rejects.toThrow('shutdown is still pending');
    const projectedBefore = await runInDurableObject(stub, async (instance, state) => {
      expect(await state.storage.getAlarm()).toBeNull();
      await expect(instance.runtime.submit('late input', { operationId: 'deleting-late' })).rejects.toThrow('destroyed');
      await expect(instance.runtime.scheduleAdmissionRetry('deleting-late', 0)).rejects.toThrow('destroyed');
      expect(state.storage.sql.exec('SELECT id FROM calls').toArray()).toHaveLength(1);
      instance.releaseHeldTool?.();
      return state.storage.sql.exec('SELECT id FROM projected').toArray().length;
    });
    // A retry joins the same shutdown; only actual quiescence permits the host's wipe.
    await runInDurableObject(stub, instance => instance.runtime.destroy());
    await runInDurableObject(stub, async (instance, state) => {
      await instance.runtime.destroy();
      expect(await state.storage.getAlarm()).toBeNull();
      expect(state.storage.sql.exec('SELECT id FROM projected').toArray()).toHaveLength(projectedBefore);
      expect(state.storage.sql.exec('SELECT id FROM calls').toArray()).toHaveLength(1);
      expect(state.storage.sql.exec('SELECT id FROM tool_calls').toArray()).toHaveLength(1);
      expect(state.storage.sql.exec('SELECT id FROM admission_wakes').toArray()).toHaveLength(0);
    });
  } finally {
    await runInDurableObject(stub, instance => { instance.releaseHeldTool?.(); });
  }
});
it('persists one admission wake across eviction and preserves a backoff scheduled by its callback', async () => {
  const namespace = (env as unknown as { PROBE: DurableObjectNamespace<HarnessProbe> }).PROBE;
  let stub = namespace.getByName(probeId);
  await runInDurableObject(stub, async (instance, state) => {
    state.storage.sql.exec('INSERT INTO config(key,value) VALUES(?,?)', 'admissionRescheduleOnce', 'input-to-retry');
    await instance.runtime.scheduleAdmissionRetry('input-to-retry', 60_000);
    await instance.runtime.scheduleAdmissionRetry('input-to-retry', 60_000);
    const jobs = state.storage.sql.exec<{ id: string; singleflight: number; retry_options: string }>(
      "SELECT id,singleflight,retry_options FROM cf_agents_jobs WHERE capability='botspace-admission'",
    ).toArray();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ id: 'botspace:admission:input-to-retry', singleflight: 1 });
    expect(JSON.parse(jobs[0]!.retry_options)).toEqual({ maxAttempts: 1 });
  });
  for (const expectedWakes of [1, 2]) {
    await abortAllDurableObjects();
    stub = namespace.getByName(probeId);
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec("SELECT id FROM cf_agents_jobs WHERE capability='botspace-admission'").toArray()).toHaveLength(1);
      // Advance the durable queue itself; the physical alarm helper does not change its due times.
      state.storage.sql.exec("UPDATE cf_agents_jobs SET time=0 WHERE capability='botspace-admission'");
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec('SELECT operation_id FROM admission_wakes').toArray()).toEqual(
        Array.from({ length: expectedWakes }, () => ({ operation_id: 'input-to-retry' })),
      );
      expect(state.storage.sql.exec("SELECT id FROM cf_agents_jobs WHERE capability='botspace-admission'").toArray()).toHaveLength(2 - expectedWakes);
      expect(state.storage.sql.exec('SELECT id FROM calls').toArray()).toHaveLength(0);
      expect(state.storage.sql.exec('SELECT id FROM tool_calls').toArray()).toHaveLength(0);
    });
  }
});
it('runs the real PiHarness with named instructions, durable inputs and normalized events', async () => {
  const receipt = await (await request('/submit', { text: 'hello', operationId: 'op-1' })).json<{ accepted: boolean }>();
  expect(receipt.accepted).toBe(true);
  const result = await (await request('/wait?id=op-1')).json<{ status: string; text: string }>();
  expect(result).toMatchObject({ status: 'done', text: 'Hello from the real Pi harness.' });
  const state = await (await request('/inspect')).json<{ calls: { input: string }[]; events: { event: string }[] }>();
  expect(state.calls).toHaveLength(1);
  expect(state.calls[0]?.input).toContain('amber-lantern');
  expect(state.calls[0]?.input).toContain('Ada');
  const wireInput = JSON.parse(state.calls[0]!.input);
  expect(wireInput.max_tokens ?? wireInput.max_completion_tokens).toBe(4096);
  expect(state.events.some(row => JSON.parse(row.event).type === 'run.completed')).toBe(true);
});
it('recovers the native conversation and deduplicates a completed input after eviction', async () => {
  await request('/submit', { text: 'hello', operationId: 'durable-id' });
  await request('/wait?id=durable-id');
  await abortAllDurableObjects();
  const receipt = await (await request('/submit', { text: 'hello', operationId: 'durable-id' })).json<{ accepted: boolean }>();
  expect(receipt.accepted).toBe(false);
  const state = await (await request('/inspect')).json<{ calls: unknown[]; messages: { role: string; text: string }[] }>();
  expect(state.calls).toHaveLength(1);
  expect(state.messages).toContainEqual(expect.objectContaining({ role: 'assistant', text: 'Hello from the real Pi harness.' }));
});
it('terminates native execution when a tool needs human approval', async () => {
  await request('/submit', { text: 'request-exec', operationId: 'approval-id' });
  const result = await (await request('/wait?id=approval-id')).json<{ status: string }>();
  expect(result.status).toBe('done');
  const state = await (await request('/inspect')).json<{ calls: unknown[]; messages: { role: string; text: string }[] }>();
  expect(state.calls).toHaveLength(1);
  expect(state.messages.some(message => message.role === 'tool' && message.text.includes('pending_approval'))).toBe(true);
});

it('discovers host capabilities through native Pi without invoking the computer', async () => {
  await request('/submit', { text: 'request-catalog', operationId: 'catalog-id', chatgpt: true });
  expect(await (await request('/wait?id=catalog-id')).json()).toMatchObject({ status: 'done', kind: 'final' });
  const state = await (await request('/inspect')).json<{ calls: { input: string }[]; toolCalls: unknown[]; hostCalls: unknown[]; messages: { role: string; text: string }[] }>();
  expect(state.calls).toHaveLength(2);
  expect(state.toolCalls).toHaveLength(0);
  expect(state.hostCalls).toHaveLength(0);
  expect(state.messages).toContainEqual(expect.objectContaining({ role: 'tool', text: expect.stringContaining('github_clone') }));
  const wire = JSON.parse(state.calls[0]!.input);
  const names = wire.tools.flatMap((namespace: { tools: { name: string }[] }) => namespace.tools.map(tool => tool.name));
  expect(names).toContain('list_tools');
  expect(names).toContain('call_tool');
  expect(developerText(state.calls[0]!.input)).toContain('github-development');
  expect(developerText(state.calls[0]!.input)).toContain('accessible URL rather than a localhost address');
});

it('persists a connection pause across eviction and resumes only through a new host input', async () => {
  await request('/submit', { text: 'request-host', operationId: 'connect-id', chatgpt: true });
  await request('/wait?id=connect-id');
  const paused = await (await request('/inspect')).json<{ calls: unknown[]; toolCalls: unknown[]; hostCalls: { input: string }[]; events: { event: string }[] }>();
  expect(paused.calls).toHaveLength(1);
  expect(paused.toolCalls).toHaveLength(0);
  expect(paused.hostCalls).toHaveLength(1);
  expect(JSON.parse(paused.hostCalls[0]!.input)).toMatchObject({ name: 'github_clone', runOperationId: 'connect-id', arguments: { repository: 'owner/private', path: 'project' } });
  expect(paused.events.map(row => JSON.parse(row.event))).toContainEqual(expect.objectContaining({ type: 'tool.completed', operationId: 'connect-id', data: expect.objectContaining({ status: 'pending_connection' }) }));
  await abortAllDurableObjects();
  expect(await (await request('/submit', { text: 'request-host', operationId: 'connect-id' })).json()).toMatchObject({ accepted: false });
  const namespace = (env as unknown as { PROBE: DurableObjectNamespace<HarnessProbe> }).PROBE;
  await runInDurableObject(namespace.getByName(probeId), (_instance, state) => {
    const row = state.storage.sql.exec<{ approval: string }>('SELECT approval FROM botspace_runtime_pauses WHERE operation_id=?', 'connect-id').one();
    expect(JSON.parse(row.approval)).toMatchObject({ status: 'pending_connection', requestId: 'connection-fixture' });
    expect(state.storage.sql.exec('SELECT id FROM calls').toArray()).toHaveLength(1);
  });
  await request('/host-context', { githubConnected: true });
  await request('/submit', { text: 'GitHub is connected. Continue the pending request-host task.', operationId: 'connection:connection-fixture' });
  expect(await (await request('/wait?id=connection:connection-fixture')).json()).toMatchObject({ status: 'done', kind: 'final' });
  const resumed = await (await request('/inspect')).json<{ calls: unknown[]; hostCalls: { input: string }[]; toolCalls: unknown[]; messages: { text: string; role: string }[] }>();
  expect(resumed.calls).toHaveLength(3);
  expect(resumed.hostCalls).toHaveLength(2);
  expect(JSON.parse(resumed.hostCalls[1]!.input).runOperationId).toBe('connection:connection-fixture');
  expect(JSON.parse(resumed.hostCalls[1]!.input).operationId).not.toBe(JSON.parse(resumed.hostCalls[0]!.input).operationId);
  expect(resumed.toolCalls).toHaveLength(0);
  expect(resumed.messages).toContainEqual(expect.objectContaining({ role: 'assistant', text: 'Hello from ChatGPT via the real Pi harness.' }));
});

it('pauses mixed tool rounds before another model request when one tool needs approval', async () => {
  await request('/submit', { text: 'request-exec-mixed', operationId: 'mixed-id' });
  const result = await (await request('/wait?id=mixed-id')).json<{ status: string }>();
  expect(result.status).toBe('unanswered');
  const state = await (await request('/inspect')).json<{ calls: unknown[]; messages: { text: string }[] }>();
  expect(state.calls).toHaveLength(1);
  expect(state.messages.some(message => message.text.includes('pending_approval'))).toBe(true);
});
it('enforces a durable generation budget on an endlessly tool-calling model', async () => {
  await configureLimits({maxGenerations:3});
  await request('/submit', { text: 'request-loop', operationId: 'loop-id' });
  const result = await (await request('/wait?id=loop-id')).json<{ status: string }>();
  expect(result.status).toBe('unanswered');
  const state = await (await request('/inspect')).json<{ calls: unknown[] }>();
  expect(state.calls).toHaveLength(3);
});

it('projects a safe billing failure from a real provider error response', async () => {
  await request('/submit', { text: 'billing-fixture', operationId: 'billing-id' });
  const result = await (await request('/wait?id=billing-id')).json<{ status: string }>();
  expect(result.status).toBe('unanswered');
  const state = await (await request('/inspect')).json<{ events: { event: string }[] }>();
  const failure = state.events.map(row => JSON.parse(row.event)).find(event => event.type === 'run.failed');
  expect(failure.data.errorCode).toBe('model_billing_required');
  expect(failure.data.publicMessage).toContain('paid Workers AI');
  expect(JSON.stringify(failure)).not.toContain('Private example detail');
});

it('uses the official credential-free ChatGPT transport and supported request fields', async () => {
  await request('/submit', { text: 'hello', operationId: 'chatgpt-text', chatgpt: true });
  expect(await (await request('/wait?id=chatgpt-text')).json()).toMatchObject({ status: 'done', text: 'Hello from ChatGPT via the real Pi harness.' });
  const state = await (await request('/inspect')).json<{ calls: { input: string }[] }>();
  const wire = JSON.parse(state.calls[0]!.input);
  expect(wire.fixtureUrl).toBe('https://api.openai.com/v1/responses');
  expect(wire.fixtureHeaders).toEqual({ accept: 'text/event-stream', 'content-type': 'application/json' });
  expect(wire.model).toBe('gpt-6.1-sol');
  expect(wire.store).toBe(false);
  expect(wire.stream).toBe(true);
  expect(wire.input.some((item: { role: string }) => item.role === 'system')).toBe(false);
  expect(wire.input.some((item: { role: string }) => item.role === 'developer')).toBe(true);
  expect(JSON.stringify(wire.input)).toContain('amber-lantern');
  expect(wire.tools).toEqual([expect.objectContaining({ type: 'namespace', name: 'timber_computer' })]);
  for (const forbidden of ['max_output_tokens', 'max_tool_calls', 'metadata', 'temperature', 'top_p', 'background', 'previous_response_id', 'prompt_cache_retention', 'safety_identifier']) expect(wire).not.toHaveProperty(forbidden);
});

it('replays namespaced calls, full history and screenshot pixels through native Pi', async () => {
  await request('/submit', { text: 'request-vision', operationId: 'vision', chatgpt: true });
  expect(await (await request('/wait?id=vision')).json()).toMatchObject({ status: 'done' });
  const state = await (await request('/inspect')).json<{ calls: { input: string }[] }>();
  expect(state.calls).toHaveLength(2);
  const wire = JSON.parse(state.calls[1]!.input);
  expect(wire.input).toContainEqual(expect.objectContaining({ type: 'function_call', namespace: 'timber_computer', name: 'desktop_screenshot' }));
  expect(wire.input).toContainEqual(expect.objectContaining({ type: 'function_call_output', call_id: 'call_fixture_1', output: expect.arrayContaining([{ type: 'input_image', detail: 'auto', image_url: 'data:image/png;base64,aW1hZ2U=' }]) }));
  await abortAllDurableObjects();
  await request('/submit', { text: 'Continue the conversation', operationId: 'continued' });
  expect(await (await request('/wait?id=continued')).json()).toMatchObject({ status: 'done' });
  const resumed = await (await request('/inspect')).json<{ calls: { input: string }[] }>();
  expect(resumed.calls).toHaveLength(3);
  expect(resumed.calls[2]!.input).toContain('request-vision');
});

it('pauses a namespaced ChatGPT exec for approval and resumes with a new durable input', async () => {
  await request('/submit', { text: 'request-exec', operationId: 'approval-chatgpt', chatgpt: true });
  await request('/wait?id=approval-chatgpt');
  const paused = await (await request('/inspect')).json<{ calls: unknown[]; messages: { text: string }[]; toolCalls: { input: string }[]; events: { event: string }[] }>();
  expect(paused.calls).toHaveLength(1);
  expect(paused.messages.some(message => message.text.includes('pending_approval'))).toBe(true);
  expect(paused.toolCalls).toHaveLength(1);
  const invocation = JSON.parse(paused.toolCalls[0]!.input);
  expect(invocation).toMatchObject({ runOperationId: 'approval-chatgpt', action: { type: 'exec', command: 'echo fixture' } });
  expect(invocation.operationId).toMatch(/^pi-tool-sha256:[a-f0-9]{64}$/);
  expect(paused.events.map(row => JSON.parse(row.event))).toContainEqual(expect.objectContaining({ type: 'tool.started', data: { toolCallId: 'call_fixture_1|fc_fixture_1', toolName: 'exec' } }));
  await request('/submit', { text: 'The approved action completed: fixture', operationId: 'approval:decision-1' });
  const answer = 'Hello from ChatGPT via the real Pi harness.';
  expect(await (await request('/wait?id=approval:decision-1')).json()).toMatchObject({ status: 'done', text: answer });
  const resumed = await (await request('/inspect')).json<{ calls: unknown[]; messages: { role: string; text: string }[]; events: { event: string }[] }>();
  expect(resumed.calls).toHaveLength(2);
  expect(resumed.messages).toContainEqual(expect.objectContaining({ role: 'assistant', text: answer }));
  const events = resumed.events.map(row => JSON.parse(row.event));
  expect(events).toContainEqual(expect.objectContaining({ type: 'message', operationId: 'approval:decision-1', data: expect.objectContaining({ role: 'assistant', text: answer }) }));
  expect(events).toContainEqual(expect.objectContaining({ type: 'run.completed', operationId: 'approval:decision-1', data: { text: answer, kind: 'final', answerId: expect.any(String), answerOperationId: 'approval:decision-1' } }));
  expect(events.filter(event => event.type === 'run.completed' && event.operationId === 'approval-chatgpt').every(event => event.data.text !== answer)).toBe(true);
});

it('projects an allowance failure after streaming without claiming completed inference', async () => {
  await request('/submit', { text: 'allowance-exhausted', operationId: 'allowance', chatgpt: true });
  expect(await (await request('/wait?id=allowance')).json()).toMatchObject({ status: 'unanswered' });
  const state = await (await request('/inspect')).json<{ calls: unknown[]; events: { event: string }[] }>();
  expect(state.calls).toHaveLength(1);
  const failed = state.events.map(row => JSON.parse(row.event)).find(event => event.type === 'run.failed');
  expect(failed.data.errorCode).toBe('chatgpt_allowance_exhausted');
  expect(JSON.stringify(state.events)).not.toContain('Private account detail');
});

it.each(['truncated-stream', 'incomplete-response', 'bad-namespace', 'output-limit'])('rejects %s before accepting a completed ChatGPT answer', async text => {
  await request('/submit', { text, operationId: 'invalid-stream', chatgpt: true });
  expect(await (await request('/wait?id=invalid-stream')).json()).toMatchObject({ status: 'unanswered' });
  const state = await (await request('/inspect')).json<{ events: { event: string }[] }>();
  expect(state.events.some(row => JSON.parse(row.event).type === 'tool.started')).toBe(false);
});

it('honors an explicitly configured generation limit with ChatGPT subscription inference', async () => {
  await configureLimits({maxGenerations:5});
  await request('/submit', { text: 'request-loop', operationId: 'chatgpt-loop', chatgpt: true });
  expect(await (await request('/wait?id=chatgpt-loop')).json()).toMatchObject({ status: 'unanswered' });
  const state = await (await request('/inspect')).json<{ calls: unknown[] }>();
  expect(state.calls).toHaveLength(5);
});

it('finishes a long task beyond the old round/tool caps, including after a hard restart', async () => {
  const namespace = (env as unknown as { PROBE: DurableObjectNamespace<HarnessProbe> }).PROBE;
  const stub = namespace.getByName(probeId);
  await runInDurableObject(stub, instance => {
    instance.holdInferenceAfterToolCount = 26;
    instance.heldInference = new Promise(() => {});
  });
  await request('/submit', {text: 'request-long-task', operationId: 'long-task', chatgpt: true});
  await expect.poll(() => runInDurableObject(stub, (_instance, state) =>
    state.storage.sql.exec('SELECT id FROM tool_calls').toArray().length,
  ), {timeout: 10_000}).toBe(26);
  await abortAllDurableObjects();
  expect(await (await request('/wait?id=long-task')).json()).toMatchObject({status:'done',kind:'final',text:'Completed 60 file reads over 30 tool rounds.'});
  const result = await (await request('/inspect')).json<{toolCalls:{input:string}[];messages:{role:string;kind?:string}[]}>();
  expect(result.toolCalls).toHaveLength(60);
  expect(new Set(result.toolCalls.map(row=>JSON.parse(row.input).operationId)).size).toBe(60);
  expect(result.messages.filter(message=>message.role==='assistant' && message.kind==='final')).toHaveLength(1);
  await runInDurableObject(namespace.getByName(probeId), (_instance, state) => {
    expect(state.storage.sql.exec("SELECT item_id FROM botspace_runtime_budget WHERE operation_id='long-task' AND kind='generation'").toArray()).toHaveLength(31);
  });
});

it('still cancels an uncapped task after it has passed the former limits', async () => {
  const stub = (env as unknown as {PROBE:DurableObjectNamespace<HarnessProbe>}).PROBE.getByName(probeId);
  await runInDurableObject(stub, instance => {
    instance.holdInferenceAfterToolCount = 26;
    instance.heldInference = new Promise(resolve => {instance.releaseHeldInference = resolve;});
  });
  await request('/submit',{text:'request-loop',operationId:'cancel-uncapped',chatgpt:true});
  await expect.poll(()=>runInDurableObject(stub,(_instance,state)=>
    state.storage.sql.exec('SELECT id FROM calls').toArray().length,
  ),{timeout:10_000}).toBe(27);
  await runInDurableObject(stub,async instance=>{
    try {expect(await instance.runtime.cancel('cancel-uncapped')).toBe(true);}
    finally {instance.releaseHeldInference?.();}
  });
  expect(await (await request('/wait?id=cancel-uncapped')).json()).toMatchObject({status:'unanswered'});
  const result=await (await request('/inspect')).json<{toolCalls:unknown[];calls:unknown[]}>();
  expect(result.toolCalls).toHaveLength(26);
  expect(result.calls).toHaveLength(27);
});

it('preserves accounting without caps and enforces later explicit caps after restart', async () => {
  const namespace = (env as unknown as { PROBE: DurableObjectNamespace<HarnessProbe> }).PROBE;
  await runInDurableObject(namespace.getByName(probeId), (_instance, state) => {
    const consume = createBudget(state.storage);
    for(let i=0;i<130;i++)consume('accounted-task','generation',`generation-${i}`);
    for(let i=0;i<260;i++)consume('accounted-task','tool',`tool-${i}`);
  });
  await abortAllDurableObjects();
  await runInDurableObject(namespace.getByName(probeId), (_instance, state) => {
    const consume = createBudget(state.storage,{generation:130,tool:260});
    expect(()=>consume('accounted-task','generation','generation-129')).not.toThrow();
    expect(()=>consume('accounted-task','tool','tool-259')).not.toThrow();
    expect(()=>consume('accounted-task','generation','generation-130')).toThrow('generation budget exhausted');
    expect(()=>consume('accounted-task','tool','tool-260')).toThrow('tool budget exhausted');
    expect(()=>consume('another-task','generation','generation-130')).not.toThrow();
    const uncappedTools = createBudget(state.storage,{generation:130,tool:0});
    expect(()=>uncappedTools('accounted-task','tool','tool-260')).not.toThrow();
    expect(()=>uncappedTools('accounted-task','generation','generation-130')).toThrow('generation budget exhausted');
  });
});

function developerText(wire: string): string {
  const payload = JSON.parse(wire) as { input: { role?: string; content?: unknown }[] };
  return payload.input.filter(item => item.role === 'developer').map(item => typeof item.content === 'string' ? item.content : Array.isArray(item.content) ? item.content.map(part => part.text ?? '').join('') : '').join('\n');
}

it.each(['pending', 'denied', 'expired'] as const)('delivers current %s state and permits a fresh user retry to request a new approval', async status => {
  await request('/submit', { text: 'request-exec', operationId: 'first-attempt', chatgpt: true });
  await request('/wait?id=first-attempt');
  const approval = { id: 'approval-fixture-1', status, actionType: 'exec', expiresAt: status === 'pending' ? '2099-01-01T00:00:00.000Z' : '2026-01-01T00:00:00.000Z', command: 'must-not-leak', result: 'private-result' };
  await request('/host-context', { approvals: { active: status === 'pending' ? [approval] : [], recent: status === 'pending' ? [] : [approval] } });
  await request('/submit', { text: 'Please retry the task now: request-exec', operationId: 'fresh-retry' });
  await request('/wait?id=fresh-retry');
  const state = await (await request('/inspect')).json<{ calls: { input: string }[]; toolCalls: { input: string }[]; messages: { role: string; text: string }[] }>();
  expect(state.calls).toHaveLength(2);
  const currentPrompt = developerText(state.calls[1]!.input);
  expect(currentPrompt).toContain(`"status":"${status}"`);
  if (status === 'pending') expect(currentPrompt).toContain('"active":[{"id":"approval-fixture-1","status":"pending"');
  expect(currentPrompt).toContain('An old pending_approval message does not block a fresh user request');
  expect(currentPrompt).toContain('Current computer approval mode: ask');
  expect(currentPrompt).not.toContain('must-not-leak');
  expect(currentPrompt).not.toContain('private-result');
  expect(state.calls[1]!.input).toContain('pending_approval');
  const calls = state.toolCalls.map(row => JSON.parse(row.input));
  expect(calls).toHaveLength(2);
  expect(calls[0].operationId).not.toBe(calls[1].operationId);
  expect(calls[1].runOperationId).toBe('fresh-retry');
  expect(state.messages.filter(message => message.role === 'tool' && message.text.includes('pending_approval'))).toHaveLength(2);
  expect(state.messages.some(message => message.text.includes('approval-fixture-2'))).toBe(true);
});

it('refreshes approval metadata between tool rounds within the same native run', async () => {
  const pending = { id: 'current-approval', status: 'pending', actionType: 'exec', expiresAt: '2099-01-01T00:00:00.000Z' };
  await request('/host-context', { approvals: { active: [pending], recent: [] }, afterToolApprovals: { active: [], recent: [{ ...pending, status: 'denied' }] } });
  await request('/submit', { text: 'request-vision', operationId: 'fresh-snapshot', chatgpt: true });
  await request('/wait?id=fresh-snapshot');
  const state = await (await request('/inspect')).json<{ calls: { input: string }[] }>();
  expect(state.calls).toHaveLength(2);
  expect(developerText(state.calls[0]!.input)).toContain('"status":"pending"');
  expect(developerText(state.calls[1]!.input)).toContain('"status":"denied"');
  expect(developerText(state.calls[1]!.input)).not.toContain('"status":"pending"');
});

it('publishes unavailable approval state instead of retaining a stale snapshot on host failure', async () => {
  await request('/host-context', { approvals: { active: [{ id: 'stale-approval', status: 'pending', actionType: 'exec', expiresAt: '2099-01-01T00:00:00.000Z' }], recent: [] } });
  await request('/submit', { text: 'hello', operationId: 'before-failure', chatgpt: true });
  await request('/wait?id=before-failure');
  await request('/host-context', { approvals: 'unavailable' });
  await request('/submit', { text: 'hello again', operationId: 'after-failure' });
  await request('/wait?id=after-failure');
  const state = await (await request('/inspect')).json<{ calls: { input: string }[] }>();
  const prompt = developerText(state.calls[1]!.input);
  expect(prompt).toContain('Current host approval status is unavailable');
  expect(prompt).not.toContain('stale-approval');
});

it('refreshes automatic policy for new requests while retaining historical pending tool results', async () => {
  await request('/submit', { text: 'request-exec', operationId: 'asked-attempt', chatgpt: true });
  await request('/wait?id=asked-attempt');
  await request('/host-context', { mode: 'automatic', approvals: { active: [{ id: 'approval-fixture-1', status: 'pending', actionType: 'exec', expiresAt: '2099-01-01T00:00:00.000Z' }], recent: [] } });
  await request('/submit', { text: 'Please retry now: request-exec', operationId: 'automatic-retry' });
  const answer = 'Hello from ChatGPT via the real Pi harness.';
  expect(await (await request('/wait?id=automatic-retry')).json()).toMatchObject({ status: 'done', text: answer });
  const state = await (await request('/inspect')).json<{ calls: { input: string }[]; toolCalls: { input: string }[]; messages: { role: string; text: string }[]; events: { event: string }[] }>();
  expect(state.calls).toHaveLength(3);
  expect(developerText(state.calls[0]!.input)).toContain('Current computer approval mode: ask');
  expect(developerText(state.calls[1]!.input)).toContain('Current computer approval mode: automatic');
  expect(state.calls[1]!.input).toContain('pending_approval');
  expect(state.calls[1]!.input).not.toContain('Human approval is required');
  const calls = state.toolCalls.map(row => JSON.parse(row.input));
  expect(calls).toHaveLength(2);
  expect(calls[1].runOperationId).toBe('automatic-retry');
  expect(calls[0].operationId).not.toBe(calls[1].operationId);
  expect(state.calls[2]!.input).toContain('fixture completed');
  expect(state.messages).toContainEqual(expect.objectContaining({ role: 'assistant', text: answer }));
  const events = state.events.map(row => JSON.parse(row.event));
  expect(events).toContainEqual(expect.objectContaining({ type: 'message', operationId: 'automatic-retry', data: expect.objectContaining({ role: 'assistant', text: answer }) }));
  expect(events).toContainEqual(expect.objectContaining({ type: 'run.completed', operationId: 'automatic-retry', data: { text: answer, kind: 'final', answerId: expect.any(String), answerOperationId: 'automatic-retry' } }));
});

it('sends attached image bytes through the real PiHarness to the ChatGPT transport',async()=>{
  const data='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
  await request('/submit',{text:'Describe this image',operationId:'multimodal-input',chatgpt:true,images:[{data,mimeType:'image/png'}]});
  expect(await (await request('/wait?id=multimodal-input')).json()).toMatchObject({status:'done'});
  const state=await (await request('/inspect')).json<{calls:{input:string}[]}>();
  expect(state.calls).toHaveLength(1);
  expect(state.calls[0].input).toContain('input_image');
  expect(state.calls[0].input).toContain(`data:image/png;base64,${data}`);
});
