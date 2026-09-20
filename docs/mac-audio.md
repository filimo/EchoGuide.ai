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
4. Select the speech language; use **English + Russian** for bilingual conversation.
5. Click **Start live**. Allow microphone access if macOS requests it.
6. Check both source meters. Completed turns appear with their source labels;
   per-turn Russian translations and existing phrase cards remain available.
7. Click **Stop live** to stop native capture and both paid transcription sessions.

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
  an ever-growing queue. Buffers remain bounded; a stall over one second or an
  overloaded transport stops rather than silently dropping speech.
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
  terminates the helper. A helper/upstream error also closes the whole capture session.
- Only a loopback client at `localhost`, `127.0.0.1`, or `[::1]`, with a matching Origin
  and the custom request header, can start capture. LAN/iPad requests are rejected.
  One capture session owns the helper at a time. The API key remains in Node.
- Capture start, readiness, queue/chunk counters every ten seconds and the stop reason
  are recorded in `.echoguide/diagnostics/realtime-YYYY-MM-DD.jsonl` with a capture
  session ID. Reasons distinguish queue overflow, sender clock stalls, upstream
  errors/disconnects, native exit, browser backpressure and client/server shutdown.
- Raw audio and transcripts are not written to diagnostic logs. Existing local session
  history still saves text, roles and optional source/timestamp metadata under `.echoguide/`.

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
not saved. Capture still starts only with Start live.

If the application is closed, open it and click Refresh Mac sources. Missing
applications and microphones keep their saved preferences; capture stays disabled
until both sources are available or replacements are selected. Multiple running
instances with the same bundle ID require an explicit selection. Applications
without a bundle ID can be selected for this session but cannot be restored.
