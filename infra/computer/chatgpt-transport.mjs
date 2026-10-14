import {createServer} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {timingSafeEqual} from 'node:crypto';
import {pathToFileURL} from 'node:url';

const MAX_BODY = 8 * 1024 * 1024;
const responseHeaders = ['content-type', 'content-encoding', 'x-request-id', 'cf-ray'];

// This process is a dedicated server transport, never a bot computer. No shell,
// filesystem API, arbitrary destination, redirects, credential storage or logs.
export function createTransportServer({token, requestImpl = httpsRequest}) {
  if (!/^[a-f0-9]{64}$/.test(token ?? '')) throw new Error('transport_not_configured');
  let active = 0;
  const authorized = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) && timingSafeEqual(Buffer.from(value), Buffer.from(token));
  return createServer(async (incoming, outgoing) => {
    outgoing.setHeader('cache-control', 'no-store');
    const reject = status => { incoming.resume(); outgoing.writeHead(status); outgoing.end(); };
    if (!authorized(incoming.headers['x-timber-transport-token'])) return reject(401);
    if (incoming.url === '/health' && incoming.method === 'GET') {
      outgoing.setHeader('content-type', 'application/json');
      outgoing.end(JSON.stringify({ok: true, active})); return;
    }
    if (!(incoming.url === '/v1/models' && incoming.method === 'GET' || incoming.url === '/v1/responses' && incoming.method === 'POST')) return reject(404);
    const authorization = incoming.headers.authorization;
    if (typeof authorization !== 'string' || !/^Bearer [\x21-\x7e]{1,32000}$/.test(authorization)) return reject(401);
    const controller = new AbortController();
    const abort = () => { if (!outgoing.writableFinished) controller.abort(); };
    incoming.once('aborted', abort); outgoing.once('close', abort);
    active++;
    let settled = false;
    const finish = () => { if (!settled) { settled = true; active--; } };
    outgoing.once('finish', finish); outgoing.once('close', finish);
    try {
      const chunks = []; let size = 0;
      for await (const chunk of incoming.iterator({destroyOnReturn: false})) {
        size += chunk.length;
        if (size > MAX_BODY) { reject(413); return; }
        chunks.push(chunk);
      }
      if (controller.signal.aborted) return;
      const body = Buffer.concat(chunks);
      const headers = {authorization, accept: 'application/json', 'accept-encoding': 'identity', 'user-agent': 'Timber/0.1.0'};
      if (incoming.method === 'POST') {
        headers['content-type'] = 'application/json'; headers['content-length'] = String(body.length);
        const session = incoming.headers.session_id;
        if (typeof session === 'string' && /^[a-f0-9]{64}$/.test(session)) headers.session_id = session;
      }
      const upstream = requestImpl({protocol: 'https:', hostname: 'api.openai.com', port: 443, path: incoming.url,
        method: incoming.method, headers, signal: controller.signal}, response => {
        for (const name of responseHeaders) if (response.headers[name]) outgoing.setHeader(name, response.headers[name]);
        outgoing.writeHead(response.statusCode ?? 502);
        response.on('error', () => outgoing.destroy());
        response.pipe(outgoing);
      });
      upstream.setTimeout(incoming.method === 'GET' ? 15_000 : 30 * 60_000, () => controller.abort());
      upstream.on('error', () => {
        if (outgoing.headersSent) outgoing.destroy();
        else { outgoing.writeHead(502); outgoing.end(); }
      });
      // Exactly one dispatch. An uncertain POST is never replayed.
      upstream.end(body);
    } catch {
      if (outgoing.headersSent) outgoing.destroy();
      else { outgoing.writeHead(502); outgoing.end(); }
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const token = process.env.TIMBER_TRANSPORT_TOKEN;
  delete process.env.TIMBER_TRANSPORT_TOKEN;
  try { createTransportServer({token}).listen(8080, '0.0.0.0'); }
  catch { process.stderr.write('transport_not_configured\n'); process.exitCode = 1; }
}
