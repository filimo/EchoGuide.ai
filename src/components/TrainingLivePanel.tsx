import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowDownToLine, Eraser, Sparkles, Trash2, X } from "lucide-react";
import {
  ensureUniqueSessionPhraseIds,
  type SessionHistoryBridgePhrase,
  type SessionHistoryClient,
  type SessionHistoryEntry,
  type SessionHistoryEntryDraft,
  type SessionHistorySelectedReply,
  type SessionHistoryTranscriptTurn,
  type SessionSpeakerLabel
} from "../domain/sessionHistory";
import type { BilingualPhraseAnalysis } from "../realtime/bilingualAnalysis";
import {
  connectRealtimeTranscription,
  type RealtimeAudioStats,
  type RealtimeServerEvent,
  type RealtimeTranscriptionConnection
} from "../realtime/realtimeConnection";
import {
  createRealtimeDiagnosticId,
  type RealtimeDiagnosticEvent,
  type RealtimeDiagnosticReport
} from "../realtime/realtimeDiagnostics";
import {
  buildRealtimeTranscriptionSessionUpdate,
  defaultRealtimeTurnDetectionSettings,
  loadRealtimeSpeechLanguageSettings,
  loadRealtimeTurnDetectionSettings,
  saveRealtimeSpeechLanguageSettings,
  saveRealtimeTurnDetectionSettings,
  type RealtimeClientSecret,
  type RealtimeLabMode
} from "../realtime/realtimeSession";
import { SpeechLanguageControls } from "./SpeechLanguageControls";
import { TurnDetectionControls } from "./TurnDetectionControls";

type TrainingPhraseCard = {
  id: string;
  transcript: string;
  analysis: BilingualPhraseAnalysis;
  source?: "auto" | "selected-group";
};

type TranscriptTurn = SessionHistoryTranscriptTurn;

type RealtimeStatus = "disconnected" | "connecting" | "connected" | "error";

const localBridgePhrases = [
  {
    english: "Let me think.",
    russian: "Дайте подумать."
  },
  {
    english: "Can you repeat that?",
    russian: "Можете повторить?"
  },
  {
    english: "I will answer simply.",
    russian: "Я отвечу просто."
  },
  {
    english: "Good question.",
    russian: "Это хороший вопрос."
  },
  {
    english: "In my experience...",
    russian: "По моему опыту..."
  },
  {
    english: "There are two parts.",
    russian: "Тут две части."
  },
  {
    english: "One moment, please.",
    russian: "Один момент, пожалуйста."
  }
];

const fillerTranscripts = new Set(["ah", "er", "huh", "hm", "hmm", "mm", "uh", "um"]);
const testTranscripts = new Set(["test", "testing", "hi test"]);
const maxFreshThoughtTurns = 15;
const maxFreshThoughtCharacters = 5000;
const unacknowledgedSpeechDelayMs = 2500;
const loudSpeechRmsThreshold = 0.01;
const loudSpeechPeakThreshold = 0.05;

type TrainingLivePanelProps = {
  stream: MediaStream | null;
  notes: string;
  sourceLabel?: string;
  requestClientSecret?: (mode: RealtimeLabMode) => Promise<RealtimeClientSecret>;
  connectRealtime?: typeof connectRealtimeTranscription;
  analyzePhrase?: (
    transcript: string,
    knowledgeContext: string,
    recentContext: string[]
  ) => Promise<BilingualPhraseAnalysis>;
  copyText?: (text: string) => Promise<void> | void;
  sessionHistoryClient?: SessionHistoryClient;
  createSessionId?: () => string;
  autoOpenLatestSession?: boolean;
  onRequestMicrophone?: () => Promise<MediaStream | null> | MediaStream | null | void;
  onStopMicrophone?: () => void;
  onNotesChange?: (notes: string) => void;
  submitDiagnostics?: (report: RealtimeDiagnosticReport) => Promise<string>;
};

async function submitDefaultDiagnostics(report: RealtimeDiagnosticReport): Promise<string> {
  const response = await fetch("/api/diagnostics/realtime", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(report)
  });

  if (!response.ok) {
    throw new Error("Could not send Realtime diagnostics.");
  }

  const payload = (await response.json()) as { reportId?: unknown };
  return typeof payload.reportId === "string" ? payload.reportId : report.reportId;
}

async function requestDefaultClientSecret(mode: RealtimeLabMode): Promise<RealtimeClientSecret> {
  const response = await fetch(`/api/realtime/client-secret?mode=${mode}`);

  if (!response.ok) {
    throw new Error("Could not create an OpenAI Realtime client secret.");
  }

  const payload = (await response.json()) as {
    clientSecret?: unknown;
    expiresAt?: unknown;
    sessionId?: unknown;
  };

  if (typeof payload.clientSecret !== "string" || typeof payload.expiresAt !== "number") {
    throw new Error("Realtime client secret response is invalid.");
  }

  return {
    clientSecret: payload.clientSecret,
    expiresAt: payload.expiresAt,
    ...(typeof payload.sessionId === "string" ? { sessionId: payload.sessionId } : {})
  };
}

async function requestDefaultPhraseAnalysis(
  transcript: string,
  knowledgeContext: string,
  recentContext: string[]
): Promise<BilingualPhraseAnalysis> {
  const response = await fetch("/api/realtime/analyze-phrase", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ transcript, knowledgeContext, recentContext })
  });

  if (!response.ok) {
    throw new Error("Phrase analysis failed.");
  }

  return (await response.json()) as BilingualPhraseAnalysis;
}

function padDatePart(value: number): string {
  return value.toString().padStart(2, "0");
}

function formatSessionTimestamp(value: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "Unknown";
  }

  return `${date.getFullYear()}-${padDatePart(date.getMonth() + 1)}-${padDatePart(
    date.getDate()
  )} ${padDatePart(date.getHours())}:${padDatePart(date.getMinutes())}`;
}

function getSessionTitle(session: SessionHistoryEntry): string {
  const lastTranscript = [...session.transcriptTurns]
    .reverse()
    .find((turn) => turn.text.trim().length > 0);

  return lastTranscript?.text.trim() || session.sourceLabel.trim() || "Training session";
}

function getNextPhraseCardSequence(session: SessionHistoryEntry): number {
  let highestSequence = -1;

  for (const item of [...session.transcriptTurns, ...session.phraseCards]) {
    const match = /^training-phrase-(\d+)$/.exec(item.id);

    if (match != null) {
      highestSequence = Math.max(highestSequence, Number(match[1]));
    }
  }

  return highestSequence + 1;
}

async function copyTextToClipboard(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}

const defaultSessionHistoryClient: SessionHistoryClient = {
  async loadSessions() {
    const response = await fetch("/api/sessions");

    if (!response.ok) {
      throw new Error("Could not load saved sessions.");
    }

    const payload = (await response.json()) as { sessions?: unknown };

    return Array.isArray(payload.sessions) ? (payload.sessions as SessionHistoryEntry[]) : [];
  },
  async saveCurrentSession(sessionId: string, draft: SessionHistoryEntryDraft) {
    const response = await fetch("/api/sessions/current", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ sessionId, session: draft })
    });

    if (!response.ok) {
      throw new Error("Could not auto-save the current session.");
    }

    return (await response.json()) as SessionHistoryEntry;
  },
  async deleteSession(sessionId: string) {
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: "DELETE"
    });

    if (!response.ok) {
      throw new Error("Could not delete saved session.");
    }

    const payload = (await response.json()) as { sessions?: unknown };

    return Array.isArray(payload.sessions) ? (payload.sessions as SessionHistoryEntry[]) : [];
  }
};

function createDefaultSessionId(): string {
  return `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected Training Mode error.";
}

function isObviousTranscriptNoise(transcript: string): boolean {
  const trimmedTranscript = transcript.trim();
  const withoutPunctuation = trimmedTranscript
    .toLowerCase()
    .replace(/[.!?,;:…"“”'’`()[\]{}-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (withoutPunctuation.length === 0) {
    return true;
  }

  if (!/[a-zа-яё]/i.test(withoutPunctuation)) {
    return true;
  }

  return fillerTranscripts.has(withoutPunctuation) || testTranscripts.has(withoutPunctuation);
}

function buildRecentAnalysisContext(turns: TranscriptTurn[], activePhraseId: string): string[] {
  const activeTurnIndex = turns.findIndex((turn) => turn.id === activePhraseId);
  const availableTurns = activeTurnIndex >= 0 ? turns.slice(0, activeTurnIndex + 1) : turns;
  const recentTurns = availableTurns.slice(-maxFreshThoughtTurns).map((turn) => {
    const text = turn.text.trim();
    return turn.speakerLabel === "Heard" ? text : `${turn.speakerLabel}: ${text}`;
  });

  while (
    recentTurns.length > 1 &&
    recentTurns.join("\n").length > maxFreshThoughtCharacters
  ) {
    recentTurns.shift();
  }

  if (recentTurns.join("\n").length <= maxFreshThoughtCharacters) {
    return recentTurns;
  }

  return [recentTurns[0]?.slice(-maxFreshThoughtCharacters).trim() ?? ""].filter(
    (turn) => turn.length > 0
  );
}

function resolveAnalysisSpeakerLabel(
  speakerRole: BilingualPhraseAnalysis["speakerRole"]
): SessionSpeakerLabel {
  if (speakerRole === "interviewer") {
    return "Interviewer";
  }

  if (speakerRole === "me") {
    return "Me";
  }

  return "Heard";
}

function getNextSpeakerLabel(current: SessionSpeakerLabel): SessionSpeakerLabel {
  if (current === "Heard") {
    return "Interviewer";
  }

  return current === "Interviewer" ? "Me" : "Heard";
}

function getCompactSpeakerLabel(speakerLabel: SessionSpeakerLabel): string {
  if (speakerLabel === "Interviewer") {
    return "INT";
  }

  return speakerLabel === "Me" ? "ME" : "?";
}

export function TrainingLivePanel({
  stream,
  notes,
  sourceLabel = "",
  requestClientSecret = requestDefaultClientSecret,
  connectRealtime = connectRealtimeTranscription,
  analyzePhrase = requestDefaultPhraseAnalysis,
  copyText = copyTextToClipboard,
  sessionHistoryClient = defaultSessionHistoryClient,
  createSessionId = createDefaultSessionId,
  autoOpenLatestSession = false,
  onRequestMicrophone,
  onStopMicrophone,
  onNotesChange,
  submitDiagnostics = submitDefaultDiagnostics
}: TrainingLivePanelProps) {
  const [realtimeStatus, setRealtimeStatus] = useState<RealtimeStatus>("disconnected");
  const [connection, setConnection] = useState<RealtimeTranscriptionConnection | null>(null);
  const [transcriptTurns, setTranscriptTurns] = useState<TranscriptTurn[]>([]);
  const [liveTranscriptDraft, setLiveTranscriptDraft] = useState("");
  const [phraseCards, setPhraseCards] = useState<TrainingPhraseCard[]>([]);
  const [pendingAnalysisIds, setPendingAnalysisIds] = useState<Set<string>>(() => new Set());
  const [selectedPhraseCardId, setSelectedPhraseCardId] = useState<string | null>(null);
  const [analysisStatus, setAnalysisStatus] = useState<"idle" | "loading" | "ready" | "error">(
    "idle"
  );
  const [selectedReplyIndex, setSelectedReplyIndex] = useState<number | null>(null);
  const [selectedReplies, setSelectedReplies] = useState<SessionHistorySelectedReply[]>([]);
  const [selectedBridgePhraseIndex, setSelectedBridgePhraseIndex] = useState(0);
  const [transcriptSelectionMode, setTranscriptSelectionMode] = useState(false);
  const [selectedTranscriptTurnIds, setSelectedTranscriptTurnIds] = useState<Set<string>>(
    () => new Set()
  );
  const [usedBridgePhrases, setUsedBridgePhrases] = useState<SessionHistoryBridgePhrase[]>([]);
  const [savedSessions, setSavedSessions] = useState<SessionHistoryEntry[]>([]);
  const [historyPanelOpen, setHistoryPanelOpen] = useState(false);
  const [notesDialogOpen, setNotesDialogOpen] = useState(false);
  const [followLive, setFollowLive] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");
  const [copyStatus, setCopyStatus] = useState("");
  const [audioStats, setAudioStats] = useState<RealtimeAudioStats | null>(null);
  const [turnDetectionSettings, setTurnDetectionSettings] = useState(() =>
    loadRealtimeTurnDetectionSettings(window.localStorage)
  );
  const [speechLanguage, setSpeechLanguage] = useState(() =>
    loadRealtimeSpeechLanguageSettings(window.localStorage)
  );
  const phraseCardSequence = useRef(0);
  const connectionRef = useRef<RealtimeTranscriptionConnection | null>(null);
  const currentSessionIdRef = useRef<string | null>(null);
  const followLiveRef = useRef(true);
  const trainingControlRailRef = useRef<HTMLElement | null>(null);
  const conversationPanelRef = useRef<HTMLDivElement | null>(null);
  const transcriptDialogueRef = useRef<HTMLDivElement | null>(null);
  const transcriptTurnsRef = useRef<TranscriptTurn[]>([]);
  const deletedTranscriptTurnIdsRef = useRef<Set<string>>(new Set());
  const manuallyAssignedSpeakerTurnIdsRef = useRef<Set<string>>(new Set());
  const autoOpenedLatestSessionRef = useRef(false);
  const diagnosticEventsRef = useRef<RealtimeDiagnosticEvent[]>([]);
  const audioStatsRef = useRef<RealtimeAudioStats | null>(null);
  const activeStreamRef = useRef<MediaStream | null>(stream);
  const clientSecretMetadataRef = useRef<{ expiresAt: number | null; sessionId: string | null }>({
    expiresAt: null,
    sessionId: null
  });
  const lastAudioDiagnosticAtRef = useRef(0);
  const realtimeStatusRef = useRef<RealtimeStatus>("disconnected");
  const diagnosticsActiveRef = useRef(false);
  const diagnosticsSendingRef = useRef(false);
  const diagnosticsStopTimerRef = useRef<number | null>(null);
  const unacknowledgedSpeechTimerRef = useRef<number | null>(null);
  const serverSpeechActiveRef = useRef(false);
  const lastServerSpeechStartedAtRef = useRef(0);

  function recordDiagnostic(
    type: string,
    details?: Record<string, boolean | number | string | null>
  ) {
    diagnosticEventsRef.current = [
      ...diagnosticEventsRef.current,
      { at: new Date().toISOString(), type, ...(details == null ? {} : { details }) }
    ].slice(-120);
  }

  function handleAudioStats(nextStats: RealtimeAudioStats) {
    audioStatsRef.current = nextStats;
    setAudioStats(nextStats);

    const now = Date.now();

    if (now - lastAudioDiagnosticAtRef.current >= 5000) {
      lastAudioDiagnosticAtRef.current = now;
      recordDiagnostic("audio.sample", {
        chunksObserved: nextStats.chunksObserved,
        silentChunks: nextStats.silentChunks,
        bufferedAmount: nextStats.dataChannelBufferedAmount,
        rms: Number(nextStats.rms.toFixed(5)),
        peak: Number(nextStats.peak.toFixed(5))
      });
    }

    const looksLikeSpeech =
      nextStats.rms >= loudSpeechRmsThreshold || nextStats.peak >= loudSpeechPeakThreshold;
    const serverRecentlyAcknowledgedSpeech =
      now - lastServerSpeechStartedAtRef.current < unacknowledgedSpeechDelayMs;

    if (
      looksLikeSpeech &&
      diagnosticsActiveRef.current &&
      !serverSpeechActiveRef.current &&
      !serverRecentlyAcknowledgedSpeech &&
      unacknowledgedSpeechTimerRef.current == null
    ) {
      const detectedAt = now;
      const candidate = {
        chunksObserved: nextStats.chunksObserved,
        rms: Number(nextStats.rms.toFixed(5)),
        peak: Number(nextStats.peak.toFixed(5))
      };

      unacknowledgedSpeechTimerRef.current = window.setTimeout(() => {
        unacknowledgedSpeechTimerRef.current = null;

        if (
          serverSpeechActiveRef.current ||
          lastServerSpeechStartedAtRef.current >= detectedAt ||
          !diagnosticsActiveRef.current
        ) {
          return;
        }

        recordDiagnostic("audio.unacknowledged_speech", {
          ...candidate,
          secondsSinceLastSpeechStarted:
            lastServerSpeechStartedAtRef.current > 0
              ? Number(
                  ((Date.now() - lastServerSpeechStartedAtRef.current) / 1000).toFixed(1)
                )
              : null
        });
        void flushDiagnostics();
      }, unacknowledgedSpeechDelayMs);
    }
  }

  function handleConnectionDiagnostic(event: {
    type: string;
    details?: Record<string, boolean | number | string | null>;
  }) {
    recordDiagnostic(event.type, event.details);

    const failedState = event.details?.state;
    const isClosedTransport =
      (event.type === "data_channel.state" && failedState === "closed") ||
      ((event.type === "peer_connection.state" || event.type === "ice_connection.state") &&
        ["closed", "disconnected", "failed"].includes(String(failedState))) ||
      event.type === "data_channel.error" ||
      event.type === "microphone_track.ended";

    if (isClosedTransport) {
      realtimeStatusRef.current = "error";
      setRealtimeStatus("error");
      setErrorMessage("Realtime audio path stopped. Diagnostics were recorded; restart live mode.");
      void flushDiagnostics();
    }
  }

  async function flushDiagnostics() {
    if (diagnosticsSendingRef.current || !diagnosticsActiveRef.current) {
      return;
    }

    diagnosticsSendingRef.current = true;

    try {
      await connectionRef.current?.collectStats?.();
      const activeStream = activeStreamRef.current ?? stream;
      const pendingEvents = [...diagnosticEventsRef.current];
      const report: RealtimeDiagnosticReport = {
        version: 1,
        reportId: createRealtimeDiagnosticId(),
        capturedAt: new Date().toISOString(),
        trigger: "automatic",
        runtime: {
          path: window.location.pathname,
          userAgent: navigator.userAgent,
          visibilityState: document.visibilityState
        },
        status: {
          realtime: realtimeStatusRef.current,
          microphonePresent: activeStream != null,
          clientSecretExpiresAt: clientSecretMetadataRef.current.expiresAt,
          openAiSessionId: clientSecretMetadataRef.current.sessionId
        },
        audio: {
          latestStats: audioStatsRef.current,
          tracks: (activeStream?.getTracks() ?? []).map((track) => ({
            kind: track.kind,
            readyState: track.readyState,
            enabled: track.enabled,
            muted: track.muted
          }))
        },
        events: pendingEvents
      };

      await submitDiagnostics(report);
      diagnosticEventsRef.current = diagnosticEventsRef.current.filter(
        (event) => !pendingEvents.includes(event)
      );
    } catch {
      // Keep the unsent ring buffer for the next automatic retry.
    } finally {
      diagnosticsSendingRef.current = false;
    }
  }

  useEffect(() => {
    connectionRef.current = connection;
  }, [connection]);

  useEffect(() => {
    const intervalId = window.setInterval(() => void flushDiagnostics(), 10_000);

    return () => {
      window.clearInterval(intervalId);
      if (diagnosticsStopTimerRef.current != null) {
        window.clearTimeout(diagnosticsStopTimerRef.current);
      }
      if (unacknowledgedSpeechTimerRef.current != null) {
        window.clearTimeout(unacknowledgedSpeechTimerRef.current);
      }
    };
  }, [submitDiagnostics]);

  useEffect(() => {
    transcriptTurnsRef.current = transcriptTurns;
  }, [transcriptTurns]);

  useEffect(() => {
    return () => {
      connectionRef.current?.disconnect();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    void sessionHistoryClient
      .loadSessions()
      .then((sessions) => {
        if (!cancelled) {
          const normalizedSessions = sessions.map(ensureUniqueSessionPhraseIds);

          setSavedSessions(normalizedSessions);

          const latestSession = normalizedSessions[0];

          if (
            autoOpenLatestSession &&
            !autoOpenedLatestSessionRef.current &&
            latestSession != null
          ) {
            autoOpenedLatestSessionRef.current = true;
            handleOpenSavedSession(latestSession);
          }
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setErrorMessage(toErrorMessage(error));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [autoOpenLatestSession, sessionHistoryClient]);

  const selectedPhraseCard =
    phraseCards.find((card) => card.id === selectedPhraseCardId) ?? null;
  const selectedTranscriptTurn =
    transcriptTurns.find((turn) => turn.id === selectedPhraseCardId) ?? null;
  const visibleAnalysis = selectedPhraseCard?.analysis ?? null;
  const selectedPhraseIsPreloading =
    selectedPhraseCard == null &&
    selectedTranscriptTurn != null &&
    pendingAnalysisIds.has(selectedTranscriptTurn.id);
  const selectedPhraseNeedsAnalysis =
    selectedPhraseCard == null &&
    selectedTranscriptTurn != null &&
    !pendingAnalysisIds.has(selectedTranscriptTurn.id);
  const audioLevel = Math.min(1, Math.max((audioStats?.peak ?? 0) * 24, (audioStats?.rms ?? 0) * 80));
  const audioLevelPercent = Math.round(audioLevel * 100);
  const transcriptExport = transcriptTurns
    .map((turn) => `${turn.speakerLabel}: ${turn.text}`)
    .join("\n");
  const selectedTranscriptTurns = transcriptTurns.filter((turn) =>
    selectedTranscriptTurnIds.has(turn.id)
  );
  const notesCharacterCount = notes.trim().length;

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

  const hasSessionContent =
    transcriptTurns.length > 0 ||
    phraseCards.length > 0 ||
    selectedReplies.length > 0 ||
    usedBridgePhrases.length > 0;

  function buildSessionDraft(): SessionHistoryEntryDraft {
    return {
      sourceLabel: sourceLabel.trim() || "Training session",
      knowledgeContext: notes,
      transcriptTurns,
      phraseCards,
      selectedReplies,
      usedBridgePhrases
    };
  }

  function rememberSavedSession(savedEntry: SessionHistoryEntry) {
    setSavedSessions((current) => {
      const existingIndex = current.findIndex((session) => session.id === savedEntry.id);

      if (existingIndex < 0) {
        return [savedEntry, ...current].slice(0, 20);
      }

      const nextSessions = [...current];
      nextSessions[existingIndex] = savedEntry;
      return nextSessions;
    });
  }

  function setFollowLiveMode(nextFollowLive: boolean) {
    followLiveRef.current = nextFollowLive;
    setFollowLive(nextFollowLive);
  }

  function updateTranscriptSpeakerLabel(
    turnId: string,
    speakerLabel: SessionSpeakerLabel,
    onlyWhenUnconfirmed = false
  ) {
    setTranscriptTurns((current) => {
      const nextTurns = current.map((turn) =>
        turn.id === turnId &&
        (!onlyWhenUnconfirmed ||
          (turn.speakerLabel === "Heard" &&
            !manuallyAssignedSpeakerTurnIdsRef.current.has(turnId)))
          ? { ...turn, speakerLabel }
          : turn
      );
      transcriptTurnsRef.current = nextTurns;
      return nextTurns;
    });
  }

  function cycleTranscriptSpeakerLabel(turn: TranscriptTurn) {
    manuallyAssignedSpeakerTurnIdsRef.current.add(turn.id);
    updateTranscriptSpeakerLabel(turn.id, getNextSpeakerLabel(turn.speakerLabel));
  }

  function scrollTranscriptToLatest(behavior: ScrollBehavior) {
    const transcriptDialogue = transcriptDialogueRef.current;

    if (transcriptDialogue == null) {
      return;
    }

    if (typeof transcriptDialogue.scrollTo === "function") {
      transcriptDialogue.scrollTo({
        top: transcriptDialogue.scrollHeight,
        behavior
      });
      return;
    }

    transcriptDialogue.scrollTop = transcriptDialogue.scrollHeight;
  }

  useLayoutEffect(() => {
    if (followLive) {
      scrollTranscriptToLatest("auto");
    }
  }, [followLive, liveTranscriptDraft, transcriptTurns]);

  useEffect(() => {
    if (!hasSessionContent) {
      return;
    }

    let cancelled = false;
    const sessionId = currentSessionIdRef.current ?? createSessionId();
    currentSessionIdRef.current = sessionId;

    void sessionHistoryClient
      .saveCurrentSession(sessionId, buildSessionDraft())
      .then((savedEntry) => {
        if (!cancelled) {
          rememberSavedSession(savedEntry);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setErrorMessage(toErrorMessage(error));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    hasSessionContent,
    transcriptTurns,
    phraseCards,
    selectedReplies,
    usedBridgePhrases,
    notes,
    sourceLabel,
    sessionHistoryClient,
    createSessionId
  ]);

  function resolveSelectedReplyIndex(
    phraseId: string | null,
    cards: TrainingPhraseCard[],
    replies: SessionHistorySelectedReply[]
  ) {
    const selectedCard = cards.find((card) => card.id === phraseId);
    const selectedReply = replies.find((reply) => reply.phraseId === phraseId);

    if (selectedCard == null || selectedReply == null) {
      return null;
    }

    const replyIndex = selectedCard.analysis.suggestedReplies.findIndex(
      (reply) =>
        reply.shortLabel === selectedReply.reply.shortLabel &&
        reply.fullSentence === selectedReply.reply.fullSentence
    );

    return replyIndex >= 0 ? replyIndex : null;
  }

  async function analyzeCompletedTranscript(
    completedTranscript: string,
    phraseId: string,
    shouldShowAnalysis: boolean,
    recentContext: string[]
  ) {
    const trimmedTranscript = completedTranscript.trim();

    if (trimmedTranscript.length === 0) {
      return;
    }

    setPendingAnalysisIds((current) => new Set(current).add(phraseId));

    if (shouldShowAnalysis) {
      setAnalysisStatus("loading");
      setSelectedReplyIndex(null);
    }

    try {
      const nextAnalysis = await analyzePhrase(trimmedTranscript, notes, recentContext);

      if (deletedTranscriptTurnIdsRef.current.has(phraseId)) {
        setPendingAnalysisIds((current) => {
          const next = new Set(current);
          next.delete(phraseId);
          return next;
        });
        return;
      }

      const nextCard = {
        id: phraseId,
        transcript: trimmedTranscript,
        analysis: nextAnalysis,
        source: "auto" as const
      };

      const inferredSpeakerLabel = resolveAnalysisSpeakerLabel(nextAnalysis.speakerRole);
      if (inferredSpeakerLabel !== "Heard") {
        updateTranscriptSpeakerLabel(phraseId, inferredSpeakerLabel, true);
      }

      setPhraseCards((current) => [...current, nextCard].slice(-20));
      setPendingAnalysisIds((current) => {
        const next = new Set(current);
        next.delete(phraseId);
        return next;
      });
      if (shouldShowAnalysis) {
        setAnalysisStatus("ready");
      }
    } catch (error) {
      setPendingAnalysisIds((current) => {
        const next = new Set(current);
        next.delete(phraseId);
        return next;
      });
      if (shouldShowAnalysis) {
        setAnalysisStatus("error");
      }
      setErrorMessage(toErrorMessage(error));
    }
  }

  function handleRealtimeEvent(event: RealtimeServerEvent) {
    recordDiagnostic("realtime.server_event", { eventType: event.type });

    if (event.type === "session.created" || event.type === "session.updated") {
      const session = event.session as
        | {
            id?: unknown;
            expires_at?: unknown;
            audio?: {
              input?: {
                turn_detection?: {
                  type?: unknown;
                  threshold?: unknown;
                  prefix_padding_ms?: unknown;
                  silence_duration_ms?: unknown;
                  eagerness?: unknown;
                };
              };
            };
          }
        | undefined;
      clientSecretMetadataRef.current = {
        expiresAt:
          typeof session?.expires_at === "number"
            ? session.expires_at
            : clientSecretMetadataRef.current.expiresAt,
        sessionId:
          typeof session?.id === "string" ? session.id : clientSecretMetadataRef.current.sessionId
      };

      const effectiveVad = session?.audio?.input?.turn_detection;

      if (effectiveVad != null) {
        recordDiagnostic("realtime.session_config", {
          vadMode: typeof effectiveVad.type === "string" ? effectiveVad.type : "unknown",
          vadThreshold:
            typeof effectiveVad.threshold === "number" ? effectiveVad.threshold : null,
          vadPrefixPaddingMs:
            typeof effectiveVad.prefix_padding_ms === "number"
              ? effectiveVad.prefix_padding_ms
              : null,
          vadSilenceDurationMs:
            typeof effectiveVad.silence_duration_ms === "number"
              ? effectiveVad.silence_duration_ms
              : null,
          semanticEagerness:
            typeof effectiveVad.eagerness === "string" ? effectiveVad.eagerness : null
        });
      }
    }

    if (event.type === "input_audio_buffer.speech_started") {
      serverSpeechActiveRef.current = true;
      lastServerSpeechStartedAtRef.current = Date.now();
      if (unacknowledgedSpeechTimerRef.current != null) {
        window.clearTimeout(unacknowledgedSpeechTimerRef.current);
        unacknowledgedSpeechTimerRef.current = null;
      }
    }

    if (event.type === "input_audio_buffer.speech_stopped") {
      serverSpeechActiveRef.current = false;
    }

    if (event.type === "error") {
      const realtimeError = event.error as
        | { code?: unknown; message?: unknown; type?: unknown }
        | undefined;
      const errorDetails = {
        code: typeof realtimeError?.code === "string" ? realtimeError.code : null,
        errorType: typeof realtimeError?.type === "string" ? realtimeError.type : null
      };

      recordDiagnostic("realtime.error", errorDetails);
      setErrorMessage(
        typeof realtimeError?.message === "string"
          ? realtimeError.message.slice(0, 240)
          : "OpenAI Realtime returned an error."
      );
      void flushDiagnostics();
    }

    if (
      event.type === "conversation.item.input_audio_transcription.delta" &&
      typeof event.delta === "string"
    ) {
      setLiveTranscriptDraft((current) => `${current}${event.delta}`);
    }

    if (
      event.type === "conversation.item.input_audio_transcription.completed" &&
      typeof event.transcript === "string"
    ) {
      const completedTranscript = event.transcript.trim();
      const phraseId = `training-phrase-${phraseCardSequence.current}`;
      const shouldShowAnalysis = followLiveRef.current;

      if (isObviousTranscriptNoise(completedTranscript)) {
        setLiveTranscriptDraft("");
        return;
      }

      if (completedTranscript.length > 0) {
        phraseCardSequence.current += 1;
        const nextTurn = {
          id: phraseId,
          speakerLabel: "Heard" as const,
          text: completedTranscript
        };
        const nextTranscriptTurns = [...transcriptTurnsRef.current, nextTurn].slice(-50);
        transcriptTurnsRef.current = nextTranscriptTurns;
        setTranscriptTurns(nextTranscriptTurns);
        if (shouldShowAnalysis) {
          setSelectedPhraseCardId(phraseId);
        }
      }
      setLiveTranscriptDraft("");
      if (completedTranscript.length > 0) {
        void analyzeCompletedTranscript(
          completedTranscript,
          phraseId,
          shouldShowAnalysis,
          buildRecentAnalysisContext(transcriptTurnsRef.current, phraseId)
        );
      }
    }
  }

  async function handleStartLive() {
    if (connectionRef.current != null || realtimeStatus === "connecting") {
      return;
    }

    let liveStream = stream;

    if (liveStream == null) {
      const requestedStream = await onRequestMicrophone?.();
      liveStream = requestedStream ?? null;
    }

    if (liveStream == null) {
      setErrorMessage("Could not start microphone for live mode.");
      return;
    }

    setErrorMessage("");
    realtimeStatusRef.current = "connecting";
    setRealtimeStatus("connecting");

    try {
      const clientSecret = await requestClientSecret("realtime-vad");
      activeStreamRef.current = liveStream;
      clientSecretMetadataRef.current = {
        expiresAt: clientSecret.expiresAt,
        sessionId: clientSecret.sessionId ?? null
      };
      diagnosticEventsRef.current = [];
      if (diagnosticsStopTimerRef.current != null) {
        window.clearTimeout(diagnosticsStopTimerRef.current);
        diagnosticsStopTimerRef.current = null;
      }
      diagnosticsActiveRef.current = true;
      serverSpeechActiveRef.current = false;
      lastServerSpeechStartedAtRef.current = 0;
      recordDiagnostic("training_live.start", {
        clientSecretExpiresAt: clientSecret.expiresAt,
        trackCount: liveStream.getTracks().length,
        vadMode: turnDetectionSettings.mode,
        vadThreshold: turnDetectionSettings.threshold,
        vadPrefixPaddingMs: turnDetectionSettings.prefixPaddingMs,
        vadSilenceDurationMs: turnDetectionSettings.silenceDurationMs,
        semanticEagerness: turnDetectionSettings.semanticEagerness,
        speechLanguage
      });
      const realtimeConnection = await connectRealtime({
        stream: liveStream,
        clientSecret: clientSecret.clientSecret,
        sessionUpdateAfterOpen: buildRealtimeTranscriptionSessionUpdate(
          turnDetectionSettings,
          speechLanguage
        ),
        onEvent: handleRealtimeEvent,
        onAudioStats: handleAudioStats,
        onDiagnosticEvent: handleConnectionDiagnostic,
        onError: (message) => {
          recordDiagnostic("realtime.client_error");
          setErrorMessage(message);
        }
      });

      setConnection(realtimeConnection);
      realtimeStatusRef.current = "connected";
      setRealtimeStatus("connected");
      recordDiagnostic("training_live.connected");
      void flushDiagnostics();
    } catch (error) {
      recordDiagnostic("training_live.start_error");
      setConnection(null);
      realtimeStatusRef.current = "error";
      setRealtimeStatus("error");
      setErrorMessage(toErrorMessage(error));
      onStopMicrophone?.();
      void flushDiagnostics();
    }
  }

  function handleDisconnect() {
    connection?.disconnect();
    setConnection(null);
    realtimeStatusRef.current = "disconnected";
    setRealtimeStatus("disconnected");
  }

  function handleStopLive() {
    recordDiagnostic("training_live.stop");
    void flushDiagnostics();
    handleDisconnect();
    setAudioStats(null);
    onStopMicrophone?.();
    activeStreamRef.current = null;
    serverSpeechActiveRef.current = false;
    if (unacknowledgedSpeechTimerRef.current != null) {
      window.clearTimeout(unacknowledgedSpeechTimerRef.current);
      unacknowledgedSpeechTimerRef.current = null;
    }
    diagnosticsStopTimerRef.current = window.setTimeout(() => {
      diagnosticsActiveRef.current = false;
      diagnosticsStopTimerRef.current = null;
    }, 15_000);
  }

  async function handleCopyTranscript() {
    await copyText(transcriptExport || liveTranscriptDraft.trim());
    setCopyStatus("Transcript copied.");
  }

  async function handleCopyReply() {
    if (visibleAnalysis == null || selectedReplyIndex == null) {
      return;
    }

    setFollowLiveMode(false);
    await copyText(visibleAnalysis.suggestedReplies[selectedReplyIndex]?.fullSentence ?? "");
    setCopyStatus("Reply copied.");
  }

  async function handleCopyBridgePhrase() {
    const selectedBridgePhrase = localBridgePhrases[selectedBridgePhraseIndex];

    setFollowLiveMode(false);
    await copyText(selectedBridgePhrase.english);
    setUsedBridgePhrases((current) => [...current, selectedBridgePhrase]);
    setCopyStatus("Bridge phrase copied.");
  }

  function toggleTranscriptSelectionMode() {
    setTranscriptSelectionMode((current) => {
      const next = !current;

      if (!next) {
        setSelectedTranscriptTurnIds(new Set());
      }

      return next;
    });
  }

  function toggleTranscriptTurnSelection(turnId: string) {
    setSelectedTranscriptTurnIds((current) => {
      const next = new Set(current);

      if (next.has(turnId)) {
        next.delete(turnId);
      } else {
        next.add(turnId);
      }

      return next;
    });
  }

  function clearTranscriptSelection() {
    setSelectedTranscriptTurnIds(new Set());
  }

  function handleDeleteSelectedTranscriptTurns() {
    if (selectedTranscriptTurns.length === 0) {
      return;
    }

    const selectedIds = new Set(selectedTranscriptTurns.map((turn) => turn.id));
    const messageLabel = selectedIds.size === 1 ? "message" : "messages";

    if (!window.confirm(`Delete ${selectedIds.size} selected ${messageLabel}?`)) {
      return;
    }

    selectedIds.forEach((turnId) => deletedTranscriptTurnIdsRef.current.add(turnId));
    selectedIds.forEach((turnId) => manuallyAssignedSpeakerTurnIdsRef.current.delete(turnId));

    const nextTranscriptTurns = transcriptTurns.filter((turn) => !selectedIds.has(turn.id));
    const nextPhraseCards = phraseCards.filter((card) => !selectedIds.has(card.id));
    const nextSelectedReplies = selectedReplies.filter(
      (selectedReply) => !selectedIds.has(selectedReply.phraseId)
    );
    const nextSelectedPhraseCardId =
      selectedPhraseCardId != null && selectedIds.has(selectedPhraseCardId)
        ? (nextTranscriptTurns.at(-1)?.id ?? nextPhraseCards.at(-1)?.id ?? null)
        : selectedPhraseCardId;

    transcriptTurnsRef.current = nextTranscriptTurns;
    setTranscriptTurns(nextTranscriptTurns);
    setPhraseCards(nextPhraseCards);
    setSelectedReplies(nextSelectedReplies);
    setPendingAnalysisIds((current) => {
      const next = new Set(current);
      selectedIds.forEach((turnId) => next.delete(turnId));
      return next;
    });
    setSelectedPhraseCardId(nextSelectedPhraseCardId);
    setSelectedReplyIndex(
      resolveSelectedReplyIndex(nextSelectedPhraseCardId, nextPhraseCards, nextSelectedReplies)
    );
    setAnalysisStatus(nextPhraseCards.length > 0 ? "ready" : "idle");
    setSelectedTranscriptTurnIds(new Set());
  }

  async function handleGenerateSelectedTranscriptCard() {
    if (selectedTranscriptTurns.length === 0) {
      return;
    }

    const selectedTexts = selectedTranscriptTurns.map((turn) => turn.text.trim());
    const selectedContext = selectedTranscriptTurns.map((turn) =>
      turn.speakerLabel === "Heard"
        ? turn.text.trim()
        : `${turn.speakerLabel}: ${turn.text.trim()}`
    );
    const selectedTranscript = selectedTexts.join("\n");
    const manualPhraseId = `selected-group-${Date.now()}`;

    setFollowLiveMode(false);
    setSelectedPhraseCardId(manualPhraseId);
    setAnalysisStatus("loading");
    setSelectedReplyIndex(null);
    setPendingAnalysisIds((current) => new Set(current).add(manualPhraseId));

    try {
      const nextAnalysis = await analyzePhrase(selectedTranscript, notes, selectedContext);
      const nextCard = {
        id: manualPhraseId,
        transcript: selectedTranscript,
        analysis: nextAnalysis,
        source: "selected-group" as const
      };

      setPhraseCards((current) => [...current, nextCard].slice(-20));
      setPendingAnalysisIds((current) => {
        const next = new Set(current);
        next.delete(manualPhraseId);
        return next;
      });
      setAnalysisStatus("ready");
    } catch (error) {
      setPendingAnalysisIds((current) => {
        const next = new Set(current);
        next.delete(manualPhraseId);
        return next;
      });
      setAnalysisStatus("error");
      setErrorMessage(toErrorMessage(error));
    }
  }

  async function handleGenerateSelectedTranscriptTurnCard() {
    if (selectedTranscriptTurn == null) {
      return;
    }

    const transcript = selectedTranscriptTurn.text.trim();

    if (transcript.length === 0) {
      return;
    }

    const phraseId = selectedTranscriptTurn.id;

    setFollowLiveMode(false);
    setAnalysisStatus("loading");
    setSelectedReplyIndex(null);
    setPendingAnalysisIds((current) => new Set(current).add(phraseId));

    try {
      const nextAnalysis = await analyzePhrase(
        transcript,
        notes,
        buildRecentAnalysisContext(transcriptTurns, phraseId)
      );
      const inferredSpeakerLabel = resolveAnalysisSpeakerLabel(nextAnalysis.speakerRole);
      if (inferredSpeakerLabel !== "Heard") {
        updateTranscriptSpeakerLabel(phraseId, inferredSpeakerLabel, true);
      }
      const nextCard = {
        id: phraseId,
        transcript,
        analysis: nextAnalysis,
        source: "auto" as const
      };

      setPhraseCards((current) => [
        ...current.filter((card) => card.id !== phraseId),
        nextCard
      ].slice(-20));
      setPendingAnalysisIds((current) => {
        const next = new Set(current);
        next.delete(phraseId);
        return next;
      });
      setAnalysisStatus("ready");
    } catch (error) {
      setPendingAnalysisIds((current) => {
        const next = new Set(current);
        next.delete(phraseId);
        return next;
      });
      setAnalysisStatus("error");
      setErrorMessage(toErrorMessage(error));
    }
  }

  function handleSelectReply(index: number) {
    setFollowLiveMode(false);
    setSelectedReplyIndex(index);

    if (selectedPhraseCard == null || visibleAnalysis == null) {
      return;
    }

    const reply = visibleAnalysis.suggestedReplies[index];

    if (reply == null) {
      return;
    }

    setSelectedReplies((current) => [
      ...current.filter((selectedReply) => selectedReply.phraseId !== selectedPhraseCard.id),
      {
        phraseId: selectedPhraseCard.id,
        reply
      }
    ]);
  }

  async function refreshSavedSessions() {
    try {
      setSavedSessions((await sessionHistoryClient.loadSessions()).map(ensureUniqueSessionPhraseIds));
    } catch (error) {
      setErrorMessage(toErrorMessage(error));
    }
    setHistoryPanelOpen((current) => !current);
  }

  async function handleDeleteSavedSession(session: SessionHistoryEntry) {
    if (!window.confirm("Delete this saved session?")) {
      return;
    }

    try {
      const nextSessions = await sessionHistoryClient.deleteSession(session.id);

      if (currentSessionIdRef.current === session.id) {
        currentSessionIdRef.current = null;
      }

      setSavedSessions(nextSessions);
    } catch (error) {
      setErrorMessage(toErrorMessage(error));
    }
  }

  function handleNewSession() {
    currentSessionIdRef.current = null;
    setFollowLiveMode(true);
    transcriptTurnsRef.current = [];
    deletedTranscriptTurnIdsRef.current = new Set();
    manuallyAssignedSpeakerTurnIdsRef.current = new Set();
    setTranscriptTurns([]);
    setLiveTranscriptDraft("");
    setPhraseCards([]);
    setPendingAnalysisIds(new Set());
    setSelectedPhraseCardId(null);
    setTranscriptSelectionMode(false);
    setSelectedTranscriptTurnIds(new Set());
    setSelectedReplies([]);
    setUsedBridgePhrases([]);
    setSelectedReplyIndex(null);
    setAnalysisStatus("idle");
    setErrorMessage("");
    setCopyStatus("");
  }

  function handleOpenSavedSession(session: SessionHistoryEntry) {
    const normalizedSession = ensureUniqueSessionPhraseIds(session);
    const lastCardId =
      normalizedSession.transcriptTurns.at(-1)?.id ??
      normalizedSession.phraseCards.at(-1)?.id ??
      null;

    currentSessionIdRef.current = normalizedSession.id;
    setFollowLiveMode(false);
    phraseCardSequence.current = getNextPhraseCardSequence(normalizedSession);
    transcriptTurnsRef.current = normalizedSession.transcriptTurns;
    deletedTranscriptTurnIdsRef.current = new Set();
    manuallyAssignedSpeakerTurnIdsRef.current = new Set();
    setTranscriptTurns(normalizedSession.transcriptTurns);
    setLiveTranscriptDraft("");
    setPhraseCards(normalizedSession.phraseCards);
    setPendingAnalysisIds(new Set());
    setSelectedPhraseCardId(lastCardId);
    setTranscriptSelectionMode(false);
    setSelectedTranscriptTurnIds(new Set());
    setSelectedReplies(normalizedSession.selectedReplies);
    setUsedBridgePhrases(normalizedSession.usedBridgePhrases);
    setSelectedReplyIndex(
      resolveSelectedReplyIndex(
        lastCardId,
        normalizedSession.phraseCards,
        normalizedSession.selectedReplies
      )
    );
    setAnalysisStatus(normalizedSession.phraseCards.length > 0 ? "ready" : "idle");
    setCopyStatus("");
  }

  function handleTurnDetectionSettingsChange(
    nextSettings: typeof defaultRealtimeTurnDetectionSettings
  ) {
    saveRealtimeTurnDetectionSettings(window.localStorage, nextSettings);
    setTurnDetectionSettings(nextSettings);
  }

  function handleSpeechLanguageChange(nextSpeechLanguage: typeof speechLanguage) {
    saveRealtimeSpeechLanguageSettings(window.localStorage, nextSpeechLanguage);
    setSpeechLanguage(nextSpeechLanguage);
  }

  function handleFollowLive() {
    const latestCardId = transcriptTurns.at(-1)?.id ?? phraseCards.at(-1)?.id ?? null;

    setFollowLiveMode(true);
    if (latestCardId != null) {
      setSelectedPhraseCardId(latestCardId);
      setSelectedReplyIndex(resolveSelectedReplyIndex(latestCardId, phraseCards, selectedReplies));
    }
  }

  function handlePauseFollowLive() {
    setFollowLiveMode(false);
  }

  function handleJumpToLatestMessage() {
    const trainingControlRail = trainingControlRailRef.current;
    const conversationPanel = conversationPanelRef.current;
    const transcriptDialogue = transcriptDialogueRef.current;
    const latestCardId = transcriptTurns.at(-1)?.id ?? phraseCards.at(-1)?.id ?? null;

    if (transcriptDialogue == null) {
      return;
    }

    if (latestCardId != null) {
      setSelectedPhraseCardId(latestCardId);
      setSelectedReplyIndex(resolveSelectedReplyIndex(latestCardId, phraseCards, selectedReplies));
    }

    const stickyRailHeight = trainingControlRail?.getBoundingClientRect().height ?? 0;
    const conversationPanelTop = conversationPanel?.getBoundingClientRect().top;

    if (conversationPanelTop != null) {
      window.scrollTo({
        top: Math.max(0, window.scrollY + conversationPanelTop - stickyRailHeight - 12),
        behavior: "smooth"
      });
    }

    scrollTranscriptToLatest("smooth");
  }

  return (
    <main className="copilot-shell">
      <section
        ref={trainingControlRailRef}
        className="training-control-rail"
        aria-label="Training Mode controls"
      >
        <header className="topbar">
          <div>
            <p className="eyebrow">iPad companion mode</p>
            <h1>Training Mode</h1>
          </div>
          <div className="topbar-actions">
            {connection == null ? (
              <button
                type="button"
                disabled={realtimeStatus === "connecting" || (stream == null && onRequestMicrophone == null)}
                onClick={handleStartLive}
              >
                {realtimeStatus === "connecting" ? "Starting live..." : "Start live"}
              </button>
            ) : (
              <button type="button" onClick={handleStopLive}>
                Stop live
              </button>
            )}
            <button type="button" onClick={handleNewSession}>
              New session
            </button>
            <button type="button" onClick={refreshSavedSessions}>
              Sessions
            </button>
            <button type="button" onClick={() => setNotesDialogOpen(true)}>
              Notes
            </button>
            <button type="button" onClick={handleCopyTranscript}>
              Copy transcript
            </button>
          </div>
        </header>

        <section className="training-status-row" aria-label="Training Mode status">
          <span className={`status status-${stream == null ? "idle" : "active"}`}>
            Microphone: {stream == null ? "not connected" : "active"}
          </span>
          <span className={`status status-${realtimeStatus}`}>Realtime: {realtimeStatus}</span>
          <span className="status">
            Notes: {notesCharacterCount > 0 ? `${notesCharacterCount} chars` : "empty"}
          </span>
          <div
            className="status training-audio-level"
            role="meter"
            aria-label="Microphone level"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={audioLevelPercent}
          >
            <span className="training-audio-label">Mic level</span>
            <span className="audio-meter" aria-hidden="true">
              <span style={{ transform: `scaleX(${audioLevel})` }} />
            </span>
          </div>
        </section>
      </section>

      {notesDialogOpen ? (
        <div className="modal-backdrop" onClick={() => setNotesDialogOpen(false)}>
          <section
            className="notes-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="notes-dialog-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-header">
              <h2 id="notes-dialog-title">Pasted notes</h2>
              <button type="button" onClick={() => setNotesDialogOpen(false)}>
                Done
              </button>
            </div>
            <label className="notes-label" htmlFor="live-knowledge-notes">
              Pasted notes
            </label>
            <textarea
              id="live-knowledge-notes"
              className="notes-dialog-textarea"
              value={notes}
              onChange={(event) => onNotesChange?.(event.target.value)}
              placeholder="Факты о проекте, клиенте, правила ответа или контекст разговора."
            />
          </section>
        </div>
      ) : null}

      {historyPanelOpen ? (
        <div className="session-history-layer">
          <section
            className="session-history-panel session-history-drawer"
            role="dialog"
            aria-labelledby="session-history-title"
          >
            <div className="session-history-header">
              <h2 id="session-history-title">Saved sessions</h2>
              <div className="session-history-actions">
                <button
                  type="button"
                  disabled={savedSessions.length === 0}
                  onClick={() => {
                    const latestSession = savedSessions[0];

                    if (latestSession != null) {
                      handleOpenSavedSession(latestSession);
                    }
                  }}
                >
                  Open latest
                </button>
                <button type="button" onClick={() => setHistoryPanelOpen(false)}>
                  Close
                </button>
              </div>
            </div>
            {savedSessions.length === 0 ? (
              <p className="hint">No saved sessions yet.</p>
            ) : (
              <div className="session-history-list">
                {savedSessions.map((session) => (
                  <div className="session-history-row" key={session.id}>
                    <button
                      type="button"
                      className="session-history-item"
                      onClick={() => handleOpenSavedSession(session)}
                    >
                      <span className="session-history-title">{getSessionTitle(session)}</span>
                      <span className="session-history-meta">
                        <span>
                          <span className="session-history-meta-label">Created</span>
                          <time dateTime={session.createdAt}>
                            {formatSessionTimestamp(session.createdAt)}
                          </time>
                        </span>
                        <span>
                          <span className="session-history-meta-label">Updated</span>
                          <time dateTime={session.updatedAt}>
                            {formatSessionTimestamp(session.updatedAt)}
                          </time>
                        </span>
                      </span>
                    </button>
                    <button
                      type="button"
                      className="session-history-delete"
                      aria-label="Delete session"
                      title="Delete session"
                      onClick={() => void handleDeleteSavedSession(session)}
                    >
                      <Trash2 aria-hidden="true" size={16} strokeWidth={1.8} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      ) : null}

      <TurnDetectionControls
        settings={turnDetectionSettings}
        disabled={connection != null || realtimeStatus === "connecting"}
        onChange={handleTurnDetectionSettingsChange}
      />

      <SpeechLanguageControls
        speechLanguage={speechLanguage}
        disabled={connection != null || realtimeStatus === "connecting"}
        onChange={handleSpeechLanguageChange}
      />

      <section className="copilot-grid">
        <div ref={conversationPanelRef} className="conversation-panel">
          <div className="transcript-panel-header transcript-panel-header-sticky">
            <h2>Live English transcript</h2>
            <div className="transcript-panel-actions">
              {transcriptSelectionMode ? (
                <div className="transcript-selection-actions" aria-label="Transcript selection actions">
                  <span>{selectedTranscriptTurns.length} selected</span>
                  <button
                    type="button"
                    className="transcript-action-icon"
                    aria-label="Generate card"
                    title="Generate card"
                    onClick={handleGenerateSelectedTranscriptCard}
                    disabled={selectedTranscriptTurns.length === 0}
                  >
                    <Sparkles aria-hidden="true" size={18} strokeWidth={1.8} />
                  </button>
                  <button
                    type="button"
                    className="transcript-action-icon"
                    aria-label="Clear selection"
                    title="Clear selection"
                    onClick={clearTranscriptSelection}
                    disabled={selectedTranscriptTurns.length === 0}
                  >
                    <Eraser aria-hidden="true" size={18} strokeWidth={1.8} />
                  </button>
                  <button
                    type="button"
                    className="transcript-action-icon transcript-delete-selected"
                    aria-label="Delete selected"
                    title="Delete selected"
                    onClick={handleDeleteSelectedTranscriptTurns}
                    disabled={selectedTranscriptTurns.length === 0}
                  >
                    <Trash2 aria-hidden="true" size={18} strokeWidth={1.8} />
                  </button>
                </div>
              ) : null}
              {!transcriptSelectionMode && selectedTranscriptTurn != null ? (
                <button
                  type="button"
                  className="transcript-action-icon"
                  aria-label={selectedPhraseCard == null ? "Generate card" : "Regenerate card"}
                  title={selectedPhraseCard == null ? "Generate card" : "Regenerate card"}
                  onClick={() => void handleGenerateSelectedTranscriptTurnCard()}
                  disabled={pendingAnalysisIds.has(selectedTranscriptTurn.id)}
                >
                  <Sparkles aria-hidden="true" size={18} strokeWidth={1.8} />
                </button>
              ) : null}
              <button
                type="button"
                className="jump-latest-button transcript-action-icon"
                aria-label="Jump to latest message"
                title="Latest message"
                onClick={handleJumpToLatestMessage}
                disabled={transcriptTurns.length === 0 && liveTranscriptDraft.trim().length === 0}
              >
                <ArrowDownToLine aria-hidden="true" size={18} strokeWidth={1.8} />
              </button>
              <button
                type="button"
                className={transcriptSelectionMode ? "transcript-action-icon" : undefined}
                aria-label={transcriptSelectionMode ? "Cancel select" : undefined}
                title={transcriptSelectionMode ? "Cancel select" : undefined}
                onClick={toggleTranscriptSelectionMode}
              >
                {transcriptSelectionMode ? (
                  <X aria-hidden="true" size={18} strokeWidth={1.8} />
                ) : (
                  "Select"
                )}
              </button>
            </div>
          </div>
          <div
            ref={transcriptDialogueRef}
            className="transcript-box transcript-dialogue"
            aria-label="Conversation transcript"
          >
            {transcriptTurns.length === 0 && liveTranscriptDraft.trim().length === 0 ? (
              <p className="transcript-empty">Waiting for transcript...</p>
            ) : null}
            {transcriptTurns.map((turn) => (
              <article
                className={[
                  "transcript-turn",
                  turn.id === selectedPhraseCardId ? "transcript-turn-selected" : "",
                  selectedTranscriptTurnIds.has(turn.id) ? "transcript-turn-group-selected" : ""
                ]
                  .filter(Boolean)
                  .join(" ")}
                key={turn.id}
              >
                <button
                  type="button"
                  className="transcript-speaker transcript-speaker-control"
                  aria-label={`Change speaker for ${turn.text}. Current role ${turn.speakerLabel}`}
                  title="Change speaker role"
                  onClick={() => cycleTranscriptSpeakerLabel(turn)}
                >
                  {getCompactSpeakerLabel(turn.speakerLabel)}
                </button>
                <button
                  type="button"
                  className="transcript-turn-content"
                  aria-label={`${turn.speakerLabel} ${turn.text}`}
                  aria-pressed={
                    transcriptSelectionMode ? selectedTranscriptTurnIds.has(turn.id) : undefined
                  }
                  onClick={() => {
                    if (transcriptSelectionMode) {
                      toggleTranscriptTurnSelection(turn.id);
                      return;
                    }

                    setFollowLiveMode(false);
                    setSelectedPhraseCardId(turn.id);
                    setSelectedReplyIndex(
                      resolveSelectedReplyIndex(turn.id, phraseCards, selectedReplies)
                    );
                  }}
                >
                  <p>{turn.text}</p>
                </button>
              </article>
            ))}
            {liveTranscriptDraft.trim().length > 0 ? (
              <article className="transcript-turn transcript-turn-live">
                <span className="transcript-speaker">Live</span>
                <p>{liveTranscriptDraft.trim()}</p>
              </article>
            ) : null}
          </div>
          <div className="local-bridge-block">
            <div className="local-bridge-header">
              <h2>Bridge phrases</h2>
              <button type="button" onClick={handleCopyBridgePhrase}>
                Copy bridge phrase
              </button>
            </div>
            <div className="local-bridge-phrases" aria-label="Local bridge phrases">
              {localBridgePhrases.map((phrase, index) => (
                <button
                  type="button"
                  key={phrase.english}
                  className={
                    selectedBridgePhraseIndex === index
                      ? "local-bridge-phrase local-bridge-phrase-selected"
                      : "local-bridge-phrase"
                  }
                  onClick={() => setSelectedBridgePhraseIndex(index)}
                >
                  <span>{phrase.english}</span>
                  <span className="local-bridge-translation">{phrase.russian}</span>
                </button>
              ))}
            </div>
          </div>
          {usedBridgePhrases.length > 0 ? (
            <p className="hint">Used bridge phrases: {usedBridgePhrases.length}</p>
          ) : null}
          {errorMessage.length > 0 ? <p className="error-text">{errorMessage}</p> : null}
          {copyStatus.length > 0 ? <p className="hint">{copyStatus}</p> : null}
        </div>

        <aside
          className="suggestions-panel suggestions-panel-sticky"
          aria-label="Current phrase suggestions"
        >
          <div className="suggestions-panel-header">
            <div>
              <h2>Russian meaning and replies</h2>
              <p className="follow-live-status">
                {followLive ? "Following latest phrase" : "Paused on selected phrase"}
              </p>
            </div>
            {followLive ? (
              <button
                type="button"
                className="follow-live-pill"
                aria-label="Pause following live"
                onClick={handlePauseFollowLive}
              >
                <span>Following</span>
                <span>live</span>
              </button>
            ) : (
              <button type="button" className="follow-live-button" onClick={handleFollowLive}>
                Follow live
              </button>
            )}
          </div>
          {analysisStatus === "idle" && !selectedPhraseIsPreloading ? (
            <p className="hint">Waiting for a completed phrase.</p>
          ) : null}
          {analysisStatus === "loading" && !selectedPhraseIsPreloading ? (
            <p className="hint">Analyzing phrase...</p>
          ) : null}
          {analysisStatus === "error" ? <p className="error-text">Phrase analysis failed.</p> : null}
          {selectedPhraseIsPreloading && selectedTranscriptTurn != null ? (
            <div className="bilingual-card">
              <p className="selected-phrase-text">{selectedTranscriptTurn.text}</p>
              <p className="hint">Loading phrase details...</p>
            </div>
          ) : null}
          {selectedPhraseNeedsAnalysis && selectedTranscriptTurn != null ? (
            <div className="bilingual-card">
              <p className="selected-phrase-text">{selectedTranscriptTurn.text}</p>
              <p className="hint">No card yet. Use Generate card.</p>
            </div>
          ) : null}
          {visibleAnalysis != null && selectedPhraseCard != null ? (
            <div className="bilingual-card">
              {selectedPhraseCard.source === "selected-group" ? (
                <span className="selected-group-pill">Selected group</span>
              ) : null}
              <p className="selected-phrase-text">
                {visibleAnalysis.analysisTargetText?.trim() || selectedPhraseCard.transcript}
              </p>
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
                    onClick={() => handleSelectReply(index)}
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
                    <button type="button" onClick={handleCopyReply}>
                      Copy reply
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}
        </aside>
      </section>
    </main>
  );
}
