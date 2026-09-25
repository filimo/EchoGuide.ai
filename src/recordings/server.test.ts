// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
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
  it.skipIf(spawnSync("ffmpeg", ["-version"]).status !== 0 || spawnSync("ffprobe", ["-version"]).status !== 0)("downloads WAV, WebM and MP4 recordings as mono speech MP3 without changing the originals", async () => {
    const { run, store } = setup();
    const record = store.start("speech-session", "wav");
    const samples = Buffer.alloc(24_000 * 4);
    for (let i = 0; i < 24_000; i++) {
      const value = Math.round(8000 * Math.sin(2 * Math.PI * 440 * i / 24_000));
      samples.writeInt16LE(value, i * 4); samples.writeInt16LE(value, i * 4 + 2);
    }
    store.append(record.sessionId, record.id, 0, samples);
    expect((await run(`speech-session/${record.id}/mp3`)).status).toBe(409);
    store.finish(record.sessionId, record.id);
    const result = await run(`speech-session/${record.id}/mp3`, "GET", "", { "x-echoguide-recording": "" });
    expect(result.status).toBe(200);
    expect(result.headers["Content-Type"]).toBe("audio/mpeg");
    const localStart = new Date(record.startedAt);
    const pad = (value: number) => value.toString().padStart(2, "0");
    expect(result.headers["Content-Disposition"]).toContain(
      `echoguide-${localStart.getFullYear()}-${pad(localStart.getMonth() + 1)}-${pad(localStart.getDate())}` +
      `_${pad(localStart.getHours())}-${pad(localStart.getMinutes())}-${pad(localStart.getSeconds())}-${record.id.slice(0, 8)}.mp3`
    );
    expect(result.bytes.subarray(0, 3).toString()).toBe("ID3");
    expect(result.bytes.length).toBeGreaterThan(6000);
    const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,channels,sample_rate,bit_rate", "-of", "json", "pipe:0"],
      { input: result.bytes });
    expect(probe.status).toBe(0);
    expect(JSON.parse(probe.stdout.toString()).streams[0]).toMatchObject({ codec_name: "mp3", channels: 1, sample_rate: "24000", bit_rate: "64000" });
    expect(store.get(record.sessionId, record.id).format).toBe("wav");
    expect((await run(`speech-session/${record.id}/mp3`, "GET", "", { origin: "https://other.example" })).status).toBe(403);

    for (const format of ["webm", "mp4"] as const) {
      const source = join(store.root, `browser-source.${format}`);
      const converted = spawnSync("ffmpeg", ["-nostdin", "-loglevel", "error", "-i", store.file(record),
        "-c:a", format === "webm" ? "libopus" : "aac", source]);
      expect(converted.status).toBe(0);
      const browser = store.start(`browser-${format}`, format);
      const sourceBytes = readFileSync(source);
      store.append(browser.sessionId, browser.id, 0, sourceBytes);
      store.finish(browser.sessionId, browser.id);
      const download = await run(`${browser.sessionId}/${browser.id}/mp3`);
      expect(download.status).toBe(200);
      expect(download.bytes.subarray(0, 3).toString()).toBe("ID3");
      expect(readFileSync(store.file(browser))).toEqual(sourceBytes);
    }
  });
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
