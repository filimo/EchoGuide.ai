import { describe, expect, it } from "vitest";
import { buildSuggestedReplies } from "./suggestions";

describe("buildSuggestedReplies", () => {
  it("returns short options with full sentence expansions", () => {
    const replies = buildSuggestedReplies({
      notes: "Mention dependency review before promising dates.",
      latestOtherText: "Can you commit by Friday?"
    });

    expect(replies).toHaveLength(3);
    expect(replies[0].shortText.length).toBeLessThanOrEqual(40);
    expect(replies[0].fullSentence).toBe("I need to check dependency review before promising dates.");
  });

  it("marks acoustically ambiguous phrases with soft uncertainty", () => {
    const replies = buildSuggestedReplies({
      notes: "",
      latestOtherText: "Can you do it?"
    });

    expect(replies.some((reply) => reply.uncertainty.level === "medium")).toBe(true);
  });

  it("does not duplicate punctuation from pasted notes", () => {
    const replies = buildSuggestedReplies({
      notes: "Mention dependency review.",
      latestOtherText: "Can you commit by Friday?"
    });

    expect(replies[0].fullSentence).toBe(
      "I need to check dependency review first."
    );
  });
});
