# Global tasks

## Product boundary
A task is a first-class owner-scoped unit of work, not a bot, a temporary subagent, or a run. Tasks have their own persistent chat, transcript, run history, status, and assigned named bot. A task can have several runs and messages over its lifetime. The bot's ordinary conversation remains separate.

Tasks are standalone in the first version. Keep an optional nullable project/group reference as a future extension point, but do not expose project management yet.

## Actors and creation
- The owner can always create a task.
- A named bot can create tasks only when the owner has enabled its explicit `allowTaskCreation` permission. Do not infer this from `allowNamedAgents`.
- The console checks task creation by default for new bots. Existing permissions remain unchanged. An allowed bot hands substantial multi-step work to a task and finishes a brief handoff; short answers may stay in ordinary chat. A task executes its own assignment without recursively handing it off.
- New tasks are assigned to a named bot. A bot-created task defaults to its own bot; owner-created tasks select the responsible bot.
- Task creation accepts `startImmediately?: boolean`, default `true`. `false` records a pending task without submitting work. Starting a pending task is explicit and idempotent.
- Bot-initiated creation must validate current bot permission server-side and derive source bot/run identity from the active host invocation, never from model-provided identity.

## Execution and computer ownership
- Each task runs in an independent durable conversation/runtime, with its own messages and runs.
- New tasks own an isolated computer/workspace. Tasks of the same named bot can run alongside each other and its main conversation. Inline subagents share their calling task's computer. Logical bot permissions and Keychain grants remain unchanged.
- On first use, the computer copies the creating task's last durable checkpoint (when applicable), otherwise the named bot's checkpoint, into its own immutable R2 object. Uncheckpointed source changes and running processes are not copied. Dependencies excluded by checkpoints must be reinstalled locally; project/package installation remains allowed. Task files do not automatically merge back into another workspace; use the repository's normal git workflow. Continue reuses the same task computer.
- Existing previously admitted tasks retain their shared computer to preserve in-flight work and files. Never-started queued/pending tasks migrate automatically behind a durable preparation fence. Unknown preparation outcomes retry metadata only; no prior command is replayed.
- The task uses the assigned bot's current host policy; task creation does not grant computer permissions. Every computer mutation continues through normal host approvals/policy.
- Each isolated task has its own fenced computer lease (`task:<taskId>`). Legacy shared tasks retain the named bot resource lease. For the latter, a durable per-bot lease in WorkspaceDO fences task starts, ordinary bot admissions, delegated bot inputs, and direct computer mutations. Ready tasks are FIFO queued intents; DO alarms reconcile holder runs and managed processes, then wake the next task without relying on browser polling. If the shared computer is occupied, ordinary computer-capable bot inputs retain their original operation ID and text in BotDO’s bounded durable backlog; execution admission acquires an `@bot` lease only immediately before Pi. Task-enabled main chat can instead enter the computerless coordinator mode described below while a task holds that lease. Expected contention wakes through Lifecycle without consuming transport attempts. Owner direct mutations have a separate bounded durable intent queue and return an explicit 202 queued receipt; they do not execute until an exact computer lease is acquired. Task starts remain queued. Task follow-ups are accepted only by that task's active conversation.
- Stopping a task fences only that task's work, not the bot's general conversation or other tasks. A task's terminal status must not be overwritten by a later message; an explicit continue of a completed or failed task creates a fresh run under the same task. Cancelled tasks keep their permanent Stop fence and cannot be continued in this version; create a new task instead.

## Owner API / data
WorkspaceDO is the owner-scoped authoritative task registry and scheduler, so task list reads are passive and do not start computers or inference. Task creation is idempotent with a stable operation ID. A task start's durable task row is its queue intent; a fenced per-computer lease (random token plus monotonically increasing generation) is installed before any cross-DO dispatch. Workspace alarms reconcile BotDO run and managed-process state after eviction, preserve uncertain leases, and only release after a confirmed terminal run with no active processes. Direct computer-action receipts are journal-reconciled by replaying the same operation ID (or polling an execution process) and never replaying an unsafe effect. Task metadata includes ID, title, description, assigned bot ID/name, creator, status, auto-start selection, server-owned `computerMode` (`isolated` or legacy `shared`), created/updated timestamps, and optional safe last-activity summary. Task conversation state and run/event receipts live in a separately keyed durable execution object, never in the assigned bot's main transcript.

Global endpoints support listing, creation, details, explicit start/continue, and cancellation. Reassignment, owner deletion and task list pagination are not available in this version. Task message, run, cancellation, and event-stream endpoints are task-scoped and reuse the existing durable conversation semantics. Auth and owner membership checks apply throughout. Deletion/cancellation must fence the task before cleanup; do not delete the assigned bot or its computer.

## Console
The main Bots/Tasks pill switches the same sidebar on phones and desktops, retaining Timber's brand, Settings and navigation. Both lists share header, search, avatar and row styles. Task rows show their title, the assigned bot's avatar and model, a one-line preview and a subtle status in the same position as bot activity. Assigned-bot metadata and dates remain in Task details. Status filters for all/active/pending/completed open from the filter icon inside search, without adding a permanent filter row; choosing a filter closes the popover and its selection survives view switches. New Task opens a form for title, description, assigned bot and an override to start immediately (checked by default). Opening a task mounts the same conversation and composer components as ordinary bot chat: messages, command activity, approvals and failures share the timeline, typography, spacing and controls. Its compact status occupies the existing conversation-header status area. Description, assigned bot, dates, refresh and pending Start are behind the Task details button. Model settings use the assigned bot's configuration; memory/context, approvals, agent conversations, secure-input requests and connection callbacks target the independent task runtime. Messages and activity use bounded archive pages and live updates; older pages prepend without replacing recent activity. Hidden task views stop background reads and fence stale callbacks. Task messages never render as owner messages in a bot's regular conversation. The task header's computer button opens its scoped desktop; closing it only releases viewing/control. Task details identify isolated versus legacy shared computers.

Bot-created task state changes arrive as durable, idempotent `task.updated` notifications in the originating conversation. One linked status pill per task remains anchored to its source request; its tools stay in the dedicated task. The terminal result returns as an attributed assistant message without running another model or reopening stopped work. Tasks remember optional `sourceTaskId` for nested origins and a monotonic `statusVersion` so delayed snapshots cannot reverse a newer status.

When an active legacy task owns the shared computer, the allowed bot can answer new main-chat messages in a durable coordinator turn. This turn can inspect metadata or create tasks; computer and service effects are refused before execution. It neither holds nor releases the task lease. Stopping the coordinator does not stop the independent task. Ordinary computer work continues to require the exclusive fenced lease.

## Status vocabulary
Use explicit task states: `pending` (not started), `queued` (waiting for its execution admission; legacy tasks may wait for the shared computer), `running`, `waiting_approval`, `waiting_connection`, `cancelling`, `completed`, `failed`, `cancelled`. Cancellation remains in `cancelling` until run/process termination is confirmed. `blocked` can be added when the product has a concrete blocker model; do not infer it from arbitrary text.

## Explicit continuation and direct intent safety

`POST /v1/tasks/:id/continue {operationId,text,attachments?,mentions?}` accepts explicit new instructions
only for completed or failed tasks. The durable operation receipt deduplicates
that request, while the scheduler uses a newly generated native operation ID in
the same task conversation. Neither `task-start:<id>` nor a prior computer action
is replayed. Cancellation and late child reports never implicitly reopen tasks.

Busy owner computer mutations return `202 {operationId,status:"queued",accepted:true}`.
The exact validated action and original operation ID are stored before receipt;
32 pending intents per bot are allowed. `GET /v1/bots/:id/computer/queued-actions`
shows pending, claimed, settled, or cancelled intentions and available receipts.
`POST /v1/bots/:id/computer/queued-actions/:operationId/cancel` fences a pending
intent permanently. Once claimed, cancel returns `action_already_claimed`; inspect
the original action receipt or explicitly cancel its managed process. Dispatch
uses the existing ComputerDO effect journal under the same operation ID. A lost
transport never authorizes blind unsafe replay, and a queued request does not
approve any stored model approval. Interactive desktop control blocks dispatch.
Confirmed pre-effect rejection plus authoritative no-activity observation can
release only its exact token/generation; uncertain errors keep the lease held.

Before any direct effect is journaled, BotDO validates and durably pins the exact WorkspaceDO lease. That pin prevents replacement or release through asynchronous dispatch. Confirmed journal receipts or pre-effect rejections clear it; uncertain errors retain it. Recovery reuses the saved exact action/operation ID, including owner polls and manual GUI assistance while an ordinary bot waits for approval. Native-input admission reconciliation never treats a direct-effect pin as an unadmitted message.
