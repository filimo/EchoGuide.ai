export const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

export type BilingualSuggestedReply = {
  shortLabel: string;
  shortLabelTranslation: string;
  fullSentence: string;
  fullSentenceTranslation: string;
  whyUse: string;
};

export type BilingualPhraseAnalysis = {
  analysisTargetText?: string;
  speakerRole?: "interviewer" | "me" | "unknown";
  russianMeaning: string;
  isQuestion: boolean;
  bridgePhrase: string;
  suggestedReplies: BilingualSuggestedReply[];
};

type AnalyzePhraseOptions = {
  apiKey: string;
  transcript: string;
  knowledgeContext?: string;
  recentContext?: string[];
  model?: string;
  reasoningEffort?: string;
  fetchImpl?: typeof fetch;
};

type BilingualModelOptions = {
  reasoningEffort?: string;
};

const fallbackBridgePhrase = "Sure, let me think for a second.";

export const defaultBilingualModel = "gpt-5.6-luna";
export const defaultBilingualReasoningEffort = "none";
export const maxKnowledgeContextCharacters = 6000;
export const maxRecentContextTurns = 15;
export const maxRecentContextCharacters = 5000;

const bilingualAnalysisInstructions = [
  "You help a Russian-speaking senior software engineer practice English interviews.",
  "The transcript can contain English or Russian speech. Treat other-language-looking fragments as transcription noise unless they clearly give useful context.",
  "The user reads English at A2/B1 level, so use clear, natural spoken English with common words and active voice. Return only compact JSON.",
  "Main goal: help the user answer interview questions with short, complete answers that sound like something a real person would say aloud.",
  "Classify the active transcript speakerRole as interviewer, me, or unknown. Use interviewer for the person asking or clarifying interview questions. Use me for the candidate describing their work, experience, decisions, or results. Use unknown when the text is too short, ambiguous, or noise.",
  "Recent context labels can be Heard, Interviewer, or Me; Heard means the role was not confirmed yet.",
  "Build each card for the freshest coherent thought, not blindly for the last audio fragment. The active transcript is the newest completed phrase. Recent transcript context is only for understanding whether the active transcript continues a nearby thought.",
  "If the active transcript is a fragment, combine it with nearby context and set analysisTargetText to the concise cleaned thought you analyzed.",
  "If several nearby Me fragments form one draft answer, reconstruct that answer before suggesting improvements. Remove filler, false starts, accidental repetition, and obvious transcription errors. Correct grammar and word choice while preserving the user's meaning, facts, and level of confidence.",
  "If the active transcript is only a test, filler, duplicate, or unusable noise, do not invent facts; keep analysisTargetText literal and make the reply safe and minimal.",
  "Detect whether the freshest coherent thought is an interviewer question, the user's draft answer, or noise or unclear speech.",
  "For every interviewer question, explain the meaning in Russian, provide one short English bridge phrase the user can say while thinking, and provide 2-3 short answer options.",
  "For every user draft answer, keep the user's intent and simple speaking style. Improve it into natural spoken English instead of giving feedback about it. Add a detail only when it is supported by the transcript, recent context, or personal knowledge context.",
  "Choose the answer structure from the question type. For direct, opinion, weakness, yes-or-no, or pressure questions, answer directly in the first sentence and add only the explanation needed. For behavioral questions such as Tell me about a time, use a brief situation-action-result flow when those facts are available. For technical questions, state the approach and the relevant result or trade-off. Never force a challenge, action, or outcome into every answer.",
  "Make the first reply the most natural answer closest to the user's meaning. Make the second reply simpler or shorter. Add a third reply only when it offers a genuinely different useful angle.",
  "Bridge phrases must be maximum 6 words.",
  "Each answer option must contain shortLabel, shortLabelTranslation, fullSentence, fullSentenceTranslation, and whyUse. Each shortLabel must be 1-2 plain English words with spaces, not camelCase.",
  "Each fullSentence must contain 1-3 short conversational English sentences and no more than 45 words in total. Prefer sentences under 14 words, but do not split a natural sentence only to meet a word count.",
  "Use contractions such as I'm, I've, and doesn't when they sound natural. Avoid idioms, slang, formal essay language, repeated sentence openings, and stock endings that are not supported by the facts.",
  "Before returning, silently read every English reply as spoken language. Replace literal translations and awkward noun phrases with common conversational verb phrases and idiomatic collocations.",
  "For every suggested reply, include a Russian translation of the short label, a Russian translation of the full sentence, and whyUse as a short Russian explanation of when to use this answer.",
  "Use personal knowledge context only as factual background. Do not invent company names, project names, technologies, metrics, leadership, management, QA, or outcomes that were not provided in the transcript, recent context, or personal knowledge context.",
  "If exact metrics are unknown, do not invent numbers. Use a safe qualitative result only when the available context supports it.",
  "If the personal knowledge context is absent or irrelevant, make replies safe generic software-engineering frames the user can adapt.",
  "Prefer answer strategies as labels, for example: direct, simple, example, approach, result, trade-off, or clarification.",
  "Keep answers concise, natural, grounded, and useful during a live interview."
].join(" ");

export function normalizeKnowledgeContext(value: string | undefined): string {
  return value?.trim().slice(0, maxKnowledgeContextCharacters) ?? "";
}

export function normalizeRecentContext(value: string[] | undefined): string[] {
  if (value == null) {
    return [];
  }

  const normalizedTurns = value
    .map((turn) => turn.trim())
    .filter((turn) => turn.length > 0)
    .slice(-maxRecentContextTurns);

  while (
    normalizedTurns.length > 1 &&
    normalizedTurns.join("\n").length > maxRecentContextCharacters
  ) {
    normalizedTurns.shift();
  }

  if (normalizedTurns.join("\n").length <= maxRecentContextCharacters) {
    return normalizedTurns;
  }

  return [normalizedTurns[0]?.slice(-maxRecentContextCharacters).trim() ?? ""].filter(
    (turn) => turn.length > 0
  );
}

function supportsReasoningEffort(model: string): boolean {
  const match = /^gpt-5\.(\d+)/.exec(model);
  return match != null && Number(match[1]) >= 1;
}

const analysisSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "analysisTargetText",
    "speakerRole",
    "russianMeaning",
    "isQuestion",
    "bridgePhrase",
    "suggestedReplies"
  ],
  properties: {
    analysisTargetText: {
      type: "string"
    },
    speakerRole: {
      type: "string",
      enum: ["interviewer", "me", "unknown"]
    },
    russianMeaning: {
      type: "string"
    },
    isQuestion: {
      type: "boolean"
    },
    bridgePhrase: {
      type: "string"
    },
    suggestedReplies: {
      type: "array",
      minItems: 2,
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "shortLabel",
          "shortLabelTranslation",
          "fullSentence",
          "fullSentenceTranslation",
          "whyUse"
        ],
        properties: {
          shortLabel: {
            type: "string"
          },
          shortLabelTranslation: {
            type: "string"
          },
          fullSentence: {
            type: "string"
          },
          fullSentenceTranslation: {
            type: "string"
          },
          whyUse: {
            type: "string"
          }
        }
      }
    }
  }
} as const;

function isBilingualPhraseAnalysis(value: unknown): value is BilingualPhraseAnalysis {
  if (typeof value !== "object" || value == null) {
    return false;
  }

  const candidate = value as Partial<BilingualPhraseAnalysis>;

  return (
    (candidate.analysisTargetText == null || typeof candidate.analysisTargetText === "string") &&
    (candidate.speakerRole === "interviewer" ||
      candidate.speakerRole === "me" ||
      candidate.speakerRole === "unknown") &&
    typeof candidate.russianMeaning === "string" &&
    typeof candidate.isQuestion === "boolean" &&
    typeof candidate.bridgePhrase === "string" &&
    Array.isArray(candidate.suggestedReplies) &&
    candidate.suggestedReplies.every(
      (reply) =>
        typeof reply === "object" &&
        reply != null &&
        typeof (reply as Partial<BilingualSuggestedReply>).shortLabel === "string" &&
        typeof (reply as Partial<BilingualSuggestedReply>).shortLabelTranslation === "string" &&
        typeof (reply as Partial<BilingualSuggestedReply>).fullSentence === "string" &&
        typeof (reply as Partial<BilingualSuggestedReply>).fullSentenceTranslation === "string" &&
        typeof (reply as Partial<BilingualSuggestedReply>).whyUse === "string"
    )
  );
}

function readResponseText(payload: unknown): string | null {
  if (typeof payload !== "object" || payload == null) {
    return null;
  }

  const maybeOutputText = (payload as { output_text?: unknown }).output_text;

  if (typeof maybeOutputText === "string") {
    return maybeOutputText;
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

export function parseBilingualPhraseAnalysis(payload: unknown): BilingualPhraseAnalysis {
  const responseText = readResponseText(payload);

  if (responseText == null) {
    throw new Error("OpenAI phrase analysis response did not include output text.");
  }

  const parsed = JSON.parse(responseText) as unknown;

  if (!isBilingualPhraseAnalysis(parsed)) {
    throw new Error("OpenAI phrase analysis response had an unexpected shape.");
  }

  return {
    ...(parsed.analysisTargetText?.trim()
      ? { analysisTargetText: parsed.analysisTargetText.trim() }
      : {}),
    speakerRole: parsed.speakerRole,
    russianMeaning: parsed.russianMeaning,
    isQuestion: parsed.isQuestion,
    bridgePhrase: parsed.bridgePhrase.trim() || fallbackBridgePhrase,
    suggestedReplies: parsed.suggestedReplies.slice(0, 3)
  };
}

export function buildBilingualPhraseAnalysisRequest(
  transcript: string,
  model = defaultBilingualModel,
  knowledgeContext?: string,
  recentContext?: string[],
  modelOptions: BilingualModelOptions = {}
) {
  const reasoningEffort =
    modelOptions.reasoningEffort?.trim() || defaultBilingualReasoningEffort;
  const normalizedKnowledgeContext = normalizeKnowledgeContext(knowledgeContext);
  const normalizedRecentContext = normalizeRecentContext(recentContext);
  const formattedRecentContext = normalizedRecentContext
    .map((turn, index) =>
      `${index + 1}. ${/^(Interviewer|Me|Heard):\s/.test(turn) ? turn : `Heard: ${turn}`}`
    )
    .join("\n");
  const activeTranscriptMessage =
    normalizedRecentContext.length > 0
      ? `Recent transcript context:\n${formattedRecentContext}\n\nActive transcript: ${transcript}\nBuild the card for the freshest coherent thought.`
      : `Active transcript: ${transcript}`;
  const input = [
    {
      role: "system",
      content: bilingualAnalysisInstructions
    },
    ...(normalizedKnowledgeContext.length > 0
      ? [
          {
            role: "user",
            content: `Personal knowledge context:\n${normalizedKnowledgeContext}`
          }
        ]
      : []),
    {
      role: "user",
      content: activeTranscriptMessage
    }
  ];

  return {
    model,
    ...(supportsReasoningEffort(model) ? { reasoning: { effort: reasoningEffort } } : {}),
    store: false,
    max_output_tokens: 700,
    input,
    text: {
      format: {
        type: "json_schema",
        name: "echoguide_phrase_analysis",
        strict: true,
        schema: analysisSchema
      }
    }
  };
}

export async function analyzeBilingualPhrase({
  apiKey,
  transcript,
  knowledgeContext,
  recentContext,
  model = process.env.OPENAI_BILINGUAL_MODEL?.trim() || defaultBilingualModel,
  reasoningEffort =
    process.env.OPENAI_BILINGUAL_REASONING_EFFORT?.trim() ||
    defaultBilingualReasoningEffort,
  fetchImpl = fetch
}: AnalyzePhraseOptions): Promise<BilingualPhraseAnalysis> {
  const response = await fetchImpl(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "OpenAI-Safety-Identifier": "echoguide-local-dev"
    },
    body: JSON.stringify(
      buildBilingualPhraseAnalysisRequest(transcript, model, knowledgeContext, recentContext, {
        reasoningEffort
      })
    )
  });

  const payload = await response.json();

  if (!response.ok) {
    const upstreamMessage =
      typeof (payload as { error?: { message?: unknown } }).error?.message === "string"
        ? (payload as { error: { message: string } }).error.message
        : "OpenAI phrase analysis request failed.";

    throw new Error(
      `OpenAI phrase analysis request failed with status ${response.status}: ${upstreamMessage}`
    );
  }

  return parseBilingualPhraseAnalysis(payload);
}
