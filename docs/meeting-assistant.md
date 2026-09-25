# Meeting assistant

In Training Mode, enable «Режим встречи с материалами». Upload a named pack
of 1–20 Markdown files (2 MB total, up to 160 sections). Wait for Ready and
explicitly select the pack. Click a transcript turn to request help. Its text
and preceding context are captured at selection time. New speech and repeated
clicks on the same turn do not regenerate the card. Selecting another turn
cancels the old request; late results cannot replace the selected answer.
Changing sessions or leaving meeting mode clears the selection.

## Conversation window

New meeting turns carry capture times. A selected turn receives preceding speech
from the prior ten minutes, bounded to 12,000 characters. Older session turns
without capture times retain the previous seven-turn behavior. The full local
transcript can retain up to 500 turns in meeting mode.

Older turns are summarized on the local development server in the background,
in batches of up to 30. The cumulative Russian summary is capped at 2,400
characters and saved with local session history. Until a batch succeeds, its
turns remain available as unsummarized context within the request size limit.
Summarization sends those transcript turns to the configured OpenAI API and
incurs API usage; requests set `store: false`.
Editing or deleting a summarized turn rebuilds the summary from retained turns.
If the meeting exceeds 500 turns, older raw turns are no longer available for
rebuilding after such an edit. The summary helps resolve
references in later questions but never establishes a project fact. Document
sections remain the evidence for grounded answers.

Quick openings continue to use the smaller low-latency context. The full
meeting answer and material search receive the ten-minute context and summary.
Selecting a historical turn excludes any summary that may contain later speech.

The opening and retrieval start concurrently on selection. The
opening stays visible; one English continuation and Russian meaning appear
below, with expandable source sections. The continuation requests only new
ideas in 1–3 short A2/B1 sentences (up to 45 English words). A conservative
guard removes a repeated opening prefix only when both languages match and
both retain a nonempty continuation; it does not guess semantic equivalence.
If a repeat remains in one language, one additional model request rewrites
both languages together. This can add latency. Other paraphrased repetition
is handled by the prompt and requires live evaluation. Missing/conflicting evidence or API
errors produce a short request for time to check details, without promising
a later follow-up. Openings and answers discuss the meeting topic instead
of narrating document search or the assistant workflow.

## Data flow and lifecycle

`MeetingAssistant` calls `/api/meeting/{packs,active,delete,search,answer}`.
Vite middleware uses the configured OPENAI_API_KEY on the server. Each pack
has its own Vector Store. Heading-aware Markdown sections are uploaded as
files with explicit pack/section attributes. Search is restricted to the
active store and pack filter. Original bounded sections are supplied to the
Responses API, preserving qualifiers omitted by a search chunk.

The server issues short-lived search tickets rather than trusting client
evidence. Source IDs are validated. Switching packs invalidates tickets;
the UI aborts and ignores stale requests. Generated openings are not evidence. A quick clarification does not cancel
retrieval: the final result replaces it, and the clarification is not supplied
as a spoken opening to continue.
A narrow observed speech confusion, `codecs` → `Codex`, is proposed only when
retrieved evidence names Codex and contains no competing codec topic.
Explicit audio/video/compression terms prevent the interpretation. The original
transcript is unchanged and remains in model input alongside the proposed
question. A grounded result must start with “If you mean Codex” in both
languages; the interpretation never supplies facts about a person. Unsupported
answers still use the fallback. This is not general transcript autocorrection.
The existing bilingual model setting is reused.

Local `.echoguide/meeting/packs.json` contains private sections, cloud IDs and
the active selection, and must remain ignored. New packs never replace the
active pack until ready and explicitly selected. Inactive packs remain stored
in OpenAI until deleted in the UI. Deletion removes the store and uploaded
files, then the local record; retries tolerate already removed resources.
Interrupted uploads are marked failed on restart; known resource IDs remain
for cleanup. A network timeout during a creation request can leave a cloud
resource whose ID was never received; inspect the OpenAI dashboard if needed.

This is a local-dev implementation, without production authentication or
hosted persistence. Meeting snapshots are automatically stored separately in
ignored `.echoguide/sessions/meeting-cards.json`, including exact bilingual
openings, continuations, sources, timings and prior attempts. No opt-in is required.
The existing session-history format is unchanged; snapshots share its session ID.

Selecting the same phrase again, including after opening its saved session,
restores the last attempt for that phrase text, speaker, context and pack.
Interrupted attempts restore their available opening without generating again.
Use “Новый вариант” to explicitly generate another attempt, or
“Экспорт ответов сессии (JSON)” to export every stage and attempt in the session.
These controls also apply to `/mac-audio`.
New answers include a compact diagnostic reason and the number of retrieved
sections when known. Open “Диагностика ответа” under a fallback card to tell
empty search results, the model reporting insufficient evidence, conflicting
evidence, invalid output and request errors apart. The reason is saved in the
local snapshots and JSON export;
older snapshots remain readable but cannot recover a reason they never stored.

Read failures block automatic generation. Failed writes show a warning and stay
in page memory for retry; use “Повторить сохранение / загрузку” before closing
that page. Abrupt closure before a write finishes can lose pending snapshots.
Deleting a session or material pack does not delete this independent archive.
To erase all meeting snapshots, stop the local server and remove that file.
Exports contain private conversation and source content; keep them out of Git.
Historical answers generated before this feature cannot be recovered.
Transcript translation behavior is unchanged. Explicit metadata is preserved;
unknown business facts and statuses are never inferred during indexing.

## Verification

Run `npm test` and `npm run build`. `npm run eval:meeting` uses only synthetic
Russian files and English questions (proposal, names, follow-up, unknown).
It incurs API usage, writes ignored results and deletes test resources.
Inspect answer wording as well as status/source checks. The first attempt hit network timeouts; a second run passed all four cases:
retrieval 1.7–1.9 s, complete answer 3.6–5.0 s. This small synthetic sample
is not a latency guarantee or an evaluation of personal work materials.
All known synthetic cloud resources were deleted.


## Generation input boundaries

Existing transcript turns and meeting snapshots are never rewritten by input
preparation. New Realtime turns are dropped before storage when their text is
an exact configured transcription prompt or a long exact prefix ending at a
sentence boundary. The same filter excludes such turns from generation context,
allowing whitespace/case differences and a known speaker prefix. A single
matching sentence, quoted examples with surrounding speech, and arbitrary
instructions are retained. This is a narrow defense, not a general
transcription fix.

Explicit sentence-boundary handoffs such as “Next question:” or
“А теперь следующий вопрос:” select the complete following utterance. The
matching also supports “А следующая фраза такая:”. It does not split on a language
change or select the last question mark. Without a supported handoff the whole
utterance is retained, including follow-ups without punctuation. Recent dialogue
still resolves referents; it must not replace the active topic.

Quick openings and retrieval receive the same prepared input. Retrieval tickets
carry that input into the continuation request. New snapshots retain the raw
identity plus `generationInput` (version, transcript, recentContext). Cache keys
continue to identify the raw selection, so legacy snapshots restore as originally
shown, with a legacy-input notice. Use “Новый вариант” to apply current rules;
this appends an attempt and does not rewrite historical answers or sources.

To check locally: select a synthetic coach-feedback turn with an explicit
next-question handoff, verify the focused question above the reply, then export
and compare raw `identity` against `generationInput`. A prompt-only selected turn
shows a service-text notice without generating. An old saved answer remains
unchanged until explicit regeneration. Tests use synthetic inputs and mocked
model responses; they do not establish live model answer quality.


## Spoken answer quality

A hypothetical question can receive a concrete conditional first step without
inventing past actions or approved decisions. The continuation adds a supported
measurement, check or condition missing from that opening. Rewording the same
cautious conclusion still counts as repetition. Similar tasks must not become
identical tasks, and recording differences must not imply removing their effect.

Prefer simple words when the meaning is unchanged: compare, time saved, quality
requirements. This is not a global ban on technical vocabulary. Russian retains
the same conditions and uncertainty. Recommendations still require evidence:
“I would” does not make an invented method grounded. No approved quality
trade-off, grouping method or sample size may be inferred from a proposal.

Run `npm run eval:meeting -- --spoken-quality` for ten synthetic scenarios:
one result, extra rework with distracting earlier dialogue, comparable work,
complexity, few differing tasks, quality versus speed, and an unapproved policy.
The runner generates real openings before retrieval and continuations, reuses
configured model settings and writes answers/checks to ignored eval results.
It creates and removes only its synthetic cloud pack. Mechanical checks flag
known failures; review the actual English/Russian sequence and source status too.
Old saved cards remain unchanged; use “Новый вариант” to test current wording.

To compare the current meeting model's reasoning effort without changing the
live default, run `npm run eval:meeting -- --spoken-quality --efforts=none,low,medium`.
The runner reuses one generated opening per question, rotates effort order, and
records the number of search hits alongside the answer and timing. The live
meeting service still uses `none` unless explicitly overridden by the runner.

On September 23, 2026, `gpt-5.6-luna` passed 8/10, 9/10, and 9/10 checks for
`none`, `low`, and `medium`, respectively. Mean search plus answer time was
3.88s, 6.24s, and 6.39s. In a two-repeat targeted check of diplomatic wording,
`none` passed 0/2, `low` 1/2, and `medium` 2/2; all six searches found four
fragments. The sample favors a separate `medium` meeting canary, but is too
small to change the live default. Results are saved under ignored
`.echoguide/evals/meeting-*/results.json` directories; synthetic cloud
resources were removed.


### Synthetic check recorded on 2026-09-20

The seven-case live run passed the mechanical checks after prompt revisions;
the standard quick-start evaluation also passed all seven mode/factual-boundary
cases. Review found a remaining small-sample phrasing problem, so that scenario
was checked again after clarifying that few observations limit confidence, not
necessarily the range of complexity. Its opening then said: “With few tasks,
conclusions about the complexity difference will remain uncertain.”
The initial checker incorrectly treated “both groups” (the two approaches) as
an invented grouping method; the corrected check distinguishes that wording
from instructions to group tasks by complexity. Original eval outputs remain
unchanged in the ignored results directory. Use `--case=remaining-differences`
with the spoken-quality command to reproduce that targeted check.

An actual rework opening was “I would first count the extra rework time against
the time saved.” Its continuation kept human review and final quality, then
compared total time with the usual process. The unsupported-policy case returned
`no_answer`. These synthetic examples are observations, not fixed templates or
a guarantee of future wording. No private pack or export was sent in these runs;
the runner removed its synthetic cloud resources.

Spoken comparison prompts now compare total time for both approaches, counting review
and rework once. Required quality is a separate check; better quality need not reduce
effort to be necessary. Diplomatic wording should be directly speakable. Baseline
selection and quality checks already in the opening should not be repeated. The
spoken-quality suite also covers baseline follow-ups, slower higher-quality work
and diplomatic wording. These changes do not alter generation triggers.

For limited-evidence decisions, the opening can call the decision provisional or
the conclusion uncertain. It should not call the decision itself unreliable.
The continuation should add a supported check or risk without repeating the opening.
The spoken-quality suite includes this question and checks the combined EN answer.
