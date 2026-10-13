# Console PWA

The Timber console is installable as a standalone web app at `/console/`. Its
manifest and all app-shell URLs stay under that path. Safari on iOS can add the
console to the Home Screen using the Apple web-app metadata and touch icon; this
is a browser-installed web app, not a native iOS application.

## Offline behavior and data boundaries

The service worker is deliberately network-only. It handles only same-origin
GET navigations whose path is within `/console/`, and makes those requests with
`cache: "no-store"`. Successful responses and HTTP error responses are returned
as received. If the network request fails, it returns a small informational
HTML fallback. It does not cache pages, assets, API responses, or authenticated
data, and it does not intercept API requests, non-navigation resources, POSTs,
or cross-origin traffic.

Consequently, offline installation provides no offline chat, transcript, login,
or asset availability guarantee. Timber conversations and app functionality
remain network-dependent; the fallback contains no conversation data and cannot
restore a cached app shell.

The client registers `/console/sw.js` with scope `/console/` after page load.
Registration/update failures are non-fatal to normal console operation. The
login and settings surfaces explain browser install options; actual install
prompts remain controlled by the browser and platform.

## Regression verification

Run the complete local PWA suite with:

```sh
npm run test:pwa
```

This builds the console, then runs `scripts/tests/pwa.test.mjs`. The tests
exercise the worker in a Node VM (navigation-only interception and bypasses,
unchanged network responses including HTTP errors, and offline fallback), check
manifest/icon metadata and PNG dimensions, and use Chromium plus the local console
fixture for registration scope, install help, URL-hash handling, session
persistence, and an offline navigation with no Cache API entries. To select a
system Chromium installation, set `CONSOLE_CHROMIUM_PATH` and, when needed,
`CONSOLE_CHROMIUM_ARGS`.

## Manual iOS Safari verification checklist

These device-specific checks remain to be performed on a current iPhone or iPad
with Safari; this checklist is not evidence that they have already passed.

1. Open the deployed `/console/` URL in Safari. Use Share → Add to Home Screen,
   keep “Open as Web App” enabled if offered, and confirm the Timber icon/name.
2. Launch the Home Screen icon. Confirm standalone presentation (no Safari
   browser chrome), safe-area/status-bar appearance, and expected orientation.
3. Sign in once, close the installed app, reopen it, and confirm the session is
   restored without re-entering the token.
4. Open a bot and a task using their normal deep links/hash navigation. Confirm
   the selected view survives sign-in/reload and navigation remains scoped to
   `/console/`.
5. Focus the composer with the keyboard open; check that the composer remains
   reachable, content can scroll, and the bottom safe area is respected.
6. Enable Airplane Mode and reload/navigate to `/console/`. Confirm the
   informational offline notice appears, with no cached conversation or claimed
   offline chat. Disable Airplane Mode and reload to verify the app and session
   recover online.
7. Deploy a new console version while an installed app is open. Verify an
   ordinary later navigation receives the fresh network response without an
   unexpected forced reload or an old cached shell.

There is no real iOS device/Safari available in this environment, so Home Screen
installation, iOS standalone presentation, and the checklist above have not been
physically verified. No cloud deployment or production smoke verification is
implied by the local tests.
