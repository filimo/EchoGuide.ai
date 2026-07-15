export const OPENAI_AUDIO_TRANSCRIPTIONS_URL =
  "https://api.openai.com/v1/audio/transcriptions";

export const defaultAudioRecoveryModel = "gpt-4o-transcribe";

export const audioRecoveryPrompt =
  "Transcribe all clearly audible English or Russian speech in chronological order, including natural code-switching, short replies, incomplete phrases, names, and informal wording. Preserve sentence punctuation and put each distinct spoken phrase on a separate line when possible. The conversation may be about any topic. Ignore only non-speech noise and audio that is too unclear to transcribe.";

const recoveredPhraseSegmenter = new Intl.Segmenter(["en", "ru"], {
  granularity: "sentence"
});

export function splitRecoveredTranscript(transcript: string): string[] {
  const normalizedTranscript = transcript.replace(/\r\n?/g, "\n").trim();

  if (normalizedTranscript.length === 0) {
    return [];
  }

  return normalizedTranscript
    .split(/\n+/)
    .flatMap((line) =>
      Array.from(recoveredPhraseSegmenter.segment(line), ({ segment }) =>
        segment.replace(/\s+/g, " ").trim()
      )
    )
    .filter((phrase) => phrase.length > 0);
}

type TranscribeRecoveredAudioOptions = {
  apiKey: string;
  audioBytes: Uint8Array;
  model?: string;
  fetchImpl?: typeof fetch;
};

export async function transcribeRecoveredAudio({
  apiKey,
  audioBytes,
  model = defaultAudioRecoveryModel,
  fetchImpl = fetch
}: TranscribeRecoveredAudioOptions): Promise<string> {
  const body = new FormData();
  const audioCopy = new Uint8Array(audioBytes);

  body.append("file", new Blob([audioCopy], { type: "audio/wav" }), "recovered-audio.wav");
  body.append("model", model);
  body.append("response_format", "json");
  body.append("prompt", audioRecoveryPrompt);

  const response = await fetchImpl(OPENAI_AUDIO_TRANSCRIPTIONS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "OpenAI-Safety-Identifier": "echoguide-local-dev"
    },
    body
  });
  const payload = (await response.json()) as {
    text?: unknown;
    error?: { message?: unknown };
  };

  if (!response.ok) {
    const upstreamMessage =
      typeof payload.error?.message === "string"
        ? payload.error.message
        : "OpenAI audio recovery request failed.";
    throw new Error(
      `OpenAI audio recovery request failed with status ${response.status}: ${upstreamMessage}`
    );
  }

  if (typeof payload.text !== "string") {
    throw new Error("OpenAI audio recovery response had an unexpected shape.");
  }

  return payload.text.trim();
}
