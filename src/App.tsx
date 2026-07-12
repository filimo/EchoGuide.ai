import { useEffect, useState } from "react";
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

export default function App({ requestMicrophone = requestMicrophoneStream }: AppProps = {}) {
  const [setupMemory, setSetupMemory] = useState(() => loadSetupMemory(window.localStorage));
  const [session, setSession] = useState(() =>
    setKnowledgeNotes(createInitialSession(), setupMemory.knowledgeContext)
  );
  const [sourceLabel, setSourceLabel] = useState(setupMemory.sourceLabel);
  const [mode, setMode] = useState<"setup" | "live">(
    setupMemory.onboardingCompleted ? "live" : "setup"
  );
  const [errorMessage, setErrorMessage] = useState("");
  const [microphoneStream, setMicrophoneStream] = useState<MediaStream | null>(null);

  useEffect(() => {
    if (setupMemory.knowledgeContext.trim().length > 0) {
      return;
    }

    let cancelled = false;

    void loadLocalKnowledgeContext()
      .then((knowledgeContext) => {
        if (cancelled || knowledgeContext.trim().length === 0) {
          return;
        }

        setSession((current) =>
          current.knowledge.notes.trim().length > 0
            ? current
            : setKnowledgeNotes(current, knowledgeContext)
        );
      })
      .catch(() => {
        // Local knowledge is optional; setup remains manual if it is unavailable.
      });

    return () => {
      cancelled = true;
    };
  }, [setupMemory.knowledgeContext]);

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
      knowledgeContext: session.knowledge.notes
    };
    saveSetupMemory(window.localStorage, nextSetupMemory);
    setSetupMemory(nextSetupMemory);
    setMode("live");
  }

  function handleNotesChange(notes: string) {
    setSession((current) => setKnowledgeNotes(current, notes));

    if (setupMemory.onboardingCompleted) {
      const nextSetupMemory = {
        ...setupMemory,
        knowledgeContext: notes
      };
      saveSetupMemory(window.localStorage, nextSetupMemory);
      setSetupMemory(nextSetupMemory);
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
