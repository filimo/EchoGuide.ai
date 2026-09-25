import { describe, expect, it } from "vitest";
import { prepareGenerationInput, focusExplicitHandoff, withoutTranscriptionPrompt } from "./generationInput";
import { englishRealtimeTranscriptionPrompt, russianRealtimeTranscriptionPrompt, realtimeTranscriptionPrompt } from "./realtimeSession";

describe("generation input boundaries", () => {
  it("excludes known transcription prompts and long exact prefixes while keeping ordinary speech", () => {
    for (const prompt of [englishRealtimeTranscriptionPrompt, russianRealtimeTranscriptionPrompt, realtimeTranscriptionPrompt]) {
      expect(withoutTranscriptionPrompt(`Me: ${prompt.replaceAll(" ", "  ")}`)).toBe("");
      expect(withoutTranscriptionPrompt(prompt.slice(0, prompt.indexOf(". ", prompt.indexOf(". ") + 2) + 1))).toBe("");
    }
    for (const text of ["The spoken language is English.", "We discussed transcription prompts.",
      `I read this example: ${englishRealtimeTranscriptionPrompt}`, "usual human review", "similar tasks"]) {
      expect(withoutTranscriptionPrompt(text)).toBe(text);
    }
  });
  it("uses explicit handoffs while keeping the complete follow-up and its context", () => {
    const followup = "And if the review takes longer";
    expect(prepareGenerationInput(`Хорошее начало. А теперь следующий вопрос: ${followup}`, [
      `Me: ${englishRealtimeTranscriptionPrompt}`, "Interviewer: How much effort does the review need?"
    ])).toEqual({ version: 1, transcript: followup, recentContext: ["Interviewer: How much effort does the review need?"] });
    expect(focusExplicitHandoff("Полезный ответ. А следующая фраза такая: How do you compare costs? Include review time.")).toBe("How do you compare costs? Include review time.");
    expect(focusExplicitHandoff("Good point. Next question: Как проверить качество без метрики?")).toBe("Как проверить качество без метрики?");
  });
  it("does not infer boundaries from language changes, question marks, quotes or incomplete handoffs", () => {
    for (const text of ["What changed? And why?", "Обсудим расходы. What about review time?",
      "And if the review takes longer", 'She said "Next question: who pays?" yesterday.',
      'She read "Good point. Next question: who pays?" from a script.',
      "Our next question: who pays?", "Feedback. Next question:"]) expect(focusExplicitHandoff(text)).toBe(text);
  });
});
