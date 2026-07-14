import { afterEach, describe, expect, it } from "vitest";
import {
  deleteSessionHistoryEntry,
  loadSessionHistory,
  saveSessionHistoryEntry,
  sessionHistoryStorageKey,
  type SessionHistoryEntryDraft
} from "./sessionHistory";

const draftEntry: SessionHistoryEntryDraft = {
  sourceLabel: "ChatGPT Real Voice practice",
  knowledgeContext: "Mention dependency review.",
  transcriptTurns: [
    {
      id: "training-phrase-0",
      speakerLabel: "Interviewer",
      text: "Can you walk me through your recent project?",
      source: "realtime",
      originalText: "Can you walk through your recent project?"
    }
  ],
  phraseCards: [
    {
      id: "training-phrase-0",
      transcript: "Can you walk me through your recent project?",
      source: "selected-group",
      analysis: {
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
      }
    }
  ],
  selectedReplies: [
    {
      phraseId: "training-phrase-0",
      reply: {
        shortLabel: "Project context",
        shortLabelTranslation: "Контекст проекта",
        fullSentence: "Sure, the project focused on improving a core user workflow.",
        fullSentenceTranslation:
          "Конечно, проект был сфокусирован на улучшении основного пользовательского сценария.",
        whyUse: "Когда нужно начать с контекста проекта."
      }
    }
  ],
  usedBridgePhrases: [
    {
      english: "Let me think for a second.",
      russian: "Дайте секунду подумать."
    }
  ]
};

afterEach(() => {
  window.localStorage.clear();
});

describe("session history storage", () => {
  it("saves local Training Mode sessions with transcript, analysis, replies, bridge phrases, source, and knowledge context", () => {
    const saved = saveSessionHistoryEntry(window.localStorage, draftEntry, {
      now: () => new Date("2026-07-08T10:00:00.000Z"),
      id: () => "session-1"
    });

    expect(saved).toMatchObject({
      id: "session-1",
      savedAt: "2026-07-08T10:00:00.000Z",
      createdAt: "2026-07-08T10:00:00.000Z",
      updatedAt: "2026-07-08T10:00:00.000Z",
      sourceLabel: "ChatGPT Real Voice practice",
      knowledgeContext: "Mention dependency review."
    });

    const history = loadSessionHistory(window.localStorage);

    expect(history.sessions).toHaveLength(1);
    expect(history.sessions[0]?.transcriptTurns[0]?.text).toBe(
      "Can you walk me through your recent project?"
    );
    expect(history.sessions[0]?.transcriptTurns[0]?.speakerLabel).toBe("Interviewer");
    expect(history.sessions[0]?.transcriptTurns[0]?.source).toBe("realtime");
    expect(history.sessions[0]?.transcriptTurns[0]?.originalText).toBe(
      "Can you walk through your recent project?"
    );
    expect(history.sessions[0]?.phraseCards[0]?.analysis.russianMeaning).toBe(
      "Можешь рассказать о последнем проекте?"
    );
    expect(history.sessions[0]?.phraseCards[0]?.source).toBe("selected-group");
    expect(history.sessions[0]?.selectedReplies[0]?.reply.fullSentence).toBe(
      "Sure, the project focused on improving a core user workflow."
    );
    expect(history.sessions[0]?.usedBridgePhrases[0]?.english).toBe(
      "Let me think for a second."
    );
  });

  it("falls back to empty history when stored JSON is invalid", () => {
    window.localStorage.setItem(sessionHistoryStorageKey, "{bad json");

    expect(loadSessionHistory(window.localStorage)).toEqual({
      version: 1,
      sessions: []
    });
  });

  it("repairs duplicate phrase ids without losing transcript-card relationships", () => {
    const makeReply = (shortLabel: string) => ({
      shortLabel,
      shortLabelTranslation: shortLabel,
      fullSentence: `${shortLabel} answer.`,
      fullSentenceTranslation: `${shortLabel} ответ.`,
      whyUse: `${shortLabel} подсказка.`
    });
    const nextQuestionsReply = makeReply("Continue practice");
    const prioritiesReply = makeReply("Clear priorities");

    window.localStorage.setItem(
      sessionHistoryStorageKey,
      JSON.stringify({
        version: 1,
        sessions: [
          {
            version: 1,
            id: "session-duplicate-ids",
            savedAt: "2026-07-11T00:40:00.000Z",
            createdAt: "2026-07-11T00:30:00.000Z",
            updatedAt: "2026-07-11T00:40:00.000Z",
            sourceLabel: "Interview practice",
            knowledgeContext: "",
            transcriptTurns: [
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
                  suggestedReplies: [nextQuestionsReply]
                }
              },
              {
                id: "training-phrase-50",
                transcript: "What's your approach to prioritizing when everything feels urgent?",
                source: "auto",
                analysis: {
                  analysisTargetText:
                    "What's your approach to prioritizing when everything feels urgent?",
                  russianMeaning: "Как вы расставляете приоритеты?",
                  isQuestion: true,
                  bridgePhrase: "Let me explain.",
                  suggestedReplies: [prioritiesReply]
                }
              }
            ],
            selectedReplies: [{ phraseId: "training-phrase-50", reply: prioritiesReply }],
            usedBridgePhrases: []
          }
        ]
      })
    );

    const repaired = loadSessionHistory(window.localStorage).sessions[0]!;
    const latestTurn = repaired.transcriptTurns.at(-1)!;
    const latestCard = repaired.phraseCards.at(-1)!;

    expect(repaired.transcriptTurns).toHaveLength(2);
    expect(new Set(repaired.transcriptTurns.map((turn) => turn.id)).size).toBe(2);
    expect(new Set(repaired.phraseCards.map((card) => card.id)).size).toBe(2);
    expect(latestCard.id).toBe(latestTurn.id);
    expect(latestCard.analysis.russianMeaning).toBe("Как вы расставляете приоритеты?");
    expect(repaired.selectedReplies[0]?.phraseId).toBe(latestCard.id);
  });

  it("keeps the original creation time and updates the last updated time for an existing session", () => {
    saveSessionHistoryEntry(window.localStorage, draftEntry, {
      now: () => new Date("2026-07-08T10:00:00.000Z"),
      sessionId: "session-1"
    });

    const savedAgain = saveSessionHistoryEntry(window.localStorage, draftEntry, {
      now: () => new Date("2026-07-08T10:15:00.000Z"),
      sessionId: "session-1"
    });

    expect(savedAgain.createdAt).toBe("2026-07-08T10:00:00.000Z");
    expect(savedAgain.updatedAt).toBe("2026-07-08T10:15:00.000Z");
    expect(savedAgain.savedAt).toBe("2026-07-08T10:15:00.000Z");
    expect(loadSessionHistory(window.localStorage).sessions).toHaveLength(1);
  });

  it("keeps an existing session in its original list position when updating it", () => {
    saveSessionHistoryEntry(window.localStorage, draftEntry, {
      now: () => new Date("2026-07-08T10:00:00.000Z"),
      sessionId: "session-1"
    });
    saveSessionHistoryEntry(window.localStorage, draftEntry, {
      now: () => new Date("2026-07-08T10:05:00.000Z"),
      sessionId: "session-2"
    });
    saveSessionHistoryEntry(window.localStorage, draftEntry, {
      now: () => new Date("2026-07-08T10:10:00.000Z"),
      sessionId: "session-1"
    });

    expect(loadSessionHistory(window.localStorage).sessions.map((session) => session.id)).toEqual([
      "session-2",
      "session-1"
    ]);
  });

  it("deletes a saved session by id", () => {
    saveSessionHistoryEntry(window.localStorage, draftEntry, {
      now: () => new Date("2026-07-08T10:00:00.000Z"),
      sessionId: "session-1"
    });
    saveSessionHistoryEntry(window.localStorage, draftEntry, {
      now: () => new Date("2026-07-08T10:05:00.000Z"),
      sessionId: "session-2"
    });

    const nextHistory = deleteSessionHistoryEntry(window.localStorage, "session-1");

    expect(nextHistory.sessions.map((session) => session.id)).toEqual(["session-2"]);
    expect(loadSessionHistory(window.localStorage).sessions.map((session) => session.id)).toEqual([
      "session-2"
    ]);
  });
});
