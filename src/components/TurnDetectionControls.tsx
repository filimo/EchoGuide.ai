import type {
  RealtimeSemanticVadEagerness,
  RealtimeTurnDetectionMode,
  RealtimeTurnDetectionSettings
} from "../realtime/realtimeSession";

type TurnDetectionControlsProps = {
  settings: RealtimeTurnDetectionSettings;
  disabled?: boolean;
  onChange: (settings: RealtimeTurnDetectionSettings) => void;
};

const turnDetectionLabels: Record<RealtimeTurnDetectionMode, string> = {
  server_vad: "Normal",
  semantic_vad: "Semantic",
  disabled: "Disabled"
};

const turnDetectionDescriptions: Record<RealtimeTurnDetectionMode, string> = {
  server_vad:
    "Обычный VAD: завершает реплику после паузы в голосе. Это базовый режим для большинства тренировок.",
  semantic_vad:
    "Семантический VAD: старается дождаться смыслового завершения мысли, а не только тишины.",
  disabled:
    "Выключено: автоматическое разделение реплик не используется. Нужен только для диагностики."
};

const serverVadParameterDescriptions = {
  threshold:
    "Насколько уверенно система должна услышать голос, чтобы считать, что реплика началась.",
  prefixPaddingMs:
    "Сколько миллисекунд звука до начала речи оставить, чтобы не обрезать первые слова.",
  silenceDurationMs:
    "Сколько миллисекунд тишины ждать перед тем, как завершить текущую реплику."
};

const eagernessLabels: Record<RealtimeSemanticVadEagerness, string> = {
  auto: "Auto",
  low: "Low",
  medium: "Medium",
  high: "High"
};

const eagernessDescriptions: Record<RealtimeSemanticVadEagerness, string> = {
  auto: "API сам выбирает чувствительность к завершению мысли.",
  low: "Дольше ждёт продолжение фразы, меньше риск оборвать мысль слишком рано.",
  medium: "Средний баланс между ожиданием продолжения и быстрым завершением реплики.",
  high: "Быстрее закрывает реплику, когда смысл выглядит завершённым."
};

function updateNumber(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function formatTurnDetectionSettings(settings: RealtimeTurnDetectionSettings): string {
  if (settings.mode === "disabled") {
    return "VAD: disabled";
  }

  if (settings.mode === "semantic_vad") {
    return `VAD: semantic_vad / ${settings.semanticEagerness}`;
  }

  return `VAD: server_vad ${settings.threshold.toFixed(2)} / ${settings.prefixPaddingMs}ms / ${settings.silenceDurationMs}ms`;
}

export function TurnDetectionControls({
  settings,
  disabled = false,
  onChange
}: TurnDetectionControlsProps) {
  function setMode(mode: RealtimeTurnDetectionMode) {
    onChange({ ...settings, mode });
  }

  return (
    <section className="turn-detection-panel" aria-label="Automatic turn detection">
      <div className="turn-detection-header">
        <h2>Automatic turn detection</h2>
        <span className="status">{formatTurnDetectionSettings(settings)}</span>
      </div>
      <div className="mode-tabs turn-detection-tabs" aria-label="Turn detection mode">
        {(["server_vad", "semantic_vad", "disabled"] as const).map((mode) => (
          <button
            type="button"
            key={mode}
            className={settings.mode === mode ? "mode-tab mode-tab-active" : "mode-tab"}
            disabled={disabled}
            onClick={() => setMode(mode)}
          >
            {turnDetectionLabels[mode]}
          </button>
        ))}
      </div>
      <p className="turn-detection-mode-description">
        <strong>{turnDetectionLabels[settings.mode]}.</strong>{" "}
        {turnDetectionDescriptions[settings.mode]}
      </p>

      {settings.mode === "server_vad" ? (
        <div className="turn-detection-grid">
          <label className="turn-detection-field">
            <span>Threshold</span>
            <input
              aria-label="Threshold"
              type="number"
              inputMode="decimal"
              min="0"
              max="1"
              step="0.05"
              value={settings.threshold}
              disabled={disabled}
              onChange={(event) =>
                onChange({
                  ...settings,
                  threshold: updateNumber(event.target.value, settings.threshold)
                })
              }
            />
            <small>{serverVadParameterDescriptions.threshold}</small>
          </label>
          <label className="turn-detection-field">
            <span>Prefix padding</span>
            <input
              aria-label="Prefix padding"
              type="number"
              inputMode="numeric"
              min="0"
              step="50"
              value={settings.prefixPaddingMs}
              disabled={disabled}
              onChange={(event) =>
                onChange({
                  ...settings,
                  prefixPaddingMs: updateNumber(event.target.value, settings.prefixPaddingMs)
                })
              }
            />
            <small>{serverVadParameterDescriptions.prefixPaddingMs}</small>
          </label>
          <label className="turn-detection-field">
            <span>Silence duration</span>
            <input
              aria-label="Silence duration"
              type="number"
              inputMode="numeric"
              min="100"
              step="100"
              value={settings.silenceDurationMs}
              disabled={disabled}
              onChange={(event) =>
                onChange({
                  ...settings,
                  silenceDurationMs: updateNumber(event.target.value, settings.silenceDurationMs)
                })
              }
            />
            <small>{serverVadParameterDescriptions.silenceDurationMs}</small>
          </label>
        </div>
      ) : null}

      {settings.mode === "semantic_vad" ? (
        <label className="turn-detection-field turn-detection-select">
          <span>Eagerness</span>
          <select
            aria-label="Eagerness"
            value={settings.semanticEagerness}
            disabled={disabled}
            onChange={(event) =>
              onChange({
                ...settings,
                semanticEagerness: event.target.value as RealtimeSemanticVadEagerness
              })
            }
          >
            {(["auto", "low", "medium", "high"] as const).map((eagerness) => (
              <option key={eagerness} value={eagerness}>
                {eagernessLabels[eagerness]}
              </option>
            ))}
          </select>
          <small>{eagernessDescriptions[settings.semanticEagerness]}</small>
        </label>
      ) : null}
    </section>
  );
}
