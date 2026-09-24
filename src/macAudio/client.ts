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

export type MacInputVolume = { available: boolean; value?: number };

export async function macInputVolume(microphone: string, value?: number, signal?: AbortSignal): Promise<MacInputVolume> {
  const response = await fetch("/api/mac-audio/input-volume", {
    method: "POST", headers: macAudioHeaders,
    body: JSON.stringify({ microphone, ...(value === undefined ? {} : { value }) }), signal
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Could not read microphone input volume.");
  return payload;
}

export type MacMicrophoneMonitorEvent =
  | { type: "ready" }
  | { type: "level"; level: number; peak: number };

export function monitorMacMicrophone(microphone: string,
  onEvent: (event: MacMicrophoneMonitorEvent) => void,
  onError: (message: string) => void,
  fetchImpl: typeof fetch = fetch
): { stop: () => void } {
  const controller = new AbortController();
  void (async () => {
    try {
      const response = await fetchImpl("/api/mac-audio/microphone-monitor", {
        method: "POST", headers: macAudioHeaders, body: JSON.stringify({ microphone }), signal: controller.signal
      });
      if (!response.ok) {
        const payload = await response.json();
        throw new Error(payload.error || "Could not start microphone test.");
      }
      if (!response.body) throw new Error("Microphone test streaming is unavailable.");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      try {
        while (!controller.signal.aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          pending += decoder.decode(value, { stream: true });
          if (pending.length > 4096) throw new Error("Invalid microphone test response.");
          let end: number;
          while ((end = pending.indexOf("\n")) >= 0) {
            const line = pending.slice(0, end);
            pending = pending.slice(end + 1);
            if (!line.trim()) continue;
            const event = JSON.parse(line);
            if (event.type === "error") throw new Error(event.message || "Microphone test failed.");
            if (!controller.signal.aborted && (event.type === "ready" || event.type === "level")) onEvent(event);
          }
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      if (!controller.signal.aborted) throw new Error("Microphone test disconnected.");
    } catch (error) {
      if (!controller.signal.aborted) onError(error instanceof Error ? error.message : "Microphone test failed.");
    }
  })();
  return { stop: () => controller.abort() };
}

export type MacAudioOptions = {
  sessionId?: string;
  recordingOnly?: boolean;
  virtualOutput?: boolean;
  pid: number;
  microphone: string;
  language: RealtimeSpeechLanguage;
  signal: AbortSignal;
  onEvent: (event: MacAudioEvent) => void;
  onError: (message: string) => void;
  fetchImpl?: typeof fetch;
};

export async function connectMacAudio({ pid, microphone, language, sessionId, recordingOnly = false, virtualOutput = false, signal, onEvent, onError,
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
        method: "POST", headers: macAudioHeaders, body: JSON.stringify({ pid, microphone, language, sessionId, recordingOnly, virtualOutput }), signal: controller.signal
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
