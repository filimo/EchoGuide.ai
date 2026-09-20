import type { QuickStart } from "../realtime/quickStart";

type BilingualText = { english: string; russian: string };

function afterOpening(text: string, opening: string): string | null {
  const words = (value: string) => [...value.matchAll(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)];
  const prefix = words(opening);
  const answer = words(text);
  // Match complete word sequences, never fuzzy similarity that could erase negation.
  const normalize = (value: string) => value.toLowerCase().replaceAll("’", "'");
  if (prefix.length < 4 || answer.length <= prefix.length ||
      prefix.some((word, index) => normalize(word[0]) !== normalize(answer[index][0]))) return null;
  const last = answer[prefix.length - 1];
  const remainder = text.slice(last.index! + last[0].length);
  // Only remove a complete opening sentence, not the start of a different claim.
  if (!/^\s*[.!?…]/u.test(remainder)) return null;
  return remainder.replace(/^[\s.!?…]+/u, "").trim() || null;
}

export function removeRepeatedOpening(answer: BilingualText, opening?: QuickStart): BilingualText {
  if (!opening || !["start", "continue"].includes(opening.mode)) return answer;
  const english = afterOpening(answer.english, opening.english);
  const russian = afterOpening(answer.russian, opening.russian);
  // Keep translations aligned; never discard information based on one language alone.
  return english && russian ? { english, russian } : answer;
}

export function hasRepeatedOpening(answer: BilingualText, opening?: QuickStart): boolean {
  return !!opening && ["start", "continue"].includes(opening.mode) &&
    (afterOpening(answer.english, opening.english) !== null || afterOpening(answer.russian, opening.russian) !== null);
}
