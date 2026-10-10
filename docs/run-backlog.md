# Run backlog and admission operations

## Receipts are not workers

A BotDO run is a durable input receipt. Several root inputs may join one native
Pi turn and settle against one answer. Temporary-agent inputs have their own host
projections; approvals, connections and result continuations remain attached to
their exact input/run identities. Consequently, the number of `activeRuns` is not
the number of concurrent model generations or computer effects.

The former `This bot already has 16 active runs` rejection counted queued,
running, approval/connection waits and child projections together, before saving a
new message. Sixteen legitimate waits could therefore prevent a fresh user input
while the root conversation had execution capacity. Console rendering/performance
changes cannot remove that backend admission rejection.

## Current boundaries

| Boundary | Admission policy |
| --- | --- |
| User backlog | New host inputs require space in the 32-queued-user-input budget. Explicit owner follow-ups to temporary agents use this budget. |
| Collaborator backlog | New host continuations/delegated inputs require space in the separate 16-queued-internal-input budget. |
| Native root inbox | At most 16 queued native inputs are admitted through the host root outbox. Capacity checks and submissions share one admission lane. |
| Outstanding projection circuit breaker | New host admissions stop at 128 unresolved queued/running/waiting projections, with a visible operator error. |
| Execution | Pi owns one root conversation and at most eight active temporary agents, including reactivation of completed agents. |

Running and approval/connection-waiting receipts are not backlog slots. The
backlog budgets include queued inputs already delivered to Pi as well as inputs
still waiting in the host outbox; they are not an additional allowance on top of
the native queue. Origin is stored server-side in `admission_sources` beside the
atomic run/submission/message receipt. Pre-migration root origin is inferred from
its stored public user message and provenance, not from a client-chosen ID prefix.

Native child projections retain their independent runtime ownership. Native work
already accepted can increase projection counts beyond a host admission threshold;
these limits do not truncate history or retroactively terminate those tasks.

## Interpret the receipt and error

- **202, queued, waiting for inbox space:** The input is already durably saved in
  `submissions`. A replaceable one-second Lifecycle wake checks native capacity.
  It survives object eviction and requires no browser polling. No user resend is
  necessary. Capacity waiting does not spend the five transport-delivery attempts.
- **202, queued, delivery being retried:** Delivery to the runtime is unconfirmed.
  Existing bounded transport recovery uses the same operation ID and reconciles a
  lost receipt before retrying. Exhaustion keeps the saved input and exposes an
  explicit identical retry; it does not authorize replay of a computer effect.
- **429 `inbox_full`:** A new input was rejected before its run/message was stored.
  Keep the draft and operation ID. Wait for queued inputs to settle, or explicitly
  cancel an unwanted queued input. Identical previously accepted receipts remain
  accessible at the limit. Reopening an unadmitted terminal configuration/legacy
  delivery failure requires a free backlog slot, while an already queued resend
  does not allocate a second one.
- **503 `run_lifecycle_overloaded`:** The bot has at least 128 unresolved projections
  when host admission checks capacity. New work is not accepted. Inspect pending
  decisions, outstanding native receipts and recovery health; do not solve this by
  raising the ceiling or guessing that old records are safe to delete. BotDO emits
  a deduplicated public `runtime.error` diagnostic and sanitized operator warning
  for new-message overload, without recording conversation text or provider data.

If a response was lost, reuse the exact original operation ID, text, attachments
and recipients to determine the saved receipt. A fresh operation ID is not a
transport retry and may create another task. Without a 202 receipt or a successful
idempotent reconciliation, do not assume an input was durably accepted.

## Safe investigation and recovery

1. Use authenticated bot-scoped run, approval, connection and agent reads. Inspect
   `activeRuns` independently of the requested history page; it is not truncated
   to an admission threshold. The summary endpoint is passive SQL-only.
2. Distinguish a host outbox entry (`submissions.admitted=0`) from an admitted native
   input, and compare the current `runs.native_operation_id` with its exact native
   receipt. Approval/connection continuations can replace that identity while
   retaining the host run. An old callback must not rewrite the newer continuation.
3. Check pending Stop/cancellation intents before interpreting admission health.
   Admission drains exact earlier cancellation intents first. A delayed callback,
   capacity wake or duplicate POST must never resurrect a stopped input/session.
4. Let ordinary recovery reconcile native terminal receipts and existing delivery
   intents. Resolve a real pending decision through its supported authenticated
   route if the owner wants that task to continue. A projection's age or status
   alone does not prove that its generation, unsafe effect or decision is stale.
5. If the owner no longer wants a task, use its explicit Stop/cancel route. Do not
   delete SQL rows, reset admission markers, blanket-abort the root conversation,
   silently cancel unrelated agents, or replay an interrupted computer command.
6. Persistent circuit-breaker overload requires operator diagnosis of native/host
   reconciliation and alarm delivery. Preserve the original input, receipts,
   cancellation fences and public result while investigating. This guide does not
   grant database-edit or effect-replay permission.

Acceptance, admission and task completion are different outcomes. A saved input
is not proof of inference, a queued wake is not proof of admission, and a final
answer is not proof that a pending command was approved or executed.

## Local regression evidence

The focused backend capacity suite covers user/internal budget separation,
concurrent last-slot admission, idempotency at a full backlog, capacity-wait retry
accounting, cancellation and eviction, the protective operator fault, and bounded
reopening of both configuration and exact legacy admission failures. Existing
admission/model tests cover lost receipts and conservative delivery retries.

`tests/pi/inbox-capacity.integration.ts` uses the real Pi harness and local SQLite
Durable Objects with a deterministic external model transport. It proves that a
17th user input completes while sixteen real approval waits remain pending, with
one saved user message, one answer and no pending command effects executed. It
also verifies a capacity-waited input wakes through the real Lifecycle alarm after
eviction without an HTTP read triggering opportunistic recovery. These local
checks do not establish production deployment, paid/live provider behavior, or
cloud computer readiness.
