# Agent runtime

`AgentRuntime` is the engine-neutral host contract. `createPiRuntime` is the first
adapter and installs Cloudflare Lifecycle on the owning plain Durable Object.
Use `onRequest`, not a competing custom `alarm`; Pi owns transcript, inbox, native
run recovery, and wake-up scheduling. The backend owns the product projection and
an outbox for admitting user inputs with stable operation IDs.

The default model is `gpt-6.1-sol` through the user's connected ChatGPT plan.
The host supplies `chatgpt: { fetch(request): Promise<Response>, models(): Promise<ModelCatalog> }`, which receives
only credential-free POST requests to `https://api.openai.com/v1/responses` and
injects OAuth in its separate authentication object. The runtime never reads
tokens or environment API keys. An absent connection or exhausted allowance
fails explicitly; there is no billed fallback. Explicit `@cf/` model IDs retain
Workers AI. Named bot instructions are rendered before every request. Pi and
Agents packages are pinned because the durable harness is beta.

The native Pi Responses adapter receives the active context (including summaries
after compaction), developer
instructions, `store:false`, `stream:true`, and functions under the
`timber_computer` namespace. Its parser preserves namespace and call identity
across tool results and restart. Screenshot pixels use image tool outputs. No
native hosted computer-use tool or ChatGPT `backend-api` endpoint is used.

Computer tools route through the host's permission callback. Stable tool
operation IDs survive replay. Reads are replay-safe; effects are unsafe. A
pending approval terminates the native tool round and persists a pause marker;
the provider boundary blocks further inference for that operation, including
mixed tool rounds. The approved result resumes through a new durable input.

Optional host `catalog()` and `call(request)` ports enable the native `list_tools`
and `call_tool` functions. The catalog supplies names, descriptions and JSON input
schemas. The host validates each call, owns MCP sessions, service credentials,
repository grants and effect deduplication; Pi receives none of those secrets.
Reusable instructions use the host's `load_skill` capability. Skills cannot grant
tool access. App previews use the same host boundary, so another runtime can reuse
these capabilities without importing Pi types.

A `pending_connection` result carries a request ID, provider, repository and
requested permission. It uses the same durable pause as approvals and stops all
remaining dispatch and inference for that native operation. Connecting a service
does not re-execute a tool inside Pi. The host submits a new durable continuation
only after validating current run state and access. Historical pause records do
not block fresh user submissions. Generic `call_tool` invocations are always
unsafe and sequential for crash recovery, including when the selected host tool
is a read; host operation IDs remain the authority for any effect reconciliation.

Task-count budgets are optional: `maxGenerations` and `maxToolCalls` default to
uncapped, and `null`/`0` also disable them. Positive safe integers configure an
independent cap without a hidden clamp. The API exposes them as Worker variables
`BOTSPACE_MAX_GENERATIONS` and `BOTSPACE_MAX_TOOL_CALLS`; malformed settings fail
explicitly. Accounting stays persistent even while uncapped, and enforcement
happens before provider/tool dispatch. Recovery reuses each logical task identity,
so an object restart or inference retry cannot reset or double-charge its budget.
These are host policy controls, not limits required by Pi Durable.

Individual operations retain up to two inference retries and bounded time/output.
Workers AI requests use at most 4096 output tokens. ChatGPT forbids `max_output_tokens`, so
its adapter aborts locally at 65,536 generated characters and the harness applies
a 120-second stream timeout. This is a local safety cap, not an exact token or
cost ceiling. Incomplete and truncated responses are failures, including usage
errors arriving after text has streamed. Text-only models receive an explicit error before a
model-initiated screenshot dispatch; direct human screenshot access is separate.

## Verification

```sh
npx vitest run --config packages/runtime/vitest.config.ts
```

These integration tests execute the real Pi harness, Cloudflare Lifecycle and
SQLite in workerd. Only the external Workers AI / ChatGPT inference transport is
a fixture. They cover named instructions and both streaming protocols, allowed
subscription request fields, credential isolation, namespaced tool and screenshot
roundtrips, input deduplication after a hard object restart, approval and connection pauses,
output limits, incomplete streams, usage failures, optional model-loop budgets,
and tasks exceeding the former count caps across a hard restart.

## Temporary agents

`spawn_subagent`, `list_subagents`, `send_subagent_message`, `wait_subagent` and
`cancel_subagent` use real Pi conversations. A native background anchor owns each
child, and native durable delivery tasks submit its work and report public answers
back through the host's `onSubagentMessage` callback. PiHarness schedules the child
session before admission; a separate lifecycle wake covers the gap before delivery.
Spawning and messaging are deduplicated in the same native transaction as their
delivery tasks. Each child has a fresh transcript and inherits the bot's model,
instructions and tools. Agents share the bot's computer and must coordinate writes.
Transient child admission and parent-report failures retry the same durable input
up to five attempts with 1/2/4/8-second backoff. Exhausted admission becomes a
visible failure; an exhausted report leaves the result in the child's conversation
and emits `subagent.report_failed`. Restarting never repeats a completed tool.

The host protocol exposes `subagents()`, `subagentMessages(id)`,
`sendSubagent(id,text,{operationId})` and `cancelSubagent(id)`. Normalized
`subagent.created`, `subagent.updated`, `subagent.message` and tool activity events
keep native payloads and reasoning private. Child tools carry `subagentId` and
`subagentOperationId` alongside the original parent `runOperationId`, so the host
can associate approvals, service connections and child runs without mixing their
transcripts. A child approval pauses only its native input; the host resumes that
child with a new durable input after the decision.

At most eight children may be active, including approval/connection waits, and
delegation is limited to three levels. Generation and tool accounting is shared
with the original parent task and survives eviction. A completed parent leaves
its children running. Explicit parent cancellation cancels its descendants;
cancelled children cannot restart. Completed or failed children can receive a new
message. Followups queue without replacing the attribution of an active child
tool. Children can message peers in the same task or address their parent with
`targetId: "parent"`. Public results are also retained in each child conversation.

Protocol references: [ChatGPT inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
and [preview requirements](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).

`test/runtime.test.ts` supplies pure bridge/normalization tests also included in
the main API test suite. Cloudflare `abortAllDurableObjects` and storage resets
can print workerd teardown exceptions during tests; assertions determine result.

This package does not implement Hermes, routine scheduling, native
iOS, local execution, or a secrets-entry UI. Its host interfaces leave those
separate from the Pi integration.


Model choices are account-scoped. Native model references include a persisted,
immutable configuration so prepared generations, compaction and recovered child
conversations retain the selected model, reasoning and Fast tier. The adapter
sends the public provider model ID on the wire; internal configuration IDs and
OAuth credentials never enter the request payload. New runs snapshot bot settings
before admission, while retries keep the original snapshot.

Pi owns automatic/manual compaction; the host preserves the immutable archive and
curated notes independently. See [context and memory](../../docs/context-memory.md).
