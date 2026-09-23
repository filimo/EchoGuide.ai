import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MacAudioControls, type MacAudioSelection } from "./MacAudioControls";
import { listMacAudioSources, macInputVolume, monitorMacMicrophone, type MacMicrophoneMonitorEvent } from "../macAudio/client";
import { loadAudioMode, loadMacAudioPreference, saveAudioMode, saveMacAudioPreference } from "../macAudio/preferences";
vi.mock("../macAudio/client", () => ({ listMacAudioSources: vi.fn(), macInputVolume: vi.fn().mockResolvedValue({ available: false }), monitorMacMicrophone: vi.fn() }));
beforeEach(() => { vi.mocked(macInputVolume).mockResolvedValue({ available: false }); });
afterEach(() => { localStorage.clear(); vi.resetAllMocks(); });
function Harness() {
  const [selection, setSelection] = useState<MacAudioSelection | null>(null);
  return <><MacAudioControls disabled={false} selection={selection} onChange={setSelection} />
    <output data-testid="selection">{JSON.stringify(selection)}</output></>;
}
const app = { pid: 10, name: "Call", bundleId: "com.test.call" };
const microphones = [{ id: "usb", name: "USB mic" }];
it("previews the selected microphone and stops monitoring when requested", async () => {
  saveMacAudioPreference({ application: app, microphone: "usb" });
  vi.mocked(listMacAudioSources).mockResolvedValue({ applications: [app], microphones });
  let onEvent: ((event: MacMicrophoneMonitorEvent) => void) | undefined;
  const stop = vi.fn();
  vi.mocked(monitorMacMicrophone).mockImplementation((_microphone, next) => {
    onEvent = next;
    return { stop };
  });
  render(<Harness />);
  await screen.findByRole("option", { name: "USB mic" });
  fireEvent.click(screen.getByRole("button", { name: "Проверить микрофон" }));
  expect(monitorMacMicrophone).toHaveBeenCalledWith("usb", expect.any(Function), expect.any(Function));
  act(() => {
    onEvent?.({ type: "ready" });
    onEvent?.({ type: "level", level: 0.01, peak: 0.1 });
  });
  expect(screen.getByRole("meter", { name: "Уровень проверяемого микрофона" }))
    .toHaveAttribute("aria-valuetext", expect.stringContaining("рабочий уровень"));
  fireEvent.click(screen.getByRole("button", { name: "Остановить проверку" }));
  expect(stop).toHaveBeenCalledOnce();
  expect(screen.queryByRole("meter", { name: "Уровень проверяемого микрофона" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Проверить микрофон" }));
  fireEvent.click(screen.getByRole("button", { name: "Закрыть настройки звука" }));
  expect(stop).toHaveBeenCalledTimes(2);
});
it("shows and changes the selected microphone's system input volume", async () => {
  vi.mocked(listMacAudioSources).mockResolvedValue({ applications: [app], microphones });
  vi.mocked(macInputVolume).mockResolvedValueOnce({ available: true, value: 42 })
    .mockResolvedValueOnce({ available: true, value: 55 });
  render(<Harness />);
  await screen.findByRole("option", { name: "Call (10)" });
  const slider = await screen.findByRole("slider", { name: /Чувствительность микрофона/ });
  expect(slider).toHaveValue("42");
  fireEvent.change(slider, { target: { value: "55" } });
  fireEvent.pointerUp(slider);
  await waitFor(() => expect(macInputVolume).toHaveBeenCalledWith("default", 55));
  expect(screen.getByText("55%")).toBeInTheDocument();
});
it("restores the app by bundle ID with a new PID after remount, ignoring a reused old PID", async () => {
  vi.mocked(listMacAudioSources).mockResolvedValue({ applications: [app], microphones });
  const view = render(<Harness />);
  await screen.findByRole("option", { name: "Call (10)" });
  fireEvent.change(screen.getByLabelText("Call application"), { target: { value: "10" } });
  fireEvent.change(screen.getByLabelText("Mac microphone"), { target: { value: "usb" } });
  expect(loadMacAudioPreference()).toEqual({ application: { bundleId: app.bundleId, name: "Call" }, microphone: "usb" });
  view.unmount();
  vi.mocked(listMacAudioSources).mockResolvedValue({ applications: [
    { ...app, pid: 99 }, { pid: 10, name: "Unrelated", bundleId: "other" }
  ], microphones });
  render(<Harness />);
  await waitFor(() => expect(screen.getByTestId("selection")).toHaveTextContent('{"pid":99,"microphone":"usb"}'));
  expect(screen.getByLabelText("Call application")).toHaveValue("99");
});
it("preserves an unavailable app preference and restores it after refresh", async () => {
  saveMacAudioPreference({ application: app, microphone: "default" });
  vi.mocked(listMacAudioSources).mockResolvedValue({ applications: [], microphones: [] });
  render(<Harness />);
  expect(await screen.findByRole("alert")).toHaveTextContent("not running");
  expect(screen.getByTestId("selection")).toHaveTextContent("null");
  vi.mocked(listMacAudioSources).mockResolvedValue({ applications: [{ ...app, pid: 55 }], microphones });
  fireEvent.click(screen.getByRole("button", { name: "Refresh Mac sources" }));
  await waitFor(() => expect(screen.getByLabelText("Call application")).toHaveValue("55"));
});
it("does not silently replace a missing microphone", async () => {
  saveMacAudioPreference({ application: app, microphone: "usb" });
  vi.mocked(listMacAudioSources).mockResolvedValue({ applications: [app], microphones: [] });
  render(<Harness />);
  expect(await screen.findByRole("alert")).toHaveTextContent("microphone is unavailable");
  expect(screen.getByTestId("selection")).toHaveTextContent("null");
  await act(async () => {
    fireEvent.change(screen.getByLabelText("Mac microphone"), { target: { value: "default" } });
  });
  expect(screen.getByTestId("selection")).toHaveTextContent('{"pid":10,"microphone":"default"}');
});
it("requires explicit selection for duplicate bundle IDs", async () => {
  saveMacAudioPreference({ application: app, microphone: "default" });
  vi.mocked(listMacAudioSources).mockResolvedValue({ applications: [app, { ...app, pid: 20 }], microphones });
  render(<Harness />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Multiple instances");
  expect(screen.getByTestId("selection")).toHaveTextContent("null");
  fireEvent.change(screen.getByLabelText("Call application"), { target: { value: "20" } });
  expect(screen.getByLabelText("Call application")).toHaveValue("20");
});
it("restores the last audio mode and tolerates invalid or blocked storage", () => {
  saveAudioMode("microphone");
  expect(loadAudioMode("mac")).toBe("microphone");
  localStorage.setItem("echoguide.macAudio.v1", "broken");
  expect(loadMacAudioPreference().application).toBeNull();
  const mock = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw Error("blocked"); });
  expect(loadAudioMode("mac")).toBe("mac");
  expect(loadMacAudioPreference().microphone).toBe("default");
  mock.mockRestore();
});
