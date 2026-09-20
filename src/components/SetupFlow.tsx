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

        <h1>EchoGuide</h1>
        <p><a href="/mac-audio">Попробовать на MacBook: микрофон + звук звонка</a></p>
        <p className="lead">
          Выбери микрофон или захват звука звонка на MacBook.
        </p>

        <div className="setup-grid">
          <button type="button" onClick={props.onRequestMicrophone}>
            Подключить микрофон
          </button>
          <span className={`status status-${props.microphoneStatus}`}>
            Microphone: {statusText(props.microphoneStatus)}
          </span>
        </div>

        <p className="hint">
          Для звонка в наушниках используй режим MacBook: микрофон + звук приложения.
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
