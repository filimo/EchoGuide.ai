# Phrase-card model evaluation

## Decision

EchoGuide evaluates text models against the real `transcript -> bilingual phrase card -> suggested replies` contract instead of selecting a model from generic benchmarks.

The current default remains `gpt-5.6-luna` with `reasoning.effort: "none"`. A September 23, 2026 synthetic comparison favors `gpt-6-luna` as the next phrase-card candidate, but the shared meeting-assistant model setting and live latency still need validation. Realtime transcription remains a separate `gpt-4o-transcribe` path.

The runtime values are configured in `.env.local` through `OPENAI_BILINGUAL_MODEL`
and `OPENAI_BILINGUAL_REASONING_EFFORT`. Realtime transcription uses
`OPENAI_REALTIME_TRANSCRIPTION_MODEL` and `OPENAI_REALTIME_WHISPER_MODEL`.
Missed-phrase recovery is configured separately through
`OPENAI_RECOVERY_TRANSCRIPTION_MODEL` because it uses a bounded file request
instead of the live Realtime session.
`.env.example` contains the current defaults.

Model availability, preview status, and pricing can change. Re-run the evaluation before treating this choice as a production default.

## Reproduce the comparison

```bash
npm run eval:models
```

The runner reads `OPENAI_API_KEY` from `.env.local` and writes detailed local results under the ignored `.echoguide/evals/` directory. It does not print or persist the key.

Candidate models, judge model, and judge reasoning effort are configured through
`ECHOGUIDE_EVAL_MODELS`, `ECHOGUIDE_EVAL_JUDGE_MODEL`, and
`ECHOGUIDE_EVAL_JUDGE_REASONING_EFFORT`.

## Fixtures

Each candidate receives the same nine synthetic, privacy-safe scenarios:

1. a direct interviewer question about the user's role;
2. a short draft answer without an outcome;
3. a Russian draft answer;
4. a coherent thought assembled from several transcript fragments;
5. a noisy, incomplete utterance where facts must not be invented;
6. a technical challenge with bounded factual context.
7. a direct weakness question that should not be forced into a STAR template;
8. a pressure question about AI use that requires a direct, honest answer.
9. an interviewer question whose replies must follow an explicit card-local
   answer hint without inventing supporting details.

## Scoring

The score combines two layers:

- **30% mechanical contract:** question classification, two or three replies, short bridge phrase, compact labels, one to three conversational sentences within 45 words, translations, and `whyUse` guidance;
- **70% blind quality judge:** factual grounding, interview usefulness, natural A2/B1 English, coherent-thought selection, and Russian-layer quality.

Candidate identities are hidden behind rotating keys to reduce position bias.

## Recorded result

### September 23, 2026 candidate check

The current nine-case contract was run once with `gpt-5.6-luna`, `gpt-6-luna`, and `gpt-6-sol`, using the existing blind `gpt-5.5` judge. All 27 candidate requests succeeded.

| Model | Average score | Wins | Mean latency | p95 latency | Output tokens |
| --- | ---: | ---: | ---: | ---: | ---: |
| `gpt-6-luna` | **94.3** | **6 / 9** | **3.73s** | 6.54s | 2,060 |
| `gpt-5.6-luna` | 92.6 | 3 / 9 | 4.10s | 6.38s | 2,510 |
| `gpt-6-sol` | 91.4 | 0 / 9 | 3.74s | 4.75s | 2,037 |

The scores come from one synthetic run, not real interview audio. GPT-6 Luna lost the noise and AI-use pressure cases to the current default. Its current list price is $0.10 per million input tokens and $0.50 per million output tokens, compared with $0.20 and $1.20 for GPT-5.6 Luna. See the [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna) and [GPT-5.6 Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna) model pages.

The separate seven-case quick-start check gave GPT-6 Luna two 3.5-second timeouts on the first run and none on the repeat; GPT-5.6 Luna passed all seven in its run. Keep quick start on the current default until its timeout behavior is measured in live use. The meeting assistant reads `OPENAI_BILINGUAL_MODEL`, so changing that setting also changes meeting answers; validate that path before switching the shared default.

The detailed phrase-card run is in the ignored local file `.echoguide/evals/model-comparison-2026-09-23T05-40-51-321Z.json`.

### Earlier comparison

The recorded comparison below used the earlier, stricter sentence-shape contract.
Re-run the evaluation before using these scores to compare models under the current
natural spoken-answer prompt.

Two runs on July 11, 2026 produced the following comparison:

| Model | Overall | Judge | Average latency | Wins | Estimated cost for 6 candidate calls* |
| --- | ---: | ---: | ---: | ---: | ---: |
| `gpt-5.6-luna` | **90.7** | **88.4** | **2.65s** | **7 / 12** | **$0.0155** |
| `gpt-5.6-sol` | 87.4 | 81.9 | 5.04s | 4 / 12 | $0.0854 |
| `gpt-5.4-mini` | 85.3 | 81.2 | 3.22s | 1 / 12 | $0.0134 |
| `gpt-5.6-terra` | 85.3 | 79.7 | 3.25s | 0 / 12 | $0.0441 |

\* Excludes judge calls. The estimate uses the observed token mix and public prices available on the evaluation date.

## Observations

- `gpt-5.6-luna` most consistently preserved a concise answer style and used fewer output tokens.
- `gpt-5.6-sol` performed well on the hardest technical scenario but was slower, more expensive, and more likely to add plausible unsupported details.
- `gpt-5.6-terra` did not outperform the lower-cost option under this prompt contract.
- `gpt-5.4-mini` handled one noisy scenario well but violated compactness constraints more often.

### Card-local answer hint regression

A targeted July 15, 2026 run added the ninth `card-local-answer-hint` case and
checked the current `gpt-5.6-luna` default without repeating the full four-model
comparison. The new case scored **97.2** overall with a **96** blind-judge score
and 2.54-second latency. The first reply preserved both supplied facts in compact
spoken English: the prototype used the slower standard mode, while Generation
mode is about 50% faster. Across all nine cases, the single-model regression run
averaged 93.4 with a 100% success rate.

## Next evaluation step

Before a production rollout, repeat the comparison on anonymized real transcript patterns and measure p50/p95 latency on the intended iPad and room-audio setup.
