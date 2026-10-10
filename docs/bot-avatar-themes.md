# Bot avatar themes

## Product behavior

Avatars use **one global theme per owner**. Settings lets the owner choose a shared
theme and explicitly regenerate all bots or one bot. No bot can override the global
theme. Changing the global theme marks the previous validated avatars stale but
keeps them visible while replacements are generated; a newly generated avatar
replaces the old image only after validation and publication succeed. If generation
fails, the old image remains visible and is identified as stale. SVGs have a
transparent background and are not displayed in circular frames.

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
