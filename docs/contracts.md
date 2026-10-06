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
  API request requires Authorization: Bearer token. Health is public and
  contains no account information. Never put token in URL or localStorage.
- /console is a static unprivileged test UI; it prompts for token in memory only.
- Cross-tenant design: deterministic owner identity "owner" after auth. Bot ids are
  server-generated UUIDs. Registry membership checked before any access.

## HTTP surface
JSON dates are ISO8601; camelCase fields; errors {error:{code,message}}.
- GET /health -> {ok:true,service:"botspace"}
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
  `activeRuns` independently contains all admitted queued/running/waiting_approval
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
  execution success. A successful inference with no tool call or public answer
  fails explicitly as `model_empty_response`; completed effects are not replayed.
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
screenshot, click, type, key, scroll, navigate, checkpoint. Cloud provider and
ComputerDO concrete implementation live under packages/computer. Container HTTP
server and image live in infra/computer. Agree export names with API agent.

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
