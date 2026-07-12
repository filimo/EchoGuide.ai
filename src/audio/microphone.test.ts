import { describe, expect, it, vi } from "vitest";
import { requestMicrophoneStream, stopStream } from "./microphone";

describe("microphone adapter", () => {
  it("requests microphone audio with no video", async () => {
    const stream = { getTracks: () => [] } as unknown as MediaStream;
    const getUserMedia = vi.fn().mockResolvedValue(stream);

    const result = await requestMicrophoneStream({ getUserMedia } as unknown as MediaDevices);

    expect(getUserMedia).toHaveBeenCalledWith({ audio: true, video: false });
    expect(result.status).toBe("active");
    expect(result.stream).toBe(stream);
  });

  it("returns blocked when permission is denied", async () => {
    const getUserMedia = vi.fn().mockRejectedValue(new DOMException("Denied", "NotAllowedError"));

    const result = await requestMicrophoneStream({ getUserMedia } as unknown as MediaDevices);

    expect(result.status).toBe("blocked");
    expect(result.errorMessage).toContain("microphone");
  });

  it("explains when iPad microphone is unavailable outside a secure context", async () => {
    const getUserMedia = vi.fn();

    const result = await requestMicrophoneStream(
      { getUserMedia } as unknown as MediaDevices,
      { isSecureContext: false }
    );

    expect(getUserMedia).not.toHaveBeenCalled();
    expect(result.status).toBe("error");
    expect(result.errorMessage).toContain("HTTPS");
  });

  it("stops all tracks", () => {
    const stop = vi.fn();
    const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream;

    stopStream(stream);

    expect(stop).toHaveBeenCalledOnce();
  });
});
