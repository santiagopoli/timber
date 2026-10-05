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
- POST /v1/bots {name,instructions?,model?} -> 201 {bot:Bot}
- GET /v1/bots/:id -> {bot:Bot}
- PATCH /v1/bots/:id {name?,instructions?} -> {bot:Bot}
- GET /v1/bots/:id/messages -> {messages:Message[]}
- POST /v1/bots/:id/messages {text,operationId} -> 202 {run:Run}
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
- GET /v1/bots/:id/computer -> {computer:ComputerStatus}
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

Computer actions from the model pass through host policy. Shell execution requires
approval by default; read/list/screenshot can run without approval. Browser navigation,
click/type/key/scroll also require explicit approval in initial secure MVP; the console
can directly invoke actions as the human. User action approvals are persisted; do not
keep an unbounded promise waiting for approval. The runtime returns a pending-approval
result and resumes with the decision after user input. No automatically replayed exec.

## Storage / lifecycle
Workspace path /workspace, one writer via ComputerDO. Root package/tool image version
pinned. Backend stores artifacts and directory archive in R2, metadata in DO. Unsafe
in-progress operations after restart are interrupted; completed results deduplicated.
No container per tool call. Stop only after true inactivity. Mark checkpoints durable
only after successful upload; don't claim full live-volume persistence.

## Delegation
Not implemented in this milestone. Future send_to_bot should use bounded
asynchronous task submission with source bot/run id,
deduplicated operation id and depth cap. Bot identity preserved, all target ids checked
in registry. Can be followup if other core loop critical paths aren't yet complete,
but document explicitly instead of a fake tool.
