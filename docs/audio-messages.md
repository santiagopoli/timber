# Audio messages

Audio messages retain the original recording in private, bot-scoped R2 storage.
Transcription is a separate, explicitly billed OpenAI API request; it does not use
ChatGPT subscription allowance or another provider as a fallback. The server uses
its existing `OPENAI_API_KEY`; no credential is returned to the browser.

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

The composer displays the separate API billing notice before Send. A successful
transcription starts normal bot work, which retains that bot's existing inference
billing settings. An explicit transcription retry may incur another charge,
including if an earlier request's outcome was uncertain.

**Production entitlement is not verified.** Documentation of a model does not
prove this deployment's API project has billing credit, model access or quota.
Local verification must use mocked OpenAI responses; no paid inference is needed
to run the feature's tests. No deployment or secret changes are part of this work.

## User interaction and privacy

The original audio remains playable even when transcription fails. Transcripts
are machine-generated and can contain errors; users can expand them independently
of playback. A failed or empty transcription is never substituted with invented
text and never sends an empty prompt to the bot.

Microphone permission is requested only after an explicit Record action, never on
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

## Verification of this change

Local verification completed on **2026-10-11**, with no paid provider requests:

- Root `npm run typecheck`: passed (API, shared contracts, tests and console).
- Production console build: passed, with output kept outside the repository.
- Targeted backend aggregate: **145/145 tests across 15 suites**, covering all
  audio suites plus API/security, owner sessions, inbox/model admission, image
  attachments, tasks, agent messaging and console assets.
- Playwright audio and microphone lifecycle: **9/9**, desktop and mobile.
  Includes a real-sample 31-second PCM waveform, playback/seek/pause, original
  audio on pending/failure, transcript controls, billing and explicit retry.
- Native Chromium MediaRecorder regression: **3/3 serial repeats**. It encodes a
  synthetic oscillator stream with the real browser recorder, validates the exact
  resulting WebM bytes, uploads those same bytes, and plays/seeks/pauses them.
  Permission races and recorder errors use controlled browser mocks; a physical
  microphone or actual OS permission prompt was not tested.
- Existing desktop/mobile image-composer UI regression: **6/6**, including
  dark/light layout and narrow 320 px controls.
- Independent targeted security review: no remaining known critical blockers.
- Script syntax checks and `git diff --check`: passed.

This is not a claim that the entire repository's runtime/computer suite or a
production smoke test ran. Deployment, project entitlement, real OpenAI billing
and physical-device/browser coverage remain unverified.
