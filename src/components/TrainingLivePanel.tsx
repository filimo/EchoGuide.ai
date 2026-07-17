import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowDownToLine, Eraser, Pencil, Plus, Sparkles, Trash2, X } from "lucide-react";
import {
  createBrowserRecoveryAudioRecorder,
  type RecoveryAudioCaptureState,
  type RecoveryAudioRecorder
} from "../audio/recoveryAudioRecorder";
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
import {
  maxAnswerHintCharacters,
  type BilingualPhraseAnalysis
} from "../realtime/bilingualAnalysis";
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
import {
  connectRealtimeTranslation,
  type RealtimeTranslationClientSecret,
  type RealtimeTranslationConnection,
  type RealtimeTranslationEvent
} from "../realtime/realtimeTranslation";
import { SpeechLanguageControls } from "./SpeechLanguageControls";
import { TurnDetectionControls } from "./TurnDetectionControls";

type TrainingPhraseCard = {
  id: string;
  transcript: string;
  analysis: BilingualPhraseAnalysis;
  source?: "auto" | "selected-group";
  answerHint?: string;
};

type TranscriptTurn = SessionHistoryTranscriptTurn;

type TranscriptEditorState = {
  mode: "add" | "edit";
  turnId: string | null;
  speakerLabel: SessionSpeakerLabel;
  text: string;
  originalText?: string;
};

type PendingAutomaticAnalysis = {
  transcript: string;
  phraseId: string;
  shouldShowAnalysis: boolean;
};

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
const maxFreshThoughtTurns = 8;
const maxFreshThoughtCharacters = 3000;
const defaultAutomaticAnalysisDelayMs = 1200;
const maxStreamingTranslationCharacters = 2000;
const unacknowledgedSpeechDelayMs = 2500;
const loudSpeechRmsThreshold = 0.01;
const loudSpeechPeakThreshold = 0.05;
const transcriptSpeakerLabels: SessionSpeakerLabel[] = ["Heard", "Interviewer", "Me"];

type TrainingLivePanelProps = {
  stream: MediaStream | null;
  notes: string;
  sourceLabel?: string;
  requestClientSecret?: (mode: RealtimeLabMode) => Promise<RealtimeClientSecret>;
  connectRealtime?: typeof connectRealtimeTranscription;
  requestTranslationClientSecret?: () => Promise<RealtimeTranslationClientSecret>;
  connectTranslation?: typeof connectRealtimeTranslation;
  createRecoveryAudioRecorder?: typeof createBrowserRecoveryAudioRecorder;
  analyzePhrase?: (
    transcript: string,
    knowledgeContext: string,
    recentContext: string[],
    answerHint?: string
  ) => Promise<BilingualPhraseAnalysis>;
  translatePhrase?: (transcript: string) => Promise<string>;
  automaticAnalysisDelayMs?: number;
  recoverPhrases?: (audio: Blob) => Promise<string[]>;
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
    transcriptionModel?: unknown;
  };

  if (typeof payload.clientSecret !== "string" || typeof payload.expiresAt !== "number") {
    throw new Error("Realtime client secret response is invalid.");
  }

  return {
    clientSecret: payload.clientSecret,
    expiresAt: payload.expiresAt,
    ...(typeof payload.sessionId === "string" ? { sessionId: payload.sessionId } : {}),
    ...(typeof payload.transcriptionModel === "string"
      ? { transcriptionModel: payload.transcriptionModel }
      : {})
  };
}

async function requestDefaultTranslationClientSecret(): Promise<RealtimeTranslationClientSecret> {
  const response = await fetch("/api/realtime/translation-client-secret", {
    method: "POST"
  });

  if (!response.ok) {
    throw new Error("Could not create an OpenAI Realtime translation client secret.");
  }

  const payload = (await response.json()) as {
    clientSecret?: unknown;
    expiresAt?: unknown;
    sessionId?: unknown;
    model?: unknown;
    outputLanguage?: unknown;
  };

  if (
    typeof payload.clientSecret !== "string" ||
    typeof payload.expiresAt !== "number" ||
    typeof payload.model !== "string" ||
    typeof payload.outputLanguage !== "string"
  ) {
    throw new Error("Realtime translation client secret response is invalid.");
  }

  return {
    clientSecret: payload.clientSecret,
    expiresAt: payload.expiresAt,
    ...(typeof payload.sessionId === "string" ? { sessionId: payload.sessionId } : {}),
    model: payload.model,
    outputLanguage: payload.outputLanguage
  };
}

async function requestDefaultPhraseAnalysis(
  transcript: string,
  knowledgeContext: string,
  recentContext: string[],
  answerHint = ""
): Promise<BilingualPhraseAnalysis> {
  const response = await fetch("/api/realtime/analyze-phrase", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      transcript,
      knowledgeContext,
      recentContext,
      ...(answerHint.trim().length > 0 ? { answerHint } : {})
    })
  });

  if (!response.ok) {
    throw new Error("Phrase analysis failed.");
  }

  return (await response.json()) as BilingualPhraseAnalysis;
}

async function requestDefaultFastTranslation(transcript: string): Promise<string> {
  const response = await fetch("/api/realtime/translate-phrase", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transcript })
  });

  if (!response.ok) {
    throw new Error("Phrase translation failed.");
  }

  const payload = (await response.json()) as { translation?: unknown };

  if (typeof payload.translation !== "string" || payload.translation.trim().length === 0) {
    throw new Error("Phrase translation returned an empty result.");
  }

  return payload.translation.trim();
}

async function requestDefaultRecoveredPhrases(audio: Blob): Promise<string[]> {
  const response = await fetch("/api/realtime/recover-transcript", {
    method: "POST",
    headers: {
      "Content-Type": "audio/wav"
    },
    body: audio
  });

  if (!response.ok) {
    throw new Error("Recent audio transcription failed.");
  }

  const payload = (await response.json()) as { phrases?: unknown };

  if (
    !Array.isArray(payload.phrases) ||
    !payload.phrases.every((phrase) => typeof phrase === "string")
  ) {
    throw new Error("Recovered phrases response is invalid.");
  }

  return payload.phrases.map((phrase) => phrase.trim()).filter((phrase) => phrase.length > 0);
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

function createManualTranscriptTurnId(turns: TranscriptTurn[]): string {
  const baseId = `manual-phrase-${Date.now()}`;
  const existingIds = new Set(turns.map((turn) => turn.id));
  let candidateId = baseId;
  let suffix = 0;

  while (existingIds.has(candidateId)) {
    suffix += 1;
    candidateId = `${baseId}-${suffix}`;
  }

  return candidateId;
}

export function TrainingLivePanel({
  stream,
  notes,
  sourceLabel = "",
  requestClientSecret = requestDefaultClientSecret,
  connectRealtime = connectRealtimeTranscription,
  requestTranslationClientSecret = requestDefaultTranslationClientSecret,
  connectTranslation = connectRealtimeTranslation,
  createRecoveryAudioRecorder = createBrowserRecoveryAudioRecorder,
  analyzePhrase = requestDefaultPhraseAnalysis,
  translatePhrase = requestDefaultFastTranslation,
  recoverPhrases = requestDefaultRecoveredPhrases,
  copyText = copyTextToClipboard,
  sessionHistoryClient = defaultSessionHistoryClient,
  createSessionId = createDefaultSessionId,
  autoOpenLatestSession = false,
  automaticAnalysisDelayMs = defaultAutomaticAnalysisDelayMs,
  onRequestMicrophone,
  onStopMicrophone,
  onNotesChange,
  submitDiagnostics = submitDefaultDiagnostics
}: TrainingLivePanelProps) {
  const [realtimeStatus, setRealtimeStatus] = useState<RealtimeStatus>("disconnected");
  const [connection, setConnection] = useState<RealtimeTranscriptionConnection | null>(null);
  const [translationConnection, setTranslationConnection] =
    useState<RealtimeTranslationConnection | null>(null);
  const [streamingTranslationStatus, setStreamingTranslationStatus] =
    useState<RealtimeStatus>("disconnected");
  const [streamingTranslationText, setStreamingTranslationText] = useState("");
  const [streamingTranslationError, setStreamingTranslationError] = useState("");
  const [transcriptTurns, setTranscriptTurns] = useState<TranscriptTurn[]>([]);
  const [liveTranscriptDraft, setLiveTranscriptDraft] = useState("");
  const [phraseCards, setPhraseCards] = useState<TrainingPhraseCard[]>([]);
  const [pendingAnalysisIds, setPendingAnalysisIds] = useState<Set<string>>(() => new Set());
  const [fastTranslations, setFastTranslations] = useState<Record<string, string>>({});
  const [pendingTranslationIds, setPendingTranslationIds] = useState<Set<string>>(
    () => new Set()
  );
  const [selectedPhraseCardId, setSelectedPhraseCardId] = useState<string | null>(null);
  const [analysisStatus, setAnalysisStatus] = useState<"idle" | "loading" | "ready" | "error">(
    "idle"
  );
  const [selectedReplyIndex, setSelectedReplyIndex] = useState<number | null>(null);
  const [selectedReplies, setSelectedReplies] = useState<SessionHistorySelectedReply[]>([]);
  const [answerHint, setAnswerHint] = useState("");
  const [answerHintOpen, setAnswerHintOpen] = useState(false);
  const [selectedBridgePhraseIndex, setSelectedBridgePhraseIndex] = useState(0);
  const [transcriptSelectionMode, setTranscriptSelectionMode] = useState(false);
  const [selectedTranscriptTurnIds, setSelectedTranscriptTurnIds] = useState<Set<string>>(
    () => new Set()
  );
  const [transcriptEditor, setTranscriptEditor] = useState<TranscriptEditorState | null>(null);
  const [usedBridgePhrases, setUsedBridgePhrases] = useState<SessionHistoryBridgePhrase[]>([]);
  const [savedSessions, setSavedSessions] = useState<SessionHistoryEntry[]>([]);
  const [historyPanelOpen, setHistoryPanelOpen] = useState(false);
  const [notesDialogOpen, setNotesDialogOpen] = useState(false);
  const [translationHistoryOpen, setTranslationHistoryOpen] = useState(false);
  const [followLive, setFollowLive] = useState(true);
  const [transcriptFollowsLatest, setTranscriptFollowsLatest] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");
  const [copyStatus, setCopyStatus] = useState("");
  const [recoveryStatus, setRecoveryStatus] = useState<"idle" | "loading">("idle");
  const [recoveryAudioCaptureState, setRecoveryAudioCaptureState] =
    useState<RecoveryAudioCaptureState>("idle");
  const [recoveryNotice, setRecoveryNotice] = useState("");
  const [recoverySuggested, setRecoverySuggested] = useState(false);
  const [recoveryPhrases, setRecoveryPhrases] = useState<string[]>([]);
  const [selectedRecoveryPhraseIndex, setSelectedRecoveryPhraseIndex] = useState<number | null>(
    null
  );
  const [audioStats, setAudioStats] = useState<RealtimeAudioStats | null>(null);
  const [turnDetectionSettings, setTurnDetectionSettings] = useState(() =>
    loadRealtimeTurnDetectionSettings(window.localStorage)
  );
  const [speechLanguage, setSpeechLanguage] = useState(() =>
    loadRealtimeSpeechLanguageSettings(window.localStorage)
  );
  const phraseCardSequence = useRef(0);
  const connectionRef = useRef<RealtimeTranscriptionConnection | null>(null);
  const translationConnectionRef = useRef<RealtimeTranslationConnection | null>(null);
  const recoveryAudioRecorderRef = useRef<RecoveryAudioRecorder | null>(null);
  const currentSessionIdRef = useRef<string | null>(null);
  const followLiveRef = useRef(true);
  const transcriptScrollBehaviorRef = useRef<ScrollBehavior>("auto");
  const trainingControlRailRef = useRef<HTMLElement | null>(null);
  const conversationPanelRef = useRef<HTMLDivElement | null>(null);
  const liveTranslationPreviewRef = useRef<HTMLParagraphElement | null>(null);
  const transcriptDialogueRef = useRef<HTMLDivElement | null>(null);
  const recoveryPickerRef = useRef<HTMLElement | null>(null);
  const transcriptEditorRef = useRef<HTMLFormElement | null>(null);
  const shouldRevealRecoveryPickerRef = useRef(false);
  const shouldRevealRecoveredEditorRef = useRef(false);
  const transcriptTurnsRef = useRef<TranscriptTurn[]>([]);
  const deletedTranscriptTurnIdsRef = useRef<Set<string>>(new Set());
  const manuallyAssignedSpeakerTurnIdsRef = useRef<Set<string>>(new Set());
  const phraseAnalysisRevisionRef = useRef<Map<string, number>>(new Map());
  const phraseAnalysisSequenceRef = useRef(0);
  const translationRevisionRef = useRef<Map<string, number>>(new Map());
  const translationSequenceRef = useRef(0);
  const automaticAnalysisTimerRef = useRef<number | null>(null);
  const pendingAutomaticAnalysisRef = useRef<PendingAutomaticAnalysis | null>(null);
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
        setRecoverySuggested(true);
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

    if (
      isClosedTransport &&
      (realtimeStatusRef.current === "connecting" || realtimeStatusRef.current === "connected")
    ) {
      realtimeStatusRef.current = "error";
      setRealtimeStatus("error");
      setErrorMessage("Realtime audio path stopped. Diagnostics were recorded; restart live mode.");
      void flushDiagnostics();
      releaseLiveTransport("error");
      scheduleDiagnosticsStop();
    }
  }

  function handleRecoveryAudioCaptureState(state: RecoveryAudioCaptureState) {
    setRecoveryAudioCaptureState(state);
    recordDiagnostic("audio_recovery.capture_state", { state });

    if (state === "recording") {
      setRecoveryNotice("Recovery audio is recording.");
    } else if (state === "needs-user-action") {
      setRecoveryNotice("Tap Enable recovery to start the local audio buffer.");
    } else if (state === "unavailable") {
      setRecoveryNotice("Recovery audio is unavailable in this browser session.");
    }
  }

  async function flushDiagnostics() {
    if (diagnosticsSendingRef.current || !diagnosticsActiveRef.current) {
      return;
    }

    diagnosticsSendingRef.current = true;
    const diagnosticConnection = connectionRef.current;
    const activeStream = activeStreamRef.current ?? stream;

    try {
      await diagnosticConnection?.collectStats?.();
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
    function reactivateRecoveryAudio() {
      if (document.visibilityState !== "visible") {
        return;
      }

      void recoveryAudioRecorderRef.current?.ensureActive();
    }

    document.addEventListener("visibilitychange", reactivateRecoveryAudio);
    window.addEventListener("pageshow", reactivateRecoveryAudio);

    return () => {
      document.removeEventListener("visibilitychange", reactivateRecoveryAudio);
      window.removeEventListener("pageshow", reactivateRecoveryAudio);
    };
  }, []);

  useEffect(() => {
    if (recoveryPhrases.length === 0 || !shouldRevealRecoveryPickerRef.current) {
      return;
    }

    shouldRevealRecoveryPickerRef.current = false;
    window.requestAnimationFrame(() => {
      recoveryPickerRef.current?.scrollIntoView?.({ behavior: "smooth", block: "center" });
    });
  }, [recoveryPhrases]);

  useEffect(() => {
    if (transcriptEditor == null || !shouldRevealRecoveredEditorRef.current) {
      return;
    }

    shouldRevealRecoveredEditorRef.current = false;
    window.requestAnimationFrame(() => {
      transcriptEditorRef.current?.scrollIntoView?.({ behavior: "smooth", block: "center" });
    });
  }, [transcriptEditor]);

  useEffect(() => {
    return () => {
      realtimeStatusRef.current = "disconnected";
      connectionRef.current?.disconnect();
      translationConnectionRef.current?.disconnect();
      recoveryAudioRecorderRef.current?.stop();
      if (automaticAnalysisTimerRef.current != null) {
        window.clearTimeout(automaticAnalysisTimerRef.current);
      }
      automaticAnalysisTimerRef.current = null;
      pendingAutomaticAnalysisRef.current = null;
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
  const selectedCardAnswerHint = selectedPhraseCard?.answerHint ?? "";
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
  const recoveryAudioChunks = audioStats?.chunksObserved ?? 0;
  const recoveryCanRecover = recoveryAudioChunks > 0;
  const recoveryButtonDisabled = recoveryStatus === "loading";
  const recoveryButtonLabel =
    recoveryStatus === "loading"
      ? "Recovering phrases..."
      : recoveryCanRecover
        ? recoveryPhrases.length > 0
          ? "Refresh phrases"
          : "Recover phrases"
        : "Enable recovery";
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

  useEffect(() => {
    setAnswerHint(selectedCardAnswerHint);
    setAnswerHintOpen(selectedCardAnswerHint.length > 0);
  }, [selectedPhraseCardId, selectedCardAnswerHint]);

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

  function beginPhraseAnalysis(phraseId: string): number {
    phraseAnalysisSequenceRef.current += 1;
    const revision = phraseAnalysisSequenceRef.current;

    phraseAnalysisRevisionRef.current.set(phraseId, revision);
    setPendingAnalysisIds((current) => new Set(current).add(phraseId));
    return revision;
  }

  function isCurrentPhraseAnalysis(phraseId: string, revision: number): boolean {
    return phraseAnalysisRevisionRef.current.get(phraseId) === revision;
  }

  function finishPhraseAnalysis(phraseId: string, revision: number) {
    if (!isCurrentPhraseAnalysis(phraseId, revision)) {
      return;
    }

    setPendingAnalysisIds((current) => {
      const next = new Set(current);
      next.delete(phraseId);
      return next;
    });
  }

  function invalidatePhraseAnalysis(phraseId: string) {
    phraseAnalysisSequenceRef.current += 1;
    phraseAnalysisRevisionRef.current.set(phraseId, phraseAnalysisSequenceRef.current);
    setPendingAnalysisIds((current) => {
      const next = new Set(current);
      next.delete(phraseId);
      return next;
    });
  }

  function invalidateFastTranslation(phraseId: string) {
    translationSequenceRef.current += 1;
    translationRevisionRef.current.set(phraseId, translationSequenceRef.current);
    setPendingTranslationIds((current) => {
      const next = new Set(current);
      next.delete(phraseId);
      return next;
    });
    setFastTranslations((current) => {
      const next = { ...current };
      delete next[phraseId];
      return next;
    });
  }

  async function translateCompletedTranscript(transcript: string, phraseId: string) {
    translationSequenceRef.current += 1;
    const revision = translationSequenceRef.current;
    translationRevisionRef.current.set(phraseId, revision);
    setPendingTranslationIds((current) => new Set(current).add(phraseId));

    try {
      const translation = await translatePhrase(transcript.trim());

      if (
        deletedTranscriptTurnIdsRef.current.has(phraseId) ||
        translationRevisionRef.current.get(phraseId) !== revision
      ) {
        return;
      }

      setFastTranslations((current) => ({ ...current, [phraseId]: translation.trim() }));
    } catch {
      // The phrase card remains the fallback source for Russian meaning.
    } finally {
      if (translationRevisionRef.current.get(phraseId) === revision) {
        setPendingTranslationIds((current) => {
          const next = new Set(current);
          next.delete(phraseId);
          return next;
        });
      }
    }
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

  function handleTranscriptScroll() {
    const transcriptDialogue = transcriptDialogueRef.current;

    if (transcriptDialogue == null) {
      return;
    }

    const distanceFromLatest =
      transcriptDialogue.scrollHeight -
      transcriptDialogue.scrollTop -
      transcriptDialogue.clientHeight;

    setTranscriptFollowsLatest(distanceFromLatest <= 48);
  }

  useLayoutEffect(() => {
    if (transcriptFollowsLatest) {
      scrollTranscriptToLatest(transcriptScrollBehaviorRef.current);
      transcriptScrollBehaviorRef.current = "auto";
    }
  }, [liveTranscriptDraft, transcriptFollowsLatest, transcriptTurns]);

  useLayoutEffect(() => {
    const liveTranslationPreview = liveTranslationPreviewRef.current;

    if (liveTranslationPreview != null) {
      liveTranslationPreview.scrollTop = liveTranslationPreview.scrollHeight;
    }
  }, [streamingTranslationText]);

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

    const analysisRevision = beginPhraseAnalysis(phraseId);

    if (shouldShowAnalysis) {
      setAnalysisStatus("loading");
      setSelectedReplyIndex(null);
    }

    try {
      const nextAnalysis = await analyzePhrase(trimmedTranscript, notes, recentContext);

      if (
        deletedTranscriptTurnIdsRef.current.has(phraseId) ||
        !isCurrentPhraseAnalysis(phraseId, analysisRevision)
      ) {
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
      finishPhraseAnalysis(phraseId, analysisRevision);
      if (shouldShowAnalysis) {
        setAnalysisStatus("ready");
      }
    } catch (error) {
      if (!isCurrentPhraseAnalysis(phraseId, analysisRevision)) {
        return;
      }

      finishPhraseAnalysis(phraseId, analysisRevision);
      if (shouldShowAnalysis) {
        setAnalysisStatus("error");
      }
      setErrorMessage(toErrorMessage(error));
    }
  }

  function cancelPendingAutomaticAnalysis(phraseIds?: Set<string>) {
    const pendingAnalysis = pendingAutomaticAnalysisRef.current;

    if (pendingAnalysis == null || (phraseIds != null && !phraseIds.has(pendingAnalysis.phraseId))) {
      return;
    }

    if (automaticAnalysisTimerRef.current != null) {
      window.clearTimeout(automaticAnalysisTimerRef.current);
      automaticAnalysisTimerRef.current = null;
    }
    pendingAutomaticAnalysisRef.current = null;
    setPendingAnalysisIds((current) => {
      const next = new Set(current);
      next.delete(pendingAnalysis.phraseId);
      return next;
    });
  }

  function flushPendingAutomaticAnalysis() {
    const pendingAnalysis = pendingAutomaticAnalysisRef.current;

    if (pendingAnalysis == null) {
      return;
    }

    if (automaticAnalysisTimerRef.current != null) {
      window.clearTimeout(automaticAnalysisTimerRef.current);
      automaticAnalysisTimerRef.current = null;
    }
    pendingAutomaticAnalysisRef.current = null;

    if (deletedTranscriptTurnIdsRef.current.has(pendingAnalysis.phraseId)) {
      setPendingAnalysisIds((current) => {
        const next = new Set(current);
        next.delete(pendingAnalysis.phraseId);
        return next;
      });
      return;
    }

    void analyzeCompletedTranscript(
      pendingAnalysis.transcript,
      pendingAnalysis.phraseId,
      pendingAnalysis.shouldShowAnalysis,
      buildRecentAnalysisContext(transcriptTurnsRef.current, pendingAnalysis.phraseId)
    );
  }

  function scheduleAutomaticAnalysis(
    transcript: string,
    phraseId: string,
    shouldShowAnalysis: boolean
  ) {
    const previousPendingAnalysis = pendingAutomaticAnalysisRef.current;

    if (automaticAnalysisTimerRef.current != null) {
      window.clearTimeout(automaticAnalysisTimerRef.current);
      automaticAnalysisTimerRef.current = null;
    }

    pendingAutomaticAnalysisRef.current = { transcript, phraseId, shouldShowAnalysis };
    setPendingAnalysisIds((current) => {
      const next = new Set(current);

      if (previousPendingAnalysis != null) {
        next.delete(previousPendingAnalysis.phraseId);
      }
      next.add(phraseId);
      return next;
    });

    if (shouldShowAnalysis) {
      setAnalysisStatus("loading");
      setSelectedReplyIndex(null);
    }

    if (automaticAnalysisDelayMs <= 0) {
      flushPendingAutomaticAnalysis();
      return;
    }

    automaticAnalysisTimerRef.current = window.setTimeout(
      flushPendingAutomaticAnalysis,
      automaticAnalysisDelayMs
    );
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
      setRecoverySuggested(false);
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
          text: completedTranscript,
          source: "realtime" as const
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
        void translateCompletedTranscript(completedTranscript, phraseId);
        scheduleAutomaticAnalysis(completedTranscript, phraseId, shouldShowAnalysis);
      }
    }
  }

  function releaseStreamingTranslation(
    nextStatus: Extract<RealtimeStatus, "disconnected" | "error"> = "disconnected"
  ) {
    const liveTranslationConnection = translationConnectionRef.current;

    translationConnectionRef.current = null;
    setTranslationConnection(null);
    setStreamingTranslationStatus(nextStatus);
    liveTranslationConnection?.disconnect();
  }

  function handleRealtimeTranslationEvent(event: RealtimeTranslationEvent) {
    if (
      event.type === "session.output_transcript.delta" &&
      typeof event.delta === "string"
    ) {
      setStreamingTranslationText((current) =>
        `${current}${event.delta}`.slice(-maxStreamingTranslationCharacters)
      );
      return;
    }

    if (event.type === "session.closed") {
      releaseStreamingTranslation("disconnected");
      return;
    }

    if (event.type === "error") {
      const errorMessage =
        typeof (event.error as { message?: unknown } | undefined)?.message === "string"
          ? (event.error as { message: string }).message
          : "Realtime translation became unavailable.";

      setStreamingTranslationError(errorMessage);
      releaseStreamingTranslation("error");
    }
  }

  async function handleStartStreamingTranslation() {
    if (
      translationConnectionRef.current != null ||
      streamingTranslationStatus === "connecting"
    ) {
      return;
    }

    const liveStream = activeStreamRef.current;

    if (connectionRef.current == null || liveStream == null) {
      setStreamingTranslationError("Start live mode before streaming translation.");
      return;
    }

    setStreamingTranslationStatus("connecting");
    setStreamingTranslationText("");
    setStreamingTranslationError("");
    recordDiagnostic("streaming_translation.start");

    try {
      const clientSecret = await requestTranslationClientSecret();
      const liveTranslationConnection = await connectTranslation({
        stream: liveStream,
        clientSecret: clientSecret.clientSecret,
        onEvent: handleRealtimeTranslationEvent,
        onError: (message) => setStreamingTranslationError(message)
      });

      if (connectionRef.current == null || activeStreamRef.current !== liveStream) {
        liveTranslationConnection.disconnect();
        setStreamingTranslationStatus("disconnected");
        return;
      }

      translationConnectionRef.current = liveTranslationConnection;
      setTranslationConnection(liveTranslationConnection);
      setStreamingTranslationStatus("connected");
      recordDiagnostic("streaming_translation.connected", {
        model: clientSecret.model,
        outputLanguage: clientSecret.outputLanguage,
        expiresAt: clientSecret.expiresAt
      });
    } catch (error) {
      translationConnectionRef.current = null;
      setTranslationConnection(null);
      setStreamingTranslationStatus("error");
      setStreamingTranslationError(toErrorMessage(error));
      recordDiagnostic("streaming_translation.start_error");
    }
  }

  function handleStopStreamingTranslation() {
    recordDiagnostic("streaming_translation.stop");
    releaseStreamingTranslation("disconnected");
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
    setRecoverySuggested(false);
    setRecoveryStatus("idle");
    setRecoveryNotice("");
    realtimeStatusRef.current = "connecting";
    setRealtimeStatus("connecting");

    let recoveryAudioRecorder: RecoveryAudioRecorder | null = null;

    try {
      recoveryAudioRecorder = createRecoveryAudioRecorder({
        stream: liveStream,
        onAudioStats: handleAudioStats,
        onStateChange: handleRecoveryAudioCaptureState,
        onDiagnosticEvent: handleConnectionDiagnostic
      });
      recoveryAudioRecorderRef.current = recoveryAudioRecorder;
      void recoveryAudioRecorder.ensureActive();
    } catch (error) {
      setRecoveryAudioCaptureState("unavailable");
      setRecoveryNotice("Recovery audio is unavailable in this browser session.");
      recordDiagnostic("audio_recovery.capture_unavailable", {
        errorName: error instanceof Error ? error.name : "UnknownError"
      });
    }

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
          speechLanguage,
          clientSecret.transcriptionModel
        ),
        onEvent: handleRealtimeEvent,
        onAudioStats: handleAudioStats,
        onDiagnosticEvent: handleConnectionDiagnostic,
        audioAppender: recoveryAudioRecorder,
        onError: (message) => {
          recordDiagnostic("realtime.client_error");
          setErrorMessage(message);
        }
      });

      connectionRef.current = realtimeConnection;
      setConnection(realtimeConnection);
      realtimeStatusRef.current = "connected";
      setRealtimeStatus("connected");
      recordDiagnostic("training_live.connected");
      void flushDiagnostics();
    } catch (error) {
      recoveryAudioRecorder?.stop();
      recoveryAudioRecorderRef.current = null;
      recordDiagnostic("training_live.start_error");
      setConnection(null);
      realtimeStatusRef.current = "error";
      setRealtimeStatus("error");
      setErrorMessage(toErrorMessage(error));
      setRecoveryAudioCaptureState("idle");
      onStopMicrophone?.();
      void flushDiagnostics();
    }
  }

  function releaseLiveTransport(nextStatus: Extract<RealtimeStatus, "disconnected" | "error">) {
    flushPendingAutomaticAnalysis();
    const liveConnection = connectionRef.current;

    releaseStreamingTranslation("disconnected");
    connectionRef.current = null;
    setConnection(null);
    realtimeStatusRef.current = nextStatus;
    setRealtimeStatus(nextStatus);
    liveConnection?.disconnect();
    recoveryAudioRecorderRef.current = null;
    setAudioStats(null);
    setRecoverySuggested(false);
    setRecoveryStatus("idle");
    setRecoveryAudioCaptureState("idle");
    setRecoveryNotice("");
    onStopMicrophone?.();
    activeStreamRef.current = null;
    serverSpeechActiveRef.current = false;
    if (unacknowledgedSpeechTimerRef.current != null) {
      window.clearTimeout(unacknowledgedSpeechTimerRef.current);
      unacknowledgedSpeechTimerRef.current = null;
    }
  }

  function scheduleDiagnosticsStop() {
    if (diagnosticsStopTimerRef.current != null) {
      window.clearTimeout(diagnosticsStopTimerRef.current);
    }

    diagnosticsStopTimerRef.current = window.setTimeout(() => {
      diagnosticsActiveRef.current = false;
      diagnosticsStopTimerRef.current = null;
    }, 15_000);
  }

  function handleStopLive() {
    recordDiagnostic("training_live.stop");
    void flushDiagnostics();
    releaseLiveTransport("disconnected");
    scheduleDiagnosticsStop();
  }

  async function handleRecoverPhrases() {
    if (recoveryStatus === "loading") {
      return;
    }

    const recentAudio = connectionRef.current?.getRecentAudio(30) ?? null;

    if (recentAudio == null || recentAudio.size <= 44) {
      setErrorMessage("No recent microphone audio is available yet.");
      setRecoveryNotice("No recent microphone audio is available yet.");
      return;
    }

    setErrorMessage("");
    setCopyStatus("");
    setRecoveryStatus("loading");
    setRecoveryNotice("Recovering phrases from the latest buffered audio...");
    recordDiagnostic("audio_recovery.requested", { audioBytes: recentAudio.size });

    try {
      const recoveredPhrases = (await recoverPhrases(recentAudio)).filter(
        (phrase) => !isObviousTranscriptNoise(phrase)
      );

      if (recoveredPhrases.length === 0) {
        throw new Error("No clear speech was found in the recent audio.");
      }

      shouldRevealRecoveryPickerRef.current = true;
      setRecoveryPhrases(recoveredPhrases);
      setSelectedRecoveryPhraseIndex(null);
      if (selectedRecoveryPhraseIndex != null) {
        setTranscriptEditor(null);
      }
      setRecoverySuggested(false);
      setRecoveryNotice(
        `${recoveredPhrases.length} recovered ${
          recoveredPhrases.length === 1 ? "phrase is" : "phrases are"
        } ready to review.`
      );
      recordDiagnostic("audio_recovery.ready", {
        audioBytes: recentAudio.size,
        phraseCount: recoveredPhrases.length,
        transcriptCharacters: recoveredPhrases.join(" ").length
      });
    } catch (error) {
      recordDiagnostic("audio_recovery.client_failed", { audioBytes: recentAudio.size });
      setErrorMessage(toErrorMessage(error));
      setRecoveryNotice(toErrorMessage(error));
    } finally {
      setRecoveryStatus("idle");
    }
  }

  function handleSelectRecoveredPhrase(phrase: string, phraseIndex: number) {
    setFollowLiveMode(false);
    setTranscriptSelectionMode(false);
    setSelectedTranscriptTurnIds(new Set());
    setSelectedRecoveryPhraseIndex(phraseIndex);
    setTranscriptEditor({
      mode: "add",
      turnId: null,
      speakerLabel: "Heard",
      text: phrase
    });
    shouldRevealRecoveredEditorRef.current = true;
  }

  function handleCloseRecoveredPhrases() {
    setRecoveryPhrases([]);
    setSelectedRecoveryPhraseIndex(null);
  }

  async function handleEnableRecovery() {
    const recoveryAudioRecorder = recoveryAudioRecorderRef.current;

    if (recoveryAudioRecorder == null) {
      setRecoveryAudioCaptureState("unavailable");
      setRecoveryNotice("Recovery audio is unavailable in this browser session.");
      return;
    }

    setRecoveryNotice("Enabling the local recovery buffer...");
    const nextState = await recoveryAudioRecorder.ensureActive();

    if (nextState === "recording") {
      setRecoveryNotice("Recovery is enabled. New microphone audio is being buffered.");
    } else {
      setRecoveryNotice("Safari did not start the recovery buffer. Tap Enable recovery again.");
    }
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

      if (next) {
        setTranscriptEditor(null);
      }

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
    selectedIds.forEach((turnId) => invalidatePhraseAnalysis(turnId));
    selectedIds.forEach((turnId) => invalidateFastTranslation(turnId));
    cancelPendingAutomaticAnalysis(selectedIds);

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
    const analysisRevision = beginPhraseAnalysis(manualPhraseId);

    try {
      const nextAnalysis = await analyzePhrase(selectedTranscript, notes, selectedContext);

      if (!isCurrentPhraseAnalysis(manualPhraseId, analysisRevision)) {
        return;
      }

      const nextCard = {
        id: manualPhraseId,
        transcript: selectedTranscript,
        analysis: nextAnalysis,
        source: "selected-group" as const
      };

      setPhraseCards((current) => [...current, nextCard].slice(-20));
      finishPhraseAnalysis(manualPhraseId, analysisRevision);
      setAnalysisStatus("ready");
    } catch (error) {
      if (!isCurrentPhraseAnalysis(manualPhraseId, analysisRevision)) {
        return;
      }

      finishPhraseAnalysis(manualPhraseId, analysisRevision);
      setAnalysisStatus("error");
      setErrorMessage(toErrorMessage(error));
    }
  }

  async function generateTranscriptTurnCard(
    turn: TranscriptTurn,
    contextTurns: TranscriptTurn[],
    requestedAnswerHint = ""
  ) {
    const transcript = turn.text.trim();
    const normalizedAnswerHint = requestedAnswerHint
      .trim()
      .slice(0, maxAnswerHintCharacters);

    if (transcript.length === 0) {
      return;
    }

    const phraseId = turn.id;

    setFollowLiveMode(false);
    setAnalysisStatus("loading");
    setSelectedReplyIndex(null);
    const analysisRevision = beginPhraseAnalysis(phraseId);

    try {
      const recentContext = buildRecentAnalysisContext(contextTurns, phraseId);
      const nextAnalysis =
        normalizedAnswerHint.length > 0
          ? await analyzePhrase(transcript, notes, recentContext, normalizedAnswerHint)
          : await analyzePhrase(transcript, notes, recentContext);

      if (!isCurrentPhraseAnalysis(phraseId, analysisRevision)) {
        return;
      }

      const inferredSpeakerLabel = resolveAnalysisSpeakerLabel(nextAnalysis.speakerRole);
      if (inferredSpeakerLabel !== "Heard") {
        updateTranscriptSpeakerLabel(phraseId, inferredSpeakerLabel, true);
      }
      const nextCard = {
        id: phraseId,
        transcript,
        analysis: nextAnalysis,
        source: "auto" as const,
        ...(normalizedAnswerHint.length > 0 ? { answerHint: normalizedAnswerHint } : {})
      };

      setPhraseCards((current) => [
        ...current.filter((card) => card.id !== phraseId),
        nextCard
      ].slice(-20));
      setSelectedReplies((current) =>
        current.filter((selectedReply) => selectedReply.phraseId !== phraseId)
      );
      finishPhraseAnalysis(phraseId, analysisRevision);
      setAnalysisStatus("ready");
    } catch (error) {
      if (!isCurrentPhraseAnalysis(phraseId, analysisRevision)) {
        return;
      }

      finishPhraseAnalysis(phraseId, analysisRevision);
      setAnalysisStatus("error");
      setErrorMessage(toErrorMessage(error));
    }
  }

  async function handleGenerateSelectedTranscriptTurnCard() {
    if (selectedTranscriptTurn == null) {
      return;
    }

    await generateTranscriptTurnCard(
      selectedTranscriptTurn,
      transcriptTurns,
      selectedPhraseCard?.answerHint
    );
  }

  async function handleGenerateAnswerFromHint() {
    if (selectedTranscriptTurn == null || answerHint.trim().length === 0) {
      return;
    }

    await generateTranscriptTurnCard(selectedTranscriptTurn, transcriptTurns, answerHint);
  }

  function handleOpenAddTranscriptEditor() {
    setFollowLiveMode(false);
    setTranscriptSelectionMode(false);
    setSelectedTranscriptTurnIds(new Set());
    setSelectedRecoveryPhraseIndex(null);
    setTranscriptEditor({
      mode: "add",
      turnId: null,
      speakerLabel: "Heard",
      text: ""
    });
  }

  function handleOpenEditTranscriptEditor() {
    if (selectedTranscriptTurn == null) {
      return;
    }

    setFollowLiveMode(false);
    setSelectedRecoveryPhraseIndex(null);
    setTranscriptEditor({
      mode: "edit",
      turnId: selectedTranscriptTurn.id,
      speakerLabel: selectedTranscriptTurn.speakerLabel,
      text: selectedTranscriptTurn.text,
      originalText: selectedTranscriptTurn.originalText
    });
  }

  function buildEditedTranscriptTurn(
    turn: TranscriptTurn,
    text: string,
    speakerLabel: SessionSpeakerLabel
  ): TranscriptTurn {
    const source = turn.source ?? "realtime";
    const recognizedText =
      source === "realtime" && text !== turn.text
        ? (turn.originalText ?? turn.text)
        : turn.originalText;
    const originalText =
      recognizedText != null && text !== recognizedText ? recognizedText : undefined;

    return {
      id: turn.id,
      speakerLabel,
      text,
      source,
      ...(originalText == null ? {} : { originalText })
    };
  }

  function handleSaveTranscriptEditor(generateCard: boolean) {
    if (transcriptEditor == null) {
      return;
    }

    const text = transcriptEditor.text.trim();

    if (text.length === 0) {
      return;
    }

    let savedTurn: TranscriptTurn;
    let nextTranscriptTurns: TranscriptTurn[];

    if (transcriptEditor.mode === "add") {
      savedTurn = {
        id: createManualTranscriptTurnId(transcriptTurnsRef.current),
        speakerLabel: transcriptEditor.speakerLabel,
        text,
        source: "manual"
      };
      nextTranscriptTurns = [...transcriptTurnsRef.current, savedTurn].slice(-50);
    } else {
      const currentTurn = transcriptTurnsRef.current.find(
        (turn) => turn.id === transcriptEditor.turnId
      );

      if (currentTurn == null) {
        setTranscriptEditor(null);
        return;
      }

      savedTurn = buildEditedTranscriptTurn(currentTurn, text, transcriptEditor.speakerLabel);
      nextTranscriptTurns = transcriptTurnsRef.current.map((turn) =>
        turn.id === savedTurn.id ? savedTurn : turn
      );
      invalidatePhraseAnalysis(savedTurn.id);
      invalidateFastTranslation(savedTurn.id);
      setPhraseCards((current) => current.filter((card) => card.id !== savedTurn.id));
      setSelectedReplies((current) =>
        current.filter((selectedReply) => selectedReply.phraseId !== savedTurn.id)
      );
      setSelectedReplyIndex(null);
      setAnalysisStatus("idle");

      if (
        currentTurn.speakerLabel !== savedTurn.speakerLabel ||
        savedTurn.speakerLabel !== "Heard"
      ) {
        manuallyAssignedSpeakerTurnIdsRef.current.add(savedTurn.id);
      }
    }

    if (savedTurn.speakerLabel !== "Heard") {
      manuallyAssignedSpeakerTurnIdsRef.current.add(savedTurn.id);
    }

    transcriptTurnsRef.current = nextTranscriptTurns;
    setTranscriptTurns(nextTranscriptTurns);
    setSelectedPhraseCardId(savedTurn.id);
    setTranscriptEditor(null);
    setFollowLiveMode(false);
    void translateCompletedTranscript(savedTurn.text, savedTurn.id);

    if (generateCard) {
      void generateTranscriptTurnCard(savedTurn, nextTranscriptTurns);
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
    cancelPendingAutomaticAnalysis();
    currentSessionIdRef.current = null;
    setFollowLiveMode(true);
    transcriptScrollBehaviorRef.current = "auto";
    setTranscriptFollowsLatest(true);
    transcriptTurnsRef.current = [];
    deletedTranscriptTurnIdsRef.current = new Set();
    manuallyAssignedSpeakerTurnIdsRef.current = new Set();
    phraseAnalysisRevisionRef.current = new Map();
    translationRevisionRef.current = new Map();
    setTranscriptTurns([]);
    setLiveTranscriptDraft("");
    setPhraseCards([]);
    setPendingAnalysisIds(new Set());
    setFastTranslations({});
    setPendingTranslationIds(new Set());
    setSelectedPhraseCardId(null);
    setTranscriptSelectionMode(false);
    setSelectedTranscriptTurnIds(new Set());
    setTranscriptEditor(null);
    setRecoveryPhrases([]);
    setSelectedRecoveryPhraseIndex(null);
    setSelectedReplies([]);
    setUsedBridgePhrases([]);
    setSelectedReplyIndex(null);
    setAnalysisStatus("idle");
    setErrorMessage("");
    setCopyStatus("");
  }

  function handleOpenSavedSession(session: SessionHistoryEntry) {
    cancelPendingAutomaticAnalysis();
    const normalizedSession = ensureUniqueSessionPhraseIds(session);
    const lastCardId =
      normalizedSession.transcriptTurns.at(-1)?.id ??
      normalizedSession.phraseCards.at(-1)?.id ??
      null;

    currentSessionIdRef.current = normalizedSession.id;
    setFollowLiveMode(false);
    setTranscriptFollowsLatest(true);
    phraseCardSequence.current = getNextPhraseCardSequence(normalizedSession);
    transcriptTurnsRef.current = normalizedSession.transcriptTurns;
    deletedTranscriptTurnIdsRef.current = new Set();
    manuallyAssignedSpeakerTurnIdsRef.current = new Set();
    phraseAnalysisRevisionRef.current = new Map();
    translationRevisionRef.current = new Map();
    setTranscriptTurns(normalizedSession.transcriptTurns);
    setLiveTranscriptDraft("");
    setPhraseCards(normalizedSession.phraseCards);
    setPendingAnalysisIds(new Set());
    setFastTranslations({});
    setPendingTranslationIds(new Set());
    setSelectedPhraseCardId(lastCardId);
    setTranscriptSelectionMode(false);
    setSelectedTranscriptTurnIds(new Set());
    setTranscriptEditor(null);
    setRecoveryPhrases([]);
    setSelectedRecoveryPhraseIndex(null);
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

    if (transcriptDialogue == null) {
      return;
    }

    if (transcriptFollowsLatest) {
      scrollTranscriptToLatest("smooth");
    } else {
      transcriptScrollBehaviorRef.current = "smooth";
      setTranscriptFollowsLatest(true);
    }

    const stickyRailHeight = trainingControlRail?.getBoundingClientRect().height ?? 0;
    const conversationPanelTop = conversationPanel?.getBoundingClientRect().top;

    if (conversationPanelTop != null) {
      window.scrollTo({
        top: Math.max(0, window.scrollY + conversationPanelTop - stickyRailHeight - 12),
        behavior: "smooth"
      });
    }
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
              <>
                <button
                  type="button"
                  disabled={recoveryButtonDisabled}
                  onClick={() =>
                    void (recoveryCanRecover
                      ? handleRecoverPhrases()
                      : handleEnableRecovery())
                  }
                >
                  {recoveryButtonLabel}
                </button>
                <button type="button" onClick={handleStopLive}>
                  Stop live
                </button>
              </>
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
          {recoverySuggested ? (
            <span className="status status-warning">Speech may be missing. Try recovery.</span>
          ) : null}
          {recoveryNotice.length > 0 ? (
            <span
              className={`status ${
                recoveryAudioCaptureState === "recording" ? "status-active" : "status-warning"
              }`}
            >
              {recoveryNotice}
            </span>
          ) : null}
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

      {translationHistoryOpen ? (
        <div className="translation-history-layer">
          <section
            className="translation-history-drawer"
            role="dialog"
            aria-labelledby="translation-history-title"
          >
            <div className="translation-history-header">
              <div>
                <p className="eyebrow">Rolling subtitle buffer</p>
                <h2 id="translation-history-title">Recent live translation</h2>
              </div>
              <button type="button" onClick={() => setTranslationHistoryOpen(false)}>
                Close
              </button>
            </div>
            <p className="translation-history-copy" lang="ru">
              {streamingTranslationText.trim() || "No live translation yet."}
            </p>
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

      <section
        className="live-translation-panel"
        aria-labelledby="live-translation-title"
      >
        <div className="live-translation-header">
          <div className="live-translation-heading">
            <h2 id="live-translation-title">Live Russian translation</h2>
            <span className={`status status-${streamingTranslationStatus}`}>
              {streamingTranslationStatus}
            </span>
          </div>
          <div className="live-translation-actions">
            {streamingTranslationText.trim().length > 0 ? (
              <button
                type="button"
                className="live-translation-expand"
                onClick={() => setTranslationHistoryOpen(true)}
              >
                Expand
              </button>
            ) : null}
            {translationConnection == null ? (
              <button
                type="button"
                aria-label="Start streaming translation"
                disabled={connection == null || streamingTranslationStatus === "connecting"}
                onClick={() => void handleStartStreamingTranslation()}
              >
                {streamingTranslationStatus === "connecting"
                  ? "Starting..."
                  : "Start translation"}
              </button>
            ) : (
              <button
                type="button"
                aria-label="Stop streaming translation"
                onClick={handleStopStreamingTranslation}
              >
                Stop translation
              </button>
            )}
          </div>
        </div>
        <p ref={liveTranslationPreviewRef} className="live-translation-copy" lang="ru">
          {streamingTranslationText.length > 0
            ? streamingTranslationText
            : streamingTranslationStatus === "connected"
              ? "Listening for speech..."
              : "Start live mode, then start translation."}
        </p>
        {streamingTranslationError.length > 0 ? (
          <p className="live-translation-error" role="alert">
            {streamingTranslationError}
          </p>
        ) : null}
      </section>

      <section className="copilot-grid">
        <div ref={conversationPanelRef} className="conversation-panel">
          <div className="transcript-panel-header transcript-panel-header-sticky">
            <h2>Live bilingual transcript</h2>
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
              {!transcriptSelectionMode ? (
                <button
                  type="button"
                  className="transcript-action-icon"
                  aria-label="Add message"
                  title="Add message"
                  onClick={handleOpenAddTranscriptEditor}
                >
                  <Plus aria-hidden="true" size={18} strokeWidth={1.8} />
                </button>
              ) : null}
              {!transcriptSelectionMode && selectedTranscriptTurn != null ? (
                <button
                  type="button"
                  className="transcript-action-icon"
                  aria-label="Edit message"
                  title="Edit message"
                  onClick={handleOpenEditTranscriptEditor}
                >
                  <Pencil aria-hidden="true" size={18} strokeWidth={1.8} />
                </button>
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
          </div>
          {recoveryPhrases.length > 0 ? (
            <section
              ref={recoveryPickerRef}
              className="recovery-picker"
              aria-label="Recovered phrases"
            >
              <div className="recovery-picker-header">
                <div>
                  <p className="eyebrow">Recent audio</p>
                  <h3>Choose a phrase to review</h3>
                </div>
                <button
                  type="button"
                  className="transcript-editor-close"
                  aria-label="Close recovered phrases"
                  title="Close"
                  onClick={handleCloseRecoveredPhrases}
                >
                  <X aria-hidden="true" size={18} strokeWidth={1.8} />
                </button>
              </div>
              <div className="recovery-phrase-list">
                {recoveryPhrases.map((phrase, phraseIndex) => (
                  <button
                    type="button"
                    className={
                      selectedRecoveryPhraseIndex === phraseIndex
                        ? "recovery-phrase recovery-phrase-selected"
                        : "recovery-phrase"
                    }
                    aria-pressed={selectedRecoveryPhraseIndex === phraseIndex}
                    key={`${phraseIndex}-${phrase}`}
                    onClick={() => handleSelectRecoveredPhrase(phrase, phraseIndex)}
                  >
                    <span className="recovery-phrase-index">{phraseIndex + 1}</span>
                    <span>{phrase}</span>
                  </button>
                ))}
              </div>
              <p className="hint">
                Select a phrase to edit it below. This list stays available after save or cancel.
              </p>
            </section>
          ) : null}
          {transcriptEditor != null ? (
            <form
              ref={transcriptEditorRef}
              className="transcript-editor"
              aria-label={transcriptEditor.mode === "add" ? "Add message" : "Edit message"}
              onSubmit={(event) => {
                event.preventDefault();
                handleSaveTranscriptEditor(false);
              }}
            >
              <div className="transcript-editor-header">
                <h3>{transcriptEditor.mode === "add" ? "Add message" : "Edit message"}</h3>
                <button
                  type="button"
                  className="transcript-editor-close"
                  aria-label="Cancel message editor"
                  title="Cancel"
                  onClick={() => setTranscriptEditor(null)}
                >
                  <X aria-hidden="true" size={18} strokeWidth={1.8} />
                </button>
              </div>
              <fieldset className="transcript-editor-speakers">
                <legend>Speaker</legend>
                <div>
                  {transcriptSpeakerLabels.map((speakerLabel) => (
                    <button
                      type="button"
                      className={
                        transcriptEditor.speakerLabel === speakerLabel
                          ? "transcript-editor-speaker-active"
                          : undefined
                      }
                      aria-pressed={transcriptEditor.speakerLabel === speakerLabel}
                      key={speakerLabel}
                      onClick={() =>
                        setTranscriptEditor((current) =>
                          current == null ? current : { ...current, speakerLabel }
                        )
                      }
                    >
                      {speakerLabel}
                    </button>
                  ))}
                </div>
              </fieldset>
              <label className="transcript-editor-label" htmlFor="transcript-message-text">
                Message text
              </label>
              <textarea
                id="transcript-message-text"
                autoFocus
                value={transcriptEditor.text}
                placeholder="Type the missing or corrected phrase."
                onChange={(event) =>
                  setTranscriptEditor((current) =>
                    current == null ? current : { ...current, text: event.target.value }
                  )
                }
              />
              <div className="transcript-editor-actions">
                {transcriptEditor.mode === "edit" && transcriptEditor.originalText != null ? (
                  <button
                    type="button"
                    onClick={() =>
                      setTranscriptEditor((current) =>
                        current == null || current.originalText == null
                          ? current
                          : { ...current, text: current.originalText }
                      )
                    }
                  >
                    Restore recognized text
                  </button>
                ) : null}
                <span className="transcript-editor-primary-actions">
                  <button
                    type="submit"
                    disabled={transcriptEditor.text.trim().length === 0}
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    className="primary-action"
                    disabled={transcriptEditor.text.trim().length === 0}
                    onClick={() => handleSaveTranscriptEditor(true)}
                  >
                    Save and generate card
                  </button>
                </span>
              </div>
            </form>
          ) : null}
          <div
            ref={transcriptDialogueRef}
            className="transcript-box transcript-dialogue"
            aria-label="Conversation transcript"
            onScroll={handleTranscriptScroll}
          >
            {transcriptTurns.length === 0 && liveTranscriptDraft.trim().length === 0 ? (
              <p className="transcript-empty">Waiting for transcript...</p>
            ) : null}
            {transcriptTurns.map((turn) => {
              const turnPhraseCard = phraseCards.find((card) => card.id === turn.id);
              const russianMeaning =
                fastTranslations[turn.id]?.trim() ??
                turnPhraseCard?.analysis.russianMeaning.trim() ??
                "";
              const translationId = `${turn.id}-russian-meaning`;
              const translationPending =
                pendingTranslationIds.has(turn.id) && russianMeaning.length === 0;
              const hasTranslationStatus = translationPending || russianMeaning.length > 0;

              return (
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
                    aria-describedby={hasTranslationStatus ? translationId : undefined}
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
                    {translationPending ? (
                      <span
                        id={translationId}
                        className="transcript-turn-translation transcript-turn-translation-pending"
                      >
                        Переводим…
                      </span>
                    ) : null}
                    {!translationPending && russianMeaning.length > 0 ? (
                      <span id={translationId} className="transcript-turn-translation" lang="ru">
                        {russianMeaning}
                      </span>
                    ) : null}
                  </button>
                </article>
              );
            })}
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
          {selectedTranscriptTurn != null && !answerHintOpen ? (
            <button
              type="button"
              className="answer-hint-open"
              onClick={() => setAnswerHintOpen(true)}
            >
              Add my point
            </button>
          ) : null}
          {selectedTranscriptTurn != null && answerHintOpen ? (
            <form
              className="answer-hint-form"
              aria-label="Generate answer from my point"
              onSubmit={(event) => {
                event.preventDefault();
                void handleGenerateAnswerFromHint();
              }}
            >
              <div className="answer-hint-header">
                <label htmlFor="training-answer-hint">My point</label>
                <button type="button" onClick={() => setAnswerHintOpen(false)}>
                  Hide
                </button>
              </div>
              <textarea
                id="training-answer-hint"
                value={answerHint}
                maxLength={maxAnswerHintCharacters}
                placeholder="What do you want to say? Russian or English is fine."
                onChange={(event) => setAnswerHint(event.target.value)}
                disabled={pendingAnalysisIds.has(selectedTranscriptTurn.id)}
              />
              <div className="answer-hint-actions">
                <span>Used only for this card.</span>
                <button
                  type="submit"
                  className="primary-action"
                  disabled={
                    answerHint.trim().length === 0 ||
                    pendingAnalysisIds.has(selectedTranscriptTurn.id)
                  }
                >
                  {selectedPhraseCard == null ? "Generate answer" : "Regenerate answer"}
                </button>
              </div>
            </form>
          ) : null}
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
