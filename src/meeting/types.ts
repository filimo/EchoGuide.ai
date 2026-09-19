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
};
export const meetingFallback: MeetingAnswer = {
  status: "no_answer",
  english: "I need to check the details. Please carry on while I look into it. If I need more time, I'll follow up after the meeting.",
  russian: "Мне нужно проверить детали. Пока продолжайте обсуждение, а я посмотрю. Если потребуется больше времени, вернусь с ответом после встречи.",
  sources: []
};
