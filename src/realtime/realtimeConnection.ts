import {
  createBrowserRecoveryAudioRecorder,
  type RecoveryAudioCaptureState,
  type RecoveryAudioStats
} from "../audio/recoveryAudioRecorder";

export const OPENAI_REALTIME_CALLS_URL = "https://api.openai.com/v1/realtime/calls";

export type RealtimeServerEvent = {
  type: string;
  [key: string]: unknown;
};

export type RealtimeTranscriptionConnection = {
  sendEvent: (event: RealtimeClientEvent) => boolean;
  clearAudio: () => boolean;
  commitAudio: () => boolean;
  collectStats: () => Promise<void>;
  getRecentAudio: (seconds?: number) => Blob | null;
  disconnect: () => void;
};

export type RealtimeClientEvent = {
  type: string;
  [key: string]: unknown;
};

export type RealtimeAudioStats = RecoveryAudioStats;

export type RealtimeAudioAppender = {
  ensureActive?: () => Promise<RecoveryAudioCaptureState>;
  getState?: () => RecoveryAudioCaptureState;
  getRecentAudio?: (seconds?: number) => Blob | null;
  stop: () => void;
};

export type RealtimeConnectionDiagnostic = {
  type: string;
  details?: Record<string, boolean | number | string | null>;
};

type ConnectRealtimeTranscriptionOptions = {
  stream: MediaStream;
  clientSecret: string;
  onEvent: (event: RealtimeServerEvent) => void;
  onError?: (message: string) => void;
  onAudioStats?: (stats: RealtimeAudioStats) => void;
  onDiagnosticEvent?: (event: RealtimeConnectionDiagnostic) => void;
  sessionUpdateAfterOpen?: Record<string, unknown>;
  fetchImpl?: typeof fetch;
  peerConnectionFactory?: () => RTCPeerConnection;
  audioAppender?: RealtimeAudioAppender | null;
  audioAppenderFactory?: (options: {
    stream: MediaStream;
    getDataChannelBufferedAmount?: () => number;
    onAudioStats?: (stats: RealtimeAudioStats) => void;
    onDiagnosticEvent?: (event: RealtimeConnectionDiagnostic) => void;
  }) => RealtimeAudioAppender;
  callsUrl?: string;
};

function parseRealtimeEvent(data: string): RealtimeServerEvent | null {
  const parsed = JSON.parse(data) as unknown;

  if (typeof parsed !== "object" || parsed == null || !("type" in parsed)) {
    return null;
  }

  const event = parsed as { type?: unknown };
  return typeof event.type === "string" ? (parsed as RealtimeServerEvent) : null;
}

function waitForDataChannelOpen(dataChannel: RTCDataChannel): Promise<void> {
  if (dataChannel.readyState === "open") {
    return Promise.resolve();
  }

  if (dataChannel.readyState === "closed" || dataChannel.readyState === "closing") {
    return Promise.reject(new Error("Realtime data channel closed before it opened."));
  }

  return new Promise((resolve, reject) => {
    dataChannel.addEventListener("open", () => resolve());
    dataChannel.addEventListener("close", () =>
      reject(new Error("Realtime data channel closed before it opened."))
    );
    dataChannel.addEventListener("error", () =>
      reject(new Error("Realtime data channel failed before it opened."))
    );
  });
}

export async function connectRealtimeTranscription({
  stream,
  clientSecret,
  onEvent,
  onError,
  onAudioStats,
  onDiagnosticEvent,
  sessionUpdateAfterOpen,
  fetchImpl = fetch,
  peerConnectionFactory = () => new RTCPeerConnection(),
  audioAppender: providedAudioAppender,
  audioAppenderFactory = createBrowserRecoveryAudioRecorder,
  callsUrl = OPENAI_REALTIME_CALLS_URL
}: ConnectRealtimeTranscriptionOptions): Promise<RealtimeTranscriptionConnection> {
  const peerConnection = peerConnectionFactory();
  const dataChannel = peerConnection.createDataChannel("oai-events");
  let audioAppender: RealtimeAudioAppender | null = providedAudioAppender ?? null;
  const shouldCreateAudioAppender = providedAudioAppender === undefined;

  dataChannel.addEventListener("message", (message) => {
    try {
      const event = parseRealtimeEvent(String(message.data));
      if (event != null) {
        onEvent(event);
      }
    } catch {
      onError?.("Could not parse a Realtime event from the data channel.");
    }
  });

  function emitDiagnostic(
    type: string,
    details?: Record<string, boolean | number | string | null>
  ) {
    onDiagnosticEvent?.({ type, details });
  }

  dataChannel.addEventListener("open", () =>
    emitDiagnostic("data_channel.state", { state: dataChannel.readyState })
  );
  dataChannel.addEventListener("close", () =>
    emitDiagnostic("data_channel.state", { state: dataChannel.readyState })
  );
  dataChannel.addEventListener("error", () => emitDiagnostic("data_channel.error"));
  peerConnection.addEventListener("connectionstatechange", () =>
    emitDiagnostic("peer_connection.state", { state: peerConnection.connectionState })
  );
  peerConnection.addEventListener("iceconnectionstatechange", () =>
    emitDiagnostic("ice_connection.state", { state: peerConnection.iceConnectionState })
  );

  stream.getTracks().forEach((track) => {
    peerConnection.addTrack(track, stream);
    track.addEventListener("mute", () =>
      emitDiagnostic("microphone_track.mute", { kind: track.kind, readyState: track.readyState })
    );
    track.addEventListener("unmute", () =>
      emitDiagnostic("microphone_track.unmute", { kind: track.kind, readyState: track.readyState })
    );
    track.addEventListener("ended", () =>
      emitDiagnostic("microphone_track.ended", { kind: track.kind, readyState: track.readyState })
    );
  });

  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);

  if (offer.sdp == null) {
    throw new Error("Could not create a local SDP offer for Realtime.");
  }

  const sdpResponse = await fetchImpl(callsUrl, {
    method: "POST",
    body: offer.sdp,
    headers: {
      Authorization: `Bearer ${clientSecret}`,
      "Content-Type": "application/sdp"
    }
  });

  if (!sdpResponse.ok) {
    throw new Error(`OpenAI Realtime SDP exchange failed with status ${sdpResponse.status}`);
  }

  await peerConnection.setRemoteDescription({
    type: "answer",
    sdp: await sdpResponse.text()
  });

  await waitForDataChannelOpen(dataChannel);

  function sendEvent(event: RealtimeClientEvent) {
    if (dataChannel.readyState !== "open") {
      return false;
    }

    dataChannel.send(JSON.stringify(event));
    return true;
  }

  if (sessionUpdateAfterOpen != null) {
    sendEvent({
      type: "session.update",
      session: sessionUpdateAfterOpen
    });
  }

  function startAudioAppender() {
    if (audioAppender != null || !shouldCreateAudioAppender) {
      return;
    }

    audioAppender = audioAppenderFactory({
      stream,
      getDataChannelBufferedAmount: () => dataChannel.bufferedAmount,
      onAudioStats,
      onDiagnosticEvent
    });
    void audioAppender.ensureActive?.();
  }

  startAudioAppender();

  async function collectStats() {
    try {
      const stats = await peerConnection.getStats();
      let outboundAudioFound = false;
      let mediaSourceFound = false;

      stats.forEach((rawStat) => {
        const stat = rawStat as RTCStats & Record<string, unknown>;
        const mediaKind = stat.kind ?? stat.mediaType;

        if (stat.type === "outbound-rtp" && mediaKind === "audio" && stat.isRemote !== true) {
          outboundAudioFound = true;
          emitDiagnostic("webrtc.outbound_audio", {
            bytesSent: typeof stat.bytesSent === "number" ? stat.bytesSent : 0,
            packetsSent: typeof stat.packetsSent === "number" ? stat.packetsSent : 0,
            headerBytesSent:
              typeof stat.headerBytesSent === "number" ? stat.headerBytesSent : 0,
            retransmittedPacketsSent:
              typeof stat.retransmittedPacketsSent === "number"
                ? stat.retransmittedPacketsSent
                : 0,
            statsTimestamp: typeof stat.timestamp === "number" ? stat.timestamp : 0
          });
        }

        if (stat.type === "media-source" && mediaKind === "audio") {
          mediaSourceFound = true;
          emitDiagnostic("webrtc.media_source_audio", {
            audioLevel: typeof stat.audioLevel === "number" ? stat.audioLevel : 0,
            totalAudioEnergy:
              typeof stat.totalAudioEnergy === "number" ? stat.totalAudioEnergy : 0,
            totalSamplesDuration:
              typeof stat.totalSamplesDuration === "number" ? stat.totalSamplesDuration : 0,
            statsTimestamp: typeof stat.timestamp === "number" ? stat.timestamp : 0
          });
        }
      });

      if (!outboundAudioFound) {
        emitDiagnostic("webrtc.outbound_audio.missing");
      }

      if (!mediaSourceFound) {
        emitDiagnostic("webrtc.media_source_audio.missing");
      }
    } catch {
      emitDiagnostic("webrtc.stats_error");
    }
  }

  return {
    sendEvent,
    clearAudio() {
      return sendEvent({ type: "input_audio_buffer.clear" });
    },
    commitAudio() {
      return sendEvent({ type: "input_audio_buffer.commit" });
    },
    collectStats,
    getRecentAudio(seconds) {
      return audioAppender?.getRecentAudio?.(seconds) ?? null;
    },
    disconnect() {
      audioAppender?.stop();
      dataChannel.close();
      peerConnection.close();
    }
  };
}
