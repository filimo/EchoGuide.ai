import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MeetingAssistant } from "./MeetingAssistant";
import { meetingRequest } from "../meeting/client";
import { meetingFallback } from "../meeting/types";
vi.mock("../meeting/client", () => ({ meetingRequest: vi.fn() }));
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
const packs = { activePackId: "a", packs: [{ id: "a", name: "Current", status: "ready", createdAt: "2026-09-19", filenames: ["notes.md"], sectionCount: 1 }] };
const turn = { id: "one", text: "What is the plan?", speakerLabel: "Interviewer" as const };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function mockRoutes(answer = { ...meetingFallback }) {
  vi.mocked(meetingRequest).mockImplementation(async (path) => {
    if (path === "packs") return packs;
    if (path === "search") return { ticket: "t", found: 1 };
    if (path === "answer") return answer;
    return packs;
  });
}
async function start() {
  await waitFor(() => expect(screen.getByLabelText("Вопросы ко мне")).not.toBeDisabled());
  fireEvent.click(screen.getByLabelText("Вопросы ко мне"));
}
describe("meeting assistance", () => {
  it("does not search until enabled, then uses the last question before the toggle", async () => {
    mockRoutes(); const quick = vi.fn().mockResolvedValue({ mode: "start", english: "Let me explain the plan.", russian: "Расскажу о плане." });
    render(<MeetingAssistant turns={[turn]} quickStart={quick} />);
    await waitFor(() => expect(screen.getByLabelText("Вопросы ко мне")).not.toBeDisabled());
    expect(quick).not.toHaveBeenCalled();
    await start();
    await waitFor(() => expect(screen.getByText(meetingFallback.english)).toBeInTheDocument(), { timeout: 2000 });
    expect(quick).toHaveBeenCalledWith(turn.text, [], "Interviewer", expect.any(AbortSignal));
    expect(screen.getByText("Let me explain the plan.")).toBeInTheDocument();
    expect(screen.getByText(meetingFallback.russian)).toBeInTheDocument();
  });
  it("starts search before the opening is ready and ignores late answers after disabling", async () => {
    mockRoutes(); const opening = deferred<any>(); const response = deferred<any>();
    vi.mocked(meetingRequest).mockImplementation(async path => path === "packs" ? packs : path === "search" ? { ticket: "t", found: 1 } : response.promise);
    const quick = vi.fn(() => opening.promise);
    render(<MeetingAssistant turns={[turn]} quickStart={quick} />); await start();
    await waitFor(() => expect(meetingRequest).toHaveBeenCalledWith("search", expect.anything(), expect.any(AbortSignal)), { timeout: 2000 });
    expect(screen.queryByText("Opening")).not.toBeInTheDocument();
    await act(async () => opening.resolve({ mode: "start", english: "Opening", russian: "Начало" }));
    expect(screen.getByText("Opening")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Вопросы ко мне"));
    await act(async () => response.resolve({ status: "grounded", english: "Stale answer", russian: "Старый ответ", sources: [] }));
    expect(screen.queryByText("Stale answer")).not.toBeInTheDocument();
  });
  it("does not generate an answer for wait or for the user's own speech", async () => {
    mockRoutes(); const quick = vi.fn().mockResolvedValue({ mode: "wait", english: "", russian: "" });
    const { rerender } = render(<MeetingAssistant turns={[turn]} quickStart={quick} />); await start();
    await waitFor(() => expect(screen.getByText("Пока ответ не требуется.")).toBeInTheDocument(), { timeout: 2000 });
    expect(vi.mocked(meetingRequest).mock.calls.some(c => c[0] === "answer")).toBe(false);
    rerender(<MeetingAssistant turns={[turn, { id: "two", text: "My answer", speakerLabel: "Me" }]} quickStart={quick} />);
    await new Promise(r => setTimeout(r, 800)); expect(quick).toHaveBeenCalledTimes(1);
  });
  it("keeps the latest question when an earlier search finishes late", async () => {
    mockRoutes(); const old = deferred<any>();
    vi.mocked(meetingRequest).mockImplementation(async (path, body: any) => {
      if (path === "packs") return packs;
      if (path === "search") return body.transcript === turn.text ? old.promise : { ticket: "new", found: 1 };
      return { status: "grounded", english: "Latest answer", russian: "Новый ответ", sources: [] };
    });
    const quick = vi.fn().mockResolvedValue({ mode: "start", english: "Opening", russian: "Начало" });
    const { rerender } = render(<MeetingAssistant turns={[turn]} quickStart={quick} />); await start();
    await waitFor(() => expect(quick).toHaveBeenCalledTimes(1), { timeout: 2000 });
    rerender(<MeetingAssistant turns={[turn, { ...turn, id: "two", text: "Who owns it?" }]} quickStart={quick} />);
    await waitFor(() => expect(screen.getByText("Latest answer")).toBeInTheDocument(), { timeout: 2000 });
    await act(async () => old.resolve({ ticket: "old", found: 1 }));
    expect(vi.mocked(meetingRequest).mock.calls.filter(c => c[0] === "answer")).toHaveLength(1);
    expect(screen.getByText("Who owns it?")).toBeInTheDocument();
  });
});
