import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer, request as httpRequest} from 'node:http';
import {once} from 'node:events';
import {createTransportServer} from '../../infra/computer/chatgpt-transport.mjs';

const token = 'a'.repeat(64);
const headers = {'x-timber-transport-token': token, authorization: 'Bearer test-only-oauth'};
async function fixture(handler) {
  const calls = [];
  const upstream = createServer(handler); upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const transport = createTransportServer({token, requestImpl: (options, callback) => {
    calls.push(options);
    return httpRequest({...options, protocol: 'http:', hostname: '127.0.0.1', port: upstream.address().port}, callback);
  }});
  transport.listen(0, '127.0.0.1'); await once(transport, 'listening');
  return {calls, url: `http://127.0.0.1:${transport.address().port}`, close: async () => {
    for (const server of [transport, upstream]) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  }};
}

test('private transport rejects missing authority and arbitrary destinations before network I/O', async () => {
  const f = await fixture((_req, res) => res.end());
  try {
    assert.equal((await fetch(`${f.url}/v1/models`)).status, 401);
    assert.equal((await fetch(`${f.url}/v1/models`, {headers: {...headers, 'x-timber-transport-token': 'b'.repeat(64)}})).status, 401);
    for (const path of ['/https://other.test/', '/v1/models?target=other', '/v1/models/../responses', '/exec', '/health?credentials=1']) {
      assert.equal((await fetch(`${f.url}${path}`, {headers})).status, 404);
    }
    assert.equal((await fetch(`${f.url}/v1/models`, {headers: {'x-timber-transport-token': token}})).status, 401);
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test('models go to the fixed HTTPS origin without forwarding owner, cookie or internal authority', async () => {
  const f = await fixture((req, res) => {
    assert.equal(req.headers.authorization, headers.authorization);
    assert.equal(req.headers['x-timber-transport-token'], undefined);
    assert.equal(req.headers.cookie, undefined);
    res.setHeader('set-cookie', 'private-provider-cookie'); res.setHeader('x-request-id', 'test-only-request');
    res.setHeader('content-type', 'application/json'); res.end('{"models":[]}');
  });
  try {
    const response = await fetch(`${f.url}/v1/models`, {headers: {...headers, cookie: 'private-owner-cookie', 'x-timber-internal': 'must-not-forward'}});
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), {models: []});
    assert.equal(response.headers.get('set-cookie'), null); assert.equal(response.headers.get('x-request-id'), 'test-only-request');
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].protocol, 'https:'); assert.equal(f.calls[0].hostname, 'api.openai.com');
    assert.equal(f.calls[0].path, '/v1/models'); assert.equal(f.calls[0].headers['x-timber-internal'], undefined);
  } finally { await f.close(); }
});

test('responses preserve streaming, input and cache affinity; active health protects the live stream', async () => {
  let release;
  const body = JSON.stringify({model: 'test-model', store: false, stream: true, input: []});
  const f = await fixture(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    assert.equal(text, body); assert.equal(req.headers.session_id, 'b'.repeat(64));
    res.setHeader('content-type', 'text/event-stream'); res.write('event: response.created\ndata: {}\n\n');
    await new Promise(resolve => {release = resolve;});
    res.end('event: response.completed\ndata: {"type":"response.completed"}\n\n');
  });
  try {
    const response = await fetch(`${f.url}/v1/responses`, {method: 'POST', headers: {...headers, session_id: 'b'.repeat(64)}, body});
    const reader = response.body.getReader(); const first = await reader.read();
    assert.match(new TextDecoder().decode(first.value), /response.created/);
    const health = await (await fetch(`${f.url}/health`, {headers})).json(); assert.equal(health.active, 1);
    release(); let remainder = ''; for (;;) { const part = await reader.read(); if (part.done) break; remainder += new TextDecoder().decode(part.value); }
    assert.match(remainder, /response.completed/); assert.equal(f.calls.length, 1);
    assert.equal((await (await fetch(`${f.url}/health`, {headers})).json()).active, 0);
  } finally { release?.(); await f.close(); }
});

test('origin redirects and failed POSTs are returned without following or replaying them', async () => {
  let fail = false;
  const f = await fixture((req, res) => { if (fail) req.socket.destroy(); else {res.writeHead(302, {location: 'https://unapproved.test'}); res.end();} });
  try {
    assert.equal((await fetch(`${f.url}/v1/models`, {headers, redirect: 'manual'})).status, 302);
    fail = true;
    assert.equal((await fetch(`${f.url}/v1/responses`, {method: 'POST', headers, body: '{}'})).status, 502);
    assert.equal(f.calls.length, 2);
  } finally { await f.close(); }
});

test('cancelling a streamed response closes the upstream connection', async () => {
  let resolveClosed;
  const closed = new Promise(resolve => {resolveClosed = resolve;});
  const f = await fixture((req, res) => {
    res.writeHead(200, {'content-type': 'text/event-stream'}); res.write('data: {}\n\n');
    res.once('close', resolveClosed);
  });
  try {
    const response = await fetch(`${f.url}/v1/responses`, {method: 'POST', headers, body: '{}'});
    await response.body.cancel();
    await Promise.race([closed, new Promise((_, reject) => {const timer = setTimeout(() => reject(new Error('upstream_not_cancelled')), 3000); timer.unref();})]);
    assert.equal(f.calls.length, 1);
  } finally { await f.close(); }
});

test('oversized input is rejected before dispatch', async () => {
  const f = await fixture((_req, res) => res.end());
  try {
    const response = await fetch(`${f.url}/v1/responses`, {method: 'POST', headers, body: 'x'.repeat(8 * 1024 * 1024 + 1)});
    assert.equal(response.status, 413); await response.arrayBuffer(); assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});
