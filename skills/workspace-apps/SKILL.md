---
name: workspace-apps
description: Publish and verify multiple named apps from a persistent workspace.
---

# Workspace apps
Apps are named services, and one workspace may have several (for example Frontend,
Admin and API). Start each server on its own port, bound
to 0.0.0.0. Use publish_app({name,port}) to register it and obtain its URL/basePath.
Load this skill before starting an app. Exec has no default execution deadline.
Its yieldMs parameter limits the wait for a response, not the process lifetime.
For installs and builds, retain the returned processId and use exec_poll until
completion; never start the same command again because it returned running.
Use exec_cancel or Stop to terminate a managed process. Set timeoutMs only when
the task needs an actual deadline.

A managed server can run with `npm run dev -- --host 0.0.0.0`; it remains visible
and cancelable, and keeps the computer active while running. Stop managed writers
before checkpointing. For a service intended to follow the computer's ordinary
idle lifecycle, first finish and checkpoint setup, then explicitly detach its
streams, for example `nohup npm run dev -- --host 0.0.0.0 > /tmp/frontend.log 2>&1 < /dev/null &`.
Keep a distinct log/PID path for each detached service. Probe its HTTP port and
read its log to verify readiness. Shell exit 0 alone does not prove readiness.
After a timeout or cancellation, inspect output and files before proceeding.

Keep frequently written logs and disposable build caches outside /workspace.
Checkpointing verifies the included files do not change while being archived.
node_modules, .venv, .cache and __pycache__ are already excluded; source files,
manifests and lockfiles must remain under /workspace. If checkpointing reports
concurrent writes, relocate temporary output or pause the writer and retry only
checkpoint. Do not rerun a successful command merely because persistence failed.
Configure the server's base path using the exact returned basePath. For Vite use
--base with this path; frameworks with build-time base paths must be rebuilt.
Do not expose filesystem/control/debug services. Do not include secrets in an app.
Probe the app via list_apps after setup. Test HTML, assets and relevant API routes.
Provide named app URLs in the final answer and explain only actual limitations.
The Apps panel grants browser access securely; normal preview URLs require that
browser session. Servers stop when the computer sleeps; source files persist via
checkpoints, running processes do not. Removing a preview revokes its access.
