import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {chromium} from 'playwright';
import {createConsoleFixture, TEST_TOKEN} from './console-fixture.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../apps/console');
const publicDir = resolve(root, 'public');
const workerSource = await readFile(resolve(publicDir, 'sw.js'), 'utf8');

function serviceWorker(fetchImpl) {
  const listeners = new Map();
  const self = {
    location: {origin: 'https://timber.example'},
    clients: {claim: async () => {}},
    skipWaiting: async () => {},
    addEventListener: (name, listener) => listeners.set(name, listener),
  };
  vm.runInNewContext(workerSource, {self, fetch: fetchImpl, URL, Response, Request, Promise});
  return {
    listeners,
    async fetch(request) {
      let responsePromise;
      const event = {request, respondWith: promise => {responsePromise = Promise.resolve(promise);}};
      listeners.get('fetch')(event);
      return responsePromise;
    },
  };
}

const req = (url, {method = 'GET', mode = 'navigate'} = {}) => ({url, method, mode});

test('service worker lifecycle skips waiting and claims existing clients', async () => {
  let skipped = 0, claimed = 0;
  const listeners = new Map();
  const self = {location:{origin:'https://timber.example'},clients:{claim:async()=>claimed++},skipWaiting:async()=>skipped++,addEventListener:(n,fn)=>listeners.set(n,fn)};
  vm.runInNewContext(workerSource, {self, fetch:globalThis.fetch, URL, Response, Request, Promise});
  await listeners.get('install')({waitUntil:p=>p});
  await listeners.get('activate')({waitUntil:p=>p});
  assert.equal(skipped, 1);
  assert.equal(claimed, 1);
});

test('only same-origin GET navigations within /console/ are handled', async () => {
  const calls = [];
  const sw = serviceWorker(async (request, init) => {calls.push({request, init}); return new Response('online');});
  for (const request of [
    req('https://timber.example/v1/bots', {mode:'same-origin'}),
    req('https://timber.example/console/assets/app.js', {mode:'same-origin'}),
    req('https://timber.example/console/manifest.webmanifest', {mode:'same-origin'}),
    req('https://elsewhere.example/console/', {mode:'same-origin'}),
    req('https://timber.example/console/', {method:'POST'}),
    req('https://timber.example/consoleish/', {mode:'same-origin'}),
  ]) {
    let intercepted = false;
    sw.listeners.get('fetch')({request, respondWith:()=>{intercepted=true;}});
    assert.equal(intercepted, false, `${request.method} ${request.url} must bypass the worker`);
  }
  const handled = await sw.fetch(req('https://timber.example/console/bots/ada?view=chat'));
  assert.equal(await handled.text(), 'online');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].request.url, 'https://timber.example/console/bots/ada?view=chat');
  assert.equal(calls[0].init?.cache, 'no-store');
});

test('network navigations return the original response, including HTTP errors', async () => {
  for (const status of [200, 404, 503]) {
    const response = new Response(`status-${status}`, {status});
    const sw = serviceWorker(async () => response);
    const result = await sw.fetch(req('https://timber.example/console/'));
    assert.equal(result, response, 'response identity is preserved; HTTP errors are not treated as offline');
    assert.equal(await result.text(), `status-${status}`);
  }
});

test('offline navigation returns minimal no-data HTML and never caches', async () => {
  const sw = serviceWorker(async () => {throw new TypeError('offline');});
  const response = await sw.fetch(req('https://timber.example/console/bots/ada?view=chat'));
  assert.equal(response.status, 503);
  assert.match(response.headers.get('content-type'), /text\/html/);
  const html = await response.text();
  assert.match(html, /offline/i);
  assert.doesNotMatch(html, /Ada|Linus|Organize the research|persistent conversations|<script|<img/i);
  assert.doesNotMatch(workerSource, /caches\.|CacheStorage|localStorage|sessionStorage|indexedDB/i);
});

function pngSize(buffer) {
  assert.deepEqual([...buffer.subarray(0, 8)], [137,80,78,71,13,10,26,10], 'icon is PNG');
  return [buffer.readUInt32BE(16), buffer.readUInt32BE(20)];
}

test('manifest is installable, scoped to /console/, and declares sized PNG icons', async () => {
  const manifest = JSON.parse(await readFile(resolve(publicDir, 'manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.name, 'Timber');
  assert.equal(manifest.id, '/console/');
  assert.equal(manifest.start_url, '/console/');
  assert.equal(manifest.scope, '/console/');
  assert.equal(manifest.display, 'standalone');
  for (const [size, purpose] of [[192,'any'], [512,'any'], [512,'maskable']]) {
    const icon = manifest.icons.find(entry => entry.sizes === `${size}x${size}` && entry.purpose === purpose && entry.type === 'image/png');
    assert.ok(icon, `manifest includes a ${size}px ${purpose} PNG`);
    const file = icon.src.replace(/^\/console\//, '').replace(/^\//, '');
    const bytes = await readFile(resolve(publicDir, file));
    assert.deepEqual(pngSize(bytes), [size,size], `${icon.src} pixel dimensions`);
  }
});

test('console shell declares the worker, install metadata and Apple touch icon', async () => {
  const html = await readFile(resolve(root, 'index.html'), 'utf8');
  assert.match(html, /rel=["']manifest["'][^>]*href=["']\/console\/manifest\.webmanifest["']|href=["']\/console\/manifest\.webmanifest["'][^>]*rel=["']manifest["']/i);
  assert.match(html, /apple-mobile-web-app-capable/i);
  assert.match(html, /apple-mobile-web-app-title/i);
  assert.match(html, /apple-mobile-web-app-status-bar-style[^>]+black-translucent/i);
  assert.match(html, /apple-touch-icon[^>]+href=["']\/console\/icons\/apple-touch-icon\.png["']/i);
  const appleIcon = await readFile(resolve(publicDir, 'icons/apple-touch-icon.png'));
  assert.deepEqual(pngSize(appleIcon), [180,180]);
});

test('browser registers worker, installs help, preserves login session/hash and falls back offline without caching', async () => {
  const fixture = await createConsoleFixture();
  const browser = await chromium.launch({headless:true,
    ...(process.env.CONSOLE_CHROMIUM_PATH ? {executablePath:process.env.CONSOLE_CHROMIUM_PATH} : {}),
    ...(process.env.CONSOLE_CHROMIUM_ARGS ? {args:JSON.parse(process.env.CONSOLE_CHROMIUM_ARGS)} : {}),
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  const hash = '#bot=10000000-0000-4000-8000-000000000001';
  try {
    await page.goto(`${fixture.url}${hash}`);
    assert.equal(await page.locator('#pwa-install-help').isVisible(), true);
    await page.locator('#token').fill(TEST_TOKEN);
    await page.locator('#connect-form button').click();
    await page.locator('#app').waitFor({state:'visible'});
    assert.equal(new URL(page.url()).hash, hash, 'login does not remove or replace the bot hash');
    const registration = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.ready;
      return {scope:reg.scope, updateViaCache:reg.updateViaCache, script:reg.active?.scriptURL};
    });
    assert.equal(registration.scope, new URL('/console/', fixture.url).href);
    assert.equal(registration.updateViaCache, 'none');
    assert.equal(registration.script, new URL('/console/sw.js', fixture.url).href);
    assert.equal(await page.evaluate(()=>Boolean(navigator.serviceWorker.controller)), true, 'worker claims the console tab');
    assert.deepEqual(await page.evaluate(()=>caches.keys()), [], 'service worker creates no Cache API entries');
    await page.locator('#settings-button').click();
    assert.equal(await page.locator('[aria-label="Install Timber"]').isVisible(), true);

    await context.setOffline(true);
    const offlineResponse = await page.reload();
    assert.equal(offlineResponse?.status(), 503, 'network failure serves the explicit offline fallback');
    assert.match(await page.locator('body').innerText(), /You’re offline/);
    assert.deepEqual(await page.evaluate(()=>caches.keys()), [], 'offline visit does not persist the shell or response');
    assert.equal(new URL(page.url()).hash, hash, 'offline navigation retains the requested hash');

    await context.setOffline(false);
    await page.reload();
    await page.locator('#app').waitFor({state:'visible'});
    assert.equal(new URL(page.url()).hash, hash);
    assert.equal(fixture.state.sessionCalls.filter(call=>call.method==='POST').length, 1, 'reload restores the persistent session instead of prompting to log in');
  } finally {
    await context.close(); await browser.close(); await fixture.close();
  }
});
