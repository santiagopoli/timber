# Workspace apps

A workspace can contain several named apps: Frontend, Admin, API, or another name
the bot chooses from the user's task. The user opens an app from its card in the
bot's Apps section or its registered root link in the conversation. Both actions
request the same one-use grant. Other bots' links and unregistered URLs retain
ordinary browser navigation and cannot mint a grant for the selected bot. Ports
remain an implementation detail for the agent.

`publish_app({name,port})` registers an existing HTTP app and probes readiness. It
does not start a shell process, install dependencies, or change the app's code.
The result contains a stable `url`, `basePath`, and the observed `state`. Publishing
the same name/port again returns the existing app. Distinct apps have independent
identities and browser grants. At most 16 apps are registered per workspace.

The agent should:

1. Register the app to obtain `basePath` even if the app is not running yet.
2. Configure the app for that base path, bind its HTTP server to `0.0.0.0`, and
   start it in the existing workspace computer. Port 8080 is reserved for Timber.
3. Publish the same name/port again to verify the app responds. Readiness is an
   observed HTTP 2xx/3xx response, not an assumption based on process creation.
4. Explain that the app can be opened from the Apps list. A response should never
   instruct the user to open a localhost URL on their own PC.

For Vite, set `base` to the returned base path, bind with `--host 0.0.0.0`, and
configure HMR to use the public HTTPS hostname / WSS port 443 where needed. For
Next.js, configure `basePath` before starting/building. Client routing and API
requests must honor the same base path. A framework that cannot run under a base
path needs a dedicated hostname; this MVP does not rewrite arbitrary HTML/JS.

## HTTP contract

- `GET /v1/bots/:botId/apps` returns `{apps}`. Listing does not start or refresh
  the computer. `state` is the last readiness observation.
- `POST /v1/bots/:botId/apps` accepts `{name,port,operationId}` and returns `{app}`.
  The operation ID is idempotent and conflicts if its arguments change.
- `DELETE /v1/bots/:botId/apps/:appId` revokes browser access and removes the card.
  It does not kill the server process or delete workspace files.
- `POST /v1/bots/:botId/apps/:appId/open` returns `{actionUrl,ticket,expiresAt}`.
  The console submits the ticket using an HTML form POST in a new browser tab.
  The 60-second ticket is one-use, never a URL parameter. A successful exchange
  sets a one-hour Secure, HttpOnly, SameSite cookie scoped to this app path and
  redirects to the clean app URL. Opening from another browser requires another
  owner-authorized grant. A copied URL alone does not grant public access.

The dedicated `timber-preview` Worker has no credentials. It calls a named service
entrypoint on the API Worker, which verifies the bot still exists before dispatch.
The BotDO validates the app/session, then ComputerDO forwards to the registered
container port. No route accepts an arbitrary network destination. Owner tokens,
gateway session cookies, internal headers, and Cloudflare identity headers are
removed before reaching the app. App cookies are constrained to the app's path.
Service worker registrations are blocked. Deletion invalidates browser sessions
and pending tickets for subsequent requests. An already accepted WebSocket stays
open until its server/computer closes it; revocation prevents new handshakes.

HTTP paths, query strings, request bodies, streaming responses and WebSocket
upgrades are forwarded without retrying requests. Preview requests reuse an
already-running computer. They do not boot it or replay its startup command after
sleep; a stopped app asks the user to return to the bot and restart it. Browsing
renews the existing computer's idle timeout. Open WebSockets do not promise an
indefinite computer lifetime.

## Deployment and scope

Deploy the API with the exported `WorkspacePreviewGateway` entrypoint, then run
`npx wrangler deploy --config apps/preview/wrangler.jsonc`. Set `PREVIEW_ORIGIN` to
the exact separate HTTPS preview origin and `GITHUB_PUBLIC_ORIGIN` to the console
origin. The console's form-action CSP must permit the preview origin.
The console uses `Referrer-Policy: strict-origin` in both its HTTP header and HTML
metadata so browser form submissions carry its exact Origin without disclosing a
path or query. `no-referrer` turns that Origin into `null` and breaks the ticket
exchange. Preview responses use `same-origin` to retain their own form provenance
while suppressing external referrers. Missing, null and foreign opening origins
remain rejected.

The preview origin is separate from the admin/API origin. On workers.dev,
multiple apps use separate paths on one preview origin and therefore share the
browser's origin security boundary. This is the private single-owner MVP, not
cross-tenant isolation between untrusted apps. A dedicated preview domain with
per-app hostnames is the next boundary when that isolation is required. Cookie
paths avoid accidental crossover; they are not a cross-app authorization boundary
against malicious same-origin JavaScript.

Local verification lives in `tests/workspace-apps.spec.ts` and the ComputerDO
preview tests. Cloud verification should create two isolated apps, open them via
one-use grants, check independent HTML/assets and an HTTP POST, and verify access
fails after revocation. Do not claim private browser or WebSocket cloud tests
passed until they have actually run.

Verified on 2026-10-07:

- 11 gateway tests and 3 ComputerDO preview tests passed, including ticket
  expiration/replay, bot and app boundaries, reviewed HTTP errors through BotDO,
  credential stripping, and native WebSocket echo/passthrough.
- Two real Node apps, Frontend and Admin, ran together in one Cloudflare computer.
  Both returned the correct HTML, a CSS asset, and a POST body through the separately
  deployed preview Worker. Both completed a real WebSocket echo round trip.
- Unauthenticated app access returned 401; reusing an opening ticket returned
  401. Neither owner Authorization nor gateway cookies reached either app.
  Removing each app made its existing browser grant return 404 on the next request.
- The isolated test bot, its computer and R2 prefix were deleted. The temporary API
  and preview Workers, container application, and temporary owner token were also
  removed. Production bots and credentials were not changed by these checks.

The cloud check used API version `e8a45377-7cd4-4b57-9a1b-22a8666bfe36` in isolated
diagnostic Workers and the existing production desktop image. It exercised actual
Cloudflare HTTP/WebSocket forwarding; it did not claim arbitrary framework base
path configuration or cross-app browser origin isolation.

Primary platform references:
- https://developers.cloudflare.com/sandbox/previews/
- https://developers.cloudflare.com/sandbox/previews/serve-previews-on-their-own-hostnames/
- https://developers.cloudflare.com/containers/examples/websocket/
