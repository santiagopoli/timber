import { exports } from 'cloudflare:workers';
import { abortAllDurableObjects, reset } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it } from 'vitest';
let probeId: string;
beforeEach(() => { probeId = crypto.randomUUID(); });
const request = (path: string, input?: unknown) => exports.default.fetch(`https://test${path}`, { headers: { 'content-type': 'application/json', 'x-probe-id': probeId }, ...(input ? { method: 'POST', body: JSON.stringify(input) } : {}) });
afterEach(async () => { await reset(); });
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
