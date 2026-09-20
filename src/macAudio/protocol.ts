export type MacAudioSource = "microphone" | "application";
export type MacAudioSources = {
  applications: { pid: number; name: string; bundleId: string }[];
  microphones: { id: string; name: string }[];
};
export type MacAudioEvent =
  | { type: "ready" }
  | { type: "error"; message: string }
  | { type: "level"; source: MacAudioSource; level: number; chunks: number }
  | { type: "realtime"; source: MacAudioSource; capturedAt?: number; event: { type: string; [key: string]: unknown } };

export const macAudioHeaders = { "Content-Type": "application/json", "X-EchoGuide-Mac-Audio": "1" };

export function isMacAudioSource(value: unknown): value is MacAudioSource {
  return value === "microphone" || value === "application";
}

export function sourceSpeaker(source: MacAudioSource) {
  return source === "microphone" ? "Me" as const : "Interviewer" as const;
}
