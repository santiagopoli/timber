import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { authorizationUrl, cloudRequest, createAttempt, discoverOpenAI, exchangeCode, OPENAI_ISSUER, parseCallback, prepareImport, readRegistration, RESOURCE, saveRegistration, SCOPES, startCallbackListener, validateIdentity } from '../chatgpt-login.mjs';

const hostId = 'urn:uuid:11111111-1111-4111-8111-111111111111';
const clientId = 'oaiapp_test_client';
const callback = (attempt, additions = {}) => new URLSearchParams({ state: attempt.state, code: 'test-code', client_id: clientId, ...additions });

test('authorization binds fresh PKCE, state, nonce and persistent cloud host; returning client omits registration hint', () => {
  const attempt = createAttempt({ hostId }), other = createAttempt({ hostId });
  assert.notEqual(attempt.state, other.state); assert.notEqual(attempt.nonce, other.nonce); assert.notEqual(attempt.verifier, other.verifier);
  assert.match(attempt.verifier, /^[A-Za-z0-9_-]{43,128}$/);
  const url = new URL(authorizationUrl(attempt, 'http://127.0.0.1:5555/auth/callback'));
  assert.equal(url.origin, OPENAI_ISSUER); assert.equal(url.searchParams.get('ext_agent_host_id'), hostId);
  assert.equal(url.searchParams.get('resource'), RESOURCE); assert.equal(url.searchParams.get('scope'), SCOPES);
  assert.equal(url.searchParams.get('agent_name_hint'), 'Timber'); assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(!url.searchParams.has('code_verifier')); assert.ok(!url.searchParams.has('id_token_hint'));
  const returning = new URL(authorizationUrl(createAttempt({ hostId, clientId }), 'http://127.0.0.1:5566/auth/callback'));
  assert.equal(returning.searchParams.get('client_id'), clientId); assert.ok(!returning.searchParams.has('agent_name_hint'));
  assert.throws(() => authorizationUrl(attempt, 'http://localhost:5555/auth/callback'), /callback/);
  assert.throws(() => authorizationUrl(attempt, 'http://127.0.0.1:5555/callback'), /callback/);
});

test('callback rejects CSRF, duplicate fields, OAuth denial and client replacement', () => {
  const attempt = createAttempt({ hostId });
  assert.deepEqual(parseCallback(callback(attempt), attempt), { code: 'test-code', clientId });
  assert.throws(() => parseCallback(callback(attempt, { state: 'wrong' }), attempt), /state/);
  const duplicate = callback(attempt); duplicate.append('state', attempt.state);
  assert.throws(() => parseCallback(duplicate, attempt), /Ambiguous/);
  assert.throws(() => parseCallback(callback(attempt, { error: 'access_denied' }), attempt), /declined/);
  assert.throws(() => parseCallback(callback(attempt, { client_id: 'dynamic_agent_client' }), attempt), /issued/);
  const existing = createAttempt({ hostId, clientId });
  assert.throws(() => parseCallback(callback(existing, { client_id: 'oaiapp_different' }), existing), /changed/);
  const noClient = callback(existing); noClient.delete('client_id');
  assert.equal(parseCallback(noClient, existing).clientId, clientId);
});

test('loopback callback accepts one attempt and binds exact callback path', async () => {
  const attempt = createAttempt({ hostId });
  const listener = await startCallbackListener(attempt, { timeoutMs: 2000 });
  try {
    const uri = new URL(listener.redirectUri); assert.equal(uri.hostname, '127.0.0.1'); assert.equal(uri.pathname, '/auth/callback');
    const irrelevant = await fetch(new URL('/favicon.ico', uri)); assert.equal(irrelevant.status, 404);
    uri.search = callback(attempt).toString();
    const response = await fetch(uri); assert.equal(response.status, 200); assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.ok(!(await response.text()).includes('test-code'));
    assert.deepEqual(await listener.result, { code: 'test-code', clientId });
    await assert.rejects(fetch(uri));
  } finally { listener.stop(); }
});

test('invalid callback state terminates attempt without a code; timeout terminates listener', async () => {
  const attempt = createAttempt({ hostId });
  const listener = await startCallbackListener(attempt, { timeoutMs: 2000 });
  try {
    const response = await fetch(`${listener.redirectUri}?${callback(attempt, { state: 'wrong' })}`);
    assert.equal(response.status, 400); await assert.rejects(listener.result, /state/);
  } finally { listener.stop(); }
  const expired = await startCallbackListener(createAttempt({ hostId }), { timeoutMs: 25 });
  await assert.rejects(expired.result, /timed out/); expired.stop();
});

test('code exchange uses issued client and exact redirect URI without a client secret', async () => {
  const attempt = createAttempt({ hostId }); const uri = 'http://127.0.0.1:5555/auth/callback';
  let exchanges = 0;
  const fakeFetch = async (url, options) => {
    exchanges++; assert.equal(url, `${OPENAI_ISSUER}/api/accounts/oauth/token`);
    assert.equal(options.body.get('client_id'), clientId); assert.equal(options.body.get('redirect_uri'), uri);
    assert.equal(options.body.get('code_verifier'), attempt.verifier); assert.equal(options.body.get('resource'), RESOURCE);
    assert.ok(!options.body.has('client_secret')); assert.equal(options.redirect, 'error');
    return Response.json({ access_token: 'test-access', id_token: 'test-id' });
  };
  await exchangeCode({ code: 'test-code', clientId }, attempt, uri, fakeFetch); assert.equal(exchanges, 1);
  await assert.rejects(exchangeCode({ code: 'test-code', clientId: 'dynamic_agent_client' }, attempt, uri, fakeFetch), /issued/);
  assert.equal(exchanges, 1);
});

test('signed identity requires trusted signature, issuer, audience, expiry, nonce and saved subject', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey); jwk.kid = 'test-key';
  const jwks = createLocalJWKSet({ keys: [jwk] });
  const attempt = createAttempt({ hostId, clientId, subject: 'test-subject' });
  const discovery = { issuer: OPENAI_ISSUER, algorithms: ['RS256'] };
  const sign = (changes = {}) => new SignJWT({ sub: 'test-subject', email: 'test@example.invalid', nonce: attempt.nonce, iss: OPENAI_ISSUER, aud: clientId,
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300, ...changes }).setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).sign(privateKey);
  assert.equal((await validateIdentity({ id_token: await sign() }, clientId, attempt, discovery, { jwks })).subject, 'test-subject');
  for (const changes of [{ iss: 'https://invalid.example' }, { aud: 'different-client' }, { exp: Math.floor(Date.now() / 1000) - 60 }, { nonce: 'wrong' }, { sub: 'different-subject' }]) {
    await assert.rejects(validateIdentity({ id_token: await sign(changes) }, clientId, attempt, discovery, { jwks }));
  }
  const forged = await sign();
  await assert.rejects(validateIdentity({ id_token: `${forged.slice(0, -8)}AAAAAAAA` }, clientId, attempt, discovery, { jwks }));
});

test('plan permission is mandatory and token import keeps nonce and host binding', () => {
  const attempt = createAttempt({ hostId, clientId });
  const tokens = { access_token: 'test-access', id_token: 'test-id', refresh_token: 'test-refresh', token_type: 'Bearer', scope: SCOPES, expires_in: 3600, earliest_refresh_at: 12345 };
  assert.throws(() => prepareImport({ ...tokens, scope: 'openid profile email' }, clientId, attempt), /plan use was not granted/);
  const imported = prepareImport(tokens, clientId, attempt);
  assert.equal(imported.ext_agent_host_id, hostId); assert.equal(imported.nonce, attempt.nonce); assert.equal(imported.client_id, clientId);
  assert.equal(imported.earliest_refresh_at, 12345); assert.ok(!('code_verifier' in imported));
});

test('local registration is private metadata only and scoped to deployment plus host', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'timber-oauth-test-')); const file = pathToFileURL(join(folder, 'registration.json'));
  const config = { apiUrl: 'https://timber.example' };
  try {
    await saveRegistration(config, hostId, { clientId, subject: 'test-subject', email: 'test@example.invalid', access_token: 'must-not-save', refresh_token: 'must-not-save', id_token: 'must-not-save' }, file);
    const content = await readFile(file, 'utf8'); assert.ok(!content.includes('must-not-save')); assert.ok(!content.includes('token'));
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await readRegistration(config, hostId, file)).subject, 'test-subject');
    assert.equal(await readRegistration(config, 'other-host', file), null);
    assert.equal(await readRegistration({ apiUrl: 'https://other.example' }, hostId, file), null);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('discovery rejects substituted signing-key origin and errors never echo provider payloads', async () => {
  await assert.rejects(discoverOpenAI(async () => Response.json({ issuer: OPENAI_ISSUER, jwks_uri: 'https://attacker.invalid/jwks' })), /trusted issuer/);
  await assert.rejects(cloudRequest({ apiUrl: 'https://timber.example', apiToken: 'test-api' }, { fetchImpl: async () => Response.json({ error: { code: 'unknown', message: 'must-not-display' } }, { status: 403 }) }), (error) => !error.message.includes('must-not-display'));
});
