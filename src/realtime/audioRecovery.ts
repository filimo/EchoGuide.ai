export const OPENAI_AUDIO_TRANSCRIPTIONS_URL =
  "https://api.openai.com/v1/audio/transcriptions";

export const defaultAudioRecoveryModel = "gpt-4o-transcribe";

export const audioRecoveryPrompt =
  "Transcribe the most recent clearly audible English or Russian speech faithfully, including natural code-switching, short replies, incomplete phrases, names, and informal wording. The conversation may be about any topic. Ignore only non-speech noise and audio that is too unclear to transcribe.";

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
