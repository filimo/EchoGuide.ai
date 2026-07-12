import type { AudioStatus } from "../domain/session";

export type MicrophoneResult = {
  status: AudioStatus;
  stream: MediaStream | null;
  errorMessage?: string;
};

type BrowserSecurityContext = {
  isSecureContext?: boolean;
};

const secureContextError =
  "Для microphone на iPad нужен HTTPS. HTTP .local адрес не даёт Safari доступ к microphone.";

function toErrorResult(error: unknown): MicrophoneResult {
  if (error instanceof DOMException && error.name === "NotAllowedError") {
    return {
      status: "blocked",
      stream: null,
      errorMessage: "iPad browser did not receive microphone permission."
    };
  }

  return {
    status: "error",
    stream: null,
    errorMessage: "Could not start the iPad microphone."
  };
}

export async function requestMicrophoneStream(
  mediaDevices: Pick<MediaDevices, "getUserMedia"> | undefined = navigator.mediaDevices,
  browserContext: BrowserSecurityContext = globalThis
): Promise<MicrophoneResult> {
  if (browserContext.isSecureContext === false || mediaDevices?.getUserMedia == null) {
    return {
      status: "error",
      stream: null,
      errorMessage: secureContextError
    };
  }

  try {
    const stream = await mediaDevices.getUserMedia({ audio: true, video: false });
    return { status: "active", stream };
  } catch (error) {
    return toErrorResult(error);
  }
}

export function stopStream(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}
