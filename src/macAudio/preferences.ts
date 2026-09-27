export type AudioMode = "microphone" | "mac";
export type MacAudioPreference = {
  application: { bundleId: string; name: string } | null;
  microphone: string;
};
const modeKey = "echoguide.audioMode.v1";
const sourcesKey = "echoguide.macAudio.v1";
export function loadAudioMode(fallback: AudioMode): AudioMode {
  try {
    const value = localStorage.getItem(modeKey);
    return value === "mac" || value === "microphone" ? value : fallback;
  } catch { return fallback; }
}
export function saveAudioMode(value: AudioMode) {
  try { localStorage.setItem(modeKey, value); } catch { /* Storage is optional. */ }
}
export function loadMacAudioPreference(): MacAudioPreference {
  const fallback = { application: null, microphone: "default" };
  try {
    const value = JSON.parse(localStorage.getItem(sourcesKey) ?? "null");
    if (!value || typeof value !== "object") return fallback;
    return {
      application: typeof value.application?.bundleId === "string" && value.application.bundleId.trim()
        && typeof value.application.name === "string" ? value.application : null,
      microphone: typeof value.microphone === "string" && value.microphone ? value.microphone : "default"
    };
  } catch { return fallback; }
}
export function saveMacAudioPreference(value: MacAudioPreference) {
  try { localStorage.setItem(sourcesKey, JSON.stringify(value)); } catch { /* Storage is optional. */ }
}
