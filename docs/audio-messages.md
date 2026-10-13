# Audio messages and draft dictation

Audio messages retain the original recording in private, bot-scoped R2 storage.
Transcription is a separate, explicitly billed OpenAI API request; it does not use
ChatGPT subscription allowance or another provider as a fallback. The server uses
its existing `OPENAI_API_KEY`; no credential is returned to the browser.

## Two explicit destinations

The single primary **Dictate text** microphone sits beside **+ / Send** in the
existing compact toolbar, in both bot and task composers. Starting it explicitly
selects text transcription; its contextual tooltip discloses separate API billing.
**Stop recording** releases the microphone, validates the recording, and transcribes
immediately into the editable draft, without a review row, mode selector or modal.
It never sends a message. Existing text and selected words are preserved, as are
concurrent edits and opaque private-input references. Enter inserts a newline;
only explicit **Send** submits the user-edited text. Dictation creates no audio
conversation card, message, submission or run. Active status, Cancel and errors
are contextual; no permanent format/billing disclaimer expands the idle composer.

For a bot conversation, the existing **+** menu also provides **Attach audio** and
secondary **Record audio**, alongside its existing image and secure-input actions.
These create a local voice-note attachment with playback. Only the toolbar's
explicit **Send audio** and separate paid-send consent send an audio message; Stop
alone never sends. Tasks do not support audio messages and expose only primary
text dictation. Both destinations reuse validated capture/upload machinery,
not their durable destination.

Draft dictation results stay scoped to the original bot/task/navigation/session.
Cancel and Stop immediately release capture and abort pending transport where
possible; late results cannot insert into another composer or resurrect work.
Operation cancellation has a permanent server tombstone, independently of upload
discard. A known cancelled receipt contains no transcript. Draft receipts and
originals expire after 24 hours; task deletion removes its separate recording
prefix without touching main or sibling artifacts. Paid dispatch may already
have happened when an HTTP abort occurs. **Check transcription status** only
reads the same operation/attempt; it never automatically starts another paid
attempt, even after an uncertain response or a later missing receipt.

## Provider contract and billing

Documentation checked **2026-10-11** (public documentation only):

- [GPT-4o Mini Transcribe](https://developers.openai.com/api/docs/models/gpt-4o-mini-transcribe.md)
  lists exact ID `gpt-4o-mini-transcribe`, default snapshot
  `gpt-4o-mini-transcribe-2025-12-15`, and support for `v1/audio/transcriptions`.
- [Transcription endpoint](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create.md)
  confirms the exact multipart endpoint and JSON transcript response.
- [File transcription](https://platform.openai.com/docs/guides/speech-to-text)
  documents multipart file transcription and a provider upload limit of 25 MB.
  The guide lists `gpt-4o-mini-transcribe` and `gpt-4o-transcribe`; this feature
  intentionally uses the smaller model, without fallback.
- [Pricing](https://developers.openai.com/api/docs/pricing.md) publishes an
  estimated **$0.003/minute** for `gpt-4o-mini-transcribe` (audio-token input
  $1.25/million and output $5/million). This is a provider estimate, not a fixed
  quote or a promise of the total bot-run cost. Rates and account terms can change.

The composer displays the separate API billing notice before Send. For an explicitly sent audio message, a successful
transcription starts normal bot work, which retains that bot's existing inference
billing settings. An explicit transcription retry may incur another charge,
including if an earlier request's outcome was uncertain.

**Production entitlement is not verified.** Documentation of a model does not
prove this deployment's API project has billing credit, model access or quota.
Local verification must use mocked OpenAI responses; no paid inference is needed
to run the feature's tests. No secret changes or paid calls are needed for fixture verification. Deployment
evidence is reported separately.

## User interaction and privacy

The original audio remains playable even when transcription fails. Transcripts
are machine-generated and can contain errors; users can expand them independently
of playback. A failed or empty transcription is never substituted with invented
text and never sends an empty prompt to the bot.

Microphone permission is requested only after an explicit Dictate text or Record audio action, never on
page load. Recording stops and its tracks are released when discarded, completed,
or when leaving that conversation. Late permission grants after leaving release
the acquired tracks without starting capture. Concurrent permission requests are
fenced; recorder errors and the 20 MB recording limit discard the failed capture.
Unsupported recording/browser decoding is
reported honestly. File input remains available without microphone permission.

Waveform bars are derived from actual audio samples, not generated decoration.
Validated PCM16 WAVs are sampled directly across the accepted upload envelope,
with a bounded 200,000-frame sample budget. Compressed waveform decoding requires
complete structural preflight and is limited to 2 MB, 30 seconds and an estimated
32 MB decoded float buffer, with a bounded serialized decoder queue. Larger
compressed clips retain playback and seeking without a fabricated waveform.
When browser decoding is unavailable, the player reports that limitation instead
of displaying fabricated peaks. Audio playback uses authenticated private bytes,
never public R2 URLs, and temporary object URLs are released when no longer used.

## Supported upload subset

The feature accepts at most **20,000,000 bytes** and **10 minutes** of audio.
This is intentionally stricter than OpenAI's file limit:

- **WAV:** RIFF/WAVE PCM signed 16-bit, mono or stereo, 8–192 kHz. Frame alignment,
  RIFF/chunk boundaries and declared byte rate must agree with the data bytes.
- **MP3:** complete MPEG Layer III frame streams, one stable sample rate/channel
  configuration; optional bounded ID3 metadata. Protected/CRC streams, free-format,
  truncated reservoir-dependent beginnings, Xing/Info/VBRI gapless/seek headers,
  and ambiguous/trailing data are rejected. Not every `.mp3` file is supported.
- **WebM:** a conservative audio-only Opus recording subset with one mono/stereo
  track, bounded packet framing, monotonic packet starts and supported EBML
  elements. Benign recorder clock jitter may overlap packet ends. Duration bounds
  cover both accumulated Opus samples and the maximum observed packet end.
  Optional container duration tags must be bounded and consistent within one
  actual packet plus codec delay and one timestamp tick; they are never trusted
  as the duration authority.
  Unsupported lacing, codecs, video tracks, unvalidated index/seek structures or malformed
  packet boundaries fail closed. Browser recording support varies.

**M4A/MP4 and Ogg are not offered in this release.** Their names/extensions are
not evidence of safe duration or provider compatibility. Convert unsupported
files externally to a supported format; Timber does not silently transcode them
or send unsupported bytes to a billed provider request.

## Safety and recovery

Uploads are immutable by client UUID and content fingerprint. Authentication and
live bot-registry membership are required before upload, lookup, transcription,
retry, or download. Audio downloads recheck membership after the R2 lookup
before returning bytes. References from another bot cannot be used. Uploaded data is
validated with MIME and format structure before it is sent to OpenAI; untrusted
client duration is not the server's safety boundary. Unsupported containers and
codecs are rejected explicitly rather than silently transcoded.

Transcription dispatch is journaled durably before network I/O. Replaying the same
message or attempt ID cannot create another paid inference. A crashed, interrupted
or lost provider response is uncertain and is not automatically retried. The
owner may explicitly authorize a new attempt with a new attempt identity after
seeing the billing warning. Successful transcripts are delivered under a stable
normal input operation identity, so native inbox recovery and busy-bot steering
apply without duplicate transcript messages or cancelling existing work. Bot
removal fences late transcription completions and removes its audio bytes with
its other private artifacts.

## Local verification commands

`npm run test:audio` runs bounded parser, authenticated journal/admission/scope/CSP
checks followed by a console build and mocked Playwright audio scenarios. For a
system Chromium install, set `CONSOLE_CHROMIUM_PATH` as in the existing console
test setup. No provider inference is performed by these tests. Browser tests use
real WAV samples, real Chromium media playback and real Chromium MediaRecorder
encoding; backend routes are mocked. Separate lifecycle tests cover microphone
permission races, recorder errors and bounded capture cleanup.

## Draft cleanup and cancellation

A durable bot-scoped upload candidate is journaled and flushed before any R2
write. Upload, admission, discard and cleanup serialize per audio identity.
Unreferenced drafts expire after 24 hours; expiry fences admission even before
the bounded 32-item cleanup runs. R2 failures keep a recoverable deletion journal
and retry wake; a conflicting non-audio artifact is terminal and never deleted.
DELETE creates a permanent identity tombstone and retains one final 24-hour sweep
for an uncertain late write. Admitted audio, even with pending
or failed transcription, cannot be discarded through this draft route. Artifact
reads consult the tombstone as well as the live registry, so a late uncertain R2
write cannot make a discarded original visible again.

The console aborts remaining PUT/POST stages on cancellation or navigation. Abort
is not proof that durable admission failed. A mounted cancelled draft retains its
IDs and only an explicit send inspects the existing receipt before submission.
Navigation reconciles canonical messages rather than replaying audio or paying
for another attempt. Logout and lost-page cleanup rely on the durable TTL.

Microphone capture prefers WebM Opus; a browser without it captures bounded mono
PCM16 WAV at no more than 16 kHz through native Web Audio. MP4 is never relabeled
or admitted. Tracks, processors and contexts stop on discard, Stop run,
navigation, hidden page, logout and unmount. Stop fences a pending microphone
permission even before the run-cancellation response arrives. Safari hardware/OS permission testing is separate from
synthetic-signal tests in the WebKit engine.

## Delivery verification

See the PR/delivery report for checks on the integrated tree and exact main/CI/
production deployment evidence. Earlier branch-local checks are not proof of the
current integrated tree. No fixture or browser test makes paid provider calls.
Physical iPhone microphone/OS permissions and live transcription billing remain
outside this fixture-based delivery verification.
