import { useEffect, useState } from "react";
import { recordingPath } from "../recordings/client";
import { recordingHeaders, type Recording } from "../recordings/types";

export function SessionAudio({ sessionId, refresh = "" }: { sessionId: string; refresh?: string }) {
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch(recordingPath(sessionId), { headers: recordingHeaders, signal: controller.signal });
        if (!response.ok) throw new Error();
        const result = await response.json();
        if (!Array.isArray(result)) throw new Error();
        if (!cancelled) { setRecordings(result); setError(""); }
      } catch { if (!cancelled) setError("Не удалось загрузить аудиозаписи."); }
    }
    void load();
    const timer = window.setInterval(() => void load(), 2000);
    return () => { cancelled = true; controller.abort(); window.clearInterval(timer); };
  }, [sessionId, refresh, open]);
  return <details className="session-audio" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Аудиозаписи</summary>
    {error && <p role="alert">{error}</p>}
    {open && !error && recordings.length === 0 && <p className="hint">В этой сессии пока нет аудиозаписей.</p>}
    {open && recordings.map(record => <div key={record.id} className="session-audio-file">
      <span>{new Date(record.startedAt).toLocaleString("ru-RU", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })} · {Math.round(record.durationMs / 1000)} с · {record.status === "recording" ? "Записывается" : record.status === "saved" ? "Сохранено" : "Неполная запись"}</span>
      {record.status !== "recording" && record.bytes > 44 && <>
        <audio controls preload="none" aria-label="Запись сессии" src={`${recordingPath(sessionId)}/${record.id}/audio`} />
        {record.status === "saved" &&
          <a href={`${recordingPath(sessionId)}/${record.id}/mp3`}>Скачать MP3</a>}
      </>}
    </div>)}
  </details>;
}
