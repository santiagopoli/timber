# Avatar desktop/mobile UI verification

The focused local review is implemented in `scripts/tests/avatar-ui-review.test.mjs`.
It uses the bundled console served by `console-fixture.mjs`, synthetic fixture
session authentication (`TEST_TOKEN`, `BOT_A`, `BOT_B`), and Playwright route mocks.
A network guard rejects non-local browser requests. No real provider request,
billing action, account entitlement check, secret access or deployment is involved.

## Reproduction

Build and install dependencies in a temporary **copy** of the repository, not in
the durable workspace. Once the console has been built there:

```sh
node --test scripts/tests/avatar-ui-review.test.mjs
```

The default Chromium executable is `/usr/bin/chromium`; override it with
`CONSOLE_CHROMIUM_PATH` if needed. Screenshots and measurements are written outside
the repository to `/tmp/avatar-ui-evidence` (override with `AVATAR_UI_EVIDENCE`).

## Coverage

- Desktop 1280×900 and touch/mobile 390×844 browser viewports.
- SVG images fetched with the fixture session cookie and `x-timber-client: console`,
  without bearer headers, then displayed as Blob-backed images.
- Transparent vector containers with zero border radius, including the image;
  distinct bot images and no per-bot theme selector.
- Shared-theme selection increments the revision without automatic generation.
- Previous validated images remain visible and stale after a theme switch and
  after a mocked single-bot generation failure.
- A fresh explicit regeneration replaces only Ada's image; Linus's previous
  image remains unchanged and stale. Requests bind the global theme/revision and
  use fresh operation IDs; vector generation does not acknowledge image billing.
- Saved unavailable image theme disables batch and per-bot generation. Expanded
  creation form explains unconfigured Image API, no image dispatch and unknown
  cost rather than silently falling back to SIWC.
- Document and Settings modal horizontal geometry, viewport containment and
  browser exceptions. Vertical modal scrolling is expected for expanded forms.

The mocks exercise console behavior, not backend enforcement or actual model
availability. The SVG fixture deliberately contains angular shapes; computed-style
checks do not prove exhaustive geometric recognition of arbitrary generated paths.

## Local execution results

Executed against the parent's built temporary copy at
`/tmp/timber-avatar-validation` on 2026-10-10:

```text
node --test --test-concurrency=1 scripts/tests/avatar-ui-review.test.mjs
2 passed / 0 failed (desktop and mobile)
```

Log: `/tmp/avatar-ui-review.log`. Browser exceptions and non-local requests were
both zero. `desktop-checks.json` and `mobile-checks.json` contain measured geometry,
mock admission payloads and image request counts (no session-cookie values).

Desktop Settings measured 518px client width / 518px scroll width, within a 1280px
document. Mobile Settings measured 364px client width / 364px scroll width, within a
390px document. The expanded form scrolls vertically; neither layout has document
or modal horizontal overflow. Both shared-theme selection and individual buttons
were reachable using normal Playwright interactions (no forced clicks).

Actual PNG evidence in `/tmp/avatar-ui-evidence`:

- `desktop-conversation.png`, `desktop-settings-shared.png`,
  `desktop-stale-failed.png`, `desktop-single-bot-replaced.png`,
  `desktop-image-unavailable.png`
- `mobile-bot-list.png`, `mobile-conversation.png`, `mobile-settings-shared.png`,
  `mobile-stale-failed.png`, `mobile-single-bot-replaced.png`,
  `mobile-image-unavailable.png`

Visually inspected desktop shared Settings / stale failure and mobile bot list /
shared Settings / unavailable image form via the desktop browser displaying the
actual captured PNGs from a temporary localhost-only evidence server. Transparent
angular avatars, stale dashed square outlines, readable shared-theme controls,
wrapped capability explanation and disabled unavailable-image regeneration were
visible. The evidence server was stopped after review. No avatar-specific UI
blocker was found.

Mobile intentionally hides the conversation header avatar and top-level Settings
button under the existing responsive CSS; avatars remain visible in the bot list
and Settings. The test opens a conversation and returns with “Back to bots” to
reach Settings. Mock terminal successful generation is followed by explicit
Refresh to load replacement metadata; this does not claim live asynchronous
provider execution.

Initial iterations corrected these fixture/navigation assumptions before the
passing run; no application files were changed during this review.
