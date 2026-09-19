# Meeting assistant

In Training Mode, enable «Режим встречи с материалами». Upload a named pack
of 1–20 Markdown files (2 MB total, up to 160 sections). Wait for Ready and
explicitly select the pack. Turn on «Вопросы ко мне» when questions are directed
to you; it also processes the last utterance before activation. Turn it off
when the discussion moves to others. No speaker recognition is assumed.

The opening and retrieval start concurrently after a 700 ms debounce. The
opening stays visible; one English continuation and Russian meaning appear
below, with expandable source sections. Missing/conflicting evidence or API
errors produce a polite request for time to check details.

## Data flow and lifecycle

`MeetingAssistant` calls `/api/meeting/{packs,active,delete,search,answer}`.
Vite middleware uses the configured OPENAI_API_KEY on the server. Each pack
has its own Vector Store. Heading-aware Markdown sections are uploaded as
files with explicit pack/section attributes. Search is restricted to the
active store and pack filter. Original bounded sections are supplied to the
Responses API, preserving qualifiers omitted by a search chunk.

The server issues short-lived search tickets rather than trusting client
evidence. Source IDs are validated. Switching packs invalidates tickets;
the UI aborts and ignores stale requests. Generated openings are not evidence.
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
hosted persistence. Meeting answers are not persisted into session history.
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
