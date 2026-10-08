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

After shell/file writes and before an intentional idle stop, the computer creates
an immutable tar.gz workspace checkpoint. The server supplies SHA-256; R2 validates
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

Chromium is closed to flush its profile during a checkpoint. When the computer
continues running it is reopened with the previous browser session. Tabs/profile
data can survive; page JavaScript memory and in-flight interactions do not. Idle
and explicit suspension leave Chromium closed.

Managed tools are serialized, and checkpoint creation checks file/directory
metadata to detect concurrent changes. Arbitrary detached shell jobs are not yet a
supervised job system. Stop background writers before making a checkpoint. This
is checkpoint persistence, not a transactional live disk or a VM memory snapshot.
If upload fails, the action result explicitly says its files are not yet durable.

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
