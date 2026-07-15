import { describe, expect, it } from "vitest";
import { createRollingPcmAudioBuffer, encodeMonoPcm16Wav } from "./rollingAudioBuffer";

describe("rolling PCM audio buffer", () => {
  it("encodes mono PCM samples as a valid WAV file", () => {
    const wav = encodeMonoPcm16Wav(new Float32Array([-1, 0, 1]), 16000);
    const view = new DataView(wav.buffer);
    const text = (start: number, length: number) =>
      String.fromCharCode(...wav.subarray(start, start + length));

    expect(text(0, 4)).toBe("RIFF");
    expect(text(8, 4)).toBe("WAVE");
    expect(text(36, 4)).toBe("data");
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint32(40, true)).toBe(6);
    expect(view.getInt16(44, true)).toBe(-32768);
    expect(view.getInt16(46, true)).toBe(0);
    expect(view.getInt16(48, true)).toBe(32767);
  });

  it("keeps only the configured amount of recent audio", () => {
    const buffer = createRollingPcmAudioBuffer(2);

    buffer.append(new Float32Array([0.1, 0.2]), 2);
    buffer.append(new Float32Array([0.3, 0.4, 0.5, 0.6]), 2);

    expect(buffer.getDurationSeconds()).toBe(2);
    const blob = buffer.toWavBlob();
    expect(blob).not.toBeNull();
    expect(blob?.type).toBe("audio/wav");
    expect(blob?.size).toBe(44 + 4 * 2);
  });

  it("can export a shorter tail and clear all retained audio", () => {
    const buffer = createRollingPcmAudioBuffer(10);
    buffer.append(new Float32Array([0.1, 0.2, 0.3, 0.4]), 2);

    expect(buffer.toWavBlob(1)?.size).toBe(44 + 2 * 2);

    buffer.clear();

    expect(buffer.getDurationSeconds()).toBe(0);
    expect(buffer.toWavBlob()).toBeNull();
  });
});
