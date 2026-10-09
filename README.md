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

- Create, rename and delete bots; edit instructions; persistent conversation per bot.
- Native Pi subagents with separate conversations, visible progress, messaging and cancellation.
- Asynchronous delegation between named bots, explicit `@` recipients and optional bot-created named agents.
- Durable asynchronous runs with streamed events, reconnect cursors and cancellation.
- Paginated run history with active runs returned independently of the history page.
- Replaceable agent engine, initially the durable Pi harness with `gpt-6.1-sol`
  through Sign in with ChatGPT plan sharing.
- Host-owned OAuth connection, encrypted credentials, serialized token renewal,
  explicit verification and disconnection. No automatic paid-model fallback.
- One lazy cloud computer per bot, reused across tool calls: terminal, files,
  Chromium, screenshots, mouse, keyboard and scrolling.
- Persisted approvals for model-initiated effects, optional task budgets and operation IDs
  that prevent a repeated request from executing a completed action twice.
- Workspace checkpoints in R2, restore on cold start, explicit suspend and idle stop.
- Protected API, developer console and CLI smoke tests.

The admin console provides bot search, creation and configuration dialogs, a
conversation with code blocks and per-bot drafts, a Runs panel with cancellation,
and an approval indicator available from every panel. Reconnecting restores active
runs even when newer runs have already finished. Older event replay cannot move a
completed run back to running.
Streaming replies use the same safe Markdown formatting as saved messages;
recovery snapshots replace the partial reply before later deltas are appended.
Each user or assistant message has a copy action that preserves its original
Markdown. Public progress updates appear as normal assistant messages. Consecutive
computer operations share an **Activity** block in chronological order; a new
message separates that block from later actions, even within the same task.
Native and host events for the same tool call produce one row. The final answer
follows its actions. Private model reasoning is never shown.
Completed actions remain in the conversation as newer tasks run and after reload;
only the separate diagnostic event log is limited to its latest 200 entries.
Successful desktop actions use a status icon; redundant acknowledgements remain
available only in raw details. Screenshot results show authenticated thumbnails
that expand into a fit/actual-size viewer with download. These previews read
saved artifacts, never run another computer action, and are released on bot
switch or sign-out.
Cancellation, interrupted work and empty model responses have explicit
inline states rather than silently appearing complete.

**Edit bot → Delete bot** asks for confirmation naming the bot. Deletion disables
access, stops the agent and computer, and erases the conversation, approvals,
artifacts and checkpoints. If cleanup cannot finish immediately, the console
offers **Finish deleting** while the backend also retries. The shared ChatGPT
connection is retained.

Create or edit a bot to choose **Computer permission**. **Ask for each action**
is the default; **Allow computer use** authorizes that bot's new commands, file
writes and desktop/browser actions without separate approval. Existing pending
requests, denials and interrupted results are unchanged when switching modes.
Approvals appear inline in the conversation beside their requests, with older
records collapsed in place. **Approve and allow computer use** saves the bot's
permission and then approves that exact stored request.
If either step fails, the console reports what was confirmed without replaying
the action.
The model receives current approval state on each generation, so a historical
pending result does not block an explicit new request to retry after a denial.

The computer panel shows elapsed time during pending actions, clickable workspace
files, readable terminal output, and raw results on demand. Screenshot clicking is
opt-in and maps the displayed image to desktop coordinates. Optional screenshot
refresh happens after a successful desktop action; there is no background polling
that wakes computers. While the Computer panel is open, startup status refreshes
until it settles; this does not start the container or renew its idle deadline.
An unhealthy control server shows an explicit diagnostic instead of indefinite
`starting`. Connection settings hold ChatGPT setup and verification.
The layout supports desktop and mobile, light and dark appearance, and keyboard
navigation. Sign-in exchanges the API token for a protected HttpOnly session
cookie valid for 30 days. The token is then discarded. Reloading or reopening
Timber preserves the session; Sign out clears it. Drafts stay in memory per bot;
the selected bot ID is kept in the URL fragment. On mobile, the bot list opens
into a full-screen conversation; Workspace contains Computer, Files and Apps.
Desktop and iPad keep the conversation next to a collapsible workspace inspector.
The left bot list also collapses, opening as a drawer on narrower iPads. Layout
preferences persist locally; switching inspector tabs preserves the selected file
and conversation. Expanded Computer and desktop fullscreen retain the same prompt
and a collapsible preview with formatted replies and live actions. **History**
opens the conversation inside fullscreen, preserving the desktop connection and
message draft. Browsers without native fullscreen use an
in-page fallback. Writing to the prompt never sends keys to the remote desktop.
The conversation and fullscreen prompt follow the visible viewport's height and
offset when a mobile keyboard opens or pans the page. The transcript keeps its
own scroll position; pinch zoom keeps native browser behavior. Browser regression
tests simulate keyboard resizing and panning on phone and iPad layouts, including
multiline drafts and fullscreen. They do not replace a physical iOS device check.

This is a single-owner development MVP. There is no multi-user login, native iOS
client, routine scheduling, Hermes adapter, local execution
yet. Live desktop viewing/control and a Files/Git explorer are available in the
browser console. It is a test client, not the intended
product interface. Packages and environment variables retain the internal
`@botspace/*` and `BOTSPACE_*` names.

## Bots and subagents

Ask a bot to delegate work to temporary subagents. Pi creates each with a separate
conversation and a concrete task. They share the bot's computer, files, model and
computer permission, so agents working on the same project should coordinate file
ownership. The **Agents** panel lists their status and parent relationships. Open
an agent to read its public conversation, send a follow-up or stop it. Completed
and failed agents can receive follow-ups; a cancelled agent stays cancelled.
Private model reasoning is never displayed.

Agents can exchange messages, contact their parent and wait for another agent's
result. There can be eight active temporary agents per bot, nested up to three
levels. They use Pi's durable conversations and tasks, so reloading the console
does not stop them. A parent finishing its answer does not cancel its remaining
agents; explicitly stopping a task cancels its subagents too. Temporary agents
remain inspectable in their owning bot's history and do not appear as independent
bots or receive a separate computer.

Named bots can send work to each other while keeping their own conversations,
computers and approval settings. In a conversation, type `@`, select another bot
and send the message. Selected recipients appear above the prompt; each receives
the submitted message, and its result returns to the original conversation with
its source identified. Typing a name without selecting it does not send a task.
The **Agents → Bot collaboration** list shows incoming and outgoing delegation
status and links to the target bot. Delivery survives reconnects and deduplicates
retries; delegation paths cannot revisit a bot and are limited to four hops and
eight pending deliveries per source bot.

Enable **Allow creating named agents** in a bot's configuration to let that bot create
persistent named bots. The setting is off by default. A newly created bot uses
the creator's model, starts with **Ask for each action**, and has named-agent
creation disabled. Temporary subagents and messages to existing bots do not need
this setting. Deleting a creator does not delete the named bots it previously
created; cancelling or deleting a source stops its outstanding delegated tasks.

## Task execution limits

By default, a task has no fixed model-round or tool-call count limit. It can
continue until the agent answers, the user stops it, a host approval/connection
is needed, or an actual operation/provider failure ends the run. The old 12-round
and 24-tool MVP caps were Timber policy, not a Pi Durable requirement.

An operator can opt into independent per-task limits using Worker variables:

| Variable | Default | Optional value |
| --- | --- | --- |
| `BOTSPACE_MAX_GENERATIONS` | Unset: no count cap | Positive integer model-generation count; `0` disables |
| `BOTSPACE_MAX_TOOL_CALLS` | Unset: no count cap | Positive integer tool-call count; `0` disables |

These are deployment settings, not per-bot console controls. Invalid values are
rejected instead of silently changing the budget. Accounting survives object
restarts, including when a cap is enabled later; replaying an already recorded
logical operation does not count it again. There is no hidden 100/200 clamp.
Budget exhaustion does not automatically restart or replay the task.

Individual operations remain bounded: two retries for transient inference
failures, a 120-second model stream timeout, the existing response-size cap, and
a 120-second maximum for a finite `exec`. Provider allowance limits still apply.
The console's Stop action remains available while the task is running.

This policy follows the opt-in task-count limits documented by
[OpenCode](https://opencode.ai/docs/agents/#max-steps),
[Claude Code](https://code.claude.com/docs/en/cli-reference), and
[Hermes](https://hermes-agent.nousresearch.com/docs/user-guide/configuration)
(checked 2026-10-08), while preserving Pi's operation-level controls.

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

Run the browser regressions separately:

```sh
npx playwright install chromium --only-shell
npm run test:console
```

The conversation uses the official AI Elements source components, React and
Streamdown inside the existing admin console. Vite builds the static files with
`npm run build:console`; the deploy commands build these assets automatically.
For `npm run dev`, build the console first. The API Worker serves
`apps/console/dist` at `/console/`; no additional UI server or model gateway is
required. Component provenance and licenses are in
`apps/console/THIRD_PARTY_NOTICES.md`.

These use real Chromium with local HTTP API fixtures, with no model or cloud
charges. They cover bot editing, draft isolation, stale SSE, active-run recovery,
pagination, approvals, screenshot input, files, session expiry, and mobile layout.
They also cover immediate message receipts, slow history refreshes, lost responses,
same-ID retries, double submission and strict content security policy. The backend
tests durable input delivery retries after an agent restart, multiple queued
messages and new questions while an older approval remains pending.
The independent Worker suite tests the real API and Durable Objects. To use an
installed Chrome instead, set `CONSOLE_CHROMIUM_PATH` to its executable; CI uses
the runner's installed Chrome. CI retains screenshots as `console-screenshots`.

## Deploy to Cloudflare

### Continuous deployment

The `Verify and deploy Timber` GitHub Actions workflow runs the full checks and
desktop image smoke tests on pushes and pull requests. Only successful runs on
`main` deploy production, including manually dispatched runs on `main`.
Deployment uses the `production` environment and is serialized without cancelling
an in-progress deploy. Superseded revisions are skipped before deployment.
The API and preview gateway are deployed with `npm run deploy`, followed by a
public API health check. Existing Worker secrets are preserved.

Configure GitHub Actions secrets at repository or `production` environment scope:

- `CLOUDFLARE_API_TOKEN`: deployment token (preferred).
- Alternatively, `CLOUDFLARE_API_KEY` and `CLOUDFLARE_EMAIL`: global API key and
  its account email. These are used only when no API token is configured.

To rotate credentials, replace the secret value in GitHub. To switch from a global
key to a deployment token, add `CLOUDFLARE_API_TOKEN`, then remove the old key/email
secrets. No workflow edit is needed. Re-run the workflow on `main` after initial
secret setup. Pull requests never receive the deployment credentials.
The desktop image remains pinned to the digest in the production configuration;
publishing an image archive alone does not roll it out.

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

Skip bucket creation if it already exists. `npm run deploy` uses
`apps/api/wrangler.production.jsonc`, with the desktop image pinned by digest in
this deployment's Cloudflare Registry. Chromium, Xvfb and desktop dependencies
are already installed; fresh computers do not run package installation. The first
image preparation happens during deployment. Updating the image map does not
restart running computers; the new image is used on their next natural start.

For another Cloudflare account, use `npm run deploy:build` with a working Docker
daemon to build and upload the desktop image for that account. For this deployment,
the **Desktop image release** GitHub workflow builds and tests the image, then
publishes a pristine Docker archive and SHA-256 checksum. To release a newer
image without local Docker, verify the archive checksum, decompress it, push it
to the account's Cloudflare Registry with `crane push` and temporary registry
credentials, and update the digest in `wrangler.production.jsonc`. No Cloudflare
credentials are stored in the repository or image release.

`npm run deploy:bootstrap` remains an explicit fallback. It installs desktop
dependencies when a fresh computer starts and is substantially slower.

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

If an approved action is interrupted, the conversation retains a read-only card
with its stored action, operation ID and diagnostic in a collapsible conversation
entry. Do not repeat the original task until its effects are checked:
inspect the relevant workspace file or take a fresh screenshot. An interruption
means the outcome was not confirmed, not that the action had no effect. Polling
the console coalesces recovery of an executing approval; it does not launch a
second approval execution or reset a later continuation.

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
It used the same ComputerDO and bootstrap server as production at that time. This caught and
fixed Python's startup failure on Cloudflare's 64-character container hostname.
Fresh provisioning plus workspace restore took 132 seconds in that single run;
the production configuration now replaces bootstrap with a prebuilt desktop image.
The release image passed actual Chromium/X11, shell, screenshot and checkpoint
smoke tests in GitHub Actions. An isolated Cloudflare computer using the prebuilt
image on 2026-10-06 returned its first Linux command in 24.1 seconds, including
network and VM startup; a subsequent command reused the computer and returned in
9.4 seconds. These are single observations, not a latency guarantee. Package
installation is removed, but VM startup and checkpoint restoration still cost time.
Run `npm run smoke -- --computer`
with the owner's local credentials to verify the full production API and model
flow. The isolated computer test does not validate ChatGPT OAuth.

No credentials belong in this repository.


### GitHub development and workspace apps

The deployed console supports inline GitHub connection requests. Ask a bot to
work on `owner/repository` and open a pull request: it discovers host tools, loads
`github-development`, requests the needed repository access, and waits durably.
Use **Connect GitHub** in that conversation to create/install the private personal
GitHub App and authorize it. The original task resumes automatically; credentials
stay outside chat and workspace archives. This setup currently supports personal
GitHub accounts. See [contracts](docs/contracts.md) for scope and recovery behavior.

One workspace can contain several named apps. Ask the bot to publish its Frontend,
Admin, or API; each appears in **Apps** with its own status and URL. Preview code
runs on a separate origin. Servers must support the returned base path; a copied
URL requires access through Timber in that browser. **Refresh apps** explicitly
checks readiness without starting a stopped computer. See [workspace apps](docs/workspace-apps.md).

`npm run deploy` deploys the API and its separate preview gateway. `deploy:preview`
only updates the gateway. Neither command changes existing authentication secrets.
