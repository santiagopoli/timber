# Private Computer secure-deploy protocol (v1)

This is an internal host-to-Computer protocol, not a `ComputerAction`, model tool,
public route or generic command endpoint. The Worker/ComputerDO owner-authority
check is mandatory; the Computer API bearer token authenticates only the host
channel and does not prove owner authorization.

## Readiness

`GET /secure-deploy/capabilities` requires the per-computer `Authorization:
Bearer <computer-token>` header. It never starts a container or touches a secret.
The fixed response is:

```json
{
  "secureDeploy": true,
  "isolationVersion": "uid-ptrace-v1",
  "privateCredentialChannel": true,
  "noShellEnv": true,
  "noBuildCredentialInheritance": true,
  "outputRedaction": true,
  "canaryVersion": "cross-uid-proc-env-v1"
}
```

All capability bits are false (except the descriptive versions and output filter)
unless the running image confirms distinct fixed UIDs, no-root escalation, the
root-owned runner, the exact pinned Wrangler version and an actual synthetic
cross-UID `/proc/<pid>/environ` denial canary. The canary contains no credential.
The Worker must fail closed unless the complete schema matches its supported
version; an advertisement alone is not a security boundary.

## One dispatch

After ComputerDO has awaited any container initialization, it must re-check the
signed authorization, live plan/revisions/grants, task/run/native operation,
Stop/deletion state, expiry and reference bindings immediately before its one
private request. Do not await between the final authority check and dispatch.
Credential decryption belongs to the narrowly scoped owner-keychain operation;
plaintext exists only in request/controller/runner memory.

`POST /secure-deploy` uses the same per-computer bearer header and this exact JSON
shape (unknown properties are rejected):

```json
{
  "operationId": "stable-operation-id",
  "authorization": "signed metadata envelope",
  "pin": {
    "repository": "owner/name",
    "commit": "40-or-64-lowercase-hex",
    "artifactDigest": "sha256:<64-lowercase-hex>",
    "artifactPath": "dist/worker.js",
    "accountId": "32-lowercase-hex",
    "workerName": "worker-name",
    "destination": "https://api.cloudflare.com/client/v4/accounts/<accountId>/workers/scripts/<workerName>"
  },
  "refs": [
    {"id":"secret-id","revision":1,"permissionEpoch":"...","binding":"..."}
  ],
  "credentials": [
    {"refId":"secret-id","revision":1,"header":"Authorization","prefix":"Bearer ","value":"private"}
  ]
}
```

The signed authorization binds the exact operation, plan, bot/run/native operation,
pin including `artifactPath`, and ordered metadata-only references. The container
checks field consistency but has no Worker signing key and cannot replace the
Worker's authority/revocation/liveness check. Allowed Cloudflare formats are one
`Authorization`/`Bearer ` value or the two-reference pair `X-Auth-Key` and
`X-Auth-Email`, both with empty prefix. The resulting Wrangler environment names
are fixed. Other formats are rejected.

The Computer opens the owner-pinned artifact path beneath `/workspace` by
`openat`/`O_NOFOLLOW` traversal, rejects symlinks, special files, traversal,
empty/oversize files and non-UTF-8 bytes, snapshots at most 4 MiB in memory, and
checks SHA-256 against the plan. It performs no repository fetch, build, script,
plugin, hook, config import or workspace command. Only this verified bundled JS
snapshot crosses to the trusted runner.

The root controller passes one JSON record over the private inherited stdin pipe
to the image-pinned runner using `setpriv` UID 10002, empty supplementary groups,
zero capabilities and `no-new-privs`. Its clean environment contains only fixed
system variables and the approved Cloudflare auth env values. The runner is
nondumpable, never reads workspace paths, and uses a private mode-0700 transient
home. It generates a fixed Wrangler config; invokes pinned Wrangler 4.147.0 by
absolute path with `deploy --no-bundle`; disables metrics and file logs; suppresses
stdout/stderr; bounds core dumps; and returns only fixed status codes. The
repository bundle is not executed locally. No credential is put in `argv`,
workspace files, server/runner logs, operation journal, returned output or
checkpoint. Temporary config and bundle contain no credentials and are removed.

Response body is always allowlisted and has no CLI output:

```json
{"operationId":"stable-operation-id","status":"completed","code":"deploy_accepted"}
```

Status values: `completed`, `failed`, `interrupted`, `rejected`, `unavailable`.
Code values: `deploy_accepted`, `provider_failed`, `runner_failed`,
`runner_interrupted`, `runner_unavailable`, `dispatch_already_seen`,
`invalid_request`, `invalid_authorization`, `invalid_pin`, `invalid_refs`,
`artifact_not_found`, `artifact_invalid`, `artifact_digest_mismatch`.

`POST /secure-deploy/cancel` accepts only `{ "operationId": "..." }` on the
same authenticated channel and returns `{operationId,result}` where result is
`cancelled`, `already_dispatched` or `unknown`. A pre-launch cancellation fences
the local dispatch; after the runner starts, the host kills that exact process
 group and reports `already_dispatched`, because Cloudflare may already have
accepted the external write. Such outcomes are uncertain and are never retried.
The durable Worker/DO operation journal remains the authoritative cross-restart
no-retry fence.

## Host image isolation requirements

The Docker image is root-controlled. The API server retains the management token
as trusted controller. Generic shell, managed Git/inspection, PTY, desktop/browser,
Openbox and desktop bridges run as UID 10001 with no supplementary groups,
capabilities, sudo or setuid privilege. The private Wrangler process runs under a
different UID 10002. `/opt/botspace`, Wrangler and startup code are root-owned and
not writable from `/workspace`. `/state` remains root-private. Shell and browser
children receive a fixed allowlisted environment, never the controller token or
arbitrary container variables. These UID/capability/canary checks gate both the
readiness response and actual dispatch; an unconfigured/local test environment
reports unsupported and cannot launch Wrangler.

Production smoke must verify the exact capability schema, `id -u` == 10001 for a
shell and Openbox/browser, `/proc` canary hidden from UID 10001, shell cannot
`setpriv --reuid=0`, shell has no `sudo`, `CAP_SYS_PTRACE`, `CAP_SETUID` or
`CAP_SYS_ADMIN`, and the canary is not present in shell output, argv, files or
logs. Confirm a wrong/absent host bearer is rejected and a wrong artifact digest
fails before any Wrangler process. These are host/image smoke requirements; no
local tests/build/install were run by this implementation task.
