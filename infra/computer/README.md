# Cloud computer

`@botspace/computer` owns one Cloudflare Container per bot. The `ComputerProvider`
contract contains no Cloudflare SDK types. The cloud adapter routes all operations
to `ComputerDO`, which serializes tools and persists operation identities/results.

## Images and deployment

Cloudflare Containers requires a Workers Paid account with Containers access. A
successful Worker/R2 deployment alone does not establish this access. The deployed
provider returns an unavailable/startup error if the account cannot start its
container; it never substitutes simulated shell or desktop results.

Cloudflare Containers require Workers Paid. Deploying only the Worker and R2
does not provision a working computer when that account prerequisite is missing.

The production image is this directory's Dockerfile. Use this directory as its
Docker build context. Build for `linux/amd64`; pin the resulting registry digest in
deployments. Python, Node, Chromium, Xvfb, Openbox, xdotool, xclip and scrot are
installed before startup.

The bootstrap deployment sets `COMPUTER_BOOTSTRAP=true`. It uses Cloudflare's
managed `cloudflare/debian-trixie` image and installs the same desktop dependencies
at the first start of each fresh container. This mode supports a real cloud smoke
test without a local Docker daemon, but is intentionally slower and depends on
Debian package availability. It is not a fast-cold-start production configuration.
Wrangler bundles `server.py` and `start.sh` as Text modules.

The Python HTTP server listens on port 8080. Every endpoint, including its health
check, requires a random per-computer bearer token. Only `ComputerDO` proxies this
port; app previews cannot access this management port. The token is not a model
provider or R2 credential. The shell and desktop share the VM trust boundary and
must not be treated as mutually isolated users.

The HTTP listener uses fixed server metadata instead of resolving the container's
hostname. Cloudflare can assign a 64-character hostname that Python's default
HTTPServer rejects during its IDNA/FQDN lookup, before accepting requests.
Startup failures propagate as safe, stage-specific API errors (normally HTTP 503)
and fixed diagnostic codes in Worker logs, without leaking credentials or commands.

Official deployment guidance:

- https://developers.cloudflare.com/containers/api/durable-object-container/
- https://developers.cloudflare.com/containers/guides/deploy/
- https://developers.cloudflare.com/sandbox/get-started/

## Tools

Tools execute in a reusable `/workspace`. Paths supplied to file tools are relative
to that directory; absolute paths, parent traversal and escaping symlinks fail.
Terminal commands control this bot's workspace and its same-UID desktop processes,
not root/private credential services. Model invocation requires host policy approval.

The desktop is 1280×800. `navigate`, `screenshot`, `click`, `move`, `doubleClick`,
`drag`, `type`, `key` and `scroll` operate the real X11 desktop. `move` does not
click; `drag` releases its button even if an input subprocess fails. Screenshots
are private PNG artifacts in R2. Live observation/control uses noVNC over an
authenticated WebSocket with separate view-only and control x11vnc servers. Chromium starts lazily on first navigation. Clipboard
paste permits Unicode text, then clears the clipboard.

Shell commands run up to 120 seconds, return up to 128 KiB of merged stdout/stderr,
and have their process group terminated on timeout. A timeout cannot undo an
already performed external action. A later client retry with the same operation ID
returns the stored result. Different arguments with an existing ID are rejected.
The durable journal treats unknown interrupted operations as interrupted, never
as permission to execute them again.

Managed `gitClone` and `gitPush` receive only `owner/repository`, a workspace path,
and an optional clone branch or required push branch. The host obtains a short-lived
repository-scoped transport capability from its GitHub connection broker. That
capability goes in a private request envelope and transient Git process environment;
it is absent from command arguments, action identities, journals and `.git/config`.
The remote stored on disk is the ordinary `https://github.com/owner/repository.git`.
The GitHub installation credential remains in the host broker. Arbitrary processes
within the same VM can inspect transient process environments, so the transport
capability grants only the explicitly authorized repository and is revoked after use.

Clone is shallow (depth 1), does not recurse into submodules, and checkpoints the
result. Push specifies one exact local branch and the same remote branch, with no
force or implicit tag pushes. Both operations disable custom global configuration,
credential helpers, hooks, redirects and non-HTTPS protocols. Managed push rejects
repository configuration that could activate custom helpers, filters or includes.
Existing computers on an older image return `computer_upgrade_required` before any
Git effect is journaled. Explicit suspension saves their workspace; the next natural
start uses the newly deployed image without destroying active tasks.

Registered app previews forward HTTP and WebSocket traffic only to the matching
bot's already running computer. They retain the application's base path and remove
platform credentials. A preview never starts a stopped computer or retries a write.
Ports below 1024 and the management port 8080 are excluded. Successful requests renew
the normal idle lease; an idle open tab alone does not keep a computer running forever.

## Persistence and limits

Shell/file tools return their journaled outcome without waiting for persistence.
Terminal shell receipts report observed workspace changes. Pure reads such as
`cd && grep` omit checkpoint status and do not schedule an archive/upload. Linux
events maintain a bounded directory/file index; a metadata audit of indexed files
covers mmap and hardlink writes without hashing content or walking directories
again. Lost events or unavailable watches retain conservative saving. Running
execution intent and its observation alarm are durable before dispatch; terminal
write intent is durable before returning its result.

Their filesystem changes have `checkpointStatus:pending` until a durable alarm
coalesces them after 90 seconds without agent tool/runtime activity and without
active managed commands. Passive process observations and viewer renewals do not
postpone this save. Before an intentional idle stop, or for an explicit checkpoint
or suspension, the computer also creates a fresh immutable tar.gz checkpoint.
The server supplies SHA-256; R2 validates
the streamed upload, then the Durable Object updates the current checkpoint
pointer. A new computer restores and verifies this checkpoint before tools run.

The portable format permits regular files, directories, and relative symlinks that
remain inside the workspace. Restore rejects hardlinks, devices, absolute/traversal
paths, duplicate members and members beneath symlinks. Extraction happens in a
staging directory before the workspace directory is swapped. A failed extraction
leaves the previous workspace intact.

Limits are 256 MiB uncompressed, 256 MiB compressed and 10,000 entries per
checkpoint. Dependency/cache directories `node_modules`, `.venv`, `.cache` and
`__pycache__` are excluded. Chromium caches are excluded while its profile is
included. Rebuild dependencies from package manifests after a cold start.

Automatic file checkpoints keep Chromium and its live pages open. They archive
the last consistent closed-profile baseline captured before browser launch,
rather than copy active SQLite/session files. Recent browser changes are saved
by an explicit checkpoint or idle/suspend capture: those close Chromium to flush
its current profile. An explicit checkpoint reopens the previous browser session;
idle and suspension leave it closed. Restoring a saved profile can recover browser
data, but not page JavaScript memory or in-flight interactions. A file checkpoint
alone does not promise that recent cookies or session changes are durable.

Managed effects and archive creation are serialized, but a background upload to
R2 holds neither the effect nor workspace gate. New tools can run during upload;
their revisions remain pending until a later snapshot includes them. Explicit
checkpoint and suspend wait for the earlier upload and then capture fresh files.
Checkpoint creation checks file/directory
metadata to detect concurrent changes. Arbitrary detached shell jobs are not yet a
supervised job system. Stop background writers before making a checkpoint. This
is checkpoint persistence, not a transactional live disk or a VM memory snapshot.
An upload failure preserves the known action outcome and retries saving only;
continuing or non-retryable failures add a checkpoint warning. A container failure
before a successful save can lose pending files. Journals do not turn the container
disk into a durable volume, and interrupted commands are never automatically replayed.

The computer stops after five minutes without activity after a successful
checkpoint. Active bot turns can call `touchCloudComputer` to extend that lease.
`suspendCloudComputer` checkpoints and stops immediately for cold-restore testing.
The provider has a 15-minute infrastructure inactivity safety timeout.

## Tests

Run `npm run test:computer` from the repository root. The standard-library tests
execute real shell processes and exercise auth, deduplication, restart recovery,
timeouts, bounds, traversal, symlink handling and checkpoint restore. They do not
require Docker or claim to validate Chromium without an X11 desktop.

The Git test uses a real temporary HTTPS smart-HTTP repository requiring a scoped
test credential. It clones, commits and pushes a branch, verifies the remote result,
checks duplicate operation handling, and inspects the saved checkpoint and journal
for credential leakage. The fixture requires local `git` and `openssl` binaries.

The deployed smoke test must verify a screenshot is a PNG and run file write,
checkpoint, suspend, restart/read and a duplicate shell action against cloud.

## Private interactive shell transport

`server.py` embeds the independent `shell_bridge.py` transport on **private
6082** and shares its `ShellManager`. This is a real interactive bash controlling
TTY (native Linux `forkpty`, job control and `TIOCSWINSZ`), not `exec` polling. The 8080
control server remains internal. Neither port is a public app/console port;
Docker `EXPOSE` is container metadata only. Authenticated health advertises
`"shellPtySupported"` for this image implementation, and `"shellPty"` only after a successful authenticated bridge protocol probe.

The upstream DO connects to `/shell` (or `/`) using all of:

- `Authorization: Bearer <BOTSPACE_COMPUTER_TOKEN>` (never a URL parameter);
- `Sec-WebSocket-Protocol: timber-shell.v1`;
- `X-Timber-Shell-Session: <canonical UUID>`;
- `X-Timber-Shell-Expires: <integer epoch milliseconds>` (future, at most 60s).

Client frames are masked, unfragmented RFC6455 **text** frames containing exactly
`{"type":"input","data":"..."}` or
`{"type":"resize","cols":80,"rows":24}`. Dimensions are integer 1–500 columns
and 1–200 rows. Binary frames, compression, continuation frames, unknown fields,
and malformed messages terminate the session. Ping/pong/close are supported.
Output frames are text JSON `{"type":"output","data":"..."}`;
terminal status is `{"type":"exit","exitCode":7}` (null for signal death), and
errors contain only fixed `{"type":"error","code":"shell_*"}` categories.
Invalid PTY output UTF-8 is replaced incrementally, not allowed to break JSON.

Internal authenticated HTTP controls on **6082** (also available on **8080**):

- `POST /shell/renew {"sessionId":"<UUID>","expiresAt":<epoch-ms>}`;
- `POST /shell/close {"sessionId":"<UUID>"}`;
- `POST /shell/close-all {}`.

Success is `{"ok":true}`. Session UUIDs are one-use within the boot. Close records
an hour-long session fence **before** cleanup, including IDs whose upgrade has
not arrived. At most 1024 unexpired fences are retained; capacity fails closed
rather than evicting a live fence. `/shell/close-all` permanently fences new shell
admission for this bridge boot (appropriate for suspend/delete); reopening requires
a new bridge/manager. This prevents unknown delayed handshakes without relying on
an absent generation header. Close is idempotent and returns only after cleanup;
a mismatched session ID never closes another shell. Renew never revives an
expired/closed session, shortens its lease, or extends the monotonic one-hour
hard deadline. The lease continues to expire even when the client sends input.
There is at most **one session**, and its entire life (including cleanup) blocks
checkpoint/restore atomically. The DO must close it before suspend/delete and
must arrange persistence after it closes; shell input/output is not journaled.

Frames are capped at 16 KiB, queued input at 64 KiB, total input/output UTF-8 data at 16 MiB
per session, and sends at two seconds. Slow/disconnected peers cannot retain an
unbounded output queue. Incomplete upgrades have a five-second socket timeout
and at most sixteen accepted connection handlers. Disconnect, lease/hard expiry,
protocol/limit failure and explicit close kill/reap the PTY and all descendants.
Each session starts a fresh-exec, single-threaded `shell_bridge.py --supervisor`
helper with Linux `PR_SET_CHILD_SUBREAPER`; only that helper calls native Linux `os.forkpty`.
The threaded HTTP server never runs Python child setup after fork. The private
socketpair passes the PTY descriptor with `SCM_RIGHTS`, not terminal data.
Detached descendants remain under the dedicated subreaper even after `env -i`,
`setsid`, double-fork or reparenting. Cleanup freezes/kills only its current direct
children using identity-fenced Linux pidfds; as ancestors die, surviving subtree
roots are adopted and killed in turn. The helper reaps until kernel `ECHILD`
confirms no remaining children before sending an acknowledged cleanup receipt.
No environment marker, historical PID sample or unrelated process group is used.
Linux child-subreaper and pidfd support are required; startup fails closed without
them. A known pre-launch rejection sends an explicit acknowledged `not_started`
receipt after confirming kernel `ECHILD`; the controller returns a fixed 503,
reaps the helper and releases the guard, permitting a new grant after correction.
EOF/exit status alone never proves no effects. If a child is observed during a
startup failure, the helper must have established subreaping and complete normal
descendant cleanup before any positive receipt; otherwise it remains uncertain.
Ambiguous post-launch failures remain guarded. Native Linux
`forkpty` avoids a Python fallback throwing partway through child terminal setup.
The helper is included in the existing single-file Docker/bootstrap copy.

A cleanup timeout/error retains the session and checkpoint/admission guard.
Handler completion is separate from confirmed cleanup; authenticated close calls
(including upstream maintenance retries) retry shutdown of the same helper,
never launch a replacement shell. The helper also retries uncertain shutdown
without surrendering subreaper ownership. A dead helper without a cleanup receipt
is uncertainty, not evidence that its descendants stopped.
Only an allowlisted minimal environment reaches bash: no inherited computer or
provider tokens or shell startup hooks; bash uses `--noprofile --norc` and starts
in `/workspace` (the configured workspace in tests). Automatic bash history is
disabled (`HISTFILE=/dev/null`, `HISTSIZE=0`, `HISTFILESIZE=0`), so terminal input
is not silently written into workspace checkpoints. The authorized owner can
still explicitly write files or change history settings; this is not an attempt
to suppress authorized filesystem effects.

**Private-service boundary:** the root controller and fresh-exec cleanup
supervisor are trusted, fixed root-owned code. Only the native-forkpty child execs
`/usr/bin/setpriv` before bash: real/effective UID/GID **10001**, empty supplementary
groups, empty inheritable/permitted/effective/bounding/ambient capability sets,
and `NoNewPrivs=1`. The fixed launcher fails closed without a root supervisor or
root-owned non-writable launcher; there is no root/local fallback. No workspace
code runs before the irreversible drop. The child owns its PTY slave and starts
with only the minimal allowlisted environment. Root supervisor ownership prevents
workspace code from signalling/ptracing it or forging its private socket receipt;
losing the helper without proof still blocks replacement/checkpoint.

UID10002 is reserved for the private credential runner, distinct from the
workspace/desktop UID. Workspace code cannot read root/private process env,
memory or descriptors, read root-private `/state`, overwrite trusted controller
code, or escalate via setuid binaries. The authenticated management HTTP/shell
bridges reject missing/incorrect bearer tokens even from localhost: reachability
is not authorization. The shell cannot obtain the controller token via its env
or cross-UID `/proc`. There is no claim of network-namespace isolation. The shell
and desktop deliberately share UID10001 and can inspect/signal each other;
the VM remains the cross-bot boundary, not a separate sandbox per shell job.

Private dispatch and shell admission are additionally arbitrated by the DO.
A private dispatch response has an **internal-only** `quiescent` boolean: normal
provider outcome status/code does not certify local cleanup. Authenticated
`POST /secure-deploy/close {"operationId":"..."}` on 8080 returns
`{"operationId":"...","quiescent":true}` only after tombstoning that ID against
delayed dispatch and proving no active dispatch/private runner remains. False or
missing proof retains the upstream shell exclusion guard; maintenance retries
close the same operation. `/secure-deploy/cancel` retains its old outcome meaning
and is not a quiescence receipt. Close waits up to ten seconds; prelaunch IO and
spawn-publication races cannot release early. Dispatch cleanup reaps its direct
runner and requires **kernel-atomic original-group emptiness** (`killpg(pgid,0)`
returns ESRCH), never a sampled `/proc` table or direct-parent reap alone.
Zombie processes, reused groups and errors retain the guard; image PID1 init must
reap orphaned trusted CLI children. Signals use identity-checked pidfds collected
only while the original leader is live, never late numeric `killpg` after reap.
Observation/signal/proof uncertainty retains the tombstone and guard for retry.
This private-runner proof relies on the pinned trusted runner/CLI not deliberately
escaping its cancellation group; it is **not** the arbitrary detached descendant
`ECHILD` containment guarantee of the dedicated shell subreaper.
Real Linux tests cover environment-cleared, detached double-fork writers, complete
reaping, unrelated process survival, and failed cleanup followed by explicit retry.
They also inject a real helper-level pidfd signal failure while a detached writer
remains live, verify pending receipts keep checkpoint/replacement guards, then
restore the syscall and confirm the same helper kills/reaps before releasing.
Fresh-helper capability failures exercise explicit pre-launch no-effects receipts;
loss of control after a real PTY launch verifies ambiguous EOF stays guarded.
The focused tests also exercise actual WebSocket auth,
TTY/input, Ctrl-C, resizing, exit codes, lease renewal/expiry, limits, slow-reader
backpressure, and internal HTTP/checkpoint exclusion:

```
python3 -m unittest discover -s infra/computer/tests -p test_shell_bridge.py -v
```

The privilege-boundary fixtures require a Linux root test controller plus
`setpriv`; they explicitly model production workspace/root-code permissions and
skip on hosts that cannot establish that boundary. They execute adversarial
probes **inside the actual PTY**, including UID/GID/groups/all capability sets,
no-new-privs, private process env/memory/pipe access, signals/ptrace, root-private
paths, protected code writes, a genuine setuid-root executable, unauthenticated
localhost management requests, and non-root supervisor rejection. Existing root
trust expectations are preserved. Tests no longer read workspace-UID environments
from a root fixture without CAP_SYS_PTRACE; the real detached writer records its
own cleared-env observation instead, preserving the strengthened cross-UID boundary.

`smoke_shell.py` is standalone built-image verification using only shipped modules:
run `docker exec -i timber-image-smoke python3 - < infra/computer/smoke_shell.py`
after `start.sh` is ready. It checks genuine identity/caps/no-new-privs, protected
paths and setuid suppression, Unicode stdin, resize, Ctrl-C, detached descendant
adoption/reaping, replacement/checkpoint exclusion, and unauthenticated localhost
management denial. Docker is unavailable in the editing workspace, so a local
Linux subprocess smoke is not a claimed Docker image run; actual image smoke
must pass in CI before image delivery can be reported. The existing
`smoke_desktop.py` image gate invokes the root-owned shipped `smoke_shell.py`,
so both verification and desktop-release workflows exercise the actual built
PTY image without changing workflow permissions. Root-only private lifecycle
unit fixtures require a separate root test run; a nonroot `npm run check` may
skip them and must not be presented as that root-isolation evidence.

Automated Chromium/WebKit terminal coverage does not verify a physical device:
**physical Safari/iPhone testing remains unverified**.
