# Changelog

This file highlights notable user-facing changes to EchoGuide.

EchoGuide is still an early prototype and does not publish tagged releases yet.
Until the first versioned release, changes are grouped by date.

## Unreleased

### Added

- A public changelog linked from the project README.
- Training Mode can add missed transcript messages manually, edit recognized
  messages with an explicit speaker role, restore the original recognized text,
  and generate a replacement phrase card from the correction.
- Training Mode keeps a 60-second microphone buffer in memory during a live
  session and can recover the latest 30 seconds through a separate transcription
  request. Recovered text opens in the existing message editor for confirmation.

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
- Recovery status and errors remain visible near the live controls, and a recovered
  phrase scrolls its review editor into view.
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
