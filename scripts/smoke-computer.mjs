#!/usr/bin/env node
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';

const origin = process.env.COMPUTER_URL || 'http://127.0.0.1:8080';
const token = process.env.COMPUTER_TEST_TOKEN;
if (!token) throw new Error('COMPUTER_TEST_TOKEN is required.');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function request(path, options = {}) {
  return fetch(origin + path, {...options, headers:{Authorization:`Bearer ${token}`, 'Content-Type':'application/json', ...options.headers}, signal:AbortSignal.timeout(45000)});
}
let health;
for (let attempt = 0; attempt < 40; attempt++) {
  try {const response = await request('/health'); if (response.ok) {health = await response.json();break;}} catch {}
  await pause(500);
}
assert.equal(health?.ok,true,'computer starts');
assert.equal(health?.desktop,true,'real X11 desktop is available');
assert.equal((await fetch(origin+'/health')).status,401,'unauthenticated container request rejected');
async function action(action, operationId = randomUUID()) {
  const response = await request('/actions',{method:'POST',body:JSON.stringify({operationId,action})});
  assert.equal(response.status,200);
  const result = await response.json();assert.equal(result.status,'completed',JSON.stringify(result));return result;
}
await action({type:'writeFile',path:'image-smoke.txt',content:'Timber image smoke\n'});
assert.equal((await action({type:'readFile',path:'image-smoke.txt'})).output,'Timber image smoke\n');
const operationId = randomUUID();
const command = {type:'exec',command:'printf x >> effect-count.txt; cat effect-count.txt',timeoutMs:10000};
const result = await action(command,operationId);assert.equal(result.exitCode,0);assert.equal(result.output,'x');
assert.deepEqual(await action(command,operationId),result,'effect deduplicated');
assert.equal((await action({type:'readFile',path:'effect-count.txt'})).output,'x','duplicate action did not append again');
// A local page avoids internet/CDN timing and verifies text actually reaches an
// application, rather than merely claiming xdotool returned successfully.
await action({type:'writeFile',path:'desktop-smoke.html',content:'<!doctype html><meta charset="utf-8"><title>Timber desktop smoke</title><textarea autofocus style="width:800px;height:400px;font-size:24px"></textarea>'});
await action({type:'exec',command:'python3 -m http.server 8765 --bind 127.0.0.1 > /state/smoke-http.log 2>&1 < /dev/null & echo $! > /state/smoke-http.pid',timeoutMs:10000});
await action({type:'navigate',url:'http://127.0.0.1:8765/desktop-smoke.html'});
await pause(1000);
const unicodeText = 'Hola, Poli. Café, λ y 👋';
await action({type:'type',text:unicodeText});
await action({type:'key',key:'ctrl+a'});
await action({type:'key',key:'ctrl+c'});
assert.equal((await action({type:'exec',command:'xclip -o -selection clipboard',timeoutMs:10000})).output,unicodeText,'Unicode text pasted into real Chromium textarea');
const image = await action({type:'screenshot'});assert.ok(image.artifactName);
const artifact = await request(`/artifacts/${image.artifactName}`);assert.equal(artifact.status,200);
const pixels = new Uint8Array(await artifact.arrayBuffer());
assert.deepEqual([...pixels.slice(0,8)],[137,80,78,71,13,10,26,10]);
await action({type:'exec',command:'kill "$(cat /state/smoke-http.pid)"',timeoutMs:10000});
const checkpoint = await request('/checkpoint',{method:'POST',body:JSON.stringify({quiesce:true})});
assert.equal(checkpoint.status,200);
const checksum = checkpoint.headers.get('x-content-sha256');assert.match(checksum||'',/^[a-f0-9]{64}$/);
const archive = new Uint8Array(await checkpoint.arrayBuffer());assert.ok(archive.byteLength>0);
assert.equal(createHash('sha256').update(archive).digest('hex'),checksum,'checkpoint checksum matches bytes');
await action({type:'writeFile',path:'image-smoke.txt',content:'changed after checkpoint'});
const restore = await request('/restore',{method:'POST',body:archive,headers:{'Content-Type':'application/gzip','X-Content-SHA256':checksum}});
assert.equal(restore.status,200,'checkpoint restores');
assert.equal((await action({type:'readFile',path:'image-smoke.txt'})).output,'Timber image smoke\n','restore recovers original file');
console.log('PASS Docker desktop: auth, files, shell, side-effect deduplication, Chromium, keyboard, verified Unicode paste, PNG screenshot, checksum and checkpoint restore.');
