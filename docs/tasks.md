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
- Tasks assigned to different bots can work in parallel. Since tasks for one bot share one writable computer, execution must be serialized per bot (at most one task actively dispatches computer work at a time); other ready tasks remain queued. User chat can still be durably accepted as steering/follow-up input.
- Stopping a task fences only that task's work, not the bot's general conversation or other tasks. A task's terminal status must not be overwritten by a later message; an explicit restart/continue creates a new run under the same task.

## Owner API / data
WorkspaceDO is the owner-scoped authoritative task registry, so task list reads are passive and do not start computers or inference. Task creation is idempotent with a stable operation ID. Task metadata includes ID, title, description, assigned bot ID/name, creator, status, auto-start selection, created/updated timestamps, and optional safe last-activity summary. Task conversation state and run/event receipts live in a separately keyed durable execution object, never in the assigned bot's main transcript.

Global endpoints should support listing, creation, details, update/assignment, explicit start, and deletion/cancellation. Task message, run, cancellation, and event-stream endpoints are task-scoped and reuse the existing durable conversation semantics. Auth and owner membership checks apply throughout. Deletion/cancellation must fence the task before cleanup; do not delete the assigned bot or its computer.

## Console
Add a global Tasks destination outside the bot list. The task list shows status, title, assigned bot and last activity, with filters for active/pending/completed. New Task opens a form for title, description, assigned bot and an override to start immediately (checked by default). Opening a task shows its dedicated chat, activity/status and an explicit stop/continue control. Task messages and statuses never render as messages authored by the owner in a bot's regular conversation.

## Status vocabulary
Use explicit task states: `pending` (not started), `queued` (waiting for the assigned bot's computer slot), `running`, `waiting_approval`, `waiting_connection`, `completed`, `failed`, `cancelled`. `blocked` can be added when the product has a concrete blocker model; do not infer it from arbitrary text.
