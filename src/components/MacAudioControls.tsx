import { useCallback, useEffect, useId, useRef, useState } from "react";
import { listMacAudioSources, macInputVolume, monitorMacMicrophone, type MacInputVolume } from "../macAudio/client";
import type { MacAudioSources } from "../macAudio/protocol";
import { levelMeter } from "../macAudio/levelMeter";

import { loadMacAudioPreference, saveMacAudioPreference, type MacAudioPreference } from "../macAudio/preferences";

export type MacAudioSelection = { pid: number; microphone: string };

export function MacAudioControls({ disabled, selection, onChange, onMicrophoneChange }: {
  disabled: boolean; selection: MacAudioSelection | null; onChange: (value: MacAudioSelection | null) => void;
  onMicrophoneChange?: (microphone: string) => void;
}) {
  const popoverId = useId();
  const [sources, setSources] = useState<MacAudioSources>({ applications: [], microphones: [] });
  const [loading, setLoading] = useState(false);
  const [sourcesRequested, setSourcesRequested] = useState(false);
  const [error, setError] = useState("");
  const [preference, setPreference] = useState(loadMacAudioPreference);
  const [inputVolume, setInputVolume] = useState<MacInputVolume | null>(null);
  const [volumeDraft, setVolumeDraft] = useState<number | null>(null);
  const [volumeSaving, setVolumeSaving] = useState(false);
  const [volumeRequested, setVolumeRequested] = useState(false);
  const [volumeError, setVolumeError] = useState("");
  const [monitorState, setMonitorState] = useState<"idle" | "starting" | "active">("idle");
  const [monitorLevel, setMonitorLevel] = useState<{ level: number; peak: number } | null>(null);
  const [monitorError, setMonitorError] = useState("");
  const monitorRef = useRef<{ stop: () => void } | null>(null);
  const preferenceRef = useRef(preference);
  function remember(value: MacAudioPreference) {
    preferenceRef.current = value;
    setPreference(value);
    saveMacAudioPreference(value);
  }
  const request = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setSourcesRequested(true);
    setLoading(true); setError("");
    onChange(null);
    try {
      const result = await listMacAudioSources(controller.signal);
      if (controller.signal.aborted) return;
      setSources(result);
      const saved = preferenceRef.current;
      const matches = saved.application ? result.applications.filter(app => app.bundleId === saved.application!.bundleId) : [];
      const microphoneAvailable = saved.microphone === "default" || result.microphones.some(mic => mic.id === saved.microphone);
      if (matches.length === 1 && microphoneAvailable) onChange({ pid: matches[0].pid, microphone: saved.microphone });
      if (saved.application && matches.length === 0) setError(`${saved.application.name} is not running or unavailable. Open it, then refresh sources.`);
      else if (matches.length > 1) setError("Multiple instances of the saved application are running. Select one explicitly.");
      else if (!microphoneAvailable) setError("The saved microphone is unavailable. Reconnect it and refresh, or choose another microphone.");
    } catch (error) {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "Could not list sources.");
    } finally { if (!controller.signal.aborted) setLoading(false); }
  }, [onChange]);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => () => monitorRef.current?.stop(), []);
  useEffect(() => {
    if (disabled && monitorRef.current) {
      monitorRef.current.stop();
      monitorRef.current = null;
      setMonitorState("idle");
      setMonitorLevel(null);
    }
  }, [disabled]);
  useEffect(() => {
    if (!volumeRequested || loading) return;
    const controller = new AbortController();
    setInputVolume(null); setVolumeDraft(null); setVolumeError("");
    void macInputVolume(preference.microphone, undefined, controller.signal)
      .then(result => { if (!controller.signal.aborted) { setInputVolume(result); setVolumeDraft(result.value ?? null); } })
      .catch(error => { if (!controller.signal.aborted) setVolumeError(error instanceof Error ? error.message : "Could not read input volume."); });
    return () => controller.abort();
  }, [preference.microphone, volumeRequested, loading]);
  async function applyInputVolume() {
    if (!inputVolume?.available || volumeDraft == null || volumeDraft === inputVolume.value || volumeSaving) return;
    setVolumeSaving(true); setVolumeError("");
    try {
      const result = await macInputVolume(preference.microphone, volumeDraft);
      setInputVolume(result);
      setVolumeDraft(result.value ?? null);
    } catch (error) {
      setVolumeError(error instanceof Error ? error.message : "Could not change input volume.");
    } finally { setVolumeSaving(false); }
  }
  function stopMonitor() {
    monitorRef.current?.stop();
    monitorRef.current = null;
    setMonitorState("idle");
    setMonitorLevel(null);
  }
  function startMonitor() {
    setMonitorError("");
    setMonitorLevel(null);
    setMonitorState("starting");
    monitorRef.current = monitorMacMicrophone(preference.microphone,
      event => {
        if (event.type === "ready") setMonitorState("active");
        if (event.type === "level") { setMonitorState("active"); setMonitorLevel(event); }
      },
      message => { stopMonitor(); setMonitorError(message); }
    );
  }
  const applicationName = sources.applications.find(app => app.pid === selection?.pid)?.name;
  const microphoneName = preference.microphone === "default" ? "System microphone" :
    sources.microphones.find(mic => mic.id === preference.microphone)?.name ?? "Microphone unavailable";
  const microphoneAvailable = preference.microphone === "default" || sources.microphones.some(mic => mic.id === preference.microphone);
  const preview = levelMeter(monitorLevel?.level ?? 0, monitorLevel?.peak ?? 0);
  const previewZone = { silent: "тишина", quiet: "тихо", good: "рабочий уровень",
    loud: "громко", clipping: "перегруз" }[preview.zone];
  return <section className="mac-audio-controls" aria-label="MacBook audio sources">
    <button type="button" className="mac-sources-trigger" popoverTarget={popoverId}
      disabled={disabled} onClick={() => { if (!sourcesRequested) void refresh(); }}
      title={selection ? `Источники звука: ${applicationName} и ${microphoneName}. Нажми, чтобы изменить.` :
        "Выбери приложение звонка и микрофон для EchoGuide"}>
      <span aria-hidden="true">⚙</span> {loading ? "Loading sources…" : selection ? `${applicationName} + ${microphoneName}` : "Настроить источники"}
    </button>
    {error && <span className="mac-source-error" role="alert">{error}</span>}
    <div id={popoverId} popover="auto" className="mac-sources-popover"
      onToggle={event => { if ((event.nativeEvent as ToggleEvent).newState === "closed") stopMonitor(); }}>
      <header><h2>Источники звука</h2><button type="button" popoverTarget={popoverId} popoverTargetAction="hide"
        onClick={stopMonitor} aria-label="Закрыть настройки звука">×</button></header>
    <p>Два источника: микрофон — «Я», приложение звонка — «Собеседники». Используй наушники.</p>
    <div className="training-status-row">
      <button type="button" disabled={disabled || loading} onClick={() => void refresh()}>
        {loading ? "Loading Mac sources…" : "Refresh Mac sources"}
      </button>
      <label>Call application <select title="Звук выбранного приложения будет поступать в EchoGuide во время встречи"
        disabled={disabled || loading} value={selection?.pid ?? ""}
        onChange={event => {
          const app = sources.applications.find(app => app.pid === Number(event.target.value));
          remember({ ...preference, application: app?.bundleId ? { bundleId: app.bundleId, name: app.name } : null });
          const available = preference.microphone === "default" || sources.microphones.some(mic => mic.id === preference.microphone);
          onChange(app && available ? { pid: app.pid, microphone: preference.microphone } : null);
          setError(app && !available ? "The saved microphone is unavailable. Choose another microphone." : "");
        }}>
        <option value="">Select an application</option>
        {sources.applications.map(app => <option key={app.pid} value={app.pid}>{app.name} ({app.pid})</option>)}
      </select></label>
      <label>Mac microphone <select title="Микрофон для EchoGuide"
        disabled={disabled || loading || monitorState !== "idle"} value={preference.microphone}
        onChange={event => {
          remember({ ...preference, microphone: event.target.value });
          onMicrophoneChange?.(event.target.value);
          const matches = sources.applications.filter(app => app.bundleId === preference.application?.bundleId);
          const pid = selection?.pid ?? (matches.length === 1 ? matches[0].pid : null);
          onChange(pid == null ? null : { pid, microphone: event.target.value });
          if (pid != null) setError("");
        }}>
        {preference.microphone !== "default" && !sources.microphones.some(mic => mic.id === preference.microphone) &&
          <option value={preference.microphone}>Saved microphone (unavailable)</option>}
        <option value="default">System default microphone</option>
        {sources.microphones.map(mic => <option key={mic.id} value={mic.id}>{mic.name}</option>)}
      </select></label>
      <small>Используется системный микрофон. Выбери UGREEN в Системных настройках → Звук → Вход; для раздельных сторон не выбирай смешанный вход Loopback.</small>
      <div className="mac-input-volume">
        <button type="button" disabled={disabled || loading} onClick={() => setVolumeRequested(true)}>Показать системный уровень входа</button>
        <label htmlFor={`${popoverId}-input-volume`}>Чувствительность микрофона · системный уровень входа</label>
        <button type="button" className="mac-monitor-button" disabled={disabled || loading || !microphoneAvailable}
          onClick={monitorState === "idle" ? startMonitor : stopMonitor}>
          {monitorState === "idle" ? "Проверить микрофон" : "Остановить проверку"}
        </button>
        <small>Во время проверки показывается только уровень звука. Аудио не записывается и не отправляется в OpenAI.</small>
        {monitorState !== "idle" && <div className="mac-monitor-level">
          <span className="mac-monitor-prompt">{monitorState === "starting" ? "Включаем микрофон…" : "Говорите в микрофон"}</span>
          <span className="mac-level-track" role="meter" aria-label="Уровень проверяемого микрофона"
            aria-valuemin={-60} aria-valuemax={0} aria-valuenow={Math.round(preview.dbfs)}
            aria-valuetext={monitorLevel ? `${Math.round(preview.dbfs)} dBFS, ${previewZone}; пик ${Math.round(preview.peakDbfs)} dBFS` : "ожидание звука"}>
            <span className="mac-level-fill" style={{ width: `${preview.percent}%` }} />
          </span>
          <span className={`mac-level-reading mac-level-${preview.zone}`}>
            {monitorLevel ? `${Math.round(preview.dbfs)} dB · ${previewZone}` : "—"}
          </span>
        </div>}
        {monitorError && <span className="mac-source-error" role="alert">{monitorError}</span>}
        {inputVolume?.available && volumeDraft != null ? <div className="mac-input-volume-control">
          <input id={`${popoverId}-input-volume`} type="range" min={0} max={100} step={1}
            value={volumeDraft} disabled={volumeSaving} onChange={event => setVolumeDraft(Number(event.target.value))}
            onPointerUp={() => void applyInputVolume()} onKeyUp={() => void applyInputVolume()}
            onBlur={() => void applyInputVolume()} />
          <output>{volumeDraft}%</output>
        </div> : <small>{volumeError ? "Не удалось прочитать системный уровень входа." : inputVolume === null ?
          volumeRequested ? "Проверяем настройку устройства…" : "Уровень входа читается только по кнопке выше." :
          "У этого микрофона нет доступного системного регулятора. Проверь Системные настройки → Звук → Вход или настройку на самом устройстве."}</small>}
        <small>Меняет уровень входа выбранного устройства в macOS, в том числе для других приложений. EchoGuide не усиливает запись отдельно.</small>
        {inputVolume?.available && inputVolume.value === 100 &&
          <small>Уровень входа уже максимальный. Если голос всё ещё тихий, проверь положение микрофона или сравни с другим устройством.</small>}
        {volumeError && <span className="mac-source-error" role="alert">{volumeError}</span>}
      </div>
    </div>
    <small>Для Meet выбери браузер. Захватывается звук всего выбранного приложения, включая другие его вкладки.
      Первый запуск требует разрешений macOS. В прототипе пауза 1,2 с завершает реплику автоматически.</small>
    </div>
  </section>;
}
