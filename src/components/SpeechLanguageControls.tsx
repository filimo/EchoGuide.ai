import type { RealtimeSpeechLanguage } from "../realtime/realtimeSession";

type SpeechLanguageControlsProps = {
  speechLanguage: RealtimeSpeechLanguage;
  disabled?: boolean;
  onChange: (speechLanguage: RealtimeSpeechLanguage) => void;
};

const speechLanguageLabels: Record<RealtimeSpeechLanguage, string> = {
  english: "English",
  russian: "Russian",
  "english-russian": "English + Russian"
};

const speechLanguageDescriptions: Record<RealtimeSpeechLanguage, string> = {
  english: "Фиксирует transcription как английскую речь, когда модель ошибочно слышит русский.",
  russian: "Фиксирует transcription как русскую речь для русских пояснений или черновиков.",
  "english-russian":
    "Оставляет текущий bilingual режим: модель принимает английскую и русскую речь без жёсткой фиксации."
};

export function formatSpeechLanguage(speechLanguage: RealtimeSpeechLanguage): string {
  return `Speech: ${speechLanguageLabels[speechLanguage]}`;
}

export function SpeechLanguageControls({
  speechLanguage,
  disabled = false,
  onChange
}: SpeechLanguageControlsProps) {
  return (
    <section className="speech-language-panel" aria-label="Speech language">
      <div className="speech-language-header">
        <h2>Speech language</h2>
        <span className="status">{formatSpeechLanguage(speechLanguage)}</span>
      </div>
      <div className="mode-tabs speech-language-tabs" aria-label="Speech language mode">
        {(["english", "russian", "english-russian"] as const).map((language) => (
          <button
            type="button"
            key={language}
            className={speechLanguage === language ? "mode-tab mode-tab-active" : "mode-tab"}
            disabled={disabled}
            onClick={() => onChange(language)}
          >
            {speechLanguageLabels[language]}
          </button>
        ))}
      </div>
      <p className="speech-language-description">
        <strong>{speechLanguageLabels[speechLanguage]}.</strong>{" "}
        {speechLanguageDescriptions[speechLanguage]}
      </p>
    </section>
  );
}
