/** Local-only HTTP fixture for browser regression tests. Never deployed. */
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve, extname, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {deflateSync} from 'node:zlib';

export const TEST_TOKEN = 'console-browser-test-token-only';
export const BOT_A = '10000000-0000-4000-8000-000000000001';
export const BOT_B = '10000000-0000-4000-8000-000000000002';
const active = new Set(['queued', 'running', 'waiting_approval', 'waiting_connection']);
function png() {
  const chunk = (type, bytes) => {
    const data = Buffer.concat([Buffer.from(type), bytes]); let crc = 0xffffffff;
    for (const byte of data) {crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);}
    const head = Buffer.alloc(4), tail = Buffer.alloc(4); head.writeUInt32BE(bytes.length); tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([head, data, tail]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(1280); header.writeUInt32BE(800, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc((1280 * 3 + 1) * 800, 80); for (let y = 0; y < 800; y++) pixels[y * (1280 * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
const image = png();
const consoleRoot = fileURLToPath(new URL('../../apps/console/dist/', import.meta.url));
const assetTypes = new Map([['.html', 'text/html'], ['.js', 'text/javascript'], ['.css', 'text/css'], ['.svg', 'image/svg+xml'], ['.png', 'image/png'], ['.woff', 'font/woff'], ['.woff2', 'font/woff2'], ['.ttf', 'font/ttf'], ['.wasm', 'application/wasm']]);
export async function createConsoleFixture({port = 0} = {}) {
  // Exercise the same bundled React island and asset graph that is deployed.
  await readFile(resolve(consoleRoot, 'index.html'));
  const date = '2026-10-05T10:00:00.000Z';
  const state = {
    githubConnected: false, connectionGate: null, appOpenGate: null, appRefreshStates: new Map(), appRefreshGate: null, previewCalls: [], rejectAuth: false, actionGate: null, readsGate: null, messageGates: new Map(), messageResponseGates: new Map(), messageOperations: new Map(), patchGate: null, patchError: null, deleteGates: new Map(), deleteError: null, deletingBots: new Set(), deletedBots: new Set(), approvalGate: null, approvalError: null, approvalStatus: null, computerStates: new Map(), computerStatusGate: null, failures: [], actions: [], calls: [], streams: new Set(), events: [],
    bots: [
      {id: BOT_A, name: 'Ada', instructions: 'Research and turn findings into useful notes.', model: 'gpt-6.1-sol', runtime: 'pi', createdAt: date, updatedAt: date},
      {id: BOT_B, name: 'Linus', instructions: 'Help build and maintain software.', model: 'gpt-6.1-sol', runtime: 'pi', createdAt: date, updatedAt: date},
    ],
    messages: new Map([[BOT_A, [
      {id: 'message-one', botId: BOT_A, role: 'user', text: 'Organize the research notes and prepare a summary.', createdAt: date},
      {id: 'message-two', botId: BOT_A, role: 'assistant', text: 'The notes are ready. **Three themes** stood out:\n\n- Persistent conversations\n- Reusable computers\n- Portable workspaces\n\n```sh\ncat notes/summary.md\n```', createdAt: date},
    ]], [BOT_B, []]]),
    connections: new Map([[BOT_A, []], [BOT_B, []]]), apps: new Map([[BOT_A, []], [BOT_B, []]]), runs: new Map([[BOT_A, []], [BOT_B, []]]), approvals: new Map([[BOT_A, []], [BOT_B, []]]), nextEventId: 0,
  };
  state.deliver = event => {for (const stream of state.streams) if (stream.botId === event.botId) stream.response.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);};
  state.emit = (botId, type, data, runId) => {
    const event = {id: ++state.nextEventId, botId, type, data, runId, createdAt: new Date().toISOString()}; state.events.push(event); state.deliver(event); return event;
  };
  const preview = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    state.previewCalls.push({method: request.method, url: request.url, authorization: request.headers.authorization, cookie: request.headers.cookie, body: raw});
    const url = new URL(request.url, state.previewOrigin);
    if (url.pathname === '/access' && request.method === 'POST') {
      const ticket = new URLSearchParams(raw).get('ticket'), app = [...state.apps.values()].flat().find(item => `fixture-ticket-${item.id}` === ticket);
      if (!app) {response.writeHead(403).end('Access denied'); return;}
      response.writeHead(303, {'location': app.url, 'set-cookie': 'fixture_app_access=granted; HttpOnly; SameSite=Lax; Path=/'}).end(); return;
    }
    if (!request.headers.cookie?.includes('fixture_app_access=granted')) {response.writeHead(401).end('Open this app from Timber'); return;}
    response.writeHead(200, {'content-type': 'text/html'}).end('<!doctype html><title>Workspace app</title><h1>Workspace app is available</h1>');
  });
  await new Promise(resolve => preview.listen(0, '127.0.0.1', resolve));
  state.previewOrigin = `http://127.0.0.1:${preview.address().port}`;
  state.appURL = (botId, appId) => `${state.previewOrigin}/apps/${botId}.${appId}/`;
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://fixture'), path = url.pathname;
      const json = (data, status = 200) => {response.writeHead(status, {'content-type': 'application/json', 'cache-control': 'no-store'}); response.end(JSON.stringify(data));};
      if (path.startsWith('/console/')) {
        const filename = path === '/console/' ? 'index.html' : decodeURIComponent(path.slice('/console/'.length));
        const asset = resolve(consoleRoot, filename), contentType = assetTypes.get(extname(asset));
        if (!asset.startsWith(consoleRoot + (consoleRoot.endsWith(sep) ? '' : sep)) || !contentType) {response.writeHead(404).end(); return;}
        let data; try {data = await readFile(asset);} catch (error) {if (error.code === 'ENOENT') {response.writeHead(404).end(); return;} throw error;}
        response.writeHead(200, {'content-type': contentType, 'content-security-policy': `default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' blob: data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self' ${state.previewOrigin}`}); response.end(data); return;
      }
      if (path === '/github-connect') {response.writeHead(200, {'content-type': 'text/html'}).end('<!doctype html><title>GitHub connection</title><p>GitHub consent fixture</p>'); return;}
      if (state.rejectAuth || request.headers.authorization !== `Bearer ${TEST_TOKEN}`) return json({error: {code: 'unauthorized', message: 'Token rejected.'}}, 401);
      let body; if (!['GET', 'HEAD'].includes(request.method)) {let raw = ''; for await (const chunk of request) raw += chunk; body = raw ? JSON.parse(raw) : {};}
      state.calls.push({path: request.url, method: request.method, body});
      if (path === '/v1/connections/github/connect' && request.method === 'POST') return json({url: '/github-connect', connected: false});
      if (path === '/v1/connections/github') {if (request.method === 'DELETE') state.githubConnected = false; return json({connected: state.githubConnected});}
      if (path === '/v1/connections/chatgpt') return json({connected: true, status: 'verified', model: 'gpt-6.1-sol', verifiedAt: date});
      if (path === '/v1/bots') {
        if (request.method === 'GET') return json({bots: state.bots.filter(bot => !state.deletingBots.has(bot.id))});
        const bot = {id: randomUUID(), ...body, runtime: 'pi', createdAt: date, updatedAt: date}; state.bots.unshift(bot); state.messages.set(bot.id, []); state.runs.set(bot.id, []); state.approvals.set(bot.id, []); state.connections.set(bot.id, []); state.apps.set(bot.id, []); return json({bot}, 201);
      }
      const match = /^\/v1\/bots\/([^/]+)(.*)$/.exec(path); if (!match) return json({}, 404);
      const [, id, tail] = match, bot = state.bots.find(bot => bot.id === id);
      if (!tail && request.method === 'DELETE') {
        if (state.deletedBots.has(id)) return json({botId: id, deleted: true});
        if (!bot) return json({error: {code: 'not_found', message: 'Bot not found.'}}, 404);
        state.deletingBots.add(id);
        if (state.deleteGates.has(id)) await state.deleteGates.get(id);
        if (state.deleteError) return json({error: state.deleteError}, state.deleteError.status || 503);
        state.bots = state.bots.filter(item => item.id !== id); state.messages.delete(id); state.runs.delete(id); state.approvals.delete(id); state.connections.delete(id); state.apps.delete(id); state.computerStates.delete(id);
        for (const key of state.messageOperations.keys()) if (key.startsWith(`${id}:`)) state.messageOperations.delete(key);
        for (const stream of state.streams) if (stream.botId === id) stream.response.end();
        state.events = state.events.filter(event => event.botId !== id);
        state.deletingBots.delete(id); state.deletedBots.add(id);
        return json({botId: id, deleted: true});
      }
      if (!bot || state.deletingBots.has(id)) return json({}, 404);
      if (!tail) {if (request.method === 'PATCH') {if (state.patchGate) await state.patchGate; if (state.patchError) return json({error: state.patchError}, state.patchError.status || 503); Object.assign(bot, body);} return json({bot});}
      if (tail === '/messages') {
        if (request.method === 'GET') {const snapshot = structuredClone(state.messages.get(id)); if (state.readsGate) await state.readsGate; return json({messages: snapshot});}
        if (state.messageGates.has(id)) await state.messageGates.get(id);
        if (typeof body.text !== 'string' || !body.text.trim() || typeof body.operationId !== 'string' || !body.operationId) return json({error: {code: 'invalid_request', message: 'text and operationId are required.'}}, 400);
        const key = `${id}:${body.operationId}`, previous = state.messageOperations.get(key);
        if (previous) {
          if (previous.text !== body.text) return json({error: {code: 'operation_conflict', message: 'This operation ID belongs to another message.'}}, 409);
          return json({run: previous.run}, 202);
        }
        const run = {id: randomUUID(), botId: id, operationId: body.operationId, status: 'queued', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()};
        state.messageOperations.set(key, {run, text: body.text}); state.runs.get(id).unshift(run); state.messages.get(id).push({id: randomUUID(), botId: id, runId: run.id, role: 'user', text: body.text, createdAt: run.createdAt});
        if (state.messageResponseGates.has(id)) await state.messageResponseGates.get(id);
        return json({run}, 202);
      }
      if (tail === '/runs') {
        const all = state.runs.get(id), offset = Number(url.searchParams.get('before') || 0), limit = Number(url.searchParams.get('limit') || 30);
        return json({runs: all.slice(offset, offset + limit), activeRuns: all.filter(run => active.has(run.status)), nextCursor: offset + limit < all.length ? String(offset + limit) : null});
      }
      if (tail.startsWith('/runs/')) {const run = state.runs.get(id).find(run => run.id === tail.split('/')[2]); if (!run) return json({}, 404); if (tail.endsWith('/cancel')) {run.status = 'cancelled'; run.updatedAt = new Date().toISOString();} return json({run});}
      if (tail === '/connections') return json({connections: state.connections.get(id)});
      if (/^\/connections\/[^/]+\/connect$/.test(tail)) {if (state.connectionGate) await state.connectionGate; return json({url: `http://127.0.0.1:${server.address().port}/github-connect`});}
      if (tail === '/apps') return json({apps: state.apps.get(id)});
      if (tail === '/apps/refresh' && request.method === 'POST') {if (state.appRefreshGate) await state.appRefreshGate; for (const app of state.apps.get(id)) {const next = state.appRefreshStates.get(`${id}:${app.id}`); if (next) app.state = next;} return json({apps: state.apps.get(id)});}
      if (/^\/apps\/[^/]+\/open$/.test(tail)) {if (state.appOpenGate) await state.appOpenGate; return json({actionUrl: `${state.previewOrigin}/access`, ticket: `fixture-ticket-${tail.split('/')[2]}`, expiresAt: new Date(Date.now() + 60000).toISOString()});}
      if (/^\/apps\/[^/]+$/.test(tail) && request.method === 'DELETE') {state.apps.set(id, state.apps.get(id).filter(app => app.id !== tail.split('/')[2])); return json({deleted: true});}
      if (tail === '/approvals') return json({approvals: state.approvals.get(id)});
      if (tail.startsWith('/approvals/')) {if (state.approvalGate) await state.approvalGate; if (state.approvalError) return json({error: state.approvalError}, state.approvalError.status || 409); const approval = state.approvals.get(id).find(item => item.id === tail.split('/')[2]); approval.status = body.decision === 'deny' ? 'denied' : state.approvalStatus || 'completed'; return json({approval});}
      if (tail === '/events') {
        response.writeHead(200, {'content-type': 'text/event-stream', 'cache-control': 'no-cache'}); response.write(': connected\n\n');
        for (const event of state.events) if (event.botId === id && event.id > Number(url.searchParams.get('after') || 0)) response.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
        const stream = {botId: id, response}; state.streams.add(stream); response.on('close', () => state.streams.delete(stream)); return;
      }
      if (tail === '/computer') {const computer = {id, provider: 'cloudflare', state: 'running', capabilities: ['exec', 'readFile', 'writeFile', 'listFiles', 'screenshot', 'click'], ...state.computerStates.get(id)}; if (state.computerStatusGate) await state.computerStatusGate; return json({computer});}
      if (tail === '/computer/actions') {
        state.actions.push({botId: id, ...body}); if (state.actionGate) await state.actionGate;
        const {action, operationId} = body;
        const result = {operationId, status: 'completed'};
        if (action.type === 'screenshot') Object.assign(result, {artifactId: '10000000-0000-4000-8000-000000000099', mimeType: 'image/png'});
        if (action.type === 'listFiles') result.output = JSON.stringify(action.path === 'notes' ? [{name: 'summary.md', kind: 'file'}] : [{name: 'notes', kind: 'directory'}, {name: 'readme.txt', kind: 'file'}]);
        if (action.type === 'readFile') result.output = `Contents of ${action.path}`;
        if (action.type === 'exec') Object.assign(result, {output: '/workspace\n', exitCode: 0, checkpointId: 'fixture-checkpoint'});
        return json({result});
      }
      if (tail.startsWith('/artifacts/')) {response.writeHead(200, {'content-type': 'image/png'}).end(image); return;}
      return json({error: {code: 'not_found', message: 'Unknown fixture route.'}}, 404);
    } catch (error) {state.failures.push(String(error)); response.writeHead(500).end('{}');}
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return {state, url: `http://127.0.0.1:${server.address().port}/console/`, close: async () => {for (const {response} of state.streams) response.end(); server.closeAllConnections(); preview.closeAllConnections(); await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => preview.close(resolve))]);}};
}
