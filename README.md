# Timber

Cloud-first backend for named, persistent bots. Each bot owns one conversation,
its instructions, history and a reusable computer. The product client will be a
native iOS app; this milestone focuses on the backend and an authenticated test
console.

## Monorepo

| Path | Responsibility |
| --- | --- |
| `apps/api` | Cloudflare Worker API, bot registry and durable conversations |
| `apps/console` | Browser-based developer test console |
| `packages/contracts` | Transport and provider contracts |
| `packages/runtime` | Replaceable Pi agent runtime, ChatGPT and Workers AI transports |
| `packages/computer` | Cloudflare computer provider and operation lifecycle |
| `infra/computer` | Linux desktop image, terminal, files and computer use |
| `tests` | Worker integration and security regression tests |
| `scripts` | Cloud setup and end-to-end smoke testing |

The first implementation is cloud-only. `AgentRuntime` and `ComputerProvider`
keep engine choice separate from computer placement. Future local computers and
other engines can implement these boundaries without changing bot identity.

## Implemented

- Create and rename bots; edit instructions; persistent conversation per bot.
- Durable asynchronous runs with streamed events, reconnect cursors and cancellation.
- Replaceable agent engine, initially the durable Pi harness with `gpt-6.1-sol`
  through Sign in with ChatGPT plan sharing.
- Host-owned OAuth connection, encrypted credentials, serialized token renewal,
  explicit verification and disconnection. No automatic paid-model fallback.
- One lazy cloud computer per bot, reused across tool calls: terminal, files,
  Chromium, screenshots, mouse, keyboard and scrolling.
- Persisted approvals for model-initiated effects, bounded loops and operation IDs
  that prevent a repeated request from executing a completed action twice.
- Workspace checkpoints in R2, restore on cold start, explicit suspend and idle stop.
- Protected API, developer console and CLI smoke tests.

This is a single-owner development MVP. There is no multi-user login, native iOS
client, inter-bot delegation, routine scheduling, Hermes adapter, local execution
or live desktop video yet. The browser console is a test client, not the intended
product interface. Packages and environment variables retain the internal
`@botspace/*` and `BOTSPACE_*` names.

## Run the tests

Requires Node.js 24+ and Python 3.11+. No Cloudflare credentials or Docker are
needed for these tests.

```sh
npm ci
npm run check
```

This checks TypeScript, the API in real local workerd/SQLite, the actual Pi harness
with a deterministic inference transport, OAuth with signed test identities and
real loopback callbacks, and the Python server with real shell processes and
files. External model inference and cloud containers are separate
smoke checks. GitHub Actions also builds the desktop Docker image and exercises
real Chromium/X11, keyboard input, screenshots and checkpoints.

## Deploy to Cloudflare

Full computer use requires a Cloudflare account with **Workers Paid and Containers
enabled**, plus R2. The default model is `gpt-6.1-sol`, using the owner's authorized
ChatGPT plan allowance. ChatGPT plan sharing must be available to that account and
deployment; the real verification request checks this. No OpenAI API key or Kimi
payment is needed for this route. Cloudflare compute and storage are separate costs.

```sh
npm ci
npx wrangler login
npx wrangler r2 bucket create timber-files
npm run deploy
```

On first installation, create the server's credential encryption secret:

```sh
openssl rand -hex 32 | npx wrangler secret put CHATGPT_CREDENTIAL_KEY --config apps/api/wrangler.jsonc
```

Store that key in your secret manager if you need to recover or migrate this
deployment. Do not replace an existing key: stored credentials would become
unreadable. The current Timber deployment already has this secret configured.

Skip bucket creation if it already exists. `npm run deploy` builds the desktop
image and therefore requires a working Docker daemon. For an initial deployment
without local Docker, use `npm run deploy:bootstrap` instead. The bootstrap image
installs desktop dependencies when a fresh computer starts; it is slower and is
not the proposed fast cold-start production configuration.

After deployment, configure the client token using the exact URL Wrangler returns:

```sh
npm run access:setup -- --url https://timber-api.YOUR-SUBDOMAIN.workers.dev
npm run chatgpt:login
npm run smoke
npm run smoke -- --computer
```

`access:setup` sets a generated Worker secret and saves the client configuration
privately in gitignored `.local/client.json`. It replaces the existing access
token. The commands never print it. On macOS, `npm run access:copy` copies the token
for the console's password field. Other clients can supply `API_URL` and
`BOTSPACE_API_TOKEN` as environment variables. Never use an account API key as the
client token or put credentials in URLs, repository files or model prompts.

## Connect your ChatGPT subscription

Run this on your own computer, where the browser can reach the local callback:

```sh
npm run chatgpt:login
npm run chatgpt:status -- --verify
```

The login opens OpenAI's consent screen and requests permission to use your plan.
It uses PKCE, a one-time state and nonce, and verifies the signed OpenAI identity.
After consent, the CLI transfers the session directly to your authenticated
Timber backend and tests a real `gpt-6.1-sol` response. A successful OAuth login
alone does not mark model access as verified. No password or token is pasted into
chat. The CLI retains only registration metadata, not OAuth tokens.

One dedicated Durable Object owns the encrypted credentials for this deployment
and serializes refresh-token rotation across bots. Credentials are never stored
in bot histories, computer workspaces, R2 checkpoints or browser storage. The
console shows the account and verification status, and can disconnect it. If
remote revocation cannot be confirmed, local credentials are still removed and
the console tells you to revoke access in ChatGPT settings.

The subscription allowance is shared and limited. Exhaustion, unsupported access
or a revoked session stops the run with an explicit error; Timber does not switch
to API billing or another model. Existing bots retain their model selection;
new bots default to `gpt-6.1-sol`. Explicit `@cf/...` model IDs remain available
through the API and smoke command for deliberate Workers AI usage.

This is a personal, self-hosted integration using the documented
[Sign in with ChatGPT flow](https://developers.openai.com/siwc/token-sharing-open-source).
It is not an unrestricted API credit included with Pro; account eligibility,
available models and deployment policy are checked by OpenAI.

Open the deployed `/console/`, enter the client token and connect. Create a named
bot, send a message, review approvals, inspect its workspace and take a screenshot.
The token stays in page memory. The smoke command creates a uniquely named bot
and leaves it for inspection. `--computer` additionally verifies a write/read,
shell deduplication, screenshot artifact, checkpoint, suspend and restored file.
For the slower bootstrap mode, set `SMOKE_TIMEOUT_MS=600000`.

For a text-only cloud check with the model verified on the initial Free account:

```sh
SMOKE_MODEL=@cf/meta/llama-3.3-70b-instruct-fp8-fast npm run smoke
```

This explicitly selects Workers AI for the new smoke bot and uses Cloudflare's
inference allowance/billing. It does not use your ChatGPT subscription or change
the default. There is no automatic fallback to this route.

`npm run dev` runs the Worker locally. Real computer tools still need a supported
container environment; this command is not an implementation of the future local
computer provider. The automated tests are the credential-free local test path.

## Request and storage flow

The Worker authenticates requests and routes each bot to its Durable Object. The
durable Pi runtime calls the model through the credential-owning ChatGPTAuthDO;
answering a text question does not start a Linux container. A computer tool wakes
the bot's ComputerDO, which restores its
workspace if needed and reuses that computer for subsequent calls. No container
is created per tool call. Client disconnection does not cancel a durable run.

The BotDO keeps messages, runs, approvals and replayable events in SQLite. R2
stores private artifacts and immutable workspace archives. A computer stops after
five idle minutes only after a successful checkpoint; active runs renew its lease.
Container root filesystems are ephemeral. Checkpoints preserve `/workspace` and
the Chromium profile, not process RAM or running tasks. Dependency caches are
excluded. An abrupt failure can lose changes since the last successful checkpoint;
an interrupted effect is reported instead of automatically repeated.

`AgentRuntime` and `ComputerProvider` are independent interfaces. A future local
or sandboxed provider can restore the portable workspace under the same bot ID.
Moving a task between providers will require an explicit checkpoint and ownership
handoff; live VM migration is not implemented. See [computer details](infra/computer/README.md)
for archive limits and [API contracts](docs/contracts.md) for endpoints.

## Initial deployment status

The initial Worker and R2 bucket were deployed. The developer console is at
https://timber-api.santiagopoli.workers.dev/console/ and requires the client token.
The real cloud smoke passed using the explicit Llama model above: authentication,
named bot persistence, deduplication, replayable SSE, actual inference and persisted
assistant response. The new default uses ChatGPT authorization; real
`gpt-6.1-sol` inference remains unverified until the owner completes
`npm run chatgpt:login` and its verification succeeds. Automated OAuth and Pi
integration tests use signed fixtures and simulated model responses.

The desktop Docker smoke passed in GitHub Actions: Chromium, verified Unicode
input, PNG screenshot, shell deduplication, checkpoint checksum and file restore.
With Containers enabled, a separate authenticated Cloudflare smoke on 2026-10-05
passed real file write/read, terminal execution, operation deduplication, PNG
capture stored in R2, checkpoint, suspend, and file recovery in a fresh container.
It uses the same ComputerDO and bootstrap server as production. This caught and
fixed Python's startup failure on Cloudflare's 64-character container hostname.
Fresh provisioning plus workspace restore took 132 seconds in that single run;
bootstrap remains a temporary deployment mode, not a fast cold-start target.
The fix is deployed to `timber-api`; rerun `SMOKE_TIMEOUT_MS=600000 npm run smoke
-- --computer` with the owner's local credentials to verify the full production
API and model flow. The isolated computer test does not validate ChatGPT OAuth.

No credentials belong in this repository.
