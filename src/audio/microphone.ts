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
  browserContext: BrowserSecurityContext = globalThis,
  deviceId = "default"
): Promise<MicrophoneResult> {
  if (browserContext.isSecureContext === false || mediaDevices?.getUserMedia == null) {
    return {
      status: "error",
      stream: null,
      errorMessage: secureContextError
    };
  }

  try {
    // Some browsers omit the synthetic default device (for example on mobile).
    const devices = deviceId === "default" && "enumerateDevices" in mediaDevices
      ? await (mediaDevices as MediaDevices).enumerateDevices().catch(() => [])
      : [];
    const audio = deviceId !== "default" || devices.some(device => device.deviceId === "default")
      ? { deviceId: { exact: deviceId } }
      : true;
    const stream = await mediaDevices.getUserMedia({ audio, video: false });
    return { status: "active", stream };
  } catch (error) {
    return toErrorResult(error);
  }
}

export function stopStream(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}
