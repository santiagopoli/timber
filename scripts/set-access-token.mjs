#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, rename, chmod } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { clientConfigUrl } from './client-config.mjs';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: npm run access:setup -- --url https://your-worker.workers.dev\nRequires Wrangler authentication. Replaces this Worker\'s client access token, stores it privately in .local/client.json, and never prints it. Existing clients must use the new token.');
  process.exit(0);
}
if (args.length !== 2 || args[0] !== '--url') throw new Error('Provide --url https://your-worker.workers.dev');
const url = new URL(args[1]);
if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new Error('Use an HTTPS origin without credentials, path, query or fragment.');
const root = fileURLToPath(new URL('../', import.meta.url));
const token = randomBytes(48).toString('base64url');
const child = spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'secret', 'put', 'BOTSPACE_API_TOKEN', '--config', 'apps/api/wrangler.jsonc'], {cwd: root, stdio: ['pipe', 'pipe', 'pipe']});
let diagnostics = '';
for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-16384); });
child.stdin.end(token + '\n');
const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
if (code !== 0) {
  process.stderr.write(diagnostics.replaceAll(token, '[REDACTED]'));
  throw new Error('Cloudflare did not accept the new token; local credentials were not changed.');
}
await mkdir(new URL('../.local/', import.meta.url), {recursive: true, mode: 0o700});
await chmod(new URL('../.local/', import.meta.url), 0o700);
const temporary = new URL('../.local/client.json.tmp', import.meta.url);
await writeFile(temporary, JSON.stringify({apiUrl: url.origin, apiToken: token}, null, 2) + '\n', {mode: 0o600});
await chmod(temporary, 0o600);
await rename(temporary, clientConfigUrl);
console.log('Access configured. Credentials saved only in .local/client.json (0600).\nRun npm run smoke. On macOS, npm run access:copy copies the console token without printing it.');
