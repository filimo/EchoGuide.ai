# MacBook audio prototype

EchoGuide can capture a selected macOS application's output and a microphone as
separate sources. Microphone turns are labeled `Me`; application turns are labeled
`Interviewer` internally and “Собеседники” in the live UI. This identifies the side
of the call, not individual remote participants.

## Run

Requires macOS 15+, Xcode Command Line Tools (`swiftc`), Node.js 20+, and the
existing local OpenAI configuration. On this prototype, both the server and browser
must run on the same Mac.

```bash
npm install
npm run mac-audio:build
npm run dev
```

Use the existing development server if one is already running. Open
`https://localhost:5173/mac-audio` (use the port printed by Vite).
The direct route opens Training Mode without requiring the iPad setup microphone.
It does not start capture automatically. The normal setup screen also links here.

1. Wear headphones and open the call application.
2. Click **Refresh Mac sources**. Grant the macOS capture permission if requested.
3. Select **Call application**. For Meet, select the browser. Mac capture currently
   uses **System default microphone** to avoid native device enumeration triggering
   a system-wide audio hang. Select a physical input in macOS Sound settings, not
   a Loopback mix, to preserve source roles. If an old microphone preference is
   unavailable, explicitly choose **System default microphone**.
   To set input volume first, click **Проверить микрофон** in the source popover,
   speak normally, then click **Показать системный уровень входа** if you need the
   system input-volume slider. Stop the test when done.
4. Select the speech language; use **English + Russian** for bilingual conversation.
5. Click **Начать встречу** and choose **С подсказками и расшифровкой** to start capture, transcription and local audio recording, or **Только записать аудио** for local capture without OpenAI transcription. Allow microphone access if macOS requests it.
6. Check both source meters. Completed turns appear with their source labels;
   per-turn Russian translations and existing phrase cards remain available.
7. Stop the active run to end native capture and finalize the recording. In live mode this also closes both paid transcription sessions. Play audio from **Sessions → Аудиозаписи**.

If permission is denied, open macOS **System Settings → Privacy & Security** and
allow **Screen & System Audio Recording** and **Microphone** for **EchoGuide Audio**
or the host application named in the permission prompt. Follow any requested
restart, then refresh sources. The helper is a locally ad-hoc-signed `.app` under
`.echoguide/native/`; rebuilding it may require reviewing permission again.

## Data path and lifecycle

`ScreenCaptureKit → Swift PCM conversion → private stdout pipe → local Node server
→ two OpenAI transcription WebSockets → same-origin streamed response → TrainingLivePanel`.

- The helper opens no port, receives no API key and writes no recordings. It emits
  signed 16-bit mono PCM at 24 kHz in memory. Video frames are neither consumed nor
  stored; ScreenCaptureKit supplies the selected application's audio.
- The server sends separate 100 ms PCM chunks for each source, filling missing
  audio with silence so VAD can complete turns when application playback stops.
  The sender uses elapsed monotonic time, so late timer callbacks do not accumulate
  an ever-growing queue. Audio received before native capture is ready is
  discarded. Buffers remain bounded; a queue backlog over three seconds or an
  overloaded transport stops rather than silently dropping speech.
- Loading or reloading the page does not query native audio devices or start
  capture, including when Mac mode was saved previously. Open
  the source settings or click **Refresh Mac sources** to load devices and input
  volume. Source listing only enumerates applications; system volume is read
  separately via **Показать системный уровень входа**. **Проверить микрофон** starts the explicit preview test.
- The source meters use the same dBFS scale for microphone and application RMS.
  Green is a working speech range, amber is loud, and red warns when a sample peak
  is close to clipping. Hover over a meter to see RMS and peak separately. A low
  microphone reading can indicate input gain, microphone placement or the wrong
  device; the meter does not adjust the audio sent for transcription or recording.
- Audio settings show the selected microphone's macOS input volume when the device
  exposes a writable Core Audio control. Changing it affects that device system-wide,
  including other apps. Some devices provide only hardware or vendor controls.
- The microphone test uses the selected native device and sends only RMS and peak
  measurements to the local UI. It does not capture application audio, start an
  OpenAI session, or save audio. Closing the popover stops the test.
- The existing `OPENAI_REALTIME_TRANSCRIPTION_MODEL` is reused. Each source uses
  its own paid session and fixed `server_vad` with the existing default 1.2 s pause.
  The model is not changed by this feature.
- `item_id` is used to deduplicate completions. VAD offsets and the shared local
  capture start provide approximate turn timestamps; they are not word timestamps.
  Completed source turns are sorted by these timestamps, even when results arrive late.
- Microphone speech updates context and cancels obsolete automatic suggestions;
  it does not trigger a new automatic reply. Later application questions can do so.
  Explicit source roles are retained instead of being overwritten by model inference.
- Existing meeting-material mode remains opt-in and uses explicitly selected turns.
- Disconnecting the browser request, cancelling startup, stopping live mode, opening
  a different saved session, or leaving the screen closes both upstream sessions and
  terminates the helper. A helper error also closes the whole capture session.
  After capture starts, an upstream error disables that transcription channel
  while local capture and recording continue until the meeting is stopped.
- Stop/cancel sends SIGTERM to the helper and escalates to SIGKILL after two seconds
  if it has not exited. New native requests receive a retryable conflict until
  process closure is confirmed; sending a signal alone does not release ownership.
  This also applies to timed-out source/volume requests and microphone previews.
  `mac_audio.stopped` records the stop request; `mac_audio.helper_exited` confirms
  capture-helper closure. An unkillable helper keeps new starts blocked.
- The helper watches its owning server on an independent dispatch queue installed
  before audio calls. Owner death exits even if the main thread is blocked during
  device setup. This protects input-volume helpers as well as capture and previews.
- After readiness, ten seconds without microphone PCM stops capture and finalizes
  its recording as interrupted. Silent PCM is valid; application audio may be idle
  without causing a timeout. A microphone preview uses the same deadline for missing
  level measurements. These guards detect delivery failure, not a specific driver
  fault, and do not restart Core Audio or change installed drivers.
- Only a loopback client at `localhost`, `127.0.0.1`, or `[::1]`, with a matching Origin
  and the custom request header, can start capture. LAN/iPad requests are rejected.
  One capture session owns the helper at a time. The API key remains in Node.
- Capture start, readiness, queue/chunk counters every ten seconds and the stop reason
  are recorded in `.echoguide/diagnostics/realtime-YYYY-MM-DD.jsonl` with a capture
  session ID. Reasons distinguish queue overflow, sender clock stalls, upstream
  errors/disconnects, native exit, browser backpressure and client/server shutdown.
  Native meeting capture reports safe stages: process entry, main actor,
  shareable content, microphone permission/device lookup and stream creation/start.
  A microphone packet gap over one second is logged. These events contain no audio,
  transcript, microphone ID or application name.
- Raw audio and transcripts are not written to diagnostic logs. Existing local session
  history still saves text, roles and optional source/timestamp metadata under `.echoguide/`.
- The Node server also saves a mixed stereo WAV: both voices in both channels.
  Recording errors do not stop transcription. See [session recording](session-recording.md).

## Prototype limits

- Application capture includes all audio from that application, including other
  browser tabs. Close or mute unrelated tabs. It does not identify individual speakers.
- Headphones are recommended: speaker playback can leak into the microphone.
  This prototype does not implement cross-channel echo cancellation.
- In this mode, audio recovery, manual/semantic VAD controls and the optional continuous
  translation sidecar are unavailable. Per-turn translation and reply cards work.
- Device disconnection, sleep/wake and permission changes can require restarting live
  mode. There is no automatic reconnection or packaged installer yet.
- A real Meet/Teams call is still required to evaluate actual audio quality, latency,
  permissions and overlapping speech. Synthetic checks do not establish these results.

## Verification

```bash
npm run mac-audio:build  # compiles/signs, checks PCM and owner-death cleanup
npm run lint
npm run test
npm run build
npm run eval:mac-audio  # paid API check: two synthetic sources, no capture permissions
```

The API check uses macOS `say` and `afconvert`, removes its temporary generated audio,
and prints only pass/fail results. Unit/UI tests cover isolation of the two channels,
silence padding, origin/loopback checks, duplicate completion, concurrent ownership,
bounded buffering, failure cleanup, source roles and cancellation of pending startup.
The native build also runs `scripts/test-mac-audio-watchdog.mjs`: a synthetic
supervisor is killed while the helper blocks its main thread in a test-only branch.
The helper must exit independently. Neither this check nor the PCM self-test opens
an audio device. Real audio quality and driver recovery still require a manual call.

API references: [Apple ScreenCaptureKit](https://developer.apple.com/videos/play/wwdc2024/10088/),
[OpenAI transcription](https://developers.openai.com/api/docs/guides/realtime-transcription),
[OpenAI WebSockets](https://developers.openai.com/api/docs/guides/voice-websockets).

## Remembered audio sources

Audio source, Call application and Mac microphone are saved automatically in this
browser for the current site address. Opening Mac audio refreshes the source list
and resolves the saved application bundle ID to its current PID. Process IDs are
not saved. Capture still starts only through the meeting start menu.

If the application is closed, open it and click Refresh Mac sources. Missing
applications and microphones keep their saved preferences; capture stays disabled
until both sources are available or replacements are selected. Multiple running
instances with the same bundle ID require an explicit selection. Applications
without a bundle ID can be selected for this session but cannot be restored.

### Isolating a native startup hang

For local diagnosis only, the helper accepts `--diagnose-application-only` or
`--diagnose-microphone-only` after `--capture <pid> default`. These flags disable
one source in ScreenCaptureKit without changing normal meeting behavior. Do not
forward or save raw helper audio output; inspect only stages and aggregate chunk
counts. Test from a recovered audio-service state, with Loopback closed. A closed
Loopback UI does not uninstall its ARK driver.
