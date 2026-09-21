import { createReadStream, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { RecordingError, RecordingStore, recordingStore } from "./store";

const base = "/api/recordings/";
function sameOrigin(req: IncomingMessage, media: boolean) {
  const authority = req.headers[":authority"] ?? req.headers.host;
  try {
    if (req.headers.origin) return new URL(req.headers.origin).host === authority;
    // Audio elements cannot set a custom header; browsers supply Fetch Metadata.
    if (req.headers["sec-fetch-site"] === "same-origin") return true;
    return typeof req.headers.referer === "string" && new URL(req.headers.referer).host === authority &&
      (media || req.headers["x-echoguide-recording"] === "1");
  } catch { return false; }
}
function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}
async function readBytes(req: IncomingMessage, limit: number) {
  const chunks: Buffer[] = []; let size = 0;
  for await (const value of req) {
    const chunk = Buffer.from(value); size += chunk.length;
    if (size > limit) throw new RecordingError("Recording chunk is too large.", 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function createRecordingMiddleware(store: RecordingStore = recordingStore) {
  return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (!req.url?.startsWith(base)) return next();
    try {
      const url = new URL(req.url, "http://localhost");
      const parts = url.pathname.slice(base.length).split("/").map(decodeURIComponent);
      const [sessionId, id, action] = parts;
      const media = req.method === "GET" && action === "audio";
      if (!sameOrigin(req, media) || (!media && req.headers["x-echoguide-recording"] !== "1")) {
        throw new RecordingError("Recording access requires the same-origin app.", 403);
      }
      if (parts.length > 3 || !sessionId) throw new RecordingError("Unknown recording route.", 404);
      if (req.method === "GET" && !id) return json(res, 200, store.list(sessionId));
      if (req.method === "POST" && !id) {
        const { format } = JSON.parse((await readBytes(req, 1024)).toString());
        if (format !== "webm" && format !== "mp4") throw new RecordingError("Unsupported browser recording format.");
        return json(res, 201, store.start(sessionId, format));
      }
      if (req.method === "POST" && action === "chunk") {
        const sequence = Number(url.searchParams.get("sequence"));
        if (!Number.isSafeInteger(sequence) || sequence < 0) throw new RecordingError("Invalid chunk sequence.");
        const bytes = await readBytes(req, 8 * 1024 * 1024);
        return json(res, 200, store.append(sessionId, id, sequence, bytes));
      }
      if (req.method === "POST" && action === "finish") {
        const { interrupted } = JSON.parse((await readBytes(req, 1024)).toString() || "{}");
        return json(res, 200, store.finish(sessionId, id, interrupted ? "interrupted" : "saved"));
      }
      if (media) {
        const record = store.get(sessionId, id);
        const file = store.file(record);
        const size = statSync(file).size;
        let start = 0; let end = size - 1;
        const range = req.headers.range;
        if (range) {
          const match = /^bytes=(\d+)-(\d*)$/.exec(range);
          if (!match) { res.writeHead(416, { "Content-Range": `bytes */${size}` }); res.end(); return; }
          start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), end) : end;
          if (start > end || start < 0) { res.writeHead(416, { "Content-Range": `bytes */${size}` }); res.end(); return; }
        }
        res.writeHead(range ? 206 : 200, { "Content-Type": `audio/${record.format}`,
          "Content-Length": Math.max(0, end - start + 1), "Cache-Control": "no-store",
          "Accept-Ranges": "bytes", "X-Content-Type-Options": "nosniff",
          ...(range ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}) });
        if (!size) { res.end(); return; }
        const stream = createReadStream(file, { start, end });
        stream.on("error", () => res.destroy());
        res.on("close", () => stream.destroy()); stream.pipe(res); return;
      }
      throw new RecordingError("Unknown recording route.", 404);
    } catch (error) {
      if (!res.headersSent) json(res, error instanceof RecordingError ? error.status : 500,
        { error: error instanceof RecordingError ? error.message : "Recording storage is unavailable." });
      else res.end();
    }
  };
}

export function createRecordingPlugin(): Plugin {
  return { name: "echoguide-local-recordings", configureServer(server) {
    server.middlewares.use(createRecordingMiddleware());
    const timer = setInterval(() => { try { recordingStore.expireBrowserRecordings(); } catch { /* Disk failure is shown on the next request. */ } }, 10_000);
    timer.unref(); server.httpServer?.once("close", () => clearInterval(timer));
  } };
}
