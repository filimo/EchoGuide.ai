export const OPENAI_REALTIME_CLIENT_SECRETS_URL =
  "https://api.openai.com/v1/realtime/client_secrets";

export type RealtimeClientSecret = {
  clientSecret: string;
  expiresAt: number;
  sessionId?: string;
};

export type RealtimeLabMode = "whisper-ptt" | "realtime-vad";
export type RealtimeSpeechLanguage = "english" | "russian" | "english-russian";
export type RealtimeTurnDetectionMode = "server_vad" | "semantic_vad" | "disabled";
export type RealtimeSemanticVadEagerness = "auto" | "low" | "medium" | "high";

export type RealtimeTurnDetectionSettings = {
  mode: RealtimeTurnDetectionMode;
  threshold: number;
  prefixPaddingMs: number;
  silenceDurationMs: number;
  semanticEagerness: RealtimeSemanticVadEagerness;
};

export type RealtimeTurnDetection =
  | {
      type: "server_vad";
      threshold: number;
      prefix_padding_ms: number;
      silence_duration_ms: number;
    }
  | {
      type: "semantic_vad";
      eagerness: RealtimeSemanticVadEagerness;
    }
  | null;

export type RealtimeTranscriptionConfig = {
  model: "gpt-4o-transcribe";
  prompt: string;
  language?: "en" | "ru";
};

export type RealtimeTranscriptionSessionUpdate = {
  type: "transcription";
  audio: {
    input: {
      turn_detection: RealtimeTurnDetection;
      transcription: RealtimeTranscriptionConfig;
    };
  };
};

export const realtimeTurnDetectionSettingsStorageKey = "echoguide.turnDetectionSettings.v1";
export const realtimeSpeechLanguageSettingsStorageKey = "echoguide.speechLanguage.v1";

type RealtimeClientSecretPayload = {
  value?: unknown;
  expires_at?: unknown;
  session?: Record<string, unknown> & {
    id?: unknown;
  };
};

type CreateRealtimeClientSecretOptions = {
  apiKey: string;
  mode?: RealtimeLabMode;
  speechLanguage?: RealtimeSpeechLanguage;
  fetchImpl?: typeof fetch;
};

export const defaultRealtimeVadTurnDetection = {
  type: "server_vad",
  threshold: 0.5,
  prefix_padding_ms: 300,
  silence_duration_ms: 1200
} as const;

export const realtimeTranscriptionPrompt =
  "The audio may contain only English or Russian speech. This is software engineering interview practice. Expect simple English, Russian clarifications, software projects, AI tools, data cleaning, pattern matching, React, TypeScript, APIs. Ignore short filler sounds, uncertain background noise, and anything that looks like another language.";

export const englishRealtimeTranscriptionPrompt =
  "The audio should be transcribed as English speech. This is software engineering interview practice. Expect simple English, software projects, AI tools, data cleaning, pattern matching, React, TypeScript, APIs. Ignore short filler sounds and uncertain background noise.";

export const russianRealtimeTranscriptionPrompt =
  "The audio should be transcribed as Russian speech. This is software engineering interview practice with Russian clarifications. Expect Russian speech, software projects, AI tools, data cleaning, pattern matching, React, TypeScript, APIs. Ignore short filler sounds and uncertain background noise.";

export const defaultRealtimeSpeechLanguageSettings: RealtimeSpeechLanguage =
  "english-russian";

export const defaultRealtimeTurnDetectionSettings: RealtimeTurnDetectionSettings = {
  mode: "server_vad",
  threshold: defaultRealtimeVadTurnDetection.threshold,
  prefixPaddingMs: defaultRealtimeVadTurnDetection.prefix_padding_ms,
  silenceDurationMs: defaultRealtimeVadTurnDetection.silence_duration_ms,
  semanticEagerness: "auto"
};

function isRealtimeTurnDetectionMode(value: unknown): value is RealtimeTurnDetectionMode {
  return value === "server_vad" || value === "semantic_vad" || value === "disabled";
}

function isRealtimeSemanticVadEagerness(value: unknown): value is RealtimeSemanticVadEagerness {
  return value === "auto" || value === "low" || value === "medium" || value === "high";
}

function isRealtimeSpeechLanguage(value: unknown): value is RealtimeSpeechLanguage {
  return value === "english" || value === "russian" || value === "english-russian";
}

function readFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function loadRealtimeSpeechLanguageSettings(storage: Storage): RealtimeSpeechLanguage {
  const rawValue = storage.getItem(realtimeSpeechLanguageSettingsStorageKey);

  if (rawValue == null) {
    return defaultRealtimeSpeechLanguageSettings;
  }

  try {
    const parsed = JSON.parse(rawValue) as unknown;
    return isRealtimeSpeechLanguage(parsed) ? parsed : defaultRealtimeSpeechLanguageSettings;
  } catch {
    return defaultRealtimeSpeechLanguageSettings;
  }
}

export function saveRealtimeSpeechLanguageSettings(
  storage: Storage,
  speechLanguage: RealtimeSpeechLanguage
): void {
  storage.setItem(realtimeSpeechLanguageSettingsStorageKey, JSON.stringify(speechLanguage));
}

export function loadRealtimeTurnDetectionSettings(storage: Storage): RealtimeTurnDetectionSettings {
  const rawValue = storage.getItem(realtimeTurnDetectionSettingsStorageKey);

  if (rawValue == null) {
    return defaultRealtimeTurnDetectionSettings;
  }

  try {
    const parsed = JSON.parse(rawValue) as Partial<RealtimeTurnDetectionSettings>;

    return {
      mode: isRealtimeTurnDetectionMode(parsed.mode)
        ? parsed.mode
        : defaultRealtimeTurnDetectionSettings.mode,
      threshold: readFiniteNumber(
        parsed.threshold,
        defaultRealtimeTurnDetectionSettings.threshold
      ),
      prefixPaddingMs: readFiniteNumber(
        parsed.prefixPaddingMs,
        defaultRealtimeTurnDetectionSettings.prefixPaddingMs
      ),
      silenceDurationMs: readFiniteNumber(
        parsed.silenceDurationMs,
        defaultRealtimeTurnDetectionSettings.silenceDurationMs
      ),
      semanticEagerness: isRealtimeSemanticVadEagerness(parsed.semanticEagerness)
        ? parsed.semanticEagerness
        : defaultRealtimeTurnDetectionSettings.semanticEagerness
    };
  } catch {
    return defaultRealtimeTurnDetectionSettings;
  }
}

export function saveRealtimeTurnDetectionSettings(
  storage: Storage,
  settings: RealtimeTurnDetectionSettings
): void {
  storage.setItem(realtimeTurnDetectionSettingsStorageKey, JSON.stringify(settings));
}

export function buildRealtimeTurnDetection(
  settings: RealtimeTurnDetectionSettings
): RealtimeTurnDetection {
  if (settings.mode === "disabled") {
    return null;
  }

  if (settings.mode === "semantic_vad") {
    return {
      type: "semantic_vad",
      eagerness: settings.semanticEagerness
    };
  }

  return {
    type: "server_vad",
    threshold: settings.threshold,
    prefix_padding_ms: settings.prefixPaddingMs,
    silence_duration_ms: settings.silenceDurationMs
  };
}

export function buildRealtimeTranscriptionConfig(
  speechLanguage: RealtimeSpeechLanguage = defaultRealtimeSpeechLanguageSettings
): RealtimeTranscriptionConfig {
  if (speechLanguage === "english") {
    return {
      model: "gpt-4o-transcribe",
      prompt: englishRealtimeTranscriptionPrompt,
      language: "en"
    };
  }

  if (speechLanguage === "russian") {
    return {
      model: "gpt-4o-transcribe",
      prompt: russianRealtimeTranscriptionPrompt,
      language: "ru"
    };
  }

  return {
    model: "gpt-4o-transcribe",
    prompt: realtimeTranscriptionPrompt
  };
}

export function buildRealtimeTranscriptionSessionUpdate(
  settings: RealtimeTurnDetectionSettings,
  speechLanguage: RealtimeSpeechLanguage = defaultRealtimeSpeechLanguageSettings
): RealtimeTranscriptionSessionUpdate {
  return {
    type: "transcription",
    audio: {
      input: {
        turn_detection: buildRealtimeTurnDetection(settings),
        transcription: buildRealtimeTranscriptionConfig(speechLanguage)
      }
    }
  };
}

export function parseRealtimeLabMode(value: string | null | undefined): RealtimeLabMode {
  return value === "realtime-vad" ? "realtime-vad" : "whisper-ptt";
}

export function buildRealtimeClientSecretRequest(
  mode: RealtimeLabMode = "whisper-ptt",
  options: { speechLanguage?: RealtimeSpeechLanguage } = {}
) {
  if (mode === "realtime-vad") {
    return {
      expires_after: {
        anchor: "created_at",
        seconds: 600
      },
      session: {
        type: "transcription",
        audio: {
          input: {
            noise_reduction: {
              type: "far_field"
            },
            transcription: buildRealtimeTranscriptionConfig(options.speechLanguage)
          }
        }
      }
    };
  }

  return {
    expires_after: {
      anchor: "created_at",
      seconds: 600
    },
    session: {
      type: "transcription",
      audio: {
        input: {
          transcription: {
            model: "gpt-realtime-whisper",
            delay: "medium"
          },
          turn_detection: null
        }
      }
    }
  };
}

export function parseRealtimeClientSecretResponse(
  payload: RealtimeClientSecretPayload
): RealtimeClientSecret {
  if (typeof payload.value !== "string" || typeof payload.expires_at !== "number") {
    throw new Error("OpenAI Realtime client secret response had an unexpected shape");
  }

  const sessionId = typeof payload.session?.id === "string" ? payload.session.id : undefined;

  return {
    clientSecret: payload.value,
    expiresAt: payload.expires_at,
    ...(sessionId == null ? {} : { sessionId })
  };
}

export function readOpenAiApiKey(env: NodeJS.ProcessEnv, localEnvText = ""): string | null {
  const processValue = env.OPENAI_API_KEY?.trim();

  if (processValue) {
    return processValue;
  }

  const localLine = localEnvText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith("OPENAI_API_KEY="));

  const localValue = localLine?.slice("OPENAI_API_KEY=".length).trim();
  return localValue ? localValue.replace(/^["']|["']$/g, "") : null;
}

export async function createRealtimeClientSecret({
  apiKey,
  mode = "whisper-ptt",
  speechLanguage = defaultRealtimeSpeechLanguageSettings,
  fetchImpl = fetch
}: CreateRealtimeClientSecretOptions): Promise<RealtimeClientSecret> {
  const response = await fetchImpl(OPENAI_REALTIME_CLIENT_SECRETS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "OpenAI-Safety-Identifier": "echoguide-local-dev"
    },
    body: JSON.stringify(buildRealtimeClientSecretRequest(mode, { speechLanguage }))
  });

  const payload = await response.json();

  if (!response.ok) {
    const upstreamMessage =
      typeof (payload as { error?: { message?: unknown } }).error?.message === "string"
        ? (payload as { error: { message: string } }).error.message
        : "OpenAI Realtime client secret request failed.";

    throw new Error(
      `OpenAI Realtime client secret request failed with status ${response.status}: ${upstreamMessage}`
    );
  }

  return parseRealtimeClientSecretResponse(payload);
}
