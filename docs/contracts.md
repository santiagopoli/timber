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
- GET /v1/models -> {models:ModelOption[],connected,defaultModel,error?}. Returns
  the connected account's selectable models and supported reasoning/Fast options.
  A disconnected or unavailable catalogue has no invented model entries.
- GET /v1/bots -> {bots:Bot[]}
- POST /v1/bots {name,instructions?,model?,reasoningEffort?,fast?,computerApprovalMode?,allowNamedAgents?} -> 201 {bot:Bot}
- GET /v1/bots/:id -> {bot:Bot}
- GET /v1/bots/:id/summary -> {summary:{status,activeRuns,activeAgents,activeProcesses,lastMessage?}}.
  A passive SQL-only sidebar snapshot; it does not admit work, call inference or
  wake a computer. The latest user/assistant text is limited to 240 characters.
  Root work, temporary agents and managed processes have independent counts.
- PATCH /v1/bots/:id {name?,instructions?,model?,reasoningEffort?,fast?,computerApprovalMode?,allowNamedAgents?} -> {bot:Bot}
- DELETE /v1/bots/:id -> 200 {botId,deleted:true}. Repeated deletion of the same
  known bot is idempotent; an unknown ID returns 404. Registry access is removed
  before cleanup. The agent and computer are stopped before their data and R2
  prefix are erased. If cleanup is pending, returns 503 `bot_deletion_pending`;
  access remains disabled, the deletion alarm retries, and another DELETE resumes
  cleanup. Minimal ID/status tombstones prevent resurrection. Shared ChatGPT
  credentials are not deleted.
- GET /v1/bots/:id/messages?limit=500&before=<cursor> -> {messages:Message[],nextCursor:string|null}
  Retained public transcript pages are chronological within each newest/older
  page. Default limit is 500; digit-string integer bounds 1..500 and positive safe
  integer `before` cursors are required, or 400. Pass `nextCursor` unchanged to
  read the next older page; null means no older page remains. Stable SQLite rowid
  pagination preserves older page boundaries while new messages arrive and does
  not depend on timestamps. No messages are deleted by context compaction.
  Assistant messages may carry `kind: "progress" | "final"`. Progress is public
  assistant commentary accompanying native tool calls; it is durably deduplicated
  by its native message identity. Final answers are deduplicated by their native
  answer entry; older answers without that identity retain operation-based deduplication.
  Messages without kind remain ordinary messages for backward compatibility.
- PUT /v1/bots/:id/attachments/:imageId uploads raw PNG/JPEG bytes (5 MB maximum)
  under a client-generated UUID and returns `{attachment:{artifactId,mimeType,size}}`.
  Authentication and bot membership apply; MIME and byte signatures are checked.
  Repeated IDs with identical content succeed; different content returns 409.
  Images are immutable R2 artifacts under the bot prefix, deleted with the bot.
  GET uses the existing authenticated artifact route, never a public URL.
- POST /v1/bots/:id/messages {text,operationId,mentions?:string[],attachments?:string[]} -> 202 {run:Run}
  Up to four distinct uploaded image IDs are allowed; text can be empty only with
  an image. References from other bots or non-chat artifacts are rejected.
  The message fingerprint covers text and ordered image IDs. The transcript stores
  image metadata; admission reads the immutable bytes into native multimodal input,
  including explicit delivery retries. No images are silently dropped or replaced
  with URLs. The promptbox supports file selection, clipboard paste and local
  drag/drop, removable previews, and retains attachments after a failed send.
  Blob conversion uses FileReader, without weakening the console CSP.
  Image attachments with bot mentions are currently rejected, not silently omitted.

  The receipt confirms durable storage of the user input. A busy named bot admits
  subsequent inputs as native Pi steering: they join at the next completed tool
  round, or start a new run after the current final answer. An in-flight model
  generation or unsafe action is not aborted or replayed to admit a message.
  New requests can create independent subagents while earlier children continue.
  Transient engine admission failures stay queued
  with a fixed diagnostic and retry through the shared Lifecycle alarm using the
  same operation ID (five total attempts, with 1/2/4/8-second backoff). A lost
  engine receipt is reconciled against native durable state before resubmission.
  After exhaustion, an identical POST explicitly retries that saved input without
  duplicating its message. This only resets unadmitted delivery failures, including
  the exact legacy admission-failure state. It never resets actual model/tool
  failures or replays cancelled or interrupted effects.
  Model configuration failures before native admission have specific safe errors:
  disconnected accounts, unsupported model/reasoning/Fast settings and unsupported
  image input fail without scheduling inference. Temporary catalogue failures keep
  the same bounded automatic retries and their actionable catalogue error. An
  identical POST after correcting settings may refresh that saved input's model
  snapshot only while a durable configuration-failure marker exists and native
  state confirms the input was never admitted. Stop remains a permanent fence.
  `Run.admissionRetryable:true` exposes this safe resend option in REST and run
  events; admission, Stop or a genuine execution outcome removes it.
- GET /v1/bots/:id/runs?limit=30&before=<cursor>
  -> {runs:Run[],activeRuns:Run[],nextCursor:string|null}. Runs are newest-created
  first, with stable SQLite rowid pagination. `limit` defaults to 30 and accepts
  digit strings representing integers 1..100; `before`, if present, must be a
  digit string representing a positive safe integer. Invalid values return 400.
  Pass `nextCursor` unchanged as `before` for the next older page; null means no
  older page remains. New runs inserted between requests do not shift older pages.
  `activeRuns` independently contains all admitted queued/running/waiting_approval/waiting_connection
  runs, newest-created first, even if absent from the requested page;
  it can overlap `runs`. Listing makes no new inference calls beyond the existing
  recovery of already accepted runs. Authentication and bot membership checks apply.
  HTTP task admission permits at most 16 active host runs. Native child inputs are
  projected separately and may increase that total; `activeRuns` is never truncated
  to the admission limit. Temporary agents retain their independent eight-agent cap.
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
  Model failures retain an allowlisted `Run.errorCode` alongside the safe public
  error. The console uses this category to open connection, model or context
  settings for failures that need a change; transient failures retain an explicit
  continuation. HTTP and streaming provider errors use the same categories.
  Subscription Sharing allowance errors, including SDK errors that retain only
  provider prose, show `chatgpt_allowance_exhausted` and a ChatGPT Usage link.
  They do not offer an unchanged retry or switch to API-key billing. The provider
  controls the reset time; Timber does not invent one. List/detail reads can
  reclassify a saved generic model failure from its existing native receipt,
  without running inference, rewriting timestamps or changing terminal status.
  Production diagnostics log only the category, stage and optional HTTP status,
  never provider error bodies, conversation text or credentials.
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

### Account model settings
ChatGPT model discovery calls `GET https://api.openai.com/v1/models` using the
same OAuth connection as inference. Only entries with `visibility:"list"` appear,
in provider order. Public options contain the model ID/name, supported reasoning
efforts, advertised default effort, Fast support and available context/input
capabilities; raw account metadata and credentials are never returned. This is
the account's catalogue, not a hardcoded list of model or effort names.

The catalogue cache lasts five minutes and belongs to a connection revision.
Import and disconnect invalidate it. Network discovery runs outside the token
refresh lock; a delayed response from an old connection cannot populate the new
cache or authorize inference under a replacement account. Catalogue failures are
explicit and never trigger another provider or separately billed API access.

`Bot.model`, `Bot.reasoningEffort?` and `Bot.fast?` are persisted configuration.
Explicit selections on creation or PATCH must be available to the connected
account. Changing the model clears omitted reasoning/Fast settings before applying
that model's default reasoning effort and `fast:false`. Legacy bots without an
explicit effort use the provider's advertised default; Timber does not force
`low`. Creation without explicit model settings remains possible before connecting
ChatGPT; inference still requires a valid connection and account-supported model.
Explicit `@cf/` models retain Workers AI and cannot use ChatGPT reasoning/Fast
settings.

Fast is opt-in and accepted only when the catalogue advertises `fast` or its
`priority` alias. The Responses proxy preserves the selected model, reasoning
effort and supported speed tier with `store:false`, streaming and client-owned
history. The model request has a 30-minute transport deadline; disconnect and
user Stop can abort earlier. This deadline is separate from managed shell process
lifetimes and optional generation/tool budgets.

Run records retain their admitted model settings. Temporary subagents inherit
their parent's selection by default and may choose another supported model,
reasoning effort or Fast setting at spawn; existing child selections remain
independent of later bot configuration edits. `list_models` exposes the same
account options to the model.

Shared types live in @botspace/contracts. Runtime implementer owns its concrete
types and exports createPiRuntime({owner,ai,model,instructions,tools,...}) or agrees
an integration API with backend implementer immediately. Pi native recovery owns
the loop; backend persists user-facing run/event projection. Runtime events need
normalization into BotEvent; do not expose raw engine-specific formats to UI.

Root submissions default to `whenBusy:"steer"`; explicit internal `followUp`
remains available. At a safe boundary Pi places one steering input at a time.
New generations and tools belong to the latest placed input, while durable tool
memos keep already-started invocations attached to their original operation.
Existing children retain their original parent and budget; children spawned for
a later input inherit that input. Several host runs may join one native run and
settle with one answer. Runtime completion includes `answerId` and
`answerOperationId`, recovered from durable generation attribution, so the host
settles every input, displays the shared answer once and assigns it to the input
that generated it. Sending a message never invokes cancellation.
Stopping an older input that has already been joined by a newer input withdraws
only the older submission and cancels its descendants; the newer root work and
its children continue. Stopping the latest input aborts the active native run.
An input still queued in the native inbox is withdrawn without aborting the
active work. Explicit Stop persists the exact affected native input IDs, root task
ID and cancellation group before requesting abort. Recovery marks that same task
before native scheduling resumes; it never aborts a later independent run. Pending
child cleanup and public stop events remain durable until acknowledged.
`wait`, `operation` and `run.failed` include `cancellationId` only for an affected
input that actually settles as `aborted`; unexpected aborts remain failures.

The host persists an outbox of exact input/session IDs before Stop dispatch. New
admissions drain earlier Stop intents first; failed dispatch retries through
Lifecycle without replaying tools. `Run.cancellation:{id,requestedRunId}` records
explicit Stop intent, including on an already completed or failed owner whose
background work remains active. Existing terminal status, answer and error remain
unchanged. Active affected runs become cancelled and share one neutral
`run.cancellation.requested` notice per stable group. Private host and runtime
fences prevent late continuations, approvals, messages and effects from reopening
stopped work; new independent inputs remain available.

ComputerProvider exports exec(botId,operationId,action), status(botId), checkpoint(botId).
ComputerAction is a discriminated union: exec, execPoll, execCancel, readFile, writeFile, listFiles,
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

Pi `exec {command,timeoutMs?,yieldMs?}` starts a managed process with no default
execution deadline. `timeoutMs`, when explicitly supplied, is a positive safe
integer; there is no 120-second maximum. Its expiry terminates the process group
and retains output and the terminal outcome. `yieldMs` is an integer from 0 to
30,000, default 1,000; it limits how long a request waits for output and never
terminates a process. These values have the same meaning for direct computer API
clients and Pi tools.

A response with `status:"running"` includes `processId`, equal to the initial
exec operation ID. It confirms the command continues in the computer. Pi exposes
`exec_poll {processId,yieldMs?}` and `exec_cancel {processId}`, mapped to the
`execPoll` and `execCancel` computer actions. Each observation/cancellation has its
own operation ID and refers to the original process ID. Polling never launches a
command. Output is a cumulative snapshot capped at 128 KiB. Terminal states are
`completed`, `failed`, `interrupted` and `cancelled`; running and explicit successful
cancellation are normal tool results, not tool errors. Processes are scoped to
their bot. Child cancellation is restricted to its own processes or descendants.
BotDO also observes confirmed running processes through a durable ten-second
read-only job, including after their task's final answer. `process.updated` keeps
the conversation and sidebar current without additional model calls. Transport
retries reuse the same observation identity; fully settled terminal states end observation.
Terminal commands with `checkpointStatus:"pending"` remain under observation
until their files are saved or checkpointing fails. Unchanged snapshots do not
emit duplicate output. A durable dispatch marker also recovers an exec whose
initial receipt was lost: observation starts after transport failure or recovery,
not during ordinary startup. If the provider confirms `processKnown:false`, the
host first obtains an acknowledged cancellation fence for that process ID before
reporting a terminal outcome, preventing a delayed start. Historical runtime tool
receipts remain immutable; recovery never relaunches exec or requests a model turn.

Pi marks exec and cancellation unsafe for native replay; polling is safe. A saved
running result survives runtime recovery and directs the next call to the same
process ID. A retry with the original exec operation ID cannot launch a second
command. A cancellation tombstone also fences a delayed initial request. Bot/task
cancellation keeps retrying process cancellation until the computer acknowledges
it; a request to stop is not reported as a confirmed stop while delivery is pending.

Long builds, installations and app servers can use managed sessions without
`nohup`, shell backgrounding or a guessed short timeout. App readiness is checked
separately; a live process alone does not prove that an app is responding. Keep
live logs and temporary build output outside /workspace. Checkpointing waits for
active managed commands to settle; their launch or a running receipt does not
claim that workspace changes are durably checkpointed.

Checkpoint errors preserve the completed, failed or cancelled command outcome. Known
background-write conflicts, archive limits and nonportable files are classified
into fixed safe diagnostics; arbitrary server responses and paths are not
forwarded. Explicit checkpoint failure reports failed with the same safe cause.
Reusing the original operation ID never reruns its command. Persistence recovery
retries only the save; an explicit checkpoint can also save the existing files
after fixing an actionable archive problem, without repeating the command.

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
renew it. A managed running process is active work: a durable ten-second maintenance
alarm observes it and renews the computer lifetime without model inference.
Explicit checkpoint, suspend and human desktop control reject while managed
commands are active. Terminal command checkpoints are deferred until the active
batch finishes; one checkpoint can cover the completed batch. Passive status
polling and an open chat do not keep the machine awake. A detached server outside
managed execution alone does not keep it awake. Idle shutdown first checkpoints, then destroys
the container; checkpoint failures defer shutdown and retry after one minute.
Checkpoint persistence has its own durable retry intent, separate from execution.
Uploads enforce the declared byte length with a streaming transfer and verify SHA-256.
The upload candidate is recorded before R2 admission; recovery checks its size and
checksum and atomically publishes its pointer and affected operation receipts.
A lost pointer write can therefore recover an existing upload without rerunning a
command. A fresh explicit checkpoint or suspend always captures current files,
including desktop changes made after any recovered upload.
Transient persistence failures get one immediate retry, then durable retries with
exponential delay capped at one minute. User activity cannot postpone this deadline.
`checkpointStatus` is `pending`, `saved`, or `failed`; routine saving is not an action
error. Continued persistence failure becomes visible after three failed attempts;
successful publication removes only the checkpoint warning and preserves command
errors. Snapshot validation failures remain actionable immediately. If the original
computer was lost before upload, recovery reports unsaved files instead of starting
a new computer or claiming that the old effects were saved.
A separate fifteen-minute infrastructure inactivity timeout is the fallback.
Restoration brings back the checkpointed /workspace files, not process memory,
running services, desktop windows, /tmp or packages installed elsewhere.

Workspace path /workspace, one writer via ComputerDO. Root package/tool image version
pinned. Backend stores artifacts and directory archive in R2, metadata in DO. Unsafe
in-progress operations after restart are interrupted; completed results deduplicated.
Managed exec sessions retain their process IDs in ComputerDO. Eviction of that
object reconciles the existing session and computer boot identity instead of
reissuing exec. A control-server or container restart interrupts the old session,
retains available output and never replays its command. Server recovery attempts
to terminate a surviving process group only after verifying its recorded process
identity, avoiding unrelated processes that reused the PID.
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
### Temporary Pi subagents
The runtime uses native Pi conversations and durable tasks for temporary agents.
Each starts with a fresh transcript, inherits the owning bot's model, instructions
and tool policy, and receives its own name and task. It shares the bot's computer
and workspace; it does not create a registry bot or another container. Native
conversation and task IDs remain internal. Public `Subagent` metadata includes an
ID, name, task, parent operation, optional parent subagent, current operation,
status, timestamps and public result/error.

Pi exposes `spawn_subagent {name,task}`, `list_subagents {}`,
`send_subagent_message {targetId,text}`, `wait_subagent {subagentId}` and
`cancel_subagent {subagentId}`. A child may use `targetId:"parent"`; other temporary
agents are addressed by their visible IDs. Messages queue as durable inputs and
start a new turn if the recipient is idle. Initial successful task results return
to the parent automatically; peer-to-peer messages do not create automatic reply
loops. Wait returns immediately for an approval or connection wait so the host can
present that decision. A native steering input also releases `wait_subagent` with
`{status:"yielded",reason:"new_input",subagent}`. Only that read-only observer
ends: the child and its durable delivery keep running. The completed tool round
then lets the parent attend to the input, including creating another child.
Public `subagent.reported` events contain the message body in `text`, with
`contentFormat:"plain"` and sender identity in `subagentId`/`subagentName`.
Model-only attribution stays separate so the UI shows the sender once. Legacy
events retain their original stored text; display removes only the known sender
wrappers, never prefixes from new plain messages or unrelated transcript entries.
There are at most eight active agents per bot and three
levels of nesting. Model generations and tool calls share the originating parent
operation's optional budgets; spawning does not reset those counters.

An agent's conversation is owned by a native background task and its submissions
and result delivery use native durable tasks. Parent completion leaves background
work running. Explicit cancellation cascades to descendants. Active agents become
cancelled; already completed or failed agents retain their public result, error and
timestamps. A private durable fence closes every stopped session, and the
`subagent.stopped` event projects that intent without rewriting completed history.
Completed or failed agents accept explicit follow-up messages unless their session
or originating task was stopped. Bot deletion stops all of its temporary agents
before deleting storage.
Public histories remain inspectable after task completion and recovery. Fresh
computer actions always pass through the owning bot's current host policy, and
child approvals/connections remain attached to the child run. A host continuation
resumes the child that requested the decision.
Admission and automatic parent notification retry transient failures with stable
operation IDs. If parent notification exhausts retries, the result remains in the
child conversation and the Agents view shows a delivery notice.

- GET /v1/bots/:id/agents -> {agents:Subagent[]}.
- GET /v1/bots/:id/agents/:agentId/messages -> {messages}; public messages include
  `id`, `role`, `text`, optional `kind` and optional `createdAt`.
- POST /v1/bots/:id/agents/:agentId/messages {text,operationId} submits a durable
  follow-up and returns 202 {run,receipt:{operationId,accepted:true}}. Text is
  bounded to 32,000 characters; model-initiated peer messages are limited to 20,000.
- POST /v1/bots/:id/agents/:agentId/cancel -> {agent}; cancels that agent and its
  descendants.

All routes require owner authentication and registry membership. Agent IDs are
resolved only inside the selected bot. `Run.subagentId` and `Run.parentRunId` link
child execution to the ordinary durable run/approval projection. Each child input
has its own host run. Only approval and connection continuations reuse that input's
run; queueing a follow-up does not supersede an in-flight tool or its approval.
Parent result notifications create separate continuation runs linked through
`parentRunId`, so cancelling the originating task also fences those continuations.
Subagent events
carry explicit attribution; child text and tool events cannot complete the parent's
run or appear as the parent's final answer. Only public message text, status and
safe activity are exposed; native reasoning is never returned in these transcripts.

### Persistent named bots
`list_bots`, `create_bot` and `send_to_bot` are host capabilities discovered through
Pi's `list_tools` and invoked through `call_tool`. Each named bot retains its own
identity, conversation and computer. The single owner's connected services remain
host-owned; delegation does not copy credentials or another bot's workspace.

`Bot.allowNamedAgents` is a strict boolean, defaulting to false for new and legacy
bots. The owner may change it through bot configuration. Only `create_bot` requires
this permission; messaging existing bots and temporary subagents do not. Creation
checks the current registry permission and persists the new bot and operation
receipt atomically. A bot-created named agent inherits the source model, reasoning
effort and Fast setting, records
`createdByBotId`, starts with `computerApprovalMode:"ask"` and has
`allowNamedAgents:false`. It does not inherit standing computer authorization.
Replaying a completed creation returns its existing identity even after permission
revocation; replaying after that child was deleted returns 404 and never recreates it.

`send_to_bot {botId,text}` durably queues a task and returns immediately with an
`AgentDelegation` receipt. Registry membership is checked for both bots. The target
receives a normal queued run, preserving its identity and approval policy. Inputs
carry `Message.provenance` with `kind:"bot"|"mention"`, source bot ID/name, source
run ID and delegation ID. The target `Run.delegation` records the source and complete
bot-ID path. Source identity comes from the active host run, not model-supplied
attribution. Paths allow at most four hops and cannot revisit a bot; each source bot
has at most eight pending delegations.

WorkspaceDO keeps a durable outbox beside the bot registry. Submission uses a stable
`delegate:<delegationId>` operation ID, so retries and lost receipts do not create a
second target run. A completed target run returns its public final answer, or its
safe terminal diagnostic, to the source with `kind:"delegation_result"` provenance.
The source and target runs remain separately addressable. Result continuations
retain the visited bot IDs in their delegation path, preventing automatic task
echoes back to a bot already contacted in that path. A fresh user request starts
with a new path. Request and result text
are bounded to 32,000 characters. Transport delivery has five attempts with
1/2/4/8-second backoff; this retries input delivery, never completed computer effects.
Observation polls queued/running work every three seconds and host waits every
15 seconds. A delegation still active after 24 hours is cancelled with a visible
failure. Exhausted result delivery retains an error in the delegation record rather
than claiming that the source received it.
Exhausted submission or observation retries request cancellation of the exact
target operation before reporting the uncertain delivery outcome. A missing target
is a visible terminal failure. A cancellation request remains pending until the
target acknowledges it.

Cancelling the source run or deleting its bot requests cancellation of the exact
delegated target operation. The coordinator also honors `Run.cancellation` on a
completed source: its terminal result stays intact while new mentions, pending
delegation submissions and outstanding target work are fenced. A target cancellation tombstone fences a late or lost
submission receipt, so cancellation does not depend on knowing the target run ID.
Cancellation delivery retries until acknowledged, with backoff capped at one
minute. Source deletion removes task text, result text and names from its outbox,
retaining only the cancellation identities until cleanup finishes. Other work in
the target bot and named bots previously created by the source remain independent.

- GET /v1/bots/:id/delegations -> {delegations:AgentDelegation[]}; latest 100 incoming
  or outgoing records, including target run ID, status and available diagnostics.

### Mentions
`POST /v1/bots/:id/messages` accepts `mentions`, at most eight distinct bot UUIDs.
The console's `@` menu selects explicit recipient IDs and displays recipient chips;
typing a name without selecting a recipient does not dispatch a task. Duplicate
names remain distinguishable by ID. Each selected recipient receives the submitted
message through the same durable delegation outbox. Transcript messages retain
`mentions` and source provenance. Client retries keep the original operation ID,
text and recipient list. Removing the selected name from a draft removes that
recipient; a plain `@` string never grants authority to choose a different bot.


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
Publishing registers and probes a server; it does not install dependencies or
start that server. The startup skill directs the agent to inspect the repository,
use the returned base path, start one managed process and poll its existing
process identity while checking readiness.

Unavailable apps may include `readiness:{code,httpStatus?,message}`. Codes are
`http_error`, `computer_unavailable`, `timeout` or `connection_failed`; messages
are fixed troubleshooting hints, never raw server output. A five-second root probe
requires HTTP 2xx/3xx. HTTP 404 is unavailable and points to base-path/router
configuration; successful or missing assets cannot overwrite root readiness.
Success clears the previous readiness error.

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

## Context compaction and durable memory

Owner-authenticated bot routes expose `GET /context`, `POST /context/compact`
`{operationId,instructions?}`, and an independent memory API under `/memory`.
Manual compaction returns 202 with a durable receipt; automatic compaction uses
Pi's threshold and overflow policies. Both retain the complete archived history. `GET /context` returns every native
root-conversation compaction, not a last-20 slice; stable `compact:<taskId>`
receipts expose reason/status/summaryApplied/historyRetained and optional actual
createdAt/startedAt/summaryCreatedAt, firstKeptEntryId, summarizedEntries and
estimatedTokensBefore (selected-prefix estimate, not billed usage). Unrecorded
historical times/details are omitted; private summaries/instructions/checkpoints
are never exposed. See [context-memory.md](context-memory.md) for field semantics.

Memory lives in the bot's SQLite Durable Object through `packages/memory`,
independently of Pi's model context and the computer filesystem. The shared
contract is `packages/contracts/src/memory.ts`:

- `GET /memory` returns `{memory}` with `schemaVersion:2`, active `entries`,
  `suggestions`, optional preserved `legacy`, `revision`, `limits` and `review`.
  The `content` field is a read-only text export for older clients.
- `GET /memory/search?q=...&limit=...` returns
  `{results:{hits,total,truncated}}`. Search uses deterministic text ranking;
  `limit`, when present, is an integer from 1 to 50.
- `GET /memory/entries/:id` returns `{entry}`;
  `GET /memory/entries/:id/history` returns `{history}`.
- `POST /memory/entries` accepts
  `{operationId,category,title,content,pinned?}` and returns
  `201 {result:{entry,changed}}`.
- `PATCH /memory/entries/:id` accepts the same fields plus `expectedRevision`
  and returns `{result:{entry,changed}}`. This is a complete entry edit;
  category, title and content are required.
- `DELETE /memory/entries/:id` accepts `{operationId,expectedRevision}` and
  returns `{result:{entry,changed}}`. Forgetting memory does not erase source
  conversations; tombstones prevent silent recreation by maintenance.
- `POST /memory/entries/:id/accept` accepts
  `{operationId,expectedRevision,replacesRevision?}` and returns
  `{result:{entry,changed}}`. Accepting a correction also checks the revision
  of the entry it replaces.
- `POST /memory/review` accepts `{operationId}` and returns `202 {review}`.
  A different manual operation ID while review is queued/running returns
  `409 memory_review_busy`; an existing ID returns its recorded receipt.
- `PUT /memory` is retired and returns `409 memory_upgrade_required`.
  Existing freeform notes remain preserved as legacy data, excluded from
  automatic context injection and automatic promotion.

Categories are `preference`, `fact`, `decision` and `procedure`. Scope, actor,
sources, state and replacement identity are host-owned metadata, not caller
write fields. Mutations use operation IDs for replay deduplication and record
revisions for conflict detection. Each temporary child has isolated editable
memory and read-only inherited root-bot memory; named bots remain isolated.
Memory does not grant authority or supersede the user's current request.

Background review works from original user/assistant evidence, not compaction
summaries, system messages, assistant progress, collaboration envelopes or raw
tool output. Agent writes cite one to three exact source quotes of at most 400
characters; the host validates source ownership and quote membership. This
proves provenance, not the truth of an extracted conclusion. Assistant-only
evidence and proposed corrections remain suggestions until accepted; preferences
require a user source. `memory_suggest` is the agent's correction path for
user-authored or pinned notes. Temporary-child inputs are conservatively treated
as agent evidence, not proof of a human preference. The active tools are `memory_list`, `memory_search`,
`memory_get`, `memory_save`, `memory_suggest` and `memory_forget`;
`memory_read` remains a listing alias and `memory_update` reports its retirement.
Listing is a paginated index without note bodies (default 20, maximum 50 entries
per scope). `memory_get` accepts `scope:"own"|"inherited"`; inherited reads are
available only to a child and resolve to its read-only root-bot memory.

Each scope allows 200 active notes and 100 suggestions, with 100-character titles
and 1,200-character bodies. Selected context is capped at 8,000 characters across
own and inherited notes. History, operation receipts and forget tombstones are
retained separately; forgetting is not erasure of those records or source
conversations. Background apply rechecks memory revisions and forget fences.
Memory maintenance and model-context compaction are separate operations;
the pre-compaction hook schedules review but does not wait for extraction.
`recall_history` still reads the caller's archive.
See [context and memory](context-memory.md) for API details, recovery, verification
boundaries and the Hermes, OpenClaw and Meta Muse sources informing this design.
