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
  const paused = await (await request('/inspect')).json<{ calls: unknown[]; messages: { text: string }[] }>();
  expect(paused.calls).toHaveLength(1);
  expect(paused.messages.some(message => message.text.includes('pending_approval'))).toBe(true);
  await request('/submit', { text: 'The approved action completed: fixture', operationId: 'approval:decision-1' });
  expect(await (await request('/wait?id=approval:decision-1')).json()).toMatchObject({ status: 'done' });
  const resumed = await (await request('/inspect')).json<{ calls: unknown[] }>();
  expect(resumed.calls).toHaveLength(2);
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
