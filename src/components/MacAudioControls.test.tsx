import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { MacAudioControls, type MacAudioSelection } from "./MacAudioControls";
import { listMacAudioSources } from "../macAudio/client";
import { loadAudioMode, loadMacAudioPreference, saveAudioMode, saveMacAudioPreference } from "../macAudio/preferences";
vi.mock("../macAudio/client", () => ({ listMacAudioSources: vi.fn() }));
afterEach(() => { localStorage.clear(); vi.resetAllMocks(); });
function Harness() {
  const [selection, setSelection] = useState<MacAudioSelection | null>(null);
  return <><MacAudioControls disabled={false} selection={selection} onChange={setSelection} />
    <output data-testid="selection">{JSON.stringify(selection)}</output></>;
}
const app = { pid: 10, name: "Call", bundleId: "com.test.call" };
const microphones = [{ id: "usb", name: "USB mic" }];
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
  fireEvent.change(screen.getByLabelText("Mac microphone"), { target: { value: "default" } });
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
