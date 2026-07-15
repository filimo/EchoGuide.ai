# Product scope

## Product idea

EchoGuide is a bilingual companion for interview practice and live English conversations. It listens through the microphone of the device running the web app, shows the English transcript and Russian meaning, and helps the user choose a short English response.

The product is not intended to automate the conversation. It keeps the user in control and reduces the time between understanding a question and answering it.

## Primary user journey

1. Open EchoGuide on an iPad or another microphone-enabled device.
2. Place it near an audible conversation source.
3. Add a small set of verified personal or project facts in `Pasted notes`.
4. Start a live session manually.
5. Read the completed English transcript and Russian meaning.
6. Use a bridge phrase while thinking.
7. Choose one of two or three concise reply intents.
8. Expand the selected intent into a complete English sentence.
9. Review the locally saved session later.

## MVP capabilities

- browser microphone permission and explicit live-session controls;
- OpenAI Realtime transcription over WebRTC;
- English, Russian, and bilingual transcription modes;
- normal, semantic, and disabled automatic turn detection;
- dialogue-style transcript with speaker labels;
- Russian meaning and question detection;
- instant local bridge phrases;
- grounded suggested replies based on recent context and pasted notes;
- manual transcript additions and corrections with explicit speaker roles;
- a 60-second in-memory microphone buffer with manual recovery of the latest
  30 seconds when Realtime misses a phrase;
- manual card generation from selected transcript turns;
- local session history without raw audio;
- privacy-safe Realtime diagnostics.

## Interaction principles

### Low cognitive load

The live UI shows only two or three short answer options. A complete sentence appears after selection, so the user does not need to scan long generated text during a conversation.

### Concise English

Suggested replies target natural spoken A2/B1 English: simple vocabulary, active
voice, contractions where they sound natural, and one idea per sentence. Direct
questions get direct answers; behavioral questions use a brief situation-action-result
flow only when the available facts support it. The first answer should be complete
but leave room for a follow-up question.

### Grounded answers

Personal notes are factual background, not permission to invent details. The prompt explicitly rejects unsupported roles, projects, metrics, team sizes, and outcomes.

### Human control

The user chooses the active transcript turn, can add a missed phrase or correct a
recognized phrase, selects the speaker role, reply, bridge phrase, and whether the
UI follows the latest live phrase. EchoGuide assists the conversation; it does not
speak on the user's behalf.

Recovered audio follows the same boundary: a separate transcription request opens
the result in the message editor, and the user confirms the text and speaker before
it becomes part of the session.

## Current limitations

- The microphone must be able to hear the conversation; audio played only through headphones is unavailable.
- The current server routes are local development middleware, not a production backend.
- Authentication, cloud sync, and multi-user knowledge management are outside the prototype.
- Session cost and latency depend on the selected OpenAI models and conversation length.
