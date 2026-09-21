# Local session audio

`Start live` starts audio recording with the live session. `Stop live` finalizes it.
There are no separate recording controls. The status line explains local storage
before starting and shows recording, saving, or an independent recording error.

Open **Sessions → Аудиозаписи** on a saved session to play its recordings. Each
new live run creates a separate file, even when continuing the same session.
Sessions are created before the first transcript, so a silent or untranscribed
run can still have audio. Deleting a session deletes all its recording files;
active recordings cannot be deleted. History is retained until explicit deletion,
including sessions beyond the former twenty-entry limit.

## Formats and storage

- Mac mode writes 24 kHz, signed 16-bit stereo WAV. Microphone and application
  samples are mixed, clipped to the valid sample range and duplicated into both
  channels. Both voices play in both headphones. The transcription streams
  remain separate and keep their source labels.
- Browser microphone mode uses MediaRecorder: WebM/Opus where available,
  otherwise MP4. Mono input plays in both headphones. Unsupported browsers
  show a recording error while transcription can continue.
- Files and metadata stay on the development-server computer in ignored
  `.echoguide/sessions/audio/`, grouped by a hash of the session ID. When using
  an iPad, this means the computer hosting EchoGuide, not the iPad.
- Each run is limited to 1 GB or four hours, whichever comes first. Recording
  stops at that limit; transcription continues and the UI reports the interruption.
  WAV uses about 346 MB per hour, so its size limit is reached before four hours.

## Failure behavior

Browser chunks upload every second in order with an 8 MB request limit and a
16 MB pending-memory limit. Stop waits for the final chunk and server finish.
Uploads abandoned for a minute are marked interrupted. A page or browser crash
can lose pending chunks; an incomplete browser container may not seek or play
in every browser. Do not close the page while it says it is saving.

Mac WAV headers are checkpointed with each written frame. Stopping capture flushes
the queued tail; a server restart marks unfinished files interrupted. Disk errors
leave the last successfully written data, without stopping transcription.
Once Mac capture is running, an upstream transcription failure disables that
transcription channel but leaves capture and recording active until Stop live.
Native capture failure, closing the page, or server shutdown ends capture and
preserves the partial recording. Failed startup before capture begins has no audio.

Opening another session, New session, or leaving the screen stops the live run.
Saving status and errors are separate from transcription status. Recordings are
not copied into diagnostics, sent to a new external service, or committed to Git.
The existing Realtime audio transmission for transcription is unchanged.

## Verification

`npm run test` covers mixing, WAV checkpoints, ordered uploads, cancellation,
partial recordings, playback byte ranges, same-origin access, deletion and
independent errors. `npm run lint` and `npm run build` check the full application.

For manual verification, start a short conversation, check the recording status,
stop, open its audio in Sessions, reload and play it again. In Mac mode check both
voices in both headphones. Real device permissions, capture quality and Safari
MediaRecorder behavior still require a device smoke test.
