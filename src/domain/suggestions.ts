import type { SuggestedReply } from "./session";

type BuildSuggestedRepliesInput = {
  notes: string;
  latestOtherText: string;
};

function firstMeaningfulNote(notes: string): string {
  return (
    notes
      .split(/\n+/)
      .map((line) => line.trim())
      .map((line) => line.replace(/^mention\s+/i, ""))
      .map((line) => line.replace(/[.!?]+$/, ""))
      .find((line) => line.length > 0) ?? "the current call context"
  );
}

function isAmbiguous(text: string): boolean {
  return /\bit\b|\bthis\b|\bthat\b|\bdo it\b/i.test(text);
}

export function buildSuggestedReplies(input: BuildSuggestedRepliesInput): SuggestedReply[] {
  const note = firstMeaningfulNote(input.notes);
  const ambiguous = isAmbiguous(input.latestOtherText);
  const checkSentence = /\bbefore\b/i.test(note)
    ? `I need to check ${note}.`
    : `I need to check ${note} first.`;

  return [
    {
      id: "clarify-scope",
      shortText: "Уточнить scope",
      fullSentence: checkSentence,
      uncertainty: ambiguous
        ? {
            level: "medium",
            reason: "The phrase may be ambiguous in room audio from the MacBook speakers.",
            alternative: "Ask which exact action or deadline they mean."
          }
        : { level: "low" }
    },
    {
      id: "conditional-yes",
      shortText: "Условно согласиться",
      fullSentence: "Yes, if the scope does not change.",
      uncertainty: { level: "low" }
    },
    {
      id: "ask-for-time",
      shortText: "Попросить время",
      fullSentence: "Please give me time to check it.",
      uncertainty: { level: "none" }
    }
  ];
}
