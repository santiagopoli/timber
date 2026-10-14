# ChatGPT connection investigation — 2026-10-14

Message sending is still blocked. A successful workflow run is not successful
inference: the latest production verification returned HTTP 503 with
`model_catalog_unavailable`, without a completed response.

The user's fresh-sign-in comparison retrieved seven models locally (HTTP 200),
then failed in Timber (HTTP 503, upstream 520) after handing off the same access
credential. This establishes that the account can retrieve its catalogue. It
does not establish remaining inference allowance or the specific cause of the
server failure.

At 14:19 UTC, the credential owner compared requests using one newly refreshed
access token with about 59 minutes remaining. Issuer, audience, subject, client,
scopes and expiry matched the stored connection. Results:

| Request from production | Result |
| --- | --- |
| Workers, authenticated, five header variants | 520, Cloudflare error, no API request ID |
| Workers, unauthenticated control | 401, API JSON error with request ID |
| Dedicated Node HTTPS transport on Cloudflare, authenticated | 520, JSON, `error_category: origin`, no API request ID |

[Production comparison](https://github.com/santiagopoli/timber/actions/runs/38579342813).
The reported Cloudflare colo was ORD for both transports. A 520 and missing API
request ID do not prove the request never reached the origin.

The first alternative transport failed to become ready with the `lite` size.
An isolated test using a deliberately invalid credential received the expected
401 with `standard-1`; `lite` could not serve the request. The resource change
and one-time retirement of the unready instance were deployed and tested, but
did not fix authenticated 520s. The optional Node transport is therefore being
disabled as the default; it remains available for private diagnostics.

[Isolated runtime comparison](https://github.com/santiagopoli/timber/actions/runs/38576980130).
[Resource correction deployment](https://github.com/santiagopoli/timber/actions/runs/38578756891).

The cause is not yet isolated between the common Cloudflare route/network and
the authenticated request context, including the exact header combination.
Token expiration alone does not explain the failure with fresh credentials.

The updated `npm run chatgpt:login -- --compare-route` controls this difference
outside Cloudflare. It compares local discovery with default SDK headers and
the server's headers (`Timber/0.1.0`, JSON acceptance, identity encoding), repeats
the server-header query after cloud verification, then attempts one tiny local
plan response using a model actually returned by discovery. Output contains only
statuses, counts and completion; credentials stay in request memory.

If those local controls succeed while cloud verification fails, the evidence
points to the common cloud connection. If the server-header control also fails
locally, the request format is the next target. If the local credential stops
working after the handoff, connection/session handling needs further review.

No paid provider fallback was enabled, no bot messages or tool results were
replayed, and shared bot computer processes were preserved.
