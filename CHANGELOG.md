# Changelog

This file highlights notable user-facing changes to EchoGuide.

EchoGuide is still an early prototype and does not publish tagged releases yet.
Until the first versioned release, changes are grouped by date.

## Unreleased

### Added

- A public changelog linked from the project README.
- Completed transcript turns now show their Russian meaning directly beneath
  the English text, including a compact translation-in-progress state while the
  dedicated low-latency `gpt-5-nano` translation request is running. Full phrase
  cards continue to use the separately configured bilingual model.
- Training Mode now has an independent, opt-in live Russian subtitle block. It
  sends the active microphone track through a second WebRTC connection to
  `gpt-realtime-translate`, appends continuous translation deltas, and leaves
  translated audio muted so the existing conversation audio stays unchanged.
- Training Mode can regenerate the current phrase card from a short `My point`
  hint in Russian or English. The hint stays attached to that card and grounds
  the generated replies without changing global pasted notes.
- Training Mode can add missed transcript messages manually, edit recognized
  messages with an explicit speaker role, restore the original recognized text,
  and generate a replacement phrase card from the correction.
- Training Mode keeps a 60-second microphone buffer in memory during a live
  session and can recover the latest 30 seconds through a separate transcription
  request. Recovery now shows all detected phrases from that audio together;
  selecting one opens the existing message editor, while the list remains
  available for another choice or refresh.

### Changed

- Automatic phrase analysis now waits briefly and combines rapid transcript
  fragments into one request. Stable instructions and pasted notes use an
  explicit prompt-cache boundary, recent context is smaller, and local
  diagnostics record privacy-safe token and cache counters.
- Realtime and recovery transcription prompts are now topic-neutral and preserve
  brief, informal, and incomplete speech instead of assuming a software
  interview.
- Suggested interview replies now favor natural spoken English, answer direct
  questions directly, and use a short situation-action-result structure only
  when the question and available facts call for it.

### Fixed

- Recovery audio now starts before Realtime signaling and keeps an explicit
  `Enable recovery` action active until local audio chunks arrive, including when
  iPad WebKit suspends the local AudioContext.
- Recovery status and errors remain visible near the live controls, and a selected
  recovered phrase scrolls its review editor into view.
- An unexpected microphone or WebRTC transport stop now releases the stale live
  session immediately, so Training Mode can be restarted without an extra
  `Stop live` action.

## 2026-07-13

### Added

- Local-server persistence for `Pasted notes`, so personal context survives a
  page reload in the local prototype.

### Changed

- OpenAI Realtime, transcription, phrase-card, and evaluation models can now be
  selected through environment variables instead of source-code edits.

### Fixed

- A normal `Stop live` action no longer leaves a misleading Realtime error in
  the Training Mode interface.

## 2026-07-12

### Added

- The first public runnable EchoGuide prototype with bilingual Training Mode,
  OpenAI Realtime transcription, phrase cards, local session history,
  diagnostics, tests, and model evaluation.
- An animated product walkthrough covering the main setup and Training Mode
  flow.
- The MIT License.
