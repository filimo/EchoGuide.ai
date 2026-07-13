import { useEffect, useRef, useState } from "react";
import { requestMicrophoneStream, stopStream, type MicrophoneResult } from "./audio/microphone";
import { RealtimeLab } from "./components/RealtimeLab";
import { SetupFlow } from "./components/SetupFlow";
import { TrainingLivePanel } from "./components/TrainingLivePanel";
import {
  createInitialSession,
  setKnowledgeNotes,
  setMicrophoneStatus
} from "./domain/session";
import { loadSetupMemory, saveSetupMemory } from "./domain/setupMemory";

type AppProps = {
  requestMicrophone?: () => Promise<MicrophoneResult>;
};

async function loadLocalKnowledgeContext(): Promise<string> {
  const response = await fetch("/api/knowledge/local");

  if (!response.ok) {
    return "";
  }

  const payload = (await response.json()) as { knowledgeContext?: unknown };

  return typeof payload.knowledgeContext === "string" ? payload.knowledgeContext : "";
}

async function saveLocalKnowledgeContext(knowledgeContext: string): Promise<string> {
  const response = await fetch("/api/knowledge/local", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ knowledgeContext })
  });

  if (!response.ok) {
    throw new Error("Could not save pasted notes on the server.");
  }

  const payload = (await response.json()) as { knowledgeContext?: unknown };

  return typeof payload.knowledgeContext === "string" ? payload.knowledgeContext : "";
}

export default function App({ requestMicrophone = requestMicrophoneStream }: AppProps = {}) {
  const [setupMemory, setSetupMemory] = useState(() => loadSetupMemory(window.localStorage));
  const [session, setSession] = useState(() =>
    setKnowledgeNotes(createInitialSession(), setupMemory.legacyKnowledgeContext)
  );
  const [sourceLabel, setSourceLabel] = useState(setupMemory.sourceLabel);
  const [mode, setMode] = useState<"setup" | "live">(
    setupMemory.onboardingCompleted ? "live" : "setup"
  );
  const [errorMessage, setErrorMessage] = useState("");
  const [microphoneStream, setMicrophoneStream] = useState<MediaStream | null>(null);
  const notesEditedRef = useRef(false);
  const knowledgeHydratedRef = useRef(false);
  const latestNotesRef = useRef(setupMemory.legacyKnowledgeContext);
  const lastSavedKnowledgeRef = useRef<string | null>(null);
  const knowledgeSaveTimeoutRef = useRef<number | null>(null);

  function removeLegacyKnowledgeFromBrowserStorage() {
    if (setupMemory.legacyKnowledgeContext.length === 0) {
      return;
    }

    saveSetupMemory(window.localStorage, {
      ...setupMemory,
      legacyKnowledgeContext: ""
    });
  }

  function scheduleKnowledgeSave(knowledgeContext: string) {
    if (knowledgeContext === lastSavedKnowledgeRef.current) {
      return;
    }

    if (knowledgeSaveTimeoutRef.current != null) {
      window.clearTimeout(knowledgeSaveTimeoutRef.current);
    }

    knowledgeSaveTimeoutRef.current = window.setTimeout(() => {
      knowledgeSaveTimeoutRef.current = null;
      void saveLocalKnowledgeContext(knowledgeContext)
        .then((savedKnowledgeContext) => {
          lastSavedKnowledgeRef.current = savedKnowledgeContext;
          removeLegacyKnowledgeFromBrowserStorage();
        })
        .catch(() => {
          // The next edit will retry without moving private notes back to localStorage.
        });
    }, 400);
  }

  useEffect(() => {
    let cancelled = false;

    void loadLocalKnowledgeContext()
      .then((knowledgeContext) => {
        if (cancelled) {
          return;
        }

        lastSavedKnowledgeRef.current = knowledgeContext;
        knowledgeHydratedRef.current = true;

        if (!notesEditedRef.current && knowledgeContext.trim().length > 0) {
          latestNotesRef.current = knowledgeContext;
          setSession((current) => setKnowledgeNotes(current, knowledgeContext));
          removeLegacyKnowledgeFromBrowserStorage();
        } else {
          scheduleKnowledgeSave(latestNotesRef.current);
        }
      })
      .catch(() => {
        if (!cancelled) {
          // Avoid overwriting an existing server file after a failed load.
          knowledgeHydratedRef.current = true;
          lastSavedKnowledgeRef.current = latestNotesRef.current;
        }
      });

    return () => {
      cancelled = true;
      if (knowledgeSaveTimeoutRef.current != null) {
        window.clearTimeout(knowledgeSaveTimeoutRef.current);
      }
    };
  }, []);

  if (window.location.pathname === "/realtime-lab") {
    return <RealtimeLab />;
  }

  async function handleRequestMicrophone(): Promise<MediaStream | null> {
    setSession((current) => setMicrophoneStatus(current, "requesting"));
    const result = await requestMicrophone();
    setSession((current) => setMicrophoneStatus(current, result.status));
    setMicrophoneStream(result.stream ?? null);
    setErrorMessage(result.errorMessage ?? "");
    return result.stream ?? null;
  }

  function handleStopMicrophone() {
    stopStream(microphoneStream);
    setMicrophoneStream(null);
    setSession((current) => setMicrophoneStatus(current, "idle"));
    setErrorMessage("");
  }

  function handleStartSession() {
    const ready =
      session.audio.microphone === "active" &&
      session.knowledge.notes.trim().length > 0;
    if (!ready) {
      setErrorMessage("Подключи microphone и добавь pasted notes.");
      return;
    }
    const nextSetupMemory = {
      version: 1 as const,
      onboardingCompleted: true,
      selectedMode: "training-mode" as const,
      sourceLabel: sourceLabel.trim() || setupMemory.sourceLabel,
      legacyKnowledgeContext: ""
    };
    saveSetupMemory(window.localStorage, nextSetupMemory);
    setSetupMemory(nextSetupMemory);
    setMode("live");
  }

  function handleNotesChange(notes: string) {
    notesEditedRef.current = true;
    latestNotesRef.current = notes;
    setSession((current) => setKnowledgeNotes(current, notes));

    if (knowledgeHydratedRef.current) {
      scheduleKnowledgeSave(notes);
    }
  }

  if (mode === "live") {
    return (
      <TrainingLivePanel
        stream={microphoneStream}
        notes={session.knowledge.notes}
        sourceLabel={sourceLabel}
        autoOpenLatestSession={setupMemory.onboardingCompleted && microphoneStream == null}
        onNotesChange={handleNotesChange}
        onRequestMicrophone={handleRequestMicrophone}
        onStopMicrophone={handleStopMicrophone}
      />
    );
  }

  return (
    <SetupFlow
      microphoneStatus={session.audio.microphone}
      sourceLabel={sourceLabel}
      notes={session.knowledge.notes}
      errorMessage={errorMessage}
      onSourceLabelChange={setSourceLabel}
      onNotesChange={handleNotesChange}
      onRequestMicrophone={handleRequestMicrophone}
      onStartSession={handleStartSession}
    />
  );
}
