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
Terminal commands intentionally have full control of this bot's computer, and must
be approved by host policy before model invocation.

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
TTY (`pty.fork`, job control and `TIOCSWINSZ`), not `exec` polling. The 8080
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
helper with Linux `PR_SET_CHILD_SUBREAPER`; only that helper calls `pty.fork`.
The threaded HTTP server never runs Python child setup after fork. The private
socketpair passes the PTY descriptor with `SCM_RIGHTS`, not terminal data.
Detached descendants remain under the dedicated subreaper even after `env -i`,
`setsid`, double-fork or reparenting. Cleanup freezes/kills only its current direct
children using identity-fenced Linux pidfds; as ancestors die, surviving subtree
roots are adopted and killed in turn. The helper reaps until kernel `ECHILD`
confirms no remaining children before sending an acknowledged cleanup receipt.
No environment marker, historical PID sample or unrelated process group is used.
Linux child-subreaper and pidfd support are required; startup fails closed without
them. The helper is included in the existing single-file Docker/bootstrap copy.

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

**Isolation caveat:** the VM remains the trust boundary. This is not a
privilege-separating sandbox: hostile same-UID code can inspect other processes or
kill the supervisor. Losing the supervisor without its cleanup receipt fails
closed and blocks replacement/checkpoint rather than claiming successful cleanup.
Real Linux tests cover environment-cleared, detached double-fork writers, complete
reaping, unrelated process survival, and failed cleanup followed by explicit retry.
The focused tests also exercise actual WebSocket auth,
TTY/input, Ctrl-C, resizing, exit codes, lease renewal/expiry, limits, slow-reader
backpressure, and internal HTTP/checkpoint exclusion:

```
python3 -m unittest discover -s infra/computer/tests -p test_shell_bridge.py -v
```
