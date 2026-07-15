// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import {
  OPENAI_AUDIO_TRANSCRIPTIONS_URL,
  audioRecoveryPrompt,
  splitRecoveredTranscript,
  transcribeRecoveredAudio
} from "./audioRecovery";

describe("recovered audio transcription", () => {
  it("splits the full bilingual transcript into chronological phrase candidates", () => {
    expect(
      splitRecoveredTranscript(
        "Could you explain that trade-off? I think latency is the main issue.\nДа, согласен.\nOne more thing"
      )
    ).toEqual([
      "Could you explain that trade-off?",
      "I think latency is the main issue.",
      "Да, согласен.",
      "One more thing"
    ]);
    expect(splitRecoveredTranscript("   ")).toEqual([]);
  });

  it("uploads the WAV file with server-side credentials and the recovery prompt", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ text: "  Could you explain that trade-off?  " })
    });

    const transcript = await transcribeRecoveredAudio({
      apiKey: "sk-server-only",
      audioBytes: new Uint8Array([82, 73, 70, 70]),
      model: "gpt-transcribe-recovery",
      fetchImpl
    });

    expect(transcript).toBe("Could you explain that trade-off?");
    expect(fetchImpl).toHaveBeenCalledWith(
      OPENAI_AUDIO_TRANSCRIPTIONS_URL,
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "Bearer sk-server-only",
          "OpenAI-Safety-Identifier": "echoguide-local-dev"
        },
        body: expect.any(FormData)
      })
    );
    const form = fetchImpl.mock.calls[0][1].body as FormData;
    expect(form.get("model")).toBe("gpt-transcribe-recovery");
    expect(form.get("response_format")).toBe("json");
    expect(form.get("prompt")).toBe(audioRecoveryPrompt);
    expect(form.get("file")).toBeInstanceOf(Blob);
  });

  it("returns a safe error when the upstream transcription fails", async () => {
    await expect(
      transcribeRecoveredAudio({
        apiKey: "sk-server-only",
        audioBytes: new Uint8Array([1, 2, 3]),
        fetchImpl: vi.fn().mockResolvedValue({
          ok: false,
          status: 429,
          json: vi.fn().mockResolvedValue({ error: { message: "Rate limit reached" } })
        })
      })
    ).rejects.toThrow("status 429: Rate limit reached");
  });
});
