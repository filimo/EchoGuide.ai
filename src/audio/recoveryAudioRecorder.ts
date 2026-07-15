import { createRollingPcmAudioBuffer } from "./rollingAudioBuffer";

export type RecoveryAudioCaptureState =
  | "idle"
  | "recording"
  | "needs-user-action"
  | "unavailable";

export type RecoveryAudioStats = {
  chunksObserved: number;
  silentChunks: number;
  dataChannelBufferedAmount: number;
  inputSampleRate: number;
  samplesInLastChunk: number;
  rms: number;
  peak: number;
};

export type RecoveryAudioRecorderDiagnostic = {
  type: string;
  details?: Record<string, boolean | number | string | null>;
};

export type RecoveryAudioRecorder = {
  ensureActive: () => Promise<RecoveryAudioCaptureState>;
  getState: () => RecoveryAudioCaptureState;
  getRecentAudio: (seconds?: number) => Blob | null;
  stop: () => void;
};

type AudioContextConstructor = new (options?: AudioContextOptions) => AudioContext;

type WindowWithWebkitAudio = Window &
  typeof globalThis & {
    webkitAudioContext?: AudioContextConstructor;
  };

export type CreateBrowserRecoveryAudioRecorderOptions = {
  stream: MediaStream;
  getDataChannelBufferedAmount?: () => number;
  onAudioStats?: (stats: RecoveryAudioStats) => void;
  onStateChange?: (state: RecoveryAudioCaptureState) => void;
  onDiagnosticEvent?: (event: RecoveryAudioRecorderDiagnostic) => void;
  audioContextFactory?: () => AudioContext;
};

function measurePcm(samples: Float32Array) {
  let peak = 0;
  let sumSquares = 0;

  samples.forEach((sample) => {
    const absolute = Math.abs(sample);
    peak = Math.max(peak, absolute);
    sumSquares += sample * sample;
  });

  return {
    peak,
    rms: samples.length > 0 ? Math.sqrt(sumSquares / samples.length) : 0
  };
}

function mapAudioContextState(state: string): RecoveryAudioCaptureState {
  if (state === "running") {
    return "recording";
  }

  if (state === "closed") {
    return "unavailable";
  }

  return "needs-user-action";
}

export function createBrowserRecoveryAudioRecorder({
  stream,
  getDataChannelBufferedAmount = () => 0,
  onAudioStats,
  onStateChange,
  onDiagnosticEvent,
  audioContextFactory
}: CreateBrowserRecoveryAudioRecorderOptions): RecoveryAudioRecorder {
  const AudioContextImpl =
    globalThis.AudioContext ?? (globalThis as WindowWithWebkitAudio).webkitAudioContext;

  if (audioContextFactory == null && AudioContextImpl == null) {
    throw new Error("Browser AudioContext is unavailable for recovery audio capture.");
  }

  const audioContext = audioContextFactory?.() ?? new AudioContextImpl!();
  const source = audioContext.createMediaStreamSource(stream);
  const processor = audioContext.createScriptProcessor(4096, 1, 1);
  const rollingAudio = createRollingPcmAudioBuffer(60);
  let chunksObserved = 0;
  let silentChunks = 0;
  let captureState: RecoveryAudioCaptureState = "idle";
  let stopped = false;

  function updateCaptureState() {
    const nextState = stopped
      ? "unavailable"
      : mapAudioContextState(String(audioContext.state));

    if (captureState !== nextState) {
      captureState = nextState;
      onStateChange?.(nextState);
    }

    onDiagnosticEvent?.({
      type: "audio_context.state",
      details: { state: String(audioContext.state), sampleRate: audioContext.sampleRate }
    });

    return captureState;
  }

  audioContext.addEventListener("statechange", updateCaptureState);
  updateCaptureState();

  processor.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0);
    const level = measurePcm(input);

    rollingAudio.append(input, audioContext.sampleRate);
    chunksObserved += 1;

    if (level.rms < 0.002 && level.peak < 0.01) {
      silentChunks += 1;
    }

    onAudioStats?.({
      chunksObserved,
      silentChunks,
      dataChannelBufferedAmount: getDataChannelBufferedAmount(),
      inputSampleRate: audioContext.sampleRate,
      samplesInLastChunk: input.length,
      rms: level.rms,
      peak: level.peak
    });
  };

  source.connect(processor);
  processor.connect(audioContext.destination);

  return {
    async ensureActive() {
      if (stopped) {
        return "unavailable";
      }

      if (String(audioContext.state) !== "running") {
        try {
          await audioContext.resume();
        } catch {
          // iPad WebKit can reject resume outside a direct user gesture.
        }
      }

      return updateCaptureState();
    },
    getState() {
      return captureState;
    },
    getRecentAudio(seconds) {
      return rollingAudio.toWavBlob(seconds);
    },
    stop() {
      if (stopped) {
        return;
      }

      stopped = true;
      rollingAudio.clear();
      processor.disconnect();
      source.disconnect();
      audioContext.removeEventListener("statechange", updateCaptureState);
      captureState = "unavailable";
      onStateChange?.("unavailable");
      void audioContext.close();
    }
  };
}
