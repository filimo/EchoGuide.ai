# Changelog

## MacBook audio prototype — 2026-09-20

- Add `/mac-audio` with separate microphone and application capture on macOS 15+.
- Keep source-based speaker roles, per-turn translations and existing reply cards.
- Add native build/self-test, a synthetic two-session API check, and a [setup guide](docs/mac-audio.md).

This file highlights notable user-facing changes to EchoGuide.

EchoGuide is still an early prototype and does not publish tagged releases yet.
Until the first versioned release, changes are grouped by date.

## Unreleased

### Changed

- Support Shift-click transcript ranges and copying selected entries with their available Russian meanings with a single copy button in the compact, single-row transcript toolbar.

- Make the latest transcript button resume automatic scrolling and phrase selection, including meeting mode; selecting a transcript entry pauses following.

- Hide the redundant completed status once a grounded meeting answer is displayed and place saved-answer metadata and generation timings on a compact shared row.

- Move Mac microphone and call application selection into a dismissible audio settings popover; keep selected sources in the toolbar.

- Use a compact desktop workspace with full-height conversation and answer panels, smaller bridge phrases, collapsible turn detection settings, and an accessible regenerate icon in the meeting card header.
- Place the meeting materials mode toggle beside the app name in the header.
- Remove iPad companion and Training Mode labels from the main screen and update microphone setup copy for Mac use.

### Added

- Remember the meeting-with-materials mode toggle across page and browser restarts.

- Remember Audio source, Call application and Mac microphone in this browser. Restore applications by bundle ID using their current process ID; keep unavailable preferences for a later refresh.

- Move session answer export to the top action bar beside Copy transcript.

- Automatically save meeting openings, continuations, sources and timings locally.
  Revisiting a phrase restores its saved answer; explicit regeneration keeps
  previous attempts. Export the session's snapshots as JSON.

- Fix Mac audio stopping after accumulated timer delays: pace both channels by elapsed time and record privacy-safe stop reasons and queue counters.

### Fixed

- Make meeting openings more concrete and spoken continuations more focused.
  Keep hypothetical first steps distinct from personal facts, avoid repeating
  cautious conclusions, and preserve evidence requirements for recommendations.

- Exclude complete known transcription-prompt echoes from generation while retaining
  raw transcript history. Explicit next-question handoffs now focus the opening
  and retrieval on the same utterance. New meeting snapshots record the prepared
  input; legacy answers remain unchanged until explicit regeneration.

- Meeting answers can resolve likely spoken product-name substitutions from
  unambiguous retrieved evidence, while preserving explicit competing topics.

- Spoken meeting help avoids describing document search and uses a short
  fallback without promising a follow-up after the meeting.

- A fast clarification no longer prevents meeting materials from answering
  the selected question. The evidence-backed result replaces that clarification.

- Meeting continuations use shorter spoken sentences and explicitly avoid
  restating the opening in either language. A conservative bilingual guard
  removes repeated opening prefixes; quick openings now request one short sentence.

- Meeting help now starts only when a transcript turn is selected. New speech
  no longer clears or regenerates the pinned answer. The opening remains in
  place while the continuation loads below it. Repeated selection is a no-op.


- Meeting material uploads now accept same-origin HTTP/2 requests from the
  local HTTPS app; foreign origins remain rejected.

### Added

- Meeting cards show time to the opening and total time for retrieval and the
  full answer, measured from request start.

- Training Mode microphone selector with a saved device preference, explicit
  system-default selection when supported, and the connected microphone name.
  Stop live before changing inputs; unavailable saved devices remain visible.

- Opt-in meeting assistant: upload Markdown packs, index them in OpenAI, select
  an active pack, and get one source-backed English answer with Russian meaning.
  Contextual openings and retrieval run in parallel. Missing or conflicting
  evidence produces a polite follow-up phrase; archived packs stay excluded.


- Contextual EN + RU openings in a separate start, continue, or clarify block.
  The quick request uses recent dialogue; the main card receives the displayed
  opening and suggests a continuation. On timeout or failure, the card is
  generated normally. The keep-on-screen button stops following new turns.
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

- Continuous Russian translation now stays in a compact three-line subtitle
  strip. Its rolling text can be opened in a separate drawer without pushing
  the transcript and reply card below the viewport.
- The transcript follows new messages independently from the selected reply
  card. Scrolling the transcript upward pauses that movement until `Latest
  message` is used, while the right-hand card remains on the user's selection.
  The control stays aligned with the transcript title in narrow two-column
  layouts instead of dropping with the secondary actions.
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
