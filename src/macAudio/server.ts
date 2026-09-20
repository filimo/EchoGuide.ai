import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import WebSocket from "ws";
import type { Plugin } from "vite";
import {
  buildRealtimeTranscriptionSessionUpdate, defaultRealtimeTranscriptionModel,
  defaultRealtimeTurnDetectionSettings, readEnvironmentValue, readOpenAiApiKey
} from "../realtime/realtimeSession";
import { isMacAudioSource, type MacAudioEvent, type MacAudioSource } from "./protocol";

const prefix = "/api/mac-audio/";
const helperPath = ".echoguide/native/EchoGuide Audio.app/Contents/MacOS/EchoGuideAudio";
const sources: MacAudioSource[] = ["microphone", "application"];

export function isLocalMacAudioRequest(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress;
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address ?? "")) return false;
  if (req.headers["x-echoguide-mac-audio"] !== "1") return false;
  try {
    const authority = req.headers[":authority"] ?? req.headers.host;
    const host = new URL(`https://${authority}`).hostname;
    if (!["localhost", "127.0.0.1", "[::1]"].includes(host)) return false;
    const origin = req.headers.origin;
    return typeof origin === "string" && new URL(origin).host === authority &&
      ["https:", "http:"].includes(new URL(origin).protocol);
  } catch { return false; }
}

function json(res: ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(payload));
}

async function readOptions(req: IncomingMessage) {
  let text = "";
  for await (const chunk of req) {
    text += String(chunk);
    if (text.length > 4096) throw new Error("Request is too large.");
  }
  const value = JSON.parse(text || "{}");
  if (value == null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid request.");
  return value as Record<string, unknown>;
}

// Never forward an upstream raw error payload: it can contain request content.
function publicRealtimeEvent(event: Record<string, unknown>) {
  if (event.type === "conversation.item.input_audio_transcription.completed") {
    return { type: event.type, item_id: event.item_id, transcript: event.transcript };
  }
  if (event.type === "input_audio_buffer.speech_started" || event.type === "input_audio_buffer.speech_stopped") {
    return { type: event.type, item_id: event.item_id };
  }
  return null;
}

export type MacAudioServerDependencies = {
  platform?: string;
  helperExists?: () => boolean;
  spawnHelper?: (args: string[]) => ChildProcessWithoutNullStreams;
  connectSocket?: (key: string) => WebSocket;
  readEnv?: () => string;
};

export function createMacAudioMiddleware(deps: MacAudioServerDependencies = {}) {
  const children = new Set<ChildProcessWithoutNullStreams>();
  let active = false;
  let stopActive: (() => void) | undefined;
  const spawnHelper = deps.spawnHelper ?? ((args) => spawn(resolve(helperPath), args, {
    // The native helper needs no API credentials and opens no network port.
    env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME, TMPDIR: process.env.TMPDIR },
    stdio: ["pipe", "pipe", "pipe"]
  }));
  const connectSocket = deps.connectSocket ?? ((key) => new WebSocket(
    "wss://api.openai.com/v1/realtime?intent=transcription",
    { headers: { Authorization: `Bearer ${key}` }, handshakeTimeout: 20_000, maxPayload: 1024 * 1024 }
  ));

  function child(args: string[]) {
    const process = spawnHelper(args);
    children.add(process);
    process.once("close", () => children.delete(process));
    // Drain macOS stderr without persisting potentially sensitive native messages.
    process.stderr.resume();
    return process;
  }

  async function middleware(req: IncomingMessage, res: ServerResponse, next: () => void) {
    const path = req.url?.split("?")[0];
    if (!path?.startsWith(prefix)) return next();
    if (!isLocalMacAudioRequest(req)) return json(res, 403, { error: "Mac audio is available only from this Mac at localhost." });
    if (req.method !== "POST") return json(res, 405, { error: "Use POST." });
    if ((deps.platform ?? process.platform) !== "darwin") return json(res, 400, { error: "Mac audio requires macOS 15+." });
    if (!(deps.helperExists?.() ?? existsSync(resolve(helperPath)))) {
      return json(res, 503, { error: "Build Mac audio first: npm run mac-audio:build" });
    }
    if (path !== `${prefix}sources` && path !== `${prefix}session`) return json(res, 404, { error: "Unknown Mac audio route." });
    if (active) return json(res, 409, { error: "Mac audio is already running. Stop the other session first." });
    let options: Record<string, unknown>;
    try { options = await readOptions(req); } catch { return json(res, 400, { error: "Invalid Mac audio options." }); }
    if (res.destroyed) return;
    if (active) return json(res, 409, { error: "Mac audio is already running." });

    if (path === `${prefix}sources`) {
      const helper = child(["--list"]);
      let text = "";
      let finished = false;
      const finish = (status: number, value: unknown) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        helper.kill();
        if (!res.destroyed) json(res, status, value);
      };
      const timeout = setTimeout(() => finish(504, { error: "Source selection timed out. Check macOS capture permissions and refresh sources." }), 90_000);
      res.on("close", () => { clearTimeout(timeout); helper.kill(); });
      helper.on("error", () => finish(500, { error: "Could not launch EchoGuide Audio. Rebuild the helper." }));
      helper.stdout.on("data", (chunk) => {
        text += chunk.toString();
        if (text.length > 512_000) return finish(500, { error: "Source list is too large." });
      });
      helper.on("close", () => {
        try {
          const result = JSON.parse(text.trim());
          if (result.type === "sources") finish(200, result);
          else finish(403, { error: result.message || "Check macOS capture permissions." });
        } catch { finish(500, { error: "Could not read Mac audio sources. Check permissions and refresh." }); }
      });
      return;
    }

    if (!Number.isInteger(options.pid) || Number(options.pid) <= 0 ||
        typeof options.microphone !== "string" || options.microphone.length > 512 ||
        !["english", "russian", "english-russian"].includes(String(options.language))) {
      return json(res, 400, { error: "Select an application, microphone and speech language." });
    }
    const localEnv = deps.readEnv?.() ?? (existsSync(".env.local") ? readFileSync(".env.local", "utf8") : "");
    const key = readOpenAiApiKey(process.env, localEnv);
    if (!key) return json(res, 503, { error: "The local server has no OpenAI API key." });
    active = true;
    res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
    res.flushHeaders();
    const sockets = new Map<MacAudioSource, WebSocket>();
    const ready = new Set<MacAudioSource>();
    const frames = new Map<MacAudioSource, { chunks: number; lastLevel: number }>();
    const audioQueues = new Map<MacAudioSource, Buffer>(sources.map(source => [source, Buffer.alloc(0)]));
    let captureEpoch = 0;
    let audioPump: ReturnType<typeof setInterval> | undefined;
    const turns = new Map<string, number>();
    const completed = new Set<string>();
    let helper: ChildProcessWithoutNullStreams | undefined;
    let stopped = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearTimeout(timeout);
      clearInterval(heartbeat);
      clearInterval(audioPump);
      audioQueues.clear();
      helper?.kill();
      for (const socket of sockets.values()) socket.terminate();
      active = false;
      stopActive = undefined;
      res.end();
    };
    stopActive = stop;
    const send = (event: MacAudioEvent | { type: "heartbeat" }) => {
      if (stopped || res.destroyed) return;
      if (!res.write(`${JSON.stringify(event)}\n`)) stop();
    };
    const fail = (message: string) => { send({ type: "error", message }); stop(); };
    res.on("close", stop);
    timeout = setTimeout(() => fail("Mac audio startup timed out. Check capture permissions and try again."), 90_000);
    heartbeat = setInterval(() => send({ type: "heartbeat" }), 5000);

    function startCapture() {
      if (stopped || helper || ready.size !== 2) return;
      helper = child(["--capture", String(options.pid), String(options.microphone)]);
      let buffer = "";
      helper.on("error", () => fail("Could not launch EchoGuide Audio. Rebuild the helper."));
      helper.on("close", () => { if (!stopped) fail("Mac audio capture stopped. Check permissions and restart live mode."); });
      helper.stdout.on("data", (chunk) => {
        if (stopped) return;
        buffer += chunk.toString();
        if (buffer.length > 1024 * 1024) return fail("Mac audio capture exceeded its buffer limit.");
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0 && !stopped) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          try {
            const event = JSON.parse(line);
            if (event.type === "error") { fail(String(event.message).slice(0, 300)); break; }
            if (event.type === "ready") {
              if (audioPump) continue;
              clearTimeout(timeout);
              captureEpoch = Date.now();
              // Clock both streams together, including silence when an app emits no buffers.
              // This lets VAD finish a turn even when playback stops abruptly.
              audioPump = setInterval(() => {
                for (const source of sources) {
                  if (stopped) return;
                  const socket = sockets.get(source)!;
                  if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > 256_000) {
                    fail("Audio delivery fell behind. Stop and restart live mode."); return;
                  }
                  const queue = audioQueues.get(source)!;
                  const pcm = Buffer.alloc(4800);
                  queue.copy(pcm, 0, 0, Math.min(queue.length, pcm.length));
                  audioQueues.set(source, queue.subarray(Math.min(queue.length, pcm.length)));
                  socket.send(JSON.stringify({ type: "input_audio_buffer.append", audio: pcm.toString("base64") }));
                }
              }, 100);
              send({ type: "ready" }); continue;
            }
            if (event.type !== "audio" || !isMacAudioSource(event.source) || typeof event.audio !== "string") continue;
            const socket = sockets.get(event.source)!;
            if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > 256_000) {
              fail("Audio delivery fell behind. Stop and restart live mode."); break;
            }
            const pcm = Buffer.from(event.audio, "base64");
            if (pcm.length === 0 || pcm.length % 2 !== 0 || pcm.length > 192_000) throw new Error("Invalid PCM");
            const now = Date.now();
            const stats = frames.get(event.source) ?? { chunks: 0, lastLevel: 0 };
            stats.chunks += 1;
            frames.set(event.source, stats);
            const queued = audioQueues.get(event.source)!;
            if (queued.length + pcm.length > 48_000) { fail("Native audio delivery fell behind. Restart live mode."); break; }
            audioQueues.set(event.source, Buffer.concat([queued, pcm]));
            if (now - stats.lastLevel >= 500) {
              stats.lastLevel = now;
              let squares = 0;
              for (let i = 0; i < pcm.length; i += 2) squares += (pcm.readInt16LE(i) / 32768) ** 2;
              send({ type: "level", source: event.source, chunks: stats.chunks, level: Math.sqrt(squares / (pcm.length / 2)) });
            }
          } catch { fail("Could not read the Mac audio stream."); }
        }
      });
    }

    try {
      const language = options.language as "english" | "russian" | "english-russian";
      const model = readEnvironmentValue(process.env, "OPENAI_REALTIME_TRANSCRIPTION_MODEL", localEnv) ?? defaultRealtimeTranscriptionModel;
      const session = buildRealtimeTranscriptionSessionUpdate(defaultRealtimeTurnDetectionSettings, language, model);
      for (const source of sources) {
        const socket = connectSocket(key);
        sockets.set(source, socket);
        socket.on("error", () => fail(`Could not connect ${source} transcription to OpenAI.`));
        socket.on("close", () => { if (!stopped) fail(`${source} transcription disconnected. Restart live mode.`); });
        socket.on("open", () => {
          if (stopped) return;
          socket.send(JSON.stringify({ type: "session.update", session: {
            ...session, audio: { input: { ...session.audio.input, format: { type: "audio/pcm", rate: 24000 } } }
          } }));
        });
        socket.on("message", (data) => {
          if (stopped) return;
          try {
            const event = JSON.parse(String(data));
            if (event.type === "error" || event.type === "conversation.item.input_audio_transcription.failed") {
              fail(`${source} transcription failed. Check the transcription model and API access.`); return;
            }
            if (event.type === "session.updated") { ready.add(source); startCapture(); }
            const itemKey = `${source}:${event.item_id}`;
            if (event.type === "input_audio_buffer.speech_started" && typeof event.audio_start_ms === "number") {
              turns.set(itemKey, (captureEpoch || Date.now()) + event.audio_start_ms);
            }
            const publicEvent = publicRealtimeEvent(event);
            if (!publicEvent) return;
            const capturedAt = turns.get(itemKey) ?? Date.now();
            if (event.type === "conversation.item.input_audio_transcription.completed") {
              if (completed.has(itemKey)) return;
              completed.add(itemKey);
              turns.delete(itemKey);
              if (completed.size > 2000) completed.delete(completed.values().next().value!);
            }
            send({ type: "realtime", source, capturedAt, event: publicEvent });
          } catch { fail("Could not read an OpenAI transcription event."); }
        });
      }
    } catch { fail("Could not start Mac audio transcription."); }
  }
  return {
    middleware,
    dispose() { stopActive?.(); for (const process of children) process.kill(); }
  };
}

export function createMacAudioPlugin(): Plugin {
  return {
    name: "echoguide-mac-audio",
    configureServer(server) {
      const bridge = createMacAudioMiddleware();
      server.middlewares.use((req, res, next) => { void bridge.middleware(req, res, next).catch(() => {
        if (!res.headersSent) json(res, 500, { error: "Mac audio could not start." });
        else res.end();
      }); });
      server.httpServer?.once("close", bridge.dispose);
    }
  };
}
