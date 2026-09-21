import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TrainingLivePanel } from "./TrainingLivePanel";
import { startBrowserRecording } from "../recordings/client";
import type { SessionHistoryEntry } from "../domain/sessionHistory";

vi.mock("../recordings/client", async original => ({
  ...await original<typeof import("../recordings/client")>(), startBrowserRecording: vi.fn()
}));
afterEach(() => { vi.clearAllMocks(); window.localStorage.clear(); });
async function setup() {
  const stopRecording = vi.fn(async () => {});
  vi.mocked(startBrowserRecording).mockImplementation((_stream, _sessionId, status) => {
    status("recording"); return { stop: stopRecording };
  });
  const disconnect = vi.fn();
  const save = vi.fn(async (id, draft) => ({ ...draft, id, version: 1,
    savedAt: "2026-09-21T10:00:00Z", createdAt: "2026-09-21T10:00:00Z", updatedAt: "2026-09-21T10:00:00Z" } as SessionHistoryEntry));
  const view = render(<TrainingLivePanel stream={{ getTracks: () => [], getAudioTracks: () => [] } as unknown as MediaStream} notes=""
    createSessionId={() => "recorded-session"}
    sessionHistoryClient={{ loadSessions: async () => [], saveCurrentSession: save, deleteSession: async () => [] }}
    requestClientSecret={async () => ({ clientSecret: "synthetic", expiresAt: 9999999999 })}
    createRecoveryAudioRecorder={() => ({ ensureActive: async () => "recording", getState: () => "recording",
      getRecentAudio: () => null, stop: () => {} })}
    connectRealtime={async () => ({ disconnect, sendEvent: () => false, clearAudio: () => false,
      commitAudio: () => false, collectStats: async () => {}, getRecentAudio: () => null })} />);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Start live" })); });
  await screen.findByRole("button", { name: "Stop live" });
  return { ...view, save, stopRecording, disconnect };
}
describe("Start live recording lifecycle", () => {
  it("creates history before the first transcript and stops audio with the same Stop live button", async () => {
    const test = await setup();
    expect(test.save).toHaveBeenCalledWith("recorded-session", expect.objectContaining({ transcriptTurns: [] }));
    expect(startBrowserRecording).toHaveBeenCalledWith(expect.anything(), "recorded-session", expect.any(Function));
    expect(screen.getByText("● Аудио записывается на этот компьютер")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Stop live" }));
    expect(test.stopRecording).toHaveBeenCalledOnce(); expect(test.disconnect).toHaveBeenCalledOnce();
  });
  it("shows recording errors independently and keeps live transcription available", async () => {
    const test = await setup();
    act(() => vi.mocked(startBrowserRecording).mock.calls[0][2]("error", "Disk full"));
    expect(screen.getByRole("button", { name: "Stop live" })).toBeInTheDocument();
    expect(screen.getByText(/Disk full/)).toBeInTheDocument();
    expect(test.disconnect).not.toHaveBeenCalled();
  });
  it("finalizes audio when starting a new session and ignores late status from the old one", async () => {
    const test = await setup();
    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    expect(test.stopRecording).toHaveBeenCalledOnce();
    act(() => vi.mocked(startBrowserRecording).mock.calls[0][2]("saved"));
    await waitFor(() => expect(screen.getByText("Start live также записывает аудио локально на этом компьютере.")).toBeInTheDocument());
  });
});
