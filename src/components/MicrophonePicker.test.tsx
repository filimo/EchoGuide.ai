import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MicrophonePicker } from "./MicrophonePicker";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("lists inputs without opening audio, updates on device changes, and locks during live use", async () => {
  const media = new EventTarget();
  const enumerateDevices = vi.fn().mockResolvedValue([
    { kind: "audioinput", deviceId: "mac", label: "MacBook" },
    { kind: "audiooutput", deviceId: "speaker", label: "Speaker" }
  ]);
  const getUserMedia = vi.fn();
  vi.stubGlobal("navigator", { mediaDevices: Object.assign(media, { enumerateDevices, getUserMedia }) });
  const onChange = vi.fn();
  const view = render(<MicrophonePicker value="default" onChange={onChange} disabled={false} stream={null} />);
  await screen.findByRole("option", { name: "MacBook" });
  expect(screen.queryByRole("option", { name: "Speaker" })).toBeNull();
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "mac" } });
  expect(onChange).toHaveBeenCalledWith("mac");
  expect(getUserMedia).not.toHaveBeenCalled();
  view.rerender(<MicrophonePicker value="mac" onChange={onChange} disabled={true} stream={null} />);
  expect(screen.getByRole("combobox")).toBeDisabled();
  enumerateDevices.mockResolvedValue([]);
  media.dispatchEvent(new Event("devicechange"));
  await waitFor(() => expect(screen.getByRole("option", { name: "Saved microphone (unavailable)" })).toBeInTheDocument());
  expect(onChange).toHaveBeenCalledTimes(1);
});
