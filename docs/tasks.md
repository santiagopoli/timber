# Global tasks

## Product boundary
A task is a first-class owner-scoped unit of work, not a bot, a temporary subagent, or a run. Tasks have their own persistent chat, transcript, run history, status, and assigned named bot. A task can have several runs and messages over its lifetime. The bot's ordinary conversation remains separate.

Tasks are standalone in the first version. Keep an optional nullable project/group reference as a future extension point, but do not expose project management yet.

## Actors and creation
- The owner can always create a task.
- A named bot can create tasks only when the owner has enabled its explicit `allowTaskCreation` permission. Do not infer this from `allowNamedAgents`.
- New tasks are assigned to a named bot. A bot-created task defaults to its own bot; owner-created tasks select the responsible bot.
- Task creation accepts `startImmediately?: boolean`, default `true`. `false` records a pending task without submitting work. Starting a pending task is explicit and idempotent.
- Bot-initiated creation must validate current bot permission server-side and derive source bot/run identity from the active host invocation, never from model-provided identity.

## Execution and computer ownership
- Each task runs in an independent durable conversation/runtime, with its own messages and runs.
- A task uses its assigned bot's existing computer/workspace. It does not create a second computer or inherit another bot's computer.
- The task uses the assigned bot's current host policy; task creation does not grant computer permissions. Every computer mutation continues through normal host approvals/policy.
- Tasks assigned to different bots can work in parallel. A durable per-bot lease in WorkspaceDO fences task starts, ordinary bot admissions, delegated bot inputs, and direct computer mutations. Ready tasks are FIFO queued intents; DO alarms reconcile holder runs and managed processes, then wake the next task without relying on browser polling. If the shared computer is occupied, ordinary bot inputs retain their original operation ID and text in BotDO’s bounded durable backlog; admission acquires an `@bot` execution lease only immediately before Pi. Expected contention wakes through Lifecycle without consuming transport attempts. Owner direct mutations have a separate bounded durable intent queue and return an explicit 202 queued receipt; they do not execute until an exact computer lease is acquired. Task starts remain queued. Task follow-ups are accepted only by that task's active conversation.
- Stopping a task fences only that task's work, not the bot's general conversation or other tasks. A task's terminal status must not be overwritten by a later message; an explicit continue of a completed or failed task creates a fresh run under the same task. Cancelled tasks keep their permanent Stop fence and cannot be continued in this version; create a new task instead.

## Owner API / data
WorkspaceDO is the owner-scoped authoritative task registry and scheduler, so task list reads are passive and do not start computers or inference. Task creation is idempotent with a stable operation ID. A task start's durable task row is its queue intent; a fenced per-bot lease (random token plus monotonically increasing generation) is installed before any cross-DO dispatch. Workspace alarms reconcile BotDO run and managed-process state after eviction, preserve uncertain leases, and only release after a confirmed terminal run with no active processes. Direct computer-action receipts are journal-reconciled by replaying the same operation ID (or polling an execution process) and never replaying an unsafe effect. Task metadata includes ID, title, description, assigned bot ID/name, creator, status, auto-start selection, created/updated timestamps, and optional safe last-activity summary. Task conversation state and run/event receipts live in a separately keyed durable execution object, never in the assigned bot's main transcript.

Global endpoints should support listing, creation, details, update/assignment, explicit start, and deletion/cancellation. Task message, run, cancellation, and event-stream endpoints are task-scoped and reuse the existing durable conversation semantics. Auth and owner membership checks apply throughout. Deletion/cancellation must fence the task before cleanup; do not delete the assigned bot or its computer.

## Console
Add a global Tasks destination outside the bot list. The task list shows status, title, assigned bot and last activity, with filters for active/pending/completed. New Task opens a form for title, description, assigned bot and an override to start immediately (checked by default). Opening a task shows its dedicated chat, activity/status and an explicit stop/continue control. Task messages and statuses never render as messages authored by the owner in a bot's regular conversation.

## Status vocabulary
Use explicit task states: `pending` (not started), `queued` (waiting for the assigned bot's computer slot), `running`, `waiting_approval`, `waiting_connection`, `cancelling`, `completed`, `failed`, `cancelled`. Cancellation remains in `cancelling` until run/process termination is confirmed. `blocked` can be added when the product has a concrete blocker model; do not infer it from arbitrary text.

## Explicit continuation and direct intent safety

`POST /v1/tasks/:id/continue {operationId,text}` accepts explicit new instructions
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
