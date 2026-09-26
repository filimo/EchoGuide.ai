import { describe, expect, it } from "vitest";
import { buildMeetingGeneralRequest, isMeetingGeneralAnswer } from "./generalAnswer";

const pair = { opening: { mode: "start", english: "I would define the goal.", russian: "Я бы определил цель." },
  continuation: { english: "Then I would test one case.", russian: "Затем я бы проверил один случай." } };

describe("meeting general answer contract", () => {
  it("requires a bilingual continuation for a speakable opening", () => {
    expect(isMeetingGeneralAnswer(pair)).toBe(true);
    expect(isMeetingGeneralAnswer({ ...pair, continuation: null })).toBe(false);
    expect(isMeetingGeneralAnswer({ opening: { mode: "wait", english: "", russian: "" }, continuation: null })).toBe(true);
    expect(isMeetingGeneralAnswer({ opening: { mode: "wait", english: "", russian: "" }, continuation: pair.continuation })).toBe(false);
  });
  it("focuses the current question without adding document evidence", () => {
    const request = buildMeetingGeneralRequest("Old feedback. Next question: How would you compare the options?",
      ["Me: We need to include review time."], "Interviewer", "synthetic-model");
    expect(JSON.parse(request.input).transcript).toBe("How would you compare the options?");
    expect(request.store).toBe(false);
    expect(request.text.format.name).toBe("meeting_general_answer");
  });
});


it("keeps a user point separate from conversational evidence and accepts saved legacy cards", () => {
  const request = buildMeetingGeneralRequest("What should we try?", [], "Interviewer", "synthetic-model", "Начать с одной задачи");
  expect(JSON.parse(request.input)).toEqual({ transcript: "What should we try?", recentContext: [], speakerLabel: "Interviewer", answerHint: "Начать с одной задачи" });
  const presentation = { gist: "Обсуждают первый шаг.", intent: "Предложить эксперимент.", clarification: null, vocabulary: [] };
  expect(isMeetingGeneralAnswer({ ...pair, presentation })).toBe(true);
  expect(isMeetingGeneralAnswer({ ...pair, presentation: { ...presentation, vocabulary: Array(4).fill({ english: "task", russian: "задача" }) } })).toBe(false);
  expect(isMeetingGeneralAnswer(pair)).toBe(true);
});
