import { flushSync } from "react-dom";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TrainingLivePanel } from "./TrainingLivePanel";
import { listMacAudioSources, macInputVolume, type MacAudioOptions } from "../macAudio/client";
import type { MacAudioEvent } from "../macAudio/protocol";
import type { SessionHistoryEntry, SessionHistoryEntryDraft } from "../domain/sessionHistory";

function getStartLiveOption() {
  const option = screen.queryByRole("button", { name: "С подсказками и расшифровкой" });
  if (option) return option;
  flushSync(() => fireEvent.click(screen.getByRole("button", { name: "Начать встречу ▾" })));
  return screen.getByRole("button", { name: "С подсказками и расшифровкой" });
}

vi.mock("../macAudio/client", async importOriginal => ({
  ...await importOriginal<typeof import("../macAudio/client")>(),
  listMacAudioSources: vi.fn(async () => ({ applications: [{ pid: 123, name: "Call app", bundleId: "test.app" }],
    microphones: [{ id: "usb", name: "UGREEN" }] })),
  macInputVolume: vi.fn(async () => ({ available: false }))
}));
afterEach(() => { window.localStorage.clear(); vi.restoreAllMocks(); });

async function setup(pending = false, recordingOnly = false) {
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
  expect(screen.getByLabelText("Audio source")).toHaveAttribute("title", expect.stringContaining("Источник звука"));
  expect(screen.queryByText("Audio source")).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Audio source"), { target: { value: "mac" } });
  fireEvent.click(screen.getByRole("button", { name: "Refresh Mac sources" }));
  await screen.findByRole("option", { name: "Call app (123)" });
  fireEvent.change(screen.getByLabelText("Call application"), { target: { value: "123" } });
  if (recordingOnly) {
    fireEvent.click(screen.getByRole("button", { name: "Начать встречу ▾" }));
    fireEvent.click(screen.getByRole("button", { name: "Только записать аудио" }));
  } else fireEvent.click(getStartLiveOption());
  await waitFor(() => expect(options).toBeDefined());
  if (!pending) await screen.findByRole("button", { name: recordingOnly ? "Остановить запись" : "Остановить встречу" });
  const emit = async (event: MacAudioEvent) => act(async () => { options!.onEvent(event); });
  return { ...view, emit, options: options!, transport, analyzePhrase, save, onRequestMicrophone, finish: () => finish() };
}

describe("Mac audio in Training Mode", () => {
  it("ignores obsolete routing preferences without opening native audio on reload", async () => {
    localStorage.setItem("echoguide.audioMode.v1", "mac");
    localStorage.setItem("echoguide.macAudio.virtualOutput.v1", "true");
    localStorage.setItem("echoguide.macAudio.v1", JSON.stringify({
      application: { name: "Call app", bundleId: "test.app" }, microphone: "usb"
    }));
    vi.mocked(listMacAudioSources).mockClear();
    vi.mocked(macInputVolume).mockClear();
    const connect = vi.fn();
    const renderPanel = () => render(<TrainingLivePanel stream={null} notes=""
      connectMacAudioClient={connect}
      sessionHistoryClient={{ loadSessions: async () => [],
        saveCurrentSession: vi.fn(), deleteSession: async () => [] }} />);
    const first = renderPanel();
    await act(async () => {});
    first.unmount();
    const second = renderPanel();
    await act(async () => {});
    expect(screen.queryByRole("button", { name: /BlackHole/ })).not.toBeInTheDocument();
    expect(listMacAudioSources).not.toHaveBeenCalled();
    expect(macInputVolume).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    second.unmount();
  });
  it("starts a meeting with the default microphone without an output route", async () => {
    const test = await setup();
    expect(test.options.microphone).toBe("default");
    expect(test.options).not.toHaveProperty("virtualOutput");
    expect(screen.queryByRole("button", { name: /BlackHole/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Остановить встречу" }));
    expect(test.options.signal.aborted).toBe(true);
  });
  it("uses the same dBFS scale for both source meters and reports peak overload", async () => {
    const test = await setup();
    await test.emit({ type: "level", source: "microphone", chunks: 1, level: 0.01, peak: 0.1 });
    await test.emit({ type: "level", source: "application", chunks: 1, level: 0.2, peak: 0.95 });
    const own = screen.getByRole("meter", { name: "Я / microphone" });
    const others = screen.getByRole("meter", { name: "Собеседники / application" });
    expect(own).toHaveAttribute("aria-valuenow", "-40");
    expect(own).toHaveAttribute("aria-valuetext", expect.stringContaining("рабочий уровень"));
    expect(others).toHaveAttribute("aria-valuenow", "-14");
    expect(others).toHaveAttribute("aria-valuetext", expect.stringContaining("перегруз"));
  });
  it("starts native recording without requesting transcription", async () => {
    const test = await setup(false, true);
    expect(test.options.recordingOnly).toBe(true);
    expect(test.save).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ sourceLabel: "Только аудио" }));
    expect(screen.queryByRole("button", { name: "Start streaming translation" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Остановить запись" }));
    expect(test.options.signal.aborted).toBe(true);
  });
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
    fireEvent.click(screen.getByRole("button", { name: "Остановить встречу" }));
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
    expect(screen.queryByRole("button", { name: "Остановить встречу" })).not.toBeInTheDocument();
  });
  it("stops capture on unmount and ignores late events", async () => {
    const test = await setup();
    test.unmount();
    expect(test.options.signal.aborted).toBe(true);
    expect(test.transport.disconnect).toHaveBeenCalledOnce();
  });
});
