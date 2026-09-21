import { afterEach, describe, expect, it, vi } from "vitest";
import { startBrowserRecording } from "./client";

class Recorder {
  static isTypeSupported = () => true;
  static last: Recorder;
  state = "inactive";
  ondataavailable?: (event: { data: Blob }) => void;
  onstop?: () => void;
  onerror?: () => void;
  constructor() { Recorder.last = this; }
  start() { this.state = "recording"; }
  stop() { this.state = "inactive"; this.ondataavailable?.({ data: new Blob(["tail"]) }); this.onstop?.(); }
  chunk(value: string) { this.ondataavailable?.({ data: new Blob([value]) }); }
}
afterEach(() => { vi.unstubAllGlobals(); });
describe("browser session recording", () => {
  it("uploads ordered chunks and flushes the final chunk before saving, even during pending startup", async () => {
    vi.stubGlobal("MediaRecorder", Recorder);
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: "recording-one" }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    const onStatus = vi.fn();
    const recording = startBrowserRecording({} as MediaStream, "session-one", onStatus);
    Recorder.last.chunk("first"); Recorder.last.chunk("second");
    await recording.stop();
    expect(fetcher.mock.calls.map(call => (call as unknown as [string])[0])).toEqual([
      "/api/recordings/session-one", "/api/recordings/session-one/recording-one/chunk?sequence=0",
      "/api/recordings/session-one/recording-one/chunk?sequence=1", "/api/recordings/session-one/recording-one/chunk?sequence=2",
      "/api/recordings/session-one/recording-one/finish"
    ]);
    expect(onStatus).toHaveBeenLastCalledWith("saved");
  });
  it("reports upload failure and marks partial audio interrupted without stopping microphone tracks", async () => {
    vi.stubGlobal("MediaRecorder", Recorder);
    const fetcher = vi.fn(async (path: string) => new Response(JSON.stringify(
      path.includes("chunk") ? { error: "Disk full" } : { id: "one" }), { status: path.includes("chunk") ? 500 : 200 }));
    vi.stubGlobal("fetch", fetcher);
    const stopTrack = vi.fn(); const onStatus = vi.fn();
    const recording = startBrowserRecording({ getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream, "session", onStatus);
    Recorder.last.chunk("audio");
    await recording.stop();
    expect(onStatus).toHaveBeenLastCalledWith("error", "Disk full");
    expect(stopTrack).not.toHaveBeenCalled();
    expect(fetcher.mock.calls.at(-1)?.[0]).toContain("finish");
  });
});
