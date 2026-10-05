# Backend verification

Run `npm test` from the repository root. This suite executes in the real local
Workers runtime through `@cloudflare/vitest-plugin`, with SQLite Durable Objects
and a local R2 binding. It requires no deployment, API key, Docker, or paid model
calls. The fixed credential in `wrangler.jsonc` is a public test value, never a
deployment secret.

The API tests use the production Worker, WorkspaceDO, BotDO, request validation,
and cloud computer provider routing. Only the external runtime and computer
effects are replaced with deterministic adapters under `fixtures/`. The runtime
alias exists exclusively in `tests/vitest.config.ts`.

Coverage includes:

- Missing/malformed authentication, fail-closed configuration, sanitized errors,
  bounded request bodies, file path restrictions and unsafe navigation inputs.
- Named bots and conversation persistence through object eviction, artifact
  ownership and attachment-only serving of active content.
- Concurrent message submission deduplication and conflicting-input rejection.
- Stored approval arguments, repeated approvals, denial, cancellation, late
  effect completion, and stale GUI approval invalidation after manual input.
- SSE disconnect without task cancellation and replay using durable cursors.
- The **real ComputerDO** journal across eviction, proving that unknown effects
  return `interrupted` and completed effects return their recorded result even
  when no container is available.
- Runtime tool policy, durable tool IDs, screenshot pixels, and transcript
  projection excluding internal reasoning.

Test source typechecking: `npx tsc --noEmit -p tests/tsconfig.json`.

The independent `packages/runtime/vitest.config.ts` suite exercises the real Pi
Harness with a deterministic Workers AI transport. Computer server tests exercise
real filesystem and shell behavior in Python. Cloud smoke tests remain necessary
for actual model inference, container startup, desktop tools, and R2 restore.
Passing this local suite does not establish cloud cold-start latency or prove a
production desktop image can start.
