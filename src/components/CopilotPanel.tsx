import type { SuggestedReply, TranscriptSegment } from "../domain/session";
import { UncertaintyMark } from "./UncertaintyMark";

type CopilotPanelProps = {
  transcript: TranscriptSegment[];
  suggestions: SuggestedReply[];
  selectedReply: SuggestedReply | null;
  onSelectReply: (reply: SuggestedReply) => void;
  onCopyReply: (reply: SuggestedReply) => void;
  onCopyTranscript: () => void;
};

export function CopilotPanel(props: CopilotPanelProps) {
  return (
    <main className="copilot-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">iPad companion mode</p>
          <h1>Live Copilot</h1>
        </div>
        <button type="button" onClick={props.onCopyTranscript}>
          Copy transcript
        </button>
      </header>

      <section className="copilot-grid">
        <div className="conversation-panel">
          <h2>Conversation</h2>
          {props.transcript.map((segment) => (
            <article className={`segment segment-${segment.speaker}`} key={segment.id}>
              <div className="segment-meta">
                <span>{segment.speaker === "other" ? "Собеседник" : "Вы"}</span>
                <UncertaintyMark uncertainty={segment.uncertainty} />
              </div>
              <p className="original">{segment.original}</p>
              <p className="translation">{segment.translation}</p>
            </article>
          ))}
        </div>

        <aside className="suggestions-panel">
          <h2>Suggested replies</h2>
          {props.suggestions.map((reply) => {
            const isSelected = props.selectedReply?.id === reply.id;

            return (
              <div
                className={`suggestion-card${isSelected ? " suggestion-card-selected" : ""}`}
                key={reply.id}
              >
                <div className="suggestion-row">
                  <button
                    aria-label={reply.shortText}
                    aria-pressed={isSelected}
                    className="suggestion-option"
                    type="button"
                    onClick={() => props.onSelectReply(reply)}
                  >
                    {reply.shortText}
                  </button>
                  <UncertaintyMark uncertainty={reply.uncertainty} />
                </div>
                {isSelected ? (
                  <section className="reply-expansion" aria-label="Full sentence reply">
                    <h3>Full sentence</h3>
                    <p>{reply.fullSentence}</p>
                    <button type="button" onClick={() => props.onCopyReply(reply)}>
                      Copy reply
                    </button>
                  </section>
                ) : null}
              </div>
            );
          })}
        </aside>
      </section>
    </main>
  );
}
