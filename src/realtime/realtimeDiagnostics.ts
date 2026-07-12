import type { RealtimeAudioStats } from "./realtimeConnection";

export type RealtimeDiagnosticEvent = {
  at: string;
  type: string;
  details?: Record<string, boolean | number | string | null>;
};

export type RealtimeDiagnosticReport = {
  version: 1;
  reportId: string;
  capturedAt: string;
  trigger: "manual" | "automatic";
  runtime: {
    path: string;
    userAgent: string;
    visibilityState: string;
  };
  status: {
    realtime: string;
    microphonePresent: boolean;
    clientSecretExpiresAt: number | null;
    openAiSessionId: string | null;
  };
  audio: {
    latestStats: RealtimeAudioStats | null;
    tracks: Array<{
      kind: string;
      readyState: string;
      enabled: boolean;
      muted: boolean;
    }>;
  };
  events: RealtimeDiagnosticEvent[];
};

export function createRealtimeDiagnosticId(now = Date.now()): string {
  return `diag-${now}-${Math.random().toString(36).slice(2, 10)}`;
}

export function isRealtimeDiagnosticReport(value: unknown): value is RealtimeDiagnosticReport {
  if (typeof value !== "object" || value == null) {
    return false;
  }

  const report = value as Partial<RealtimeDiagnosticReport>;

  return (
    report.version === 1 &&
    typeof report.reportId === "string" &&
    /^diag-[a-z0-9-]{8,80}$/i.test(report.reportId) &&
    typeof report.capturedAt === "string" &&
    (report.trigger === "manual" || report.trigger === "automatic") &&
    typeof report.runtime === "object" &&
    report.runtime != null &&
    typeof report.status === "object" &&
    report.status != null &&
    typeof report.audio === "object" &&
    report.audio != null &&
    Array.isArray(report.events) &&
    report.events.length <= 120
  );
}

const diagnosticDetailKeys = new Set([
  "bufferedAmount",
  "bytesSent",
  "chunksObserved",
  "clientSecretExpiresAt",
  "code",
  "errorType",
  "eventType",
  "headerBytesSent",
  "kind",
  "audioLevel",
  "peak",
  "packetsSent",
  "readyState",
  "retransmittedPacketsSent",
  "rms",
  "sampleRate",
  "secondsSinceLastSpeechStarted",
  "silentChunks",
  "state",
  "statsTimestamp",
  "totalAudioEnergy",
  "totalSamplesDuration",
  "vadMode",
  "vadPrefixPaddingMs",
  "vadSilenceDurationMs",
  "vadThreshold",
  "semanticEagerness",
  "speechLanguage",
  "trackCount"
]);

function sanitizeDetails(
  details: RealtimeDiagnosticEvent["details"]
): RealtimeDiagnosticEvent["details"] {
  if (details == null) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(details)
      .filter(([key]) => diagnosticDetailKeys.has(key))
      .map(([key, value]) => [key, typeof value === "string" ? value.slice(0, 160) : value])
  );
}

function sanitizeAudioStats(value: unknown): RealtimeAudioStats | null {
  if (typeof value !== "object" || value == null) {
    return null;
  }

  const stats = value as Partial<RealtimeAudioStats>;
  const numericKeys: Array<keyof RealtimeAudioStats> = [
    "chunksObserved",
    "silentChunks",
    "dataChannelBufferedAmount",
    "inputSampleRate",
    "samplesInLastChunk",
    "rms",
    "peak"
  ];

  if (!numericKeys.every((key) => typeof stats[key] === "number")) {
    return null;
  }

  return Object.fromEntries(numericKeys.map((key) => [key, stats[key]])) as RealtimeAudioStats;
}

export function sanitizeRealtimeDiagnosticReport(
  value: unknown
): RealtimeDiagnosticReport | null {
  if (!isRealtimeDiagnosticReport(value)) {
    return null;
  }

  return {
    version: 1,
    reportId: value.reportId.slice(0, 96),
    capturedAt: value.capturedAt.slice(0, 40),
    trigger: value.trigger,
    runtime: {
      path: typeof value.runtime.path === "string" ? value.runtime.path.slice(0, 256) : "",
      userAgent:
        typeof value.runtime.userAgent === "string" ? value.runtime.userAgent.slice(0, 512) : "",
      visibilityState:
        typeof value.runtime.visibilityState === "string"
          ? value.runtime.visibilityState.slice(0, 32)
          : "unknown"
    },
    status: {
      realtime:
        typeof value.status.realtime === "string" ? value.status.realtime.slice(0, 32) : "unknown",
      microphonePresent: value.status.microphonePresent === true,
      clientSecretExpiresAt:
        typeof value.status.clientSecretExpiresAt === "number"
          ? value.status.clientSecretExpiresAt
          : null,
      openAiSessionId:
        typeof value.status.openAiSessionId === "string"
          ? value.status.openAiSessionId.slice(0, 128)
          : null
    },
    audio: {
      latestStats: sanitizeAudioStats(value.audio.latestStats),
      tracks: Array.isArray(value.audio.tracks)
        ? value.audio.tracks.slice(0, 4).map((track) => ({
            kind: typeof track.kind === "string" ? track.kind.slice(0, 16) : "unknown",
            readyState:
              typeof track.readyState === "string" ? track.readyState.slice(0, 16) : "unknown",
            enabled: track.enabled === true,
            muted: track.muted === true
          }))
        : []
    },
    events: value.events
      .filter((event) => typeof event === "object" && event != null)
      .slice(-120)
      .map((event) => {
        const details = sanitizeDetails(event.details);

        return {
          at: typeof event.at === "string" ? event.at.slice(0, 40) : "",
          type: typeof event.type === "string" ? event.type.slice(0, 120) : "unknown",
          ...(details == null ? {} : { details })
        };
      })
  };
}
