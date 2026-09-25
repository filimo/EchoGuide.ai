import { englishRealtimeTranscriptionPrompt, russianRealtimeTranscriptionPrompt, realtimeTranscriptionPrompt } from "./realtimeSession.ts";

const normalize = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();
const knownPrompts = [englishRealtimeTranscriptionPrompt, russianRealtimeTranscriptionPrompt, realtimeTranscriptionPrompt].map(prompt => {
  const secondSentenceEnd = prompt.indexOf(". ", prompt.indexOf(". ") + 2);
  return { full: normalize(prompt), minimumEcho: normalize(prompt.slice(0, secondSentenceEnd + 1)) };
});

// A long exact prefix ending at a sentence boundary is also a prompt echo.
// Keep a single matching sentence: it could be ordinary speech.
export function withoutTranscriptionPrompt(text: string): string {
  const unlabeled = text.replace(/^(?:Me|Heard|Interviewer):\s*/i, "");
  const candidate = normalize(unlabeled);
  return knownPrompts.some(({ full, minimumEcho }) =>
    candidate === full || (candidate.length >= minimumEcho.length && candidate.endsWith(".") && full.startsWith(candidate))) ? "" : text.trim();
}

// Explicit conversational handoffs only: never split on language or an arbitrary question mark.
export function focusExplicitHandoff(text: string): string {
  const handoff = /(?:^|[.!?]\s+|\n)(?:(?:а\s+)?(?:теперь\s+)?следующий вопрос|(?:а\s+)?следующая фраза такая|(?:and\s+)?(?:now\s+)?(?:the\s+)?next question(?:\s+is)?)\s*:\s*/giu;
  let focused = text;
  for (const match of text.matchAll(handoff)) {
    const prefix = text.slice(0, match.index! + match[0].length);
    // A quoted handoff is reported speech, not a new conversational turn.
    if ((prefix.match(/"/g)?.length ?? 0) % 2 ||
      prefix.lastIndexOf("«") > prefix.lastIndexOf("»") ||
      prefix.lastIndexOf("“") > prefix.lastIndexOf("”")) continue;
    const tail = text.slice(match.index! + match[0].length).trim();
    if (tail) focused = tail;
  }
  return focused;
}

export type GenerationInput = { version: 1; transcript: string; recentContext: string[] };
export function prepareGenerationInput(transcript: string, recentContext: string[] = []): GenerationInput {
  return {
    version: 1,
    transcript: focusExplicitHandoff(withoutTranscriptionPrompt(transcript)),
    recentContext: recentContext.map(withoutTranscriptionPrompt).filter(Boolean).map(turn => {
      const label = turn.match(/^(?:Me|Heard|Interviewer):\s*/)?.[0] ?? "";
      return label + focusExplicitHandoff(turn.slice(label.length));
    })
  };
}
