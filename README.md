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
| `packages/runtime` | Replaceable Pi agent runtime, Workers AI integration |
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
- Replaceable agent engine, initially the official durable Pi harness and Workers AI.
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
with a deterministic inference transport, and the Python server with real shell
processes and files. External model inference and cloud containers are separate
smoke checks. GitHub Actions also builds the desktop Docker image and exercises
real Chromium/X11, keyboard input, screenshots and checkpoints.

## Deploy to Cloudflare

Requires a Cloudflare account with **Workers Paid and Containers enabled**, R2,
and access to the selected Workers AI model. The default is
`@cf/moonshotai/kimi-k2.7-code`, with vision and function calling. Model inference,
containers and storage can incur charges.

```sh
npm ci
npx wrangler login
npx wrangler r2 bucket create timber-files
npm run deploy
```

Skip bucket creation if it already exists. `npm run deploy` builds the desktop
image and therefore requires a working Docker daemon. For an initial deployment
without local Docker, use `npm run deploy:bootstrap` instead. The bootstrap image
installs desktop dependencies when a fresh computer starts; it is slower and is
not the proposed fast cold-start production configuration.

After deployment, configure the client token using the exact URL Wrangler returns:

```sh
npm run access:setup -- --url https://timber-api.YOUR-SUBDOMAIN.workers.dev
npm run smoke
npm run smoke -- --computer
```

`access:setup` sets a generated Worker secret and saves the client configuration
privately in gitignored `.local/client.json`. It replaces the existing access
token. The commands never print it. On macOS, `npm run access:copy` copies the token
for the console's password field. Other clients can supply `API_URL` and
`BOTSPACE_API_TOKEN` as environment variables. Never use an account API key as the
client token or put credentials in URLs, repository files or model prompts.

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

This explicitly selects Llama for the new smoke bot. It does not change the
vision-capable default or enable cloud containers.
In the console, enter the same model ID in the optional Model field when creating
a bot to try text conversations before enabling Workers Paid.

`npm run dev` runs the Worker locally. Real computer tools still need a supported
container environment; this command is not an implementation of the future local
computer provider. The automated tests are the credential-free local test path.

## Request and storage flow

The Worker authenticates requests and routes each bot to its Durable Object. The
durable Pi runtime calls the model there; answering a text question does not start
a Linux container. A computer tool wakes the bot's ComputerDO, which restores its
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
assistant response. The default Kimi model was rejected with HTTP 403 because it
requires Workers Paid; this is reported as a model failure with a billing message.

The desktop Docker smoke passed in GitHub Actions: Chromium, verified Unicode
input, PNG screenshot, shell deduplication, checkpoint checksum and file restore.
Cloudflare rejected container activation because the account did not have Workers
Paid. The **Cloudflare** computer and cold-start/restore performance therefore
remain unverified until that prerequisite is enabled and
`npm run smoke -- --computer` passes. A desktop running in CI does not establish
that its cloud deployment works.

No credentials belong in this repository.
