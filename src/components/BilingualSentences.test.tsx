import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BilingualSentences } from "./BilingualSentences";

describe("bilingual sentence display", () => {
  it("places each translation immediately after its English sentence", () => {
    const { container } = render(<BilingualSentences
      english="I'd start small. Then we'd check the result."
      russian="Я бы начал с малого. Затем мы бы проверили результат." />);
    expect(Array.from(container.querySelectorAll("p"), p => [p.lang, p.textContent])).toEqual([
      ["en", "I'd start small."], ["ru", "Я бы начал с малого."],
      ["en", "Then we'd check the result."], ["ru", "Затем мы бы проверили результат."]
    ]);
  });
  it("does not mistake decimal points for sentence boundaries", () => {
    const { container } = render(<BilingualSentences
      english="It takes 2.5 hours. Is that okay?" russian="Это занимает 2,5 часа. Это подходит?" />);
    expect(container.querySelectorAll(".bilingual-sentence-pair")).toHaveLength(2);
    expect(container.querySelector("p")?.textContent).toBe("It takes 2.5 hours.");
  });
  it("preserves unmatched old translations as a block instead of pairing them incorrectly", () => {
    const { container } = render(<BilingualSentences
      english="We could start small. Then test it." russian="Мы могли бы начать с малого, а затем проверить результат." />);
    expect(container.querySelectorAll(".bilingual-sentence-pair")).toHaveLength(1);
    expect(container.querySelector('[lang="en"]')?.textContent).toBe("We could start small. Then test it.");
    expect(container.querySelector('[lang="ru"]')?.textContent).toBe("Мы могли бы начать с малого, а затем проверить результат.");
  });
});
