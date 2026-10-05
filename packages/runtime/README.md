# Agent runtime

`AgentRuntime` is the engine-neutral host contract. `createPiRuntime` is the first
adapter and installs Cloudflare Lifecycle on the owning plain Durable Object.
Use `onRequest`, not a competing custom `alarm`; Pi owns transcript, inbox, native
run recovery, and wake-up scheduling. The backend owns the product projection and
an outbox for admitting user inputs with stable operation IDs.

The default Workers AI model is `@cf/moonshotai/kimi-k2.7-code`, which supports
vision and function calling. Named bot instructions are rendered before every
request. Pi and Agents packages are pinned because the durable harness is beta.

Computer tools route through the host's permission callback. Stable tool
operation IDs survive replay. Reads are replay-safe; effects are unsafe. A
pending approval terminates the native tool round and persists a pause marker;
the provider boundary blocks further inference for that operation, including
mixed tool rounds. The approved result resumes through a new durable input.

Budgets are persistent and enforced before provider dispatch: 12 logical agent
generations, 24 tool invocations, at most 4096 output tokens per inference
request, and up to two inference retries. Retries/recovery of one logical task
retain its budget identity. Text-only models receive an explicit error before a
model-initiated screenshot dispatch; direct human screenshot access is separate.

## Verification

```sh
npx vitest run --config packages/runtime/vitest.config.ts
```

These integration tests execute the real Pi harness, Cloudflare Lifecycle and
SQLite in workerd. Only the external Workers AI inference transport is a
fixture. They cover named instructions and the actual streaming protocol,
output limits, input deduplication after a hard object restart, approval pauses
including mixed tool rounds, and model-loop budget enforcement.

`test/runtime.test.ts` supplies pure bridge/normalization tests also included in
the main API test suite. Cloudflare `abortAllDurableObjects` and storage resets
can print workerd teardown exceptions during tests; assertions determine result.

This package does not implement Hermes, delegation, routine scheduling, native
iOS, local execution, or a secrets-entry UI. Its host interfaces leave those
separate from the Pi integration.
