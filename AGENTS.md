# Timber

Cloud-first backend for named persistent bots. Each bot owns one conversation.
The intended product client is native iOS, but this milestone is backend and a
protected developer console/CLI for end-to-end testing.

## Boundaries
- TypeScript npm workspace monorepo. KISS: one API deployment, Durable Objects,
  R2 and reusable Cloudflare computers. No local companion in this milestone.
- AgentRuntime and ComputerProvider are independently replaceable.
- No secrets in git, logs, fixtures, browser URLs, prompts, or artifacts.
- All data/API routes are authenticated. Health and the unprivileged static
  console shell are public. Fail closed without configured auth.
- Never report an unimplemented or simulated capability as available.
- Existing operation IDs deduplicate effects. Unsafe interrupted actions are
  interrupted, never blindly retried. Cloud files persist through checkpoints.
- Bot inbox and transcript persist; client disconnection does not cancel work.
- Read docs/contracts.md before touching API or shared types.
- Agents modify only their assigned paths and do not commit shared changes.

## Verification
Run typecheck, meaningful tests covering auth, isolation, idempotency and recovery,
and the smoke script against the actual backend when credentials permit.
Document precisely what has run locally and in cloud.
