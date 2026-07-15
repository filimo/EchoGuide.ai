const wavHeaderBytes = 44;
const pcmBytesPerSample = 2;

type PcmChunk = {
  samples: Float32Array;
  sampleRate: number;
};

export type RollingPcmAudioBuffer = {
  append: (samples: Float32Array, sampleRate: number) => void;
  clear: () => void;
  getDurationSeconds: () => number;
  toWavBlob: (seconds?: number) => Blob | null;
};

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

export function encodeMonoPcm16Wav(samples: Float32Array, sampleRate: number): Uint8Array {
  const bytes = new Uint8Array(wavHeaderBytes + samples.length * pcmBytesPerSample);
  const view = new DataView(bytes.buffer);
  const dataBytes = samples.length * pcmBytesPerSample;

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * pcmBytesPerSample, true);
  view.setUint16(32, pcmBytesPerSample, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);

  samples.forEach((sample, index) => {
    const clamped = Math.max(-1, Math.min(1, sample));
    const pcmValue = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    view.setInt16(wavHeaderBytes + index * pcmBytesPerSample, Math.round(pcmValue), true);
  });

  return bytes;
}

export function createRollingPcmAudioBuffer(maxSeconds = 60): RollingPcmAudioBuffer {
  const chunks: PcmChunk[] = [];
  let totalSamples = 0;
  let activeSampleRate = 0;

  function clear() {
    chunks.length = 0;
    totalSamples = 0;
    activeSampleRate = 0;
  }

  function append(samples: Float32Array, sampleRate: number) {
    if (samples.length === 0 || !Number.isFinite(sampleRate) || sampleRate <= 0) {
      return;
    }

    if (activeSampleRate !== 0 && activeSampleRate !== sampleRate) {
      clear();
    }

    activeSampleRate = sampleRate;
    chunks.push({ samples: samples.slice(), sampleRate });
    totalSamples += samples.length;

    const maxSamples = Math.max(1, Math.floor(maxSeconds * sampleRate));

    while (chunks.length > 0 && totalSamples - chunks[0].samples.length >= maxSamples) {
      totalSamples -= chunks.shift()!.samples.length;
    }

    const overflowSamples = totalSamples - maxSamples;
    const firstChunk = chunks[0];

    if (overflowSamples > 0 && firstChunk != null) {
      firstChunk.samples = firstChunk.samples.slice(overflowSamples);
      totalSamples -= overflowSamples;
    }
  }

  function getDurationSeconds() {
    return activeSampleRate > 0 ? totalSamples / activeSampleRate : 0;
  }

  function toWavBlob(seconds = maxSeconds) {
    if (totalSamples === 0 || activeSampleRate === 0) {
      return null;
    }

    const requestedSamples = Math.max(1, Math.floor(seconds * activeSampleRate));
    const sampleCount = Math.min(totalSamples, requestedSamples);
    const combined = new Float32Array(sampleCount);
    let writeOffset = sampleCount;

    for (let index = chunks.length - 1; index >= 0 && writeOffset > 0; index -= 1) {
      const chunk = chunks[index].samples;
      const samplesToCopy = Math.min(writeOffset, chunk.length);
      const sourceOffset = chunk.length - samplesToCopy;
      writeOffset -= samplesToCopy;
      combined.set(chunk.subarray(sourceOffset), writeOffset);
    }

    const wavBytes = encodeMonoPcm16Wav(combined, activeSampleRate);
    const wavBuffer = new ArrayBuffer(wavBytes.byteLength);
    new Uint8Array(wavBuffer).set(wavBytes);

    return new Blob([wavBuffer], { type: "audio/wav" });
  }

  return {
    append,
    clear,
    getDurationSeconds,
    toWavBlob
  };
}
