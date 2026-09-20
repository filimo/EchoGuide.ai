import { useCallback, useEffect, useId, useRef, useState } from "react";
import { listMacAudioSources } from "../macAudio/client";
import type { MacAudioSources } from "../macAudio/protocol";

import { loadMacAudioPreference, saveMacAudioPreference, type MacAudioPreference } from "../macAudio/preferences";

export type MacAudioSelection = { pid: number; microphone: string };

export function MacAudioControls({ disabled, selection, onChange }: {
  disabled: boolean; selection: MacAudioSelection | null; onChange: (value: MacAudioSelection | null) => void;
}) {
  const popoverId = useId();
  const [sources, setSources] = useState<MacAudioSources>({ applications: [], microphones: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [preference, setPreference] = useState(loadMacAudioPreference);
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
  useEffect(() => { void refresh(); return () => request.current?.abort(); }, [refresh]);
  const applicationName = sources.applications.find(app => app.pid === selection?.pid)?.name;
  const microphoneName = preference.microphone === "default" ? "System microphone" :
    sources.microphones.find(mic => mic.id === preference.microphone)?.name ?? "Microphone unavailable";
  return <section className="mac-audio-controls" aria-label="MacBook audio sources">
    <button type="button" className="mac-sources-trigger" popoverTarget={popoverId}
      title={selection ? `${applicationName} + ${microphoneName}` : "Choose microphone and call application"}>
      <span aria-hidden="true">⚙</span> {loading ? "Loading sources…" : selection ? `${applicationName} + ${microphoneName}` : "Настроить источники"}
    </button>
    {error && <span className="mac-source-error" role="alert">{error}</span>}
    <div id={popoverId} popover="auto" className="mac-sources-popover">
      <header><h2>Источники звука</h2><button type="button" popoverTarget={popoverId} popoverTargetAction="hide" aria-label="Закрыть настройки звука">×</button></header>
    <p>Два источника: микрофон — «Я», приложение звонка — «Собеседники». Используй наушники.</p>
    <div className="training-status-row">
      <button type="button" disabled={disabled || loading} onClick={() => void refresh()}>
        {loading ? "Loading Mac sources…" : "Refresh Mac sources"}
      </button>
      <label>Call application <select disabled={disabled || loading} value={selection?.pid ?? ""}
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
      <label>Mac microphone <select disabled={disabled || loading} value={preference.microphone}
        onChange={event => {
          remember({ ...preference, microphone: event.target.value });
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
    </div>
    <small>Для Meet выбери браузер. Захватывается звук всего выбранного приложения, включая другие его вкладки.
      Первый запуск требует разрешений macOS. В прототипе пауза 1,2 с завершает реплику автоматически.</small>
    </div>
  </section>;
}
