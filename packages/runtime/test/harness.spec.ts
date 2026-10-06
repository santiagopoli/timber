import { env, exports } from 'cloudflare:workers';
import { abortAllDurableObjects, reset, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { HarnessProbe } from './worker.js';
let probeId: string;
beforeEach(() => { probeId = crypto.randomUUID(); });
const request = (path: string, input?: unknown) => exports.default.fetch(`https://test${path}`, { headers: { 'content-type': 'application/json', 'x-probe-id': probeId }, ...(input ? { method: 'POST', body: JSON.stringify(input) } : {}) });
afterEach(async () => { await reset(); });
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

it('pauses mixed tool rounds before another model request when one tool needs approval', async () => {
  await request('/submit', { text: 'request-exec-mixed', operationId: 'mixed-id' });
  const result = await (await request('/wait?id=mixed-id')).json<{ status: string }>();
  expect(result.status).toBe('unanswered');
  const state = await (await request('/inspect')).json<{ calls: unknown[]; messages: { text: string }[] }>();
  expect(state.calls).toHaveLength(1);
  expect(state.messages.some(message => message.text.includes('pending_approval'))).toBe(true);
});
it('enforces a durable generation budget on an endlessly tool-calling model', async () => {
  await request('/submit', { text: 'request-loop', operationId: 'loop-id' });
  const result = await (await request('/wait?id=loop-id')).json<{ status: string }>();
  expect(result.status).toBe('unanswered');
  const state = await (await request('/inspect')).json<{ calls: unknown[] }>();
  expect(state.calls).toHaveLength(12);
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
  expect(events).toContainEqual(expect.objectContaining({ type: 'run.completed', operationId: 'approval:decision-1', data: { text: answer } }));
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

it('retains the 12-generation limit with ChatGPT subscription inference', async () => {
  await request('/submit', { text: 'request-loop', operationId: 'chatgpt-loop', chatgpt: true });
  expect(await (await request('/wait?id=chatgpt-loop')).json()).toMatchObject({ status: 'unanswered' });
  const state = await (await request('/inspect')).json<{ calls: unknown[] }>();
  expect(state.calls).toHaveLength(12);
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
  expect(events).toContainEqual(expect.objectContaining({ type: 'run.completed', operationId: 'automatic-retry', data: { text: answer } }));
});
