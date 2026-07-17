export const OPENAI_REALTIME_TRANSLATION_CLIENT_SECRETS_URL =
  "https://api.openai.com/v1/realtime/translations/client_secrets";
export const OPENAI_REALTIME_TRANSLATION_CALLS_URL =
  "https://api.openai.com/v1/realtime/translations/calls";

export const defaultRealtimeTranslationModel = "gpt-realtime-translate";
export const defaultRealtimeTranslationLanguage = "ru";

export type RealtimeTranslationClientSecret = {
  clientSecret: string;
  expiresAt: number;
  sessionId?: string;
  model: string;
  outputLanguage: string;
};

export type RealtimeTranslationEvent = {
  type: string;
  [key: string]: unknown;
};

export type RealtimeTranslationConnection = {
  disconnect: () => void;
};

type RealtimeTranslationClientSecretPayload = {
  value?: unknown;
  expires_at?: unknown;
  session?: Record<string, unknown> & {
    id?: unknown;
  };
};

type CreateRealtimeTranslationClientSecretOptions = {
  apiKey: string;
  model?: string;
  outputLanguage?: string;
  fetchImpl?: typeof fetch;
};

export type ConnectRealtimeTranslationOptions = {
  stream: MediaStream;
  clientSecret: string;
  onEvent: (event: RealtimeTranslationEvent) => void;
  onError?: (message: string) => void;
  fetchImpl?: typeof fetch;
  peerConnectionFactory?: () => RTCPeerConnection;
  callsUrl?: string;
};

function parseRealtimeTranslationEvent(data: string): RealtimeTranslationEvent | null {
  const parsed = JSON.parse(data) as unknown;

  if (typeof parsed !== "object" || parsed == null || !("type" in parsed)) {
    return null;
  }

  const event = parsed as { type?: unknown };
  return typeof event.type === "string" ? (parsed as RealtimeTranslationEvent) : null;
}

function waitForDataChannelOpen(dataChannel: RTCDataChannel): Promise<void> {
  if (dataChannel.readyState === "open") {
    return Promise.resolve();
  }

  if (dataChannel.readyState === "closed" || dataChannel.readyState === "closing") {
    return Promise.reject(new Error("Realtime translation data channel closed before it opened."));
  }

  return new Promise((resolve, reject) => {
    dataChannel.addEventListener("open", () => resolve());
    dataChannel.addEventListener("close", () =>
      reject(new Error("Realtime translation data channel closed before it opened."))
    );
    dataChannel.addEventListener("error", () =>
      reject(new Error("Realtime translation data channel failed before it opened."))
    );
  });
}

export function buildRealtimeTranslationClientSecretRequest(
  model = defaultRealtimeTranslationModel,
  outputLanguage = defaultRealtimeTranslationLanguage
) {
  return {
    session: {
      model,
      audio: {
        output: {
          language: outputLanguage
        }
      }
    }
  };
}

export function parseRealtimeTranslationClientSecretResponse(
  payload: RealtimeTranslationClientSecretPayload,
  model = defaultRealtimeTranslationModel,
  outputLanguage = defaultRealtimeTranslationLanguage
): RealtimeTranslationClientSecret {
  if (typeof payload.value !== "string" || typeof payload.expires_at !== "number") {
    throw new Error("OpenAI Realtime translation client secret response had an unexpected shape");
  }

  const sessionId = typeof payload.session?.id === "string" ? payload.session.id : undefined;

  return {
    clientSecret: payload.value,
    expiresAt: payload.expires_at,
    ...(sessionId == null ? {} : { sessionId }),
    model,
    outputLanguage
  };
}

export async function createRealtimeTranslationClientSecret({
  apiKey,
  model = defaultRealtimeTranslationModel,
  outputLanguage = defaultRealtimeTranslationLanguage,
  fetchImpl = fetch
}: CreateRealtimeTranslationClientSecretOptions): Promise<RealtimeTranslationClientSecret> {
  const response = await fetchImpl(OPENAI_REALTIME_TRANSLATION_CLIENT_SECRETS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "OpenAI-Safety-Identifier": "echoguide-local-dev"
    },
    body: JSON.stringify(buildRealtimeTranslationClientSecretRequest(model, outputLanguage))
  });
  const payload = await response.json();

  if (!response.ok) {
    const upstreamMessage =
      typeof (payload as { error?: { message?: unknown } }).error?.message === "string"
        ? (payload as { error: { message: string } }).error.message
        : "OpenAI Realtime translation client secret request failed.";

    throw new Error(
      `OpenAI Realtime translation client secret request failed with status ${response.status}: ${upstreamMessage}`
    );
  }

  return parseRealtimeTranslationClientSecretResponse(payload, model, outputLanguage);
}

export async function connectRealtimeTranslation({
  stream,
  clientSecret,
  onEvent,
  onError,
  fetchImpl = fetch,
  peerConnectionFactory = () => new RTCPeerConnection(),
  callsUrl = OPENAI_REALTIME_TRANSLATION_CALLS_URL
}: ConnectRealtimeTranslationOptions): Promise<RealtimeTranslationConnection> {
  const peerConnection = peerConnectionFactory();
  const dataChannel = peerConnection.createDataChannel("oai-events");

  dataChannel.addEventListener("message", (message) => {
    try {
      const event = parseRealtimeTranslationEvent(String(message.data));

      if (event != null) {
        onEvent(event);
      }
    } catch {
      onError?.("Could not parse a Realtime translation event from the data channel.");
    }
  });

  try {
    const audioTracks = stream.getAudioTracks();

    if (audioTracks.length === 0) {
      throw new Error("No microphone audio track is available for Realtime translation.");
    }

    audioTracks.forEach((track) => peerConnection.addTrack(track, stream));

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    if (offer.sdp == null) {
      throw new Error("Could not create a local SDP offer for Realtime translation.");
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
      throw new Error(
        `OpenAI Realtime translation SDP exchange failed with status ${sdpResponse.status}`
      );
    }

    await peerConnection.setRemoteDescription({
      type: "answer",
      sdp: await sdpResponse.text()
    });
    await waitForDataChannelOpen(dataChannel);

    return {
      disconnect() {
        dataChannel.close();
        peerConnection.close();
      }
    };
  } catch (error) {
    if (dataChannel.readyState !== "closed") {
      dataChannel.close();
    }

    peerConnection.close();
    throw error;
  }
}
