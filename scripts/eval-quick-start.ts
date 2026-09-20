import { existsSync } from "node:fs";
import { generateQuickStart, quickStartTimeoutMs } from "../src/realtime/quickStart.ts";
import { analyzeBilingualPhrase } from "../src/realtime/bilingualAnalysis.ts";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");
const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) throw new Error("OPENAI_API_KEY is not configured.");

const cases = [
  { id: "meeting-confirmation", transcript: "What exactly has Maria confirmed about Codex usage, and what would be going too far beyond that?", speakerLabel: "Interviewer", mode: "start", recentContext: [], knowledgeContext: "" },
  { id: "database-choice", transcript: "Why didn't you use PostgreSQL?", speakerLabel: "Interviewer", mode: "start",
    recentContext: ["Interviewer: Let's discuss the analytics database.", "Me: The workload involved scanning many rows."],
    knowledgeContext: "Synthetic example: I evaluated query plans. Wide scans dominated the workload. No measured performance gain is recorded." },
  { id: "follow-up", transcript: "And your part?", speakerLabel: "Interviewer", mode: "start",
    recentContext: ["Interviewer: Tell me about the API migration.", "Me: The team moved the API to a new service."], knowledgeContext: "" },
  { id: "stuck", transcript: "Я добавил проверку входных данных, чтобы... не знаю, как это сказать по-английски.", speakerLabel: "Me", mode: "continue",
    recentContext: ["Interviewer: How did you handle bad requests?", "Me: Invalid requests were reaching the database."], knowledgeContext: "" },
  { id: "complete-answer", transcript: "I fixed the validation and added a regression test.", speakerLabel: "Me", mode: "wait", recentContext: [], knowledgeContext: "" },
  { id: "ambiguous", transcript: "Why that one?", speakerLabel: "Interviewer", mode: "clarify", recentContext: [], knowledgeContext: "" },
  { id: "unfinished-question", transcript: "Before we discuss the result, let me explain the situation and", speakerLabel: "Interviewer", mode: "wait", recentContext: [], knowledgeContext: "" }
];
const durations: number[] = [];
let failures = 0;
for (const fixture of cases) {
  const start = performance.now();
  try {
    const opening = await generateQuickStart({ apiKey, ...fixture,
      model: process.env.OPENAI_QUICK_START_MODEL,
      reasoningEffort: process.env.OPENAI_QUICK_START_REASONING_EFFORT });
    const durationMs = Math.round(performance.now() - start);
    durations.push(durationMs);
    const unsupportedClaim = fixture.mode === "start" && /\b(?:I|we)\s+(?:chose|considered|helped|tested|built|wanted|needed|decided|worked|was responsible|focused)\b/i.test(opening.english);
    const repeatedDraft = fixture.id === "stuck" && /^I added/i.test(opening.english);
    const processNarration = /\b(?:documents?|files?|evidence|RAG|prompts?|insufficient|substantiate)\b/i.test(opening.english);
    const followUpPromise = /follow up|after the meeting/i.test(opening.english);
    const passed = !processNarration && !followUpPromise && opening.mode === fixture.mode && !unsupportedClaim && !repeatedDraft;
    if (!passed) failures++;
    console.log(JSON.stringify({ id: fixture.id, durationMs, passed, processNarration, followUpPromise, unsupportedClaim, repeatedDraft, expectedMode: fixture.mode, ...opening }));
    if (fixture.id === "database-choice" && opening.mode !== "wait") {
      const answerStarted = performance.now();
      const card = await analyzeBilingualPhrase({ apiKey, transcript: fixture.transcript,
        recentContext: fixture.recentContext, knowledgeContext: fixture.knowledgeContext, quickStart: opening });
      console.log(JSON.stringify({ id: "continuation", durationMs: Math.round(performance.now() - answerStarted),
        replies: card.suggestedReplies.map((reply) => reply.fullSentence) }));
    }
  } catch (error) {
    failures++;
    console.log(JSON.stringify({ id: fixture.id, passed: false, durationMs: Math.round(performance.now() - start),
      error: error instanceof Error ? error.name : "UnknownError" }));
  }
}
console.log(JSON.stringify({ total: cases.length, failures, timeoutMs: quickStartTimeoutMs,
  minMs: durations.length ? Math.min(...durations) : null,
  maxMs: durations.length ? Math.max(...durations) : null,
  meanMs: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null }));
process.exitCode = failures ? 1 : 0;
