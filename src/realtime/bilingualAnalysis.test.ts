// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import {
  analyzeBilingualPhrase,
  buildBilingualPhraseAnalysisRequest,
  maxRecentContextCharacters,
  maxRecentContextTurns,
  normalizeRecentContext,
  parseBilingualPhraseAnalysis
} from "./bilingualAnalysis";

function response(body: unknown, init: { ok: boolean; status: number }): Response {
  return {
    ok: init.ok,
    status: init.status,
    json: vi.fn().mockResolvedValue(body)
  } as unknown as Response;
}

describe("bilingual phrase analysis", () => {
  it("builds a structured Responses API request for interview phrase analysis", () => {
    const request = buildBilingualPhraseAnalysisRequest("What was your role?", "gpt-test");

    expect(request).toMatchObject({
      model: "gpt-test",
      store: false,
      input: [
        expect.objectContaining({ role: "system" }),
        {
          role: "user",
          content: "Active transcript: What was your role?"
        }
      ],
      text: {
        format: expect.objectContaining({
          type: "json_schema",
          name: "echoguide_phrase_analysis",
          strict: true
        })
      }
    });

    expect(request.input[0]?.content).toContain("A2/B1");
    expect(request.input[0]?.content).toContain("clear, natural spoken English");
    expect(request.input[0]?.content).toContain("The transcript can contain English or Russian");
    expect(request.input[0]?.content).toContain("1-3 short conversational English sentences");
    expect(request.input[0]?.content).toContain("no more than 45 words in total");
    expect(request.input[0]?.content).toContain("answer directly in the first sentence");
    expect(request.input[0]?.content).toContain("brief situation-action-result flow");
    expect(request.input[0]?.content).toContain(
      "Never force a challenge, action, or outcome into every answer"
    );
    expect(request.input[0]?.content).toContain("Use contractions");
    expect(request.input[0]?.content).toContain("whyUse");
    expect(request.input[0]?.content).toContain("Classify the active transcript speakerRole");
    expect(request.text.format.schema.required).toContain("speakerRole");
    expect(
      request.text.format.schema.properties.suggestedReplies.items.required
    ).toContain("whyUse");
    expect(request.input[0]?.content).toContain(
      "Improve it into natural spoken English instead of giving feedback about it"
    );
    expect(request.input[0]?.content).toContain(
      "Remove filler, false starts, accidental repetition, and obvious transcription errors"
    );
    expect(request.input[0]?.content).toContain(
      "silently read every English reply as spoken language"
    );
    expect(request.input[0]?.content).not.toContain(
      "Each English sentence must be maximum 10 words"
    );
  });

  it("uses gpt-5.6-luna with no reasoning effort by default", () => {
    const request = buildBilingualPhraseAnalysisRequest("What was your role?");

    expect(request).toMatchObject({
      model: "gpt-5.6-luna",
      reasoning: {
        effort: "none"
      }
    });
  });

  it("uses the configured reasoning effort for the bilingual model", () => {
    const request = buildBilingualPhraseAnalysisRequest(
      "What was your role?",
      "gpt-5.6-luna",
      undefined,
      undefined,
      { reasoningEffort: "low" }
    );

    expect(request).toMatchObject({
      model: "gpt-5.6-luna",
      reasoning: {
        effort: "low"
      }
    });
  });

  it("omits reasoning effort for legacy non-reasoning card models", () => {
    const request = buildBilingualPhraseAnalysisRequest("What was your role?", "gpt-4.1-mini");

    expect(request).not.toHaveProperty("reasoning");
  });

  it("sets reasoning effort to none for gpt-5.1", () => {
    const request = buildBilingualPhraseAnalysisRequest("What was your role?", "gpt-5.1");

    expect(request).toMatchObject({
      model: "gpt-5.1",
      reasoning: {
        effort: "none"
      }
    });
  });

  it("sets reasoning effort to none for current gpt-5 mini models", () => {
    const request = buildBilingualPhraseAnalysisRequest("What was your role?", "gpt-5.4-mini");

    expect(request).toMatchObject({
      model: "gpt-5.4-mini",
      reasoning: {
        effort: "none"
      }
    });
  });

  it("includes personal knowledge context as factual background when provided", () => {
    const request = buildBilingualPhraseAnalysisRequest(
      "Can you describe your AI integration work?",
      "gpt-test",
      "Project: EchoGuide. Role: built Realtime VAD training flow."
    );

    expect(request.input).toEqual([
      expect.objectContaining({
        role: "system",
        content: expect.stringContaining(
          "Use personal knowledge context only as factual background"
        )
      }),
      {
        role: "user",
        content:
          "Personal knowledge context:\nProject: EchoGuide. Role: built Realtime VAD training flow."
      },
      {
        role: "user",
        content: "Active transcript: Can you describe your AI integration work?"
      }
    ]);
  });

  it("includes recent transcript context and asks for a fresh thought target", () => {
    const request = buildBilingualPhraseAnalysisRequest(
      "Find useful method.",
      "gpt-test",
      "",
      [
        "Interviewer: How do you keep learning?",
        "And exploring new AI tools regularly.",
        "I test them in small projects. This helps me find useful methods."
      ]
    );

    expect(request.input[0]?.content).toContain("freshest coherent thought");
    expect(request.input[0]?.content).toContain("analysisTargetText");
    expect(request.text.format.schema.required).toContain("analysisTargetText");
    expect(request.input).toEqual([
      expect.objectContaining({ role: "system" }),
      {
        role: "user",
        content:
          "Recent transcript context:\n1. Interviewer: How do you keep learning?\n2. Heard: And exploring new AI tools regularly.\n3. Heard: I test them in small projects. This helps me find useful methods.\n\nActive transcript: Find useful method.\nBuild the card for the freshest coherent thought."
      }
    ]);
  });

  it("keeps up to fifteen recent turns within a five-thousand-character window", () => {
    const turns = Array.from({ length: 20 }, (_, index) => `Turn ${index + 1}`);

    expect(maxRecentContextTurns).toBe(15);
    expect(maxRecentContextCharacters).toBe(5000);
    expect(normalizeRecentContext(turns)).toEqual(turns.slice(-15));
    expect(normalizeRecentContext(["A".repeat(3000), "B".repeat(3000)])).toEqual([
      "B".repeat(3000)
    ]);
  });

  it("omits empty personal knowledge context from the Responses request", () => {
    const request = buildBilingualPhraseAnalysisRequest("What was your role?", "gpt-test", "   ");

    expect(request.input).toHaveLength(2);
    expect(request.input).toEqual([
      expect.objectContaining({ role: "system" }),
      {
        role: "user",
        content: "Active transcript: What was your role?"
      }
    ]);
  });

  it("parses the compact JSON output text from a Responses API payload", () => {
    expect(
      parseBilingualPhraseAnalysis({
        output_text: JSON.stringify({
          analysisTargetText: "What was your role?",
          speakerRole: "interviewer",
          russianMeaning: "Какую роль ты выполнял?",
          isQuestion: true,
          bridgePhrase: "Good question, let me explain.",
          suggestedReplies: [
            {
              shortLabel: "My role",
              shortLabelTranslation: "Моя роль",
              fullSentence:
                "I worked on the user flow. The challenge was unclear scope. I clarified the scope. It helped delivery.",
              fullSentenceTranslation:
                "Я работал над пользовательским сценарием. Сложностью был неясный объём. Я уточнил объём. Это помогло поставке.",
              whyUse: "Когда нужно коротко показать роль, сложность и результат."
            }
          ]
        })
      })
    ).toEqual({
      analysisTargetText: "What was your role?",
      speakerRole: "interviewer",
      russianMeaning: "Какую роль ты выполнял?",
      isQuestion: true,
      bridgePhrase: "Good question, let me explain.",
      suggestedReplies: [
        {
          shortLabel: "My role",
          shortLabelTranslation: "Моя роль",
          fullSentence:
            "I worked on the user flow. The challenge was unclear scope. I clarified the scope. It helped delivery.",
          fullSentenceTranslation:
            "Я работал над пользовательским сценарием. Сложностью был неясный объём. Я уточнил объём. Это помогло поставке.",
          whyUse: "Когда нужно коротко показать роль, сложность и результат."
        }
      ]
    });
  });

  it("calls OpenAI Responses without leaking the server key into the request body", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      response(
        {
          output_text: JSON.stringify({
            analysisTargetText: "What was your role?",
            speakerRole: "interviewer",
            russianMeaning: "Какую роль ты выполнял?",
            isQuestion: true,
            bridgePhrase: "Good question, let me explain.",
            suggestedReplies: [
              {
                shortLabel: "My role",
                shortLabelTranslation: "Моя роль",
                fullSentence:
                  "I worked on the user flow. The challenge was unclear scope. I clarified the scope. It helped delivery.",
                fullSentenceTranslation:
                  "Я работал над пользовательским сценарием. Сложностью был неясный объём. Я уточнил объём. Это помогло поставке.",
                whyUse: "Когда нужно коротко показать роль, сложность и результат."
              }
            ]
          })
        },
        { ok: true, status: 200 }
      )
    );

    await expect(
      analyzeBilingualPhrase({
        apiKey: "sk-server-only",
        transcript: "What was your role?",
        knowledgeContext: "Project: EchoGuide. Role: designed the Realtime VAD flow.",
        model: "gpt-test",
        fetchImpl
      })
    ).resolves.toMatchObject({
      russianMeaning: "Какую роль ты выполнял?",
      isQuestion: true
    });

    const body = String(fetchImpl.mock.calls[0][1].body);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.openai.com/v1/responses",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer sk-server-only"
        })
      })
    );
    expect(body).toContain("Project: EchoGuide. Role: designed the Realtime VAD flow.");
    expect(body).not.toContain("sk-server-only");
  });
});
