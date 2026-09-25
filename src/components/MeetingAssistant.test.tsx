import { englishRealtimeTranscriptionPrompt } from "../realtime/realtimeSession";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MeetingAssistant } from "./MeetingAssistant";
import { meetingRequest } from "../meeting/client";
import { meetingHistoryClient } from "../meeting/historyClient";
import type { MeetingCardSnapshot } from "../meeting/history";
import { meetingFallback, meetingFallbackFor } from "../meeting/types";
vi.mock("../meeting/client", () => ({ meetingRequest: vi.fn() }));
vi.mock("../meeting/historyClient", () => ({ meetingHistoryClient: { load: vi.fn(), save: vi.fn(), retry: vi.fn(), hasPending: vi.fn(() => false) } }));
let snapshots: MeetingCardSnapshot[] = [];
beforeEach(() => {
  snapshots = [];
  vi.mocked(meetingHistoryClient.load).mockImplementation(async sessionId => snapshots.filter(r => r.identity.sessionId === sessionId));
  vi.mocked(meetingHistoryClient.save).mockImplementation(async r => { snapshots.push(structuredClone(r)); });
});
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); });
const packs = { activePackId: "a", packs: [{ id: "a", name: "Current", status: "ready", createdAt: "2026-09-19", filenames: ["notes.md"], sectionCount: 1 }] };
const selection = { id: "one", text: "What is the plan?", speaker: "Heard", context: ["Heard: Let's discuss the pilot."] };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function mockRoutes() {
  vi.mocked(meetingRequest).mockImplementation(async path => path === "packs" ? packs : path === "search" ? { ticket: "t", found: 1 } : meetingFallback);
}
describe("manual meeting assistance", () => {
  it("shows and saves why the full answer fell back after an opening", async () => {
    vi.mocked(meetingRequest).mockImplementation(async path => path === "packs" ? packs : path === "search"
      ? { ticket: "t", found: 2 } : meetingFallbackFor("model_no_answer", 2));
    render(<MeetingAssistant sessionId="session-one" selection={selection}
      quickStart={async () => ({ mode: "start", english: "I would compare both options.", russian: "Я бы сравнил оба варианта." })} />);
    await screen.findByText(meetingFallback.english);
    fireEvent.click(screen.getByText("Диагностика ответа"));
    expect(screen.getByText(/model_no_answer/)).toHaveTextContent("Найдено разделов: 2");
    expect(snapshots.at(-1)?.answer?.diagnostics).toEqual({ reason: "model_no_answer", found: 2 });
  });
  it("distinguishes a search failure from an unsupported answer", async () => {
    vi.mocked(meetingRequest).mockImplementation(async path => {
      if (path === "packs") return packs;
      throw new Error("synthetic search failure");
    });
    render(<MeetingAssistant sessionId="session-one" selection={selection} quickStart={async () => null} />);
    await screen.findByText(meetingFallback.english);
    fireEvent.click(screen.getByText("Диагностика ответа"));
    expect(screen.getByText(/search_error/)).toHaveTextContent("Найдено разделов: неизвестно");
    expect(snapshots.at(-1)?.answer?.diagnostics).toEqual({ reason: "search_error" });
  });
  it("shows the Russian meaning first and keeps the spoken English in a disclosure", async () => {
    mockRoutes();
    render(<MeetingAssistant
      sessionId="session-one"
      selection={selection}
      russianMeaning="Каков план?"
      quickStart={async () => null}
    />);
    await screen.findByText(meetingFallback.english);
    const question = screen.getByText("Каков план?").closest(".meeting-question");
    expect(question).toHaveTextContent("Каков план?");
    expect(question).toHaveTextContent("English original");
    expect(question).toHaveTextContent(selection.text);
    expect(question?.querySelector("details")).not.toHaveAttribute("open");
  });

  it("waits for selection and does not regenerate the same selected phrase", async () => {
    mockRoutes(); const quick = vi.fn().mockResolvedValue({ mode: "start", english: "Opening", russian: "Начало" });
    const { rerender } = render(<MeetingAssistant sessionId="session-one" selection={null} quickStart={quick} />);
    await waitFor(() => expect(meetingRequest).toHaveBeenCalled());
    expect(quick).not.toHaveBeenCalled();
    rerender(<MeetingAssistant sessionId="session-one" selection={selection} quickStart={quick} />);
    await screen.findByText(meetingFallback.english);
    const opening = screen.getByText("Opening");
    rerender(<MeetingAssistant sessionId="session-one" selection={{ ...selection }} quickStart={quick} />);
    expect(quick).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Opening")).toBe(opening);
    expect(quick).toHaveBeenCalledWith(selection.text, selection.context, "Heard", expect.any(AbortSignal));
  });
  it("starts retrieval in parallel and appends the answer without replacing the opening", async () => {
    let now = 100;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const first = deferred<any>(); const answer = deferred<any>();
    vi.mocked(meetingRequest).mockImplementation(async path => path === "packs" ? packs : path === "search" ? { ticket: "t", found: 1 } : answer.promise);
    render(<MeetingAssistant sessionId="session-one" selection={selection} quickStart={() => first.promise} />);
    await waitFor(() => expect(meetingRequest).toHaveBeenCalledWith("search", expect.anything(), expect.any(AbortSignal)));
    now = 1350;
    await act(async () => first.resolve({ mode: "start", english: "Opening", russian: "Начало" }));
    expect(screen.getByText("Начало: 1.3 с")).toBeInTheDocument();
    expect(screen.queryByText(/Поиск и полный ответ:/)).not.toBeInTheDocument();
    const opening = screen.getByText("Opening");
    now = 4600;
    await act(async () => answer.resolve(meetingFallback));
    expect(screen.getByText("Начало: 1.3 с")).toBeInTheDocument();
    expect(screen.getByText("Поиск и полный ответ: 4.5 с")).toBeInTheDocument();
    expect(screen.getByText("Opening")).toBe(opening);
    expect(screen.getByText(meetingFallback.english)).toBeInTheDocument();
  });
  it("lets evidence answer when the fast opening asks for clarification", async () => {
    const grounded = { status: "grounded", english: "I test ideas on real tasks.", russian: "Я проверяю идеи на реальных задачах.", sources: [] };
    vi.mocked(meetingRequest).mockImplementation(async path => path === "packs" ? packs : path === "search" ? { ticket: "t", found: 1 } : grounded);
    render(<MeetingAssistant sessionId="session-one" selection={selection} quickStart={async () => ({ mode: "clarify", english: "Which role?", russian: "Какая роль?" })} />);
    await screen.findByText(grounded.english);
    expect(screen.queryByText("Which role?")).not.toBeInTheDocument();
    expect(screen.getByText("Ответ")).toBeInTheDocument();
    expect(meetingRequest).toHaveBeenCalledWith("answer", { packId: "a", ticket: "t" }, expect.any(AbortSignal));
  });
  it("honors explicit selection even when the opening model chooses wait", async () => {
    mockRoutes(); const quick = vi.fn().mockResolvedValue({ mode: "wait", english: "", russian: "" });
    render(<MeetingAssistant sessionId="session-one" selection={{ ...selection, speaker: "Me" }} quickStart={quick} />);
    await screen.findByText(meetingFallback.english);
    expect(screen.queryByText("Начни так")).not.toBeInTheDocument();
  });
  it("ignores late results after selecting another phrase", async () => {
    const old = deferred<any>();
    vi.mocked(meetingRequest).mockImplementation(async (path, body: any) => path === "packs" ? packs : path === "search" ?
      (body.transcript === selection.text ? old.promise : { ticket: "new", found: 1 }) : meetingFallback);
    const quick = vi.fn().mockResolvedValue(null);
    const { rerender } = render(<MeetingAssistant sessionId="session-one" selection={selection} quickStart={quick} />);
    await waitFor(() => expect(quick).toHaveBeenCalledTimes(1));
    rerender(<MeetingAssistant sessionId="session-one" selection={{ ...selection, id: "two", text: "Who owns it?" }} quickStart={quick} />);
    await screen.findByText(meetingFallback.english);
    await act(async () => old.resolve({ ticket: "old", found: 1 }));
    expect(vi.mocked(meetingRequest).mock.calls.filter(c => c[0] === "answer")).toHaveLength(1);
    expect(screen.getByText("Who owns it?")).toBeInTheDocument();
  });
});


it("restores a persisted pair after switching away and remounting without generation", async () => {
  mockRoutes(); const quick = vi.fn().mockResolvedValue({ mode: "start", english: "Saved opening", russian: "Начало" });
  const view = render(<MeetingAssistant sessionId="session-one" selection={selection} quickStart={quick} />);
  await screen.findByText(meetingFallback.english);
  expect(snapshots.some(r => r.phase === "opening" && !r.answer)).toBe(true);
  view.rerender(<MeetingAssistant sessionId="session-one" selection={null} quickStart={quick} />);
  view.rerender(<MeetingAssistant sessionId="session-one" selection={selection} quickStart={quick} />);
  await screen.findByText("Saved opening");
  expect(quick).toHaveBeenCalledTimes(1);
  view.unmount();
  render(<MeetingAssistant sessionId="session-one" selection={selection} quickStart={quick} />);
  await screen.findByText(meetingFallback.english);
  expect(quick).toHaveBeenCalledTimes(1);
  expect(vi.mocked(meetingRequest).mock.calls.filter(c => c[0] === "search")).toHaveLength(1);
});
it("restores an interrupted opening and preserves old attempts on explicit regeneration", async () => {
  const pendingAnswer = deferred<any>();
  vi.mocked(meetingRequest).mockImplementation(async path => path === "packs" ? packs : path === "search" ? { ticket: "t", found: 1 } : pendingAnswer.promise);
  const quick = vi.fn().mockResolvedValue({ mode: "start", english: "First opening", russian: "Первое начало" });
  const view = render(<MeetingAssistant sessionId="session-one" selection={selection} quickStart={quick} />);
  await screen.findByText("First opening");
  const originalAttempt = snapshots.at(-1)!.attemptId;
  view.rerender(<MeetingAssistant sessionId="session-one" selection={null} quickStart={quick} />);
  await act(async () => pendingAnswer.resolve(meetingFallback));
  view.rerender(<MeetingAssistant sessionId="session-one" selection={selection} quickStart={quick} />);
  await screen.findByText("First opening");
  expect(screen.queryByText(meetingFallback.english)).not.toBeInTheDocument();
  expect(quick).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Новый вариант" }));
  await screen.findByText(meetingFallback.english);
  expect(quick).toHaveBeenCalledTimes(2);
  expect(new Set(snapshots.map(r => r.attemptId)).size).toBe(2);
  expect(snapshots.filter(r => r.attemptId === originalAttempt).every(r => !r.answer)).toBe(true);
});
it("isolates session and edited question caches", async () => {
  mockRoutes(); const quick = vi.fn().mockResolvedValue(null);
  const view = render(<MeetingAssistant sessionId="session-one" selection={selection} quickStart={quick} />);
  await screen.findByText(meetingFallback.english);
  view.rerender(<MeetingAssistant sessionId="session-two" selection={selection} quickStart={quick} />);
  await waitFor(() => expect(quick).toHaveBeenCalledTimes(2));
  await screen.findByText(meetingFallback.english);
  view.rerender(<MeetingAssistant sessionId="session-two" selection={{ ...selection, text: "Edited question?" }} quickStart={quick} />);
  await waitFor(() => expect(quick).toHaveBeenCalledTimes(3));
});
it("does not generate when history cannot be read", async () => {
  mockRoutes(); vi.mocked(meetingHistoryClient.load).mockRejectedValue(new Error("offline"));
  const quick = vi.fn();
  render(<MeetingAssistant sessionId="session-one" selection={selection} quickStart={quick} />);
  await screen.findByText(/Не удалось прочитать историю/);
  expect(quick).not.toHaveBeenCalled();
});

it("sends the same focused question to opening and retrieval, retaining raw input in the archive", async () => {
  mockRoutes(); const quick = vi.fn().mockResolvedValue(null);
  const text = "Хорошо объяснил прежнюю тему. А теперь следующий вопрос: How would you measure total effort?";
  const raw = { ...selection, text, context: [`Me: ${englishRealtimeTranscriptionPrompt}`, "Me: We discussed review time."] };
  render(<MeetingAssistant sessionId="session-one" selection={raw} quickStart={quick} />);
  await screen.findByText(meetingFallback.english);
  expect(quick).toHaveBeenCalledWith("How would you measure total effort?", ["Me: We discussed review time."], "Heard", expect.any(AbortSignal));
  expect(meetingRequest).toHaveBeenCalledWith("search", { packId: "a", transcript: "How would you measure total effort?", recentContext: ["Me: We discussed review time."] }, expect.any(AbortSignal));
  expect(snapshots.at(-1)!.identity.text).toBe(text);
  expect(snapshots.at(-1)!.identity.context).toEqual(raw.context);
  expect(snapshots.at(-1)!.generationInput).toEqual({ version: 1, transcript: "How would you measure total effort?", recentContext: ["Me: We discussed review time."] });
});
it("does not send a prompt-only selected turn to either generator", async () => {
  mockRoutes(); const quick = vi.fn();
  render(<MeetingAssistant sessionId="session-one" selection={{ ...selection, text: englishRealtimeTranscriptionPrompt }} quickStart={quick} />);
  await screen.findByText(/Это служебный текст распознавания/);
  expect(quick).not.toHaveBeenCalled();
  expect(vi.mocked(meetingRequest).mock.calls.some(c => c[0] === "search")).toBe(false);
  expect(snapshots).toEqual([]);
});
it("restores legacy snapshots unchanged until explicit regeneration", async () => {
  mockRoutes(); const quick = vi.fn().mockResolvedValue(null);
  const view = render(<MeetingAssistant sessionId="session-one" selection={selection} quickStart={quick} />);
  await screen.findByText(meetingFallback.english);
  view.unmount();
  snapshots = snapshots.map(({ generationInput: _ignored, ...legacy }) => legacy);
  const old = structuredClone(snapshots);
  quick.mockClear();
  render(<MeetingAssistant sessionId="session-one" selection={selection} quickStart={quick} />);
  await screen.findByText(/До фильтрации входа/);
  expect(quick).not.toHaveBeenCalled();
  expect(snapshots).toEqual(old);
  fireEvent.click(screen.getByRole("button", { name: "Новый вариант" }));
  await waitFor(() => expect(quick).toHaveBeenCalledTimes(1));
  await screen.findByText(meetingFallback.english);
  expect(snapshots.slice(0, old.length)).toEqual(old);
  expect(snapshots.at(-1)!.generationInput?.version).toBe(1);
});
