import { useEffect, useRef, useState } from "react";
import {
  requestMicrophoneStream,
  stopStream,
  type MicrophoneResult
} from "../audio/microphone";
import {
  connectRealtimeTranscription,
  type RealtimeAudioStats,
  type RealtimeServerEvent,
  type RealtimeTranscriptionConnection
} from "../realtime/realtimeConnection";
import {
  buildRealtimeTranscriptionSessionUpdate,
  defaultRealtimeTurnDetectionSettings,
  type RealtimeClientSecret,
  type RealtimeLabMode
} from "../realtime/realtimeSession";
import { formatTurnDetectionSettings, TurnDetectionControls } from "./TurnDetectionControls";
import type { BilingualPhraseAnalysis } from "../realtime/bilingualAnalysis";
import type { AudioStatus } from "../domain/session";

type RealtimeStatus = "disconnected" | "connecting" | "connected" | "error";
type PhraseStatus = "idle" | "recording" | "committed";
type PhraseAnalysisCard = {
  id: string;
  transcript: string;
  analysis: BilingualPhraseAnalysis;
};

type RealtimeLabProps = {
  requestMicrophone?: () => Promise<MicrophoneResult>;
  requestClientSecret?: (mode: RealtimeLabMode) => Promise<RealtimeClientSecret>;
  connectRealtime?: typeof connectRealtimeTranscription;
  analyzePhrase?: (transcript: string) => Promise<BilingualPhraseAnalysis>;
  copyText?: (text: string) => Promise<void> | void;
  now?: () => number;
};

const realtimeStatusLabels: Record<RealtimeStatus, string> = {
  disconnected: "disconnected",
  connecting: "connecting",
  connected: "connected",
  error: "error"
};

const microphoneStatusLabels: Record<AudioStatus, string> = {
  idle: "idle",
  requesting: "requesting",
  active: "active",
  blocked: "blocked",
  error: "error"
};

const emptyAudioCommitMessage =
  "No audio reached Realtime yet. Click Start phrase, speak for at least one second, then click Commit phrase.";

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Realtime Lab failed.";
}

const modeLabels: Record<RealtimeLabMode, string> = {
  "whisper-ptt": "Whisper PTT",
  "realtime-vad": "Realtime VAD"
};

async function requestDefaultClientSecret(mode: RealtimeLabMode): Promise<RealtimeClientSecret> {
  const response = await fetch(`/api/realtime/client-secret?mode=${mode}`);
  const payload = (await response.json().catch(() => ({}))) as {
    error?: unknown;
    clientSecret?: unknown;
    expiresAt?: unknown;
    sessionId?: unknown;
  };

  if (!response.ok) {
    throw new Error(
      typeof payload.error === "string"
        ? payload.error
        : "Could not create a Realtime client secret."
    );
  }

  if (typeof payload.clientSecret !== "string" || typeof payload.expiresAt !== "number") {
    throw new Error("Realtime client secret response had an unexpected shape.");
  }

  return {
    clientSecret: payload.clientSecret,
    expiresAt: payload.expiresAt,
    ...(typeof payload.sessionId === "string" ? { sessionId: payload.sessionId } : {})
  };
}

async function copyTextToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText == null) {
    throw new Error("Clipboard API is unavailable in this browser.");
  }

  await navigator.clipboard.writeText(text);
}

async function requestDefaultPhraseAnalysis(transcript: string): Promise<BilingualPhraseAnalysis> {
  const response = await fetch("/api/realtime/analyze-phrase", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ transcript })
  });
  const payload = (await response.json().catch(() => ({}))) as Partial<BilingualPhraseAnalysis> & {
    error?: unknown;
  };

  if (!response.ok) {
    throw new Error(typeof payload.error === "string" ? payload.error : "Could not analyze phrase.");
  }

  if (
    typeof payload.russianMeaning !== "string" ||
    typeof payload.isQuestion !== "boolean" ||
    typeof payload.bridgePhrase !== "string" ||
    !Array.isArray(payload.suggestedReplies)
  ) {
    throw new Error("Phrase analysis response had an unexpected shape.");
  }

  return {
    russianMeaning: payload.russianMeaning,
    isQuestion: payload.isQuestion,
    bridgePhrase: payload.bridgePhrase,
    suggestedReplies: payload.suggestedReplies
  };
}

function getTrackDebug(stream: MediaStream | null) {
  return (
    stream?.getTracks().map((track) => ({
      id: track.id,
      kind: track.kind,
      label: track.label,
      enabled: track.enabled,
      muted: track.muted,
      readyState: track.readyState,
      settings: track.getSettings?.() ?? {}
    })) ?? []
  );
}

export function RealtimeLab({
  requestMicrophone = requestMicrophoneStream,
  requestClientSecret = requestDefaultClientSecret,
  connectRealtime = connectRealtimeTranscription,
  analyzePhrase = requestDefaultPhraseAnalysis,
  copyText = copyTextToClipboard,
  now = () => performance.now()
}: RealtimeLabProps) {
  const [microphoneStatus, setMicrophoneStatus] = useState<AudioStatus>("idle");
  const [realtimeStatus, setRealtimeStatus] = useState<RealtimeStatus>("disconnected");
  const [mode, setMode] = useState<RealtimeLabMode>("realtime-vad");
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [connection, setConnection] = useState<RealtimeTranscriptionConnection | null>(null);
  const [transcript, setTranscript] = useState("");
  const [finalTranscript, setFinalTranscript] = useState("");
  const [events, setEvents] = useState<RealtimeServerEvent[]>([]);
  const [clientEvents, setClientEvents] = useState<Array<{ type: string; timestamp: string }>>([]);
  const [audioStats, setAudioStats] = useState<RealtimeAudioStats | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [latencyNote, setLatencyNote] = useState("No transcript events yet.");
  const [copyStatus, setCopyStatus] = useState("");
  const [phraseStatus, setPhraseStatus] = useState<PhraseStatus>("idle");
  const [analysis, setAnalysis] = useState<BilingualPhraseAnalysis | null>(null);
  const [phraseCards, setPhraseCards] = useState<PhraseAnalysisCard[]>([]);
  const [selectedPhraseCardId, setSelectedPhraseCardId] = useState<string | null>(null);
  const [analysisStatus, setAnalysisStatus] = useState<"idle" | "loading" | "ready" | "error">(
    "idle"
  );
  const [selectedReplyIndex, setSelectedReplyIndex] = useState<number | null>(null);
  const [turnDetectionSettings, setTurnDetectionSettings] = useState(
    defaultRealtimeTurnDetectionSettings
  );
  const audioStartedAt = useRef<number | null>(null);
  const phraseStartedAt = useRef<number | null>(null);
  const firstTranscriptAt = useRef<number | null>(null);
  const phraseCardSequence = useRef(0);
  const connectionRef = useRef<RealtimeTranscriptionConnection | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  function explainRealtimeError(event: RealtimeServerEvent): string | null {
    const error = event.error;

    if (typeof error !== "object" || error == null || !("code" in error)) {
      return null;
    }

    const code = (error as { code?: unknown }).code;

    if (code === "input_audio_buffer_commit_empty") {
      return emptyAudioCommitMessage;
    }

    const message = (error as { message?: unknown }).message;
    return typeof message === "string" ? message : null;
  }

  useEffect(() => {
    connectionRef.current = connection;
  }, [connection]);

  useEffect(() => {
    streamRef.current = stream;
  }, [stream]);

  useEffect(() => {
    return () => {
      connectionRef.current?.disconnect();
      stopStream(streamRef.current);
    };
  }, []);

  function handleRealtimeEvent(event: RealtimeServerEvent) {
    setEvents((current) => [event, ...current].slice(0, 30));

    if (event.type === "error") {
      const message = explainRealtimeError(event);

      if (message != null) {
        setErrorMessage(message);
      }
    }

    if (event.type === "input_audio_buffer.speech_started") {
      phraseStartedAt.current = now();
      firstTranscriptAt.current = null;
      setTranscript("");
      setFinalTranscript("");
      setAnalysis(null);
      setAnalysisStatus("idle");
      setSelectedReplyIndex(null);
      setLatencyNote("Speech detected.");
      setPhraseStatus("recording");
    }

    if (event.type === "input_audio_buffer.speech_stopped") {
      setLatencyNote("Speech stopped; waiting for transcript.");
      setPhraseStatus("committed");
    }

    if (
      event.type === "conversation.item.input_audio_transcription.delta" &&
      typeof event.delta === "string"
    ) {
      setTranscript((current) => `${current}${event.delta}`);

      if (firstTranscriptAt.current == null && phraseStartedAt.current != null) {
        firstTranscriptAt.current = now();
        setLatencyNote(
          `First transcript event: ${Math.round(firstTranscriptAt.current - phraseStartedAt.current)} ms`
        );
      }
    }

    if (
      event.type === "conversation.item.input_audio_transcription.completed" &&
      typeof event.transcript === "string"
    ) {
      setFinalTranscript(event.transcript);
      setTranscript(event.transcript);
      setPhraseStatus("idle");
      if (mode === "realtime-vad") {
        void analyzeCompletedTranscript(event.transcript);
      }
    }
  }

  async function analyzeCompletedTranscript(completedTranscript: string) {
    const trimmedTranscript = completedTranscript.trim();

    if (trimmedTranscript.length === 0) {
      return;
    }

    setAnalysisStatus("loading");
    setAnalysis(null);
    setSelectedReplyIndex(null);

    try {
      const nextAnalysis = await analyzePhrase(trimmedTranscript);
      const nextCard = {
        id: `phrase-${phraseCardSequence.current}`,
        transcript: trimmedTranscript,
        analysis: nextAnalysis
      };
      phraseCardSequence.current += 1;

      setAnalysis(nextAnalysis);
      setPhraseCards((current) => [...current, nextCard].slice(-20));
      setSelectedPhraseCardId(nextCard.id);
      setAnalysisStatus("ready");
    } catch (error) {
      setAnalysisStatus("error");
      setErrorMessage(toErrorMessage(error));
    }
  }

  function recordClientEvent(type: string) {
    setClientEvents((current) =>
      [{ type, timestamp: new Date().toISOString() }, ...current].slice(0, 30)
    );
  }

  async function handleStartMicrophone() {
    setErrorMessage("");
    setCopyStatus("");
    setAudioStats(null);
    setAnalysis(null);
    setPhraseCards([]);
    setSelectedPhraseCardId(null);
    setAnalysisStatus("idle");
    setSelectedReplyIndex(null);
    setMicrophoneStatus("requesting");

    const result = await requestMicrophone();
    setMicrophoneStatus(result.status);

    if (result.status === "active" && result.stream != null) {
      audioStartedAt.current = now();
      stopStream(streamRef.current);
      setStream(result.stream);
      return;
    }

    setErrorMessage(result.errorMessage ?? "Could not start microphone for Realtime Lab.");
  }

  async function handleConnectRealtime() {
    if (stream == null) {
      setErrorMessage("Start microphone before connecting Realtime.");
      return;
    }

    setErrorMessage("");
    setRealtimeStatus("connecting");

    try {
      const clientSecret = await requestClientSecret(mode);
      const realtimeConnection = await connectRealtime({
        stream,
        clientSecret: clientSecret.clientSecret,
        ...(mode === "realtime-vad"
          ? {
              sessionUpdateAfterOpen: buildRealtimeTranscriptionSessionUpdate(
                turnDetectionSettings
              )
            }
          : {}),
        onEvent: handleRealtimeEvent,
        onAudioStats: setAudioStats,
        onError: setErrorMessage
      });

      setConnection(realtimeConnection);
      setRealtimeStatus("connected");
      recordClientEvent(`realtime.connected.${mode}`);
    } catch (error) {
      setRealtimeStatus("error");
      setErrorMessage(toErrorMessage(error));
    }
  }

  function handleStartPhrase() {
    const cleared = connection?.clearAudio() ?? false;

    if (!cleared) {
      setErrorMessage("Realtime data channel is not open yet.");
      return;
    }

    recordClientEvent("input_audio_buffer.clear");
    setErrorMessage("");
    setTranscript("");
    setFinalTranscript("");
    firstTranscriptAt.current = null;
    phraseStartedAt.current = now();
    setLatencyNote("Waiting for this phrase transcript.");
    setPhraseStatus("recording");
  }

  function handleCommitAudio() {
    const committed = connection?.commitAudio() ?? false;

    if (!committed) {
      setErrorMessage("Realtime data channel is not open yet.");
      return;
    }

    recordClientEvent("input_audio_buffer.commit");
    setPhraseStatus("committed");
  }

  function handleDisconnect() {
    connection?.disconnect();
    setConnection(null);
    setRealtimeStatus("disconnected");
    setPhraseStatus("idle");
  }

  async function handleCopyDebugInfo() {
    const debugBundle = {
      capturedAt: new Date().toISOString(),
      page: window.location.href,
      userAgent: navigator.userAgent,
      statuses: {
        microphone: microphoneStatus,
        realtime: realtimeStatus,
        mode,
        phrase: phraseStatus,
        turnDetection: turnDetectionSettings
      },
      audio: {
        startedAtMs: audioStartedAt.current,
        phraseStartedAtMs: phraseStartedAt.current,
        firstTranscriptAtMs: firstTranscriptAt.current,
        latestStats: audioStats,
        tracks: getTrackDebug(stream)
      },
      transcript,
      analysis,
      phraseCards,
      selectedPhraseCardId,
      analysisStatus,
      latencyNote,
      errorMessage,
      clientEvents,
      events
    };

    try {
      await copyText(JSON.stringify(debugBundle, null, 2));
      setCopyStatus("Debug info copied.");
    } catch (error) {
      setCopyStatus(toErrorMessage(error));
    }
  }

  const audioLevel = Math.min(1, Math.max((audioStats?.peak ?? 0) * 24, (audioStats?.rms ?? 0) * 80));
  const hasAudioChunks = (audioStats?.chunksObserved ?? 0) > 0;
  const selectedPhraseCard =
    phraseCards.find((card) => card.id === selectedPhraseCardId) ?? null;
  const visibleAnalysis = selectedPhraseCard?.analysis ?? analysis;
  const recentPhraseCards = phraseCards.slice(-4).reverse();

  useEffect(() => {
    setSelectedReplyIndex((currentIndex) => {
      if (visibleAnalysis == null) {
        return null;
      }

      if (
        currentIndex != null &&
        visibleAnalysis.suggestedReplies[currentIndex] != null
      ) {
        return currentIndex;
      }

      return visibleAnalysis.suggestedReplies.length > 0 ? 0 : null;
    });
  }, [visibleAnalysis]);

  return (
    <main className="lab-shell">
      <header className="lab-header">
        <p className="eyebrow">OpenAI Realtime API</p>
        <h1>Realtime Transcription Lab</h1>
      </header>

      <section className="mode-tabs" aria-label="Realtime Lab mode">
        {(["whisper-ptt", "realtime-vad"] as const).map((modeOption) => (
          <button
            type="button"
            key={modeOption}
            className={mode === modeOption ? "mode-tab mode-tab-active" : "mode-tab"}
            disabled={connection != null || realtimeStatus === "connecting"}
            onClick={() => {
              setMode(modeOption);
              setTranscript("");
              setFinalTranscript("");
              setAnalysis(null);
              setPhraseCards([]);
              setSelectedPhraseCardId(null);
              setAnalysisStatus("idle");
              setSelectedReplyIndex(null);
              setEvents([]);
              setClientEvents([]);
              setPhraseStatus("idle");
              firstTranscriptAt.current = null;
              phraseStartedAt.current = null;
              setLatencyNote("No transcript events yet.");
            }}
          >
            {modeLabels[modeOption]}
          </button>
        ))}
      </section>

      <section className="lab-controls" aria-label="Realtime Lab controls">
        <button type="button" onClick={handleStartMicrophone}>
          Start microphone
        </button>
        <span className={`status status-${microphoneStatus}`}>
          Microphone: {microphoneStatusLabels[microphoneStatus]}
        </span>
        <button
          type="button"
          disabled={stream == null || realtimeStatus === "connecting"}
          onClick={handleConnectRealtime}
        >
          Connect Realtime
        </button>
        <span className={`status status-${realtimeStatus}`}>
          Realtime: {realtimeStatusLabels[realtimeStatus]}
        </span>
        {mode === "whisper-ptt" ? (
          <>
            <button
              type="button"
              disabled={connection == null || phraseStatus === "recording"}
              onClick={handleStartPhrase}
            >
              Start phrase
            </button>
            <button
              type="button"
              disabled={connection == null || phraseStatus !== "recording"}
              onClick={handleCommitAudio}
            >
              Commit phrase
            </button>
          </>
        ) : (
          <span className="status">{formatTurnDetectionSettings(turnDetectionSettings)}</span>
        )}
        <button type="button" disabled={connection == null} onClick={handleDisconnect}>
          Disconnect
        </button>
        <span className="status">Phrase: {phraseStatus}</span>
      </section>

      {mode === "realtime-vad" ? (
        <TurnDetectionControls
          settings={turnDetectionSettings}
          disabled={connection != null || realtimeStatus === "connecting"}
          onChange={setTurnDetectionSettings}
        />
      ) : null}

      <p className="lab-instruction">
        {mode === "whisper-ptt"
          ? "Click Start phrase, speak, then click Commit phrase."
          : "Speak normally. Realtime VAD should segment turns automatically."}
      </p>

      {errorMessage.length > 0 ? (
        <p className="error-text" role="alert">
          {errorMessage}
        </p>
      ) : null}

      <section className="lab-diagnostics" aria-label="Audio diagnostics">
        <div className="audio-meter" aria-label="Microphone peak level">
          <span style={{ transform: `scaleX(${audioLevel})` }} />
        </div>
        <dl className="diagnostics-list">
          <div>
            <dt>Monitor chunks</dt>
            <dd>{audioStats?.chunksObserved ?? 0}</dd>
          </div>
          <div>
            <dt>RMS</dt>
            <dd>{audioStats?.rms.toFixed(5) ?? "0.00000"}</dd>
          </div>
          <div>
            <dt>Peak</dt>
            <dd>{audioStats?.peak.toFixed(5) ?? "0.00000"}</dd>
          </div>
          <div>
            <dt>Silent chunks</dt>
            <dd>{audioStats?.silentChunks ?? 0}</dd>
          </div>
          <div>
            <dt>Buffered</dt>
            <dd>{audioStats?.dataChannelBufferedAmount ?? 0}</dd>
          </div>
          <div>
            <dt>Sample rate</dt>
            <dd>
              {audioStats == null ? "unknown" : audioStats.inputSampleRate}
            </dd>
          </div>
        </dl>
        <button type="button" onClick={handleCopyDebugInfo}>
          Copy debug bundle
        </button>
        <p className="hint">
          {hasAudioChunks
            ? "Local microphone levels are being monitored. Audio is sent by the WebRTC media track."
            : "No local microphone monitor chunks yet."}
        </p>
        {copyStatus.length > 0 ? <p className="hint">{copyStatus}</p> : null}
      </section>

      <section className="lab-grid">
        <article className="lab-panel">
          <h2>Live English transcript</h2>
          <pre className="transcript-box">{transcript || "Waiting for transcript..."}</pre>
          {finalTranscript.length > 0 ? (
            <p className="hint">Final transcript received.</p>
          ) : null}
          <p className="hint">{latencyNote}</p>
        </article>

        <article className="lab-panel">
          <h2>Russian meaning and replies</h2>
          {recentPhraseCards.length > 0 ? (
            <div className="recent-phrase-chips" aria-label="Recent phrases">
              {recentPhraseCards.map((card) => (
                <button
                  type="button"
                  key={card.id}
                  className={
                    card.id === selectedPhraseCardId
                      ? "recent-phrase-chip recent-phrase-chip-selected"
                      : "recent-phrase-chip"
                  }
                  onClick={() => {
                    setSelectedPhraseCardId(card.id);
                    setSelectedReplyIndex(null);
                  }}
                >
                  {card.transcript}
                </button>
              ))}
            </div>
          ) : null}
          {analysisStatus === "idle" && visibleAnalysis == null ? (
            <p className="hint">Waiting for a completed phrase.</p>
          ) : null}
          {analysisStatus === "loading" ? <p className="hint">Analyzing phrase...</p> : null}
          {analysisStatus === "error" ? (
            <p className="error-text">Phrase analysis failed.</p>
          ) : null}
          {visibleAnalysis != null ? (
            <div className="bilingual-card">
              {selectedPhraseCard != null ? (
                <p className="selected-phrase-text">{selectedPhraseCard.transcript}</p>
              ) : null}
              <div className="translation-block">
                <span className={visibleAnalysis.isQuestion ? "question-pill" : "question-pill-muted"}>
                  {visibleAnalysis.isQuestion ? "Question" : "Statement"}
                </span>
                <p>{visibleAnalysis.russianMeaning}</p>
              </div>
              <div className="bridge-block">
                <h3>Bridge phrase</h3>
                <p>{visibleAnalysis.bridgePhrase}</p>
              </div>
              <div className="reply-options">
                <h3>Suggested replies</h3>
                {visibleAnalysis.suggestedReplies.map((reply, index) => (
                  <button
                    type="button"
                    key={`${reply.shortLabel}-${index}`}
                    className={
                      selectedReplyIndex === index
                        ? "reply-chip reply-chip-selected"
                        : "reply-chip"
                    }
                    onClick={() => setSelectedReplyIndex(index)}
                  >
                    <span>{reply.shortLabel}</span>
                    <span className="reply-chip-translation">{reply.shortLabelTranslation}</span>
                  </button>
                ))}
                {selectedReplyIndex != null ? (
                  <div className="reply-full">
                    <p>{visibleAnalysis.suggestedReplies[selectedReplyIndex]?.fullSentence}</p>
                    <p className="reply-full-translation">
                      {visibleAnalysis.suggestedReplies[selectedReplyIndex]?.fullSentenceTranslation}
                    </p>
                    {(visibleAnalysis.suggestedReplies[selectedReplyIndex]?.whyUse ?? "").length > 0 ? (
                      <p className="reply-why-use">
                        {visibleAnalysis.suggestedReplies[selectedReplyIndex]?.whyUse}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}
        </article>

        <article className="lab-panel">
          <h2>Raw event log</h2>
          {events.length === 0 ? (
            <p className="hint">No Realtime events yet.</p>
          ) : (
            <ol className="event-log">
              {events.map((event, index) => (
                <li key={`${event.type}-${index}`}>
                  <code>{event.type}</code>
                  <pre>{JSON.stringify(event, null, 2)}</pre>
                </li>
              ))}
            </ol>
          )}
        </article>
      </section>
    </main>
  );
}
