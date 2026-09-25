export type MeetingDocument = { name: string; text: string };
export type MeetingSection = {
  id: string; filename: string; heading: string; text: string;
  metadata: Record<string, string>;
};
export type MeetingPack = {
  id: string; name: string; createdAt: string;
  status: "uploading" | "indexing" | "ready" | "failed";
  filenames: string[]; sectionCount: number; error?: string;
};
export type MeetingPackState = { packs: MeetingPack[]; activePackId: string | null };
export type MeetingEvidence = {
  id: string; filename: string; heading: string; text: string;
  metadata: Record<string, string>;
};
export type MeetingAnswer = {
  status: "grounded" | "no_answer" | "conflict";
  english: string; russian: string; sources: MeetingEvidence[];
  diagnostics?: { reason: MeetingAnswerReason; found?: number };
};
export type MeetingAnswerReason = "grounded" | "no_hits" | "model_no_answer" | "conflict" | "invalid_answer" | "search_error" | "answer_error";
export const meetingFallback: MeetingAnswer = {
  status: "no_answer",
  english: "I need to check that before giving a firm answer.",
  russian: "Мне нужно это проверить, прежде чем отвечать уверенно.",
  sources: []
};
export function meetingFallbackFor(reason: Exclude<MeetingAnswerReason, "grounded">, found?: number): MeetingAnswer {
  return { ...meetingFallback, status: reason === "conflict" ? "conflict" : "no_answer",
    diagnostics: { reason, ...(found === undefined ? {} : { found }) } };
}
