import { describe, expect, it, vi } from "vitest";
import {
  buildFastTranslationRequest,
  defaultFastTranslationModel,
  defaultFastTranslationReasoningEffort,
  translatePhraseToRussian
} from "./fastTranslation";

describe("fast Russian translation", () => {
  it("builds a small low-latency GPT-5 nano request", () => {
    expect(buildFastTranslationRequest(" What was your role? ")).toMatchObject({
      model: defaultFastTranslationModel,
      reasoning: { effort: defaultFastTranslationReasoningEffort },
      input: "What was your role?",
      max_output_tokens: 120,
      text: { verbosity: "low" },
      store: false
    });
  });

  it("returns only the translated response text", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ output_text: " Какова была ваша роль? " })
    });

    await expect(
      translatePhraseToRussian({
        apiKey: "sk-test",
        transcript: "What was your role?",
        fetchImpl
      })
    ).resolves.toBe("Какова была ваша роль?");

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.openai.com/v1/responses",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer sk-test" })
      })
    );
  });
});
