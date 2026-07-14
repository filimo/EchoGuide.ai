import type { BilingualPhraseAnalysis, BilingualSuggestedReply } from "../realtime/bilingualAnalysis";

export type SessionSpeakerLabel = "Heard" | "Interviewer" | "Me";

export type SessionHistoryTranscriptTurn = {
  id: string;
  speakerLabel: SessionSpeakerLabel;
  text: string;
  source?: "realtime" | "manual";
  originalText?: string;
};

export type SessionHistoryPhraseCard = {
  id: string;
  transcript: string;
  source?: "auto" | "selected-group";
  analysis: BilingualPhraseAnalysis;
};

export type SessionHistorySelectedReply = {
  phraseId: string;
  reply: BilingualSuggestedReply;
};

export type SessionHistoryBridgePhrase = {
  english: string;
  russian: string;
};

export type SessionHistoryEntry = {
  version: 1;
  id: string;
  savedAt: string;
  createdAt: string;
  updatedAt: string;
  sourceLabel: string;
  knowledgeContext: string;
  transcriptTurns: SessionHistoryTranscriptTurn[];
  phraseCards: SessionHistoryPhraseCard[];
  selectedReplies: SessionHistorySelectedReply[];
  usedBridgePhrases: SessionHistoryBridgePhrase[];
};

export type SessionHistoryEntryDraft = Omit<
  SessionHistoryEntry,
  "version" | "id" | "savedAt" | "createdAt" | "updatedAt"
>;

export type SessionHistoryState = {
  version: 1;
  sessions: SessionHistoryEntry[];
};

export type SessionHistoryClient = {
  loadSessions: () => Promise<SessionHistoryEntry[]>;
  saveCurrentSession: (
    sessionId: string,
    draft: SessionHistoryEntryDraft
  ) => Promise<SessionHistoryEntry>;
  deleteSession: (sessionId: string) => Promise<SessionHistoryEntry[]>;
};

type SaveSessionHistoryOptions = {
  now?: () => Date;
  id?: () => string;
  sessionId?: string;
  createdAt?: string;
};

export const sessionHistoryStorageKey = "echoguide.session-history.v1";
const maxStoredSessions = 20;

function createEmptySessionHistory(): SessionHistoryState {
  return {
    version: 1,
    sessions: []
  };
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isReply(value: unknown): value is BilingualSuggestedReply {
  if (typeof value !== "object" || value == null) {
    return false;
  }

  const candidate = value as Partial<BilingualSuggestedReply>;

  return (
    isString(candidate.shortLabel) &&
    isString(candidate.shortLabelTranslation) &&
    isString(candidate.fullSentence) &&
    isString(candidate.fullSentenceTranslation)
  );
}

function isAnalysis(value: unknown): value is BilingualPhraseAnalysis {
  if (typeof value !== "object" || value == null) {
    return false;
  }

  const candidate = value as Partial<BilingualPhraseAnalysis>;

  return (
    isString(candidate.russianMeaning) &&
    typeof candidate.isQuestion === "boolean" &&
    isString(candidate.bridgePhrase) &&
    Array.isArray(candidate.suggestedReplies) &&
    candidate.suggestedReplies.every(isReply)
  );
}

function isTranscriptTurn(value: unknown): value is SessionHistoryTranscriptTurn {
  if (typeof value !== "object" || value == null) {
    return false;
  }

  const candidate = value as Partial<SessionHistoryTranscriptTurn>;

  return (
    isString(candidate.id) &&
    (candidate.speakerLabel === "Heard" ||
      candidate.speakerLabel === "Interviewer" ||
      candidate.speakerLabel === "Me") &&
    isString(candidate.text) &&
    (candidate.source == null ||
      candidate.source === "realtime" ||
      candidate.source === "manual") &&
    (candidate.originalText == null || isString(candidate.originalText))
  );
}

function isPhraseCard(value: unknown): value is SessionHistoryPhraseCard {
  if (typeof value !== "object" || value == null) {
    return false;
  }

  const candidate = value as Partial<SessionHistoryPhraseCard>;

  return (
    isString(candidate.id) &&
    isString(candidate.transcript) &&
    (candidate.source == null ||
      candidate.source === "auto" ||
      candidate.source === "selected-group") &&
    isAnalysis(candidate.analysis)
  );
}

function isSelectedReply(value: unknown): value is SessionHistorySelectedReply {
  if (typeof value !== "object" || value == null) {
    return false;
  }

  const candidate = value as Partial<SessionHistorySelectedReply>;

  return isString(candidate.phraseId) && isReply(candidate.reply);
}

function isBridgePhrase(value: unknown): value is SessionHistoryBridgePhrase {
  if (typeof value !== "object" || value == null) {
    return false;
  }

  const candidate = value as Partial<SessionHistoryBridgePhrase>;

  return isString(candidate.english) && isString(candidate.russian);
}

function hasDuplicateIds(items: Array<{ id: string }>): boolean {
  return new Set(items.map((item) => item.id)).size !== items.length;
}

function createRecoveredPhraseId(
  originalId: string,
  kind: "turn" | "card",
  index: number,
  reservedIds: Set<string>
): string {
  let attempt = 0;
  let candidate = `${originalId}-recovered-${kind}-${index}`;

  while (reservedIds.has(candidate)) {
    attempt += 1;
    candidate = `${originalId}-recovered-${kind}-${index}-${attempt}`;
  }

  reservedIds.add(candidate);
  return candidate;
}

function repliesMatch(left: BilingualSuggestedReply, right: BilingualSuggestedReply): boolean {
  return left.shortLabel === right.shortLabel && left.fullSentence === right.fullSentence;
}

export function ensureUniqueSessionPhraseIds(session: SessionHistoryEntry): SessionHistoryEntry {
  if (!hasDuplicateIds(session.transcriptTurns) && !hasDuplicateIds(session.phraseCards)) {
    return session;
  }

  const reservedIds = new Set([
    ...session.transcriptTurns.map((turn) => turn.id),
    ...session.phraseCards.map((card) => card.id)
  ]);
  const assignedTurnIds = new Set<string>();
  const turnMappings: Array<{
    originalId: string;
    text: string;
    recoveredId: string;
  }> = [];
  const transcriptTurns = session.transcriptTurns.map((turn, index) => {
    const recoveredId = assignedTurnIds.has(turn.id)
      ? createRecoveredPhraseId(turn.id, "turn", index, reservedIds)
      : turn.id;

    assignedTurnIds.add(recoveredId);
    turnMappings.push({ originalId: turn.id, text: turn.text, recoveredId });
    return recoveredId === turn.id ? turn : { ...turn, id: recoveredId };
  });
  const assignedCardIds = new Set<string>();
  const cardMappings: Array<{
    originalId: string;
    recoveredId: string;
    card: SessionHistoryPhraseCard;
  }> = [];
  const phraseCards = session.phraseCards.map((card, index) => {
    const matchingTurn = turnMappings.find(
      (mapping) =>
        mapping.originalId === card.id &&
        mapping.text === card.transcript &&
        !assignedCardIds.has(mapping.recoveredId)
    );
    const recoveredId =
      matchingTurn?.recoveredId ??
      (!assignedCardIds.has(card.id) && !assignedTurnIds.has(card.id)
        ? card.id
        : createRecoveredPhraseId(card.id, "card", index, reservedIds));
    const recoveredCard = recoveredId === card.id ? card : { ...card, id: recoveredId };

    assignedCardIds.add(recoveredId);
    cardMappings.push({ originalId: card.id, recoveredId, card: recoveredCard });
    return recoveredCard;
  });
  const selectedReplies = session.selectedReplies.map((selectedReply) => {
    const candidates = cardMappings.filter(
      (mapping) => mapping.originalId === selectedReply.phraseId
    );
    const matchingCandidate = [...candidates]
      .reverse()
      .find((mapping) =>
        mapping.card.analysis.suggestedReplies.some((reply) =>
          repliesMatch(reply, selectedReply.reply)
        )
      );
    const recoveredPhraseId = matchingCandidate?.recoveredId ?? candidates.at(-1)?.recoveredId;

    return recoveredPhraseId == null || recoveredPhraseId === selectedReply.phraseId
      ? selectedReply
      : { ...selectedReply, phraseId: recoveredPhraseId };
  });

  return {
    ...session,
    transcriptTurns,
    phraseCards,
    selectedReplies
  };
}

function normalizeSessionHistoryEntry(value: unknown): SessionHistoryEntry | null {
  if (typeof value !== "object" || value == null) {
    return null;
  }

  const candidate = value as Partial<SessionHistoryEntry>;

  if (
    candidate.version !== 1 ||
    !isString(candidate.id) ||
    !isString(candidate.savedAt) ||
    !isString(candidate.sourceLabel) ||
    !isString(candidate.knowledgeContext) ||
    !Array.isArray(candidate.transcriptTurns) ||
    !candidate.transcriptTurns.every(isTranscriptTurn) ||
    !Array.isArray(candidate.phraseCards) ||
    !candidate.phraseCards.every(isPhraseCard) ||
    !Array.isArray(candidate.selectedReplies) ||
    !candidate.selectedReplies.every(isSelectedReply) ||
    !Array.isArray(candidate.usedBridgePhrases) ||
    !candidate.usedBridgePhrases.every(isBridgePhrase)
  ) {
    return null;
  }

  return ensureUniqueSessionPhraseIds({
    version: 1,
    id: candidate.id,
    savedAt: candidate.savedAt,
    createdAt: isString(candidate.createdAt) ? candidate.createdAt : candidate.savedAt,
    updatedAt: isString(candidate.updatedAt) ? candidate.updatedAt : candidate.savedAt,
    sourceLabel: candidate.sourceLabel,
    knowledgeContext: candidate.knowledgeContext,
    transcriptTurns: candidate.transcriptTurns,
    phraseCards: candidate.phraseCards,
    selectedReplies: candidate.selectedReplies,
    usedBridgePhrases: candidate.usedBridgePhrases
  });
}

export function isSessionHistoryEntryDraft(value: unknown): value is SessionHistoryEntryDraft {
  if (typeof value !== "object" || value == null) {
    return false;
  }

  const candidate = value as Partial<SessionHistoryEntryDraft>;

  return (
    isString(candidate.sourceLabel) &&
    isString(candidate.knowledgeContext) &&
    Array.isArray(candidate.transcriptTurns) &&
    candidate.transcriptTurns.every(isTranscriptTurn) &&
    Array.isArray(candidate.phraseCards) &&
    candidate.phraseCards.every(isPhraseCard) &&
    Array.isArray(candidate.selectedReplies) &&
    candidate.selectedReplies.every(isSelectedReply) &&
    Array.isArray(candidate.usedBridgePhrases) &&
    candidate.usedBridgePhrases.every(isBridgePhrase)
  );
}

function createSessionId(now: Date): string {
  return `session-${now.getTime()}`;
}

function createSessionHistoryEntry(
  draft: SessionHistoryEntryDraft,
  options: SaveSessionHistoryOptions = {}
): SessionHistoryEntry {
  const savedAtDate = options.now?.() ?? new Date();

  return {
    version: 1,
    id: options.sessionId ?? options.id?.() ?? createSessionId(savedAtDate),
    savedAt: savedAtDate.toISOString(),
    createdAt: options.createdAt ?? savedAtDate.toISOString(),
    updatedAt: savedAtDate.toISOString(),
    sourceLabel: draft.sourceLabel,
    knowledgeContext: draft.knowledgeContext,
    transcriptTurns: draft.transcriptTurns,
    phraseCards: draft.phraseCards,
    selectedReplies: draft.selectedReplies,
    usedBridgePhrases: draft.usedBridgePhrases
  };
}

export function upsertSessionHistoryEntry(
  currentHistory: SessionHistoryState,
  draft: SessionHistoryEntryDraft,
  options: SaveSessionHistoryOptions = {}
): { history: SessionHistoryState; entry: SessionHistoryEntry } {
  const sessionId = options.sessionId ?? options.id?.();
  const existingSession =
    sessionId == null ? null : currentHistory.sessions.find((session) => session.id === sessionId);
  const entry = createSessionHistoryEntry(draft, {
    ...options,
    ...(sessionId == null ? {} : { sessionId }),
    createdAt: existingSession?.createdAt ?? existingSession?.savedAt
  });
  const existingIndex = currentHistory.sessions.findIndex((session) => session.id === entry.id);
  const sessions = [...currentHistory.sessions];

  if (existingIndex >= 0) {
    sessions[existingIndex] = entry;
  } else {
    sessions.unshift(entry);
  }

  const nextHistory = {
    version: 1 as const,
    sessions: sessions.slice(0, maxStoredSessions)
  };

  return { history: nextHistory, entry };
}

export function deleteSessionHistoryStateEntry(
  currentHistory: SessionHistoryState,
  sessionId: string
): SessionHistoryState {
  return {
    version: 1,
    sessions: currentHistory.sessions.filter((session) => session.id !== sessionId)
  };
}

export function loadSessionHistory(storage: Storage): SessionHistoryState {
  const rawValue = storage.getItem(sessionHistoryStorageKey);

  if (rawValue == null) {
    return createEmptySessionHistory();
  }

  try {
    return normalizeSessionHistoryState(JSON.parse(rawValue) as unknown);
  } catch {
    return createEmptySessionHistory();
  }
}

export function normalizeSessionHistoryState(value: unknown): SessionHistoryState {
  if (typeof value !== "object" || value == null) {
    return createEmptySessionHistory();
  }

  const candidate = value as { sessions?: unknown };

  if (!Array.isArray(candidate.sessions)) {
    return createEmptySessionHistory();
  }

  return {
    version: 1,
    sessions: candidate.sessions
      .map(normalizeSessionHistoryEntry)
      .filter((session): session is SessionHistoryEntry => session != null)
      .slice(0, maxStoredSessions)
  };
}

export function saveSessionHistoryEntry(
  storage: Storage,
  draft: SessionHistoryEntryDraft,
  options: SaveSessionHistoryOptions = {}
): SessionHistoryEntry {
  const currentHistory = loadSessionHistory(storage);
  const { history: nextHistory, entry } = upsertSessionHistoryEntry(currentHistory, draft, options);

  storage.setItem(sessionHistoryStorageKey, JSON.stringify(nextHistory));

  return entry;
}

export function deleteSessionHistoryEntry(
  storage: Storage,
  sessionId: string
): SessionHistoryState {
  const currentHistory = loadSessionHistory(storage);
  const nextHistory = deleteSessionHistoryStateEntry(currentHistory, sessionId);

  storage.setItem(sessionHistoryStorageKey, JSON.stringify(nextHistory));

  return nextHistory;
}
