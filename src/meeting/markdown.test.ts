import { describe, expect, it } from "vitest";
import { prepareSections, validateDocuments } from "./markdown";

describe("meeting Markdown", () => {
  it("keeps dates and section qualifications with the correct person", () => {
    const sections = prepareSections([{ name: "people.md", text: "# Team\nПроект: Atlas\nАктуально на: 2026-09-18\n\n## Евгений QA\nТип: предложение\nПилот не выбран.\n\n## Евгений DevOps\nСтатус: неизвестно\nВладелец не назначен." }], "pack-a", "2026-09-19");
    expect(sections[1]).toMatchObject({ heading: "Team / Евгений QA", metadata: { project: "Atlas", type: "предложение", as_of: "2026-09-18", pack_id: "pack-a" } });
    expect(sections[2].metadata.type).toBeUndefined();
    expect(sections[2].metadata.status).toBe("неизвестно");
    expect(sections[1].text).toContain("Пилот не выбран");
  });
  it("does not treat headings inside code fences as sections", () => {
    const sections = prepareSections([{ name: "example.md", text: "# Example\n```md\n# not a section\n```\nText" }], "a", "today");
    expect(sections).toHaveLength(1);
    expect(sections[0].text).toContain("# not a section");
  });
  it("rejects empty, duplicate, non-MD, path and excessive uploads", () => {
    for (const docs of [[], [{ name: "x.txt", text: "hi" }], [{ name: "../x.md", text: "hi" }], [{ name: "x.md", text: " " }],
      [{ name: "x.md", text: "a" }, { name: "X.MD", text: "b" }], [{ name: "x.md", text: "x".repeat(2100000) }]]) {
      expect(() => validateDocuments(docs)).toThrow();
    }
  });
  it("bounds long sections without dropping text", () => {
    const text = "abcdefghij".repeat(1200);
    const sections = prepareSections([{ name: "long.md", text }], "p", "today");
    expect(sections.map(s => s.text)).toEqual([text.slice(0,5500), text.slice(5000,10500), text.slice(10000)]);
  });
});

it("does not promote the first subsection status to its siblings", () => {
  const sections = prepareSections([{name: "facts.md", text: "# Facts\n## Proposal\nСтатус: предложение\nCandidate.\n## Decision\nUnknown."}], "p", "today");
  expect(sections[0].metadata.status).toBe("предложение");
  expect(sections[1].metadata.status).toBeUndefined();
});
