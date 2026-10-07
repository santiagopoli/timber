# Agent runtime

`AgentRuntime` is the engine-neutral host contract. `createPiRuntime` is the first
adapter and installs Cloudflare Lifecycle on the owning plain Durable Object.
Use `onRequest`, not a competing custom `alarm`; Pi owns transcript, inbox, native
run recovery, and wake-up scheduling. The backend owns the product projection and
an outbox for admitting user inputs with stable operation IDs.

The default model is `gpt-6.1-sol` through the user's connected ChatGPT plan.
The host supplies `chatgpt: { fetch(request): Promise<Response> }`, which receives
only credential-free POST requests to `https://api.openai.com/v1/responses` and
injects OAuth in its separate authentication object. The runtime never reads
tokens or environment API keys. An absent connection or exhausted allowance
fails explicitly; there is no billed fallback. Explicit `@cf/` model IDs retain
Workers AI. Named bot instructions are rendered before every request. Pi and
Agents packages are pinned because the durable harness is beta.

The native Pi Responses adapter receives the entire durable history, developer
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

Budgets are persistent and enforced before provider dispatch: 12 logical agent
generations, 24 tool invocations, and up to two inference retries. Workers AI
requests use at most 4096 output tokens. ChatGPT forbids `max_output_tokens`, so
its adapter aborts locally at 65,536 generated characters and the harness applies
a 120-second stream timeout. This is a local safety cap, not an exact token or
cost ceiling. Incomplete and truncated responses are failures, including usage
errors arriving after text has streamed. Retries/recovery of one logical task
retain its budget identity. Text-only models receive an explicit error before a
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
output limits, incomplete streams, usage failures, and model-loop budgets.

Protocol references: [ChatGPT inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
and [preview requirements](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).

`test/runtime.test.ts` supplies pure bridge/normalization tests also included in
the main API test suite. Cloudflare `abortAllDurableObjects` and storage resets
can print workerd teardown exceptions during tests; assertions determine result.

This package does not implement Hermes, delegation, routine scheduling, native
iOS, local execution, or a secrets-entry UI. Its host interfaces leave those
separate from the Pi integration.
