export const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
export const defaultFastTranslationModel = "gpt-5-nano";
export const defaultFastTranslationReasoningEffort = "minimal";

type TranslatePhraseOptions = {
  apiKey: string;
  transcript: string;
  model?: string;
  reasoningEffort?: string;
  fetchImpl?: typeof fetch;
};

function readResponseText(payload: unknown): string | null {
  if (typeof payload !== "object" || payload == null) {
    return null;
  }

  const outputText = (payload as { output_text?: unknown }).output_text;

  if (typeof outputText === "string") {
    return outputText;
  }

  const output = (payload as { output?: unknown }).output;

  if (!Array.isArray(output)) {
    return null;
  }

  for (const item of output) {
    const content = (item as { content?: unknown })?.content;

    if (!Array.isArray(content)) {
      continue;
    }

    for (const part of content) {
      const text = (part as { text?: unknown })?.text;

      if (typeof text === "string") {
        return text;
      }
    }
  }

  return null;
}

export function buildFastTranslationRequest(
  transcript: string,
  model = defaultFastTranslationModel,
  reasoningEffort = defaultFastTranslationReasoningEffort
) {
  return {
    model,
    reasoning: { effort: reasoningEffort },
    instructions: [
      "Translate the user's speech into natural Russian.",
      "Preserve names, numbers, technical terms, tone, and uncertainty.",
      "If the text is already Russian, return it unchanged.",
      "Return only the translation, without labels, quotes, or commentary."
    ].join(" "),
    input: transcript.trim(),
    max_output_tokens: 120,
    text: { verbosity: "low" },
    store: false
  };
}

export async function translatePhraseToRussian({
  apiKey,
  transcript,
  model = process.env.OPENAI_TRANSLATION_MODEL?.trim() || defaultFastTranslationModel,
  reasoningEffort =
    process.env.OPENAI_TRANSLATION_REASONING_EFFORT?.trim() ||
    defaultFastTranslationReasoningEffort,
  fetchImpl = fetch
}: TranslatePhraseOptions): Promise<string> {
  const response = await fetchImpl(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "OpenAI-Safety-Identifier": "echoguide-local-dev"
    },
    body: JSON.stringify(buildFastTranslationRequest(transcript, model, reasoningEffort))
  });
  const payload = await response.json();

  if (!response.ok) {
    const upstreamMessage =
      typeof (payload as { error?: { message?: unknown } }).error?.message === "string"
        ? (payload as { error: { message: string } }).error.message
        : "OpenAI translation request failed.";

    throw new Error(
      `OpenAI translation request failed with status ${response.status}: ${upstreamMessage}`
    );
  }

  const translation = readResponseText(payload)?.trim() ?? "";

  if (translation.length === 0) {
    throw new Error("OpenAI translation response did not include output text.");
  }

  return translation;
}
