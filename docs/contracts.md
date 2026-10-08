# MVP contracts

## Product and naming
The product is Timber. A Bot has a name, instructions, runtime,
model and a single persistent conversation. Tasks/runs are inside
that conversation. v1 is cloud-only; no iOS implementation in this milestone.

## Deployment
- One Cloudflare Worker, WorkspaceDO registry, BotDO per bot, ComputerDO per bot.
- SQLite-backed DOs; R2 bucket FILES for immutable checkpoints and artifacts.
- First engine Pi through official PiHarness. Default model gpt-6.1-sol via
  the user's explicitly authorized ChatGPT plan. Explicit @cf/ models retain
  Workers AI. No automatic fallback to separately billed inference.
- ComputerDO owns one reusable Linux desktop container, lazily started.
- Private single-owner MVP. BOTSPACE_API_TOKEN is a Worker secret; every /v1
  data API request requires Authorization: Bearer token or a valid same-origin
  console session, except the scoped live desktop WebSocket upgrade below.
  Health is public and contains no account information. Never put credentials in
  URLs, localStorage or sessionStorage.
- /console is a static unprivileged shell. Its persistent login exchanges an owner
  token for an HttpOnly session cookie, then discards the token from JavaScript.
- Cross-tenant design: deterministic owner identity "owner" after auth. Bot ids are
  server-generated UUIDs. Registry membership checked before any access.
- Model/tool task-count budgets are opt-in Worker variables
  `BOTSPACE_MAX_GENERATIONS` and `BOTSPACE_MAX_TOOL_CALLS`. Unset, empty or `0`
  means uncapped; positive safe integers impose independent per-task caps.
  Invalid values are rejected. Logical operation accounting persists across
  recovery, even while uncapped; duplicate dispatch identities are counted once.
  Timeouts, inference retries, response-size limits and cancellation remain
  independent. Changing budgets neither resumes terminal runs nor replays tools.

## HTTP surface
JSON dates are ISO8601; camelCase fields; errors {error:{code,message}}.
- GET /health -> {ok:true,service:"botspace"}
- POST /v1/session with Authorization: Bearer token -> {authenticated:true,expiresAt}.
- GET /v1/session with session cookie -> {authenticated:true,expiresAt}; invalid or
  expired sessions return 401.
- DELETE /v1/session -> {authenticated:false}; clears this browser's cookie,
  including after expiration or owner-token rotation.
- GET /v1/connections/chatgpt -> {connected,hostId,account?,model,status,verifiedAt?}
- POST /v1/connections/chatgpt imports the locally completed OAuth registration;
  requires owner auth, validates OpenAI signed identity and direct-plan permission.
- DELETE /v1/connections/chatgpt revokes and clears credentials, returns status
  with revoked:boolean. A failed remote revocation is explicit.
- POST /v1/connections/chatgpt/verify performs one small real inference and only
  returns {ok:true,model} after response.completed.
- GET /v1/bots -> {bots:Bot[]}
- POST /v1/bots {name,instructions?,model?,computerApprovalMode?} -> 201 {bot:Bot}
- GET /v1/bots/:id -> {bot:Bot}
- PATCH /v1/bots/:id {name?,instructions?,computerApprovalMode?} -> {bot:Bot}
- DELETE /v1/bots/:id -> 200 {botId,deleted:true}. Repeated deletion of the same
  known bot is idempotent; an unknown ID returns 404. Registry access is removed
  before cleanup. The agent and computer are stopped before their data and R2
  prefix are erased. If cleanup is pending, returns 503 `bot_deletion_pending`;
  access remains disabled, the deletion alarm retries, and another DELETE resumes
  cleanup. Minimal ID/status tombstones prevent resurrection. Shared ChatGPT
  credentials are not deleted.
- GET /v1/bots/:id/messages -> {messages:Message[]}
  Assistant messages may carry `kind: "progress" | "final"`. Progress is public
  assistant commentary accompanying native tool calls; it is durably deduplicated
  by its native message identity. Final answers retain operation-based deduplication.
  Messages without kind remain ordinary messages for backward compatibility.
- POST /v1/bots/:id/messages {text,operationId} -> 202 {run:Run}
  The receipt confirms durable storage of the user input. A busy bot processes
  subsequent inputs in order. Transient engine admission failures stay queued
  with a fixed diagnostic and retry through the shared Lifecycle alarm using the
  same operation ID (five total attempts, with 1/2/4/8-second backoff). A lost
  engine receipt is reconciled against native durable state before resubmission.
  After exhaustion, an identical POST explicitly retries that saved input without
  duplicating its message. This only resets unadmitted delivery failures, including
  the exact legacy admission-failure state. It never resets actual model/tool
  failures or replays cancelled or interrupted effects.
- GET /v1/bots/:id/runs?limit=30&before=<cursor>
  -> {runs:Run[],activeRuns:Run[],nextCursor:string|null}. Runs are newest-created
  first, with stable SQLite rowid pagination. `limit` defaults to 30 and accepts
  digit strings representing integers 1..100; `before`, if present, must be a
  digit string representing a positive safe integer. Invalid values return 400.
  Pass `nextCursor` unchanged as `before` for the next older page; null means no
  older page remains. New runs inserted between requests do not shift older pages.
  `activeRuns` independently contains all admitted queued/running/waiting_approval/waiting_connection
  runs (at most 16), newest-created first, even if absent from the requested page;
  it can overlap `runs`. Listing makes no new inference calls beyond the existing
  recovery of already accepted runs. Authentication and bot membership checks apply.
- GET /v1/bots/:id/runs/:runId -> {run:Run}
- POST /v1/bots/:id/runs/:runId/cancel -> {run:Run}
- GET /v1/bots/:id/events?after=cursor -> SSE id, event=event, JSON BotEvent.
  Reconnect fetches durable events >cursor; no credentials in URL.
  Tool completion events can include both `operationId` (stable computer effect
  identity) and `toolCallId` (native call identity). Clients merge these explicit
  aliases for display; neither identical command text nor event names prove
  execution success. Transient model failures, incomplete transport responses and
  responses with neither tools nor public text use Pi's durable generation retry
  (two retries, 500/1000 ms backoff). They retain the same input and recorded tool
  results; completed effects are not replayed. Limits, access denial, filtering
  and invalid protocol remain terminal. `run.retrying` exposes only the attempt,
  maximum retries, retry time and safe error category. Exhausted empty responses
  fail as `model_empty_response`. A native completion containing only progress
  without a pending host decision does not claim task completion.
  Host-dispatched actions persist `tool.started` before execution and include an
  allowlisted `input` display summary (command, path, coordinates or other public
  parameters). Completion repeats that summary with the result, using the same
  operation identity. File bodies and typed text are omitted; common command
  credential forms and URL credentials/query values are masked. This summary is
  presentation data and is never used to execute or retry an action.
  The console renders started/completed events directly in both the conversation
  and Activity, independent of transcript refresh. Command/parameters, status
  and a bounded output/error preview remain visible with details closed. Streaming
  text does not evict tool records from the separate bounded activity history.
  The conversation header represents active work only. Terminal failures and
  cancellation appear once after that task's activity; they do not label the bot
  or the entire conversation. Continue submits a new explicit request using the
  recorded context, rather than replaying an old computer operation.
- GET /v1/bots/:id/computer -> {computer:ComputerStatus}. `starting` means an
  initialization is currently in flight. A failed control-server probe or saved
  startup failure is `unavailable`, with optional fixed `error:{code,message}`.
  Status reads never start a computer, dispatch actions or renew its idle timeout.
- POST /v1/bots/:id/computer/actions {operationId,action:ComputerAction}
  -> {result:ComputerResult}; authenticated user intentionally invokes tools.
- POST /v1/bots/:id/computer/suspend -> {computer:ComputerStatus}; checkpoint
  then stop. Rejects active runs or executing approvals and invalidates GUI approvals.
- GET /v1/bots/:id/approvals -> {approvals:Approval[]}
- POST /v1/bots/:id/approvals/:approvalId {decision:"approve"|"deny"}
  -> {approval:Approval}; exact stored arguments executed only once on approval.
- GET /v1/bots/:id/artifacts/:artifactId -> authenticated bytes. All file access
  scoped to bot prefix. Generated HTML/SVG are attachments, never same-origin code.

## Console sessions
The cookie `__Host-timber_session` is Secure, HttpOnly, SameSite=Strict, host-only
and Path=/, with an absolute 30-day expiry. Only HTTP loopback development uses
the separate non-Secure `timber_session_dev` cookie. Other HTTP origins cannot
create or authenticate console sessions. Sessions are versioned HMAC-SHA256
capabilities with a random nonce, exact-origin binding and fixed expiry, signed
using the owner secret. Rotating BOTSPACE_API_TOKEN invalidates all sessions.
Logout clears only this browser's cookie; it does not revoke other devices or
invalidate a separately copied capability before expiry.

Session endpoints and all cookie-authenticated data requests require
`X-Timber-Client: console` and same-origin provenance: an exact Origin header or
`Sec-Fetch-Site: same-origin`. Conflicting Fetch Metadata and navigations are
rejected, including GET requests. The console uses `credentials: same-origin`.
Bearer-authenticated API clients retain their existing behavior, and an invalid
Authorization header never falls back to a cookie. The desktop WebSocket still
requires its independent one-use ticket and exact-origin check.

## Internal boundaries
ChatGPTAuthDO stores one owner's encrypted OAuth registration separately from bots
and workspace archives, serializes rotating-token refresh, and injects tokens only
in requests to api.openai.com. It exposes no token-read route. Pi receives a fetch
transport port, never OAuth credentials. OAuth is completed on the user's local
loopback callback and imported over the authenticated HTTPS API. No iOS app.

Shared types live in @botspace/contracts. Runtime implementer owns its concrete
types and exports createPiRuntime({owner,ai,model,instructions,tools,...}) or agrees
an integration API with backend implementer immediately. Pi native recovery owns
the loop; backend persists user-facing run/event projection. Runtime events need
normalization into BotEvent; do not expose raw engine-specific formats to UI.

ComputerProvider exports exec(botId,operationId,action), status(botId), checkpoint(botId).
ComputerAction is a discriminated union: exec, readFile, writeFile, listFiles,
screenshot, click, move, doubleClick, drag, type, key, scroll, navigate, checkpoint.
Cloud provider and ComputerDO concrete implementation live under packages/computer. Container HTTP
server and image live in infra/computer. Agree export names with API agent.

Mouse coordinates are integers in the 1280×800 desktop. `move` positions the pointer
without clicking; `doubleClick` sends two clicks 100 ms apart. `drag` holds the chosen
button from `{fromX,fromY}` to `{toX,toY}` over `durationMs` (100–2000, default 500),
with a guaranteed release attempt on failure. Left, right and middle buttons are
supported. New gestures require the corresponding image health capability; older
images reject before journaling and never report a simulated result. They share
the usual GUI approval policy and human-control exclusion. Pi exposes
`desktop_move`, `desktop_double_click` and `desktop_drag`.

Pi exec supplies a 120,000 ms default timeout and preserves an explicitly requested
shorter timeout. The computer's existing HTTP exec default remains 30,000 ms for
direct clients that omit it; its maximum is 120,000 ms. A timeout terminates the
process group and retains the partial output and exit code. Long-running app
servers must detach all standard streams, keep live logs outside /workspace and
be checked separately for readiness. A shell exit code alone does not prove an
app is responding.

Checkpoint errors preserve the completed or failed command outcome. Known
background-write conflicts, archive limits and nonportable files are classified
into fixed safe diagnostics; arbitrary server responses and paths are not
forwarded. Explicit checkpoint failure reports failed with the same safe cause.
Retrying the original operation ID never reruns its command or its checkpoint;
after fixing the persistence cause, a new checkpoint operation saves the existing
files without repeating the command.

Computer operation IDs accept 1–160 ASCII letters, digits, dots, colons, hyphens
or underscores. Runtime adapters must map opaque model call IDs into this space
before requesting approval or invoking a computer. Pi preserves existing valid
`pi-tool:<taskId>:<callId>` IDs for journal compatibility; incompatible IDs use
a deterministic SHA-256 mapping in a separate namespace. Never strip characters
or truncate IDs, which could merge distinct operations. Stored interrupted
approvals are not rewritten or replayed by this mapping change.

Computer actions from the model pass through host policy. The bot configuration
`computerApprovalMode` is `ask` (default, including older bots with no field) or
`automatic`, selected explicitly through authenticated bot configuration. In `ask`,
shell, file writes and browser/desktop input require approval; read/list/screenshot
and checkpoints can run automatically. In `automatic`, new computer operations run
under the bot's standing authorization. Changing this setting never executes,
rewrites or overrides a stored approval, denial or interrupted result. The console
can directly invoke actions as the human. User action approvals are persisted; do not
keep an unbounded promise waiting for approval. The runtime returns a pending-approval
result and resumes with the decision after user input. No automatically replayed exec.
Concurrent recovery requests share one in-flight approval finalizer. The terminal
approval result and continuation input are persisted atomically; stale finalizers
cannot overwrite a terminal approval or rewind a later continuation. Provider
exceptions retain only reviewed diagnostic codes/messages, still mark the outcome
unconfirmed, and never authorize an automatic retry of the effect.
Late admission or observation failures from an older native input cannot change
the status of its replacement continuation or undo cancellation.

Before each model generation, the host can supply an approval context: all active
unexpired pending/executing approvals and the latest 20 other approvals, with only
id, status, action type and expiration. Expired pending requests are summarized as
expired. Historical pending tool results are not current authorization state.
A fresh explicit user request to retry may create a new approval request after a
denial or expiration; it does not approve or execute the old action. Pausing applies
to the current run, not to every future message in the bot conversation.
The runtime refreshes bot configuration from the registry before each generation
and each new tool dispatch. A failed lookup authorizes no new action. Monotonic
configuration timestamps prevent an older in-flight request from restoring an
obsolete permission; already accepted effects are not cancelled by a policy edit.

## Storage / lifecycle
The normal idle window is five minutes. Tool activity, active runtime events,
explicit workspace reads, live-desktop lease renewals and successful app requests
renew it. Passive status polling and an open chat do not. A detached server alone
does not keep the machine awake. Idle shutdown first checkpoints, then destroys
the container; checkpoint failures defer shutdown and retry after one minute.
A separate fifteen-minute infrastructure inactivity timeout is the fallback.
Restoration brings back the checkpointed /workspace files, not process memory,
running services, desktop windows, /tmp or packages installed elsewhere.

Workspace path /workspace, one writer via ComputerDO. Root package/tool image version
pinned. Backend stores artifacts and directory archive in R2, metadata in DO. Unsafe
in-progress operations after restart are interrupted; completed results deduplicated.
No container per tool call. Stop only after true inactivity. Mark checkpoints durable
only after successful upload; don't claim full live-volume persistence.
Bootstrap desktop provisioning is bounded by a native process-group timeout
(240 seconds plus a 5-second kill grace), so timed-out package installers cannot
continue after the failure. No user action is journaled or dispatched before
initialization succeeds. Startup diagnostics survive object eviction until a
newly requested initialization succeeds; status polling does not retry startup.
The production configuration uses a digest-pinned prebuilt desktop image, avoiding
bootstrap package installation. Image preparation occurs at deployment; existing
running computers retain their image until the next natural start.

## Delegation
Not implemented in this milestone. Future send_to_bot should use bounded
asynchronous task submission with source bot/run id,
deduplicated operation id and depth cap. Bot identity preserved, all target ids checked
in registry. Can be followup if other core loop critical paths aren't yet complete,
but document explicitly instead of a fake tool.


## Host tools and GitHub connection
The host advertises a small catalog through runtime-independent `catalog` / `call`
ports. Pi implements native `list_tools` and `call_tool`; neither engine nor skill
owns provider credentials. Standard Agent Skills sources live in `skills/*/SKILL.md`
and `load_skill` loads them on demand. Loading instructions grants no permissions.

GitHubAuthDO stores one owner's encrypted private GitHub App registration and user
OAuth credentials, separate from bot transcripts and workspace checkpoints. First
connection creates a private personal App through GitHub's manifest flow, installs
it on selected repositories and verifies the authorizing account and installation.
The owner must complete GitHub consent. This registration flow currently targets
personal accounts; organization-owned Apps require a separate registration policy.

- GET /v1/connections/github returns safe account/App connection metadata.
- POST /v1/connections/github/connect starts account-wide setup, including when
  no bots exist. Settings and conversation setup use the same owner connection.
- DELETE /v1/connections/github revokes Timber grants/capabilities and removes local
  credentials. Uninstall the App in GitHub to revoke the GitHub-side installation.
- GET /v1/bots/:id/connections returns pending requests first plus recent history.
- POST /v1/bots/:id/connections/:requestId/connect returns {url} for the browser's
  provider consent flow. No token entry in chat.
- Public /github/setup/{start,manifest,install,oauth} validates one-time expiring
  state and a browser-bound secure HttpOnly cookie. No data API bypass.
- Public /github/git/:owner/:repo.git/{info/refs,git-upload-pack,git-receive-pack}
  is a narrow smart-HTTP proxy requiring a five-minute repository capability.
  GitHub installation tokens never leave the host; the Linux process receives only
  a transient scoped capability, which is revoked after the Git operation.

The GitHub connection belongs to the Timber account and is shared by all bots.
GitHub All/selected repositories and installation permissions are checked live;
per-bot grants are not a second access gate. Existing installations migrate from
verified legacy grants or the authorizing user's installation list.

Missing provider access saves a ConnectionRequest and pauses the run as
`waiting_connection`. Authorization persists the connected state and a new native
continuation atomically; callback retries admit that exact continuation. Cancellation,
bot deletion and newer native operations fence stale callbacks/tool calls. Authorizing
access does not claim that the original tool ran: the resumed agent dispatches it.
Bot recovery, connection reads, OAuth completion and a durable retry reconcile
pending requests against provider access, including permissions changed outside
the original request. Continuations are admitted once.

`github_connect` connects the account without requiring a repository; an optional
repository asks for the access needed by that task. `github_list_repositories` lists
the installation's authorized repositories with pagination. `github_clone` and `github_push` use
native Git in the existing computer; `github_create_pull_request` and
`github_list_pull_requests` use the fixed, host-validated remote GitHub MCP endpoint.
PR writes are journaled and reconciled by marker before retrying an uncertain result.
Git actions are stable credential-free ComputerAction values. Old running desktop
images return `computer_upgrade_required` before any Git effect; an explicit suspend
checkpoints the workspace, then the next start uses the new image. Never restart an
active computer just to upgrade it.

## Workspace apps
Each bot workspace can expose multiple named apps, each with its own ID, port,
readiness, base path and stable URL. See [workspace-apps.md](workspace-apps.md).
`publish_app`, `list_apps` and `remove_app` are engine-independent host tools. The
model explicitly probes readiness via list_apps; console polling reads stored state
and does not wake or keep a machine alive.

- GET /v1/bots/:id/apps returns {apps}.
- POST /v1/bots/:id/apps/refresh explicitly probes existing apps without starting a VM.
- POST /v1/bots/:id/apps {name,port,operationId} registers/probes {app} idempotently.
- DELETE /v1/bots/:id/apps/:appId removes access, preserving source/server files.
- POST /v1/bots/:id/apps/:appId/open issues a one-use 60-second POST ticket.

A separate `timber-preview` Worker delegates through a service binding to the API's
WorkspacePreviewGateway. App code never runs on the admin origin. The ticket becomes
an HttpOnly, app-path-scoped browser session. App URLs contain no credentials;
opening a copied URL on another browser requires access through Timber. HTML, assets,
HTTP APIs and WebSockets share the app's prefix. The server must support that base
path (e.g. Vite --base); no fragile HTML rewriting. Control and desktop transport ports 8080, 5900, 5901, 6080 and 6081 are blocked.
Service workers are disabled on the preview origin. This is a private single-owner
MVP: apps share a preview origin and are not separate browser security principals.

## Live desktop and workspace inspection
Computer screenshots capture the complete X11 desktop. The console now separates
live observation/control from model screenshots and from the Files explorer.

- POST `/v1/bots/:id/computer/live-session` `{mode:"view"|"control",replaces?:sessionId}` creates an
  owner-authorized desktop grant and explicitly starts/restores the computer.
  `replaces` is only valid for control transfer from a live Watch grant belonging
  to the same bot. It reserves that viewer's slot while the old stream remains
  open during the new RFB handshake. At most one additional transport exists
  during transfer; exclusive control remains enforced. Failure releases only the
  new grant. The console closes the previous Watch after the new connection is
  ready, so Take control never requires manually disconnecting Watch first.
- GET `/v1/bots/:id/computer/live` upgrades a same-origin WebSocket using the
  returned one-use ticket in `Sec-WebSocket-Protocol`, never a URL credential.
- POST `/v1/bots/:id/computer/live-session/:sessionId/renew` renews a 60-second
  lease; DELETE releases it. Maximum connection lifetime is one hour, maximum
  four viewers and one controller per bot. Renewal updates lease metadata without
  waiting behind workspace reads/checkpoints or starting a stopped computer.
  `desktop_session_expired` expires the viewer grant, not the owner's login.
- Watch retains its intent across panel and browser-tab switches. Brief absences
  keep the socket for up to 30 seconds; longer absences pause it and returning
  resumes with a fresh grant. Lost connections recover with bounded backoff.
  Disconnect, closing the Computer pane, changing bots, logout and Suspend cancel
  that intent. Human control releases immediately when hidden and is never
  reacquired automatically: recovery always uses view-only access.
- Observation is enforced by a separate view-only x11vnc server, not just the UI.
  Remote cursor pixels are part of the desktop stream. A controller must wait for
  active runs/actions to finish or stop them explicitly. New computer mutations
  fail before journaling while a human control lease exists; nothing is replayed.
- The gateway proxies only authenticated live-desktop ports. 8080, 5900, 5901,
  6080 and 6081 cannot be exposed as workspace apps. Browser tickets are scoped
  to one bot and mode, consumed atomically, and never enter agent history.
- GET `/v1/bots/:id/workspace/{tree,file,download,projects,changes,diff}` is a
  read-only owner-authenticated view. Query parameters: `path`, `project`, and
  diff `mode=staged|unstaged`. Explicit Files navigation may wake the computer;
  ordinary bot/status/tab discovery does not.
- Text previews are capped at 256 KiB and downloads at 32 MiB. Text, HTML and SVG
  are rendered as code; raster images may be previewed from authenticated blobs.
  Downloads are attachments with sandbox/no-store/nosniff headers. Binary files
  have metadata and download rather than a misleading text preview.
- Repository discovery is bounded and excludes dependency/build directories.
  Projects show branch/detached HEAD and staged/working/untracked counts. Diffs
  use readonly Git without external diffs, textconv, hooks, fsmonitor or pager.
  Paths and symlinks cannot escape the workspace.

The live connection uses standard noVNC/RFB. The agent runtime remains separately
replaceable: Pi, another harness and a future local computer can use the same
product-level concepts without adopting CUA as the cloud compute provider.
