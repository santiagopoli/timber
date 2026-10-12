/* Timber is cloud-first. Never persist authenticated responses or app assets.
 * Network-only navigation avoids mixing a cached shell with a newer deployment.
 * API, SSE, WebSocket, uploads and all non-navigation requests bypass this worker.
 */
self.addEventListener('install', event => {
  event.waitUntil(self.skipWaiting());
});
self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || request.mode !== 'navigate' ||
      url.origin !== self.location.origin || !url.pathname.startsWith('/console/')) return;

  event.respondWith(fetch(request, { cache: 'no-store' }).catch(() => new Response(
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">' +
    '<title>Timber — Offline</title></head><body><main><h1>You’re offline</h1>' +
    '<p>Timber needs an internet connection. Your conversations and credentials are not stored for offline use.</p>' +
    '<p>Reconnect, then <a href="/console/">try again</a>.</p></main></body></html>',
    { status: 503, headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    } },
  )));
});
