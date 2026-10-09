# Context compaction and durable memory

Timber keeps three separate records: the full conversation archive, the smaller
context sent to the model, and editable durable notes. Compaction changes the
model context; it does not delete the conversation, tool results or operation
receipts, and does not execute old tools again.

## Native Pi compaction

Timber uses `@earendil-works/pi-durable` 1.0.3's built-in `CompactionTask`.
Automatic threshold and overflow compaction are enabled with Pi's native policy:
16,384 reserve tokens, 20,000 recent tokens and a 32,768-token background margin.
The selected model's account capability supplies the context window. Pi selects
the old prefix, preserves tool call/result pairs, requests a structured summary,
records usage, and applies the summary through its durable conversation writer.
The summary retains goals, constraints, progress, decisions, next steps and exact
technical references; the recent conversation remains verbatim.

The console's **Context → Compact now** submits that same native task. Compaction
can run while the conversation is idle and does not need a new user message.
Short histories can return `unchanged`, meaning there was no older prefix to
summarize; a summary superseded by newer context also finishes `unchanged`.
A provider failure leaves the archive intact. Native checkpoints and
the existing lifecycle scheduler recover unfinished maintenance after eviction.

Timber reads the immutable native entry archive for public runtime transcripts.
Pi's `PiHarness.messages()` returns only active context and is deliberately not
used for full-history retrieval. Internal compaction summaries are not rendered
as user messages. The public conversation endpoint returns a bounded recent page plus `nextCursor`;
clients can read every older public message with stable cursor pages, without
changing the model context or rerunning work. Stored older messages remain retained. The `recall_history`
tool searches bounded pages of the calling conversation's public archive.

## Durable notes

Each bot has up to 16,000 characters of curated notes stored in Pi's durable
document storage, independently of its computer and conversation compactions.
Notes are included in the system section for each generation. The bot can use
`memory_read` and `memory_update` to maintain stable preferences, verified facts
and decisions. The user can edit the same notes through **Context → Durable
notes**. Writes require the current revision, and conflicting saves preserve the
user's draft. A successful tool write and its replay receipt commit atomically.

Each temporary child has its own isolated notes. It inherits the root bot's notes
as read-only prompt context; its tools can modify only its own notes. Sibling
notes and conversation archives are not accessible through these tools. Named
bots likewise have separate storage. Notes do not grant authorization and should
not contain credentials or transient tool output.

Memory maintenance is proactive model tool use. Timber does not add a second
hidden memory-flush conversation or repeatedly resubmit the original task.
Native context summarization handles automatic continuity even when the model
does not choose to update curated notes.

## Authenticated API

All paths below are relative to `/v1/bots/:botId` and require normal owner and bot
membership checks.

| Method and path | Request | Result |
| --- | --- | --- |
| `GET /messages` | `?limit=500&before=<cursor>` | `{messages, nextCursor}`; chronological within each page |
| `GET /context` | — | `{context: {automatic, estimatedTokens, activeEntries, contextWindow, historyRetained, compactions}}` |
| `POST /context/compact` | `{operationId, instructions?}` | `202 {compaction}` |
| `GET /memory` | — | `{memory: {content, revision, updatedAt?, maxCharacters}}` |
| `PUT /memory` | `{content, revision}` | Updated `{memory}`; `409 memory_conflict` for a stale revision |

A compaction receipt contains `id`, `reason` (`manual`, `threshold`, `overflow`),
`status` (`running`, `completed`, `unchanged`, `failed`, `cancelled`) and
`summaryApplied`. Repeating the same manual operation ID returns the same native
task receipt. Changing its instructions returns `409 compaction_conflict`.
`GET /context` reports **every** root-conversation compaction, newest native task
first, including manual, threshold and overflow maintenance. IDs remain stable
through running/terminal updates and reload; compaction never becomes an ordinary
user message. Each receipt also includes `historyRetained:true` and only recorded,
allowlisted display metadata:

- `createdAt`: admission time of new manual requests, persisted atomically with
  their native task. This is absent for older/manual and automatic tasks.
- `startedAt`: native range-selection hook time for new manual/automatic work;
  first-writer-wins persistence preserves it through retries and recovery.
- `summaryCreatedAt`: timestamp stored in the native applied summary entry,
  including historical compactions. This is summary creation time, **not** an
  invented completion time.
- `firstKeptEntryId`: the actual native entry boundary retained verbatim, from
  the summary entry or recorded range selection.
- `summarizedEntries` and `estimatedTokensBefore`: the selected prefix entry
  count and token estimate recorded at range selection. The estimate covers only
  that selected prefix, not the entire conversation, and is not billed usage.

Unavailable historical metadata is omitted, never replaced with the current time,
zero counters or fictional savings. Raw instructions, internal summaries, reasoning,
system prompts, native checkpoints and provider errors are never included.
Historical failed/unchanged/cancelled tasks without any recorded time remain in
the complete receipt list with their stable ID and actual outcome.

`GET /messages` keeps the backward-compatible 500-message default and supports
`limit` integers 1..500 and `before`, a positive safe integer rowid cursor. It
returns `{messages,nextCursor}` with chronological messages inside each page;
`nextCursor:null` means all older public messages have been read. Pass a returned
cursor unchanged to read the next older page. Cursor pagination does not use
OFFSET or timestamps, so new messages and equal dates cannot shift older pages.
Invalid bounds/cursors return 400. Pages use only the owner's selected bot's
public projection; internal native summaries and private reasoning are excluded.
The HTTP archive is the durable host `messages` projection: admitted user inputs,
public assistant progress and final answers, with host IDs, attachments, provenance
and run attribution. Those records persist before and after compaction; pagination
removes the old last-500 visibility limit. This route is deliberately not a raw
native-entry export. Native-only bookkeeping, test-seeded entries, reasoning,
private tool payloads and context summary entries do not become new HTTP messages.
The runtime's separate immutable native archive and `recall_history` remain intact.


## Prior art and sources

The design follows the distinction between compacted context, curated memory and
searchable transcripts used by existing agents, while retaining Pi as Timber's
execution and recovery engine:

- [Hermes memory documentation at 0670ba4](https://github.com/NousResearch/hermes-agent/blob/0670ba45240b734c1e6f6d1d5ead87233f37df49/website/docs/user-guide/features/memory.md):
  bounded `MEMORY.md` and `USER.md`, explicit memory tools and separately
  searchable session history. Hermes warns against multiple agents writing a
  shared memory profile; Timber uses isolated native conversation documents.
- [OpenClaw compaction at f023f0a](https://github.com/openclaw/openclaw/blob/f023f0a70443b6ca55432aff5d2a028e3d585d38/docs/concepts/compaction.md):
  automatic threshold/overflow handling and manual `/compact`, with retained
  transcripts and paired tool calls/results.
- [OpenClaw memory at f023f0a](https://github.com/openclaw/openclaw/blob/f023f0a70443b6ca55432aff5d2a028e3d585d38/docs/concepts/memory.md):
  curated memory and optional pre-compaction memory flush. Timber uses proactive
  durable memory tools rather than reproducing that separate flush loop.
- Local primary implementation: `node_modules/@earendil-works/pi-durable/dist/harness/compaction.js`,
  `harness/generation.js`, `harness/agent.js`, and `agents/harness/pi` 0.26.0.

## Verification

`tests/pi/context.integration.ts` exercises the production API, BotDO and native
Pi scheduler, storage and compaction; only the external model transport is a
deterministic fixture. Browser tests cover desktop/mobile editing, conflicting
revisions, retained drafts and transcript, and safe retries after an unconfirmed
manual submission. These local tests do not measure real-model summary quality
or claim a production deployment.
