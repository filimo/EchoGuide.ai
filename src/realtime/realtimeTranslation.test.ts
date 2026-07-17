import { describe, expect, it, vi } from "vitest";
import {
  connectRealtimeTranslation,
  createRealtimeTranslationClientSecret
} from "./realtimeTranslation";

type Listener = (event?: { data?: string }) => void;

class FakeDataChannel {
  readonly listeners = new Map<string, Listener>();
  readyState = "open";
  closed = false;

  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, listener);
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
  readonly addTrack = vi.fn();
  readonly createDataChannel = vi.fn().mockReturnValue(this.dataChannel);
  readonly createOffer = vi.fn().mockResolvedValue({ type: "offer", sdp: "local-sdp" });
  readonly setLocalDescription = vi.fn().mockResolvedValue(undefined);
  readonly setRemoteDescription = vi.fn().mockResolvedValue(undefined);
  readonly close = vi.fn();
}

function createAudioStream(): MediaStream {
  const track = { kind: "audio" } as MediaStreamTrack;

  return {
    getAudioTracks: () => [track]
  } as unknown as MediaStream;
}

function jsonResponse(payload: unknown, init: { ok: boolean; status: number }): Response {
  return {
    ok: init.ok,
    status: init.status,
    json: vi.fn().mockResolvedValue(payload)
  } as unknown as Response;
}

function sdpResponse(body: string, init: { ok: boolean; status: number }): Response {
  return {
    ok: init.ok,
    status: init.status,
    text: vi.fn().mockResolvedValue(body)
  } as unknown as Response;
}

describe("Realtime translation", () => {
  it("creates a Russian translation client secret with the dedicated model", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          value: "ek_translation",
          expires_at: 1756310470,
          session: { id: "translation-session" }
        },
        { ok: true, status: 200 }
      )
    );

    const result = await createRealtimeTranslationClientSecret({
      apiKey: "sk-test",
      fetchImpl
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.openai.com/v1/realtime/translations/client_secrets",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer sk-test",
          "Content-Type": "application/json",
          "OpenAI-Safety-Identifier": "echoguide-local-dev"
        },
        body: JSON.stringify({
          session: {
            model: "gpt-realtime-translate",
            audio: { output: { language: "ru" } }
          }
        })
      }
    );
    expect(result).toEqual({
      clientSecret: "ek_translation",
      expiresAt: 1756310470,
      sessionId: "translation-session",
      model: "gpt-realtime-translate",
      outputLanguage: "ru"
    });
  });

  it("streams translation events through a second WebRTC connection without playing audio", async () => {
    const peer = new FakePeerConnection();
    const stream = createAudioStream();
    const onEvent = vi.fn();
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(sdpResponse("answer-sdp", { ok: true, status: 200 }));

    const connection = await connectRealtimeTranslation({
      stream,
      clientSecret: "ek_translation",
      onEvent,
      fetchImpl,
      peerConnectionFactory: () => peer as unknown as RTCPeerConnection
    });

    expect(peer.addTrack).toHaveBeenCalledWith(stream.getAudioTracks()[0], stream);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.openai.com/v1/realtime/translations/calls",
      {
        method: "POST",
        body: "local-sdp",
        headers: {
          Authorization: "Bearer ek_translation",
          "Content-Type": "application/sdp"
        }
      }
    );

    peer.dataChannel.emit("message", {
      data: JSON.stringify({
        type: "session.output_transcript.delta",
        delta: "Здравствуйте"
      })
    });

    expect(onEvent).toHaveBeenCalledWith({
      type: "session.output_transcript.delta",
      delta: "Здравствуйте"
    });

    connection.disconnect();
    expect(peer.dataChannel.closed).toBe(true);
    expect(peer.close).toHaveBeenCalled();
  });
});
