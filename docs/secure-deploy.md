# Secure Worker deploy plans: fail-closed prototype

## Availability

`secure_worker_deploy` is deliberately **not an available deployment capability** on this product host. The API implements owner-managed immutable plan metadata and a reference-only request path, but the current ComputerDO/container shares a VM, filesystem, process tree and OS identity with the workspace and arbitrary commands. A Wrangler process cannot safely receive credentials there. ComputerDO reports `secure_deploy_host_unsupported` unconditionally, including if an optional service binding is accidentally configured. It does so before container startup, secret decryption, shell/PTY dispatch, or an outbound Cloudflare request. There is no plaintext credential broker, CLI, or exec fallback. No actual deployment has been attempted.

## Owner plan API

All paths require the existing authenticated `/v1` owner API:

- `POST /v1/keychain/deploy-plans` creates a plan from `{operationId,botId,repository,commit,artifactDigest,accountId,workerName,refs:[{id,revision}]}` and returns `{plan}`. Repeating the same operation ID with identical normalized metadata returns the same plan; changed details conflict. Only references currently permitted to that bot, at the pinned revision, and configured for Cloudflare API authentication are accepted. Use one `Authorization: Bearer ` reference, or both `X-Auth-Key` and `X-Auth-Email` with empty prefixes.
- `GET /v1/keychain/deploy-plans` lists active owner plans. A bot-context alias cannot list, create, or revoke plans.
- `DELETE /v1/keychain/deploy-plans/:planId` with `{operationId,expectedRevision}` revokes the plan and advances its revision. A stale revision is rejected. Plan metadata contains no secret values.

The repository must be `owner/name` with no dot path component; commit is an exact lowercase 40- or 64-character Git object ID; artifact digest is `sha256:` plus 64 lowercase hex characters; Cloudflare account is 32 lowercase hex characters; Worker name is bounded lowercase DNS-style text. The destination is constructed internally as the exact `https://api.cloudflare.com/client/v4/accounts/{accountId}/workers/scripts/{workerName}` path. Extra fields, arbitrary URLs, commands, Wrangler arguments, config paths and caller-selected credentials are rejected.

The model tool accepts **only** `{planId,expectedRevision}`. It cannot create or retarget a plan. WorkspaceDO resolves that owner record and checks plan-to-bot binding, revision, active state, run/native-operation/Stop/deletion liveness and each reference's signed grant/revision. The signed metadata-only authorization binds owner, bot, run, operation, plan revision, destination, reference revisions and permission epochs and expires quickly. No keychain value is decrypted by this flow. Replay checks live authority and produces only a fixed saved receipt; uncertain or in-progress operations are not retried. Durable fingerprints are HMAC-keyed, journals contain only plan/reference metadata and allowlisted status codes, and no provider output is persisted or returned.

## Host requirements before deployment can be enabled

A separate trusted deploy host is required. It must have an OS-enforced isolation boundary from the shared computer and workspace; credentialless digest-verified build inputs; a pinned, policy-constrained runner with no arbitrary hooks/plugins or workspace config execution; and a private short-lived credential channel available only to that runner. The host must independently verify signed authorization and current owner grants/revisions/run fences, bind the exact account/Worker URL, block redirects, serialize atomic cancellation against dispatch, redact all output before any storage/return, clean up transient credentials, and persist a durable no-retry-after-uncertainty journal. Capability must be established by that separately operated host implementation, never config, workspace files, user-supplied flags, or an advertisement boolean. This repository contains no such receiver or runner; the service-binding transport remains disabled and is not an implementation of those guarantees.

## Verified locally on upstream `3e60bba`

- `npm run typecheck`: passed (backend, tests, console).
- `npm test -- tests/keychain.spec.ts tests/security.spec.ts tests/host-connections.spec.ts tests/api.spec.ts tests/computer-validation.spec.ts`: **128 passed**, five files; includes 53 existing HTTP/Keychain cases and nine CLI/plan cases.
- `npm run test:secure-deploy`: **20 passed** with simulated trusted-host adapters and a test-only HMAC key.
- `npm run test:runtime`: **79 passed** using deterministic provider fixtures.
- `python3 -m unittest discover -s infra/computer/tests -v`: **67 passed**. A real synthetic Linux child plus independent credentialless sibling proves the shared computer exposes process environment data. It kills/reaps the child and removes temporary files; no credential value is printed.
- `git diff --check`: passed.

The real ComputerDO gate is exercised through a private namespace request, without container startup, keychain decryption, shell effects or outbound Cloudflare requests. Tests cover owner authentication, strict legacy/bearer formats, immutable targets, stale/revoked plans and references, Stop, envelope/ciphertext binding during awaits, concurrent journal reservation, input mutation, recovery, cancellation and output suppression. The initial two-coordinator duplicate-dispatch race, fingerprint canonicalization mismatch and fixture GET routing were found and corrected before the final rerun. Workerd emitted request-stream/teardown warnings; all final commands exited zero.

This is **not a working Wrangler deployment**. No trusted runner or plaintext credential channel is implemented, no cloud smoke or real deployment was run, no live keys were used, and no paid provider calls were made. Source and these verification results are delivered in a draft PR. The separate host requirements above remain mandatory before enabling dispatch.
