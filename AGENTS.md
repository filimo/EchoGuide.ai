# Agent guide

## Start here

- Read `README.md` for product positioning and public setup.
- Read `docs/product.md` for the MVP boundary.
- Read `docs/architecture.md` before changing Realtime, analysis, storage, or diagnostics.
- Read `docs/model-evaluation.md` before changing the phrase-card model or prompt contract.
- Read `docs/local-development.md` for HTTPS and iPad validation.

## Repository shape

EchoGuide is an early runnable Vite + React + TypeScript prototype. The main Training Mode uses microphone audio, OpenAI Realtime transcription over WebRTC, bilingual phrase analysis, concise reply suggestions, and local session history. `/realtime-lab` is a development-only diagnostic surface.

## Commands

```bash
npm install
npm run dev:cert
npm run dev
npm run test
npm run lint
npm run build
npm run smoke
npm run eval:models
```

## Safety boundaries

- Never commit `.env*`, API keys, local certificates, `.echoguide/`, transcripts, raw audio, or personal knowledge files.
- Keep the browser on ephemeral Realtime credentials; never expose the server API key to client code.
- Diagnostics may contain transport states and aggregate counters, but not transcript text, notes, knowledge context, audio, or credentials.
- Treat the Vite API plugin as development-only. Do not present it as a production backend.

## Working agreement

- Make the smallest change that preserves the documented product boundary.
- Add or update tests with behavioral changes.
- Update `CHANGELOG.md` in the same change when users would notice the new
  feature, behavior change, or fix. Keep internal refactors and test-only work
  out of the changelog.
- Run the relevant validation commands before reporting completion.
- Write git commit messages in English unless the user explicitly requests another language.
- Keep public documentation in English.

- Meeting retrieval synthetic API eval: `npm run eval:meeting` (creates and removes synthetic cloud resources).

## Mandatory pre-commit language review

- Before every commit or amend, inspect the staged diff against this public
  repository's rules. Passing tests and secret checks do not replace this review.
- Review all added documentation prose, changelog entries, code comments and
  configuration comments for English, including `.env.example` comments.
- Run `git diff --cached --unified=0 -- . ':!package-lock.json' | rg '^\+[^+].*[А-Яа-яЁё]'`.
  A match requires inspecting and classifying that line before committing;
  no matches produce exit code 1 from `rg`, which is expected.
- Translate Russian documentation prose and explanatory comments. Preserve
  intentional Russian translations, bilingual product content, test fixtures,
  and exact UI labels quoted by documentation. Do not silently treat all
  Cyrillic matches as exceptions; explain retained categories in the handoff.
- Verify the commit message is English. Report the language review alongside
  other checks. This review is mandatory even for a configuration-only commit.

## Mac audio prototype

- Read `docs/mac-audio.md` before changing native capture or source attribution.
- `npm run mac-audio:build` compiles the macOS 15+ helper and runs a PCM self-test.
- `npm run eval:mac-audio` checks two paid Realtime sessions with synthetic speech only.
- `/mac-audio` requires loopback access; never weaken the Origin/header checks or mix the two audio sources.
