import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import WebSocket from "ws";
import type { Plugin } from "vite";
import { recordingStore, type RecordingStore } from "../recordings/store";
import type { Recording } from "../recordings/types";
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
  recordings?: RecordingStore;
  platform?: string;
  helperExists?: () => boolean;
  spawnHelper?: (args: string[]) => ChildProcessWithoutNullStreams;
  connectSocket?: (key: string) => WebSocket;
  readEnv?: () => string;
  diagnostic?: (event: Record<string, string | number>) => void;
};

export function createMacAudioMiddleware(deps: MacAudioServerDependencies = {}) {
  const children = new Set<ChildProcessWithoutNullStreams>();
  let active = false;
  let stopActive: ((reason?: string) => void) | undefined;
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
    if (![`${prefix}sources`, `${prefix}session`, `${prefix}input-volume`, `${prefix}microphone-monitor`].includes(path)) {
      return json(res, 404, { error: "Unknown Mac audio route." });
    }
    if (active && path !== `${prefix}input-volume`) return json(res, 409, { error: "Mac audio is already running. Stop the other session first." });
    let options: Record<string, unknown>;
    try { options = await readOptions(req); } catch { return json(res, 400, { error: "Invalid Mac audio options." }); }
    if (res.destroyed) return;
    if (active && path !== `${prefix}input-volume`) return json(res, 409, { error: "Mac audio is already running." });

    if (path === `${prefix}input-volume`) {
      if (typeof options.microphone !== "string" || !options.microphone || options.microphone.length > 512 ||
          (options.value !== undefined && (!Number.isInteger(options.value) || Number(options.value) < 0 || Number(options.value) > 100))) {
        return json(res, 400, { error: "Invalid microphone input volume." });
      }
      const args = ["--input-volume", options.microphone];
      if (options.value !== undefined) args.push(String(Number(options.value) / 100));
      const helper = child(args);
      let output = "";
      let finished = false;
      const finish = (status: number, value: unknown) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        helper.kill();
        if (!res.destroyed) json(res, status, value);
      };
      const timeout = setTimeout(() => finish(504, { error: "Microphone input volume timed out." }), 10_000);
      res.on("close", () => { clearTimeout(timeout); helper.kill(); });
      helper.on("error", () => finish(500, { error: "Could not read microphone input volume." }));
      helper.stdout.on("data", chunk => {
        output += chunk.toString();
        if (output.length > 4096) finish(500, { error: "Invalid microphone input volume response." });
      });
      helper.on("close", () => {
        try {
          const result = JSON.parse(output.trim());
          if (result.type === "input-volume" && typeof result.available === "boolean") {
            finish(200, { available: result.available, value: result.available ? result.value : undefined });
          } else finish(500, { error: result.message || "Could not read microphone input volume." });
        } catch { finish(500, { error: "Could not read microphone input volume." }); }
      });
      return;
    }

    if (path === `${prefix}microphone-monitor`) {
      if (typeof options.microphone !== "string" || !options.microphone || options.microphone.length > 512) {
        return json(res, 400, { error: "Select a microphone to test." });
      }
      active = true;
      res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
      res.flushHeaders();
      const helper = child(["--monitor-microphone", options.microphone]);
      let pending = "";
      let stopped = false;
      const stop = () => {
        if (stopped) return;
        stopped = true;
        clearTimeout(timeout);
        helper.kill();
        active = false;
        stopActive = undefined;
        if (!res.destroyed) res.end();
      };
      stopActive = stop;
      const send = (event: { type: "ready" | "level" | "error"; level?: number; peak?: number; message?: string }) => {
        if (!stopped && !res.destroyed) res.write(`${JSON.stringify(event)}\n`);
      };
      const timeout = setTimeout(() => { send({ type: "error", message: "Microphone test timed out." }); stop(); }, 30_000);
      res.on("close", stop);
      helper.on("error", () => { send({ type: "error", message: "Could not start microphone test." }); stop(); });
      helper.on("close", () => { if (!stopped) { send({ type: "error", message: "Microphone test stopped." }); stop(); } });
      helper.stdout.on("data", chunk => {
        pending += chunk.toString();
        if (pending.length > 4096) { send({ type: "error", message: "Invalid microphone test response." }); stop(); return; }
        let end: number;
        while (!stopped && (end = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, end);
          pending = pending.slice(end + 1);
          try {
            const event = JSON.parse(line);
            if (event.type === "ready") { clearTimeout(timeout); send({ type: "ready" }); }
            else if (event.type === "level" && Number.isFinite(event.level) && Number.isFinite(event.peak) &&
              event.level >= 0 && event.level <= 1 && event.peak >= 0 && event.peak <= 1) {
              send({ type: "level", level: event.level, peak: event.peak });
            } else if (event.type === "error") { send({ type: "error", message: String(event.message || "Microphone test failed.") }); stop(); }
          } catch { send({ type: "error", message: "Invalid microphone test response." }); stop(); }
        }
      });
      return;
    }

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
        !["english", "russian", "english-russian"].includes(String(options.language)) ||
        (options.recordingOnly !== undefined && typeof options.recordingOnly !== "boolean") ||
        (options.recordingOnly === true && (typeof options.sessionId !== "string" || !options.sessionId))) {
      return json(res, 400, { error: "Select an application, microphone and speech language." });
    }
    const recordingOnly = options.recordingOnly === true;
    const localEnv = recordingOnly ? "" : deps.readEnv?.() ?? (existsSync(".env.local") ? readFileSync(".env.local", "utf8") : "");
    const key = recordingOnly ? "" : readOpenAiApiKey(process.env, localEnv);
    if (!recordingOnly && !key) return json(res, 503, { error: "The local server has no OpenAI API key." });
    active = true;
    res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
    res.flushHeaders();
    const sockets = new Map<MacAudioSource, WebSocket>();
    const ready = new Set<MacAudioSource>();
    const unavailable = new Set<MacAudioSource>();
    const frames = new Map<MacAudioSource, { chunks: number; lastLevel: number }>();
    const audioQueues = new Map<MacAudioSource, Buffer>(sources.map(source => [source, Buffer.alloc(0)]));
    const sessionId = randomUUID();
    const recordings = deps.recordings ?? recordingStore;
    let recording: Recording | undefined;
    const startedAt = performance.now();
    const diagnostic = (type: string, reason = "") => {
      const event = { storedAt: new Date().toISOString(), source: "mac-audio", type, sessionId, reason,
        elapsedMs: Math.round(performance.now() - startedAt),
        microphoneQueueBytes: audioQueues.get("microphone")?.length ?? 0,
        applicationQueueBytes: audioQueues.get("application")?.length ?? 0,
        microphoneChunks: frames.get("microphone")?.chunks ?? 0,
        applicationChunks: frames.get("application")?.chunks ?? 0 };
      try {
        if (deps.diagnostic) deps.diagnostic(event);
        else {
          const directory = resolve(".echoguide/diagnostics");
          mkdirSync(directory, { recursive: true });
          appendFileSync(resolve(directory, `realtime-${event.storedAt.slice(0, 10)}.jsonl`), `${JSON.stringify(event)}\n`);
        }
      } catch { /* Diagnostics must not interrupt live audio. */ }
    };
    diagnostic("mac_audio.started");
    let captureEpoch = 0;
    let audioPump: ReturnType<typeof setInterval> | undefined;
    const turns = new Map<string, number>();
    const completed = new Set<string>();
    let helper: ChildProcessWithoutNullStreams | undefined;
    let stopped = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const stop = (reason = "client_disconnected") => {
      if (stopped) return;
      stopped = true;
      diagnostic("mac_audio.stopped", reason);
      clearTimeout(timeout);
      clearInterval(heartbeat);
      clearInterval(audioPump);
      if (recording) {
        try {
          const mic = audioQueues.get("microphone") ?? Buffer.alloc(0);
          const app = audioQueues.get("application") ?? Buffer.alloc(0);
          if (mic.length || app.length) recording = recordings.append(recording.sessionId, recording.id,
            recording.sequence, mixStereo(mic, app));
          recordings.finish(recording.sessionId, recording.id, reason === "client_disconnected" ? "saved" : "interrupted");
        }
        catch { /* A previous checkpoint remains on disk; do not block capture cleanup. */ }
        recording = undefined;
      }
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
      if (!res.write(`${JSON.stringify(event)}\n`)) stop("browser_backpressure");
    };
    const fail = (message: string, reason = "capture_error") => { send({ type: "error", message }); stop(reason); };
    const transcriptionFailed = (source: MacAudioSource, message: string, reason: string) => {
      if (stopped || unavailable.has(source)) return;
      if (!captureEpoch) { fail(message, reason); return; }
      unavailable.add(source);
      sockets.get(source)?.terminate();
      diagnostic("mac_audio.transcription_error", reason);
      send({ type: "transcription-error", message: `${message} Audio capture continues; use Stop live to finish.` });
    };
    res.on("close", () => stop());
    timeout = setTimeout(() => fail("Mac audio startup timed out. Check capture permissions and try again.", "startup_timeout"), 90_000);
    let heartbeats = 0;
    heartbeat = setInterval(() => {
      send({ type: "heartbeat" });
      if (!stopped && ++heartbeats % 2 === 0) diagnostic("mac_audio.stats");
    }, 5000);

    function startCapture() {
      if (stopped || helper || (!recordingOnly && ready.size !== 2)) return;
      helper = child(["--capture", String(options.pid), String(options.microphone)]);
      let buffer = "";
      helper.on("error", () => fail("Could not launch EchoGuide Audio. Rebuild the helper."));
      helper.on("close", () => { if (!stopped) fail("Mac audio capture stopped. Check permissions and restart live mode.", "native_closed"); });
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
            if (event.type === "error") { fail(String(event.message).slice(0, 300), "native_error"); break; }
            if (event.type === "ready") {
              if (audioPump) continue;
              clearTimeout(timeout);
              captureEpoch = Date.now();
              if (typeof options.sessionId === "string") {
                try {
                  recording = recordings.start(options.sessionId, "wav");
                  send({ type: "recording", status: "recording", id: recording.id });
                } catch {
                  if (recordingOnly) { fail("Audio recording could not start. Check local storage.", "recording_error"); break; }
                  send({ type: "recording", status: "error", message: "Audio recording could not start. Check local storage." });
                }
              }
              const pumpStartedAt = performance.now();
              let sentFrames = 0;
              diagnostic("mac_audio.ready");
              // Clock both streams together, including silence when an app emits no buffers.
              // This lets VAD finish a turn even when playback stops abruptly.
              audioPump = setInterval(() => {
                // Timer callbacks can be late. Drain the elapsed audio duration rather than
                // one fixed frame per callback, otherwise a small delay accumulates forever.
                const dueFrames = Math.floor((performance.now() - pumpStartedAt) / 100) - sentFrames;
                if (dueFrames > 10) {
                  fail("Audio processing paused for too long. Restart live mode.", "audio_clock_stalled"); return;
                }
                for (let frame = 0; frame < dueFrames; frame++) {
                  sentFrames += 1;
                  const recordingChannels: Buffer[] = [];
                  for (const source of sources) {
                    if (stopped) return;
                    const queue = audioQueues.get(source)!;
                    const pcm = Buffer.alloc(4800);
                    queue.copy(pcm, 0, 0, Math.min(queue.length, pcm.length));
                    audioQueues.set(source, queue.subarray(Math.min(queue.length, pcm.length)));
                    recordingChannels.push(pcm);
                    if (!recordingOnly && !unavailable.has(source)) {
                      const socket = sockets.get(source)!;
                      if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > 256_000) {
                        transcriptionFailed(source, "Audio delivery fell behind.", "upstream_backpressure");
                      } else {
                        try { socket.send(JSON.stringify({ type: "input_audio_buffer.append", audio: pcm.toString("base64") })); }
                        catch { transcriptionFailed(source, "Audio delivery failed.", "upstream_send_failed"); }
                      }
                    }
                  }
                  if (recording && recordingChannels.length === 2) {
                    try {
                      recording = recordings.append(recording.sessionId, recording.id, recording.sequence,
                        mixStereo(recordingChannels[0], recordingChannels[1]));
                    } catch {
                      recording = undefined;
                      send({ type: "recording", status: "error", message: "Audio recording stopped: storage error or 1 GB / 4 hour limit. Earlier audio is kept." });
                    }
                  }
                }
              }, 100);
              send({ type: "ready" }); continue;
            }
            if (event.type !== "audio" || !isMacAudioSource(event.source) || typeof event.audio !== "string") continue;
            const pcm = Buffer.from(event.audio, "base64");
            if (pcm.length === 0 || pcm.length % 2 !== 0 || pcm.length > 192_000) throw new Error("Invalid PCM");
            const now = Date.now();
            const stats = frames.get(event.source) ?? { chunks: 0, lastLevel: 0 };
            stats.chunks += 1;
            frames.set(event.source, stats);
            const queued = audioQueues.get(event.source)!;
            if (queued.length + pcm.length > 48_000) { fail("Native audio delivery fell behind. Restart live mode.", "native_queue_overflow"); break; }
            audioQueues.set(event.source, Buffer.concat([queued, pcm]));
            if (now - stats.lastLevel >= 500) {
              stats.lastLevel = now;
              let squares = 0;
              let peak = 0;
              for (let i = 0; i < pcm.length; i += 2) {
                const sample = Math.abs(pcm.readInt16LE(i) / 32768);
                squares += sample ** 2;
                peak = Math.max(peak, sample);
              }
              send({ type: "level", source: event.source, chunks: stats.chunks,
                level: Math.sqrt(squares / (pcm.length / 2)), peak });
            }
          } catch { fail("Could not read the Mac audio stream."); }
        }
      });
    }

    try {
      if (recordingOnly) { startCapture(); return; }
      const language = options.language as "english" | "russian" | "english-russian";
      const model = readEnvironmentValue(process.env, "OPENAI_REALTIME_TRANSCRIPTION_MODEL", localEnv) ?? defaultRealtimeTranscriptionModel;
      const session = buildRealtimeTranscriptionSessionUpdate(defaultRealtimeTurnDetectionSettings, language, model);
      for (const source of sources) {
        const socket = connectSocket(key!);
        sockets.set(source, socket);
        socket.on("error", () => transcriptionFailed(source, `Could not connect ${source} transcription to OpenAI.`, `${source}_upstream_error`));
        socket.on("close", () => { if (!stopped) transcriptionFailed(source, `${source} transcription disconnected.`, `${source}_upstream_closed`); });
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
              transcriptionFailed(source, `${source} transcription failed. Check the transcription model and API access.`, `${source}_upstream_error`); return;
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
    dispose() { stopActive?.("server_closed"); for (const process of children) process.kill(); }
  };
}

// Both voices are centered: the same mixed sample goes to both headphones.
export function mixStereo(microphone: Buffer, application: Buffer) {
  const stereo = Buffer.alloc(Math.max(microphone.length, application.length) * 2);
  for (let offset = 0; offset < stereo.length / 2; offset += 2) {
    const mic = offset < microphone.length ? microphone.readInt16LE(offset) : 0;
    const app = offset < application.length ? application.readInt16LE(offset) : 0;
    const sample = Math.max(-32768, Math.min(32767, mic + app));
    stereo.writeInt16LE(sample, offset * 2);
    stereo.writeInt16LE(sample, offset * 2 + 2);
  }
  return stereo;
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
