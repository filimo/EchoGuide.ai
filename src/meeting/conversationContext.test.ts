import { describe, expect, it } from "vitest";
import { expiredMeetingTurns, meetingContextBefore, meetingContextWindowMs } from "./conversationContext";

const base = 1_000_000;
const turn = (id: string, offset: number, text = id) => ({ id, text, speakerLabel: "Interviewer" as const,
  capturedAt: base + offset });

describe("meeting conversation context", () => {
  it("uses twenty minutes of timed turns and retains older turns until summarized", () => {
    const turns = [turn("old", 0), turn("middle", 2 * 60_000), turn("recent", 21 * 60_000), turn("active", 22 * 60_000)];
    expect(expiredMeetingTurns(turns, turns[3].capturedAt).map(t => t.id)).toEqual(["old"]);
    expect(meetingContextBefore(turns, "active", new Set(["old"]))).toEqual([
      "Interviewer: middle", "Interviewer: recent"
    ]);
    expect(meetingContextBefore(turns, "active")).toContain("Interviewer: old");
    expect(meetingContextWindowMs).toBe(1_200_000);
  });

  it("never includes future turns when an older transcript turn is selected", () => {
    const turns = [turn("before", 0), turn("selected", 60_000), turn("future", 12 * 60_000)];
    expect(meetingContextBefore(turns, "selected", new Set(), false)).toEqual(["Interviewer: before"]);
  });

  it("keeps the previous seven turns for legacy sessions without capture times", () => {
    const turns = Array.from({ length: 10 }, (_, i) => ({ id: String(i), text: String(i), speakerLabel: "Me" as const }));
    expect(meetingContextBefore(turns, "9")).toHaveLength(7);
  });

  it("bounds a rapid exchange to the server's turn limit", () => {
    const turns = Array.from({ length: 300 }, (_, i) => turn(String(i), i * 1000));
    expect(meetingContextBefore(turns, "299")).toHaveLength(240);
  });
});
