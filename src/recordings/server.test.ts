// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough, Writable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRecordingMiddleware } from "./server";
import { RecordingStore } from "./store";

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));
function setup() {
  const root = mkdtempSync(join(tmpdir(), "echoguide-audio-api-")); directories.push(root);
  const store = new RecordingStore(root); const middleware = createRecordingMiddleware(store);
  async function run(path: string, method = "GET", body = "", headers: Record<string, string> = {}) {
    const req = new PassThrough() as unknown as IncomingMessage;
    Object.assign(req, { url: `/api/recordings/${path}`, method,
      headers: { host: "localhost:5173", "sec-fetch-site": "same-origin", "x-echoguide-recording": "1", ...headers } });
    (req as unknown as PassThrough).end(body);
    let bytes = Buffer.alloc(0); let status = 0; let responseHeaders: Record<string, string> = {};
    const output = new Writable({ write(chunk, _encoding, callback) { bytes = Buffer.concat([bytes, Buffer.from(chunk)]); callback(); } });
    const finished = new Promise<void>(resolve => output.on("finish", resolve));
    Object.assign(output, { writeHead(code: number, value: Record<string, string>) { status = code; responseHeaders = value; } });
    await middleware(req, output as unknown as ServerResponse, vi.fn());
    await finished;
    return { status, bytes, headers: responseHeaders, json: () => JSON.parse(bytes.toString()) };
  }
  return { store, run };
}

describe("recording HTTP API", () => {
  it("persists ordered upload chunks, reopens recordings and serves seekable byte ranges", async () => {
    const { run } = setup();
    const start = await run("session", "POST", JSON.stringify({ format: "webm" }));
    expect(start.status).toBe(201); const id = start.json().id;
    expect((await run(`session/${id}/chunk?sequence=0`, "POST", "abcdef")).status).toBe(200);
    expect((await run(`session/${id}/chunk?sequence=2`, "POST", "lost")).status).toBe(409);
    expect((await run(`session/${id}/finish`, "POST", "{}")).json().status).toBe("saved");
    expect((await run("session")).json()).toHaveLength(1);
    const playback = await run(`session/${id}/audio`, "GET", "", { range: "bytes=1-3", "x-echoguide-recording": "" });
    expect(playback.status).toBe(206); expect(playback.bytes.toString()).toBe("bcd");
    expect(playback.headers["Content-Range"]).toBe("bytes 1-3/6");
    expect((await run(`session/${id}/audio`, "GET", "", { range: "bytes=99-" })).status).toBe(416);
  });
  it("rejects cross-origin access, missing app headers, invalid paths and oversized chunks", async () => {
    const { run } = setup();
    expect((await run("session", "GET", "", { origin: "https://other.example" })).status).toBe(403);
    expect((await run("session", "GET", "", { "x-echoguide-recording": "" })).status).toBe(403);
    expect((await run("session/%2e%2e%2ffile/audio")).status).toBe(400);
    const record = (await run("session", "POST", '{"format":"mp4"}')).json();
    expect((await run(`session/${record.id}/chunk?sequence=0`, "POST", "a".repeat(8 * 1024 * 1024 + 1))).status).toBe(413);
  });
});
