import type { TranscriptSegment } from "./session";

export const mockConversation: TranscriptSegment[] = [
  {
    id: "segment-1",
    speaker: "other",
    original: "Can you commit by Friday?",
    translation: "Можешь подтвердить срок до пятницы?",
    uncertainty: { level: "low" }
  },
  {
    id: "segment-2",
    speaker: "user",
    original: "I need to check the dependencies first.",
    translation: "Мне нужно сначала проверить зависимости.",
    uncertainty: { level: "none" }
  },
  {
    id: "segment-3",
    speaker: "other",
    original: "That works, but we need a clear answer today.",
    translation: "Подходит, но нам нужен ясный ответ сегодня.",
    uncertainty: {
      level: "medium",
      reason: "Room audio from MacBook speakers may make 'that works' ambiguous.",
      alternative: "Confirm what exactly they accepted before committing."
    }
  }
];
