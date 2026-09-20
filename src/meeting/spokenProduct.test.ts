import { describe, expect, it } from "vitest";
import { spokenProductQuestion } from "./spokenProduct";
import type { MeetingEvidence } from "./types";
const evidence: MeetingEvidence[] = [{ id: "s1", filename: "sample.md", heading: "Status", metadata: {}, text: "Maria tried Codex on a sample script." }];
describe("evidence-bounded spoken product interpretation", () => {
  it("proposes Codex only when the retrieved evidence names it", () => {
    expect(spokenProductQuestion("What did Maria confirm about codecs usage?", evidence)).toBe("What did Maria confirm about Codex usage?");
    expect(spokenProductQuestion("What did Maria confirm about codecs usage?", [])).toBeNull();
    expect(spokenProductQuestion("What did Maria confirm about Codex usage?", evidence)).toBeNull();
  });
  it("preserves explicit codec topics and competing evidence", () => {
    for (const topic of ["video", "audio", "compression", "encoding", "H.264", "AV1", "Opus"]) {
      expect(spokenProductQuestion(`Which codecs support ${topic}?`, evidence)).toBeNull();
    }
    expect(spokenProductQuestion("What about codecs?", [...evidence, { ...evidence[0], text: "Мария проверяла видеокодеки." }])).toBeNull();
  });
});
