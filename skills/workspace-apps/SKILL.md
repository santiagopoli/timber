---
name: workspace-apps
description: Start, diagnose, publish and verify named apps from a persistent workspace.
---

# Workspace apps
An app must have a running HTTP server before its preview can work. `publish_app`
registers its name and port and checks readiness; it never installs dependencies,
starts a process, or fixes the app. Several apps can share this computer on distinct
ports. Load this skill before starting an app.

Follow the project's instructions and its existing start script:

1. Inspect AGENTS.md, git status, package.json and its lockfile in the requested
   project. Check existing processes, logs and registered apps before creating a
   second server. Every exec starts in /workspace with a fresh shell: include
   `cd /workspace/PROJECT && ...` in each project command. A previous `cd` does not
   persist into the next exec.
2. Call publish_app({name,port}) to reserve the stable URL and obtain `basePath`.
   An unavailable result at this stage is expected if no server is running yet.
   Keep that registration and port. For Vite, pass `--base` with the exact returned
   path; set the client router basename too when needed. Next.js basePath is a
   build-time setting. Bind the HTTP server to 0.0.0.0. Port 8080 belongs to Timber.
3. Install dependencies with the project's package manager and lockfile, then run
   required build/setup steps. Exec has no default execution deadline. `running`
   means the command is still alive: retain its processId and use exec_poll until
   an install/build finishes. Read any failure before correcting it. Never launch
   the same command again merely because it yielded.
4. Checkpoint completed setup before starting a long-lived server. Managed running
   commands defer checkpointing, so a server that runs indefinitely is not a reason
   to wait indefinitely for a checkpoint or to repeat a successful install/build.
5. Start the existing app script as a managed exec, for example
   `cd /workspace/PROJECT && npm run dev -- --host 0.0.0.0 --port PORT --base BASE_PATH`.
   Replace the placeholders and adapt flags to the actual framework. Retain its
   processId. A healthy server normally remains `running`; do not wait for it to
   exit before checking the app. Poll for startup logs, then use list_apps or publish
   the same name/port to probe the registered path. No nohup is required.
6. If readiness fails, use its readiness.code, httpStatus and message alongside the
   server log. A 404 at the registered path usually needs base-path/router setup;
   a 401/403 needs the app's own access/host settings; a 5xx needs server diagnosis.
   On timeout or connection failure, inspect the existing process and listening
   port before starting another one. Do not replace the project or start duplicate
   servers as a generic retry. The shell exiting successfully is not a readiness
   check.
7. Verify the returned HTML, a real asset, and relevant API routes under basePath.
   When ready, provide the named app URL and explain that the Apps panel grants
   browser access. Never direct the user to localhost on their own computer.

Keep frequently written logs and disposable build caches outside /workspace.
node_modules, .venv, .cache and __pycache__ are excluded from checkpoints; source
files, manifests and lockfiles belong under /workspace. If checkpointing reports
concurrent writes, relocate temporary output or stop the writer and retry only
checkpoint. Dependencies may need to be installed again after a computer restart.
Use exec_cancel or Stop to end a managed process deliberately; a new user message
is not a reason to kill a healthy app. Set timeoutMs only for a real task deadline.

A managed server remains visible and keeps the computer active while running. Only
when the task explicitly calls for a service that follows the computer's ordinary
idle lifecycle, finish and checkpoint setup before detaching it, for example
`nohup npm run dev -- --host 0.0.0.0 > /tmp/frontend.log 2>&1 < /dev/null &` from its
project directory. Keep distinct log/PID paths for detached services. They do not
keep the computer awake. Source files persist through checkpoints; running
processes, /tmp and system package installs do not survive computer sleep.

Do not expose filesystem/control/debug services or include secrets in an app.
Removing a preview revokes browser access, without stopping its server. The preview
URL requires the user's browser grant from Timber; authentication on that URL is
separate from whether the app's server is healthy.
