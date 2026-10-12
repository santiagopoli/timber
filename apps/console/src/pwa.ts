// Installation is progressive enhancement: failures must not affect login/chat.
function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  void navigator.serviceWorker.register('/console/sw.js', {
    scope: '/console/',
    updateViaCache: 'none',
  }).catch(() => { /* Timber remains usable without a service worker. */ });
}

if (document.readyState === 'complete') registerServiceWorker();
else window.addEventListener('load', registerServiceWorker, { once: true });
