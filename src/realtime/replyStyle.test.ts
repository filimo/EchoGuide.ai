import { describe, expect, it } from "vitest";
import { buildBilingualPhraseAnalysisRequest } from "./bilingualAnalysis";
import { buildQuickStartRequest } from "./quickStart";
import { buildMeetingGeneralRequest } from "../meeting/generalAnswer";

describe("reply style request routing", () => {
  it("keeps the same conversational and commitment boundaries across card generators", () => {
    const question = "How would you approach the first version?";
    const phrase = buildBilingualPhraseAnalysisRequest(question, "synthetic-model");
    const prompts = [String(phrase.input[0].content),
      buildQuickStartRequest(question).instructions,
      buildMeetingGeneralRequest(question, [], "Interviewer", "synthetic-model").instructions];
    for (const prompt of prompts) {
      expect(prompt).toContain("sound like a calm colleague");
      expect(prompt).toContain("must not imply agreement with an incorrect or unverified premise");
      expect(prompt).toContain("Do not invent commitments");
      expect(prompt).toContain("Style examples only, never factual evidence");
      expect(prompt).toContain("without another acknowledgement or a repeated opening");
    }
  });
});
