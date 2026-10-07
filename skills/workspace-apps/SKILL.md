---
name: workspace-apps
description: Publish and verify multiple named apps from a persistent workspace.
---

# Workspace apps
Apps are named services, and one workspace may have several (for example Frontend,
Admin and API). Start each server as a background process on its own port, bound
to 0.0.0.0. Use publish_app({name,port}) to register it and obtain its URL/basePath.
Load this skill before starting an app. Exec waits for command output and kills
its process group when its timeout expires. A bare `npm run dev` never finishes;
even `npm run dev &` can leave the output pipe open and be killed at timeout.
Start a service with detached standard streams, for example:
`nohup npm run dev -- --host 0.0.0.0 > /tmp/frontend.log 2>&1 < /dev/null &`.
Use distinct log/PID paths for each app. Check the PID, read its log and probe its
HTTP port in later finite commands. Do not mistake shell exit 0 for app readiness.
Exec defaults to 120 seconds; use that bound for dependency installs/builds rather
than short arbitrary timeouts. A timed-out command may have partially completed:
inspect its output and files before deciding how to continue.

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
