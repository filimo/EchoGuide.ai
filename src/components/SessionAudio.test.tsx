import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SessionAudio } from "./SessionAudio";

afterEach(() => vi.unstubAllGlobals());
it("loads persisted audio on reopening history and exposes the same-origin playback URL", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([
    { id: "recording-1", sessionId: "session-1", startedAt: "2026-09-21T12:00:00Z",
      status: "saved", bytes: 96044, durationMs: 1000, format: "wav" }
  ]))));
  const open = () => {
    const view = render(<SessionAudio sessionId="session-1" />);
    const details = screen.getByText("Аудиозаписи").closest("details")!;
    details.open = true; fireEvent(details, new Event("toggle"));
    return view;
  };
  const first = open();
  await waitFor(() => expect(screen.getByLabelText("Запись сессии")).toHaveAttribute("src", "/api/recordings/session-1/recording-1/audio"));
  expect(screen.getByRole("link", { name: "Скачать MP3" })).toHaveAttribute("href", "/api/recordings/session-1/recording-1/mp3");
  first.unmount();
  open();
  await waitFor(() => expect(screen.getByLabelText("Запись сессии")).toHaveAttribute("controls"));
});
