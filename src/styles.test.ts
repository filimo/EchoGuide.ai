// @vitest-environment node

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync("src/styles.css", "utf8");

describe("Training Mode layout styles", () => {
  it("keeps transcript and reply controls available while long panels scroll", () => {
    expect(styles).toMatch(/\.transcript-dialogue\s*\{[^}]*max-height:/s);
    expect(styles).toMatch(/\.transcript-dialogue\s*\{[^}]*overflow-y:\s*auto/s);
    expect(styles).not.toMatch(
      /@media\s*\(max-width:\s*860px\)[\s\S]*?\.suggestions-panel-sticky\s*\{[^}]*position:\s*static/s
    );
    expect(styles).not.toMatch(
      /@media\s*\(max-width:\s*860px\)[\s\S]*?\.copilot-grid[\s\S]*?grid-template-columns:\s*1fr/s
    );
    expect(styles).toMatch(
      /@media\s*\(max-width:\s*700px\)[\s\S]*?\.copilot-grid\s*\{[^}]*grid-template-columns:\s*1fr/s
    );
  });

  it("keeps compact transcript actions on one line", () => {
    expect(styles).toMatch(/\.transcript-panel-actions,[\s\S]*?flex-wrap:\s*nowrap/s);
    expect(styles).toMatch(/\.transcript-action-icon\s*\{[^}]*width:\s*42px/s);
  });

  it("keeps transcript roles and text in compact single rows", () => {
    expect(styles).toMatch(/\.transcript-dialogue\s*\{[^}]*gap:\s*4px/s);
    expect(styles).toMatch(
      /\.transcript-turn\s*\{[^}]*grid-template-columns:\s*30px minmax\(0, 1fr\)[^}]*padding:\s*4px 8px/s
    );
    expect(styles).toMatch(/\.transcript-turn-content\s*\{[^}]*min-height:\s*0/s);
    expect(styles).toMatch(/\.transcript-speaker-control\s*\{[^}]*min-height:\s*0/s);
  });

  it("keeps the suggestions card compact inside a landscape tablet viewport", () => {
    expect(styles).toMatch(/\.reply-full p\s*\{[^}]*margin:\s*0/s);
    expect(styles).toMatch(
      /@media\s*\(min-width:\s*701px\)\s*and\s*\(max-height:\s*900px\)[\s\S]*?\.suggestions-panel-sticky\s*\{[^}]*height:\s*calc\(100dvh - 118px\)[^}]*max-height:\s*calc\(100dvh - 118px\)/s
    );
    expect(styles).toMatch(
      /@media\s*\(min-width:\s*701px\)\s*and\s*\(max-height:\s*900px\)[\s\S]*?\.suggestions-panel-sticky \.bilingual-card\s*\{[^}]*gap:\s*10px/s
    );
  });
});
