import type { SessionHistoryTranscriptTurn } from "../domain/sessionHistory";
import { withoutTranscriptionPrompt } from "../realtime/generationInput";

export const meetingContextWindowMs = 10 * 60 * 1000;
export const maxMeetingContextCharacters = 12000;
export const maxMeetingSummaryCharacters = 2400;

export function meetingContextBefore(turns: SessionHistoryTranscriptTurn[], activeId: string,
  summarizedIds: ReadonlySet<string> = new Set(), includeUnsummarized = true): string[] {
  const index = turns.findIndex(turn => turn.id === activeId);
  if (index < 0) return [];
  const activeTime = turns[index].capturedAt;
  const previous = turns.slice(0, index);
  // Older saved sessions have no capture times; retain their old seven-turn behavior.
  const legacyIds = new Set(previous.filter(turn => turn.capturedAt == null).slice(-7).map(turn => turn.id));
  const recent = activeTime == null ? previous.slice(-7) : previous.filter(turn =>
    legacyIds.has(turn.id) || (turn.capturedAt != null && turn.capturedAt <= activeTime &&
      ((includeUnsummarized && !summarizedIds.has(turn.id)) || turn.capturedAt >= activeTime - meetingContextWindowMs))
  );
  const lines = recent.map(turn => {
    const text = withoutTranscriptionPrompt(turn.text).slice(0, 1800);
    return text ? `${turn.speakerLabel}: ${text}` : "";
  }).filter(Boolean);
  while (lines.length > 1 && (lines.length > 120 || lines.join("\n").length > maxMeetingContextCharacters)) lines.shift();
  if (lines.join("\n").length > maxMeetingContextCharacters) return [lines[0].slice(-maxMeetingContextCharacters)];
  return lines;
}

export function expiredMeetingTurns(turns: SessionHistoryTranscriptTurn[], now: number): SessionHistoryTranscriptTurn[] {
  return turns.filter(turn => turn.capturedAt != null && turn.capturedAt < now - meetingContextWindowMs &&
    withoutTranscriptionPrompt(turn.text).length > 0);
}
