import {env, exports} from 'cloudflare:workers';
import {runInDurableObject} from 'cloudflare:test';
import {describe, it, expect, vi} from 'vitest';
import type {Bot} from '@botspace/contracts';
import type {Env} from '../apps/api/src/env';
import worker from '../apps/api/src/index';

const token = 'test-only-botspace-owner-token-000000';
const api = (path: string, init: RequestInit = {}) => exports.default.fetch(`https://botspace.test${path}`, {...init, headers: {authorization: `Bearer ${token}`, ...init.headers}});
async function createBot(): Promise<Bot> {
  const response = await api('/v1/bots', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({name: 'Audio download'})});
  expect(response.status).toBe(201);
  return (await response.json<{bot: Bot}>()).bot;
}
function wav(): Uint8Array {
  const b = new Uint8Array(46), v = new DataView(b.buffer);
  for (const [at, text] of [[0, 'RIFF'], [8, 'WAVE'], [12, 'fmt '], [36, 'data']] as const) b.set(new TextEncoder().encode(text), at);
  v.setUint32(4, 38, true); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true); v.setUint32(28, 16000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); v.setUint32(40, 2, true);
  b[44] = 123; return b;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => {resolve = r;});
  return {promise, resolve};
}

describe('private audio artifact downloads', () => {
  it('requires owner authentication and exact live bot prefix, and preserves defensive byte-response headers', async () => {
    const bot = await createBot(), other = await createBot(), audioId = crypto.randomUUID(), bytes = wav();
    const path = `/v1/bots/${bot.id}/artifacts/${audioId}`;
    const upload = await api(`/v1/bots/${bot.id}/audio/${audioId}`, {method: 'PUT', headers: {'content-type': 'audio/wav'}, body: bytes});
    expect(upload.status).toBe(200); await upload.arrayBuffer();
    expect((await exports.default.fetch(`https://botspace.test${path}`)).status).toBe(401);
    expect((await api(path, {headers: {authorization: 'Bearer invalid'}})).status).toBe(401);
    expect((await api(`/v1/bots/${other.id}/artifacts/${audioId}`)).status).toBe(404);
    expect((await api(`/v1/bots/${crypto.randomUUID()}/artifacts/${audioId}`)).status).toBe(404);
    expect((await api(`/v1/bots/${bot.id}/artifacts/not-a-uuid`)).status).toBe(404);
    const response = await api(path);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('audio/wav');
    expect(response.headers.get('content-disposition')).toBe(`attachment; filename="${audioId}"`);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  it('rechecks the actual live registry after deferred R2 get and cancels audio before exposing any bytes', async () => {
    const bot = await createBot(), audioId = crypto.randomUUID(), bindings = env as unknown as Env;
    const key = `bots/${bot.id}/artifacts/${audioId}`, bytes = wav();
    await bindings.FILES.put(key, bytes, {httpMetadata: {contentType: 'audio/wav'}, customMetadata: {chatAudio: 'true'}});
    const reached = deferred(), release = deferred();
    let stored: R2ObjectBody | null = null;
    let cancel: ReturnType<typeof vi.spyOn> | undefined;
    const files = new Proxy(bindings.FILES, {get(bucket, name) {
      if (name === 'get') return async (requestedKey: string) => {
        expect(requestedKey).toBe(key);
        stored = await bucket.get(requestedKey);
        expect(stored).not.toBeNull();
        cancel = vi.spyOn(stored!.body, 'cancel');
        reached.resolve();
        await release.promise;
        return stored;
      };
      const value = Reflect.get(bucket, name, bucket);
      return typeof value === 'function' ? value.bind(bucket) : value;
    }});
    // Execute the real external gateway handler with real Worker bindings;
    // only R2's asynchronous return is held. Registry lookup is never mocked.
    const pending = worker.fetch(new Request(`https://botspace.test/v1/bots/${bot.id}/artifacts/${audioId}`, {headers: {authorization: `Bearer ${token}`}}), {...bindings, FILES: files});
    await reached.promise;
    try {
      const registry = bindings.WORKSPACE.get(bindings.WORKSPACE.idFromName('owner'));
      await runInDurableObject(registry, (_, state) => {
        state.storage.sql.exec('INSERT INTO bot_deletions(id,next_at) VALUES(?,?)', bot.id, Date.now() + 86_400_000);
        state.storage.sql.exec('DELETE FROM bots WHERE id=?', bot.id);
      });
      const removed = await registry.fetch(`https://workspace/${bot.id}`);
      expect(removed.status).toBe(404); await removed.body?.cancel();
      // Physical cleanup has not run: R2 still contains the original bytes.
      expect(await bindings.FILES.head(key)).not.toBeNull();
    } finally {release.resolve();}
    const response = await pending;
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({error: {code: 'not_found'}});
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(stored!.bodyUsed).toBe(true);
    expect(await bindings.FILES.head(key)).not.toBeNull();
    cancel?.mockRestore();
  });
});
