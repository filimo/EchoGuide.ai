import { dirname } from "node:path";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Plugin } from "vite";
import {
  deleteSessionHistoryStateEntry,
  isSessionHistoryEntryDraft,
  normalizeSessionHistoryState,
  upsertSessionHistoryEntry
} from "../domain/sessionHistory";
import {
  analyzeBilingualPhrase,
  normalizeKnowledgeContext,
  normalizeRecentContext,
  type BilingualPhraseAnalysis
} from "./bilingualAnalysis";
import {
  createRealtimeClientSecret,
  parseRealtimeLabMode,
  readOpenAiApiKey,
  type RealtimeLabMode,
  type RealtimeClientSecret
} from "./realtimeSession";
import { sanitizeRealtimeDiagnosticReport } from "./realtimeDiagnostics";

const realtimeClientSecretPath = "/api/realtime/client-secret";
const realtimeAnalyzePhrasePath = "/api/realtime/analyze-phrase";
const localKnowledgePath = "/api/knowledge/local";
const sessionsPath = "/api/sessions";
const currentSessionPath = "/api/sessions/current";
const realtimeDiagnosticsPath = "/api/diagnostics/realtime";
const defaultSessionHistoryFilePath = ".echoguide/sessions/history.json";
const defaultLocalKnowledgeFilePath = ".echoguide/knowledge.local.md";
const defaultRealtimeDiagnosticsDirectoryPath = ".echoguide/diagnostics";
const maxRealtimeDiagnosticBytes = 64 * 1024;

type BasicRequest = {
  method?: string;
  url?: string;
  body?: unknown;
};

type BasicResponse = {
  statusCode: number;
  setHeader: (name: string, value: string) => void;
  end: (body?: string) => void;
};

type MiddlewareNext = () => void;

type CreateClientSecret = (options: {
  apiKey: string;
  mode: RealtimeLabMode;
}) => Promise<RealtimeClientSecret>;

type AnalyzePhrase = (options: {
  apiKey: string;
  transcript: string;
  knowledgeContext?: string;
  recentContext?: string[];
}) => Promise<BilingualPhraseAnalysis>;

type RealtimeClientSecretMiddlewareOptions = {
  env?: NodeJS.ProcessEnv;
  readLocalEnv?: () => string;
  createClientSecret?: CreateClientSecret;
  analyzePhrase?: AnalyzePhrase;
  sessionHistoryFilePath?: string;
  localKnowledgeFilePath?: string;
  realtimeDiagnosticsDirectoryPath?: string;
  now?: () => Date;
};

function readDefaultLocalEnv(): string {
  if (!existsSync(".env.local")) {
    return "";
  }

  return readFileSync(".env.local", "utf8");
}

function sendJson(res: BasicResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

function appendRealtimeDiagnostic(
  directoryPath: string,
  now: (() => Date) | undefined,
  record: Record<string, unknown>
): string {
  const storedAt = (now?.() ?? new Date()).toISOString();
  const diagnosticsFilePath = `${directoryPath}/realtime-${storedAt.slice(0, 10)}.jsonl`;

  mkdirSync(dirname(diagnosticsFilePath), { recursive: true });
  appendFileSync(diagnosticsFilePath, `${JSON.stringify({ storedAt, ...record })}\n`, "utf8");
  return storedAt;
}

function matchesRealtimeClientSecretRoute(req: BasicRequest): boolean {
  if (req.method !== "GET" || req.url == null) {
    return false;
  }

  return new URL(req.url, "http://localhost").pathname === realtimeClientSecretPath;
}

function matchesRealtimeAnalyzePhraseRoute(req: BasicRequest): boolean {
  if (req.method !== "POST" || req.url == null) {
    return false;
  }

  return new URL(req.url, "http://localhost").pathname === realtimeAnalyzePhrasePath;
}

function matchesLoadLocalKnowledgeRoute(req: BasicRequest): boolean {
  if (req.method !== "GET" || req.url == null) {
    return false;
  }

  return new URL(req.url, "http://localhost").pathname === localKnowledgePath;
}

function matchesSaveLocalKnowledgeRoute(req: BasicRequest): boolean {
  if (req.method !== "PUT" || req.url == null) {
    return false;
  }

  return new URL(req.url, "http://localhost").pathname === localKnowledgePath;
}

function matchesLoadSessionsRoute(req: BasicRequest): boolean {
  if (req.method !== "GET" || req.url == null) {
    return false;
  }

  return new URL(req.url, "http://localhost").pathname === sessionsPath;
}

function matchesSaveCurrentSessionRoute(req: BasicRequest): boolean {
  if (req.method !== "POST" || req.url == null) {
    return false;
  }

  return new URL(req.url, "http://localhost").pathname === currentSessionPath;
}

function matchesSaveRealtimeDiagnosticsRoute(req: BasicRequest): boolean {
  if (req.method !== "POST" || req.url == null) {
    return false;
  }

  return new URL(req.url, "http://localhost").pathname === realtimeDiagnosticsPath;
}

function readDeleteSessionId(req: BasicRequest): string | null {
  if (req.method !== "DELETE" || req.url == null) {
    return null;
  }

  const pathname = new URL(req.url, "http://localhost").pathname;
  const sessionPathPrefix = `${sessionsPath}/`;

  if (!pathname.startsWith(sessionPathPrefix)) {
    return null;
  }

  const sessionId = decodeURIComponent(pathname.slice(sessionPathPrefix.length)).trim();

  return sessionId.length > 0 ? sessionId : null;
}

function readRealtimeLabMode(req: BasicRequest): RealtimeLabMode {
  return parseRealtimeLabMode(new URL(req.url ?? "", "http://localhost").searchParams.get("mode"));
}

async function readJsonBody(req: BasicRequest): Promise<unknown> {
  if (typeof req.body === "string") {
    return JSON.parse(req.body) as unknown;
  }

  if (req.body != null) {
    return req.body;
  }

  const maybeStream = req as BasicRequest & AsyncIterable<Buffer | string>;

  if (typeof maybeStream[Symbol.asyncIterator] !== "function") {
    return null;
  }

  const chunks: Buffer[] = [];

  for await (const chunk of maybeStream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
  }

  const text = Buffer.concat(chunks).toString("utf8");

  return text.trim().length === 0 ? null : (JSON.parse(text) as unknown);
}

export function createRealtimeClientSecretMiddleware({
  env = process.env,
  readLocalEnv = readDefaultLocalEnv,
  createClientSecret = createRealtimeClientSecret,
  analyzePhrase = analyzeBilingualPhrase,
  sessionHistoryFilePath = defaultSessionHistoryFilePath,
  localKnowledgeFilePath = defaultLocalKnowledgeFilePath,
  realtimeDiagnosticsDirectoryPath = defaultRealtimeDiagnosticsDirectoryPath,
  now
}: RealtimeClientSecretMiddlewareOptions = {}) {
  return async (req: BasicRequest, res: BasicResponse, next: MiddlewareNext): Promise<void> => {
    const handlesClientSecret = matchesRealtimeClientSecretRoute(req);
    const handlesAnalyzePhrase = matchesRealtimeAnalyzePhraseRoute(req);
    const handlesLoadLocalKnowledge = matchesLoadLocalKnowledgeRoute(req);
    const handlesSaveLocalKnowledge = matchesSaveLocalKnowledgeRoute(req);
    const handlesLoadSessions = matchesLoadSessionsRoute(req);
    const handlesSaveCurrentSession = matchesSaveCurrentSessionRoute(req);
    const handlesSaveRealtimeDiagnostics = matchesSaveRealtimeDiagnosticsRoute(req);
    const deleteSessionId = readDeleteSessionId(req);

    if (handlesSaveRealtimeDiagnostics) {
      let requestBody: unknown;

      try {
        requestBody = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: "Diagnostic request body must be valid JSON." });
        return;
      }

      const serializedReport = JSON.stringify(requestBody);

      const diagnosticReport = sanitizeRealtimeDiagnosticReport(requestBody);

      if (serializedReport.length > maxRealtimeDiagnosticBytes || diagnosticReport == null) {
        sendJson(res, 400, { error: "Realtime diagnostic report is invalid." });
        return;
      }

      const storedAt = appendRealtimeDiagnostic(realtimeDiagnosticsDirectoryPath, now, {
        source: "frontend",
        ...diagnosticReport
      });
      sendJson(res, 202, { reportId: diagnosticReport.reportId, storedAt });
      return;
    }

    if (handlesLoadLocalKnowledge) {
      sendJson(res, 200, {
        knowledgeContext: existsSync(localKnowledgeFilePath)
          ? normalizeKnowledgeContext(readFileSync(localKnowledgeFilePath, "utf8"))
          : ""
      });
      return;
    }

    if (handlesSaveLocalKnowledge) {
      let requestBody: unknown;

      try {
        requestBody = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: "Knowledge request body must be valid JSON." });
        return;
      }

      const rawKnowledgeContext = (requestBody as { knowledgeContext?: unknown } | null)
        ?.knowledgeContext;

      if (typeof rawKnowledgeContext !== "string") {
        sendJson(res, 400, { error: "Knowledge context must be a string." });
        return;
      }

      const knowledgeContext = normalizeKnowledgeContext(rawKnowledgeContext);
      mkdirSync(dirname(localKnowledgeFilePath), { recursive: true });
      writeFileSync(
        localKnowledgeFilePath,
        knowledgeContext.length > 0 ? `${knowledgeContext}\n` : "",
        "utf8"
      );
      sendJson(res, 200, { knowledgeContext });
      return;
    }

    if (handlesLoadSessions) {
      sendJson(res, 200, readSessionHistoryFromDisk(sessionHistoryFilePath));
      return;
    }

    if (deleteSessionId != null) {
      const nextHistory = deleteSessionHistoryStateEntry(
        readSessionHistoryFromDisk(sessionHistoryFilePath),
        deleteSessionId
      );

      writeSessionHistoryToDisk(sessionHistoryFilePath, nextHistory);
      sendJson(res, 200, nextHistory);
      return;
    }

    if (handlesSaveCurrentSession) {
      let requestBody: unknown;

      try {
        requestBody = await readJsonBody(req);
      } catch {
        sendJson(res, 400, {
          error: "Session request body must be valid JSON."
        });
        return;
      }

      const sessionId =
        typeof (requestBody as { sessionId?: unknown } | null)?.sessionId === "string"
          ? (requestBody as { sessionId: string }).sessionId.trim()
          : "";
      const sessionDraft = (requestBody as { session?: unknown } | null)?.session;

      if (sessionId.length === 0 || !isSessionHistoryEntryDraft(sessionDraft)) {
        sendJson(res, 400, {
          error: "Current session id and session draft are required."
        });
        return;
      }

      const currentHistory = readSessionHistoryFromDisk(sessionHistoryFilePath);
      const { history, entry } = upsertSessionHistoryEntry(currentHistory, sessionDraft, {
        sessionId,
        now
      });
      writeSessionHistoryToDisk(sessionHistoryFilePath, history);
      sendJson(res, 200, entry);
      return;
    }

    if (!handlesClientSecret && !handlesAnalyzePhrase) {
      next();
      return;
    }

    const apiKey = readOpenAiApiKey(env, readLocalEnv());

    if (apiKey == null) {
      appendRealtimeDiagnostic(realtimeDiagnosticsDirectoryPath, now, {
        source: "backend",
        type: "openai_api_key.missing",
        route: handlesAnalyzePhrase ? realtimeAnalyzePhrasePath : realtimeClientSecretPath
      });
      sendJson(res, 500, {
        error: "OPENAI_API_KEY is not configured for the Realtime Lab."
      });
      return;
    }

    if (handlesAnalyzePhrase) {
      let requestBody: unknown;

      try {
        requestBody = await readJsonBody(req);
      } catch {
        sendJson(res, 400, {
          error: "Phrase request body must be valid JSON."
        });
        return;
      }

      const transcript =
        typeof (requestBody as { transcript?: unknown } | null)?.transcript === "string"
          ? (requestBody as { transcript: string }).transcript.trim()
          : "";
      const knowledgeContext = normalizeKnowledgeContext(
        typeof (requestBody as { knowledgeContext?: unknown } | null)?.knowledgeContext ===
          "string"
          ? (requestBody as { knowledgeContext: string }).knowledgeContext
          : ""
      );
      const recentContext = normalizeRecentContext(
        Array.isArray((requestBody as { recentContext?: unknown } | null)?.recentContext)
          ? (requestBody as { recentContext: string[] }).recentContext.filter(
              (turn): turn is string => typeof turn === "string"
            )
          : []
      );

      if (transcript.length === 0) {
        sendJson(res, 400, {
          error: "Phrase transcript is required."
        });
        return;
      }

      appendRealtimeDiagnostic(realtimeDiagnosticsDirectoryPath, now, {
        source: "backend",
        type: "phrase_analysis.started",
        transcriptCharacters: transcript.length,
        knowledgeCharacters: knowledgeContext.length,
        recentTurnCount: recentContext.length
      });

      try {
        const analysis = await analyzePhrase({ apiKey, transcript, knowledgeContext, recentContext });
        appendRealtimeDiagnostic(realtimeDiagnosticsDirectoryPath, now, {
          source: "backend",
          type: "phrase_analysis.completed",
          transcriptCharacters: transcript.length,
          suggestedReplyCount: analysis.suggestedReplies.length
        });
        sendJson(res, 200, analysis);
      } catch (error) {
        appendRealtimeDiagnostic(realtimeDiagnosticsDirectoryPath, now, {
          source: "backend",
          type: "phrase_analysis.failed",
          errorName: error instanceof Error ? error.name : "UnknownError"
        });
        sendJson(res, 502, {
          error: "Could not analyze the phrase with OpenAI.",
          details:
            error instanceof Error ? error.message.replace(/sk-[A-Za-z0-9_-]+/g, "sk-redacted") : null
        });
      }

      return;
    }

    const mode = readRealtimeLabMode(req);

    appendRealtimeDiagnostic(realtimeDiagnosticsDirectoryPath, now, {
      source: "backend",
      type: "client_secret.started",
      mode
    });

    try {
      const clientSecret = await createClientSecret({ apiKey, mode });
      appendRealtimeDiagnostic(realtimeDiagnosticsDirectoryPath, now, {
        source: "backend",
        type: "client_secret.completed",
        mode,
        expiresAt: clientSecret.expiresAt,
        sessionId: clientSecret.sessionId ?? null
      });
      sendJson(res, 200, clientSecret);
    } catch (error) {
      appendRealtimeDiagnostic(realtimeDiagnosticsDirectoryPath, now, {
        source: "backend",
        type: "client_secret.failed",
        mode,
        errorName: error instanceof Error ? error.name : "UnknownError"
      });
      sendJson(res, 502, {
        error: "Could not create an OpenAI Realtime client secret.",
        details: error instanceof Error ? error.message.replace(/sk-[A-Za-z0-9_-]+/g, "sk-redacted") : null
      });
    }
  };
}

function readSessionHistoryFromDisk(sessionHistoryFilePath: string) {
  if (!existsSync(sessionHistoryFilePath)) {
    return {
      version: 1 as const,
      sessions: []
    };
  }

  try {
    return normalizeSessionHistoryState(JSON.parse(readFileSync(sessionHistoryFilePath, "utf8")) as unknown);
  } catch {
    return {
      version: 1 as const,
      sessions: []
    };
  }
}

function writeSessionHistoryToDisk(
  sessionHistoryFilePath: string,
  history: ReturnType<typeof readSessionHistoryFromDisk>
): void {
  mkdirSync(dirname(sessionHistoryFilePath), { recursive: true });
  writeFileSync(sessionHistoryFilePath, `${JSON.stringify(history, null, 2)}\n`, "utf8");
}

export function createRealtimeDevServerPlugin(): Plugin {
  return {
    name: "echoguide-realtime-dev-server",
    configureServer(server) {
      server.middlewares.use(createRealtimeClientSecretMiddleware());
    }
  };
}
