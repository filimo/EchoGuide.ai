# Meeting assistant

In Training Mode, enable «Режим встречи с материалами». Upload a named pack
of 1–20 Markdown files (2 MB total, up to 160 sections). Wait for Ready and
explicitly select the pack. Click a transcript turn to request help. Its text
and preceding context are captured at selection time. New speech and repeated
clicks on the same turn do not regenerate the card. Selecting another turn
cancels the old request; late results cannot replace the selected answer.
Changing sessions or leaving meeting mode clears the selection.

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
