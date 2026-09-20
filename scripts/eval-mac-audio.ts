import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { buildRealtimeTranscriptionSessionUpdate, defaultRealtimeTranscriptionModel,
  defaultRealtimeTurnDetectionSettings } from "../src/realtime/realtimeSession.ts";

// Synthetic speech only. No microphone, application capture, or private context.
if (existsSync(".env.local")) process.loadEnvFile(".env.local");
const key = process.env.OPENAI_API_KEY;
if (!key) throw new Error("OPENAI_API_KEY is not configured.");
const directory = mkdtempSync(join(tmpdir(), "echoguide-mac-audio-"));
const fixtures = [
  { source: "microphone", text: "I finished the report yesterday.", expected: /report/i },
  { source: "application", text: "What is the plan for the next meeting?", expected: /meeting/i }
];

function speech(index: number, text: string): Buffer {
  const aiff = join(directory, `${index}.aiff`);
  const wav = join(directory, `${index}.wav`);
  execFileSync("/usr/bin/say", ["-v", "Samantha", "-o", aiff, text], { stdio: "ignore" });
  execFileSync("/usr/bin/afconvert", ["-f", "WAVE", "-d", "LEI16@24000", "-c", "1", aiff, wav], { stdio: "ignore" });
  const bytes = readFileSync(wav);
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const size = bytes.readUInt32LE(offset + 4);
    if (bytes.toString("ascii", offset, offset + 4) === "data") {
      return Buffer.concat([Buffer.alloc(24000), bytes.subarray(offset + 8, offset + 8 + size), Buffer.alloc(96000)]);
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error("Synthetic WAV had no audio data.");
}

async function check(fixture: typeof fixtures[number], audio: Buffer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket("wss://api.openai.com/v1/realtime?intent=transcription", {
      headers: { Authorization: `Bearer ${key}` }, handshakeTimeout: 20_000
    });
    let timer: ReturnType<typeof setInterval> | undefined;
    let sent = false;
    let finished = false;
    const end = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline); clearInterval(timer); socket.terminate();
      if (error) reject(error); else resolve();
    };
    const deadline = setTimeout(() => end(new Error(`${fixture.source}: timed out`)), 40_000);
    socket.on("error", () => end(new Error(`${fixture.source}: connection failed`)));
    socket.on("close", () => { if (!finished) end(new Error(`${fixture.source}: disconnected`)); });
    socket.on("open", () => {
      const session = buildRealtimeTranscriptionSessionUpdate(defaultRealtimeTurnDetectionSettings,
        "english", process.env.OPENAI_REALTIME_TRANSCRIPTION_MODEL || defaultRealtimeTranscriptionModel);
      socket.send(JSON.stringify({ type: "session.update", session: {
        ...session, audio: { input: { ...session.audio.input, format: { type: "audio/pcm", rate: 24000 } } }
      } }));
    });
    socket.on("message", data => {
      const event = JSON.parse(String(data));
      if (event.type === "error") return end(new Error(`${fixture.source}: API rejected the session (${String(event.error?.code ?? "unknown").replace(/[^a-z_]/gi, "")})`));
      if (event.type === "session.updated" && !sent) {
        sent = true;
        let offset = 0;
        timer = setInterval(() => {
          if (offset >= audio.length) { clearInterval(timer); return; }
          socket.send(JSON.stringify({ type: "input_audio_buffer.append", audio: audio.subarray(offset, offset + 4800).toString("base64") }));
          offset += 4800;
        }, 100);
      }
      if (event.type === "conversation.item.input_audio_transcription.completed") {
        if (fixture.expected.test(String(event.transcript))) {
          console.log(`${fixture.source}: PASS (synthetic speech recognized)`); end();
        } else end(new Error(`${fixture.source}: unexpected synthetic transcription`));
      }
    });
  });
}

try {
  const audio = fixtures.map((fixture, index) => speech(index, fixture.text));
  const results = await Promise.allSettled(fixtures.map((fixture, index) => check(fixture, audio[index])));
  for (const result of results) if (result.status === "rejected") {
    console.error(result.reason instanceof Error ? result.reason.message : "Synthetic check failed.");
    process.exitCode = 1;
  }
} finally { rmSync(directory, { recursive: true, force: true }); }
