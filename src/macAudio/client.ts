import type { RealtimeSpeechLanguage } from "../realtime/realtimeSession";
import type { RealtimeTranscriptionConnection } from "../realtime/realtimeConnection";
import { macAudioHeaders, type MacAudioEvent, type MacAudioSources } from "./protocol";

export async function listMacAudioSources(signal?: AbortSignal): Promise<MacAudioSources> {
  const response = await fetch("/api/mac-audio/sources", {
    method: "POST", headers: macAudioHeaders, body: "{}", signal
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Could not list Mac audio sources.");
  return payload;
}

export type MacAudioOptions = {
  sessionId?: string;
  recordingOnly?: boolean;
  pid: number;
  microphone: string;
  language: RealtimeSpeechLanguage;
  signal: AbortSignal;
  onEvent: (event: MacAudioEvent) => void;
  onError: (message: string) => void;
  fetchImpl?: typeof fetch;
};

export async function connectMacAudio({ pid, microphone, language, sessionId, recordingOnly = false, signal, onEvent, onError,
  fetchImpl = fetch }: MacAudioOptions): Promise<RealtimeTranscriptionConnection> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) controller.abort();
  let ready = false;
  let readyResolve: () => void = () => {};
  let readyReject: (error: Error) => void = () => {};
  const readiness = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const timeout = setTimeout(() => controller.abort(), 95_000);
  const disconnected = () => {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
    controller.abort();
  };
  void (async () => {
    try {
      const response = await fetchImpl("/api/mac-audio/session", {
        method: "POST", headers: macAudioHeaders, body: JSON.stringify({ pid, microphone, language, sessionId, recordingOnly }), signal: controller.signal
      });
      if (!response.ok) {
        const payload = await response.json();
        throw new Error(payload.error || "Mac audio could not start.");
      }
      if (!response.body) throw new Error("This browser does not support streaming Mac audio.");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      try {
        while (!controller.signal.aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          pending += decoder.decode(value, { stream: true });
          if (pending.length > 1024 * 1024) throw new Error("Mac audio response exceeded its limit.");
          let end: number;
          while ((end = pending.indexOf("\n")) >= 0) {
            const line = pending.slice(0, end);
            pending = pending.slice(end + 1);
            if (!line.trim()) continue;
            const event = JSON.parse(line) as MacAudioEvent | { type: "heartbeat" };
            if (event.type === "error") throw new Error(event.message);
            if (event.type === "heartbeat") continue;
            if (event.type === "ready") { ready = true; clearTimeout(timeout); readyResolve(); }
            if (!controller.signal.aborted) onEvent(event);
          }
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      if (!controller.signal.aborted) throw new Error("Mac audio disconnected. Restart live mode.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Mac audio failed.";
      if (!ready) readyReject(new Error(signal.aborted ? "Mac audio start cancelled." : message));
      else if (!controller.signal.aborted) onError(message);
    } finally {
      if (!ready) readyReject(new Error("Mac audio start cancelled or timed out."));
      disconnected();
    }
  })();
  await readiness;
  return {
    sendEvent: () => false, clearAudio: () => false, commitAudio: () => false,
    collectStats: async () => {}, getRecentAudio: () => null, disconnect: disconnected
  };
}
