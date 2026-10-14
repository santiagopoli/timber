# Timber runner

The runner connects an owner-managed macOS or Linux machine to Timber. Node.js 24
or newer is required. No Timber account token is entered in the terminal: a
one-time pairing code is approved in the authenticated console’s **Settings →
Machines**.

Download and start the current runner directly from Timber:

```sh
npx --yes https://timber-api.santiagopoli.workers.dev/console/runner/timber-runner.tgz connect --url https://timber-api.santiagopoli.workers.dev --workspace "$PWD" --grant diagnostics,files.read,files.write,host.shell,agent.run
```

This advertises the explicitly requested capabilities. Pairing grants no bot
access. Choose a bot, workspace and individual permissions in Settings, then set
that bot’s execution location to this machine. Choose **Cloud agent · tools on
machine** to keep inference in Timber, or **Local Pi · agent on machine** to run
Pi here; Local Pi additionally requires the `agent.run` permission. Model selection,
conversation and memory remain managed by Timber. An offline machine waits for
reconnection; work does not move automatically to Cloud.

For read-only access, omit `--grant` or supply `--grant diagnostics,files.read`.
The default is diagnostics and file reading. A workspace path sets the working
directory; it is **not a sandbox**. `host.shell` allows approved commands with your
full user privileges. The runner does not invoke `sudo`.

The process runs in the foreground. Keep the terminal open; Ctrl+C stops execution.
Use the same artifact URL for later commands:

```sh
npx --yes https://timber-api.santiagopoli.workers.dev/console/runner/timber-runner.tgz run
npx --yes https://timber-api.santiagopoli.workers.dev/console/runner/timber-runner.tgz status
npx --yes https://timber-api.santiagopoli.workers.dev/console/runner/timber-runner.tgz disconnect
```

`disconnect` stops local execution and revokes the device in Timber when reachable.
If Timber is offline, revoke it in Settings when connected again. Per-bot access
can also be revoked there without disconnecting the entire machine.

`--workspace-id` gives the workspace a stable ID (default `workspace`); `--name`
sets the machine name. `--approval ask` is the default and requires Timber’s
explicit action approval. `--approval automatic` also accepts automatic authorizations
from the bot’s configured policy. The default rejects
automatic authorization. Runner configuration, identity and receipts stay in an
owned state directory (default `~/.local/share/timber-runner`, overridable with
`--state-dir`). macOS uses Keychain for the device key; Linux protects it with file
mode `0600` inside a directory with mode `0700`. Model account credentials remain
in Timber.

Initial machine capabilities cover managed shell commands, files, bounded
diagnostics and Local Pi. Desktop viewing, screenshots, browser previews and Cloud
workspace checkpoints are unavailable on this target.

The private workspace package is distributed as a tarball, without publishing to
npm. `node scripts/build-runner.mjs` builds it, verifies an exact allowlist of public
package files, and writes `apps/console/public/runner/timber-runner.tgz` plus
`manifest.json` with the exact SHA256 and byte count. The archive contains executable
bundles, package metadata and this document; it excludes device keys, configuration,
receipts, databases and source state.
