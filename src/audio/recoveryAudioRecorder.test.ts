import { describe, expect, it, vi } from "vitest";
import { createBrowserRecoveryAudioRecorder } from "./recoveryAudioRecorder";

class FakeAudioContext {
  state = "suspended";
  sampleRate = 48_000;
  destination = {} as AudioDestinationNode;
  resumeStartsAudio = true;
  readonly listeners = new Map<string, () => void>();
  readonly source = {
    connect: vi.fn(),
    disconnect: vi.fn()
  };
  readonly processor = {
    onaudioprocess: null as ((event: AudioProcessingEvent) => void) | null,
    connect: vi.fn(),
    disconnect: vi.fn()
  };
  readonly resume = vi.fn(async () => {
    if (this.resumeStartsAudio) {
      this.state = "running";
      this.listeners.get("statechange")?.();
    }
  });
  readonly close = vi.fn(async () => {
    this.state = "closed";
  });

  createMediaStreamSource() {
    return this.source as unknown as MediaStreamAudioSourceNode;
  }

  createScriptProcessor() {
    return this.processor as unknown as ScriptProcessorNode;
  }

  addEventListener(type: string, listener: () => void) {
    this.listeners.set(type, listener);
  }

  removeEventListener(type: string) {
    this.listeners.delete(type);
  }

  emitAudio(samples: Float32Array) {
    this.processor.onaudioprocess?.({
      inputBuffer: {
        getChannelData: () => samples
      }
    } as unknown as AudioProcessingEvent);
  }
}

function createStream(): MediaStream {
  return {} as MediaStream;
}

describe("browser recovery audio recorder", () => {
  it("resumes the AudioContext and reports recording state", async () => {
    const audioContext = new FakeAudioContext();
    const onStateChange = vi.fn();
    const recorder = createBrowserRecoveryAudioRecorder({
      stream: createStream(),
      audioContextFactory: () => audioContext as unknown as AudioContext,
      onStateChange
    });

    const activation = recorder.ensureActive();

    expect(audioContext.resume).toHaveBeenCalledOnce();
    await expect(activation).resolves.toBe("recording");
    expect(recorder.getState()).toBe("recording");
    expect(onStateChange).toHaveBeenCalledWith("needs-user-action");
    expect(onStateChange).toHaveBeenCalledWith("recording");
  });

  it("stays actionable while iPad WebKit keeps the context suspended", async () => {
    const audioContext = new FakeAudioContext();
    audioContext.resumeStartsAudio = false;
    const onAudioStats = vi.fn();
    const recorder = createBrowserRecoveryAudioRecorder({
      stream: createStream(),
      audioContextFactory: () => audioContext as unknown as AudioContext,
      getDataChannelBufferedAmount: () => 7,
      onAudioStats
    });

    await expect(recorder.ensureActive()).resolves.toBe("needs-user-action");
    expect(recorder.getRecentAudio(30)).toBeNull();

    audioContext.resumeStartsAudio = true;
    await expect(recorder.ensureActive()).resolves.toBe("recording");
    audioContext.emitAudio(new Float32Array([0, 0.25, -0.5, 0.1]));

    expect(onAudioStats).toHaveBeenCalledWith(
      expect.objectContaining({
        chunksObserved: 1,
        dataChannelBufferedAmount: 7,
        inputSampleRate: 48_000,
        samplesInLastChunk: 4,
        peak: 0.5
      })
    );
    expect(recorder.getRecentAudio(30)?.size).toBeGreaterThan(44);
  });

  it("clears buffered audio and closes the context when stopped", async () => {
    const audioContext = new FakeAudioContext();
    const recorder = createBrowserRecoveryAudioRecorder({
      stream: createStream(),
      audioContextFactory: () => audioContext as unknown as AudioContext
    });

    await recorder.ensureActive();
    audioContext.emitAudio(new Float32Array([0.1, 0.2]));
    recorder.stop();

    expect(recorder.getRecentAudio()).toBeNull();
    expect(recorder.getState()).toBe("unavailable");
    expect(audioContext.source.disconnect).toHaveBeenCalledOnce();
    expect(audioContext.processor.disconnect).toHaveBeenCalledOnce();
    expect(audioContext.close).toHaveBeenCalledOnce();
  });
});
