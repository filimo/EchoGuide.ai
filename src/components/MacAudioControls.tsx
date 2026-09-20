import { useCallback, useEffect, useRef, useState } from "react";
import { listMacAudioSources } from "../macAudio/client";
import type { MacAudioSources } from "../macAudio/protocol";

import { loadMacAudioPreference, saveMacAudioPreference, type MacAudioPreference } from "../macAudio/preferences";

export type MacAudioSelection = { pid: number; microphone: string };

export function MacAudioControls({ disabled, selection, onChange }: {
  disabled: boolean; selection: MacAudioSelection | null; onChange: (value: MacAudioSelection | null) => void;
}) {
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
  return <section className="mac-audio-controls" aria-label="MacBook audio sources">
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
    {error && <p role="alert">{error}</p>}
  </section>;
}
