import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultRealtimeVadTurnDetection } from "../realtime/realtimeSession";
import type { RealtimeServerEvent } from "../realtime/realtimeConnection";
import type { BilingualPhraseAnalysis } from "../realtime/bilingualAnalysis";
import type {
  SessionHistoryClient,
  SessionHistoryEntry,
  SessionHistoryEntryDraft
} from "../domain/sessionHistory";
import { TrainingLivePanel } from "./TrainingLivePanel";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  window.localStorage.clear();
});

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

function createConnection() {
  return {
    sendEvent: vi.fn(),
    disconnect: vi.fn(),
    clearAudio: vi.fn(),
    commitAudio: vi.fn(),
    collectStats: vi.fn().mockResolvedValue(undefined)
  };
}

function saveInMemorySession(
  savedSessions: SessionHistoryEntry[],
  sessionId: string,
  draft: SessionHistoryEntryDraft
): SessionHistoryEntry {
  const entry: SessionHistoryEntry = {
    version: 1 as const,
    id: sessionId,
    savedAt: "2026-07-08T12:00:00.000Z",
    createdAt: "2026-07-08T12:00:00.000Z",
    updatedAt: "2026-07-08T12:00:00.000Z",
    ...draft
  };
  const existingIndex = savedSessions.findIndex((session) => session.id === sessionId);

  if (existingIndex >= 0) {
    savedSessions[existingIndex] = entry;
  } else {
    savedSessions.unshift(entry);
  }

  return entry;
}

function createInMemorySessionHistoryClient(
  savedSessions: SessionHistoryEntry[] = []
): SessionHistoryClient {
  return {
    loadSessions: vi.fn().mockResolvedValue(savedSessions),
    saveCurrentSession: vi.fn(async (sessionId: string, draft: SessionHistoryEntryDraft) =>
      saveInMemorySession(savedSessions, sessionId, draft)
    ),
    deleteSession: vi.fn(async (sessionId: string) => {
      const existingIndex = savedSessions.findIndex((session) => session.id === sessionId);

      if (existingIndex >= 0) {
        savedSessions.splice(existingIndex, 1);
      }

      return [...savedSessions];
    })
  };
}

function createEmptySessionHistoryClient(): SessionHistoryClient {
  return {
    ...createInMemorySessionHistoryClient(),
    loadSessions: vi.fn(() => new Promise<SessionHistoryEntry[]>(() => {}))
  };
}

describe("Training Live Panel", () => {
  it("keeps primary controls and live status in one sticky control rail", () => {
    render(
      <TrainingLivePanel
        stream={createStream()}
        notes=""
        sessionHistoryClient={createEmptySessionHistoryClient()}
      />
    );

    const controlRail = screen.getByLabelText("Training Mode controls");

    expect(controlRail).toHaveClass("training-control-rail");
    expect(within(controlRail).getByRole("button", { name: "New session" })).toBeInTheDocument();
    expect(within(controlRail).getByText("Realtime: disconnected")).toBeInTheDocument();
    expect(within(controlRail).getByRole("meter", { name: "Microphone level" })).toBeInTheDocument();
  });

  it("shows one start live control before Realtime is connected", () => {
    const onStopMicrophone = vi.fn();

    render(
      <TrainingLivePanel
        stream={createStream()}
        notes=""
        onStopMicrophone={onStopMicrophone}
        sessionHistoryClient={createEmptySessionHistoryClient()}
      />
    );

    expect(screen.getByRole("button", { name: "Start live" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect Realtime" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop live" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Disconnect" })).not.toBeInTheDocument();
    expect(onStopMicrophone).not.toHaveBeenCalled();
  });

  it("disconnects Realtime before stopping live", async () => {
    const user = userEvent.setup();
    const realtimeConnection = createConnection();
    const connectRealtime = vi.fn().mockResolvedValue(realtimeConnection);
    const onStopMicrophone = vi.fn();

    render(
      <TrainingLivePanel
        stream={createStream()}
        notes=""
        requestClientSecret={vi.fn().mockResolvedValue({
          clientSecret: "ephemeral-secret",
          expiresAt: 123
        })}
        connectRealtime={connectRealtime}
        onStopMicrophone={onStopMicrophone}
        sessionHistoryClient={createEmptySessionHistoryClient()}
      />
    );

    await user.click(screen.getByRole("button", { name: "Start live" }));
    await screen.findByRole("button", { name: "Stop live" });
    await user.click(screen.getByRole("button", { name: "Stop live" }));

    expect(realtimeConnection.disconnect).toHaveBeenCalledTimes(1);
    expect(onStopMicrophone).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Realtime: disconnected")).toBeInTheDocument();
  });

  it("does not report a transport error when Stop live closes the data channel", async () => {
    const user = userEvent.setup();
    let emitDiagnostic: (event: {
      type: string;
      details?: Record<string, boolean | number | string | null>;
    }) => void = () => {};
    const disconnect = vi.fn(() => {
      emitDiagnostic({
        type: "data_channel.state",
        details: { state: "closed" }
      });
    });
    const realtimeConnection = {
      ...createConnection(),
      disconnect
    };
    const connectRealtime = vi.fn().mockImplementation(({ onDiagnosticEvent }) => {
      emitDiagnostic = onDiagnosticEvent;
      return Promise.resolve(realtimeConnection);
    });

    render(
      <TrainingLivePanel
        stream={createStream()}
        notes=""
        requestClientSecret={vi.fn().mockResolvedValue({
          clientSecret: "ephemeral-secret",
          expiresAt: 123
        })}
        connectRealtime={connectRealtime}
        onStopMicrophone={vi.fn()}
        sessionHistoryClient={createEmptySessionHistoryClient()}
      />
    );

    await user.click(screen.getByRole("button", { name: "Start live" }));
    await user.click(await screen.findByRole("button", { name: "Stop live" }));

    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Realtime: disconnected")).toBeInTheDocument();
    expect(
      screen.queryByText("Realtime audio path stopped. Diagnostics were recorded; restart live mode.")
    ).not.toBeInTheDocument();
  });

  it("requests microphone and connects Realtime from the single start live control", async () => {
    const user = userEvent.setup();
    const stream = createStream();
    const onRequestMicrophone = vi.fn().mockResolvedValue(stream);
    const requestClientSecret = vi.fn().mockResolvedValue({
      clientSecret: "ephemeral-secret",
      expiresAt: 123
    });
    const connectRealtime = vi.fn().mockResolvedValue(createConnection());

    render(
      <TrainingLivePanel
        stream={null}
        notes=""
        onRequestMicrophone={onRequestMicrophone}
        requestClientSecret={requestClientSecret}
        connectRealtime={connectRealtime}
        sessionHistoryClient={createEmptySessionHistoryClient()}
      />
    );

    await user.click(screen.getByRole("button", { name: "Start live" }));

    expect(onRequestMicrophone).toHaveBeenCalledTimes(1);
    expect(requestClientSecret).toHaveBeenCalledWith("realtime-vad");
    expect(connectRealtime).toHaveBeenCalledWith(expect.objectContaining({ stream }));
    expect(await screen.findByRole("button", { name: "Stop live" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect Realtime" })).not.toBeInTheDocument();
  });

  it("automatically sends privacy-safe Realtime diagnostics after live connection", async () => {
    const user = userEvent.setup();
    const submitDiagnostics = vi.fn().mockResolvedValue("diag-test");

    render(
      <TrainingLivePanel
        stream={createStream()}
        notes="PRIVATE PERSONAL NOTES"
        requestClientSecret={vi.fn().mockResolvedValue({
          clientSecret: "ephemeral-secret",
          expiresAt: 1752238800,
          sessionId: "sess_automatic"
        })}
        connectRealtime={vi.fn().mockResolvedValue(createConnection())}
        submitDiagnostics={submitDiagnostics}
        sessionHistoryClient={createEmptySessionHistoryClient()}
      />
    );

    await user.click(screen.getByRole("button", { name: "Start live" }));

    await waitFor(() => expect(submitDiagnostics).toHaveBeenCalled());
    const report = submitDiagnostics.mock.calls[0]?.[0];

    expect(report).toMatchObject({
      version: 1,
      trigger: "automatic",
      status: {
        realtime: "connected",
        microphonePresent: true,
        openAiSessionId: "sess_automatic"
      }
    });
    expect(report.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "training_live.start",
          details: expect.objectContaining({
            vadMode: "server_vad",
            vadThreshold: defaultRealtimeVadTurnDetection.threshold,
            vadPrefixPaddingMs: defaultRealtimeVadTurnDetection.prefix_padding_ms,
            vadSilenceDurationMs: defaultRealtimeVadTurnDetection.silence_duration_ms,
            speechLanguage: "english-russian"
          })
        }),
        expect.objectContaining({ type: "training_live.connected" })
      ])
    );
    expect(JSON.stringify(report)).not.toContain("PRIVATE PERSONAL NOTES");
    expect(screen.queryByRole("button", { name: "Send diagnostics" })).not.toBeInTheDocument();
  });

  it("records loud local audio when server VAD does not acknowledge speech", async () => {
    vi.useFakeTimers();
    const submitDiagnostics = vi.fn().mockResolvedValue("diag-test");
    let onAudioStats: ((stats: {
      chunksObserved: number;
      silentChunks: number;
      dataChannelBufferedAmount: number;
      inputSampleRate: number;
      samplesInLastChunk: number;
      rms: number;
      peak: number;
    }) => void) | undefined;
    const connectRealtime = vi.fn(async (options) => {
      onAudioStats = options.onAudioStats;
      return createConnection();
    });

    render(
      <TrainingLivePanel
        stream={createStream()}
        notes=""
        requestClientSecret={vi.fn().mockResolvedValue({
          clientSecret: "ephemeral-secret",
          expiresAt: 1752238800,
          sessionId: "sess_unacknowledged"
        })}
        connectRealtime={connectRealtime}
        submitDiagnostics={submitDiagnostics}
        sessionHistoryClient={createEmptySessionHistoryClient()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Start live" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    submitDiagnostics.mockClear();

    act(() => {
      onAudioStats?.({
        chunksObserved: 473,
        silentChunks: 307,
        dataChannelBufferedAmount: 0,
        inputSampleRate: 48000,
        samplesInLastChunk: 4096,
        rms: 0.05593,
        peak: 0.21307
      });
    });
    await act(async () => {
      vi.advanceTimersByTime(2500);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(submitDiagnostics).toHaveBeenCalled();
    expect(
      submitDiagnostics.mock.calls.some(([report]) =>
        report.events.some(
          (event: { type: string }) => event.type === "audio.unacknowledged_speech"
        )
      )
    ).toBe(true);
  });

  it("shows local bridge phrases immediately and copies the selected phrase", async () => {
    const user = userEvent.setup();
    const copyText = vi.fn();

    render(
      <TrainingLivePanel
        stream={createStream()}
        notes=""
        copyText={copyText}
        sessionHistoryClient={createEmptySessionHistoryClient()}
      />
    );

    expect(screen.getByRole("heading", { name: "Bridge phrases" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Let me think. Дайте подумать." })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Can you repeat that? Можете повторить?" })
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "I will answer simply. Я отвечу просто." })
    );
    await user.click(screen.getByRole("button", { name: "Copy bridge phrase" }));

    expect(copyText).toHaveBeenCalledWith("I will answer simply.");
    expect(screen.getByText("Bridge phrase copied.")).toBeInTheDocument();
  });

  it("keeps current phrase suggestions in a sticky side panel", () => {
    render(
      <TrainingLivePanel
        stream={createStream()}
        notes=""
        sessionHistoryClient={createEmptySessionHistoryClient()}
      />
    );

    expect(screen.getByLabelText("Current phrase suggestions")).toHaveClass(
      "suggestions-panel-sticky"
    );
  });

  it("edits pasted notes from a modal instead of keeping the textarea in the live layout", async () => {
    const user = userEvent.setup();
    const onNotesChange = vi.fn();

    function StatefulTrainingLivePanel() {
      const [notes, setNotes] = useState("Initial notes");

      return (
        <TrainingLivePanel
          stream={createStream()}
          notes={notes}
          onNotesChange={(nextNotes) => {
            onNotesChange(nextNotes);
            setNotes(nextNotes);
          }}
          sessionHistoryClient={createEmptySessionHistoryClient()}
        />
      );
    }

    render(<StatefulTrainingLivePanel />);

    expect(screen.queryByLabelText("Pasted notes")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Notes" }));

    const notesDialog = screen.getByRole("dialog", { name: "Pasted notes" });
    const notesInput = within(notesDialog).getByLabelText("Pasted notes");

    expect(notesInput).toHaveValue("Initial notes");

    await user.clear(notesInput);
    await user.type(notesInput, "Updated local context");

    expect(onNotesChange).toHaveBeenLastCalledWith("Updated local context");

    await user.click(within(notesDialog).getByRole("button", { name: "Done" }));

    expect(screen.queryByRole("dialog", { name: "Pasted notes" })).not.toBeInTheDocument();
  });

  it("explains only the selected automatic turn detection mode and its parameters", async () => {
    const user = userEvent.setup();

    render(
      <TrainingLivePanel
        stream={createStream()}
        notes=""
        sessionHistoryClient={createEmptySessionHistoryClient()}
      />
    );

    expect(
      screen.getByText(/Обычный VAD: завершает реплику после паузы в голосе/)
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Насколько уверенно система должна услышать голос/)
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Сколько миллисекунд тишины ждать/)
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Семантический VAD: старается дождаться смыслового завершения мысли/)
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Semantic" }));

    expect(
      screen.getByText(/Семантический VAD: старается дождаться смыслового завершения мысли/)
    ).toBeInTheDocument();
    expect(screen.getByText(/API сам выбирает чувствительность/)).toBeInTheDocument();
    expect(
      screen.queryByText(/Обычный VAD: завершает реплику после паузы в голосе/)
    ).not.toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Eagerness"), "high");

    expect(screen.getByText(/Быстрее закрывает реплику/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Disabled" }));

    expect(
      screen.getByText(/Выключено: автоматическое разделение реплик не используется/)
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Насколько уверенно система должна услышать голос/)
    ).not.toBeInTheDocument();
  });

  it("connects through Realtime VAD and renders bilingual phrase analysis", async () => {
    const user = userEvent.setup();
    let emitEvent: (event: RealtimeServerEvent) => void = () => {};
    const requestClientSecret = vi.fn().mockResolvedValue({
      clientSecret: "ek_ephemeral",
      expiresAt: 1756310470
    });
    const connectRealtime = vi.fn().mockImplementation(({ onEvent }) => {
      emitEvent = onEvent;
      return Promise.resolve(createConnection());
    });
    const analyzePhrase = vi.fn().mockResolvedValue({
      speakerRole: "interviewer",
      russianMeaning: "Можешь рассказать о последнем проекте?",
      isQuestion: true,
      bridgePhrase: "Sure, let me start with the context.",
      suggestedReplies: [
        {
          shortLabel: "Project context",
          shortLabelTranslation: "Контекст проекта",
          fullSentence: "Sure, the project focused on improving a core user workflow.",
          fullSentenceTranslation:
            "Конечно, проект был сфокусирован на улучшении основного пользовательского сценария.",
          whyUse: "Когда нужно начать с контекста проекта."
        }
      ]
    } satisfies BilingualPhraseAnalysis);

    render(
      <TrainingLivePanel
        stream={createStream()}
        notes="Mention dependency review."
        requestClientSecret={requestClientSecret}
        connectRealtime={connectRealtime}
        analyzePhrase={analyzePhrase}
      />
    );

    await user.click(screen.getByRole("button", { name: "Start live" }));

    expect(requestClientSecret).toHaveBeenCalledWith("realtime-vad");
    expect(connectRealtime).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionUpdateAfterOpen: {
          type: "transcription",
          audio: {
            input: expect.objectContaining({
              turn_detection: defaultRealtimeVadTurnDetection
            })
          }
        }
      })
    );

    await act(async () => {
      emitEvent({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "Can you walk me through your recent project?"
      });
    });

    expect(analyzePhrase).toHaveBeenCalledWith(
      "Can you walk me through your recent project?",
      "Mention dependency review.",
      ["Can you walk me through your recent project?"]
    );
    expect(screen.getAllByText("Can you walk me through your recent project?").length).toBeGreaterThan(
      0
    );
    expect(
      await screen.findByRole("button", {
        name: "Interviewer Can you walk me through your recent project?"
      })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: /Change speaker for Can you walk me through your recent project.*Current role Interviewer/
      })
    ).toHaveTextContent("INT");
    expect(screen.getByText("Можешь рассказать о последнем проекте?")).toBeInTheDocument();
    expect(screen.getByText("Sure, let me start with the context.")).toBeInTheDocument();
    expect(
      screen.getByText("Sure, the project focused on improving a core user workflow.")
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Конечно, проект был сфокусирован на улучшении основного пользовательского сценария."
      )
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Project context Контекст проекта" }));

    expect(
      screen.getByText("Sure, the project focused on improving a core user workflow.")
    ).toBeInTheDocument();
  });

  it("lets the user correct a speaker role and uses it in following context", async () => {
    const user = userEvent.setup();
    let emitEvent: (event: RealtimeServerEvent) => void = () => {};
    const connectRealtime = vi.fn().mockImplementation(({ onEvent }) => {
      emitEvent = onEvent;
      return Promise.resolve(createConnection());
    });
    let resolveFirstAnalysis: (analysis: BilingualPhraseAnalysis) => void = () => {};
    const analysis = {
      speakerRole: "unknown",
      russianMeaning: "Смысл реплики.",
      isQuestion: false,
      bridgePhrase: "Let me explain.",
      suggestedReplies: []
    } satisfies BilingualPhraseAnalysis;
    const analyzePhrase = vi.fn().mockImplementation((transcript: string) => {
      if (transcript === "Tell me about your recent project.") {
        return new Promise<BilingualPhraseAnalysis>((resolve) => {
          resolveFirstAnalysis = resolve;
        });
      }

      return Promise.resolve(analysis);
    });

    render(
      <TrainingLivePanel
        stream={createStream()}
        notes=""
        requestClientSecret={vi.fn().mockResolvedValue({
          clientSecret: "ek_ephemeral",
          expiresAt: 1756310470
        })}
        connectRealtime={connectRealtime}
        analyzePhrase={analyzePhrase}
      />
    );

    await user.click(screen.getByRole("button", { name: "Start live" }));
    await act(async () => {
      emitEvent({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "Tell me about your recent project."
      });
    });

    await user.click(
      screen.getByRole("button", {
        name: /Change speaker for Tell me about your recent project.*Current role Heard/
      })
    );
    await user.click(
      screen.getByRole("button", {
        name: /Change speaker for Tell me about your recent project.*Current role Interviewer/
      })
    );

    await act(async () => {
      resolveFirstAnalysis({ ...analysis, speakerRole: "interviewer" });
    });

    expect(
      screen.getByRole("button", { name: "Me Tell me about your recent project." })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: /Change speaker for Tell me about your recent project.*Current role Me/
      })
    ).toHaveTextContent("ME");

    await act(async () => {
      emitEvent({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "I built a validation workflow."
      });
    });

    expect(analyzePhrase).toHaveBeenLastCalledWith("I built a validation workflow.", "", [
      "Me: Tell me about your recent project.",
      "I built a validation workflow."
    ]);
  });

  it("connects with selected semantic VAD settings", async () => {
    const user = userEvent.setup();
    const connectRealtime = vi.fn().mockResolvedValue(createConnection());

    render(
      <TrainingLivePanel
        stream={createStream()}
        notes=""
        requestClientSecret={vi.fn().mockResolvedValue({
          clientSecret: "ek_ephemeral",
          expiresAt: 1756310470
        })}
        connectRealtime={connectRealtime}
      />
    );

    await user.click(screen.getByRole("button", { name: "Semantic" }));
    await user.selectOptions(screen.getByLabelText("Eagerness"), "high");
    await user.click(screen.getByRole("button", { name: "Start live" }));

    expect(connectRealtime).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionUpdateAfterOpen: {
          type: "transcription",
          audio: {
            input: expect.objectContaining({
              turn_detection: {
                type: "semantic_vad",
                eagerness: "high"
              }
            })
          }
        }
      })
    );
  });

  it("remembers selected turn detection settings for the next Training Mode open", async () => {
    const user = userEvent.setup();
    const firstConnectRealtime = vi.fn().mockResolvedValue(createConnection());
    const firstRender = render(
      <TrainingLivePanel
        stream={createStream()}
        notes=""
        requestClientSecret={vi.fn().mockResolvedValue({
          clientSecret: "ek_ephemeral",
          expiresAt: 1756310470
        })}
        connectRealtime={firstConnectRealtime}
      />
    );

    await user.click(screen.getByRole("button", { name: "Semantic" }));
    await user.selectOptions(screen.getByLabelText("Eagerness"), "high");

    firstRender.unmount();

    const secondConnectRealtime = vi.fn().mockResolvedValue(createConnection());
    render(
      <TrainingLivePanel
        stream={createStream()}
        notes=""
        requestClientSecret={vi.fn().mockResolvedValue({
          clientSecret: "ek_ephemeral",
          expiresAt: 1756310470
        })}
        connectRealtime={secondConnectRealtime}
      />
    );

    expect(screen.getByRole("button", { name: "Semantic" })).toHaveClass("mode-tab-active");
    expect(screen.getByLabelText("Eagerness")).toHaveValue("high");

    await user.click(screen.getByRole("button", { name: "Start live" }));

    expect(secondConnectRealtime).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionUpdateAfterOpen: {
          type: "transcription",
          audio: {
            input: expect.objectContaining({
              turn_detection: {
                type: "semantic_vad",
                eagerness: "high"
              }
            })
          }
        }
      })
    );
  });

  it("remembers selected speech language and sends it in the realtime session update", async () => {
    const user = userEvent.setup();
    const firstRender = render(
      <TrainingLivePanel
        stream={createStream()}
        notes=""
        requestClientSecret={vi.fn().mockResolvedValue({
          clientSecret: "ek_ephemeral",
          expiresAt: 1756310470
        })}
        connectRealtime={vi.fn().mockResolvedValue(createConnection())}
      />
    );

    await user.click(screen.getByRole("button", { name: "English" }));

    firstRender.unmount();

    const connectRealtime = vi.fn().mockResolvedValue(createConnection());
    render(
      <TrainingLivePanel
        stream={createStream()}
        notes=""
        requestClientSecret={vi.fn().mockResolvedValue({
          clientSecret: "ek_ephemeral",
          expiresAt: 1756310470
        })}
        connectRealtime={connectRealtime}
      />
    );

    expect(screen.getByRole("button", { name: "English" })).toHaveClass("mode-tab-active");

    await user.click(screen.getByRole("button", { name: "Start live" }));

    expect(connectRealtime).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionUpdateAfterOpen: {
          type: "transcription",
          audio: {
            input: {
              turn_detection: defaultRealtimeVadTurnDetection,
              transcription: {
                model: "gpt-4o-transcribe",
                prompt:
                  "The audio should be transcribed as English speech. This is software engineering interview practice. Expect simple English, software projects, AI tools, data cleaning, pattern matching, React, TypeScript, APIs. Ignore short filler sounds and uncertain background noise.",
                language: "en"
              }
            }
          }
        }
      })
    );
  });

  it("shows microphone level as a horizontal bar", async () => {
    const user = userEvent.setup();
    let emitAudioStats: (stats: {
      chunksObserved: number;
      silentChunks: number;
      dataChannelBufferedAmount: number;
      inputSampleRate: number;
      samplesInLastChunk: number;
      rms: number;
      peak: number;
    }) => void = () => {};
    const connectRealtime = vi.fn().mockImplementation(({ onAudioStats }) => {
      emitAudioStats = onAudioStats;
      return Promise.resolve(createConnection());
    });

    render(
      <TrainingLivePanel
        stream={createStream()}
        notes=""
        requestClientSecret={vi.fn().mockResolvedValue({
          clientSecret: "ek_ephemeral",
          expiresAt: 1756310470
        })}
        connectRealtime={connectRealtime}
      />
    );

    await user.click(screen.getByRole("button", { name: "Start live" }));

    act(() => {
      emitAudioStats({
        chunksObserved: 4,
        silentChunks: 1,
        dataChannelBufferedAmount: 0,
        inputSampleRate: 48000,
        samplesInLastChunk: 2048,
        rms: 0.003,
        peak: 0.02
      });
    });

    const meter = screen.getByRole("meter", { name: "Microphone level" });

    expect(meter).toHaveAttribute("aria-valuenow", "48");
    expect(meter).toHaveTextContent("Mic level");
    expect(meter).not.toHaveTextContent("0.02000");
  });

  it("keeps completed transcript phrases as a dialogue log", async () => {
    const user = userEvent.setup();
    let emitEvent: (event: RealtimeServerEvent) => void = () => {};
    const copyText = vi.fn();
    const connectRealtime = vi.fn().mockImplementation(({ onEvent }) => {
      emitEvent = onEvent;
      return Promise.resolve(createConnection());
    });
    const analyzePhrase = vi.fn().mockResolvedValue({
      russianMeaning: "Понял смысл реплики.",
      isQuestion: false,
      bridgePhrase: "Let me respond to that.",
      suggestedReplies: []
    } satisfies BilingualPhraseAnalysis);

    render(
      <TrainingLivePanel
        stream={createStream()}
        notes=""
        requestClientSecret={vi.fn().mockResolvedValue({
          clientSecret: "ek_ephemeral",
          expiresAt: 1756310470
        })}
        connectRealtime={connectRealtime}
        analyzePhrase={analyzePhrase}
        copyText={copyText}
      />
    );

    await user.click(screen.getByRole("button", { name: "Start live" }));

    await act(async () => {
      emitEvent({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "Hello, can you hear me?"
      });
    });
    await act(async () => {
      emitEvent({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "Yes, I can hear you."
      });
    });
    await act(async () => {
      emitEvent({
        type: "conversation.item.input_audio_transcription.delta",
        delta: " What about now?"
      });
    });

    const dialogueLog = screen.getByLabelText("Conversation transcript");

    expect(dialogueLog).toHaveTextContent("Hello, can you hear me?");
    expect(dialogueLog).toHaveTextContent("Yes, I can hear you.");
    expect(dialogueLog).toHaveTextContent("What about now?");
    expect(within(dialogueLog).getAllByText("?")).toHaveLength(2);
    expect(screen.getByText("Live")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Copy transcript" }));

    expect(copyText).toHaveBeenCalledWith("Heard: Hello, can you hear me?\nHeard: Yes, I can hear you.");
  });

  it("uses transcript turns as cached phrase navigation", async () => {
    const user = userEvent.setup();
    let emitEvent: (event: RealtimeServerEvent) => void = () => {};
    const connectRealtime = vi.fn().mockImplementation(({ onEvent }) => {
      emitEvent = onEvent;
      return Promise.resolve(createConnection());
    });
    const analyzePhrase = vi.fn().mockImplementation(
      async (transcript: string, knowledgeContext: string) =>
        ({
          russianMeaning: transcript === "First phrase?" ? "Первый смысл." : "Второй смысл.",
          isQuestion: transcript.endsWith("?"),
          bridgePhrase: "Let me answer that.",
          suggestedReplies: []
        }) satisfies BilingualPhraseAnalysis
    );

    render(
      <TrainingLivePanel
        stream={createStream()}
        notes=""
        requestClientSecret={vi.fn().mockResolvedValue({
          clientSecret: "ek_ephemeral",
          expiresAt: 1756310470
        })}
        connectRealtime={connectRealtime}
        analyzePhrase={analyzePhrase}
      />
    );

    await user.click(screen.getByRole("button", { name: "Start live" }));

    await act(async () => {
      emitEvent({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "First phrase?"
      });
    });
    await act(async () => {
      emitEvent({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "Second phrase."
      });
    });

    expect(screen.queryByLabelText("Recent phrases")).not.toBeInTheDocument();
    expect(screen.getByText("Второй смысл.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Heard First phrase?" }));

    expect(screen.getByText("Первый смысл.")).toBeInTheDocument();
    expect(analyzePhrase).toHaveBeenCalledTimes(2);
    expect(analyzePhrase).toHaveBeenNthCalledWith(1, "First phrase?", "", [
      "First phrase?"
    ]);
    expect(analyzePhrase).toHaveBeenNthCalledWith(2, "Second phrase.", "", [
      "First phrase?",
      "Second phrase."
    ]);
  });

  it("sends recent meaningful turns and displays the fresh thought target", async () => {
    const user = userEvent.setup();
    let emitEvent: (event: RealtimeServerEvent) => void = () => {};
    const connectRealtime = vi.fn().mockImplementation(({ onEvent }) => {
      emitEvent = onEvent;
      return Promise.resolve(createConnection());
    });
    const analyzePhrase = vi.fn().mockImplementation(
      async (transcript: string, _knowledgeContext: string, recentContext: string[]) =>
        ({
          analysisTargetText:
            transcript === "Find useful method."
              ? "I read articles, explore AI tools, and test them in small projects."
              : transcript,
          russianMeaning: "Я регулярно изучаю AI tools и проверяю их в небольших проектах.",
          isQuestion: false,
          bridgePhrase: "Let me explain.",
          suggestedReplies: []
        }) satisfies BilingualPhraseAnalysis
    );

    render(
      <TrainingLivePanel
        stream={createStream()}
        notes=""
        requestClientSecret={vi.fn().mockResolvedValue({
          clientSecret: "ek_ephemeral",
          expiresAt: 1756310470
        })}
        connectRealtime={connectRealtime}
        analyzePhrase={analyzePhrase}
      />
    );

    await user.click(screen.getByRole("button", { name: "Start live" }));

    await act(async () => {
      emitEvent({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "I read articles."
      });
    });
    await act(async () => {
      emitEvent({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "And exploring new AI tools regularly."
      });
    });
    await act(async () => {
      emitEvent({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "Find useful method."
      });
    });

    expect(analyzePhrase).toHaveBeenNthCalledWith(1, "I read articles.", "", [
      "I read articles."
    ]);
    expect(analyzePhrase).toHaveBeenNthCalledWith(
      2,
      "And exploring new AI tools regularly.",
      "",
      ["I read articles.", "And exploring new AI tools regularly."]
    );
    expect(analyzePhrase).toHaveBeenNthCalledWith(3, "Find useful method.", "", [
      "I read articles.",
      "And exploring new AI tools regularly.",
      "Find useful method."
    ]);
    expect(
      screen.getByText("I read articles, explore AI tools, and test them in small projects.")
    ).toBeInTheDocument();
  });

  it("sends the latest fifteen transcript turns to phrase analysis", async () => {
    const user = userEvent.setup();
    let emitEvent: (event: RealtimeServerEvent) => void = () => {};
    const connectRealtime = vi.fn().mockImplementation(({ onEvent }) => {
      emitEvent = onEvent;
      return Promise.resolve(createConnection());
    });
    const analyzePhrase = vi.fn().mockImplementation(async (transcript: string) => ({
      analysisTargetText: transcript,
      russianMeaning: transcript,
      isQuestion: false,
      bridgePhrase: "Let me explain.",
      suggestedReplies: []
    }));

    render(
      <TrainingLivePanel
        stream={createStream()}
        notes=""
        requestClientSecret={vi.fn().mockResolvedValue({
          clientSecret: "ek_ephemeral",
          expiresAt: 1756310470
        })}
        connectRealtime={connectRealtime}
        analyzePhrase={analyzePhrase}
      />
    );

    await user.click(screen.getByRole("button", { name: "Start live" }));

    for (let index = 1; index <= 16; index += 1) {
      await act(async () => {
        emitEvent({
          type: "conversation.item.input_audio_transcription.completed",
          transcript: `Turn ${index}.`
        });
      });
    }

    expect(analyzePhrase).toHaveBeenLastCalledWith(
      "Turn 16.",
      "",
      Array.from({ length: 15 }, (_, index) => `Turn ${index + 2}.`)
    );
  });

  it("generates a manual card from a selected transcript group", async () => {
    const user = userEvent.setup();
    let emitEvent: (event: RealtimeServerEvent) => void = () => {};
    const connectRealtime = vi.fn().mockImplementation(({ onEvent }) => {
      emitEvent = onEvent;
      return Promise.resolve(createConnection());
    });
    const analyzePhrase = vi.fn().mockImplementation(
      async (transcript: string, _knowledgeContext: string, recentContext: string[]) =>
        ({
          analysisTargetText:
            transcript ===
            "I read articles.\nAnd exploring new AI tools regularly.\nI test them in small projects."
              ? "I read articles, explore AI tools, and test them in small projects."
              : transcript,
          russianMeaning: "Я читаю статьи, изучаю AI tools и проверяю их в малых проектах.",
          isQuestion: false,
          bridgePhrase: "Let me explain.",
          suggestedReplies: []
        }) satisfies BilingualPhraseAnalysis
    );

    render(
      <TrainingLivePanel
        stream={createStream()}
        notes="Keep it practical."
        requestClientSecret={vi.fn().mockResolvedValue({
          clientSecret: "ek_ephemeral",
          expiresAt: 1756310470
        })}
        connectRealtime={connectRealtime}
        analyzePhrase={analyzePhrase}
      />
    );

    await user.click(screen.getByRole("button", { name: "Start live" }));
    await act(async () => {
      emitEvent({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "I read articles."
      });
    });
    await act(async () => {
      emitEvent({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "And exploring new AI tools regularly."
      });
    });
    await act(async () => {
      emitEvent({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "I test them in small projects."
      });
    });

    await user.click(screen.getByRole("button", { name: "Select" }));
    await user.click(screen.getByRole("button", { name: "Heard I read articles." }));
    await user.click(
      screen.getByRole("button", { name: "Heard And exploring new AI tools regularly." })
    );
    await user.click(screen.getByRole("button", { name: "Heard I test them in small projects." }));
    await user.click(screen.getByRole("button", { name: "Generate card" }));

    expect(analyzePhrase).toHaveBeenLastCalledWith(
      "I read articles.\nAnd exploring new AI tools regularly.\nI test them in small projects.",
      "Keep it practical.",
      [
        "I read articles.",
        "And exploring new AI tools regularly.",
        "I test them in small projects."
      ]
    );
    expect(screen.getByText("Selected group")).toBeInTheDocument();
    expect(
      screen.getByText("I read articles, explore AI tools, and test them in small projects.")
    ).toBeInTheDocument();
    expect(screen.getByText("Paused on selected phrase")).toBeInTheDocument();
  });

  it("keeps manual generation actions visible in the transcript header", async () => {
    const user = userEvent.setup();
    let emitEvent: (event: RealtimeServerEvent) => void = () => {};
    const connectRealtime = vi.fn().mockImplementation(({ onEvent }) => {
      emitEvent = onEvent;
      return Promise.resolve(createConnection());
    });

    render(
      <TrainingLivePanel
        stream={createStream()}
        notes=""
        requestClientSecret={vi.fn().mockResolvedValue({
          clientSecret: "ek_ephemeral",
          expiresAt: 1756310470
        })}
        connectRealtime={connectRealtime}
        analyzePhrase={vi.fn().mockResolvedValue({
          russianMeaning: "Смысл.",
          isQuestion: false,
          bridgePhrase: "Let me explain.",
          suggestedReplies: []
        } satisfies BilingualPhraseAnalysis)}
      />
    );

    await user.click(screen.getByRole("button", { name: "Start live" }));
    await act(async () => {
      emitEvent({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "First selected phrase."
      });
    });

    await user.click(screen.getByRole("button", { name: "Select" }));

    const selectionActions = screen.getByLabelText("Transcript selection actions");
    const transcriptHeader = selectionActions.closest(".transcript-panel-header");

    expect(transcriptHeader).toHaveClass("transcript-panel-header-sticky");
    expect(within(selectionActions).getByRole("button", { name: "Generate card" })).toBeDisabled();
    expect(within(selectionActions).getByRole("button", { name: "Clear selection" })).toBeDisabled();
    expect(within(selectionActions).getByRole("button", { name: "Delete selected" })).toBeDisabled();
    expect(within(selectionActions).getByRole("button", { name: "Generate card" }).textContent).toBe("");
    expect(within(selectionActions).getByRole("button", { name: "Clear selection" }).textContent).toBe("");
    expect(within(selectionActions).getByRole("button", { name: "Delete selected" }).textContent).toBe("");
    expect(screen.getByRole("button", { name: "Jump to latest message" }).textContent).toBe("");
    expect(screen.getByRole("button", { name: "Cancel select" }).textContent).toBe("");
  });

  it("deletes selected transcript messages and their related analysis data", async () => {
    const user = userEvent.setup();
    const confirmDelete = vi.spyOn(window, "confirm").mockReturnValue(true);
    let emitEvent: (event: RealtimeServerEvent) => void = () => {};
    const connectRealtime = vi.fn().mockImplementation(({ onEvent }) => {
      emitEvent = onEvent;
      return Promise.resolve(createConnection());
    });
    const sessionHistoryClient = createInMemorySessionHistoryClient();

    render(
      <TrainingLivePanel
        stream={createStream()}
        notes=""
        requestClientSecret={vi.fn().mockResolvedValue({
          clientSecret: "ek_ephemeral",
          expiresAt: 1756310470
        })}
        connectRealtime={connectRealtime}
        analyzePhrase={vi.fn().mockResolvedValue({
          russianMeaning: "Смысл.",
          isQuestion: false,
          bridgePhrase: "Let me explain.",
          suggestedReplies: []
        } satisfies BilingualPhraseAnalysis)}
        sessionHistoryClient={sessionHistoryClient}
      />
    );

    await user.click(screen.getByRole("button", { name: "Start live" }));
    await act(async () => {
      emitEvent({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "Delete this message."
      });
    });
    await act(async () => {
      emitEvent({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "Keep this message."
      });
    });

    await user.click(screen.getByRole("button", { name: "Select" }));
    await user.click(screen.getByRole("button", { name: "Heard Delete this message." }));
    await user.click(screen.getByRole("button", { name: "Delete selected" }));

    expect(confirmDelete).toHaveBeenCalledWith("Delete 1 selected message?");
    expect(screen.queryByRole("button", { name: "Heard Delete this message." })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Heard Keep this message." })).toBeInTheDocument();
    expect(screen.getByText("0 selected")).toBeInTheDocument();

    await waitFor(() => {
      const latestDraft = vi.mocked(sessionHistoryClient.saveCurrentSession).mock.calls.at(-1)?.[1];
      expect(latestDraft?.transcriptTurns.map((turn) => turn.text)).toEqual(["Keep this message."]);
      expect(latestDraft?.phraseCards.map((card) => card.transcript)).toEqual(["Keep this message."]);
    });
  });

  it("ignores obvious filler transcripts before adding cards or requesting analysis", async () => {
    const user = userEvent.setup();
    let emitEvent: (event: RealtimeServerEvent) => void = () => {};
    const connectRealtime = vi.fn().mockImplementation(({ onEvent }) => {
      emitEvent = onEvent;
      return Promise.resolve(createConnection());
    });
    const analyzePhrase = vi.fn().mockResolvedValue({
      russianMeaning: "Я сделал небольшой инструмент.",
      isQuestion: false,
      bridgePhrase: "Let me explain.",
      suggestedReplies: []
    } satisfies BilingualPhraseAnalysis);

    render(
      <TrainingLivePanel
        stream={createStream()}
        notes=""
        requestClientSecret={vi.fn().mockResolvedValue({
          clientSecret: "ek_ephemeral",
          expiresAt: 1756310470
        })}
        connectRealtime={connectRealtime}
        analyzePhrase={analyzePhrase}
      />
    );

    await user.click(screen.getByRole("button", { name: "Start live" }));

    await act(async () => {
      emitEvent({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "."
      });
    });
    await act(async () => {
      emitEvent({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "Uh."
      });
    });
    await act(async () => {
      emitEvent({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "Ah"
      });
    });
    await act(async () => {
      emitEvent({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "I built a small tool."
      });
    });

    expect(screen.queryByText(".")).not.toBeInTheDocument();
    expect(screen.queryByText("Uh.")).not.toBeInTheDocument();
    expect(screen.queryByText("Ah")).not.toBeInTheDocument();
    expect(screen.getAllByText("I built a small tool.").length).toBeGreaterThan(0);
    expect(analyzePhrase).toHaveBeenCalledTimes(1);
    expect(analyzePhrase).toHaveBeenCalledWith("I built a small tool.", "", [
      "I built a small tool."
    ]);
  });

  it("keeps Russian transcript turns instead of treating Cyrillic speech as noise", async () => {
    const user = userEvent.setup();
    let emitEvent: (event: RealtimeServerEvent) => void = () => {};
    const connectRealtime = vi.fn().mockImplementation(({ onEvent }) => {
      emitEvent = onEvent;
      return Promise.resolve(createConnection());
    });
    const analyzePhrase = vi.fn().mockResolvedValue({
      russianMeaning: "Расскажи о последнем проекте.",
      isQuestion: false,
      bridgePhrase: "Let me answer.",
      suggestedReplies: []
    } satisfies BilingualPhraseAnalysis);

    render(
      <TrainingLivePanel
        stream={createStream()}
        notes=""
        requestClientSecret={vi.fn().mockResolvedValue({
          clientSecret: "ek_ephemeral",
          expiresAt: 1756310470
        })}
        connectRealtime={connectRealtime}
        analyzePhrase={analyzePhrase}
      />
    );

    await user.click(screen.getByRole("button", { name: "Start live" }));

    await act(async () => {
      emitEvent({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "Расскажи о последнем проекте."
      });
    });

    expect(screen.getAllByText("Расскажи о последнем проекте.").length).toBeGreaterThan(0);
    expect(analyzePhrase).toHaveBeenCalledWith("Расскажи о последнем проекте.", "", [
      "Расскажи о последнем проекте."
    ]);
  });

  it("can pause and resume Following live from the suggestions card", async () => {
    const user = userEvent.setup();
    let emitEvent: (event: RealtimeServerEvent) => void = () => {};
    const connectRealtime = vi.fn().mockImplementation(({ onEvent }) => {
      emitEvent = onEvent;
      return Promise.resolve(createConnection());
    });
    const analyzePhrase = vi.fn().mockImplementation(
      async (transcript: string) =>
        ({
          russianMeaning: transcript === "First phrase?" ? "Первый смысл." : "Второй смысл.",
          isQuestion: transcript.endsWith("?"),
          bridgePhrase: "Let me answer.",
          suggestedReplies: [
            {
              shortLabel: "Simple",
              shortLabelTranslation: "Просто",
              fullSentence:
                transcript === "First phrase?"
                  ? "I built a small tool."
                  : "I used data cleaning.",
              fullSentenceTranslation:
                transcript === "First phrase?"
                  ? "Я сделал небольшой инструмент."
                  : "Я использовал очистку данных.",
              whyUse: "Когда нужен простой короткий ответ."
            }
          ]
        }) satisfies BilingualPhraseAnalysis
    );

    render(
      <TrainingLivePanel
        stream={createStream()}
        notes=""
        requestClientSecret={vi.fn().mockResolvedValue({
          clientSecret: "ek_ephemeral",
          expiresAt: 1756310470
        })}
        connectRealtime={connectRealtime}
        analyzePhrase={analyzePhrase}
      />
    );

    await user.click(screen.getByRole("button", { name: "Start live" }));
    await act(async () => {
      emitEvent({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "First phrase?"
      });
    });

    const suggestionsPanel = screen.getByLabelText("Current phrase suggestions");
    const pauseFollowingButton = within(suggestionsPanel).getByRole("button", {
      name: "Pause following live"
    });

    expect(pauseFollowingButton).toHaveClass("follow-live-pill");

    await user.click(pauseFollowingButton);

    expect(screen.getByText("Paused on selected phrase")).toBeInTheDocument();

    await act(async () => {
      emitEvent({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "Second phrase."
      });
    });

    expect(screen.getAllByText("Second phrase.").length).toBeGreaterThan(0);
    expect(screen.getByText("Первый смысл.")).toBeInTheDocument();
    expect(screen.queryByText("Второй смысл.")).not.toBeInTheDocument();

    const followLiveButton = within(suggestionsPanel).getByRole("button", { name: "Follow live" });

    expect(followLiveButton).toHaveClass("follow-live-button");

    await user.click(followLiveButton);

    expect(screen.getByText("Второй смысл.")).toBeInTheDocument();
  });

  it("brings the transcript into view and selects the latest message", async () => {
    const user = userEvent.setup();
    let emitEvent: (event: RealtimeServerEvent) => void = () => {};
    let keepLatestAnalysisPending: (() => void) | null = null;
    const connectRealtime = vi.fn().mockImplementation(({ onEvent }) => {
      emitEvent = onEvent;
      return Promise.resolve(createConnection());
    });
    const analyzePhrase = vi.fn().mockImplementation((transcript: string) => {
      if (transcript === "Latest phrase.") {
        return new Promise<BilingualPhraseAnalysis>((resolve) => {
          keepLatestAnalysisPending = () => resolve({
            russianMeaning: "Последний смысл.",
            isQuestion: false,
            bridgePhrase: "Let me continue.",
            suggestedReplies: []
          });
        });
      }

      return Promise.resolve({
        russianMeaning: "Первый смысл.",
        isQuestion: false,
        bridgePhrase: "Let me continue.",
        suggestedReplies: []
      } satisfies BilingualPhraseAnalysis);
    });

    render(
      <TrainingLivePanel
        stream={createStream()}
        notes=""
        requestClientSecret={vi.fn().mockResolvedValue({
          clientSecret: "ek_ephemeral",
          expiresAt: 1756310470
        })}
        connectRealtime={connectRealtime}
        analyzePhrase={analyzePhrase}
      />
    );

    const transcript = screen.getByLabelText("Conversation transcript");
    const conversationPanel = transcript.closest(".conversation-panel") as HTMLDivElement;
    const controlRail = screen.getByLabelText("Training Mode controls");
    const scrollTo = vi.fn();
    const pageScrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    transcript.scrollTo = scrollTo;
    conversationPanel.getBoundingClientRect = vi.fn().mockReturnValue({
      top: 500
    } as DOMRect);
    controlRail.getBoundingClientRect = vi.fn().mockReturnValue({
      height: 120
    } as DOMRect);
    Object.defineProperty(transcript, "scrollHeight", { configurable: true, value: 640 });

    const jumpToLatestButton = screen.getByRole("button", { name: "Jump to latest message" });

    expect(jumpToLatestButton).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Start live" }));
    await act(async () => {
      emitEvent({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "First phrase."
      });
    });

    await user.click(screen.getByRole("button", { name: "Pause following live" }));

    await act(async () => {
      emitEvent({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "Latest phrase."
      });
    });

    expect(jumpToLatestButton).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Heard First phrase." }).closest("article")
    ).toHaveClass("transcript-turn-selected");

    await user.click(jumpToLatestButton);

    expect(pageScrollTo).toHaveBeenCalledWith({ behavior: "smooth", top: 368 });
    expect(scrollTo).toHaveBeenLastCalledWith({ behavior: "smooth", top: 640 });
    expect(
      screen.getByRole("button", { name: "Heard Latest phrase." }).closest("article")
    ).toHaveClass("transcript-turn-selected");
    expect(screen.getByText("Loading phrase details...")).toBeInTheDocument();
    expect(screen.getByText("Paused on selected phrase")).toBeInTheDocument();

    await act(async () => {
      keepLatestAnalysisPending?.();
    });
    pageScrollTo.mockRestore();
  });

  it("keeps the selected reply expanded while a background phrase is being analyzed", async () => {
    const user = userEvent.setup();
    let emitEvent: (event: RealtimeServerEvent) => void = () => {};
    let resolveBackgroundAnalysis: (analysis: BilingualPhraseAnalysis) => void = () => {};
    const connectRealtime = vi.fn().mockImplementation(({ onEvent }) => {
      emitEvent = onEvent;
      return Promise.resolve(createConnection());
    });
    const analyzePhrase = vi.fn().mockImplementation((transcript: string) => {
      if (transcript === "First phrase?") {
        return Promise.resolve({
          russianMeaning: "Первый смысл.",
          isQuestion: true,
          bridgePhrase: "Let me answer.",
          suggestedReplies: [
            {
              shortLabel: "Simple",
              shortLabelTranslation: "Просто",
              fullSentence: "I built a small tool.",
              fullSentenceTranslation: "Я сделал небольшой инструмент.",
              whyUse: "Когда нужен простой короткий ответ."
            }
          ]
        } satisfies BilingualPhraseAnalysis);
      }

      return new Promise<BilingualPhraseAnalysis>((resolve) => {
        resolveBackgroundAnalysis = resolve;
      });
    });

    render(
      <TrainingLivePanel
        stream={createStream()}
        notes=""
        requestClientSecret={vi.fn().mockResolvedValue({
          clientSecret: "ek_ephemeral",
          expiresAt: 1756310470
        })}
        connectRealtime={connectRealtime}
        analyzePhrase={analyzePhrase}
      />
    );

    await user.click(screen.getByRole("button", { name: "Start live" }));
    await act(async () => {
      emitEvent({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "First phrase?"
      });
    });
    await user.click(screen.getByRole("button", { name: "Simple Просто" }));

    await act(async () => {
      emitEvent({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "Second phrase."
      });
    });

    expect(screen.getByText("I built a small tool.")).toBeInTheDocument();
    expect(screen.getByText("Я сделал небольшой инструмент.")).toBeInTheDocument();
    expect(screen.queryByText("Analyzing phrase...")).not.toBeInTheDocument();

    await act(async () => {
      resolveBackgroundAnalysis({
        russianMeaning: "Второй смысл.",
        isQuestion: false,
        bridgePhrase: "Let me continue.",
        suggestedReplies: []
      });
    });

    expect(screen.getByText("I built a small tool.")).toBeInTheDocument();
    expect(screen.queryByText("Второй смысл.")).not.toBeInTheDocument();
  });

  it("shows progress when a selected transcript turn is still preloading analysis", async () => {
    const user = userEvent.setup();
    let emitEvent: (event: RealtimeServerEvent) => void = () => {};
    let resolveBackgroundAnalysis: (analysis: BilingualPhraseAnalysis) => void = () => {};
    const connectRealtime = vi.fn().mockImplementation(({ onEvent }) => {
      emitEvent = onEvent;
      return Promise.resolve(createConnection());
    });
    const analyzePhrase = vi.fn().mockImplementation((transcript: string) => {
      if (transcript === "First phrase?") {
        return Promise.resolve({
          russianMeaning: "Первый смысл.",
          isQuestion: true,
          bridgePhrase: "Let me answer.",
          suggestedReplies: [
            {
              shortLabel: "Simple",
              shortLabelTranslation: "Просто",
              fullSentence: "I built a small tool.",
              fullSentenceTranslation: "Я сделал небольшой инструмент.",
              whyUse: "Когда нужен простой короткий ответ."
            }
          ]
        } satisfies BilingualPhraseAnalysis);
      }

      return new Promise<BilingualPhraseAnalysis>((resolve) => {
        resolveBackgroundAnalysis = resolve;
      });
    });

    render(
      <TrainingLivePanel
        stream={createStream()}
        notes=""
        requestClientSecret={vi.fn().mockResolvedValue({
          clientSecret: "ek_ephemeral",
          expiresAt: 1756310470
        })}
        connectRealtime={connectRealtime}
        analyzePhrase={analyzePhrase}
      />
    );

    await user.click(screen.getByRole("button", { name: "Start live" }));
    await act(async () => {
      emitEvent({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "First phrase?"
      });
    });
    await user.click(screen.getByRole("button", { name: "Simple Просто" }));

    await act(async () => {
      emitEvent({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "Second phrase."
      });
    });

    await user.click(screen.getByRole("button", { name: "Heard Second phrase." }));

    expect(screen.getAllByText("Second phrase.").length).toBeGreaterThan(1);
    expect(screen.getByText("Loading phrase details...")).toBeInTheDocument();
    expect(analyzePhrase).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolveBackgroundAnalysis({
        russianMeaning: "Второй смысл.",
        isQuestion: false,
        bridgePhrase: "Let me continue.",
        suggestedReplies: []
      });
    });

    expect(screen.getByText("Второй смысл.")).toBeInTheDocument();
    expect(screen.queryByText("Loading phrase details...")).not.toBeInTheDocument();
    expect(analyzePhrase).toHaveBeenCalledTimes(2);
  });

  it("generates or regenerates a card for the current transcript message", async () => {
    const user = userEvent.setup();
    let emitEvent: (event: RealtimeServerEvent) => void = () => {};
    let analysisCall = 0;
    const connectRealtime = vi.fn().mockImplementation(({ onEvent }) => {
      emitEvent = onEvent;
      return Promise.resolve(createConnection());
    });
    const analyzePhrase = vi.fn().mockImplementation(async () => {
      analysisCall += 1;
      return {
        russianMeaning: analysisCall === 1 ? "Первый смысл." : "Обновлённый смысл.",
        isQuestion: false,
        bridgePhrase: "Let me explain.",
        suggestedReplies: []
      } satisfies BilingualPhraseAnalysis;
    });

    render(
      <TrainingLivePanel
        stream={createStream()}
        notes=""
        requestClientSecret={vi.fn().mockResolvedValue({
          clientSecret: "ek_ephemeral",
          expiresAt: 1756310470
        })}
        connectRealtime={connectRealtime}
        analyzePhrase={analyzePhrase}
        sessionHistoryClient={createEmptySessionHistoryClient()}
      />
    );

    await user.click(screen.getByRole("button", { name: "Start live" }));
    await act(async () => {
      emitEvent({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "Current message."
      });
    });

    expect(screen.getByText("Первый смысл.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Regenerate card" }));

    expect(analyzePhrase).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Обновлённый смысл.")).toBeInTheDocument();
    expect(screen.queryByText("Первый смысл.")).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Heard Current message." })).toHaveLength(1);
  });

  it("generates a missing card for the current saved transcript message", async () => {
    const user = userEvent.setup();
    const analyzePhrase = vi.fn().mockResolvedValue({
      russianMeaning: "Смысл восстановленной карточки.",
      isQuestion: false,
      bridgePhrase: "Let me explain.",
      suggestedReplies: []
    } satisfies BilingualPhraseAnalysis);
    const savedSession: SessionHistoryEntry = {
      version: 1,
      id: "session-without-card",
      sourceLabel: "Saved session",
      knowledgeContext: "",
      savedAt: "2026-07-11T12:00:00.000Z",
      createdAt: "2026-07-11T12:00:00.000Z",
      updatedAt: "2026-07-11T12:00:00.000Z",
      transcriptTurns: [
        { id: "training-phrase-0", speakerLabel: "Heard", text: "Message without card." }
      ],
      phraseCards: [],
      selectedReplies: [],
      usedBridgePhrases: []
    };

    render(
      <TrainingLivePanel
        stream={createStream()}
        notes=""
        analyzePhrase={analyzePhrase}
        sessionHistoryClient={createInMemorySessionHistoryClient([savedSession])}
        autoOpenLatestSession
      />
    );

    expect(await screen.findByText("No card yet. Use Generate card.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Generate card" }));

    expect(analyzePhrase).toHaveBeenCalledWith("Message without card.", "", [
      "Message without card."
    ]);
    expect(screen.getByText("Смысл восстановленной карточки.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Regenerate card" })).toBeInTheDocument();
  });

  it("saves local session history and opens the latest saved session", async () => {
    const user = userEvent.setup();
    let emitEvent: (event: RealtimeServerEvent) => void = () => {};
    const copyText = vi.fn();
    const savedSessions: SessionHistoryEntry[] = [];
    const sessionHistoryClient = createInMemorySessionHistoryClient(savedSessions);
    const connectRealtime = vi.fn().mockImplementation(({ onEvent }) => {
      emitEvent = onEvent;
      return Promise.resolve(createConnection());
    });
    const analyzePhrase = vi.fn().mockResolvedValue({
      russianMeaning: "Можешь рассказать о последнем проекте?",
      isQuestion: true,
      bridgePhrase: "Sure, let me start with the context.",
      suggestedReplies: [
        {
          shortLabel: "Project context",
          shortLabelTranslation: "Контекст проекта",
          fullSentence: "Sure, the project focused on improving a core user workflow.",
          fullSentenceTranslation:
            "Конечно, проект был сфокусирован на улучшении основного пользовательского сценария.",
          whyUse: "Когда нужно начать с контекста проекта."
        }
      ]
    } satisfies BilingualPhraseAnalysis);
    const firstRender = render(
      <TrainingLivePanel
        stream={createStream()}
        notes="Mention dependency review."
        sourceLabel="ChatGPT Real Voice practice"
        requestClientSecret={vi.fn().mockResolvedValue({
          clientSecret: "ek_ephemeral",
          expiresAt: 1756310470
        })}
        connectRealtime={connectRealtime}
        analyzePhrase={analyzePhrase}
        copyText={copyText}
        sessionHistoryClient={sessionHistoryClient}
        createSessionId={() => "session-1"}
      />
    );

    await user.click(screen.getByRole("button", { name: "Start live" }));
    await act(async () => {
      emitEvent({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "Can you walk me through your recent project?"
      });
    });
    await user.click(screen.getByRole("button", { name: "Project context Контекст проекта" }));
    await user.click(screen.getByRole("button", { name: "Copy bridge phrase" }));

    expect(analyzePhrase).toHaveBeenCalledWith(
      "Can you walk me through your recent project?",
      "Mention dependency review.",
      ["Can you walk me through your recent project?"]
    );
    await waitFor(() => {
      expect(sessionHistoryClient.saveCurrentSession).toHaveBeenCalledWith(
        "session-1",
        expect.objectContaining({
          sourceLabel: "ChatGPT Real Voice practice"
        })
      );
    });

    firstRender.unmount();

    render(
      <TrainingLivePanel
        stream={createStream()}
        notes=""
        sourceLabel="Another practice"
        copyText={copyText}
        sessionHistoryClient={sessionHistoryClient}
        createSessionId={() => "session-2"}
      />
    );

    await user.click(screen.getByRole("button", { name: "Sessions" }));

    const sessionsDrawer = screen.getByRole("dialog", { name: "Saved sessions" });

    expect(sessionsDrawer).toHaveClass("session-history-drawer");
    expect(
      within(sessionsDrawer).getByRole("button", {
        name: /Can you walk me through your recent project/
      })
    ).toBeInTheDocument();

    await user.click(within(sessionsDrawer).getByRole("button", { name: "Open latest" }));

    expect(screen.getAllByText("Can you walk me through your recent project?").length).toBeGreaterThan(
      0
    );
    expect(screen.getByText("Можешь рассказать о последнем проекте?")).toBeInTheDocument();
    expect(
      screen.getByText("Sure, the project focused on improving a core user workflow.")
    ).toBeInTheDocument();
    expect(screen.getByText("Used bridge phrases: 1")).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Saved sessions" })).toBeInTheDocument();

    const saveCallsBeforeBridgeCopy = vi.mocked(sessionHistoryClient.saveCurrentSession).mock.calls
      .length;

    await user.click(screen.getByRole("button", { name: "Copy bridge phrase" }));

    await waitFor(() => {
      expect(vi.mocked(sessionHistoryClient.saveCurrentSession).mock.calls.length).toBeGreaterThan(
        saveCallsBeforeBridgeCopy
      );
    });
    expect(vi.mocked(sessionHistoryClient.saveCurrentSession).mock.lastCall).toEqual([
      "session-1",
      expect.objectContaining({
        usedBridgePhrases: expect.arrayContaining([
          expect.objectContaining({
            english: "Let me think."
          })
        ])
      })
    ]);
  });

  it("auto-opens the latest saved session when requested on mount", async () => {
    const savedSessions: SessionHistoryEntry[] = [
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
    ];

    render(
      <TrainingLivePanel
        stream={null}
        notes="Mention EchoGuide work."
        autoOpenLatestSession
        onRequestMicrophone={vi.fn()}
        sessionHistoryClient={createInMemorySessionHistoryClient(savedSessions)}
      />
    );

    expect((await screen.findAllByText("What did you build in EchoGuide?")).length).toBeGreaterThan(
      0
    );
    expect(screen.getByText("Что ты построил в EchoGuide?")).toBeInTheDocument();
    expect(screen.queryByText("Session loaded.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start live" })).toBeInTheDocument();
  });

  it("repairs duplicate restored ids and continues after the highest phrase sequence", async () => {
    const user = userEvent.setup();
    let emitEvent: (event: RealtimeServerEvent) => void = () => {};
    const connectRealtime = vi.fn().mockImplementation(({ onEvent }) => {
      emitEvent = onEvent;
      return Promise.resolve(createConnection());
    });
    const savedSessions: SessionHistoryEntry[] = [
      {
        version: 1,
        id: "session-duplicate-ids",
        savedAt: "2026-07-11T00:40:00.000Z",
        createdAt: "2026-07-11T00:30:00.000Z",
        updatedAt: "2026-07-11T00:40:00.000Z",
        sourceLabel: "Interview practice",
        knowledgeContext: "",
        transcriptTurns: [
          ...Array.from({ length: 48 }, (_, index) => ({
            id: `training-phrase-${20 + index}`,
            speakerLabel: "Heard" as const,
            text: `Earlier phrase ${index}.`
          })),
          { id: "training-phrase-50", speakerLabel: "Heard", text: "Next five questions." },
          {
            id: "training-phrase-50",
            speakerLabel: "Heard",
            text: "What's your approach to prioritizing when everything feels urgent?"
          }
        ],
        phraseCards: [
          {
            id: "training-phrase-50",
            transcript: "Next five questions.",
            source: "auto",
            analysis: {
              analysisTargetText: "Next five questions.",
              russianMeaning: "Следующие пять вопросов.",
              isQuestion: false,
              bridgePhrase: "Let's continue.",
              suggestedReplies: []
            }
          },
          {
            id: "training-phrase-50",
            transcript: "What's your approach to prioritizing when everything feels urgent?",
            source: "auto",
            analysis: {
              analysisTargetText: "What's your approach to prioritizing when everything feels urgent?",
              russianMeaning: "Как вы расставляете приоритеты?",
              isQuestion: true,
              bridgePhrase: "Let me explain.",
              suggestedReplies: []
            }
          }
        ],
        selectedReplies: [],
        usedBridgePhrases: []
      }
    ];
    const sessionHistoryClient = createInMemorySessionHistoryClient(savedSessions);

    render(
      <TrainingLivePanel
        stream={createStream()}
        notes=""
        autoOpenLatestSession
        requestClientSecret={vi.fn().mockResolvedValue({
          clientSecret: "ek_ephemeral",
          expiresAt: 1756310470
        })}
        connectRealtime={connectRealtime}
        analyzePhrase={vi.fn().mockResolvedValue({
          russianMeaning: "Новый смысл.",
          isQuestion: false,
          bridgePhrase: "Let me continue.",
          suggestedReplies: []
        })}
        sessionHistoryClient={sessionHistoryClient}
      />
    );

    expect(await screen.findByText("Как вы расставляете приоритеты?")).toBeInTheDocument();
    expect(screen.queryByText("Следующие пять вопросов.")).not.toBeInTheDocument();

    const selectedTurns = document.querySelectorAll(".transcript-turn-selected");

    expect(selectedTurns).toHaveLength(1);
    expect(selectedTurns[0]).toHaveTextContent(
      "What's your approach to prioritizing when everything feels urgent?"
    );

    await user.click(screen.getByRole("button", { name: "Start live" }));
    await act(async () => {
      emitEvent({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "A new phrase after reopening."
      });
    });

    await waitFor(() => {
      expect(savedSessions[0]?.transcriptTurns.at(-1)?.id).toBe("training-phrase-68");
    });
  });

  it("keeps an opened session in its original drawer position after auto-save", async () => {
    const user = userEvent.setup();
    const savedSessions: SessionHistoryEntry[] = [
      {
        version: 1,
        id: "session-newer",
        savedAt: "2026-07-09T10:00:00.000Z",
        createdAt: "2026-07-09T10:00:00.000Z",
        updatedAt: "2026-07-09T10:00:00.000Z",
        sourceLabel: "Interview practice",
        knowledgeContext: "",
        transcriptTurns: [
          { id: "training-newer", speakerLabel: "Heard", text: "Newer session" }
        ],
        phraseCards: [],
        selectedReplies: [],
        usedBridgePhrases: []
      },
      {
        version: 1,
        id: "session-older",
        savedAt: "2026-07-09T09:00:00.000Z",
        createdAt: "2026-07-09T09:00:00.000Z",
        updatedAt: "2026-07-09T09:00:00.000Z",
        sourceLabel: "Interview practice",
        knowledgeContext: "",
        transcriptTurns: [
          { id: "training-older", speakerLabel: "Heard", text: "Older session" }
        ],
        phraseCards: [],
        selectedReplies: [],
        usedBridgePhrases: []
      }
    ];
    const sessionHistoryClient = createInMemorySessionHistoryClient(savedSessions);

    render(
      <TrainingLivePanel
        stream={createStream()}
        notes=""
        sessionHistoryClient={sessionHistoryClient}
      />
    );

    await user.click(screen.getByRole("button", { name: "Sessions" }));

    const sessionsDrawer = screen.getByRole("dialog", { name: "Saved sessions" });
    const getVisibleSessionTitles = () =>
      Array.from(sessionsDrawer.querySelectorAll(".session-history-title")).map(
        (title) => title.textContent
      );

    expect(getVisibleSessionTitles()).toEqual(["Newer session", "Older session"]);

    await user.click(within(sessionsDrawer).getByRole("button", { name: /Older session/ }));

    await waitFor(() => {
      expect(sessionHistoryClient.saveCurrentSession).toHaveBeenCalledWith(
        "session-older",
        expect.any(Object)
      );
      expect(getVisibleSessionTitles()).toEqual(["Newer session", "Older session"]);
    });
  });

  it("shows the latest saved message with created and updated timestamps in the history list", async () => {
    const user = userEvent.setup();
    const savedSessions: SessionHistoryEntry[] = [
      {
        version: 1 as const,
        id: "session-1",
        savedAt: "2026-07-08T10:15:00.000Z",
        createdAt: "2026-07-08T10:00:00.000Z",
        updatedAt: "2026-07-08T10:15:00.000Z",
        sourceLabel: "Interview practice",
        knowledgeContext: "",
        transcriptTurns: [
          {
            id: "training-phrase-0",
            speakerLabel: "Heard",
            text: "This earlier message should not name the session."
          },
          {
            id: "training-phrase-1",
            speakerLabel: "Heard",
            text: "This latest message should name the session."
          }
        ],
        phraseCards: [],
        selectedReplies: [],
        usedBridgePhrases: []
      }
    ];

    render(
      <TrainingLivePanel
        stream={createStream()}
        notes=""
        sourceLabel="Another practice"
        sessionHistoryClient={{
          loadSessions: vi.fn().mockResolvedValue(savedSessions),
          saveCurrentSession: vi.fn(),
          deleteSession: vi.fn(async () => [])
        }}
      />
    );

    await user.click(screen.getByRole("button", { name: "Sessions" }));

    const sessionButton = screen.getByRole("button", {
      name: /This latest message should name the session/
    });

    expect(within(sessionButton).getByText("Created")).toBeInTheDocument();
    expect(within(sessionButton).getByText("Updated")).toBeInTheDocument();
    expect(
      within(sessionButton).queryByText("This earlier message should not name the session.")
    ).not.toBeInTheDocument();
    expect(within(sessionButton).queryByText("Interview practice")).not.toBeInTheDocument();
    expect(sessionButton.querySelector('time[datetime="2026-07-08T10:00:00.000Z"]')).not.toBeNull();
    expect(sessionButton.querySelector('time[datetime="2026-07-08T10:15:00.000Z"]')).not.toBeNull();
  });

  it("deletes a saved session from the history list after confirmation", async () => {
    const user = userEvent.setup();
    const confirmDelete = vi.spyOn(window, "confirm").mockReturnValue(true);
    const savedSessions: SessionHistoryEntry[] = [
      {
        version: 1 as const,
        id: "session-1",
        savedAt: "2026-07-08T10:15:00.000Z",
        createdAt: "2026-07-08T10:00:00.000Z",
        updatedAt: "2026-07-08T10:15:00.000Z",
        sourceLabel: "Interview practice",
        knowledgeContext: "",
        transcriptTurns: [
          {
            id: "training-phrase-1",
            speakerLabel: "Heard",
            text: "Delete this saved message."
          }
        ],
        phraseCards: [],
        selectedReplies: [],
        usedBridgePhrases: []
      },
      {
        version: 1 as const,
        id: "session-2",
        savedAt: "2026-07-08T10:20:00.000Z",
        createdAt: "2026-07-08T10:18:00.000Z",
        updatedAt: "2026-07-08T10:20:00.000Z",
        sourceLabel: "Interview practice",
        knowledgeContext: "",
        transcriptTurns: [
          {
            id: "training-phrase-2",
            speakerLabel: "Heard",
            text: "Keep this saved message."
          }
        ],
        phraseCards: [],
        selectedReplies: [],
        usedBridgePhrases: []
      }
    ];
    const deleteSession = vi.fn(async (sessionId: string) => {
      const existingIndex = savedSessions.findIndex((session) => session.id === sessionId);

      if (existingIndex >= 0) {
        savedSessions.splice(existingIndex, 1);
      }

      return [...savedSessions];
    });

    render(
      <TrainingLivePanel
        stream={createStream()}
        notes=""
        sourceLabel="Another practice"
        sessionHistoryClient={{
          loadSessions: vi.fn().mockResolvedValue(savedSessions),
          saveCurrentSession: vi.fn(),
          deleteSession
        }}
      />
    );

    await user.click(screen.getByRole("button", { name: "Sessions" }));

    const deleteButtons = screen.getAllByRole("button", { name: "Delete session" });

    expect(deleteButtons[0]?.textContent).toBe("");
    expect(deleteButtons[0]?.querySelector("svg")).not.toBeNull();

    await user.click(deleteButtons[0]!);

    expect(confirmDelete).toHaveBeenCalledWith("Delete this saved session?");
    expect(deleteSession).toHaveBeenCalledWith("session-1");
    expect(screen.queryByRole("button", { name: /Delete this saved message/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Keep this saved message/ })).toBeInTheDocument();
  });

  it("auto-saves sessions to disk client and starts a new session without manual save", async () => {
    const user = userEvent.setup();
    let emitEvent: (event: RealtimeServerEvent) => void = () => {};
    let sessionSequence = 0;
    const savedSessions: SessionHistoryEntry[] = [];
    const connectRealtime = vi.fn().mockImplementation(({ onEvent }) => {
      emitEvent = onEvent;
      return Promise.resolve(createConnection());
    });
    const analyzePhrase = vi.fn().mockImplementation(
      async (transcript: string) =>
        ({
          russianMeaning: transcript === "First question?" ? "Первый вопрос." : "Второй вопрос.",
          isQuestion: transcript.endsWith("?"),
          bridgePhrase: "Let me answer.",
          suggestedReplies: []
        }) satisfies BilingualPhraseAnalysis
    );
    const sessionHistoryClient = createInMemorySessionHistoryClient(savedSessions);

    render(
      <TrainingLivePanel
        stream={createStream()}
        notes="Use short answers."
        sourceLabel="ChatGPT Real Voice practice"
        requestClientSecret={vi.fn().mockResolvedValue({
          clientSecret: "ek_ephemeral",
          expiresAt: 1756310470
        })}
        connectRealtime={connectRealtime}
        analyzePhrase={analyzePhrase}
        sessionHistoryClient={sessionHistoryClient}
        createSessionId={() => {
          sessionSequence += 1;
          return `session-${sessionSequence}`;
        }}
      />
    );

    expect(screen.queryByRole("button", { name: "Save session" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Start live" }));
    await act(async () => {
      emitEvent({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "First question?"
      });
    });

    await waitFor(() => {
      expect(sessionHistoryClient.saveCurrentSession).toHaveBeenCalledWith(
        "session-1",
        expect.objectContaining({
          sourceLabel: "ChatGPT Real Voice practice",
          knowledgeContext: "Use short answers.",
          transcriptTurns: [
            expect.objectContaining({
              text: "First question?"
            })
          ]
        })
      );
    });
    expect(screen.queryByText("Final transcript received.")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "New session" }));

    expect(screen.getByText("Waiting for transcript...")).toBeInTheDocument();
    expect(screen.queryByText("New session started.")).not.toBeInTheDocument();

    await act(async () => {
      emitEvent({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "Second question?"
      });
    });

    await waitFor(() => {
      expect(sessionHistoryClient.saveCurrentSession).toHaveBeenCalledWith(
        "session-2",
        expect.objectContaining({
          transcriptTurns: [
            expect.objectContaining({
              text: "Second question?"
            })
          ]
        })
      );
    });
  });
});
