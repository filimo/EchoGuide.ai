import type { AudioStatus } from "../domain/session";

type SetupFlowProps = {
  microphoneStatus: AudioStatus;
  sourceLabel: string;
  notes: string;
  errorMessage: string;
  onSourceLabelChange: (sourceLabel: string) => void;
  onNotesChange: (notes: string) => void;
  onRequestMicrophone: () => void;
  onStartSession: () => void;
};

function statusText(status: AudioStatus): string {
  const labels: Record<AudioStatus, string> = {
    idle: "не подключён",
    requesting: "запрашиваем доступ",
    active: "активен",
    blocked: "доступ заблокирован",
    error: "ошибка"
  };

  return labels[status];
}

export function SetupFlow(props: SetupFlowProps) {
  return (
    <main className="setup-shell">
      <section className="setup-panel">
        <p className="eyebrow">iPad companion mode</p>
        <h1>EchoGuide</h1>
        <p className="lead">
          Открой EchoGuide на iPad, поставь iPad рядом с MacBook и разреши microphone.
        </p>

        <div className="setup-grid">
          <button type="button" onClick={props.onRequestMicrophone}>
            Подключить iPad microphone
          </button>
          <span className={`status status-${props.microphoneStatus}`}>
            Microphone: {statusText(props.microphoneStatus)}
          </span>
        </div>

        <p className="hint">
          Если звонок идёт в headphones, iPad может не слышать собеседника. Для MVP используй
          speakers или другой слышимый источник.
        </p>

        <label className="notes-label" htmlFor="source-label">
          Source label
        </label>
        <input
          id="source-label"
          type="text"
          value={props.sourceLabel}
          onChange={(event) => props.onSourceLabelChange(event.target.value)}
          placeholder="MacBook call, ChatGPT Real Voice practice, interview practice..."
        />

        <label className="notes-label" htmlFor="knowledge-notes">
          Pasted notes
        </label>
        <textarea
          id="knowledge-notes"
          value={props.notes}
          onChange={(event) => props.onNotesChange(event.target.value)}
          placeholder="Факты о проекте, клиенте, правила ответа или контекст разговора."
        />

        {props.errorMessage.length > 0 ? <p className="error-text">{props.errorMessage}</p> : null}

        <button className="primary-action" type="button" onClick={props.onStartSession}>
          Перейти в live session
        </button>
      </section>
    </main>
  );
}
