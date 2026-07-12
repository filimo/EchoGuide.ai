import { describe, expect, it } from "vitest";
import {
  createInitialSession,
  selectReply,
  setKnowledgeNotes,
  setMicrophoneStatus
} from "./session";

describe("session domain", () => {
  it("starts as iPad companion setup with no persisted transcript", () => {
    const session = createInitialSession();

    expect(session.audio.microphone).toBe("idle");
    expect("listeningCheck" in session.audio).toBe(false);
    expect(session.knowledge.notes).toBe("");
    expect(session.transcript).toEqual([]);
    expect(session.transcriptStorage).toBe("manual-save-or-export");
  });

  it("stores pasted notes for only the current session", () => {
    const session = setKnowledgeNotes(createInitialSession(), "Mention dependency review.");

    expect(session.knowledge.notes).toBe("Mention dependency review.");
  });

  it("tracks iPad microphone status", () => {
    const withMic = setMicrophoneStatus(createInitialSession(), "active");

    expect(withMic.audio.microphone).toBe("active");
  });

  it("stores selected reply without persisting transcript automatically", () => {
    const session = selectReply(createInitialSession(), {
      id: "r1",
      shortText: "Уточнить scope",
      fullSentence: "I can confirm after we clarify the exact scope.",
      uncertainty: { level: "low" }
    });

    expect(session.selectedReply?.shortText).toBe("Уточнить scope");
    expect(session.transcriptStorage).toBe("manual-save-or-export");
  });
});
