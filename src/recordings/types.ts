export type Recording = {
  id: string;
  sessionId: string;
  startedAt: string;
  updatedAt: string;
  status: "recording" | "saved" | "interrupted" | "error";
  format: "wav" | "webm" | "mp4";
  bytes: number;
  durationMs: number;
  sequence: number;
};

export const recordingHeaders = { "X-EchoGuide-Recording": "1" };
export const maxRecordingBytes = 1024 * 1024 * 1024;
export const maxRecordingDurationMs = 4 * 60 * 60 * 1000;
