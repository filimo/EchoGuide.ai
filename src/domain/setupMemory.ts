export type SetupMode = "training-mode";

export type SetupMemory = {
  version: 1;
  onboardingCompleted: boolean;
  selectedMode: SetupMode;
  sourceLabel: string;
  knowledgeContext: string;
};

export const setupMemoryStorageKey = "echoguide.setup.v1";
export const defaultSourceLabel = "ChatGPT Real Voice practice";

export function createDefaultSetupMemory(): SetupMemory {
  return {
    version: 1,
    onboardingCompleted: false,
    selectedMode: "training-mode",
    sourceLabel: defaultSourceLabel,
    knowledgeContext: ""
  };
}

export function loadSetupMemory(storage: Storage): SetupMemory {
  const fallback = createDefaultSetupMemory();
  const rawValue = storage.getItem(setupMemoryStorageKey);

  if (rawValue == null) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(rawValue) as Partial<SetupMemory>;

    return {
      version: 1,
      onboardingCompleted: parsed.onboardingCompleted === true,
      selectedMode: "training-mode",
      sourceLabel:
        typeof parsed.sourceLabel === "string" && parsed.sourceLabel.trim().length > 0
          ? parsed.sourceLabel
          : fallback.sourceLabel,
      knowledgeContext:
        typeof parsed.knowledgeContext === "string"
          ? parsed.knowledgeContext
          : fallback.knowledgeContext
    };
  } catch {
    return fallback;
  }
}

export function saveSetupMemory(storage: Storage, memory: SetupMemory): void {
  storage.setItem(setupMemoryStorageKey, JSON.stringify(memory));
}
