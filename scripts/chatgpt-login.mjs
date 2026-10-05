#!/usr/bin/env node
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { readClientConfig } from './client-config.mjs';

export const OPENAI_ISSUER = 'https://auth.openai.com';
export const AUTHORIZATION_ENDPOINT = `${OPENAI_ISSUER}/api/accounts/authorize`;
export const TOKEN_ENDPOINT = `${OPENAI_ISSUER}/api/accounts/oauth/token`;
export const RESOURCE = 'https://api.openai.com/v1';
export const MODEL = 'gpt-6.1-sol';
export const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const DYNAMIC_CLIENT = 'dynamic_agent_client';
const REGISTRATION_URL = new URL('../.local/chatgpt-registration.json', import.meta.url);
const SAFE_ALGORITHMS = ['RS256', 'PS256', 'ES256', 'EdDSA'];

export class LoginError extends Error {}
const fail = (message) => { throw new LoginError(message); };
const opaque = (value, max = 512) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x20\x7f]/.test(value);
const issuedClient = (value) => opaque(value, 256) && /^[A-Za-z0-9_-]+$/.test(value) && value !== DYNAMIC_CLIENT;
const equals = (left, right) => typeof left === 'string' && typeof right === 'string' && Buffer.byteLength(left) === Buffer.byteLength(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right));

export async function loadConnectionConfig() {
  const saved = process.env.API_URL && process.env.BOTSPACE_API_TOKEN ? {} : await readClientConfig();
  const value = process.env.API_URL || saved.apiUrl, apiToken = process.env.BOTSPACE_API_TOKEN || saved.apiToken;
  if (!value || !apiToken) fail('Run npm run access:setup first, or set API_URL and BOTSPACE_API_TOKEN.');
  let url;
  try { url = new URL(value); } catch { fail('API_URL is not a valid URL.'); }
  const local = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !local) fail('The Timber API must use HTTPS, except for a local development server.');
  if (url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) fail('API_URL must be an origin with no credentials, query, or path.');
  return { apiUrl: url.origin, apiToken };
}

export async function cloudRequest(config, { method = 'GET', suffix = '', body, fetchImpl = fetch } = {}) {
  let response;
  try {
    response = await fetchImpl(`${config.apiUrl}/v1/connections/chatgpt${suffix}`, {
      method, headers: { Authorization: `Bearer ${config.apiToken}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(60000),
    });
  } catch { fail('Could not reach Timber. Check your connection and API_URL; no credentials were printed.'); }
  let value;
  try { value = await response.json(); } catch { fail('Timber returned an invalid response. Check the deployed backend version.'); }
  if (!response.ok) {
    const code = typeof value?.error?.code === 'string' ? value.error.code : '';
    const messages = {
      unauthorized: 'Timber access was rejected. Run npm run access:setup with the current API token.',
      not_found: 'This backend does not have ChatGPT connections enabled. Deploy the current backend first.',
      chatgpt_not_connected: 'ChatGPT is not connected. Run npm run chatgpt:login on your computer.',
      chatgpt_reauthentication_required: 'ChatGPT needs authorization again. Run npm run chatgpt:login.',
      chatgpt_reauthorization_required: 'ChatGPT needs authorization again. Run npm run chatgpt:login.',
      chatgpt_not_configured: 'The backend ChatGPT credential key is not configured. Configure its credential secret before signing in.',
      chatgpt_scope_missing: 'ChatGPT plan use was not granted. Sign in again and enable plan use.',
      chatgpt_host_mismatch: 'The authorization belongs to a different Timber host. Start sign-in again against this deployment.',
      chatgpt_invalid_identity: 'The backend could not validate the ChatGPT identity. Complete a fresh sign-in.',
      chatgpt_account_mismatch: 'Disconnect the existing ChatGPT connection before importing another account registration.',
      chatgpt_refresh_pending: 'OpenAI has not allowed renewal yet. Keep the connection and try again shortly.',
      chatgpt_refresh_failed: 'Token renewal failed temporarily. The connection is retained; try again later.',
      chatgpt_connection_changed: 'The connection changed during verification. Run npm run chatgpt:status -- --verify again.',
      chatgpt_verification_incomplete: 'The verification response did not complete. Model access has not been confirmed.',
      subscription_sharing_user_not_eligible: 'ChatGPT plan sharing is unavailable for this account, workspace, or policy.',
      subscription_sharing_usage_limit_exceeded: 'The plan allowance available to Timber has been reached. Check ChatGPT Settings → Usage.',
      subscription_sharing_usage_unavailable: 'ChatGPT could not check available usage. Try verification again later.',
      subscription_sharing_route_not_supported: 'OpenAI has not enabled this ChatGPT plan route for the integration.',
      subscription_sharing_unsupported_capability: 'OpenAI rejected a requested capability on this ChatGPT plan route.',
      subscription_sharing_invalid_user: 'OpenAI could not validate this ChatGPT connection. Sign in again.',
      chatpass_v2_scope_not_authorized: 'The ChatGPT authorization does not permit this request. Sign in again and enable plan use.',
      chatpass_v2_invalid_authorization_context: 'The ChatGPT authorization context does not permit this request.',
      chatgpt_insufficient_scope: 'ChatGPT plan use was not granted. Authorize Timber to use your ChatGPT plan.',
      chatgpt_model_unavailable: 'gpt-6.1-sol is not available to this ChatGPT account or workspace.',
      chatgpt_rate_limited: 'ChatGPT usage is currently limited. Review your plan usage and try verification later.',
      chatgpt_identity_mismatch: 'The returned ChatGPT account differs from the saved registration. The connection was not replaced.',
    };
    fail(messages[code] || (response.status === 401 ? messages.unauthorized : `Timber could not complete this request (HTTP ${response.status}). Inspect the connection status in the console.`));
  }
  return value;
}

export async function readRegistration(config, hostId, metadataUrl = REGISTRATION_URL) {
  try {
    const saved = JSON.parse(await readFile(metadataUrl, 'utf8'));
    if (saved.apiOrigin !== config.apiUrl || saved.hostId !== hostId || !issuedClient(saved.clientId)) return null;
    if (saved.subject !== undefined && !opaque(saved.subject)) fail('The local ChatGPT registration metadata is invalid.');
    return saved;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error instanceof LoginError) throw error;
    fail('Cannot read local ChatGPT registration metadata. Repair or remove .local/chatgpt-registration.json.');
  }
}

export async function saveRegistration(config, hostId, registration, metadataUrl = REGISTRATION_URL) {
  if (!issuedClient(registration.clientId)) fail('The issued ChatGPT client ID is invalid.');
  const file = fileURLToPath(metadataUrl), folder = dirname(file), temp = `${file}.${randomUUID()}.tmp`;
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const value = { version: 1, apiOrigin: config.apiUrl, hostId, clientId: registration.clientId, issuer: OPENAI_ISSUER,
    ...(registration.subject ? { subject: registration.subject } : { pending: true }),
    ...(typeof registration.email === 'string' ? { email: registration.email } : {}), savedAt: new Date().toISOString() };
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temp, file); await chmod(file, 0o600);
  } finally { await rm(temp, { force: true }); }
}

export function createAttempt({ hostId, clientId = DYNAMIC_CLIENT, subject } = {}) {
  if (!opaque(hostId)) fail('Timber did not return a valid persistent host ID.');
  if (clientId !== DYNAMIC_CLIENT && !issuedClient(clientId)) fail('The saved ChatGPT client ID is invalid.');
  const verifier = randomBytes(48).toString('base64url');
  return { hostId, clientId, subject, verifier, challenge: createHash('sha256').update(verifier).digest('base64url'),
    state: randomBytes(32).toString('base64url'), nonce: randomBytes(32).toString('base64url') };
}

export function authorizationUrl(attempt, redirectUri) {
  const callback = new URL(redirectUri);
  if (callback.protocol !== 'http:' || callback.hostname !== '127.0.0.1' || callback.pathname !== '/auth/callback' || callback.search || callback.hash || !callback.port) fail('Invalid loopback callback URI.');
  const url = new URL(AUTHORIZATION_ENDPOINT);
  const params = { client_id: attempt.clientId, ext_agent_host_id: attempt.hostId, response_type: 'code', redirect_uri: redirectUri,
    scope: SCOPES, resource: RESOURCE, state: attempt.state, nonce: attempt.nonce, code_challenge_method: 'S256', code_challenge: attempt.challenge };
  if (attempt.clientId === DYNAMIC_CLIENT) params.agent_name_hint = 'Timber';
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  return url.href;
}

export function parseCallback(searchParams, attempt) {
  for (const name of ['state', 'code', 'client_id', 'error']) if (searchParams.getAll(name).length > 1) fail('Ambiguous authorization callback. Start sign-in again.');
  if (!equals(searchParams.get('state'), attempt.state)) fail('Authorization state did not match. Start sign-in again.');
  if (searchParams.has('error')) {
    if (searchParams.get('error') === 'access_denied') fail('Authorization was declined. No connection was changed.');
    fail('OpenAI could not authorize this request. Start sign-in again.');
  }
  const code = searchParams.get('code');
  if (!opaque(code, 8192)) fail('The authorization callback did not include a valid code.');
  const returned = searchParams.get('client_id');
  if (attempt.clientId === DYNAMIC_CLIENT) {
    if (!issuedClient(returned)) fail('Registration did not return an issued client ID. Start sign-in again.');
    return { code, clientId: returned };
  }
  if (returned && returned !== attempt.clientId) fail('The callback changed the saved client ID. The connection was not replaced.');
  return { code, clientId: attempt.clientId };
}

export async function startCallbackListener(attempt, { timeoutMs = 10 * 60 * 1000 } = {}) {
  let settled = false, timer, origin;
  let resolveResult, rejectResult;
  const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  result.catch(() => {}); // The browser launcher may still be returning when the callback arrives.
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    response.setHeader('Content-Type', 'text/plain; charset=utf-8'); response.setHeader('Connection', 'close');
    let url;
    try { url = new URL(request.url, origin); } catch { response.writeHead(400).end('Invalid request.'); return; }
    if (request.method !== 'GET' || url.pathname !== '/auth/callback') { response.writeHead(404).end('Not found.'); return; }
    if (settled) { response.writeHead(409).end('This sign-in attempt has already finished.'); return; }
    settled = true; clearTimeout(timer);
    try {
      if (url.origin !== origin || request.headers.host !== new URL(origin).host) fail('Invalid callback host. Start sign-in again.');
      const callback = parseCallback(url.searchParams, attempt);
      response.writeHead(200).end('Authorization received. Return to the terminal to finish connecting Timber.');
      resolveResult(callback);
    } catch (error) {
      response.writeHead(400).end('Authorization could not be accepted. Return to the terminal and start sign-in again.');
      rejectResult(error instanceof LoginError ? error : new LoginError('Invalid authorization callback.'));
    } finally { server.close(); }
  });
  await new Promise((resolve, reject) => {
    server.once('error', () => reject(new LoginError('Could not start the local sign-in listener.')));
    server.listen(0, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  const stop = () => {
    clearTimeout(timer);
    if (!settled) { settled = true; rejectResult(new LoginError('Sign-in was cancelled.')); }
    server.close(); server.closeAllConnections();
  };
  timer = setTimeout(() => {
    if (!settled) { settled = true; rejectResult(new LoginError('Sign-in timed out after ten minutes. Run npm run chatgpt:login again.')); }
    server.close(); server.closeAllConnections();
  }, timeoutMs);
  return { redirectUri: `${origin}/auth/callback`, result, stop };
}

export async function discoverOpenAI(fetchImpl = fetch) {
  let discovery;
  try {
    const response = await fetchImpl(`${OPENAI_ISSUER}/.well-known/openid-configuration`, { redirect: 'error', signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(); discovery = await response.json();
  } catch { fail('Could not load OpenAI sign-in configuration. Try again when OpenAI is reachable.'); }
  let jwks;
  try { jwks = new URL(discovery.jwks_uri); } catch { fail('OpenAI returned invalid signing-key metadata.'); }
  if (discovery.issuer !== OPENAI_ISSUER || jwks.protocol !== 'https:' || jwks.hostname !== 'auth.openai.com' || jwks.username || jwks.password || jwks.hash) fail('OpenAI sign-in metadata did not match its trusted issuer.');
  const supported = Array.isArray(discovery.id_token_signing_alg_values_supported) ? discovery.id_token_signing_alg_values_supported : SAFE_ALGORITHMS;
  const algorithms = SAFE_ALGORITHMS.filter((name) => supported.includes(name));
  if (!algorithms.length) fail('OpenAI did not advertise a supported secure ID-token algorithm.');
  return { issuer: OPENAI_ISSUER, jwksUri: jwks.href, algorithms };
}

export async function exchangeCode({ code, clientId }, attempt, redirectUri, fetchImpl = fetch) {
  if (!issuedClient(clientId)) fail('Token exchange requires an issued client ID.');
  let response, tokens;
  try {
    response = await fetchImpl(TOKEN_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: attempt.verifier, redirect_uri: redirectUri, resource: RESOURCE }),
      redirect: 'error', signal: AbortSignal.timeout(30000) });
    tokens = await response.json();
  } catch { fail('The code exchange could not be completed. Start a fresh sign-in; the authorization code was not saved.'); }
  if (!response.ok) {
    if (tokens?.error === 'invalid_grant') fail('The authorization code expired or was already used. Run npm run chatgpt:login again; the issued client registration is retained.');
    fail('OpenAI rejected the code exchange. Start a fresh sign-in.');
  }
  if (!opaque(tokens.id_token, 65536) || !opaque(tokens.access_token, 65536)) fail('OpenAI returned an incomplete token response.');
  return tokens;
}

export async function validateIdentity(tokens, clientId, attempt, discovery, { jwks } = {}) {
  const { createRemoteJWKSet, jwtVerify } = await import('jose');
  let payload;
  try {
    const key = jwks || createRemoteJWKSet(new URL(discovery.jwksUri), { timeoutDuration: 15000 });
    ({ payload } = await jwtVerify(tokens.id_token, key, { issuer: discovery.issuer, audience: clientId, algorithms: discovery.algorithms,
      requiredClaims: ['sub', 'exp', 'iat', 'nonce'], clockTolerance: 30 }));
  } catch { fail('The ChatGPT identity token could not be verified. The connection was not changed.'); }
  if (!Number.isFinite(payload.iat) || payload.iat > Date.now() / 1000 + 30) fail('The ChatGPT identity has an invalid issue time.');
  if (!opaque(payload.sub) || !equals(payload.nonce, attempt.nonce)) fail('The ChatGPT identity did not match this sign-in attempt.');
  if (payload.azp !== undefined && payload.azp !== clientId) fail('The ChatGPT identity was issued for a different client.');
  if (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== clientId) fail('The ChatGPT identity has no matching authorized client.');
  if (attempt.subject && payload.sub !== attempt.subject) fail('A different ChatGPT account was selected. Existing credentials were not replaced.');
  return { clientId, subject: payload.sub, ...(typeof payload.email === 'string' ? { email: payload.email } : {}) };
}

export function prepareImport(tokens, clientId, attempt) {
  const granted = new Set(typeof tokens.scope === 'string' ? tokens.scope.split(/\s+/) : []);
  if (!['chatgpt.tokens.use.direct', 'resource.invoke', 'offline_access'].every((scope) => granted.has(scope))) fail('Your identity was verified, but ChatGPT plan use was not granted. The registration is retained. Run npm run chatgpt:login again and enable plan use.');
  if (!opaque(tokens.refresh_token, 65536) || String(tokens.token_type).toLowerCase() !== 'bearer' || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0) fail('OpenAI did not return a complete renewable session. Sign in again.');
  return { client_id: clientId, access_token: tokens.access_token, refresh_token: tokens.refresh_token, id_token: tokens.id_token, scope: tokens.scope,
    expires_in: tokens.expires_in, saved_at: new Date().toISOString(), ext_agent_host_id: attempt.hostId, nonce: attempt.nonce,
    ...((typeof tokens.earliest_refresh_at === 'string' || typeof tokens.earliest_refresh_at === 'number') ? { earliest_refresh_at: tokens.earliest_refresh_at } : {}) };
}

async function openBrowser(url) {
  if (process.platform !== 'darwin') return false;
  return new Promise((resolve) => {
    const child = spawn('open', [url], { stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill(); resolve(false); }, 5000);
    child.once('error', () => { clearTimeout(timer); resolve(false); }); child.once('exit', (code) => { clearTimeout(timer); resolve(code === 0); });
  });
}

export async function runLogin({ noOpen = false } = {}) {
  const config = await loadConnectionConfig();
  const status = await cloudRequest(config);
  if (!opaque(status.hostId)) fail('Timber has no persistent ChatGPT host ID. Deploy the current backend first.');
  const saved = await readRegistration(config, status.hostId);
  const selected = status.account?.clientId ? status.account : saved;
  const attempt = createAttempt({ hostId: status.hostId, clientId: selected?.clientId, subject: selected?.subject });
  const discovery = await discoverOpenAI();
  const listener = await startCallbackListener(attempt);
  let cancelled = false;
  const cancel = () => { cancelled = true; listener.stop(); };
  const checkCancelled = () => { if (cancelled) fail('Sign-in was cancelled.'); };
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  let tokens;
  try {
    console.log(`Continue with ChatGPT for Timber at ${config.apiUrl}. Complete sign-in in a browser on this computer.`);
    const url = authorizationUrl(attempt, listener.redirectUri);
    if (noOpen || !await openBrowser(url)) console.log(`Open this authorization URL in your local browser:\n${url}`);
    else console.log('Your browser is open. Waiting for authorization, up to ten minutes.');
    const callback = await listener.result; checkCancelled();
    // Persist only the public client registration so invalid_grant does not create a new client next time.
    await saveRegistration(config, status.hostId, { clientId: callback.clientId, ...(attempt.subject ? { subject: attempt.subject } : {}) });
    tokens = await exchangeCode(callback, attempt, listener.redirectUri);
    const identity = await validateIdentity(tokens, callback.clientId, attempt, discovery);
    await saveRegistration(config, status.hostId, identity);
    checkCancelled();
    const payload = prepareImport(tokens, callback.clientId, attempt);
    let imported;
    try { imported = await cloudRequest(config, { method: 'POST', body: payload }); }
    catch (error) { throw new LoginError(`${error.message} Credentials were not saved locally. Run npm run chatgpt:status to check whether the cloud import completed.`); }
    if (!imported.connected) fail('Timber did not confirm the imported connection. Check npm run chatgpt:status before signing in again.');
    console.log('ChatGPT connected. The cloud backend now owns token refresh; no tokens were saved on this computer.');
    checkCancelled();
    console.log(`Verifying access with one small ${MODEL} request…`);
    const verified = await cloudRequest(config, { method: 'POST', suffix: '/verify', body: {} });
    if (verified.ok !== true || verified.model !== MODEL) fail(`ChatGPT is connected, but access to ${MODEL} was not confirmed.`);
    console.log(`Verified: ${MODEL} completed a real request using the connected ChatGPT plan.`);
  } finally {
    listener.stop(); process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
    if (tokens) for (const key of Object.keys(tokens)) delete tokens[key];
  }
}

async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has('--help')) {
    console.log('Run locally on the computer with your browser:\n  npm run access:setup\n  npm run chatgpt:login [-- --no-open]\n\nUses official ChatGPT authorization with a temporary 127.0.0.1 callback. Transfers credentials securely to your configured Timber backend, which owns refresh. Saves only registration metadata locally. Performs one small gpt-6.1-sol verification request after connecting.');
    return;
  }
  for (const arg of args) if (arg !== '--no-open') fail('Unknown option. Use npm run chatgpt:login -- --help.');
  await runLogin({ noOpen: args.has('--no-open') });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error instanceof LoginError ? error.message : 'ChatGPT sign-in failed. Check local file permissions and connectivity, then try again.'); process.exitCode = 1; });
}
