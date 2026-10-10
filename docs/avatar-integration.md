# Avatar integration and deferred workflow

This feature is integrated onto the host-cloned `origin/main` snapshot
`0615be4d7a82e6895038f0687951b8452fd2c1e3`, preserving upstream changes. The only
three-way conflict was in `package.json`; the upstream agent-panel performance
suite remains in `test:console`, alongside the avatar suites.

No `.github/workflows/**` modification is part of this branch. The exact original
workflow-only diff is preserved locally as `/workspace/avatar-workflow.patch`,
with `/workspace/avatar-workflow-README.md` for a separately authorized operator.
`git apply --check` against this snapshot succeeds; the patch has NOT been applied.
Those local files are outside the new repository and are not committed here.
The original `/workspace/timber` checkout remains clean at `04b7321`.

The server-only Worker secret contract remains `OPENAI_API_KEY`. This branch adds
an independently testable secret helper, not live CI wiring. Workflow-authorized
manual coordination, live secret configuration and deployment are deferred. Image
availability requires a configured Worker secret; it is not a claim of entitlement,
provider success or known cost. No secret was read, no real generation billed, and
no deployment, push, PR or merge was performed while preparing this local branch.

## Local verification environment

All dependencies, npm cache, Wrangler/Vitest caches and production console build
outputs are in `/tmp/timber-avatar-validation` or other `/tmp` paths. No durable
`node_modules`, build output or symlink was added. Node 24.14.0 / npm 11.9.0.

Confirmed focused checks on 2026-10-10:

- `npm run typecheck`: passed (API/shared, tests and console).
- `npm run build:console`: passed; inherited large-chunk warnings remain.
- `npm run test:avatars`: passed, **147 Vitest tests + 6 standalone helper tests**.
- Avatar Playwright suites: **8 passed** (6 existing cases + 2 new desktop/mobile
  review cases). See [avatar-ui-verification.md](avatar-ui-verification.md) for
  actual viewport measurements, screenshot evidence and reproduction.
- `npm run test:memory`: **17 passed** in the broader check attempt.
- `npm run test:runtime`: completed successfully before the supplementary chain
  advanced into backend-Pi (no aggregate `check` success is inferred).
- `npm run test:computer`: **47 passed**.
- `npm run test:chatgpt-cli`: **9 passed**.
- Standalone pin-image / production diagnostics / secret-helper tests: **15 passed**.
- `git diff --check`: passed; workflow and package-lock diffs are empty.
- Independent read-only API/Workspace/console integration review: no blockers.

Logs are temporary: `/tmp/avatar-typecheck.log`, `/tmp/avatar-build.log`,
`/tmp/avatar-focused-tests.log`, `/tmp/avatar-ui-review.log`.

Browser tests use the installed system Chromium with
`CONSOLE_CHROMIUM_PATH=/usr/bin/chromium` and
`CONSOLE_CHROMIUM_ARGS='["--no-sandbox"]'`. An initial broad browser invocation
without those local settings failed to launch Playwright's uninstalled downloaded
browser; it was stopped and retried with the correct executable. This is an
environment correction, not a disabled assertion or application change.

Broader monorepo verification remains **incomplete**, not green:

- The initial aggregate `npm run check` reached its command deadline before a
  final summary. A subsequent `npm test` run was stopped after about 11 minutes;
  completed test files had green results, but there is no full API-suite pass.
- The corrected full browser-suite run reached its 15-minute command deadline,
  with 120 individual passing case lines and no failed-assertion marker in the
  retained log, but without the aggregate summary. This is not a full
  `test:console` pass; the focused avatar cases did finish successfully.
- A supplementary runtime/backend-Pi/computer chain did not reach verified final
  success. Runtime completed before the chain advanced into backend-Pi; final
  backend-Pi verification is unconfirmed. The computer/CLI/standalone checks were
  then run separately and completed successfully as listed above.

No assertions were disabled, no tests were removed and no unrelated runtime code
was changed to accommodate these long-run limitations. Full monorepo/CI status
must be confirmed separately before final approval. No CI or cloud smoke success
is claimed. Additional temporary logs: `/tmp/avatar-api-tests-final.log`,
`/tmp/avatar-console-tests-final.log`, `/tmp/avatar-light-tests.log`.

`npm ci` reported **7 high-severity audit findings** from the unchanged dependency
lockfile. No dependency upgrade/audit fix was attempted outside this integration
scope. A separate full audit request timed out; the install report is the evidence
for this warning, not a completed independent vulnerability assessment.
