import { recordingHeaders, type Recording } from "./types";

export type RecordingStatus = "idle" | "starting" | "recording" | "saving" | "saved" | "error";
export type BrowserRecording = { stop: () => Promise<void> };
export const recordingPath = (sessionId: string) => `/api/recordings/${encodeURIComponent(sessionId)}`;

async function request(path: string, init: RequestInit = {}) {
  const response = await fetch(path, { ...init, headers: { ...recordingHeaders, ...init.headers },
    signal: AbortSignal.timeout(15_000) });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || "Audio recording could not be saved.");
  }
  return response.json() as Promise<Recording>;
}

export function startBrowserRecording(stream: MediaStream, sessionId: string,
  onStatus: (status: RecordingStatus, error?: string) => void): BrowserRecording {
  if (typeof MediaRecorder === "undefined") throw new Error("Audio recording is unavailable in this browser.");
  const mimeType = ["audio/webm;codecs=opus", "audio/mp4"].find(type => MediaRecorder.isTypeSupported(type));
  if (!mimeType) throw new Error("This browser has no supported audio recording format.");
  const recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 128_000 });
  let pendingBytes = 0;
  let sequence = 0;
  let failed = false;
  let stopping = false;
  let record: Recording | undefined;
  let done: () => void = () => {};
  const stopped = new Promise<void>(resolve => { done = resolve; });
  const fail = (error: unknown) => {
    if (failed) return;
    failed = true;
    onStatus("error", error instanceof Error ? error.message : "Audio recording failed.");
    if (recorder.state !== "inactive") recorder.stop();
  };
  onStatus("starting");
  let queue = request(recordingPath(sessionId), { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ format: mimeType.includes("webm") ? "webm" : "mp4" }) })
    .then(value => { record = value; if (!stopping && !failed) onStatus("recording"); })
    .catch(fail);
  recorder.ondataavailable = event => {
    if (!event.data.size || failed) return;
    pendingBytes += event.data.size;
    if (pendingBytes > 16 * 1024 * 1024) { fail(new Error("Audio saving fell behind. Earlier uploaded audio is kept.")); return; }
    queue = queue.then(async () => {
      if (!record || failed) return;
      await request(`${recordingPath(sessionId)}/${record.id}/chunk?sequence=${sequence++}`, {
        method: "POST", body: event.data
      });
    }).catch(fail).finally(() => { pendingBytes -= event.data.size; });
  };
  recorder.onerror = () => fail(new Error("The browser audio recorder stopped unexpectedly."));
  recorder.onstop = () => {
    stopping = true;
    if (!failed) onStatus("saving");
    void queue.then(async () => {
      if (record) await request(`${recordingPath(sessionId)}/${record.id}/finish`, { method: "POST",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ interrupted: failed }) });
      if (!failed) onStatus("saved");
    }).catch(fail).finally(done);
  };
  try { recorder.start(1000); }
  catch (error) {
    fail(error);
    void queue.then(async () => {
      if (record) await request(`${recordingPath(sessionId)}/${record.id}/finish`, {
        method: "POST", body: JSON.stringify({ interrupted: true }) });
    }).catch(() => {}).finally(done);
  }
  return { stop() {
    stopping = true;
    if (recorder.state !== "inactive") recorder.stop();
    return stopped;
  } };
}
