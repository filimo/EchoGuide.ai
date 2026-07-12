import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import type { MicrophoneResult } from "./audio/microphone";
import { setupMemoryStorageKey } from "./domain/setupMemory";

function createStream(): MediaStream {
  return {
    getTracks: () => [
      {
        stop: vi.fn()
      } as unknown as MediaStreamTrack
    ],
    getAudioTracks: () => []
  } as unknown as MediaStream;
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ sessions: [] })
    })
  );
});

afterEach(() => {
  window.history.pushState({}, "", "/");
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

describe("EchoGuide iPad setup flow", () => {
  it("routes directly to the Realtime Transcription Lab", () => {
    window.history.pushState({}, "", "/realtime-lab");

    render(<App />);

    expect(screen.getByRole("heading", { name: "Realtime Transcription Lab" })).toBeInTheDocument();
  });

  it("starts first-run setup without the manual listening checkbox", () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: "EchoGuide" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Подключить iPad microphone" })).toBeInTheDocument();
    expect(screen.queryByLabelText("iPad слышит разговор рядом с MacBook")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Pasted notes")).toBeInTheDocument();
  });

  it("prefills empty pasted notes from the local knowledge endpoint", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ knowledgeContext: "Project: EchoGuide local context" })
    } as Response);

    render(<App />);

    expect(await screen.findByDisplayValue("Project: EchoGuide local context")).toBeInTheDocument();
  });

  it("does not enter live mode until microphone and notes are present", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Перейти в live session" }));

    expect(screen.getByText("Подключи microphone и добавь pasted notes.")).toBeInTheDocument();
  });

  it("enters realtime training mode after microphone and notes", async () => {
    const user = userEvent.setup();
    const requestMicrophone = vi.fn<() => Promise<MicrophoneResult>>().mockResolvedValue({
      status: "active",
      stream: createStream()
    });

    await act(async () => {
      render(<App requestMicrophone={requestMicrophone} />);
    });

    await user.click(screen.getByRole("button", { name: "Подключить iPad microphone" }));
    await user.type(screen.getByLabelText("Pasted notes"), "Mention dependency review.");
    await user.click(screen.getByRole("button", { name: "Перейти в live session" }));

    expect(screen.getByRole("heading", { name: "Training Mode" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start live" })).toBeInTheDocument();
    expect(screen.queryByText("Source: ChatGPT Real Voice practice")).not.toBeInTheDocument();
    expect(screen.queryByText("Can you commit by Friday?")).not.toBeInTheDocument();
  });

  it("enters live mode with a single start live control after setup microphone permission", async () => {
    const user = userEvent.setup();
    const requestMicrophone = vi.fn<() => Promise<MicrophoneResult>>().mockResolvedValue({
      status: "active",
      stream: createStream()
    });

    await act(async () => {
      render(<App requestMicrophone={requestMicrophone} />);
    });

    await user.click(screen.getByRole("button", { name: "Подключить iPad microphone" }));
    await user.type(screen.getByLabelText("Pasted notes"), "Mention dependency review.");
    await user.click(screen.getByRole("button", { name: "Перейти в live session" }));

    expect(screen.getByRole("button", { name: "Start live" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect Realtime" })).not.toBeInTheDocument();
  });

  it("opens remembered setup directly in live mode without auto-starting the microphone", async () => {
    const user = userEvent.setup();
    const requestMicrophone = vi.fn<() => Promise<MicrophoneResult>>().mockResolvedValue({
      status: "active",
      stream: createStream()
    });
    const firstRender = render(<App requestMicrophone={requestMicrophone} />);

    await user.click(screen.getByRole("button", { name: "Подключить iPad microphone" }));
    await user.clear(screen.getByLabelText("Source label"));
    await user.type(screen.getByLabelText("Source label"), "ChatGPT Real Voice practice");
    await user.type(screen.getByLabelText("Pasted notes"), "Mention dependency review.");
    await user.click(screen.getByRole("button", { name: "Перейти в live session" }));

    firstRender.unmount();
    requestMicrophone.mockClear();

    await act(async () => {
      render(<App requestMicrophone={requestMicrophone} />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByRole("heading", { name: "Training Mode" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "EchoGuide" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start live" })).toBeInTheDocument();
    expect(screen.getByText("Microphone: not connected")).toBeInTheDocument();
    expect(screen.queryByText("Session notes are available for this training session.")).not.toBeInTheDocument();
    expect(requestMicrophone).not.toHaveBeenCalled();
  });

  it("opens remembered setup with the latest saved session after a page reload", async () => {
    window.localStorage.setItem(
      setupMemoryStorageKey,
      JSON.stringify({
        version: 1,
        onboardingCompleted: true,
        selectedMode: "training-mode",
        sourceLabel: "ChatGPT Real Voice practice",
        knowledgeContext: "Mention EchoGuide work."
      })
    );
    vi.mocked(fetch).mockImplementation(async (url) => {
      if (url === "/api/sessions") {
        return {
          ok: true,
          json: async () => ({
            sessions: [
              {
                version: 1,
                id: "session-latest",
                savedAt: "2026-07-09T07:30:00.000Z",
                createdAt: "2026-07-09T07:00:00.000Z",
                updatedAt: "2026-07-09T07:30:00.000Z",
                sourceLabel: "ChatGPT Real Voice practice",
                knowledgeContext: "Mention EchoGuide work.",
                transcriptTurns: [
                  {
                    id: "training-phrase-1",
                    speakerLabel: "Heard",
                    text: "What did you build in EchoGuide?"
                  }
                ],
                phraseCards: [
                  {
                    id: "training-phrase-1",
                    transcript: "What did you build in EchoGuide?",
                    source: "auto",
                    analysis: {
                      russianMeaning: "Что ты построил в EchoGuide?",
                      isQuestion: true,
                      bridgePhrase: "Sure, let me explain.",
                      suggestedReplies: [
                        {
                          shortLabel: "Realtime flow",
                          shortLabelTranslation: "Realtime flow",
                          fullSentence: "I built a Realtime training flow.",
                          fullSentenceTranslation: "Я построил Realtime тренировочный сценарий.",
                          whyUse: "Когда нужно коротко назвать сделанный flow."
                        }
                      ]
                    }
                  }
                ],
                selectedReplies: [],
                usedBridgePhrases: []
              }
            ]
          })
        } as Response;
      }

      return {
        ok: true,
        json: async () => ({})
      } as Response;
    });

    await act(async () => {
      render(<App requestMicrophone={vi.fn()} />);
    });

    expect(screen.getByRole("heading", { name: "Training Mode" })).toBeInTheDocument();
    expect((await screen.findAllByText("What did you build in EchoGuide?")).length).toBeGreaterThan(
      0
    );
    expect(screen.getByText("Что ты построил в EchoGuide?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start live" })).toBeInTheDocument();
    expect(screen.getByText("Microphone: not connected")).toBeInTheDocument();
  });
});
