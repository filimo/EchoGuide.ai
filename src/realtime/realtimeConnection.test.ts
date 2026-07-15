import { describe, expect, it, vi } from "vitest";
import { connectRealtimeTranscription } from "./realtimeConnection";

type Listener = (event?: { data?: string }) => void;

class FakeDataChannel {
  readonly sent: string[] = [];
  readonly listeners = new Map<string, Listener>();
  readyState = "open";
  bufferedAmount = 0;
  closed = false;

  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, listener);
  }

  send(message: string) {
    this.sent.push(message);
  }

  emit(type: string, event?: { data?: string }) {
    this.listeners.get(type)?.(event);
  }

  close() {
    this.closed = true;
  }
}

class FakePeerConnection {
  readonly dataChannel = new FakeDataChannel();
  readonly listeners = new Map<string, Listener>();
  readonly addTrack = vi.fn();
  readonly createDataChannel = vi.fn().mockReturnValue(this.dataChannel);
  readonly createOffer = vi.fn().mockResolvedValue({ type: "offer", sdp: "local-sdp" });
  readonly setLocalDescription = vi.fn().mockResolvedValue(undefined);
  readonly setRemoteDescription = vi.fn().mockResolvedValue(undefined);
  readonly getStats = vi.fn().mockResolvedValue(new Map());
  readonly close = vi.fn();
  connectionState = "connected";
  iceConnectionState = "connected";

  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, listener);
  }

  emit(type: string) {
    this.listeners.get(type)?.();
  }
}

class FakeTrack {
  readonly id: string;
  readonly listeners = new Map<string, Listener>();
  kind = "audio";
  readyState = "live";
  enabled = true;
  muted = false;

  constructor(id: string) {
    this.id = id;
  }

  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, listener);
  }

  emit(type: string) {
    this.listeners.get(type)?.();
  }
}

function createStream(trackCount = 1): MediaStream {
  const tracks = Array.from({ length: trackCount }, (_, index) => new FakeTrack(`track-${index}`));

  return {
    getTracks: () => tracks
  } as unknown as MediaStream;
}

function sdpResponse(body: string, init: { ok: boolean; status: number }): Response {
  return {
    ok: init.ok,
    status: init.status,
    text: vi.fn().mockResolvedValue(body)
  } as unknown as Response;
}

describe("Realtime WebRTC connection", () => {
  function noOpAudioAppenderFactory() {
    return { stop: vi.fn() };
  }

  it("posts local SDP to Realtime calls with the ephemeral client secret", async () => {
    const peer = new FakePeerConnection();
    const fetchImpl = vi.fn().mockResolvedValue(sdpResponse("answer-sdp", { ok: true, status: 200 }));

    await connectRealtimeTranscription({
      stream: createStream(2),
      clientSecret: "ek_ephemeral",
      fetchImpl,
      peerConnectionFactory: () => peer as unknown as RTCPeerConnection,
      audioAppenderFactory: noOpAudioAppenderFactory,
      onEvent: vi.fn()
    });

    expect(peer.addTrack).toHaveBeenCalledTimes(2);
    expect(peer.createDataChannel).toHaveBeenCalledWith("oai-events");
    expect(fetchImpl).toHaveBeenCalledWith("https://api.openai.com/v1/realtime/calls", {
      method: "POST",
      body: "local-sdp",
      headers: {
        Authorization: "Bearer ek_ephemeral",
        "Content-Type": "application/sdp"
      }
    });
    expect(peer.setRemoteDescription).toHaveBeenCalledWith({
      type: "answer",
      sdp: "answer-sdp"
    });
  });

  it("forwards parsed Realtime events from the data channel", async () => {
    const peer = new FakePeerConnection();
    const onEvent = vi.fn();

    await connectRealtimeTranscription({
      stream: createStream(),
      clientSecret: "ek_ephemeral",
      fetchImpl: vi.fn().mockResolvedValue(sdpResponse("answer-sdp", { ok: true, status: 200 })),
      peerConnectionFactory: () => peer as unknown as RTCPeerConnection,
      audioAppenderFactory: noOpAudioAppenderFactory,
      onEvent
    });

    peer.dataChannel.emit("message", {
      data: JSON.stringify({
        type: "conversation.item.input_audio_transcription.delta",
        delta: "Hello"
      })
    });

    expect(onEvent).toHaveBeenCalledWith({
      type: "conversation.item.input_audio_transcription.delta",
      delta: "Hello"
    });
  });

  it("can commit the current audio buffer over the data channel", async () => {
    const peer = new FakePeerConnection();
    const connection = await connectRealtimeTranscription({
      stream: createStream(),
      clientSecret: "ek_ephemeral",
      fetchImpl: vi.fn().mockResolvedValue(sdpResponse("answer-sdp", { ok: true, status: 200 })),
      peerConnectionFactory: () => peer as unknown as RTCPeerConnection,
      audioAppenderFactory: noOpAudioAppenderFactory,
      onEvent: vi.fn()
    });

    connection.commitAudio();

    expect(peer.dataChannel.sent).toContain(JSON.stringify({ type: "input_audio_buffer.commit" }));
  });

  it("can clear the current audio buffer before a push-to-talk phrase", async () => {
    const peer = new FakePeerConnection();
    const connection = await connectRealtimeTranscription({
      stream: createStream(),
      clientSecret: "ek_ephemeral",
      fetchImpl: vi.fn().mockResolvedValue(sdpResponse("answer-sdp", { ok: true, status: 200 })),
      peerConnectionFactory: () => peer as unknown as RTCPeerConnection,
      audioAppenderFactory: noOpAudioAppenderFactory,
      onEvent: vi.fn()
    });

    connection.clearAudio();

    expect(peer.dataChannel.sent).toContain(JSON.stringify({ type: "input_audio_buffer.clear" }));
  });

  it("sends an optional session update after the data channel opens", async () => {
    const peer = new FakePeerConnection();

    await connectRealtimeTranscription({
      stream: createStream(),
      clientSecret: "ek_ephemeral",
      fetchImpl: vi.fn().mockResolvedValue(sdpResponse("answer-sdp", { ok: true, status: 200 })),
      peerConnectionFactory: () => peer as unknown as RTCPeerConnection,
      audioAppenderFactory: noOpAudioAppenderFactory,
      sessionUpdateAfterOpen: {
        turn_detection: {
          type: "server_vad",
          threshold: 0.5
        }
      },
      onEvent: vi.fn()
    });

    expect(peer.dataChannel.sent).toContain(
      JSON.stringify({
        type: "session.update",
        session: {
          turn_detection: {
            type: "server_vad",
            threshold: 0.5
          }
        }
      })
    );
  });

  it("starts a browser audio monitor after the data channel opens", async () => {
    const peer = new FakePeerConnection();
    const stop = vi.fn();
    const audioAppenderFactory = vi.fn().mockReturnValue({ stop });
    const stream = createStream();

    const connection = await connectRealtimeTranscription({
      stream,
      clientSecret: "ek_ephemeral",
      fetchImpl: vi.fn().mockResolvedValue(sdpResponse("answer-sdp", { ok: true, status: 200 })),
      peerConnectionFactory: () => peer as unknown as RTCPeerConnection,
      audioAppenderFactory,
      onEvent: vi.fn()
    });

    expect(audioAppenderFactory).toHaveBeenCalledWith({
      stream,
      getDataChannelBufferedAmount: expect.any(Function),
      onAudioStats: undefined,
      onDiagnosticEvent: undefined
    });
    const getBufferedAmount = audioAppenderFactory.mock.calls[0][0]
      .getDataChannelBufferedAmount as () => number;
    peer.dataChannel.bufferedAmount = 42;
    expect(getBufferedAmount()).toBe(42);

    connection.disconnect();

    expect(stop).toHaveBeenCalledOnce();
  });

  it("exposes recent buffered audio from the browser audio monitor", async () => {
    const peer = new FakePeerConnection();
    const bufferedAudio = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/wav" });
    const getRecentAudio = vi.fn().mockReturnValue(bufferedAudio);
    const connection = await connectRealtimeTranscription({
      stream: createStream(),
      clientSecret: "ek_ephemeral",
      fetchImpl: vi.fn().mockResolvedValue(sdpResponse("answer-sdp", { ok: true, status: 200 })),
      peerConnectionFactory: () => peer as unknown as RTCPeerConnection,
      audioAppenderFactory: () => ({ stop: vi.fn(), getRecentAudio }),
      onEvent: vi.fn()
    });

    expect(connection.getRecentAudio(30)).toBe(bufferedAudio);
    expect(getRecentAudio).toHaveBeenCalledWith(30);
  });

  it("passes audio diagnostics callbacks into the audio appender", async () => {
    const peer = new FakePeerConnection();
    const onAudioStats = vi.fn();
    const audioAppenderFactory = vi.fn().mockReturnValue({ stop: vi.fn() });
    const stream = createStream();

    await connectRealtimeTranscription({
      stream,
      clientSecret: "ek_ephemeral",
      fetchImpl: vi.fn().mockResolvedValue(sdpResponse("answer-sdp", { ok: true, status: 200 })),
      peerConnectionFactory: () => peer as unknown as RTCPeerConnection,
      audioAppenderFactory,
      onAudioStats,
      onEvent: vi.fn()
    });

    expect(audioAppenderFactory).toHaveBeenCalledWith({
      stream,
      getDataChannelBufferedAmount: expect.any(Function),
      onAudioStats,
      onDiagnosticEvent: undefined
    });
  });

  it("uses a recovery recorder that was activated before the network connection", async () => {
    const peer = new FakePeerConnection();
    const providedAudioAppender = {
      ensureActive: vi.fn().mockResolvedValue("recording" as const),
      getState: vi.fn().mockReturnValue("recording" as const),
      getRecentAudio: vi.fn().mockReturnValue(null),
      stop: vi.fn()
    };
    const audioAppenderFactory = vi.fn();

    const connection = await connectRealtimeTranscription({
      stream: createStream(),
      clientSecret: "ek_ephemeral",
      fetchImpl: vi.fn().mockResolvedValue(sdpResponse("answer-sdp", { ok: true, status: 200 })),
      peerConnectionFactory: () => peer as unknown as RTCPeerConnection,
      audioAppender: providedAudioAppender,
      audioAppenderFactory,
      onEvent: vi.fn()
    });

    expect(audioAppenderFactory).not.toHaveBeenCalled();
    expect(providedAudioAppender.ensureActive).not.toHaveBeenCalled();

    connection.disconnect();

    expect(providedAudioAppender.stop).toHaveBeenCalledOnce();
  });

  it("reports peer, data channel, and microphone track lifecycle changes", async () => {
    const peer = new FakePeerConnection();
    const stream = createStream();
    const onDiagnosticEvent = vi.fn();

    await connectRealtimeTranscription({
      stream,
      clientSecret: "ek_ephemeral",
      fetchImpl: vi.fn().mockResolvedValue(sdpResponse("answer-sdp", { ok: true, status: 200 })),
      peerConnectionFactory: () => peer as unknown as RTCPeerConnection,
      audioAppenderFactory: noOpAudioAppenderFactory,
      onDiagnosticEvent,
      onEvent: vi.fn()
    });

    peer.connectionState = "failed";
    peer.emit("connectionstatechange");
    peer.dataChannel.readyState = "closed";
    peer.dataChannel.emit("close");
    const track = stream.getTracks()[0] as unknown as FakeTrack;
    track.readyState = "ended";
    track.emit("ended");

    expect(onDiagnosticEvent).toHaveBeenCalledWith({
      type: "peer_connection.state",
      details: { state: "failed" }
    });
    expect(onDiagnosticEvent).toHaveBeenCalledWith({
      type: "data_channel.state",
      details: { state: "closed" }
    });
    expect(onDiagnosticEvent).toHaveBeenCalledWith({
      type: "microphone_track.ended",
      details: { kind: "audio", readyState: "ended" }
    });
  });

  it("collects outbound RTP and media-source audio counters on demand", async () => {
    const peer = new FakePeerConnection();
    const onDiagnosticEvent = vi.fn();
    peer.getStats.mockResolvedValue(
      new Map([
        [
          "outbound-audio",
          {
            id: "outbound-audio",
            type: "outbound-rtp",
            kind: "audio",
            timestamp: 1234,
            bytesSent: 4567,
            packetsSent: 89,
            headerBytesSent: 321,
            retransmittedPacketsSent: 2
          }
        ],
        [
          "microphone-source",
          {
            id: "microphone-source",
            type: "media-source",
            kind: "audio",
            timestamp: 1235,
            audioLevel: 0.25,
            totalAudioEnergy: 4.5,
            totalSamplesDuration: 18
          }
        ]
      ])
    );

    const connection = await connectRealtimeTranscription({
      stream: createStream(),
      clientSecret: "ek_ephemeral",
      fetchImpl: vi.fn().mockResolvedValue(sdpResponse("answer-sdp", { ok: true, status: 200 })),
      peerConnectionFactory: () => peer as unknown as RTCPeerConnection,
      audioAppenderFactory: noOpAudioAppenderFactory,
      onDiagnosticEvent,
      onEvent: vi.fn()
    });

    await connection.collectStats();

    expect(onDiagnosticEvent).toHaveBeenCalledWith({
      type: "webrtc.outbound_audio",
      details: {
        bytesSent: 4567,
        packetsSent: 89,
        headerBytesSent: 321,
        retransmittedPacketsSent: 2,
        statsTimestamp: 1234
      }
    });
    expect(onDiagnosticEvent).toHaveBeenCalledWith({
      type: "webrtc.media_source_audio",
      details: {
        audioLevel: 0.25,
        totalAudioEnergy: 4.5,
        totalSamplesDuration: 18,
        statsTimestamp: 1235
      }
    });
  });

  it("closes the data channel, audio appender, and peer connection on disconnect", async () => {
    const peer = new FakePeerConnection();
    const stop = vi.fn();
    const connection = await connectRealtimeTranscription({
      stream: createStream(),
      clientSecret: "ek_ephemeral",
      fetchImpl: vi.fn().mockResolvedValue(sdpResponse("answer-sdp", { ok: true, status: 200 })),
      peerConnectionFactory: () => peer as unknown as RTCPeerConnection,
      audioAppenderFactory: () => ({ stop }),
      onEvent: vi.fn()
    });

    connection.disconnect();

    expect(peer.dataChannel.closed).toBe(true);
    expect(stop).toHaveBeenCalledOnce();
    expect(peer.close).toHaveBeenCalledOnce();
  });
});
