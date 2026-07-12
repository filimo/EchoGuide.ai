export type AudioStatus = "idle" | "requesting" | "active" | "blocked" | "error";
export type Speaker = "user" | "other";
export type UncertaintyLevel = "none" | "low" | "medium" | "high";

export type Uncertainty = {
  level: UncertaintyLevel;
  reason?: string;
  alternative?: string;
};

export type TranscriptSegment = {
  id: string;
  speaker: Speaker;
  original: string;
  translation: string;
  uncertainty: Uncertainty;
};

export type SuggestedReply = {
  id: string;
  shortText: string;
  fullSentence: string;
  uncertainty: Uncertainty;
};

export type SessionState = {
  audio: {
    microphone: AudioStatus;
  };
  knowledge: {
    notes: string;
  };
  transcript: TranscriptSegment[];
  suggestions: SuggestedReply[];
  selectedReply: SuggestedReply | null;
  transcriptStorage: "manual-save-or-export";
};

export function createInitialSession(): SessionState {
  return {
    audio: {
      microphone: "idle"
    },
    knowledge: {
      notes: ""
    },
    transcript: [],
    suggestions: [],
    selectedReply: null,
    transcriptStorage: "manual-save-or-export"
  };
}

export function setKnowledgeNotes(session: SessionState, notes: string): SessionState {
  return { ...session, knowledge: { notes } };
}

export function setMicrophoneStatus(session: SessionState, microphone: AudioStatus): SessionState {
  return { ...session, audio: { ...session.audio, microphone } };
}

export function setSuggestions(session: SessionState, suggestions: SuggestedReply[]): SessionState {
  return { ...session, suggestions };
}

export function setTranscript(session: SessionState, transcript: TranscriptSegment[]): SessionState {
  return { ...session, transcript };
}

export function selectReply(session: SessionState, reply: SuggestedReply): SessionState {
  return { ...session, selectedReply: reply };
}
