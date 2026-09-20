import type { MeetingEvidence } from "./types";

// A narrow, observed ASR confusion. Never rewrite the stored transcript.
export function spokenProductQuestion(transcript: string, evidence: MeetingEvidence[]): string | null {
  if (!/\bcodecs\b/i.test(transcript) || /\b(audio|video|compression|encoding|decoding|h\.?26[45]|av1|opus)\b/i.test(transcript)) return null;
  if (!evidence.some(section => /\bCodex\b/.test(section.text))) return null;
  // Real codec evidence makes the intended topic ambiguous.
  if (evidence.some(section => /\bcodecs?\b|кодек/iu.test(section.text))) return null;
  return transcript.replace(/\bcodecs\b/gi, "Codex");
}
