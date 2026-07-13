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
