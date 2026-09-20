// @vitest-environment node
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import WebSocket from "ws";
import { describe, expect, it, vi, afterEach } from "vitest";
import { createMacAudioMiddleware, isLocalMacAudioRequest } from "./server";

class Socket extends EventEmitter {
  readyState = WebSocket.OPEN;
  bufferedAmount = 0;
  send = vi.fn((_data: string) => {});
  terminate = vi.fn(() => this.emit("close"));
  message(event: unknown) { this.emit("message", Buffer.from(JSON.stringify(event))); }
}
class Helper extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn();
  line(event: unknown) { this.stdout.write(`${JSON.stringify(event)}\n`); }
}
function request(path = "session", body: unknown = { pid: 123, microphone: "default", language: "english-russian" }) {
  const req = new PassThrough() as unknown as IncomingMessage;
  Object.assign(req, { url: `/api/mac-audio/${path}`, method: "POST",
    headers: { host: "localhost:5173", origin: "https://localhost:5173", "x-echoguide-mac-audio": "1" },
    socket: { remoteAddress: "127.0.0.1" } });
  (req as unknown as PassThrough).end(JSON.stringify(body));
  return req;
}
function response() {
  const res = new EventEmitter() as EventEmitter & { status: number; body: string; destroyed: boolean; writeHead: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn>; flushHeaders: () => void };
  Object.assign(res, { status: 0, body: "", destroyed: false,
    writeHead: vi.fn((status: number) => { res.status = status; }),
    write: vi.fn((chunk: string) => { res.body += chunk; return true; }),
    end: vi.fn((chunk = "") => { res.body += chunk; }), flushHeaders: () => {} });
  return res;
}
const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach(fn => fn()); vi.restoreAllMocks(); });
function setup() {
  const sockets: Socket[] = [];
  const helper = new Helper();
  const spawnHelper = vi.fn(() => helper as unknown as ChildProcessWithoutNullStreams);
  const diagnostic = vi.fn();
  const bridge = createMacAudioMiddleware({ diagnostic, platform: "darwin", helperExists: () => true, spawnHelper,
    connectSocket: () => { const socket = new Socket(); sockets.push(socket); return socket as unknown as WebSocket; },
    readEnv: () => "OPENAI_API_KEY=test-only" });
  cleanups.push(bridge.dispose);
  const run = async (req = request()) => {
    const res = response();
    await bridge.middleware(req, res as unknown as ServerResponse, vi.fn());
    return res;
  };
  const ready = () => sockets.forEach(socket => { socket.emit("open"); socket.message({ type: "session.updated" }); });
  return { sockets, helper, spawnHelper, bridge, run, ready, diagnostic };
}

describe("Mac audio local bridge", () => {
  it("rejects remote clients, foreign origins, missing headers and rebinding hosts", () => {
    const req = request();
    expect(isLocalMacAudioRequest(req)).toBe(true);
    for (const headers of [
      { ...req.headers, origin: "https://attacker.example" },
      { ...req.headers, "x-echoguide-mac-audio": undefined },
      { ...req.headers, host: "attacker.example", origin: "https://attacker.example" }
    ]) expect(isLocalMacAudioRequest({ ...req, headers, socket: req.socket } as IncomingMessage)).toBe(false);
    expect(isLocalMacAudioRequest({ ...req, socket: { remoteAddress: "192.168.1.3" } } as IncomingMessage)).toBe(false);
    const h2 = request(); delete h2.headers.host; h2.headers[":authority"] = "localhost:5173";
    expect(isLocalMacAudioRequest(h2)).toBe(true);
  });
  it("waits for both configured sessions, routes PCM separately, and stamps transcript sources", async () => {
    const test = setup();
    const res = await test.run();
    expect(res.status).toBe(200);
    test.sockets[0].emit("open");
    test.sockets[0].message({ type: "session.updated" });
    expect(test.spawnHelper).not.toHaveBeenCalled();
    test.sockets[1].emit("open");
    test.sockets[1].message({ type: "session.updated" });
    expect(test.spawnHelper).toHaveBeenCalledWith(["--capture", "123", "default"]);
    test.helper.line({ type: "ready" });
    const pcm = Buffer.alloc(480, 1).toString("base64");
    test.helper.line({ type: "audio", source: "application", audio: pcm });
    await new Promise(resolve => setTimeout(resolve, 120));
    const sentAudio = JSON.parse(test.sockets[1].send.mock.calls.at(-1)![0]);
    expect(sentAudio.type).toBe("input_audio_buffer.append");
    expect(Buffer.from(sentAudio.audio, "base64").subarray(0, 480)).toEqual(Buffer.alloc(480, 1));
    const micAudio = JSON.parse(test.sockets[0].send.mock.calls.at(-1)![0]);
    expect(Buffer.from(micAudio.audio, "base64")).toEqual(Buffer.alloc(4800));
    test.sockets[1].message({ type: "input_audio_buffer.speech_started", item_id: "a", audio_start_ms: 0 });
    const completed = { type: "conversation.item.input_audio_transcription.completed", item_id: "a", transcript: "Synthetic question" };
    test.sockets[1].message(completed); test.sockets[1].message(completed);
    const events = res.body.trim().split("\n").map(line => JSON.parse(line));
    const turns = events.filter(event => event.event?.transcript);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ source: "application", capturedAt: expect.any(Number), event: completed });
    expect(res.body).not.toContain(pcm);
    res.emit("close");
    expect(test.helper.kill).toHaveBeenCalled();
    expect(test.sockets.every(socket => socket.terminate.mock.calls.length === 1)).toBe(true);
  });
  it("rejects a concurrent owner and releases the lock after cancellation", async () => {
    const test = setup();
    const first = await test.run();
    expect((await test.run()).status).toBe(409);
    first.emit("close");
    expect((await test.run()).status).toBe(200);
  });
  it("closes both streams on an upstream error without forwarding its contents", async () => {
    const test = setup(); const res = await test.run(); test.ready();
    test.sockets[0].message({ type: "error", error: { message: "private request content sk-sensitive" } });
    expect(res.body).toContain("microphone transcription failed");
    expect(res.body).not.toContain("private");
    expect(test.sockets[1].terminate).toHaveBeenCalled();
    expect(test.helper.kill).toHaveBeenCalled();
    expect(test.diagnostic).toHaveBeenLastCalledWith(expect.objectContaining({ type: "mac_audio.stopped", reason: "microphone_upstream_error" }));
    expect(JSON.stringify(test.diagnostic.mock.calls)).not.toContain("sk-sensitive");
  });
  it("stops instead of building an unbounded audio queue", async () => {
    const test = setup(); const res = await test.run(); test.ready();
    test.sockets[0].bufferedAmount = 300_000;
    test.helper.line({ type: "audio", source: "microphone", audio: "AAAAAA==" });
    expect(res.body).toContain("fell behind");
    expect(test.helper.kill).toHaveBeenCalled();
  });
  it("keeps running when the audio timer is consistently two milliseconds late", async () => {
    let pump: () => void = () => {};
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    vi.spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void, ms: number) => {
      if (ms === 100) pump = callback;
      return {} as ReturnType<typeof setInterval>;
    }) as typeof setInterval);
    const test = setup(); const res = await test.run(); test.ready();
    test.helper.line({ type: "ready" });
    const pcm = Buffer.alloc(480, 1).toString("base64");
    for (clock = 2; clock <= 180_000; clock += 2) {
      if (clock % 10 === 0) test.helper.line({ type: "audio", source: "microphone", audio: pcm });
      if (clock % 102 === 0) pump();
    }
    expect(test.helper.kill).not.toHaveBeenCalled();
    expect(res.body).not.toContain('"type":"error"');
    const packets = test.sockets[0].send.mock.calls.filter(([message]) => JSON.parse(message).type === "input_audio_buffer.append");
    expect(packets.length).toBeGreaterThanOrEqual(1799);
  });
  it("fails invalid selection before opening sockets", async () => {
    const test = setup();
    expect((await test.run(request("session", { pid: "123" }))).status).toBe(400);
    expect(test.sockets).toHaveLength(0);
  });
});
