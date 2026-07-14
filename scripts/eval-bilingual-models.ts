import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  OPENAI_RESPONSES_URL,
  buildBilingualPhraseAnalysisRequest,
  parseBilingualPhraseAnalysis,
  type BilingualPhraseAnalysis
} from "../src/realtime/bilingualAnalysis.ts";

type EvalCase = {
  id: string;
  description: string;
  transcript: string;
  expectedIsQuestion: boolean;
  knowledgeContext?: string;
  recentContext?: string[];
};

type Usage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

type ContractCheck = {
  name: string;
  passed: boolean;
  details: string;
};

type CandidateResult = {
  model: string;
  ok: boolean;
  latencyMs: number;
  usage: Usage;
  analysis?: BilingualPhraseAnalysis;
  contractScore: number;
  contractChecks: ContractCheck[];
  error?: string;
  judgeScore?: number;
  judgeNotes?: string;
  finalScore?: number;
};

type JudgeCandidate = {
  key: string;
  score: number;
  notes: string;
};

type JudgeResult = {
  candidates: JudgeCandidate[];
  winnerKey: string;
};

const defaultModels = [
  "gpt-5.4-mini",
  "gpt-5.6-luna",
  "gpt-5.6-terra",
  "gpt-5.6-sol"
];
const defaultJudgeModel = "gpt-5.5";
const defaultJudgeReasoningEffort = "low";

const cases: EvalCase[] = [
  {
    id: "interviewer-role-question",
    description: "Прямой вопрос интервьюера о роли",
    transcript: "What was your role in that project?",
    expectedIsQuestion: true,
    knowledgeContext:
      "Project: EchoGuide. Role: built a Realtime transcription flow and bilingual interview reply cards."
  },
  {
    id: "draft-answer-missing-outcome",
    description: "Короткий черновик ответа без результата",
    transcript: "I was responsible for backend API integration.",
    expectedIsQuestion: false,
    knowledgeContext:
      "Work: integrated APIs, added validation, and made failed requests easier to diagnose. No exact metrics are available."
  },
  {
    id: "russian-draft",
    description: "Русский черновик для ответа на английском",
    transcript: "Я исправил процесс валидации и добавил понятные ошибки.",
    expectedIsQuestion: false,
    knowledgeContext:
      "The user works as a senior software engineer. Do not invent company names or metrics."
  },
  {
    id: "fresh-coherent-thought",
    description: "Свежая мысль собрана из нескольких фрагментов",
    transcript: "It helped me find useful methods.",
    expectedIsQuestion: false,
    recentContext: [
      "How do you keep your AI skills current?",
      "I read articles and explore new AI tools regularly.",
      "I test them in small projects."
    ]
  },
  {
    id: "unclear-noise",
    description: "Шумная и неполная реплика без права выдумывать факты",
    transcript: "Um... test, test. Maybe API...",
    expectedIsQuestion: false
  },
  {
    id: "challenge-example-question",
    description: "Вопрос о конкретной сложной ситуации",
    transcript: "Tell me about a difficult technical problem you solved.",
    expectedIsQuestion: true,
    knowledgeContext:
      "Example: an AI-generated description flow produced unstable validation results. Action: added structured validation and clearer failure reasons. Outcome: the team could review results more reliably."
  },
  {
    id: "direct-weakness-question",
    description: "Прямой вопрос о слабой стороне без искусственного STAR-шаблона",
    transcript: "What's your biggest weakness?",
    expectedIsQuestion: true,
    knowledgeContext:
      "Draft answer: I sometimes spend too much time on details. I now set clear priorities and time limits. This helps me maintain quality while working faster."
  },
  {
    id: "ai-use-pressure-question",
    description: "Жёсткий прямой вопрос об использовании AI",
    transcript: "Aren't you relying on AI right now?",
    expectedIsQuestion: true,
    knowledgeContext:
      "The user uses AI for English language support. The professional experience, examples, and technical reasoning are the user's own. Do not claim that AI is not being used.",
    recentContext: [
      "Interviewer: Are you using AI tools during this interview?",
      "Me: Yes. I use AI to practice English. The experience and examples are my own."
    ]
  }
];

const judgeSchema = {
  type: "object",
  additionalProperties: false,
  required: ["candidates", "winnerKey"],
  properties: {
    candidates: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "score", "notes"],
        properties: {
          key: { type: "string" },
          score: { type: "number", minimum: 0, maximum: 100 },
          notes: { type: "string" }
        }
      }
    },
    winnerKey: { type: "string" }
  }
} as const;

function readOption(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function readModels(): string[] {
  const value = readOption("models") ?? process.env.ECHOGUIDE_EVAL_MODELS;
  return value
    ? value.split(",").map((model) => model.trim()).filter(Boolean)
    : defaultModels;
}

function countWords(value: string): number {
  return value.trim().split(/\s+/u).filter(Boolean).length;
}

function splitSentences(value: string): string[] {
  return value
    .split(/(?<=[.!?])\s+/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function checkContract(
  analysis: BilingualPhraseAnalysis,
  expectedIsQuestion: boolean
): { score: number; checks: ContractCheck[] } {
  const replies = analysis.suggestedReplies;
  const sentenceGroups = replies.map((reply) => splitSentences(reply.fullSentence));
  const checks: Array<ContractCheck & { weight: number }> = [
    {
      name: "question-classification",
      passed: analysis.isQuestion === expectedIsQuestion,
      details: `expected=${expectedIsQuestion}, actual=${analysis.isQuestion}`,
      weight: 15
    },
    {
      name: "reply-count",
      passed: replies.length >= 2 && replies.length <= 3,
      details: `${replies.length} replies`,
      weight: 10
    },
    {
      name: "bridge-length",
      passed: countWords(analysis.bridgePhrase) <= 6,
      details: `${countWords(analysis.bridgePhrase)} words`,
      weight: 10
    },
    {
      name: "short-labels",
      passed: replies.every((reply) => {
        const words = countWords(reply.shortLabel);
        return words >= 1 && words <= 2;
      }),
      details: replies.map((reply) => `${reply.shortLabel}:${countWords(reply.shortLabel)}`).join(", "),
      weight: 10
    },
    {
      name: "sentence-count",
      passed: sentenceGroups.every((sentences) => sentences.length >= 1 && sentences.length <= 3),
      details: sentenceGroups.map((sentences) => sentences.length).join(", "),
      weight: 20
    },
    {
      name: "reply-length",
      passed: replies.every((reply) => countWords(reply.fullSentence) <= 45),
      details: replies.map((reply) => countWords(reply.fullSentence)).join(", "),
      weight: 25
    },
    {
      name: "russian-support",
      passed: replies.every(
        (reply) =>
          reply.shortLabelTranslation.trim().length > 0 &&
          reply.fullSentenceTranslation.trim().length > 0 &&
          reply.whyUse.trim().length > 0
      ),
      details: "translations and whyUse are present",
      weight: 10
    }
  ];

  return {
    score: checks.reduce((total, check) => total + (check.passed ? check.weight : 0), 0),
    checks: checks.map(({ weight: _weight, ...check }) => check)
  };
}

function readUsage(payload: unknown): Usage {
  const usage = (payload as { usage?: Record<string, unknown> } | null)?.usage;
  const inputTokens = typeof usage?.input_tokens === "number" ? usage.input_tokens : 0;
  const outputTokens = typeof usage?.output_tokens === "number" ? usage.output_tokens : 0;
  const totalTokens = typeof usage?.total_tokens === "number"
    ? usage.total_tokens
    : inputTokens + outputTokens;

  return { inputTokens, outputTokens, totalTokens };
}

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
    const content = (item as { content?: unknown } | null)?.content;
    if (!Array.isArray(content)) {
      continue;
    }

    for (const part of content) {
      const text = (part as { text?: unknown } | null)?.text;
      if (typeof text === "string") {
        return text;
      }
    }
  }

  return null;
}

async function requestJson(apiKey: string, body: unknown): Promise<{ payload: unknown; latencyMs: number }> {
  const startedAt = performance.now();
  const response = await fetch(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "OpenAI-Safety-Identifier": "echoguide-local-model-eval"
    },
    body: JSON.stringify(body)
  });
  const payload = await response.json() as unknown;
  const latencyMs = Math.round(performance.now() - startedAt);

  if (!response.ok) {
    const message = (payload as { error?: { message?: unknown } } | null)?.error?.message;
    throw new Error(`${response.status}: ${typeof message === "string" ? message : "OpenAI request failed"}`);
  }

  return { payload, latencyMs };
}

async function runCandidate(apiKey: string, evalCase: EvalCase, model: string): Promise<CandidateResult> {
  try {
    const request = buildBilingualPhraseAnalysisRequest(
      evalCase.transcript,
      model,
      evalCase.knowledgeContext,
      evalCase.recentContext
    );
    const { payload, latencyMs } = await requestJson(apiKey, request);
    const analysis = parseBilingualPhraseAnalysis(payload);
    const contract = checkContract(analysis, evalCase.expectedIsQuestion);

    return {
      model,
      ok: true,
      latencyMs,
      usage: readUsage(payload),
      analysis,
      contractScore: contract.score,
      contractChecks: contract.checks
    };
  } catch (error) {
    return {
      model,
      ok: false,
      latencyMs: 0,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      contractScore: 0,
      contractChecks: [],
      error: error instanceof Error ? error.message.replace(/sk-[A-Za-z0-9_-]+/gu, "sk-redacted") : "Unknown error"
    };
  }
}

function candidateKey(index: number, caseIndex: number): string {
  const keys = ["A", "B", "C", "D", "E", "F"];
  return keys[(index + caseIndex) % keys.length] ?? `C${index + 1}`;
}

async function judgeCandidates(
  apiKey: string,
  judgeModel: string,
  judgeReasoningEffort: string,
  evalCase: EvalCase,
  caseIndex: number,
  candidates: CandidateResult[]
): Promise<Map<string, Omit<JudgeCandidate, "key">>> {
  const successful = candidates.filter(
    (candidate): candidate is CandidateResult & { analysis: BilingualPhraseAnalysis } =>
      candidate.ok && candidate.analysis != null
  );
  const blinded = successful.map((candidate, index) => ({
    key: candidateKey(index, caseIndex),
    model: candidate.model,
    analysis: candidate.analysis
  }));
  const request = {
    model: judgeModel,
    reasoning: { effort: judgeReasoningEffort },
    store: false,
    max_output_tokens: 1200,
    input: [
      {
        role: "system",
        content:
          "You are a strict, model-blind evaluator for a live English interview copilot used by a Russian-speaking senior software engineer at A2/B1 English level. Score each candidate from 0 to 100. Use this rubric: factual grounding and no invented details 30 points; usefulness during a live interview 25; short natural A2/B1 English 20; correct handling of the freshest coherent thought 15; accurate Russian meaning, translations, and whyUse 10. Penalize polished long templates, unsupported metrics or technologies, awkward English, weak answer strategies, and answers that ignore the transcript. Judge only the candidate content. Do not infer which model produced it. Return every candidate exactly once. Notes must be concise and in Russian."
      },
      {
        role: "user",
        content: JSON.stringify({
          case: {
            description: evalCase.description,
            transcript: evalCase.transcript,
            expectedIsQuestion: evalCase.expectedIsQuestion,
            knowledgeContext: evalCase.knowledgeContext ?? "",
            recentContext: evalCase.recentContext ?? []
          },
          candidates: blinded.map(({ key, analysis }) => ({ key, analysis }))
        })
      }
    ],
    text: {
      format: {
        type: "json_schema",
        name: "echoguide_model_eval_judgment",
        strict: true,
        schema: judgeSchema
      }
    }
  };
  const { payload } = await requestJson(apiKey, request);
  const responseText = readResponseText(payload);
  if (responseText == null) {
    throw new Error("Judge response did not include output text.");
  }
  const parsed = JSON.parse(responseText) as JudgeResult;
  if (!Array.isArray(parsed.candidates)) {
    throw new Error("Judge response had an unexpected shape.");
  }
  const byModel = new Map<string, Omit<JudgeCandidate, "key">>();

  for (const judgment of parsed.candidates) {
    const source = blinded.find((candidate) => candidate.key === judgment.key);
    if (source != null) {
      byModel.set(source.model, { score: judgment.score, notes: judgment.notes });
    }
  }

  return byModel;
}

function percentile(values: number[], position: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(position * sorted.length))] ?? 0;
}

async function main(): Promise<void> {
  process.loadEnvFile(".env.local");
  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey == null || apiKey.trim().length === 0) {
    throw new Error("OPENAI_API_KEY is not configured in .env.local.");
  }

  const models = readModels();
  const judgeModel =
    readOption("judge") ?? process.env.ECHOGUIDE_EVAL_JUDGE_MODEL ?? defaultJudgeModel;
  const judgeReasoningEffort =
    process.env.ECHOGUIDE_EVAL_JUDGE_REASONING_EFFORT ?? defaultJudgeReasoningEffort;
  const requestedOutput = readOption("output");
  const timestamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const outputPath = resolve(requestedOutput ?? `.echoguide/evals/model-comparison-${timestamp}.json`);
  const results: Array<{ case: EvalCase; candidates: CandidateResult[] }> = [];

  console.log(`EchoGuide model eval: ${cases.length} cases x ${models.length} models; judge=${judgeModel}`);

  for (const [caseIndex, evalCase] of cases.entries()) {
    const candidates = await Promise.all(models.map((model) => runCandidate(apiKey, evalCase, model)));
    const judgments = await judgeCandidates(
      apiKey,
      judgeModel,
      judgeReasoningEffort,
      evalCase,
      caseIndex,
      candidates
    );

    for (const candidate of candidates) {
      const judgment = judgments.get(candidate.model);
      candidate.judgeScore = judgment?.score ?? 0;
      candidate.judgeNotes = judgment?.notes ?? "Judge result missing";
      candidate.finalScore = Number((candidate.contractScore * 0.3 + (candidate.judgeScore ?? 0) * 0.7).toFixed(1));
    }

    results.push({ case: evalCase, candidates });
    const leader = [...candidates].sort((a, b) => (b.finalScore ?? 0) - (a.finalScore ?? 0))[0];
    console.log(`[${caseIndex + 1}/${cases.length}] ${evalCase.id}: ${leader?.model ?? "no result"} (${leader?.finalScore ?? 0})`);
  }

  const summary = models.map((model) => {
    const candidates = results.flatMap((result) => result.candidates.filter((candidate) => candidate.model === model));
    const successful = candidates.filter((candidate) => candidate.ok);
    const average = (values: number[]) => values.length > 0
      ? values.reduce((total, value) => total + value, 0) / values.length
      : 0;

    return {
      model,
      successRate: Number((successful.length / candidates.length).toFixed(3)),
      averageFinalScore: Number(average(candidates.map((candidate) => candidate.finalScore ?? 0)).toFixed(1)),
      averageJudgeScore: Number(average(candidates.map((candidate) => candidate.judgeScore ?? 0)).toFixed(1)),
      averageContractScore: Number(average(candidates.map((candidate) => candidate.contractScore)).toFixed(1)),
      averageLatencyMs: Math.round(average(successful.map((candidate) => candidate.latencyMs))),
      p95LatencyMs: percentile(successful.map((candidate) => candidate.latencyMs), 0.95),
      totalInputTokens: successful.reduce((total, candidate) => total + candidate.usage.inputTokens, 0),
      totalOutputTokens: successful.reduce((total, candidate) => total + candidate.usage.outputTokens, 0),
      wins: results.filter((result) => {
        const winner = [...result.candidates].sort((a, b) => (b.finalScore ?? 0) - (a.finalScore ?? 0))[0];
        return winner?.model === model;
      }).length
    };
  }).sort((a, b) => b.averageFinalScore - a.averageFinalScore);

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(
    outputPath,
    `${JSON.stringify({ generatedAt: new Date().toISOString(), judgeModel, models, cases: results, summary }, null, 2)}\n`,
    "utf8"
  );

  console.table(summary);
  console.log(`Detailed results: ${outputPath}`);
}

await main();
