import { describe, expect, it } from "vitest";
import { removeRepeatedOpening } from "./continuation";
import type { QuickStart } from "../realtime/quickStart";

const opening: QuickStart = { mode: "start", english: "We have no measured savings yet.", russian: "Измеренной экономии у нас пока нет." };
describe("bilingual meeting continuation", () => {
  it("removes repeated complete opening prefixes with harmless case and spacing differences", () => {
    expect(removeRepeatedOpening({ english: "we have no measured savings yet! We need a comparison.",
      russian: "Измеренной экономии у нас пока нет. Нам нужно сравнение." }, opening))
      .toEqual({ english: "We need a comparison.", russian: "Нам нужно сравнение." });
  });
  it("preserves negation changes, paraphrases and unmatched translations", () => {
    for (const english of ["We have measured savings now. We need a comparison.",
      "We do not have measured savings yet. We need a comparison.", "We have no measured savings yet, but expect some soon."]) {
      const answer = { english, russian: `${opening.russian} Нам нужно сравнение.` };
      expect(removeRepeatedOpening(answer, opening)).toEqual(answer);
    }
    const answer = { english: `${opening.english} We need a comparison.`, russian: "Нам нужно сравнение." };
    expect(removeRepeatedOpening(answer, opening)).toEqual(answer);
  });
  it("keeps standalone answers and never produces empty text", () => {
    const answer = { english: opening.english, russian: opening.russian };
    expect(removeRepeatedOpening(answer, opening)).toEqual(answer);
    expect(removeRepeatedOpening(answer)).toEqual(answer);
  });
});
