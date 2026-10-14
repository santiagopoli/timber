// Real production image check. No OAuth values and no external API call.
const base = process.env.TRANSPORT_TEST_URL ?? 'http://127.0.0.1:8082';
const token = process.env.TRANSPORT_TEST_TOKEN;
if (!/^[a-f0-9]{64}$/.test(token ?? '')) throw new Error('transport_smoke_not_configured');
let healthy = false;
for (let attempt = 0; attempt < 60; attempt++) {
  try {
    const response = await fetch(`${base}/health`, {headers: {'x-timber-transport-token': token}, signal: AbortSignal.timeout(1000)});
    const value = await response.json(); if (response.ok && value.ok === true && value.active === 0) {healthy = true; break;}
  } catch { /* Wait only for image startup, never repeat inference. */ }
  await new Promise(resolve => setTimeout(resolve, 250));
}
if (!healthy) throw new Error('transport_smoke_not_ready');
for (const [path, headers, expected] of [['/health', {}, 401], ['/exec', {'x-timber-transport-token': token}, 404], ['/v1/models', {'x-timber-transport-token': token}, 401]]) {
  const response = await fetch(`${base}${path}`, {headers});
  if (response.status !== expected) throw new Error('transport_smoke_boundary_failed'); await response.arrayBuffer();
}
console.log('Private ChatGPT transport image passed; no provider request was sent.');
