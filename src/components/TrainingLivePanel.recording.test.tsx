import { flushSync } from "react-dom";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TrainingLivePanel } from "./TrainingLivePanel";
import { startBrowserRecording } from "../recordings/client";
import type { SessionHistoryEntry } from "../domain/sessionHistory";

function getStartLiveOption() {
  const option = screen.queryByRole("button", { name: "С подсказками и расшифровкой" });
  if (option) return option;
  flushSync(() => fireEvent.click(screen.getByRole("button", { name: "Начать встречу ▾" })));
  return screen.getByRole("button", { name: "С подсказками и расшифровкой" });
}

vi.mock("../recordings/client", async original => ({
  ...await original<typeof import("../recordings/client")>(), startBrowserRecording: vi.fn()
}));
afterEach(() => { vi.clearAllMocks(); window.localStorage.clear(); });
async function setup(mode: "live" | "audio-only" = "live") {
  const stopRecording = vi.fn(async () => {});
  vi.mocked(startBrowserRecording).mockImplementation((_stream, _sessionId, status) => {
    status("recording"); return { stop: stopRecording };
  });
  const disconnect = vi.fn();
  const requestClientSecret = vi.fn(async () => ({ clientSecret: "synthetic", expiresAt: 9999999999 }));
  const connectRealtime = vi.fn(async () => ({ disconnect, sendEvent: () => false, clearAudio: () => false,
    commitAudio: () => false, collectStats: async () => {}, getRecentAudio: () => null }));
  const save = vi.fn(async (id, draft) => ({ ...draft, id, version: 1,
    savedAt: "2026-09-21T10:00:00Z", createdAt: "2026-09-21T10:00:00Z", updatedAt: "2026-09-21T10:00:00Z" } as SessionHistoryEntry));
  const view = render(<TrainingLivePanel stream={{ getTracks: () => [], getAudioTracks: () => [] } as unknown as MediaStream} notes=""
    createSessionId={() => "recorded-session"}
    sessionHistoryClient={{ loadSessions: async () => [], saveCurrentSession: save, deleteSession: async () => [] }}
    requestClientSecret={requestClientSecret}
    createRecoveryAudioRecorder={() => ({ ensureActive: async () => "recording", getState: () => "recording",
      getRecentAudio: () => null, stop: () => {} })}
    connectRealtime={connectRealtime} />);
  await act(async () => {
    if (mode === "live") fireEvent.click(getStartLiveOption());
    else {
      flushSync(() => fireEvent.click(screen.getByRole("button", { name: "Начать встречу ▾" })));
      fireEvent.click(screen.getByRole("button", { name: "Только записать аудио" }));
    }
  });
  await screen.findByRole("button", { name: mode === "live" ? "Остановить встречу" : "Остановить запись" });
  return { ...view, save, stopRecording, disconnect, requestClientSecret, connectRealtime };
}
describe("Start live recording lifecycle", () => {
  it("creates history before the first transcript and stops audio with the same Stop live button", async () => {
    const test = await setup();
    expect(test.save).toHaveBeenCalledWith("recorded-session", expect.objectContaining({ transcriptTurns: [] }));
    expect(startBrowserRecording).toHaveBeenCalledWith(expect.anything(), "recorded-session", expect.any(Function));
    expect(screen.getByText(/● Запись · 00:00/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Остановить встречу" }));
    expect(test.stopRecording).toHaveBeenCalledOnce(); expect(test.disconnect).toHaveBeenCalledOnce();
  });
  it("shows recording errors independently and keeps live transcription available", async () => {
    const test = await setup();
    act(() => vi.mocked(startBrowserRecording).mock.calls[0][2]("error", "Disk full"));
    expect(screen.getByRole("button", { name: "Остановить встречу" })).toBeInTheDocument();
    expect(screen.getByText(/Disk full/)).toBeInTheDocument();
    expect(test.disconnect).not.toHaveBeenCalled();
  });
  it("finalizes audio when starting a new session and ignores late status from the old one", async () => {
    const test = await setup();
    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    expect(test.stopRecording).toHaveBeenCalledOnce();
    act(() => vi.mocked(startBrowserRecording).mock.calls[0][2]("saved"));
    await waitFor(() => expect(screen.getByText("Аудиозапись сохраняется локально на этом компьютере.")).toBeInTheDocument());
  });
  it("records audio without opening Realtime or creating transcript content", async () => {
    const test = await setup("audio-only");
    expect(test.save).toHaveBeenCalledWith("recorded-session", expect.objectContaining({
      sourceLabel: "Только аудио", knowledgeContext: "", transcriptTurns: []
    }));
    expect(test.requestClientSecret).not.toHaveBeenCalled();
    expect(test.connectRealtime).not.toHaveBeenCalled();
    expect(screen.getByText(/Расшифровка и подсказки выключены/)).toBeInTheDocument();
    expect(document.querySelector(".audio-only-active")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Остановить запись" }));
    expect(test.stopRecording).toHaveBeenCalledOnce();
    expect(test.disconnect).not.toHaveBeenCalled();
  });
});
