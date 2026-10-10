# Bot avatar themes

## Included collection

Ten themes ship with Timber. Each separates **style** from an optional
**subject**: Paperfold · Animals, Bauhaus · Robots, Monoline · Animals,
Pixel · Adventurers, Botanical · Forest spirits (SVG); Clay · Animals,
Plush · Monsters, Porcelain · Animals, Watercolor · Animals and Space Toys ·
Robots (PNG). Settings → Bot avatars → Browse 10 included themes shows five
curated examples per theme. These are packaged design examples, not live bot
avatars or evidence that a provider is configured. Opening the gallery never
calls a generation provider.

New structured themes generate **heads only** on transparent backgrounds.
Image requests explicitly set `background: "transparent"`. The console places
the artwork inside a solid circular background using the bot's stable color;
the provider must not bake that circle into the file. SVG markup remains within
the existing passive grammar. The client measures visible alpha coverage to
normalize apparent head size and remove padding differences, then centers each
silhouette with a bound for long ears/antennae. PNG normalization precedes its
96px thumbnail; SVG keeps its original vector bytes and receives viewport placement.
The same optical normalization is used for all 50 gallery examples. Legacy prompt-only themes retain their original
framing. Existing avatars remain visible until a replacement is ready.

Creation accepts `{name,kind,style,subject?,model,reasoningEffort?,operationId}`. An omitted or
blank subject lets the bot's purpose guide its character. Legacy `{prompt}`
requests remain supported, but cannot be mixed with style/subject. The server
composes the rendering prompt and records `framing: "circle"`; clients cannot
claim a built-in preset ID. Built-ins use stable UUIDs and insert-if-absent
seeding on startup, including existing owners, without changing selection,
revision, legacy/custom themes, avatar pointers or job snapshots. A new owner
starts with Paperfold. Previously selected themes remain selected on upgrade.

The five raster contact strips were generated specifically for the collection;
the 25 SVG heads are authored in `scripts/generate-avatar-vector-previews.mjs`.
All preview artwork is served as local static assets under
`/console/avatar-themes/`; no third-party image hosts or credentials are involved.
Regeneration still follows the existing explicit selection, count and API
billing confirmation flow.

## SVG reasoning

Settings → Bot avatars shows a reasoning selector for the selected SVG theme,
including built-ins. The creation form also offers it beneath the model. Options
come from the selected model’s connected catalogue. **Model default** leaves the
effort unset; an explicit value is stored on that theme, independent of bot or
promptbox reasoning. Image themes do not expose this text-model setting.

Save reasoning changes future generations only. It does not regenerate avatars
or alter queued/running jobs, which retain their original theme snapshot. The
provider validates the effort and sends it as Responses `reasoning.effort`; it
never silently downgrades an unsupported level. Concurrent settings edits are
checked against the prior value and operation receipts prevent stale retries
from overwriting newer preferences.

## Product behavior

Avatars use **one global theme per owner**. Settings lets the owner choose a shared
theme and explicitly regenerate all bots or one bot. No bot can override the global
theme. Changing the global theme marks the previous validated avatars stale but
keeps them visible while replacements are generated; a newly generated avatar
replaces the old image only after validation and publication succeed. If generation
fails, the old image remains visible and is identified as stale. SVG artwork has a
transparent background. Structured head themes use a solid circle supplied by the
UI; legacy prompt-only themes retain their original unframed display.

SVG output is generated with the connected OpenAI **text** model through SIWC's
streaming Responses transport using `store:false`. SIWC text model/account discovery
and inference remain unchanged. Image output does not fall back to SVG, SIWC, Workers
AI, or another provider.

Image avatars use the actual OpenAI Image API provider when its server-side API
configuration is present. The catalogue lists only configured official IDs
`gpt-image-2.5-sunburst` and `gpt-image-2.5-flare`; availability is independent of
whether SIWC is connected. Image API usage is billed separately from ChatGPT/SIWC.
The catalogue says explicitly that the cost is unknown; Timber does not invent a
price. The UI asks for explicit confirmation of the exact number of images and the
separate API billing before submitting, sending that count as `confirmedCount`.
Consent also binds `expectedThemeId` and `expectedRevision` from the global selection
snapshot used by the confirmation UI. These are preconditions, not bot/model
configuration overrides. Images require both; vectors check them when supplied
(the console always sends both). Receipt replay precedes mismatch validation, so an
accepted operation can be checked after a switch without any new dispatch. With no
receipt, a stale theme/revision returns 409 before admission/inference and requires
refresh and re-confirmation. An uncertain resend preserves the exact original
payload and operation ID, including the confirmed selection, count and billing.
The runtime reads a server-only `OPENAI_API_KEY` Worker secret. **CI wiring is
pending a separate workflow-authorized change**: this feature branch deliberately
leaves `.github/workflows/**` unchanged because the GitHub App lacks workflows
permission. The original workflow diff and manual application README are preserved
locally outside this repository; they are not part of this commit.

`scripts/configure-avatar-secret.mjs` is a reusable deployment helper, **not invoked
by CI here**. It sends the key to Wrangler `secret put` through stdin only, removes
it from the child environment, captures subprocess output and emits only fixed
messages. Its standalone tests use synthetic values and mocked subprocesses; they
do not prove workflow placement/order or live secret wiring. A separately authorized
operator must wire the GitHub secret environment, stop on helper failure and unset
`OPENAI_API_KEY` before subsequent deployment commands. No production deployment,
account entitlement or real image request was tested. A configured key is a
deployment setting, not proof of account access or pricing. With no configured key,
Image API generation remains unavailable; text/vector provider behavior is unchanged.

Validated prior SVG/PNG blobs are loaded from authenticated endpoints. PNG display
blobs are reduced to 96×96 with browser `createImageBitmap`/canvas and decoded before
replacement; browsers without this support CSS-scale the bounded original. SVG
remains vector, without rasterization. The server returns the original variant,
not a server-generated thumbnail. The cache keeps the current/last decoded image
while replacement loads, evicts superseded URLs after replacement, and clears bot
removal/logout URLs. Recreated settings nodes also retain the prior image on a
failed replacement fetch/decode; switching bots never shows another bot's avatar.

Images use `POST https://api.openai.com/v1/images/generations`, `n:1`, PNG
`1024x1024`, with the server-only `OPENAI_API_KEY` Worker secret. The validator caps
PNG bytes at **1 MiB** (base64 plus snapshots fit the SQLite journal) and dimensions
at 1024px; accepts non-interlaced 8-bit RGB/RGBA, checks chunk CRC/order, exact zlib
scanlines/filter values, removes ancillary metadata and rejects APNG. Transport has
a 30-minute deadline. Oversize/invalid output fails explicitly without replay and
without removing the previous avatar. SVG validation is independently fail-closed;
its passive subset blocks active markup/resources. No validator claims exhaustive
geometric detection of enclosing circles expressed through arbitrary paths.

Candidates are journaled before R2 PUT. Pointer replacement and old-object GC
admission commit atomically; independent durable GC recovers lost PUT receipts.
Deleting A stops its runtime first and does not wait for B's avatar generation.
Receipts are minimal, terminal private snapshots are cleared, and status/next-time
queries are indexed. Uncertain inference is interrupted, never automatically billed
again; journaled validated output can recover publication without another call.

Official references: [Sunburst](https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst),
[Flare](https://developers.openai.com/api/docs/models/gpt-image-2.5-flare), and
[image-generation guide](https://developers.openai.com/api/docs/guides/image-generation).

## Verification boundaries

UI tests mock catalogues, authenticated image requests and generation. They do not
prove real OpenAI API billing, production secret wiring, a live image generation or
cloud deployment. A mocked successful response is not provider/account availability.
No deployment, push, merge or real billing action is part of this work. The feature
is prepared as a local commit only; production secret wiring remains deferred.
