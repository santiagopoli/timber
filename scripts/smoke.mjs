#!/usr/bin/env node
/** Run against a deployed backend: API_URL=https://... BOTSPACE_API_TOKEN=... node scripts/smoke.mjs [--computer] */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const args = new Set(process.argv.slice(2));
if (args.has('--help')) {
  console.log('Setup: npm run access:setup\nRun: npm run smoke [-- --computer]\nOr set API_URL and BOTSPACE_API_TOKEN in the environment. Environment values override the private local client configuration.\nCreates one uniquely named bot and leaves it for inspection. --computer starts its cloud computer and checks files, terminal, screenshot, checkpoint and restoration after suspension. Model and container usage may be billed.');
  process.exit(0);
}
for (const arg of args) if (arg !== '--computer') throw new Error(`Unknown argument: ${arg}`);
const { readClientConfig } = await import('./client-config.mjs');
const savedConfig = process.env.API_URL && process.env.BOTSPACE_API_TOKEN ? {} : await readClientConfig();
const apiUrl = (process.env.API_URL || savedConfig.apiUrl)?.replace(/\/+$/, '');
const token = process.env.BOTSPACE_API_TOKEN || savedConfig.apiToken;
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS || 180000);
if (!apiUrl || !token) throw new Error('Run npm run access:setup or set API_URL and BOTSPACE_API_TOKEN in the environment. Credentials are never accepted as command-line arguments.');
const parsedUrl = new URL(apiUrl);
if (parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) throw new Error('API_URL must not contain credentials, query parameters, or fragments.');
if (parsedUrl.protocol !== 'https:' && !(parsedUrl.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsedUrl.hostname))) throw new Error('API_URL must use HTTPS, except for a localhost development server.');
if (!Number.isFinite(timeoutMs) || timeoutMs < 1000) throw new Error('SMOKE_TIMEOUT_MS must be at least 1000.');

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = (name) => console.log(`PASS ${name}`);
const fail = (message) => { throw new Error(message); };
let botId;
async function call(path, { method = 'GET', body, authenticated = true, expected, raw = false, timeout = 30000 } = {}) {
  const headers = {};
  if (authenticated) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${apiUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout), redirect: 'error' });
  if (expected !== undefined) assert.equal(response.status, expected, `${method} ${path} returned ${response.status}, expected ${expected}`);
  if (!response.ok && expected === undefined) {
    // Do not print arbitrary response bodies, which could accidentally contain sensitive diagnostics.
    const detail = await response.json().catch(() => ({}));
    fail(`${method} ${path} failed (${response.status}, code ${String(detail.error?.code || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '')})`);
  }
  if (raw) return response;
  return response.json();
}
const path = (suffix = '') => `/v1/bots/${encodeURIComponent(botId)}${suffix}`;
async function waitForRun(runId) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { run } = await call(path(`/runs/${encodeURIComponent(runId)}`));
    if (run.status === 'completed') return run;
    if (['failed', 'cancelled', 'interrupted', 'waiting_approval'].includes(run.status)) fail(`Run ended in ${run.status}; inspect bot ${botId} in the console for details.`);
    await pause(1000);
  }
  fail(`Run did not finish within ${timeoutMs} ms. It was not cancelled; inspect bot ${botId}.`);
}
async function checkEvents() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  let reader;
  try {
    const response = await fetch(`${apiUrl}${path('/events?after=0')}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' }, signal: controller.signal, redirect: 'error' });
    assert.equal(response.status, 200, 'SSE request succeeds');
    assert.match(response.headers.get('content-type') || '', /text\/event-stream/, 'SSE content type');
    assert.ok(response.body, 'SSE response has a body');
    reader = response.body.getReader();
    const decoder = new TextDecoder(); let buffer = '', data = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) fail('Event stream ended before replaying a persisted event.');
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, ''); buffer = buffer.slice(index + 1);
        if (!line && data.length) {
          const event = JSON.parse(data.join('\n')); data = [];
          assert.equal(event.botId, botId, 'SSE event belongs to selected bot');
          assert.ok(Number.isSafeInteger(event.id) && event.id > 0, 'SSE event has a durable cursor');
          return;
        }
        if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
    }
  } finally {
    clearTimeout(timer); controller.abort(); await reader?.cancel().catch(() => {});
  }
}
async function action(value, operationId = randomUUID()) {
  const { result } = await call(path('/computer/actions'), { method: 'POST', body: { operationId, action: value }, timeout: timeoutMs });
  assert.equal(result.operationId, operationId, `${value.type}: operation identity preserved`);
  assert.equal(result.status, 'completed', `${value.type}: computer action completed`);
  assert.ok(!result.error, `${value.type}: completed without a persistence warning; inspect the result in the console`);
  return result;
}

try {
  const health = await call('/health', { authenticated: false, expected: 200 });
  assert.equal(health.ok, true); assert.equal(health.service, 'botspace'); report('public health');
  const denied = await call('/v1/bots', { authenticated: false, raw: true, expected: 401 });
  await denied.body?.cancel(); report('unauthenticated access denied');
  const missing = await call(`/v1/bots/${randomUUID()}`, { raw: true, expected: 404 });
  await missing.body?.cancel(); report('unknown bot inaccessible');

  const marker = `BOTSPACE_SMOKE_${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`;
  const name = `Smoke ${new Date().toISOString().slice(0, 19)} ${marker.slice(-6)}`;
  const { bot } = await call('/v1/bots', { method: 'POST', body: { name, instructions: 'You are a backend smoke-test bot. Follow the requested text response exactly. Do not use tools for this check.' }, expected: 201 });
  botId = bot.id; assert.ok(botId); assert.equal(bot.name, name); report(`named bot created (${botId})`);
  const list = await call('/v1/bots'); assert.ok(list.bots.some((item) => item.id === botId));
  const reread = await call(path()); assert.equal(reread.bot.id, botId); report('bot registry and persistent identity');

  const input = { text: `Reply with exactly this string and nothing else: ${marker}`, operationId: randomUUID() };
  const first = await call(path('/messages'), { method: 'POST', body: input, expected: 202 });
  const duplicate = await call(path('/messages'), { method: 'POST', body: input, expected: 202 });
  assert.equal(duplicate.run.id, first.run.id, 'same operationId returns same run'); report('message submission idempotency');
  await waitForRun(first.run.id); report('real model run completed');

  const history = await call(path('/messages'));
  assert.equal(history.messages.filter((message) => message.role === 'user' && message.text === input.text).length, 1, 'one user message persisted');
  assert.ok(history.messages.some((message) => message.role === 'assistant' && message.text.includes(marker)), 'assistant returned requested marker');
  const historyAgain = await call(path('/messages'));
  assert.deepEqual(historyAgain.messages.map((message) => message.id), history.messages.map((message) => message.id), 'message IDs persist across reads');
  report('model response and persistent conversation');
  await checkEvents(); report('authenticated durable SSE replay');

  if (args.has('--computer')) {
    const before = await call(path('/computer')); assert.equal(before.computer.provider, 'cloudflare');
    const file = `smoke-${randomUUID()}.txt`, content = `Timber persistence smoke: ${marker}\n`;
    await action({ type: 'writeFile', path: file, content });
    const read = await action({ type: 'readFile', path: file }); assert.equal(read.output, content); report('cloud computer writes and reads files');
    const execId = randomUUID();
    const executed = await action({ type: 'exec', command: 'pwd', timeoutMs: 10000 }, execId);
    assert.equal(executed.exitCode, 0); assert.match(executed.output || '', /\/workspace/);
    const replay = await action({ type: 'exec', command: 'pwd', timeoutMs: 10000 }, execId);
    assert.deepEqual(replay, executed, 'completed computer result is deduplicated'); report('terminal execution and operation replay');
    const screenshot = await action({ type: 'screenshot' }); assert.ok(screenshot.artifactId, 'screenshot has artifact');
    const image = await call(path(`/artifacts/${encodeURIComponent(screenshot.artifactId)}`), { raw: true });
    assert.match(image.headers.get('content-type') || '', /^image\/(png|jpeg|webp)/);
    assert.ok((await image.arrayBuffer()).byteLength > 0); report('desktop screenshot artifact');
    const checkpoint = await action({ type: 'checkpoint' }); assert.ok(checkpoint.checkpointId, 'checkpoint has durable reference');
    const after = await call(path('/computer'));
    assert.equal(after.computer.id, before.computer.id, 'same logical computer reused across tools');
    assert.equal(after.computer.lastCheckpointId, checkpoint.checkpointId, 'confirmed checkpoint is published');
    report('computer identity and durable checkpoint metadata');
    const suspended = await call(path('/computer/suspend'), { method: 'POST', body: {}, timeout: timeoutMs });
    assert.equal(suspended.computer.state, 'stopped', 'computer stops after a durable checkpoint');
    assert.ok(suspended.computer.lastCheckpointId, 'suspension confirms a checkpoint');
    const restored = await action({ type: 'readFile', path: file });
    assert.equal(restored.output, content, 'new execution restores the file after container suspension');
    const restarted = await call(path('/computer'));
    assert.equal(restarted.computer.id, before.computer.id, 'restored computer retains its logical identity');
    assert.equal(restarted.computer.state, 'running', 'restored computer is running');
    report('checkpoint restoration after container suspension');
    console.log('NOTE This verifies a controlled suspension and restoration, not an abrupt infrastructure failure. The bot and small workspace file remain for inspection.');
  } else {
    console.log('SKIP Computer checks. Add --computer to exercise actual files, terminal, screenshot, checkpoint and restore.');
  }
  console.log(`Smoke passed. Open ${apiUrl}/console/ and select bot ${botId}.`);
} catch (error) {
  console.error(`FAIL ${error instanceof Error ? error.message : 'Smoke check failed.'}`);
  if (botId) console.error(`Inspect retained bot: ${botId}`);
  process.exitCode = 1;
}
