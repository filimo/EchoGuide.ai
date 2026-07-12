// @vitest-environment node

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { createRealtimeClientSecretMiddleware as createRealtimeClientSecretMiddlewareBase } from "./realtimeDevServer";
import type { SessionHistoryEntryDraft } from "../domain/sessionHistory";

type FakeResponse = {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  setHeader: (name: string, value: string) => void;
  end: (body?: string) => void;
};

const testDiagnosticsDirectoryPath = mkdtempSync(join(tmpdir(), "echoguide-diagnostics-"));

function createRealtimeClientSecretMiddleware(
  options: Parameters<typeof createRealtimeClientSecretMiddlewareBase>[0] = {}
) {
  return createRealtimeClientSecretMiddlewareBase({
    realtimeDiagnosticsDirectoryPath: testDiagnosticsDirectoryPath,
    ...options
  });
}

function createResponse(): FakeResponse {
  return {
    statusCode: 200,
    headers: {},
    body: "",
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end(body = "") {
      this.body = body;
    }
  };
}

describe("Realtime dev server middleware", () => {
  it("continuously stores privacy-safe frontend Realtime diagnostics without an OpenAI key", async () => {
    const realtimeDiagnosticsDirectoryPath = mkdtempSync(
      join(tmpdir(), "echoguide-frontend-diagnostics-")
    );
    const middleware = createRealtimeClientSecretMiddleware({
      env: {},
      readLocalEnv: () => "",
      realtimeDiagnosticsDirectoryPath,
      now: () => new Date("2026-07-11T12:00:00.000Z")
    });
    const res = createResponse();
    const report = {
      version: 1,
      reportId: "diag-1752235200000-abcdefgh",
      capturedAt: "2026-07-11T12:00:00.000Z",
      trigger: "automatic",
      runtime: {
        path: "/",
        userAgent: "iPad Safari",
        visibilityState: "visible"
      },
      status: {
        realtime: "connected",
        microphonePresent: true,
        clientSecretExpiresAt: 1752238800,
        openAiSessionId: "sess_safe"
      },
      audio: {
        latestStats: null,
        tracks: [{ kind: "audio", readyState: "live", enabled: true, muted: false }]
      },
      events: [
        {
          at: "2026-07-11T12:00:00.000Z",
          type: "audio_context.state",
          details: {
            state: "running",
            transcript: "THIS MUST NEVER BE STORED"
          }
        }
      ],
      transcript: "THIS MUST NEVER BE STORED",
      knowledgeContext: "PRIVATE NOTES"
    };

    await middleware(
      { method: "POST", url: "/api/diagnostics/realtime", body: JSON.stringify(report) },
      res,
      vi.fn()
    );

    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body)).toEqual({
      reportId: report.reportId,
      storedAt: "2026-07-11T12:00:00.000Z"
    });
    const storedLog = readFileSync(
      join(realtimeDiagnosticsDirectoryPath, "realtime-2026-07-11.jsonl"),
      "utf8"
    );
    expect(JSON.parse(storedLog)).toMatchObject({
      source: "frontend",
      reportId: report.reportId,
      trigger: "automatic"
    });
    expect(storedLog).not.toContain("THIS MUST NEVER BE STORED");
    expect(storedLog).not.toContain("PRIVATE NOTES");
    expect(storedLog).not.toContain("knowledgeContext");
  });

  it("serves the ignored local knowledge pack without requiring an OpenAI key", async () => {
    const localKnowledgeFilePath = join(
      mkdtempSync(join(tmpdir(), "echoguide-knowledge-")),
      "knowledge.local.md"
    );
    writeFileSync(localKnowledgeFilePath, "Project: EchoGuide\nRole: local practice context", "utf8");
    const middleware = createRealtimeClientSecretMiddleware({
      env: {},
      readLocalEnv: () => "",
      localKnowledgeFilePath
    });
    const res = createResponse();

    await middleware({ method: "GET", url: "/api/knowledge/local" }, res, vi.fn());

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      knowledgeContext: "Project: EchoGuide\nRole: local practice context"
    });
  });

  it("returns a browser-safe client secret payload from local env", async () => {
    const createClientSecret = vi.fn().mockResolvedValue({
      clientSecret: "ek_ephemeral",
      expiresAt: 1756310470,
      sessionId: "sess_123"
    });
    const middleware = createRealtimeClientSecretMiddleware({
      env: {},
      readLocalEnv: () => "OPENAI_API_KEY=sk-local-only",
      createClientSecret
    });
    const res = createResponse();

    await middleware(
      { method: "GET", url: "/api/realtime/client-secret" },
      res,
      vi.fn()
    );

    expect(createClientSecret).toHaveBeenCalledWith({
      apiKey: "sk-local-only",
      mode: "whisper-ptt"
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(res.body)).toEqual({
      clientSecret: "ek_ephemeral",
      expiresAt: 1756310470,
      sessionId: "sess_123"
    });
    expect(res.body).not.toContain("sk-local-only");
  });

  it("passes the requested realtime lab mode to client secret creation", async () => {
    const createClientSecret = vi.fn().mockResolvedValue({
      clientSecret: "ek_ephemeral",
      expiresAt: 1756310470
    });
    const middleware = createRealtimeClientSecretMiddleware({
      env: { OPENAI_API_KEY: "sk-process" },
      readLocalEnv: () => "",
      createClientSecret
    });
    const res = createResponse();

    await middleware(
      { method: "GET", url: "/api/realtime/client-secret?mode=realtime-vad" },
      res,
      vi.fn()
    );

    expect(createClientSecret).toHaveBeenCalledWith({
      apiKey: "sk-process",
      mode: "realtime-vad"
    });
    expect(res.statusCode).toBe(200);
  });

  it("returns a visible setup error when OPENAI_API_KEY is missing", async () => {
    const middleware = createRealtimeClientSecretMiddleware({
      env: {},
      readLocalEnv: () => "",
      createClientSecret: vi.fn()
    });
    const res = createResponse();

    await middleware(
      { method: "GET", url: "/api/realtime/client-secret" },
      res,
      vi.fn()
    );

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({
      error: "OPENAI_API_KEY is not configured for the Realtime Lab."
    });
  });

  it("passes unrelated dev server requests to the next middleware", async () => {
    const next = vi.fn();
    const middleware = createRealtimeClientSecretMiddleware({
      env: {},
      readLocalEnv: () => "",
      createClientSecret: vi.fn()
    });

    await middleware({ method: "GET", url: "/src/main.tsx" }, createResponse(), next);

    expect(next).toHaveBeenCalledOnce();
  });
});

describe("Bilingual analysis dev middleware", () => {
  function createBodyStream(body: string) {
    return {
      method: "POST",
      url: "/api/realtime/analyze-phrase",
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(body);
      }
    };
  }

  it("analyzes a transcript with the server API key and returns browser-safe JSON", async () => {
    const analyzePhrase = vi.fn().mockResolvedValue({
      russianMeaning: "Можешь рассказать о последнем проекте?",
      isQuestion: true,
      bridgePhrase: "Sure, let me think for a second.",
      suggestedReplies: [
        {
          shortLabel: "Project scope",
          shortLabelTranslation: "Объём проекта",
          fullSentence: "Sure, the project focused on making the user flow clearer and faster.",
          fullSentenceTranslation:
            "Да, проект был сфокусирован на том, чтобы сделать пользовательский сценарий понятнее и быстрее."
        }
      ]
    });
    const middleware = createRealtimeClientSecretMiddleware({
      env: {},
      readLocalEnv: () => "OPENAI_API_KEY=sk-local-only",
      analyzePhrase
    });
    const res = createResponse();

    await middleware(
      {
        method: "POST",
        url: "/api/realtime/analyze-phrase",
        body: JSON.stringify({
          transcript: "Can you walk me through your recent project?",
          knowledgeContext: "Project: EchoGuide. Role: built Realtime VAD flow.",
          recentContext: [
            "I read articles.",
            "I test AI tools in small projects.",
            "Can you walk me through your recent project?"
          ]
        })
      },
      res,
      vi.fn()
    );

    expect(analyzePhrase).toHaveBeenCalledWith({
      apiKey: "sk-local-only",
      transcript: "Can you walk me through your recent project?",
      knowledgeContext: "Project: EchoGuide. Role: built Realtime VAD flow.",
      recentContext: [
        "I read articles.",
        "I test AI tools in small projects.",
        "Can you walk me through your recent project?"
      ]
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      russianMeaning: "Можешь рассказать о последнем проекте?",
      isQuestion: true
    });
    expect(res.body).not.toContain("sk-local-only");
  });

  it("reads phrase analysis POST body from the dev server request stream", async () => {
    const analyzePhrase = vi.fn().mockResolvedValue({
      russianMeaning: "Какую роль ты выполнял?",
      isQuestion: true,
      bridgePhrase: "Good question, let me explain.",
      suggestedReplies: [
        {
          shortLabel: "My role",
          shortLabelTranslation: "Моя роль",
          fullSentence: "My role was to clarify the scope and implement the user-facing flow.",
          fullSentenceTranslation:
            "Моя роль заключалась в уточнении объёма работ и реализации пользовательского сценария."
        }
      ]
    });
    const middleware = createRealtimeClientSecretMiddleware({
      env: { OPENAI_API_KEY: "sk-process" },
      readLocalEnv: () => "",
      analyzePhrase
    });
    const res = createResponse();

    await middleware(
      createBodyStream(JSON.stringify({ transcript: "What was your role?" })),
      res,
      vi.fn()
    );

    expect(analyzePhrase).toHaveBeenCalledWith({
      apiKey: "sk-process",
      transcript: "What was your role?",
      knowledgeContext: "",
      recentContext: []
    });
    expect(res.statusCode).toBe(200);
  });

  it("preserves Cyrillic when a request chunk splits a UTF-8 character", async () => {
    const analyzePhrase = vi.fn().mockResolvedValue({
      russianMeaning: "Да, хорошо.",
      isQuestion: false,
      bridgePhrase: "Sure, let me think.",
      suggestedReplies: []
    });
    const middleware = createRealtimeClientSecretMiddleware({
      env: { OPENAI_API_KEY: "sk-process" },
      readLocalEnv: () => "",
      analyzePhrase
    });
    const res = createResponse();
    const transcript = "Да, попробуй чуть мягче.";
    const body = Buffer.from(JSON.stringify({ transcript }), "utf8");
    const cyrillicCharacterStart = body.indexOf(Buffer.from("я", "utf8"));
    const splitInsideCharacter = cyrillicCharacterStart + 1;
    const request = {
      method: "POST",
      url: "/api/realtime/analyze-phrase",
      async *[Symbol.asyncIterator]() {
        yield body.subarray(0, splitInsideCharacter);
        yield body.subarray(splitInsideCharacter);
      }
    };

    await middleware(
      request,
      res,
      vi.fn()
    );

    expect(analyzePhrase).toHaveBeenCalledWith({
      apiKey: "sk-process",
      transcript,
      knowledgeContext: "",
      recentContext: []
    });
    expect(res.statusCode).toBe(200);
  });

  it("trims overly long knowledge context before calling OpenAI", async () => {
    const analyzePhrase = vi.fn().mockResolvedValue({
      russianMeaning: "Какую роль ты выполнял?",
      isQuestion: true,
      bridgePhrase: "Good question, let me explain.",
      suggestedReplies: []
    });
    const middleware = createRealtimeClientSecretMiddleware({
      env: { OPENAI_API_KEY: "sk-process" },
      readLocalEnv: () => "",
      analyzePhrase
    });
    const res = createResponse();
    const longContext = `${"x".repeat(6100)} trailing`;

    await middleware(
      {
        method: "POST",
        url: "/api/realtime/analyze-phrase",
        body: JSON.stringify({
          transcript: "What was your role?",
          knowledgeContext: longContext
        })
      },
      res,
      vi.fn()
    );

    expect(analyzePhrase).toHaveBeenCalledWith({
      apiKey: "sk-process",
      transcript: "What was your role?",
      knowledgeContext: "x".repeat(6000),
      recentContext: []
    });
    expect(res.statusCode).toBe(200);
  });

  it("rejects invalid phrase analysis JSON before calling OpenAI", async () => {
    const analyzePhrase = vi.fn();
    const middleware = createRealtimeClientSecretMiddleware({
      env: { OPENAI_API_KEY: "sk-process" },
      readLocalEnv: () => "",
      analyzePhrase
    });
    const res = createResponse();

    await middleware(createBodyStream("{"), res, vi.fn());

    expect(analyzePhrase).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: "Phrase request body must be valid JSON."
    });
  });

  it("rejects empty phrase analysis requests before calling OpenAI", async () => {
    const analyzePhrase = vi.fn();
    const middleware = createRealtimeClientSecretMiddleware({
      env: { OPENAI_API_KEY: "sk-process" },
      readLocalEnv: () => "",
      analyzePhrase
    });
    const res = createResponse();

    await middleware(
      { method: "POST", url: "/api/realtime/analyze-phrase", body: JSON.stringify({}) },
      res,
      vi.fn()
    );

    expect(analyzePhrase).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: "Phrase transcript is required."
    });
  });
});

describe("Training session disk history middleware", () => {
  const draftSession: SessionHistoryEntryDraft = {
    sourceLabel: "ChatGPT Real Voice practice",
    knowledgeContext: "Project notes",
    transcriptTurns: [
      {
        id: "training-phrase-0",
        speakerLabel: "Heard",
        text: "Can you describe your project?"
      }
    ],
    phraseCards: [
      {
        id: "training-phrase-0",
        transcript: "Can you describe your project?",
        analysis: {
          russianMeaning: "Можешь описать свой проект?",
          isQuestion: true,
          bridgePhrase: "Sure, briefly.",
          suggestedReplies: []
        }
      }
    ],
    selectedReplies: [],
    usedBridgePhrases: []
  };

  it("stores Training Mode sessions on disk and updates the current session by id", async () => {
    const sessionHistoryFilePath = join(
      mkdtempSync(join(tmpdir(), "echoguide-sessions-")),
      "history.json"
    );
    const middleware = createRealtimeClientSecretMiddleware({
      env: {},
      readLocalEnv: () => "",
      sessionHistoryFilePath,
      now: () => new Date("2026-07-08T12:00:00.000Z")
    });
    const firstSave = createResponse();

    await middleware(
      {
        method: "POST",
        url: "/api/sessions/current",
        body: JSON.stringify({
          sessionId: "session-active",
          session: draftSession
        })
      },
      firstSave,
      vi.fn()
    );

    expect(firstSave.statusCode).toBe(200);
    expect(JSON.parse(firstSave.body)).toMatchObject({
      id: "session-active",
      transcriptTurns: [{ text: "Can you describe your project?" }]
    });

    const secondSave = createResponse();

    await middleware(
      {
        method: "POST",
        url: "/api/sessions/current",
        body: JSON.stringify({
          sessionId: "session-active",
          session: {
            ...draftSession,
            transcriptTurns: [
              {
                id: "training-phrase-1",
                speakerLabel: "Heard",
                text: "What was your role?"
              }
            ],
            phraseCards: []
          }
        })
      },
      secondSave,
      vi.fn()
    );

    const loadResponse = createResponse();

    await middleware({ method: "GET", url: "/api/sessions" }, loadResponse, vi.fn());

    expect(loadResponse.statusCode).toBe(200);
    expect(JSON.parse(loadResponse.body)).toMatchObject({
      sessions: [
        {
          id: "session-active",
          transcriptTurns: [{ text: "What was your role?" }]
        }
      ]
    });
    expect(JSON.parse(readFileSync(sessionHistoryFilePath, "utf8")).sessions).toHaveLength(1);
  });

  it("deletes a Training Mode session from disk history", async () => {
    const sessionHistoryFilePath = join(
      mkdtempSync(join(tmpdir(), "echoguide-sessions-")),
      "history.json"
    );
    const middleware = createRealtimeClientSecretMiddleware({
      env: {},
      readLocalEnv: () => "",
      sessionHistoryFilePath,
      now: () => new Date("2026-07-08T12:00:00.000Z")
    });

    for (const sessionId of ["session-one", "session-two"]) {
      await middleware(
        {
          method: "POST",
          url: "/api/sessions/current",
          body: JSON.stringify({
            sessionId,
            session: draftSession
          })
        },
        createResponse(),
        vi.fn()
      );
    }

    const deleteResponse = createResponse();

    await middleware(
      { method: "DELETE", url: "/api/sessions/session-one" },
      deleteResponse,
      vi.fn()
    );

    expect(deleteResponse.statusCode).toBe(200);
    expect(JSON.parse(deleteResponse.body).sessions.map((session: { id: string }) => session.id)).toEqual([
      "session-two"
    ]);
    expect(
      JSON.parse(readFileSync(sessionHistoryFilePath, "utf8")).sessions.map(
        (session: { id: string }) => session.id
      )
    ).toEqual(["session-two"]);
  });
});
