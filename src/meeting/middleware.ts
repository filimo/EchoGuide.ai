import { maxMeetingContextCharacters, maxMeetingContextTurns } from "./conversationContext";
import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { MeetingHistoryStore } from "./historyStore";
import { MeetingService } from "./service";
import { readEnvironmentValue, readOpenAiApiKey } from "../realtime/realtimeSession";
import { isQuickStart } from "../realtime/quickStart";

export function createMeetingMiddleware(service?: MeetingService, history = new MeetingHistoryStore()) {
  const local = () => existsSync(".env.local") ? readFileSync(".env.local", "utf8") : "";
  const getService = () => service ??= new MeetingService({ apiKey: () => readOpenAiApiKey(process.env, local()) ?? "",
    model: () => readEnvironmentValue(process.env, "OPENAI_BILINGUAL_MODEL", local()) ?? "",
    reasoningEffort: () => readEnvironmentValue(process.env, "OPENAI_BILINGUAL_REASONING_EFFORT", local()) ?? "" });
  return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (!path.startsWith("/api/meeting/")) return next();
    const send = (status: number, body: unknown) => { res.statusCode = status; res.setHeader("Content-Type", "application/json"); res.setHeader("Cache-Control", "no-store"); res.end(JSON.stringify(body)); };
    try {
      // HTTPS browsers use HTTP/2 :authority instead of the HTTP/1.1 Host header.
      const authority = req.headers[":authority"] ?? req.headers.host;
      if (req.headers.origin) {
        let allowed = false;
        try {
          const origin = new URL(req.headers.origin);
          allowed = ["http:", "https:"].includes(origin.protocol) && typeof authority === "string" && origin.host === authority;
        } catch { /* Invalid origins must not reach application handlers. */ }
        if (!allowed) return send(403, { error: "Запрос разрешён только из приложения." });
      }
      const api = getService();
      if (req.method === "GET" && path === "/api/meeting/packs") return send(200, await api.refresh());
      if (req.method !== "POST") return send(405, { error: "Метод не поддерживается." });
      let bytes = 0; const chunks: Buffer[] = [];
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 3 * 1024 * 1024) return send(413, { error: "Слишком большой запрос." });
        chunks.push(Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!body || typeof body !== "object") return send(400, { error: "Некорректный запрос." });
      if (path === "/api/meeting/history/read") {
        if (typeof body.sessionId !== "string" || !body.sessionId || body.sessionId.length > 200) return send(400, { error: "Некорректная сессия." });
        return send(200, { snapshots: history.read(body.sessionId) });
      }
      if (path === "/api/meeting/history/save") { history.save(body.record); return send(200, { saved: true }); }
      if (path === "/api/meeting/packs") return send(202, api.create(body.name, body.files));
      if (path === "/api/meeting/active" && (body.packId === null || typeof body.packId === "string")) return send(200, api.activate(body.packId));
      if (path === "/api/meeting/summarize") {
        if (typeof body.previousSummary !== "string" || body.previousSummary.length > 2400 ||
          !Array.isArray(body.turns) || body.turns.length > 30 ||
          body.turns.some((s: unknown) => typeof s !== "string" || s.length > 1800) ||
          body.turns.join("\n").length > 16000) return send(400, { error: "Некорректный контекст." });
        return send(200, { summary: await api.summarize(body.previousSummary, body.turns) });
      }
      if (path === "/api/meeting/general" || path === "/api/meeting/opening") {
        if (typeof body.transcript !== "string" || !body.transcript.trim() || body.transcript.length > 4000 ||
          !Array.isArray(body.recentContext) || body.recentContext.length > maxMeetingContextTurns ||
          body.recentContext.some((s: unknown) => typeof s !== "string" || s.length > 2000) ||
          body.recentContext.join("\n").length > maxMeetingContextCharacters ||
          typeof body.speakerLabel !== "string" || body.speakerLabel.length > 100 ||
          (body.answerHint !== undefined && (typeof body.answerHint !== "string" || body.answerHint.length > 1200))) return send(400, { error: "Некорректный вопрос." });
        return send(200, await (path.endsWith("/opening") ? api.opening(body.transcript, body.recentContext, body.speakerLabel, body.answerHint) : api.general(body.transcript, body.recentContext, body.speakerLabel, body.answerHint)));
      }
      if (typeof body.packId !== "string") return send(400, { error: "Выберите набор." });
      if (path === "/api/meeting/delete") return send(200, await api.remove(body.packId));
      if (path === "/api/meeting/search") {
        if (typeof body.transcript !== "string" || !body.transcript.trim() || body.transcript.length > 4000 ||
          !Array.isArray(body.recentContext) || body.recentContext.length > maxMeetingContextTurns ||
          body.recentContext.some((s: unknown) => typeof s !== "string" || s.length > 2000) ||
          body.recentContext.join("\n").length > maxMeetingContextCharacters ||
          (body.summary !== undefined && (typeof body.summary !== "string" || body.summary.length > 2400))) return send(400, { error: "Некорректный вопрос." });
        return send(200, await api.search(body.packId, body.transcript, body.recentContext,
          ...(body.summary ? [body.summary] : [])));
      }
      if (path === "/api/meeting/answer" && typeof body.ticket === "string") {
        if (body.opening !== undefined && !isQuickStart(body.opening)) return send(400, { error: "Некорректное начало." });
        return send(200, await api.answer(body.packId, body.ticket, body.opening));
      }
      return send(404, { error: "Неизвестный запрос." });
    } catch {
      // Never expose upstream errors: they may echo private file names, content or credentials.
      return send(502, { error: "Не удалось выполнить запрос. Проверьте выбранный набор и повторите попытку." });
    }
  };
}
