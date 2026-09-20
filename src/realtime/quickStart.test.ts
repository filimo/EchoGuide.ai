import { englishRealtimeTranscriptionPrompt } from "./realtimeSession";
// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { buildQuickStartRequest, generateQuickStart, isQuickStart } from "./quickStart";
import { buildBilingualPhraseAnalysisRequest } from "./bilingualAnalysis";

const opening = { mode: "start" as const, english: "The workload matters here.", russian: "Здесь важна нагрузка." };

describe("contextual quick start", () => {
  it("bounds dialogue and preserves speaker labels without sending personal notes", () => {
    const request = buildQuickStartRequest("  Why?  ", Array.from({ length: 12 }, (_, i) => `Me: turn ${i}`), "Interviewer");
    const input = JSON.parse(request.input);
    expect(input.transcript).toBe("Why?");
    expect(input.recentContext).toHaveLength(8);
    expect(input.recentContext[0]).toBe("Me: turn 4");
    expect(input.speakerLabel).toBe("Interviewer");
    expect(request.store).toBe(false);
    expect(buildQuickStartRequest("x".repeat(5000), ["y".repeat(5000)]).input.length).toBeLessThan(7200);
  });

  it("accepts bilingual openings and explicit silence but rejects invalid/long output", () => {
    expect(isQuickStart(opening)).toBe(true);
    expect(isQuickStart({ mode: "wait", english: "", russian: "" })).toBe(true);
    expect(isQuickStart({ ...opening, mode: "wait" })).toBe(false);
    expect(isQuickStart({ ...opening, english: "word ".repeat(36) })).toBe(false);
    expect(isQuickStart({ ...opening, russian: "" })).toBe(false);
  });

  it("reads actual Responses output and sends a bounded abortable request", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status: "completed", output: [{ content: [{ type: "output_text", text: JSON.stringify(opening) }] }]
    })));
    expect(await generateQuickStart({ apiKey: "fake", transcript: "Why this database?", fetchImpl })).toEqual(opening);
    expect(fetchImpl.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it("rejects incomplete, refused and failed responses without forwarding upstream content", async () => {
    for (const payload of [{ status: "incomplete", output_text: JSON.stringify(opening) },
      { output: [{ content: [{ type: "refusal", refusal: "no" }] }] }]) {
      await expect(generateQuickStart({ apiKey: "fake", transcript: "Hi", fetchImpl:
        vi.fn().mockResolvedValue(new Response(JSON.stringify(payload))) })).rejects.toThrow();
    }
    await expect(generateQuickStart({ apiKey: "fake", transcript: "Hi", fetchImpl:
      vi.fn().mockResolvedValue(new Response("private upstream body", { status: 500 })) })).rejects.not.toThrow("private");
  });

  it("gives the full answer the shown opening outside the stable cache prefix", () => {
    const request = buildBilingualPhraseAnalysisRequest("Why?", undefined, "facts", ["Me: Analytics"], { quickStart: opening });
    expect(JSON.stringify(request.input.at(-1))).toContain("The workload matters here.");
    expect(JSON.stringify(request.input.at(-1))).toContain("not evidence");
    expect(JSON.stringify(request.input.slice(0, -1))).not.toContain("The workload matters here.");
  });
});

it("filters prompt echoes and focuses explicit handoffs in the actual quick request", async () => {
  const input = JSON.parse(buildQuickStartRequest("Good explanation. Next question: And if it costs more", [`Me: ${englishRealtimeTranscriptionPrompt}`, "Me: Review has a cost."]).input);
  expect(input.transcript).toBe("And if it costs more");
  expect(input.recentContext).toEqual(["Me: Review has a cost."]);
  const fetchImpl = vi.fn();
  expect(await generateQuickStart({ apiKey: "fake", transcript: englishRealtimeTranscriptionPrompt, fetchImpl })).toEqual({ mode: "wait", english: "", russian: "" });
  expect(fetchImpl).not.toHaveBeenCalled();
});
