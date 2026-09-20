import type { GenerationInput } from "../realtime/generationInput";
import { isQuickStart, type QuickStart } from "../realtime/quickStart";
import type { MeetingAnswer } from "./types";

export type MeetingCardIdentity = {
  sessionId: string; phraseId: string; text: string; speaker: string; context: string[];
  packId: string;
};
export type MeetingCardSnapshot = {
  version: 1; identity: MeetingCardIdentity; attemptId: string; sequence: number;
  generationInput?: GenerationInput;
  savedAt: string; packName: string; packCreatedAt: string;
  opening: QuickStart | null; answer: MeetingAnswer | null;
  phase: "started" | "opening" | "complete" | "error";
  progress: string; timings: { openingMs?: number; answerMs?: number };
};
export function meetingCardKey(i: MeetingCardIdentity): string {
  return JSON.stringify([i.sessionId, i.phraseId, i.text, i.speaker, i.context, i.packId]);
}
const string = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
export function isMeetingCardSnapshot(value: unknown): value is MeetingCardSnapshot {
  if (!value || typeof value !== "object") return false;
  const r = value as MeetingCardSnapshot; const i = r.identity;
  if (r.version !== 1 || !i || !string(i.sessionId, 200) || !i.sessionId || !string(i.phraseId, 200) || !i.phraseId ||
    !string(i.packId, 200) || !i.packId || !string(i.text, 4000) || !string(i.speaker, 100) ||
    !Array.isArray(i.context) || i.context.length > 8 || !i.context.every(s => string(s, 2000)) ||
    !string(r.attemptId, 200) || !r.attemptId || !Number.isInteger(r.sequence) || r.sequence < 0 || r.sequence > 10 ||
    !string(r.savedAt, 100) || !Number.isFinite(Date.parse(r.savedAt)) || !string(r.packName, 120) || !string(r.packCreatedAt, 100) ||
    !["started", "opening", "complete", "error"].includes(r.phase) || !string(r.progress, 500) ||
    (r.opening !== null && !isQuickStart(r.opening)) || !r.timings ||
    Object.values(r.timings).some(n => typeof n !== "number" || !Number.isFinite(n) || n < 0)) return false;
  if (r.generationInput !== undefined && (!r.generationInput || r.generationInput.version !== 1 ||
    !string(r.generationInput.transcript, 4000) || !Array.isArray(r.generationInput.recentContext) ||
    r.generationInput.recentContext.length > 8 || !r.generationInput.recentContext.every(t => string(t, 2000)))) return false;
  const a = r.answer;
  if (a !== null && (!a || !["grounded", "no_answer", "conflict"].includes(a.status) || !string(a.english, 2000) || !string(a.russian, 3000) ||
    !Array.isArray(a.sources) || a.sources.length > 160 || a.sources.some(s => !s || !string(s.id, 200) || !string(s.filename, 300) ||
      !string(s.heading, 1000) || !string(s.text, 100000) || !s.metadata || typeof s.metadata !== "object" ||
      Object.entries(s.metadata).some(([k,v]) => !string(k, 200) || !string(v, 2000))))) return false;
  return JSON.stringify(r).length <= 1500000;
}

// Retry arrival order must not make an older attempt the current answer.
export function latestMeetingCard(records: MeetingCardSnapshot[]): MeetingCardSnapshot | undefined {
  const attempts = new Map<string, { started: number; latest: MeetingCardSnapshot }>();
  for (const record of records) {
    const previous = attempts.get(record.attemptId);
    attempts.set(record.attemptId, {
      started: Math.min(previous?.started ?? Infinity, Date.parse(record.savedAt)),
      latest: previous && previous.latest.sequence > record.sequence ? previous.latest : record
    });
  }
  return [...attempts.values()].sort((a, b) => a.started - b.started).at(-1)?.latest;
}
