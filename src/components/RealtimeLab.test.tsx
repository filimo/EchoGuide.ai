import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RealtimeLab } from "./RealtimeLab";
import type {
  RealtimeAudioStats,
  RealtimeServerEvent,
  RealtimeTranscriptionConnection
} from "../realtime/realtimeConnection";
import type { BilingualPhraseAnalysis } from "../realtime/bilingualAnalysis";

function createStream(track: Partial<MediaStreamTrack> = {}): MediaStream {
  return {
    getTracks: () => [{ stop: vi.fn(), ...track }]
  } as unknown as MediaStream;
}

function createConnection(
  overrides: Partial<RealtimeTranscriptionConnection> = {}
): RealtimeTranscriptionConnection {
  return {
    sendEvent: vi.fn(),
    clearAudio: vi.fn(),
    commitAudio: vi.fn(),
    collectStats: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    ...overrides
  };
}

describe("Realtime Transcription Lab", () => {
  it("starts microphone before requesting a Realtime VAD client secret by default", async () => {
    const user = userEvent.setup();
    const stream = createStream();
    const requestMicrophone = vi.fn().mockResolvedValue({ status: "active", stream });
    const requestClientSecret = vi.fn().mockResolvedValue({
      clientSecret: "ek_ephemeral",
      expiresAt: 1756310470,
      sessionId: "sess_123"
    });
    const connectRealtime = vi.fn().mockResolvedValue(createConnection());

    render(
      <RealtimeLab
        requestMicrophone={requestMicrophone}
        requestClientSecret={requestClientSecret}
        connectRealtime={connectRealtime}
      />
    );

    expect(screen.getByRole("heading", { name: "Realtime Transcription Lab" })).toBeInTheDocument();
    expect(
      screen.getByText("Speak normally. Realtime VAD should segment turns automatically.")
    ).toBeInTheDocument();
    expect(requestClientSecret).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Start microphone" }));
    await user.click(screen.getByRole("button", { name: "Connect Realtime" }));

    expect(requestMicrophone).toHaveBeenCalledOnce();
    expect(requestClientSecret).toHaveBeenCalledWith("realtime-vad");
    expect(connectRealtime).toHaveBeenCalledWith(
      expect.objectContaining({
        stream,
        clientSecret: "ek_ephemeral"
      })
    );
    expect(screen.getByText("Realtime: connected")).toBeInTheDocument();
  });

  it("can connect using official-style realtime VAD mode", async () => {
    const user = userEvent.setup();
    const stream = createStream();
    const requestClientSecret = vi.fn().mockResolvedValue({
      clientSecret: "ek_ephemeral",
      expiresAt: 1756310470
    });
    const connectRealtime = vi.fn().mockResolvedValue(createConnection());

    render(
      <RealtimeLab
        requestMicrophone={vi.fn().mockResolvedValue({ status: "active", stream })}
        requestClientSecret={requestClientSecret}
        connectRealtime={connectRealtime}
      />
    );

    await user.click(screen.getByRole("button", { name: "Start microphone" }));
    await user.click(screen.getByRole("button", { name: "Connect Realtime" }));

    expect(requestClientSecret).toHaveBeenCalledWith("realtime-vad");
    expect(connectRealtime).toHaveBeenCalledWith(
      expect.objectContaining({
        stream,
        clientSecret: "ek_ephemeral",
        sessionUpdateAfterOpen: {
          type: "transcription",
          audio: {
            input: expect.objectContaining({
              turn_detection: expect.objectContaining({
                type: "server_vad",
                threshold: 0.5,
                prefix_padding_ms: 300,
                silence_duration_ms: 1200
              })
            })
          }
        }
      })
    );
    expect(screen.queryByRole("button", { name: "Start phrase" })).not.toBeInTheDocument();
    expect(screen.getAllByText("VAD: server_vad 0.50 / 300ms / 1200ms").length).toBeGreaterThan(
      0
    );
  });

  it("sends adjustable semantic VAD settings after connect", async () => {
    const user = userEvent.setup();
    const stream = createStream();
    const requestClientSecret = vi.fn().mockResolvedValue({
      clientSecret: "ek_ephemeral",
      expiresAt: 1756310470
    });
    const connectRealtime = vi.fn().mockResolvedValue(createConnection());

    render(
      <RealtimeLab
        requestMicrophone={vi.fn().mockResolvedValue({ status: "active", stream })}
        requestClientSecret={requestClientSecret}
        connectRealtime={connectRealtime}
      />
    );

    await user.click(screen.getByRole("button", { name: "Semantic" }));
    await user.selectOptions(screen.getByLabelText("Eagerness"), "low");
    await user.click(screen.getByRole("button", { name: "Start microphone" }));
    await user.click(screen.getByRole("button", { name: "Connect Realtime" }));

    expect(connectRealtime).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionUpdateAfterOpen: {
          type: "transcription",
          audio: {
            input: expect.objectContaining({
              turn_detection: {
                type: "semantic_vad",
                eagerness: "low"
              }
            })
          }
        }
      })
    );
    expect(screen.getAllByText("VAD: semantic_vad / low").length).toBeGreaterThan(0);
  });

  it("sends adjustable normal VAD silence duration after connect", async () => {
    const user = userEvent.setup();
    const stream = createStream();
    const connectRealtime = vi.fn().mockResolvedValue(createConnection());

    render(
      <RealtimeLab
        requestMicrophone={vi.fn().mockResolvedValue({ status: "active", stream })}
        requestClientSecret={vi.fn().mockResolvedValue({
          clientSecret: "ek_ephemeral",
          expiresAt: 1756310470
        })}
        connectRealtime={connectRealtime}
      />
    );

    fireEvent.change(screen.getByLabelText("Silence duration"), { target: { value: "1800" } });
    await user.click(screen.getByRole("button", { name: "Start microphone" }));
    await user.click(screen.getByRole("button", { name: "Connect Realtime" }));

    expect(connectRealtime).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionUpdateAfterOpen: {
          type: "transcription",
          audio: {
            input: expect.objectContaining({
              turn_detection: expect.objectContaining({
                type: "server_vad",
                silence_duration_ms: 1800
              })
            })
          }
        }
      })
    );
    expect(screen.getAllByText("VAD: server_vad 0.50 / 300ms / 1800ms").length).toBeGreaterThan(
      0
    );
  });

  it("tracks server VAD speech boundaries without manual phrase buttons", async () => {
    const user = userEvent.setup();
    let emitEvent: (event: RealtimeServerEvent) => void = () => {};
    const connectRealtime = vi.fn().mockImplementation(({ onEvent }) => {
      emitEvent = onEvent;
      return Promise.resolve(createConnection());
    });

    render(
      <RealtimeLab
        requestMicrophone={vi.fn().mockResolvedValue({ status: "active", stream: createStream() })}
        requestClientSecret={vi.fn().mockResolvedValue({
          clientSecret: "ek_ephemeral",
          expiresAt: 1756310470
        })}
        connectRealtime={connectRealtime}
        analyzePhrase={vi.fn().mockResolvedValue({
          russianMeaning: "Привет, привет, привет",
          isQuestion: false,
          bridgePhrase: "Let me continue.",
          suggestedReplies: []
        })}
      />
    );

    await user.click(screen.getByRole("button", { name: "Realtime VAD" }));
    await user.click(screen.getByRole("button", { name: "Start microphone" }));
    await user.click(screen.getByRole("button", { name: "Connect Realtime" }));

    act(() => {
      emitEvent({ type: "input_audio_buffer.speech_started" });
    });

    expect(screen.getByText("Phrase: recording")).toBeInTheDocument();

    act(() => {
      emitEvent({ type: "input_audio_buffer.speech_stopped" });
    });

    expect(screen.getByText("Phrase: committed")).toBeInTheDocument();

    await act(async () => {
      emitEvent({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "hello hello hello"
      });
    });

    expect(screen.getAllByText("hello hello hello").length).toBeGreaterThan(0);
    expect(screen.getByText("Phrase: idle")).toBeInTheDocument();
  });

  it("shows bilingual analysis for completed realtime VAD transcripts", async () => {
    const user = userEvent.setup();
    let emitEvent: (event: RealtimeServerEvent) => void = () => {};
    const analyzePhrase = vi.fn().mockResolvedValue({
      russianMeaning: "Можешь рассказать о своём последнем проекте?",
      isQuestion: true,
      bridgePhrase: "Sure, let me frame it briefly.",
      suggestedReplies: [
        {
          shortLabel: "Recent project",
          shortLabelTranslation: "Недавний проект",
          fullSentence:
            "Sure, I recently worked on a project where I improved the core user flow and coordinated backend changes.",
          fullSentenceTranslation:
            "Да, недавно я работал над проектом, где улучшал основной пользовательский сценарий и координировал backend-изменения.",
          whyUse: "Когда нужно быстро начать с контекста проекта."
        },
        {
          shortLabel: "My role",
          shortLabelTranslation: "Моя роль",
          fullSentence:
            "My role was to clarify requirements, implement the frontend, and keep the integration stable.",
          fullSentenceTranslation:
            "Моя роль заключалась в уточнении требований, реализации frontend и поддержании стабильной интеграции.",
          whyUse: "Когда вопрос просит описать личный вклад."
        }
      ]
    } satisfies BilingualPhraseAnalysis);
    const connectRealtime = vi.fn().mockImplementation(({ onEvent }) => {
      emitEvent = onEvent;
      return Promise.resolve(createConnection());
    });

    render(
      <RealtimeLab
        requestMicrophone={vi.fn().mockResolvedValue({ status: "active", stream: createStream() })}
        requestClientSecret={vi.fn().mockResolvedValue({
          clientSecret: "ek_ephemeral",
          expiresAt: 1756310470
        })}
        connectRealtime={connectRealtime}
        analyzePhrase={analyzePhrase}
      />
    );

    await user.click(screen.getByRole("button", { name: "Realtime VAD" }));
    await user.click(screen.getByRole("button", { name: "Start microphone" }));
    await user.click(screen.getByRole("button", { name: "Connect Realtime" }));

    await act(async () => {
      emitEvent({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "Can you walk me through your recent project?"
      });
    });

    expect(analyzePhrase).toHaveBeenCalledWith("Can you walk me through your recent project?");
    expect(screen.getByText("Можешь рассказать о своём последнем проекте?")).toBeInTheDocument();
    expect(screen.getByText("Question")).toBeInTheDocument();
    expect(screen.getByText("Sure, let me frame it briefly.")).toBeInTheDocument();
    expect(screen.getByText("Недавний проект")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Sure, I recently worked on a project where I improved the core user flow and coordinated backend changes."
      )
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Да, недавно я работал над проектом, где улучшал основной пользовательский сценарий и координировал backend-изменения."
      )
    ).toBeInTheDocument();
    expect(screen.getByText("Когда нужно быстро начать с контекста проекта.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Recent project Недавний проект" }));

    expect(
      screen.getByText(
        "Sure, I recently worked on a project where I improved the core user flow and coordinated backend changes."
      )
    ).toBeInTheDocument();
  });

  it("shows compact recent phrase chips that can reopen previous bilingual cards", async () => {
    const user = userEvent.setup();
    let emitEvent: (event: RealtimeServerEvent) => void = () => {};
    const analyzePhrase = vi
      .fn()
      .mockResolvedValueOnce({
        russianMeaning: "Можешь рассказать о проекте?",
        isQuestion: true,
        bridgePhrase: "Sure, let me start with the context.",
        suggestedReplies: [
          {
            shortLabel: "Project context",
            shortLabelTranslation: "Контекст проекта",
            fullSentence: "The project was focused on improving an important user workflow.",
            fullSentenceTranslation:
              "Проект был сфокусирован на улучшении важного пользовательского сценария.",
            whyUse: "Когда нужно вернуться к контексту проекта."
          }
        ]
      } satisfies BilingualPhraseAnalysis)
      .mockResolvedValueOnce({
        russianMeaning: "Какую роль ты выполнял?",
        isQuestion: true,
        bridgePhrase: "Good question, let me clarify my part.",
        suggestedReplies: [
          {
            shortLabel: "My part",
            shortLabelTranslation: "Моя часть",
            fullSentence: "My part was to clarify requirements and implement the user-facing flow.",
            fullSentenceTranslation:
              "Моя часть заключалась в уточнении требований и реализации пользовательского сценария.",
            whyUse: "Когда нужно объяснить личную роль."
          }
        ]
      } satisfies BilingualPhraseAnalysis);
    const connectRealtime = vi.fn().mockImplementation(({ onEvent }) => {
      emitEvent = onEvent;
      return Promise.resolve(createConnection());
    });

    render(
      <RealtimeLab
        requestMicrophone={vi.fn().mockResolvedValue({ status: "active", stream: createStream() })}
        requestClientSecret={vi.fn().mockResolvedValue({
          clientSecret: "ek_ephemeral",
          expiresAt: 1756310470
        })}
        connectRealtime={connectRealtime}
        analyzePhrase={analyzePhrase}
      />
    );

    await user.click(screen.getByRole("button", { name: "Start microphone" }));
    await user.click(screen.getByRole("button", { name: "Connect Realtime" }));

    await act(async () => {
      emitEvent({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "Can you walk me through your recent project?"
      });
    });
    await act(async () => {
      emitEvent({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "What was your role in that team?"
      });
    });

    expect(screen.getByText("Какую роль ты выполнял?")).toBeInTheDocument();
    expect(screen.getByLabelText("Recent phrases")).toBeInTheDocument();
    expect(screen.queryByLabelText("Phrase cards")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "What was your role in that team?" })).toHaveClass(
      "recent-phrase-chip-selected"
    );

    await user.click(
      screen.getByRole("button", { name: "Can you walk me through your recent project?" })
    );

    expect(screen.getByText("Можешь рассказать о проекте?")).toBeInTheDocument();
    expect(screen.queryByText("Какую роль ты выполнял?")).not.toBeInTheDocument();
  });

  it("keeps the microphone stream alive after connecting Realtime", async () => {
    const user = userEvent.setup();
    const stop = vi.fn();
    const stream = createStream({ stop });

    render(
      <RealtimeLab
        requestMicrophone={vi.fn().mockResolvedValue({ status: "active", stream })}
        requestClientSecret={vi.fn().mockResolvedValue({
          clientSecret: "ek_ephemeral",
          expiresAt: 1756310470
        })}
        connectRealtime={vi.fn().mockResolvedValue(createConnection())}
      />
    );

    await user.click(screen.getByRole("button", { name: "Start microphone" }));
    await user.click(screen.getByRole("button", { name: "Connect Realtime" }));

    expect(screen.getByText("Realtime: connected")).toBeInTheDocument();
    expect(stop).not.toHaveBeenCalled();
  });

  it("renders transcript deltas and raw event types from the data channel", async () => {
    const user = userEvent.setup();
    let emitEvent: (event: RealtimeServerEvent) => void = () => {};
    const connectRealtime = vi.fn().mockImplementation(({ onEvent }) => {
      emitEvent = onEvent;
      return Promise.resolve(createConnection());
    });

    render(
      <RealtimeLab
        requestMicrophone={vi.fn().mockResolvedValue({ status: "active", stream: createStream() })}
        requestClientSecret={vi.fn().mockResolvedValue({
          clientSecret: "ek_ephemeral",
          expiresAt: 1756310470
        })}
        connectRealtime={connectRealtime}
      />
    );

    await user.click(screen.getByRole("button", { name: "Start microphone" }));
    await user.click(screen.getByRole("button", { name: "Connect Realtime" }));

    act(() => {
      emitEvent({
        type: "conversation.item.input_audio_transcription.delta",
        delta: "Hello"
      });
    });

    expect(screen.getByText("Hello")).toBeInTheDocument();
    expect(
      screen.getByText("conversation.item.input_audio_transcription.delta")
    ).toBeInTheDocument();
  });

  it("clears the server audio buffer at phrase start before committing it", async () => {
    const user = userEvent.setup();
    const clearAudio = vi.fn().mockReturnValue(true);
    const commitAudio = vi.fn().mockReturnValue(true);

    render(
      <RealtimeLab
        requestMicrophone={vi.fn().mockResolvedValue({ status: "active", stream: createStream() })}
        requestClientSecret={vi.fn().mockResolvedValue({
          clientSecret: "ek_ephemeral",
          expiresAt: 1756310470
        })}
        connectRealtime={vi.fn().mockResolvedValue(createConnection({ clearAudio, commitAudio }))}
      />
    );

    await user.click(screen.getByRole("button", { name: "Whisper PTT" }));
    await user.click(screen.getByRole("button", { name: "Start microphone" }));
    await user.click(screen.getByRole("button", { name: "Connect Realtime" }));
    await user.click(screen.getByRole("button", { name: "Start phrase" }));

    expect(clearAudio).toHaveBeenCalledOnce();
    expect(screen.getByText("Phrase: recording")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Commit phrase" }));

    expect(commitAudio).toHaveBeenCalledOnce();
    expect(screen.getByText("Phrase: committed")).toBeInTheDocument();
  });

  it("renders local audio diagnostics from the PCM appender", async () => {
    const user = userEvent.setup();
    let emitAudioStats: (stats: RealtimeAudioStats) => void = () => {};
    const connectRealtime = vi.fn().mockImplementation(({ onAudioStats }) => {
      emitAudioStats = onAudioStats;
      return Promise.resolve(createConnection());
    });

    render(
      <RealtimeLab
        requestMicrophone={vi.fn().mockResolvedValue({ status: "active", stream: createStream() })}
        requestClientSecret={vi.fn().mockResolvedValue({
          clientSecret: "ek_ephemeral",
          expiresAt: 1756310470
        })}
        connectRealtime={connectRealtime}
      />
    );

    await user.click(screen.getByRole("button", { name: "Start microphone" }));
    await user.click(screen.getByRole("button", { name: "Connect Realtime" }));

    act(() => {
      emitAudioStats({
        chunksObserved: 3,
        silentChunks: 1,
        dataChannelBufferedAmount: 0,
        inputSampleRate: 48000,
        samplesInLastChunk: 2048,
        rms: 0.0185,
        peak: 0.12
      });
    });

    expect(screen.getByText("48000")).toBeInTheDocument();
    expect(
      screen.getByText("Local microphone levels are being monitored. Audio is sent by the WebRTC media track.")
    ).toBeInTheDocument();
  });

  it("copies a debug bundle with statuses, audio stats, transcript, and raw events", async () => {
    const user = userEvent.setup();
    const copyText = vi.fn().mockResolvedValue(undefined);
    let emitEvent: (event: RealtimeServerEvent) => void = () => {};
    let emitAudioStats: (stats: RealtimeAudioStats) => void = () => {};
    const connectRealtime = vi.fn().mockImplementation(({ onEvent, onAudioStats }) => {
      emitEvent = onEvent;
      emitAudioStats = onAudioStats;
      return Promise.resolve(createConnection());
    });

    render(
      <RealtimeLab
        requestMicrophone={vi.fn().mockResolvedValue({ status: "active", stream: createStream() })}
        requestClientSecret={vi.fn().mockResolvedValue({
          clientSecret: "ek_ephemeral",
          expiresAt: 1756310470
        })}
        connectRealtime={connectRealtime}
        copyText={copyText}
      />
    );

    await user.click(screen.getByRole("button", { name: "Whisper PTT" }));
    await user.click(screen.getByRole("button", { name: "Start microphone" }));
    await user.click(screen.getByRole("button", { name: "Connect Realtime" }));

    act(() => {
      emitAudioStats({
        chunksObserved: 2,
        silentChunks: 0,
        dataChannelBufferedAmount: 0,
        inputSampleRate: 48000,
        samplesInLastChunk: 2048,
        rms: 0.02,
        peak: 0.16
      });
      emitEvent({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "Hello"
      });
    });

    await user.click(screen.getByRole("button", { name: "Copy debug bundle" }));

    const copiedPayload = JSON.parse(copyText.mock.calls[0][0]) as {
      statuses: { microphone: string; realtime: string; mode: string; phrase: string };
      audio: { latestStats: RealtimeAudioStats };
      transcript: string;
      events: RealtimeServerEvent[];
    };

    expect(copiedPayload.statuses).toMatchObject({
      microphone: "active",
      realtime: "connected",
      mode: "whisper-ptt"
    });
    expect(copiedPayload.audio.latestStats.chunksObserved).toBe(2);
    expect(copiedPayload.transcript).toBe("Hello");
    expect(copiedPayload.events[0].type).toBe(
      "conversation.item.input_audio_transcription.completed"
    );
    expect(screen.getByText("Debug info copied.")).toBeInTheDocument();
  });

  it("shows visible connection errors", async () => {
    const user = userEvent.setup();

    render(
      <RealtimeLab
        requestMicrophone={vi.fn().mockResolvedValue({ status: "active", stream: createStream() })}
        requestClientSecret={vi.fn().mockRejectedValue(new Error("missing OPENAI_API_KEY"))}
        connectRealtime={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: "Whisper PTT" }));
    await user.click(screen.getByRole("button", { name: "Start microphone" }));
    await user.click(screen.getByRole("button", { name: "Connect Realtime" }));

    expect(screen.getByRole("alert")).toHaveTextContent("missing OPENAI_API_KEY");
  });

  it("explains empty audio buffer commits as a speak-then-commit timing issue", async () => {
    const user = userEvent.setup();
    let emitEvent: (event: RealtimeServerEvent) => void = () => {};
    const connectRealtime = vi.fn().mockImplementation(({ onEvent }) => {
      emitEvent = onEvent;
      return Promise.resolve(createConnection());
    });

    render(
      <RealtimeLab
        requestMicrophone={vi.fn().mockResolvedValue({ status: "active", stream: createStream() })}
        requestClientSecret={vi.fn().mockResolvedValue({
          clientSecret: "ek_ephemeral",
          expiresAt: 1756310470
        })}
        connectRealtime={connectRealtime}
      />
    );

    await user.click(screen.getByRole("button", { name: "Start microphone" }));
    await user.click(screen.getByRole("button", { name: "Connect Realtime" }));

    act(() => {
      emitEvent({
        type: "error",
        error: {
          code: "input_audio_buffer_commit_empty",
          message: "Expected at least 100ms of audio, but buffer only has 0.00ms of audio."
        }
      });
    });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "No audio reached Realtime yet. Click Start phrase, speak for at least one second, then click Commit phrase."
    );
  });
});
