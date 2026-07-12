// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import {
  buildRealtimeTranscriptionSessionUpdate,
  buildRealtimeTurnDetection,
  buildRealtimeClientSecretRequest,
  createRealtimeClientSecret,
  defaultRealtimeTurnDetectionSettings,
  defaultRealtimeVadTurnDetection,
  defaultRealtimeSpeechLanguageSettings,
  loadRealtimeSpeechLanguageSettings,
  loadRealtimeTurnDetectionSettings,
  parseRealtimeClientSecretResponse,
  parseRealtimeLabMode,
  realtimeSpeechLanguageSettingsStorageKey,
  readOpenAiApiKey,
  realtimeTurnDetectionSettingsStorageKey,
  saveRealtimeSpeechLanguageSettings,
  saveRealtimeTurnDetectionSettings
} from "./realtimeSession";

function response(body: unknown, init: { ok: boolean; status: number }): Response {
  return {
    ok: init.ok,
    status: init.status,
    json: vi.fn().mockResolvedValue(body)
  } as unknown as Response;
}

describe("Realtime client secret session helpers", () => {
  it("builds a short-lived bilingual transcription-only session request for whisper PTT", () => {
    expect(buildRealtimeClientSecretRequest("whisper-ptt")).toEqual({
      expires_after: {
        anchor: "created_at",
        seconds: 600
      },
      session: {
        type: "transcription",
        audio: {
          input: {
            transcription: {
              model: "gpt-realtime-whisper",
              delay: "medium"
            },
            turn_detection: null
          }
        }
      }
    });
  });

  it("builds a transcription-only realtime VAD session request without audio output", () => {
    expect(buildRealtimeClientSecretRequest("realtime-vad")).toEqual({
      expires_after: {
        anchor: "created_at",
        seconds: 600
      },
      session: {
        type: "transcription",
        audio: {
          input: {
            noise_reduction: {
              type: "far_field"
            },
            transcription: {
              model: "gpt-4o-transcribe",
              prompt:
                "The audio may contain only English or Russian speech. This is software engineering interview practice. Expect simple English, Russian clarifications, software projects, AI tools, data cleaning, pattern matching, React, TypeScript, APIs. Ignore short filler sounds, uncertain background noise, and anything that looks like another language."
            }
          }
        }
      }
    });
    expect(JSON.stringify(buildRealtimeClientSecretRequest("realtime-vad"))).not.toContain(
      "gpt-realtime-2.1-mini"
    );
    expect(JSON.stringify(buildRealtimeClientSecretRequest("realtime-vad"))).not.toContain(
      "output"
    );
  });

  it("builds realtime VAD requests with a fixed speech language when selected", () => {
    const englishRequest = buildRealtimeClientSecretRequest("realtime-vad", {
      speechLanguage: "english"
    });
    const russianRequest = buildRealtimeClientSecretRequest("realtime-vad", {
      speechLanguage: "russian"
    });
    const mixedRequest = buildRealtimeClientSecretRequest("realtime-vad", {
      speechLanguage: "english-russian"
    });

    expect(englishRequest.session.audio.input.transcription).toMatchObject({
      model: "gpt-4o-transcribe",
      language: "en"
    });
    expect(russianRequest.session.audio.input.transcription).toMatchObject({
      model: "gpt-4o-transcribe",
      language: "ru"
    });
    expect(mixedRequest.session.audio.input.transcription).not.toHaveProperty("language");
  });

  it("uses a slower server VAD silence timeout for deliberate speech", () => {
    expect(defaultRealtimeVadTurnDetection).toEqual({
      type: "server_vad",
      threshold: 0.5,
      prefix_padding_ms: 300,
      silence_duration_ms: 1200
    });
  });

  it("builds server VAD turn detection from adjustable settings", () => {
    expect(
      buildRealtimeTurnDetection({
        ...defaultRealtimeTurnDetectionSettings,
        threshold: 0.65,
        prefixPaddingMs: 420,
        silenceDurationMs: 1500
      })
    ).toEqual({
      type: "server_vad",
      threshold: 0.65,
      prefix_padding_ms: 420,
      silence_duration_ms: 1500
    });
  });

  it("builds semantic VAD turn detection from eagerness", () => {
    expect(
      buildRealtimeTurnDetection({
        ...defaultRealtimeTurnDetectionSettings,
        mode: "semantic_vad",
        semanticEagerness: "low"
      })
    ).toEqual({
      type: "semantic_vad",
      eagerness: "low"
    });
  });

  it("can disable automatic turn detection", () => {
    expect(
      buildRealtimeTurnDetection({
        ...defaultRealtimeTurnDetectionSettings,
        mode: "disabled"
      })
    ).toBeNull();
  });

  it("builds a transcription session update with nested VAD and language settings", () => {
    expect(
      buildRealtimeTranscriptionSessionUpdate(defaultRealtimeTurnDetectionSettings, "english")
    ).toEqual({
      type: "transcription",
      audio: {
        input: {
          turn_detection: defaultRealtimeVadTurnDetection,
          transcription: {
            model: "gpt-4o-transcribe",
            prompt:
              "The audio should be transcribed as English speech. This is software engineering interview practice. Expect simple English, software projects, AI tools, data cleaning, pattern matching, React, TypeScript, APIs. Ignore short filler sounds and uncertain background noise.",
            language: "en"
          }
        }
      }
    });
  });

  it("loads remembered speech language settings and falls back from broken storage", () => {
    const storage = new Map<string, string>();
    const storageApi = {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        storage.set(key, value);
      })
    } as unknown as Storage;

    saveRealtimeSpeechLanguageSettings(storageApi, "english");

    expect(loadRealtimeSpeechLanguageSettings(storageApi)).toBe("english");

    storage.set(realtimeSpeechLanguageSettingsStorageKey, JSON.stringify("spanish"));

    expect(loadRealtimeSpeechLanguageSettings(storageApi)).toBe(
      defaultRealtimeSpeechLanguageSettings
    );

    storage.set(realtimeSpeechLanguageSettingsStorageKey, "{broken");

    expect(loadRealtimeSpeechLanguageSettings(storageApi)).toBe(
      defaultRealtimeSpeechLanguageSettings
    );
  });

  it("loads remembered turn detection settings and falls back from broken storage", () => {
    const storage = new Map<string, string>();
    const storageApi = {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        storage.set(key, value);
      })
    } as unknown as Storage;
    const semanticSettings = {
      ...defaultRealtimeTurnDetectionSettings,
      mode: "semantic_vad" as const,
      semanticEagerness: "high" as const
    };

    saveRealtimeTurnDetectionSettings(storageApi, semanticSettings);

    expect(loadRealtimeTurnDetectionSettings(storageApi)).toEqual(semanticSettings);

    storage.set(realtimeTurnDetectionSettingsStorageKey, "{broken");

    expect(loadRealtimeTurnDetectionSettings(storageApi)).toEqual(
      defaultRealtimeTurnDetectionSettings
    );
  });

  it("parses unknown lab modes back to whisper PTT", () => {
    expect(parseRealtimeLabMode("realtime-vad")).toBe("realtime-vad");
    expect(parseRealtimeLabMode("anything-else")).toBe("whisper-ptt");
    expect(parseRealtimeLabMode(null)).toBe("whisper-ptt");
  });

  it("parses the ephemeral client secret without requiring the browser to know the API key", () => {
    const parsed = parseRealtimeClientSecretResponse({
      value: "ek_test_ephemeral",
      expires_at: 1756310470,
      session: {
        id: "sess_123",
        type: "transcription"
      }
    });

    expect(parsed).toEqual({
      clientSecret: "ek_test_ephemeral",
      expiresAt: 1756310470,
      sessionId: "sess_123"
    });
  });

  it("reads OPENAI_API_KEY from process env before local env text", () => {
    const apiKey = readOpenAiApiKey(
      { OPENAI_API_KEY: "sk-process" },
      "OPENAI_API_KEY=sk-local\nOTHER=value"
    );

    expect(apiKey).toBe("sk-process");
  });

  it("creates a client secret with the server API key and redacts upstream failures", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      response(
        {
          error: {
            message: "The key sk-should-not-leak is invalid."
          }
        },
        { ok: false, status: 401 }
      )
    );

    await expect(
      createRealtimeClientSecret({
        apiKey: "sk-server-only",
        fetchImpl
      })
    ).rejects.toThrow("OpenAI Realtime client secret request failed with status 401");

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.openai.com/v1/realtime/client_secrets",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer sk-server-only",
          "Content-Type": "application/json",
          "OpenAI-Safety-Identifier": "echoguide-local-dev"
        }),
        body: JSON.stringify(buildRealtimeClientSecretRequest())
      })
    );
  });
});
