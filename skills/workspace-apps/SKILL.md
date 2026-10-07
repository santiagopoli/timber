---
name: workspace-apps
description: Publish and verify multiple named apps from a persistent workspace.
---

# Workspace apps
Apps are named services, and one workspace may have several (for example Frontend,
Admin and API). Start each server as a background process on its own port, bound
to 0.0.0.0. Use publish_app({name,port}) to register it and obtain its URL/basePath.
Configure the server's base path using the exact returned basePath. For Vite use
--base with this path; frameworks with build-time base paths must be rebuilt.
Do not expose filesystem/control/debug services. Do not include secrets in an app.
Probe the app via list_apps after setup. Test HTML, assets and relevant API routes.
Provide named app URLs in the final answer and explain only actual limitations.
The Apps panel grants browser access securely; normal preview URLs require that
browser session. Servers stop when the computer sleeps; source files persist via
checkpoints, running processes do not. Removing a preview revokes its access.
