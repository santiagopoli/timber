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
assert.ok(health?.capabilities?.includes('execSessions'),'queryable execution is available');
assert.ok(health?.capabilities?.includes('preserveBrowserCheckpoint'),'file checkpoints can preserve Chromium');
assert.equal((await fetch(origin+'/health')).status,401,'unauthenticated container request rejected');
assert.equal((await fetch(origin+'/secure-deploy/capabilities')).status,401,'private deploy capability requires host auth');
const privateCapsResponse=await request('/secure-deploy/capabilities');
assert.equal(privateCapsResponse.status,200);
const privateCaps=await privateCapsResponse.json();
for(const field of ['secureDeploy','privateCredentialChannel','noShellEnv','noBuildCredentialInheritance','outputRedaction']) assert.equal(privateCaps[field],true,`real image private deploy ${field}: ${JSON.stringify(privateCaps)}`);
assert.equal(privateCaps.isolationVersion,'uid-ptrace-v1');
assert.equal(privateCaps.canaryVersion,'cross-uid-proc-env-v1');
async function action(action, operationId = randomUUID()) {
  const response = await request('/actions',{method:'POST',body:JSON.stringify({operationId,action})});
  assert.equal(response.status,200);
  let result = await response.json();
  const deadline = Date.now() + 30000;
  while (result.status === 'running' && Date.now() < deadline) {
    assert.ok(result.processId,'running execution has a process ID');
    const polled = await request('/actions',{method:'POST',body:JSON.stringify({operationId:randomUUID(),action:{type:'execPoll',processId:result.processId,yieldMs:1000}})});
    assert.equal(polled.status,200);result = {...await polled.json(),operationId};
  }
  assert.equal(result.status,'completed',JSON.stringify(result));return result;
}
const isolation=await action({type:'exec',command:'id -u; printf "token=%s\\n" "${BOTSPACE_COMPUTER_TOKEN+visible}"; ps -eo uid,comm | grep openbox'});
assert.equal(isolation.exitCode,0);
assert.match(isolation.output,/^10001\ntoken=\n\s*10001 openbox\n$/,'shell/desktop unprivileged and controller token not inherited');
const escalation=await action({type:'exec',command:'setpriv --reuid=0 -- /bin/true 2>/dev/null'});
assert.notEqual(escalation.exitCode,0,'workspace shell cannot regain root');
await action({type:'writeFile',path:'image-smoke.txt',content:'Timber image smoke\n'});
assert.equal((await action({type:'readFile',path:'image-smoke.txt'})).output,'Timber image smoke\n');
const operationId = randomUUID();
const command = {type:'exec',command:'printf x >> effect-count.txt; cat effect-count.txt',timeoutMs:10000};
const result = await action(command,operationId);assert.equal(result.exitCode,0);assert.equal(result.output,'x');
assert.equal(result.workspaceChanged,true,'real shell writes report persistent file changes');
assert.equal((await action({type:'exec',command:'cd /workspace && grep -n Timber image-smoke.txt',timeoutMs:10000})).workspaceChanged,false,'cd and grep do not report file changes');
assert.deepEqual(await action(command,operationId),result,'effect deduplicated');
assert.equal((await action({type:'readFile',path:'effect-count.txt'})).output,'x','duplicate action did not append again');
const cancellableId = randomUUID();
const cancellableResponse = await request('/actions',{method:'POST',body:JSON.stringify({operationId:cancellableId,action:{type:'exec',command:'printf cancellable; sleep 30',yieldMs:1000}})});
assert.equal(cancellableResponse.status,200);
const cancellable = await cancellableResponse.json();
assert.equal(cancellable.status,'running','yield does not kill a long command');
assert.equal(cancellable.processId,cancellableId);
await action({type:'exec',command:'printf concurrent'});
const cancellation = await request('/actions',{method:'POST',body:JSON.stringify({operationId:randomUUID(),action:{type:'execCancel',processId:cancellableId}})});
assert.equal(cancellation.status,200);
const cancelled = await cancellation.json();assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.output,'cancellable');
// A local page avoids internet/CDN timing and verifies text actually reaches an
// application, rather than merely claiming xdotool returned successfully.
await action({type:'writeFile',path:'desktop-smoke.html',content:'<!doctype html><meta charset="utf-8"><title>Timber desktop smoke</title><textarea autofocus style="width:800px;height:400px;font-size:24px"></textarea>'});
await action({type:'exec',command:'python3 -m http.server 8765 --bind 127.0.0.1 > /tmp/smoke-http.log 2>&1 < /dev/null & echo $! > /tmp/smoke-http.pid',timeoutMs:10000});
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
const browserWindow = (await action({type:'exec',command:'xdotool search --onlyvisible --class chromium'})).output;
const browserPidCommand='xdotool search --onlyvisible --class chromium | xargs -r -n 1 xdotool getwindowpid';
const browserPid=(await action({type:'exec',command:browserPidCommand})).output;
assert.match(browserPid,/^\d+\s*$/,'real Chromium has a process identity');
for (let attempt=0;attempt<2;attempt++) {
  const saved=await request('/checkpoint',{method:'POST',body:JSON.stringify({preserveBrowser:true})});
  assert.equal(saved.status,200,'automatic checkpoint succeeds with Chromium running');
  await saved.arrayBuffer();
  assert.equal((await action({type:'exec',command:'xdotool search --onlyvisible --class chromium'})).output,browserWindow,'automatic checkpoints preserve the real Chromium window');
  assert.equal((await action({type:'exec',command:browserPidCommand})).output,browserPid,'automatic checkpoints preserve the real Chromium process');
}
await action({type:'key',key:'ctrl+a'});
await action({type:'key',key:'ctrl+c'});
assert.equal((await action({type:'exec',command:'xclip -o -selection clipboard'})).output,unicodeText,'automatic checkpoints preserve live textarea state');
await action({type:'exec',command:'kill "$(cat /tmp/smoke-http.pid)"',timeoutMs:10000});
const checkpoint = await request('/checkpoint',{method:'POST',body:JSON.stringify({quiesce:true})});
assert.equal(checkpoint.status,200);
const checksum = checkpoint.headers.get('x-content-sha256');assert.match(checksum||'',/^[a-f0-9]{64}$/);
const archive = new Uint8Array(await checkpoint.arrayBuffer());assert.ok(archive.byteLength>0);
assert.equal(createHash('sha256').update(archive).digest('hex'),checksum,'checkpoint checksum matches bytes');
await action({type:'writeFile',path:'image-smoke.txt',content:'changed after checkpoint'});
const restore = await request('/restore',{method:'POST',body:archive,headers:{'Content-Type':'application/gzip','X-Content-SHA256':checksum}});
assert.equal(restore.status,200,'checkpoint restores');
assert.equal((await action({type:'readFile',path:'image-smoke.txt'})).output,'Timber image smoke\n','restore recovers original file');
console.log('PASS Docker desktop: auth, files, queryable shell sessions, cancellation, side-effect deduplication, Chromium reuse during checkpoints, keyboard, verified Unicode paste, PNG screenshot, checksum and checkpoint restore.');
