import { useEffect, useRef, useState } from "react";
import { listMacAudioSources } from "../macAudio/client";
import type { MacAudioSources } from "../macAudio/protocol";

export type MacAudioSelection = { pid: number; microphone: string };

export function MacAudioControls({ disabled, selection, onChange }: {
  disabled: boolean; selection: MacAudioSelection | null; onChange: (value: MacAudioSelection | null) => void;
}) {
  const [sources, setSources] = useState<MacAudioSources>({ applications: [], microphones: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  async function refresh() {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true); setError("");
    try {
      const result = await listMacAudioSources(controller.signal);
      if (controller.signal.aborted) return;
      setSources(result);
      if (selection && !result.applications.some(app => app.pid === selection.pid)) onChange(null);
    } catch (error) {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "Could not list sources.");
    } finally { if (!controller.signal.aborted) setLoading(false); }
  }
  return <section className="mac-audio-controls" aria-label="MacBook audio sources">
    <p>Два источника: микрофон — «Я», приложение звонка — «Собеседники». Используй наушники.</p>
    <div className="training-status-row">
      <button type="button" disabled={disabled || loading} onClick={() => void refresh()}>
        {loading ? "Loading Mac sources…" : "Refresh Mac sources"}
      </button>
      <label>Call application <select disabled={disabled || loading} value={selection?.pid ?? ""}
        onChange={event => onChange(event.target.value ? {
          pid: Number(event.target.value), microphone: selection?.microphone ?? "default"
        } : null)}>
        <option value="">Select an application</option>
        {sources.applications.map(app => <option key={app.pid} value={app.pid}>{app.name} ({app.pid})</option>)}
      </select></label>
      <label>Mac microphone <select disabled={disabled || !selection} value={selection?.microphone ?? "default"}
        onChange={event => { if (selection) onChange({ ...selection, microphone: event.target.value }); }}>
        <option value="default">System default microphone</option>
        {sources.microphones.map(mic => <option key={mic.id} value={mic.id}>{mic.name}</option>)}
      </select></label>
    </div>
    <small>Для Meet выбери браузер. Захватывается звук всего выбранного приложения, включая другие его вкладки.
      Первый запуск требует разрешений macOS. В прототипе пауза 1,2 с завершает реплику автоматически.</small>
    {error && <p role="alert">{error}</p>}
  </section>;
}
