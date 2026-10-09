# Context, history and memory

Timber keeps three separate records: the full conversation archive, the smaller
context sent to the model, and durable memory. Compaction changes model context;
it does not delete messages, tool results, operation receipts or memories, and
does not execute old tools again. A compaction summary is working context, not
evidence from which to manufacture durable facts.

## Memory is an application service

`packages/memory` owns durable records in the bot's SQLite-backed Durable Object.
The HTTP API, console and agent tools use the same service. Memory does not depend
on a running computer, a filesystem checkpoint, or Pi's active context. Pi owns
execution and compaction; it is a client of the memory service.

Each memory has an ID, a short title, readable content and a category:
`preference`, `fact`, `decision` or `procedure`. Records carry their revision,
timestamps, author class, state, pinned flag and source references. Sources can
identify the original conversation message and its supporting quote. A source ID
is a reference, not an authorization grant. Agent writes require one to three
exact quotes of at most 400 characters from the caller's original messages;
the host checks message identity, conversation ownership and quote membership.
User edits instead record the user as their source. Quote validation establishes
provenance, not that the model's interpretation of a quote is correct.

The store distinguishes active entries, suggestions and forgotten entries.
Changes are individual record operations, rather than replacement of an entire
notes document. Revisions protect concurrent edits; operation IDs deduplicate
retried mutations. Revision history makes accepted changes inspectable.

The old freeform notes are retained as a legacy snapshot during migration.
Legacy text stays inspectable but is excluded from model context and is not
automatically promoted to active memories. The console can export this snapshot.
The compatibility import preserves the old Pi document once in the independent
store; it preserves the original text instead of rewriting it. Whole-document
writes are retired.

## Scope and recall

A named bot owns its memory namespace. A temporary child can modify only its own
namespace and can read inherited root-bot memory. It cannot write parent or
sibling memory. The host supplies the caller's namespace; model-provided record
IDs never select an arbitrary bot's storage.

Memory context has a separate budget. Active, selected notes provide continuity;
the complete store stays accessible through memory search and exact reads.
Selection prioritizes pinned notes, query matches and preferences, includes only
whole notes, and uses remaining space for an index of up to 12 other titles.
Suggestions, forgotten entries and legacy notes do not become background
instructions. Memory is reference data: it never grants permission, replaces
the current user request, or turns quoted external instructions into policy.

Search is a bounded retrieval operation with explicit hits, result counts and a
truncation signal. The first implementation uses deterministic text ranking;
it does not claim semantic retrieval or require a new embedding provider. The
full conversation archive remains a separate source for exact historical recall.

Agent tools are `memory_list` (`memory_read` is a compatibility alias),
`memory_search`, `memory_get`, `memory_save`, `memory_suggest` and
`memory_forget`. Listing returns a paginated index of titles and metadata, without
note bodies or legacy text; it accepts `offset` and `limit` (20 by default, at
most 50) and returns `nextOffset`. `memory_get` reads the caller's own namespace
by default; children can select `scope: "inherited"` for a read-only parent note.
Inherited scope is host-resolved, not an arbitrary bot ID. `memory_update` returns
an error explaining that whole-document replacement is retired.

## Automatic maintenance and review

Memory maintenance uses original user messages and assistant final responses as
evidence. Compaction summaries, system scaffolding, collaboration envelopes,
assistant progress and raw tool output are excluded. The extraction prompt asks
for stable preferences, durable facts, decisions and reusable procedures, and
excludes one-off task progress and transient errors. The store rejects recognizable
logs, structured dumps and credential patterns; these checks are not a guarantee
against every poor or sensitive note.

A review is separate from the user's reply and does not repeat computer actions.
Pi schedules a background task on agent yield and before compaction. The
compaction hook schedules review without waiting for its result: it is not a
promise that extraction completes before summarization. Original history remains
available independently. Each scan reads at most 24 archive entries. A model
batch uses up to 24,000 characters of evidence and requests at most 12 candidates
from the conversation's configured model, with no tools exposed. Longer messages
continue in subsequent batches with a small overlap; a durable backlog and cursor
preserve the remaining evidence. Review records its status, examined-message
count, additions, suggestions and whether
more evidence remains. A failed review preserves existing memory and reports a
failure; it does not turn the user's successful task into a failed task.

Automatic corrections are suggestions. They identify the entry they propose to
replace and require explicit acceptance before replacing active knowledge. User
edits and forgotten records remain respected when a review finishes after the
user has changed memory: the apply transaction rechecks the memory revision.
Assistant-only evidence also produces suggestions; preferences require an
original user source. Temporary-child inputs are conservatively classified as
agent evidence because their native user-role messages do not establish human
authorship; children can propose facts but cannot create confirmed user
preferences from those messages. Direct agent saves cannot overwrite
user-authored or pinned notes; `memory_suggest` provides the correction path.
Background corrections with known source ordering are discarded when their
evidence is no newer than the target note's evidence.

Forgetting records a tombstone that blocks automatic re-additions with matching
normalized text or shared source message IDs. User corrections preserve the old
assertion's fence too. The user can explicitly save a fact again. Forgetting is
not data erasure: the source conversation and memory revision history remain.

This is bounded maintenance, not unlimited autonomous reflection. A scope holds
up to 200 active notes and 100 suggestions. Each note allows a 100-character title
and 1,200-character body; injected memory is bounded to 8,000 characters across
own and inherited notes. `GET /memory` reports the entry and context limits.
History, receipts and tombstones are retained separately from those active-entry
limits. The UI exposes entries, sources, edits, suggestions and legacy content rather than
presenting an opaque model-generated blob as memory.

## Native Pi compaction

Timber uses `@earendil-works/pi-durable` 1.0.3's built-in `CompactionTask`.
Automatic threshold and overflow compaction use Pi's native policy: 16,384 reserve
tokens, 20,000 recent tokens and a 32,768-token background margin. The selected
model's account capability supplies the context window. Pi selects the old
prefix, preserves tool call/result pairs, requests a structured summary, records
usage, and applies the summary through its durable conversation writer.

**Context → Compact now** submits that native task. Compaction can run while the
conversation is idle without a new user message. Short histories can return
`unchanged`, meaning there was no older prefix to summarize; a summary superseded
by newer context also finishes `unchanged`. A provider failure leaves the archive
intact. Native checkpoints and the lifecycle scheduler recover unfinished work
after eviction.

Timber reads the immutable native entry archive for public runtime transcripts.
Pi's `PiHarness.messages()` returns only active context and is deliberately not
used for full-history retrieval. Internal compaction summaries are not rendered
as user messages. The public conversation endpoint returns a bounded recent page;
stored older messages remain retained. `recall_history` searches bounded pages of
the calling conversation's public archive.

A compaction receipt contains `id`, `reason` (`manual`, `threshold`, `overflow`),
`status` (`running`, `completed`, `unchanged`, `failed`, `cancelled`) and
`summaryApplied`. Repeating a manual operation ID returns the same native task
receipt. Changing its instructions returns `409 compaction_conflict`. Token counts
are estimates, not billed usage. Context status reports the last 20 receipts.

## Authenticated API

All paths are relative to `/v1/bots/:botId` and require normal owner and bot
membership checks. Scope, authorship, state and source provenance are resolved
server-side; accepting model- or client-supplied ownership metadata is not part
of the write contract.

| Method and path | Request | Result |
| --- | --- | --- |
| `GET /memory` | — | `{memory}` with entries, suggestions, optional legacy snapshot, limits and review status |
| `GET /memory/search` | `q` up to 200 characters; optional `limit` from 1 to 50 | `{results: {hits, total, truncated}}` |
| `GET /memory/entries/:id` | — | `{entry}` |
| `GET /memory/entries/:id/history` | — | `{history}` |
| `POST /memory/entries` | `{operationId, category, title, content, pinned?}` | `201 {result: {entry, changed}}` |
| `PATCH /memory/entries/:id` | `{operationId, expectedRevision, category, title, content, pinned?}` | `{result: {entry, changed}}` |
| `DELETE /memory/entries/:id` | `{operationId, expectedRevision}` | `{result: {entry, changed}}` |
| `POST /memory/entries/:id/accept` | `{operationId, expectedRevision, replacesRevision?}` | `{result: {entry, changed}}` |
| `POST /memory/review` | `{operationId}` | `202 {review}` |
| `PUT /memory` | Retired whole-document write | `409 memory_upgrade_required` |
| `GET /context` | — | `{context: {automatic, estimatedTokens, activeEntries, contextWindow, historyRetained, compactions}}` |
| `POST /context/compact` | `{operationId, instructions?}` | `202 {compaction}` |

`BotMemory.schemaVersion` is `2`. Its `content` field is a read-only text export
for older clients, not a whole-document mutation surface. A stale edit is a
conflict and cannot silently overwrite a newer user or agent change. Replacement
acceptance also checks the current revision of the entry being replaced.

The public TypeScript contract lives in `packages/contracts/src/memory.ts`.
Record revisions, mutation operation IDs and source message IDs serve different
purposes and are not interchangeable.

A second manual review with a different operation ID while one is queued or
running returns `409 memory_review_busy`. Reusing the same operation ID returns
its existing review receipt. Mutation conflicts return `409 memory_conflict`,
unknown entries `404 memory_not_found`, invalid note data `400 invalid_memory`,
and a full note/suggestion store `422 memory_limit`. A new review operation ID
retries after a failed review; reusing the old ID retrieves that failure.

## Prior art and design choices

These systems informed the boundaries; Timber does not reproduce their entire
memory engines.

### Hermes

Reviewed source at commit
[`46d7718a52ff33accb15dc0501736fbdb6833cab`](https://github.com/NousResearch/hermes-agent/tree/46d7718a52ff33accb15dc0501736fbdb6833cab):

- [`agent/memory_provider.py`](https://github.com/NousResearch/hermes-agent/blob/46d7718a52ff33accb15dc0501736fbdb6833cab/agent/memory_provider.py)
  defines a provider interface with turn synchronization, pre-compression,
  session-switch and delegation hooks. Memory is a service, not just a prompt.
- [`tools/memory_tool_store.py`](https://github.com/NousResearch/hermes-agent/blob/46d7718a52ff33accb15dc0501736fbdb6833cab/tools/memory_tool_store.py)
  separates bounded `MEMORY.md` and `USER.md` and implements entry-level
  add/replace/remove. Exact duplicates are no-ops; ambiguous replacements fail.
  Timber uses stable IDs and revisions instead of matching text to replace.
- [`agent/background_review.py`](https://github.com/NousResearch/hermes-agent/blob/46d7718a52ff33accb15dc0501736fbdb6833cab/agent/background_review.py)
  runs an isolated, bounded review with restricted tools. Automatic replace/remove
  proposals are staged by
  [`tools/memory_tool.py`](https://github.com/NousResearch/hermes-agent/blob/46d7718a52ff33accb15dc0501736fbdb6833cab/tools/memory_tool.py).
- [`agent/conversation_compression.py`](https://github.com/NousResearch/hermes-agent/blob/46d7718a52ff33accb15dc0501736fbdb6833cab/agent/conversation_compression.py)
  builds direct evidence from original user/assistant prose, excluding summaries,
  system messages and tool output. Continuity and durable facts are distinct.

### OpenClaw

Reviewed source at commit
[`8899f3b8dae5e3a9b5e8a25597fa8a19d56b6989`](https://github.com/openclaw/openclaw/tree/8899f3b8dae5e3a9b5e8a25597fa8a19d56b6989):

- [`Memory architecture`](https://github.com/openclaw/openclaw/blob/8899f3b8dae5e3a9b5e8a25597fa8a19d56b6989/docs/concepts/memory-architecture.md)
  separates curated preferences/facts, episodic notes/transcripts and review
  surfaces. Provenance and eligibility are independent of recalled prose.
- [`Memory provider types`](https://github.com/openclaw/openclaw/blob/8899f3b8dae5e3a9b5e8a25597fa8a19d56b6989/src/plugins/memory-provider-types.ts)
  and [`gateway API`](https://github.com/openclaw/openclaw/blob/8899f3b8dae5e3a9b5e8a25597fa8a19d56b6989/src/gateway/server-methods/memory-provider.ts)
  expose search, bounded exact reads and health through a caller-bound provider.
  References carry identity and revision; authority comes from the host.
- [`Consolidation`](https://github.com/openclaw/openclaw/blob/8899f3b8dae5e3a9b5e8a25597fa8a19d56b6989/extensions/memory-core/src/dreaming-consolidation.ts)
  requests structured add/merge/supersede operations, constructs text from source
  evidence, and validates replacements. Its
  [`eligibility gate`](https://github.com/openclaw/openclaw/blob/8899f3b8dae5e3a9b5e8a25597fa8a19d56b6989/extensions/memory-core/src/dreaming-consolidation-candidates.ts)
  excludes untrusted/system origins. Timber borrows grounded, bounded changes;
  it does not implement OpenClaw's complete dreaming pipeline.
- [`Pre-compaction flush`](https://github.com/openclaw/openclaw/blob/8899f3b8dae5e3a9b5e8a25597fa8a19d56b6989/src/auto-reply/reply/memory-flush-session.ts)
  uses a detached conversation view and a stable per-cycle identity. Housekeeping
  does not become ordinary conversation history.
- [`Deletion and provenance`](https://github.com/openclaw/openclaw/blob/8899f3b8dae5e3a9b5e8a25597fa8a19d56b6989/docs/concepts/memory-provenance.md)
  distinguish forgetting derived memory from deleting original transcripts.
  Tombstones prevent re-ingestion from undoing a forget operation.

### Meta Muse

Meta's public sources describe two distinct products; their mechanisms should
not be conflated:

- [Muse personal architecture](https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse)
  describes durable application data in Postgres, separate from the agent runtime
  cell within the user's VM,
  and memory files the user can inspect, edit and download. It does not publish
  an extraction algorithm or memory API implementation, so there is no source
  commit to pin for those internals.
- [Muse Code configuration](https://dev.meta.ai/docs/muse-code/configuration)
  describes a `MEMORY.md` index, individual topic files, separate personal/project
  scopes and on-demand reading. Its startup context includes the index and paths
  for up to 48 files, not every note's full contents.
- [Muse Code observers](https://dev.meta.ai/docs/muse-code/extending)
  can propose recall; a reconciler decides what enters the main context. The
  [changelog](https://dev.meta.ai/docs/muse-code/changelog) documents version- and
  model-dependent defaults, so not every Muse turn necessarily runs an observer.

Timber's corresponding choices are inspectable records, bounded context,
explicit retrieval and scope enforcement. Topic files, observers and Postgres
are not requirements for Timber's Cloudflare implementation.

## Verification boundaries

Storage and API tests must cover owner/child isolation, revision conflicts,
idempotent replay, evidence validation, forgetting, legacy preservation and
recovery. Runtime tests use Pi's real scheduler and storage with deterministic
model transport; browser tests exercise the console against fixtures. These
checks establish behavior, not real-model extraction quality. Deployment and
any real-model quality check must be reported separately from fixture tests.
