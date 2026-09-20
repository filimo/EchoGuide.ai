import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MeetingAssistant } from "./MeetingAssistant";
import { meetingRequest } from "../meeting/client";
import { meetingFallback } from "../meeting/types";
vi.mock("../meeting/client", () => ({ meetingRequest: vi.fn() }));
afterEach(() => vi.clearAllMocks());
const packs = { activePackId: "a", packs: [{ id: "a", name: "Current", status: "ready", createdAt: "2026-09-19", filenames: ["notes.md"], sectionCount: 1 }] };
const selection = { id: "one", text: "What is the plan?", speaker: "Heard", context: ["Heard: Let's discuss the pilot."] };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function mockRoutes() {
  vi.mocked(meetingRequest).mockImplementation(async path => path === "packs" ? packs : path === "search" ? { ticket: "t", found: 1 } : meetingFallback);
}
describe("manual meeting assistance", () => {
  it("waits for selection and does not regenerate the same selected phrase", async () => {
    mockRoutes(); const quick = vi.fn().mockResolvedValue({ mode: "start", english: "Opening", russian: "Начало" });
    const { rerender } = render(<MeetingAssistant selection={null} quickStart={quick} />);
    await waitFor(() => expect(meetingRequest).toHaveBeenCalled());
    expect(quick).not.toHaveBeenCalled();
    rerender(<MeetingAssistant selection={selection} quickStart={quick} />);
    await screen.findByText(meetingFallback.english);
    const opening = screen.getByText("Opening");
    rerender(<MeetingAssistant selection={{ ...selection }} quickStart={quick} />);
    expect(quick).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Opening")).toBe(opening);
    expect(quick).toHaveBeenCalledWith(selection.text, selection.context, "Heard", expect.any(AbortSignal));
  });
  it("starts retrieval in parallel and appends the answer without replacing the opening", async () => {
    const first = deferred<any>(); const answer = deferred<any>();
    vi.mocked(meetingRequest).mockImplementation(async path => path === "packs" ? packs : path === "search" ? { ticket: "t", found: 1 } : answer.promise);
    render(<MeetingAssistant selection={selection} quickStart={() => first.promise} />);
    await waitFor(() => expect(meetingRequest).toHaveBeenCalledWith("search", expect.anything(), expect.any(AbortSignal)));
    await act(async () => first.resolve({ mode: "start", english: "Opening", russian: "Начало" }));
    const opening = screen.getByText("Opening");
    await act(async () => answer.resolve(meetingFallback));
    expect(screen.getByText("Opening")).toBe(opening);
    expect(screen.getByText(meetingFallback.english)).toBeInTheDocument();
  });
  it("lets evidence answer when the fast opening asks for clarification", async () => {
    const grounded = { status: "grounded", english: "I test ideas on real tasks.", russian: "Я проверяю идеи на реальных задачах.", sources: [] };
    vi.mocked(meetingRequest).mockImplementation(async path => path === "packs" ? packs : path === "search" ? { ticket: "t", found: 1 } : grounded);
    render(<MeetingAssistant selection={selection} quickStart={async () => ({ mode: "clarify", english: "Which role?", russian: "Какая роль?" })} />);
    await screen.findByText(grounded.english);
    expect(screen.queryByText("Which role?")).not.toBeInTheDocument();
    expect(screen.getByText("Ответ")).toBeInTheDocument();
    expect(meetingRequest).toHaveBeenCalledWith("answer", { packId: "a", ticket: "t" }, expect.any(AbortSignal));
  });
  it("honors explicit selection even when the opening model chooses wait", async () => {
    mockRoutes(); const quick = vi.fn().mockResolvedValue({ mode: "wait", english: "", russian: "" });
    render(<MeetingAssistant selection={{ ...selection, speaker: "Me" }} quickStart={quick} />);
    await screen.findByText(meetingFallback.english);
    expect(screen.queryByText("Начни так")).not.toBeInTheDocument();
  });
  it("ignores late results after selecting another phrase", async () => {
    const old = deferred<any>();
    vi.mocked(meetingRequest).mockImplementation(async (path, body: any) => path === "packs" ? packs : path === "search" ?
      (body.transcript === selection.text ? old.promise : { ticket: "new", found: 1 }) : meetingFallback);
    const quick = vi.fn().mockResolvedValue(null);
    const { rerender } = render(<MeetingAssistant selection={selection} quickStart={quick} />);
    await waitFor(() => expect(quick).toHaveBeenCalledTimes(1));
    rerender(<MeetingAssistant selection={{ ...selection, id: "two", text: "Who owns it?" }} quickStart={quick} />);
    await screen.findByText(meetingFallback.english);
    await act(async () => old.resolve({ ticket: "old", found: 1 }));
    expect(vi.mocked(meetingRequest).mock.calls.filter(c => c[0] === "answer")).toHaveLength(1);
    expect(screen.getByText("Who owns it?")).toBeInTheDocument();
  });
});
