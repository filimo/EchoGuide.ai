export type LevelZone = "silent" | "quiet" | "good" | "loud" | "clipping";

export function levelDbfs(amplitude: number): number {
  return amplitude > 0 ? Math.max(-60, 20 * Math.log10(amplitude)) : -60;
}

export function levelMeter(rms: number, peak: number) {
  const dbfs = levelDbfs(rms);
  const peakDbfs = levelDbfs(peak);
  const percent = Math.min(100, Math.max(0, (dbfs + 60) / 60 * 100));
  const zone: LevelZone = rms < 0.0001 ? "silent"
    : peakDbfs >= -1 ? "clipping"
    : dbfs < -40 ? "quiet"
    : dbfs < -18 ? "good"
    : "loud";
  return { dbfs, peakDbfs, percent, zone };
}
