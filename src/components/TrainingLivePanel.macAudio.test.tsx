import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TrainingLivePanel } from "./TrainingLivePanel";
import type { MacAudioOptions } from "../macAudio/client";
import type { MacAudioEvent } from "../macAudio/protocol";
import type { SessionHistoryEntry, SessionHistoryEntryDraft } from "../domain/sessionHistory";

vi.mock("../macAudio/client", async importOriginal => ({
  ...await importOriginal<typeof import("../macAudio/client")>(),
  listMacAudioSources: vi.fn(async () => ({ applications: [{ pid: 123, name: "Call app", bundleId: "test.app" }], microphones: [] }))
}));
afterEach(() => { window.localStorage.clear(); vi.restoreAllMocks(); });

async function setup(pending = false) {
  let options: MacAudioOptions | undefined;
  let finish: () => void = () => {};
  const transport = { disconnect: vi.fn(), sendEvent: () => false, clearAudio: () => false,
    commitAudio: () => false, collectStats: async () => {}, getRecentAudio: () => null };
  const analyzePhrase = vi.fn(async () => ({ speakerRole: "interviewer" as const, russianMeaning: "Вопрос",
    isQuestion: true, bridgePhrase: "Let me think.", suggestedReplies: [] }));
  const save = vi.fn(async (id: string, draft: SessionHistoryEntryDraft) => ({ ...draft, id,
    version: 1, savedAt: "now", createdAt: "now", updatedAt: "now" } as SessionHistoryEntry));
  const onRequestMicrophone = vi.fn();
  const view = render(<TrainingLivePanel stream={null} notes="" onRequestMicrophone={onRequestMicrophone}
    automaticAnalysisDelayMs={0} analyzePhrase={analyzePhrase} generateQuickStart={async () => null}
    translatePhrase={async () => "Перевод"}
    sessionHistoryClient={{ loadSessions: async () => [], saveCurrentSession: save, deleteSession: async () => [] }}
    connectMacAudioClient={async value => {
      options = value;
      if (pending) await new Promise<void>(resolve => { finish = resolve; });
      return transport;
    }} />);
  fireEvent.change(screen.getByLabelText("Audio source"), { target: { value: "mac" } });
  await screen.findByRole("option", { name: "Call app (123)" });
  fireEvent.change(screen.getByLabelText("Call application"), { target: { value: "123" } });
  fireEvent.click(screen.getByRole("button", { name: "Start live" }));
  await waitFor(() => expect(options).toBeDefined());
  if (!pending) await screen.findByRole("button", { name: "Stop live" });
  const emit = async (event: MacAudioEvent) => act(async () => { options!.onEvent(event); });
  return { ...view, emit, options: options!, transport, analyzePhrase, save, onRequestMicrophone, finish: () => finish() };
}

describe("Mac audio in Training Mode", () => {
  it("keeps source roles, analyzes only the other side, and preserves chronological turns", async () => {
    const test = await setup();
    expect(test.onRequestMicrophone).not.toHaveBeenCalled();
    await test.emit({ type: "realtime", source: "microphone", capturedAt: 50,
      event: { type: "conversation.item.input_audio_transcription.completed", transcript: "I finished the report." } });
    expect(test.analyzePhrase).not.toHaveBeenCalled();
    await test.emit({ type: "realtime", source: "application", capturedAt: 100,
      event: { type: "conversation.item.input_audio_transcription.completed", transcript: "What did you finish?" } });
    await waitFor(() => expect(test.analyzePhrase).toHaveBeenCalledWith("Interviewer: What did you finish?", "", expect.any(Array)));
    const latest = test.save.mock.calls.at(-1)![1].transcriptTurns;
    expect(latest.map(turn => turn.speakerLabel)).toEqual(["Me", "Interviewer"]);
    expect(latest.map(turn => turn.audioSource)).toEqual(["microphone", "application"]);
    expect(screen.getByText("Они", { selector: "button" })).toBeInTheDocument();
    expect(screen.getByText("Я", { selector: "button" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Stop live" }));
    expect(test.options.signal.aborted).toBe(true);
    expect(test.transport.disconnect).toHaveBeenCalledOnce();
  });
  it("does not generate an obsolete reply when the user has already started answering", async () => {
    const test = await setup();
    await test.emit({ type: "realtime", source: "microphone", capturedAt: 200,
      event: { type: "input_audio_buffer.speech_started" } });
    await test.emit({ type: "realtime", source: "application", capturedAt: 100,
      event: { type: "conversation.item.input_audio_transcription.completed", transcript: "What did you finish?" } });
    expect(test.analyzePhrase).not.toHaveBeenCalled();
    expect(screen.getByText("What did you finish?")).toBeInTheDocument();
  });
  it("cancels a pending start and disposes a late successful connection", async () => {
    const test = await setup(true);
    fireEvent.click(screen.getByRole("button", { name: "Cancel start" }));
    expect(test.options.signal.aborted).toBe(true);
    await act(async () => test.finish());
    expect(test.transport.disconnect).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Stop live" })).not.toBeInTheDocument();
  });
  it("stops capture on unmount and ignores late events", async () => {
    const test = await setup();
    test.unmount();
    expect(test.options.signal.aborted).toBe(true);
    expect(test.transport.disconnect).toHaveBeenCalledOnce();
  });
});
