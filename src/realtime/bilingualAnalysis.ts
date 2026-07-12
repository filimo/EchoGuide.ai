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
  fetchImpl?: typeof fetch;
};

const fallbackBridgePhrase = "Sure, let me think for a second.";

export const maxKnowledgeContextCharacters = 6000;
export const maxRecentContextTurns = 15;
export const maxRecentContextCharacters = 5000;

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

function supportsNoReasoningEffort(model: string): boolean {
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
  model = "gpt-5.6-luna",
  knowledgeContext?: string,
  recentContext?: string[]
) {
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
      content:
        "You help a Russian-speaking senior software engineer practice English interviews. The transcript can contain English or Russian speech. Treat other-language-looking fragments as transcription noise unless they clearly give useful context. The user reads English at A2/B1 level, so use short, simple English. Return only compact JSON. Main goal: help the user answer interview questions with short but complete answers. Classify the active transcript speakerRole as interviewer, me, or unknown. Use interviewer for the person asking or clarifying interview questions. Use me for the candidate describing their work, experience, decisions, or results. Use unknown when the text is too short, ambiguous, or noise. Recent context labels can be Heard, Interviewer, or Me; Heard means the role was not confirmed yet. Build each card for the freshest coherent thought, not blindly for the last audio fragment. The active transcript is the newest completed phrase. Recent transcript context is only for understanding whether the active transcript continues a nearby thought. If the active transcript is a fragment, combine it with nearby context and set analysisTargetText to the concise cleaned thought you analyzed. If the active transcript is only a test, filler, duplicate, or unusable noise, do not invent facts; keep analysisTargetText literal and make the reply safe and minimal. A good answer should usually include context, challenge, action, and outcome. Do not make answers long. Prefer 2-4 short conversational English sentences instead of one complex sentence. Detect whether the freshest coherent thought is an interviewer question, the user's draft answer, or noise or unclear speech. For every interviewer question, explain the meaning in Russian, provide one short English bridge phrase the user can say while thinking, and provide 2-3 short answer options. For every user draft answer, keep the user's short sentence style, improve the answer by adding only missing interview details, do not replace it with a long polished template, and prefer adding challenge and outcome if they are missing. Bridge phrases must be maximum 6 words. Each answer option must contain shortLabel, shortLabelTranslation, fullSentence, fullSentenceTranslation, and whyUse. Each shortLabel must be 1-2 plain English words with spaces, not camelCase. Each fullSentence must contain 2-4 short conversational English sentences. Each English sentence must be maximum 10 words. Use common words and active voice. Avoid idioms, slang, long clauses, rare verbs, and complex grammar. Use this answer pattern when possible: I worked on [project/system]. The main challenge was [problem]. I built/fixed/added [action]. It helped [outcome]. For every suggested reply, include a Russian translation of the short label, a Russian translation of the full sentence, and whyUse as a short Russian explanation of when to use this answer. Use personal knowledge context only as factual background. Do not invent company names, project names, technologies, metrics, leadership, management, QA, or outcomes that were not provided in the transcript, recent context, or personal knowledge context. If exact metrics are unknown, do not invent numbers. Use safe outcome phrases when needed, for example: It made the process more reliable. It reduced manual work. It improved validation. It helped the team check results. It made the workflow easier to control. If the personal knowledge context is absent or irrelevant, make replies safe generic software-engineering frames the user can adapt. Prefer answer strategies as labels, for example: project, challenge, outcome, reliability, validation, business value. Keep answers concise, natural, and useful during a live interview."
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
    ...(supportsNoReasoningEffort(model) ? { reasoning: { effort: "none" } } : {}),
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
  model = process.env.OPENAI_BILINGUAL_MODEL ?? "gpt-5.6-luna",
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
      buildBilingualPhraseAnalysisRequest(transcript, model, knowledgeContext, recentContext)
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
