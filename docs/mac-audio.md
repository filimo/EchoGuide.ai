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
3. Select **Call application** and **Mac microphone**. For Meet, select the browser.
   To set input volume first, click **Проверить микрофон** in the source popover,
   speak normally and adjust the system input-volume slider. Stop the test when done.
   To share audio with the ChatGPT macOS app, select a named physical microphone
   rather than `Default`, then click **BlackHole · выкл**. The button shows
   `микрофон` while idle, `микс` during a meeting, or an error state.
   BlackHole 2ch must already be installed. EchoGuide does not change the Mac's default output.
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
- While the BlackHole option is enabled and the local EchoGuide page is open,
  the selected microphone is routed to BlackHole 2ch even before `Start live`
  and after `Stop live`. This idle route does not record audio or use OpenAI.
  Starting a meeting replaces it with a copy of the aligned microphone and
  application chunks as one stereo mix; stopping the meeting restores the
  microphone-only route. EchoGuide's source attribution and two transcription
  sessions stay separate; a BlackHole failure leaves meeting capture running
  and reports an error in the toolbar. Closing EchoGuide or its local server
  stops the idle route.
- In ChatGPT Voice, select BlackHole 2ch as the microphone if that control is
  available. Otherwise select BlackHole as the macOS system input for the Voice
  session. Keep EchoGuide's own microphone set to the named physical device.
  ChatGPT receives a single mixed input and cannot infer EchoGuide's source labels.
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
- Only a loopback client at `localhost`, `127.0.0.1`, or `[::1]`, with a matching Origin
  and the custom request header, can start capture. LAN/iPad requests are rejected.
  One capture session owns the helper at a time. The API key remains in Node.
- Capture start, readiness, queue/chunk counters every ten seconds and the stop reason
  are recorded in `.echoguide/diagnostics/realtime-YYYY-MM-DD.jsonl` with a capture
  session ID. Reasons distinguish queue overflow, sender clock stalls, upstream
  errors/disconnects, native exit, browser backpressure and client/server shutdown.
  BlackHole output reports its own readiness, failure reason, pending bytes and
  backpressure count. Idle routing uses a separate route ID and reports aggregate
  microphone/output counters every 30 seconds. A microphone packet gap over one
  second is logged for either mode. These events contain no audio, transcript,
  microphone ID or application name.
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
npm run mac-audio:build  # compiles/signs and checks 48 kHz stereo → 24 kHz mono PCM
npm run lint
npm run test
npm run build
npm run eval:mac-audio  # paid API check: two synthetic sources, no capture permissions
```

The API check uses macOS `say` and `afconvert`, removes its temporary generated audio,
and prints only pass/fail results. Unit/UI tests cover isolation of the two channels,
silence padding, origin/loopback checks, duplicate completion, concurrent ownership,
bounded buffering, failure cleanup, source roles and cancellation of pending startup.

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
