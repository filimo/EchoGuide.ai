import { useEffect, useRef, useState } from "react";
import type { SessionHistoryTranscriptTurn } from "../domain/sessionHistory";
import { isQuickStart, type QuickStart } from "../realtime/quickStart";
import { meetingRequest } from "../meeting/client";
import { meetingFallback, type MeetingAnswer, type MeetingPackState, type MeetingDocument } from "../meeting/types";

type Props = {
  turns: SessionHistoryTranscriptTurn[];
  quickStart: (text: string, context: string[], speaker: string, signal: AbortSignal) => Promise<QuickStart | null>;
};
const statuses = { uploading: "Загружается", indexing: "Индексируется", ready: "Готов", failed: "Ошибка" };
export function MeetingAssistant({ turns, quickStart }: Props) {
  const [state, setState] = useState<MeetingPackState>({ packs: [], activePackId: null });
  const [enabled, setEnabled] = useState(false);
  const [name, setName] = useState("");
  const [documents, setDocuments] = useState<MeetingDocument[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [opening, setOpening] = useState<QuickStart | null>(null);
  const [answer, setAnswer] = useState<MeetingAnswer | null>(null);
  const [question, setQuestion] = useState("");
  const [progress, setProgress] = useState("");
  const [retry, setRetry] = useState(0);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const mounted = useRef(true);
  const request = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const stateRevision = useRef(0);
  const fileRevision = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const quickRef = useRef(quickStart); quickRef.current = quickStart;
  const active = state.packs.find(p => p.id === state.activePackId && p.status === "ready");
  const recentTurns = turns.slice(-8);
  const dialogue = JSON.stringify(recentTurns.map(t => ({ id: t.id, text: t.text, speaker: t.speakerLabel })));

  useEffect(() => {
    mounted.current = true;
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    const controller = new AbortController();
    const poll = async () => {
      const revision = stateRevision.current;
      try {
        const next = await meetingRequest<MeetingPackState>("packs", undefined, controller.signal);
        if (!stopped && revision === stateRevision.current) {
          setState(next);
          setError(current => current.startsWith("Не удалось обновить список") ? "" : current);
        }
      } catch {
        if (!stopped) setError("Не удалось обновить список наборов. Повторная проверка выполняется автоматически.");
      }
      if (!stopped) timer = setTimeout(poll, 2500);
    };
    void poll();
    return () => { stopped = true; mounted.current = false; controller.abort(); clearTimeout(timer); request.current?.abort(); generation.current++; };
  }, []);

  function stop() {
    request.current?.abort(); generation.current++; setEnabled(false); setProgress("");
  }
  async function mutate(path: string, body: unknown) {
    stateRevision.current++; setBusy(true); setError("");
    try {
      const next = await meetingRequest<MeetingPackState>(path, body);
      if (mounted.current) { stateRevision.current++; setState(next); }
      return true;
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : "Не удалось выполнить запрос.");
      return false;
    } finally { if (mounted.current) setBusy(false); }
  }
  async function activate(packId: string | null) {
    stop(); setOpening(null); setAnswer(null); setQuestion("");
    await mutate("active", { packId });
  }

  useEffect(() => {
    request.current?.abort();
    const revision = ++generation.current;
    if (!enabled || !active) { setProgress(""); return; }
    const history = JSON.parse(dialogue) as { id: string; text: string; speaker: string }[];
    const last = history.at(-1);
    if (!last?.text.trim() || last.speaker === "Me") { setProgress(""); return; }
    const controller = new AbortController(); request.current = controller;
    const current = () => mounted.current && !controller.signal.aborted && generation.current === revision;
    const timer = setTimeout(() => {
      const transcript = last.text.slice(0, 4000);
      const context = history.slice(0, -1).map(t => `${t.speaker}: ${t.text.slice(0, 1800)}`);
      setQuestion(transcript); setOpening(null); setAnswer(null); setProgress("Готовлю начало и ищу основания…");
      const started = performance.now();
      const search = meetingRequest<{ ticket: string; found: number }>("search", { packId: active.id, transcript, recentContext: context }, controller.signal)
        .then(value => ({ value, error: false as const })).catch(() => ({ error: true as const }));
      const quickSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(4000)]);
      const first = quickRef.current(transcript, context, last.speaker, quickSignal).catch(() => null);
      void (async () => {
        const firstPiece = await first;
        if (!current()) return;
        if (firstPiece?.mode === "wait") { setProgress("Пока ответ не требуется."); return; }
        if (isQuickStart(firstPiece)) {
          setOpening(firstPiece);
          if (firstPiece.mode === "clarify") { setProgress("Уточни вопрос перед ответом."); return; }
        }
        setProgress("Ищу подтверждённые сведения…");
        const found = await search;
        if (!current()) return;
        if (found.error) { setAnswer({ ...meetingFallback }); setProgress("Поиск временно недоступен. Можно повторить."); return; }
        try {
          const result = await meetingRequest<MeetingAnswer>("answer", {
            packId: active.id, ticket: found.value.ticket,
            ...(isQuickStart(firstPiece) ? { opening: firstPiece } : {})
          }, controller.signal);
          if (!current()) return;
          setAnswer(result);
          setProgress(result.status === "grounded" ? `Готово · ${((performance.now() - started) / 1000).toFixed(1)} с` :
            result.status === "conflict" ? "В материалах есть расхождение — нужна проверка." : "В этом наборе недостаточно оснований для ответа.");
        } catch {
          if (current()) { setAnswer({ ...meetingFallback }); setProgress("Не удалось подготовить ответ. Можно повторить."); }
        }
      })();
    }, 700);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [enabled, active?.id, dialogue, retry]);

  return <div className="meeting-assistant">
    <h2>Помощник на встрече</h2>
    <details className="meeting-materials" open={!active}>
      <summary>Материалы встречи{active ? `: ${active.name}` : " — выбери или загрузи набор"}</summary>
      <p className="hint">MD-файлы загружаются в OpenAI. Поиск использует только выбранный набор.</p>
      <label>Название нового набора<input value={name} maxLength={120} onChange={e => setName(e.target.value)} placeholder="Следующий синк" /></label>
      <label>MD-файлы<input ref={fileInput} type="file" multiple accept=".md,text/markdown" disabled={busy} onChange={async e => {
        const revision = ++fileRevision.current;
        const files = Array.from(e.target.files ?? []); setDocuments([]); setError("");
        if (!files.length) return;
        if (files.length > 20 || files.some(f => !f.name.toLowerCase().endsWith(".md")) || files.reduce((n,f) => n+f.size,0) > 2*1024*1024) {
          setError("Выберите до 20 MD-файлов общим размером до 2 MB."); return;
        }
        try {
          const next = await Promise.all(files.map(async f => ({ name: f.name, text: await f.text() })));
          if (mounted.current && revision === fileRevision.current) setDocuments(next);
        } catch { if (mounted.current) setError("Не удалось прочитать файлы."); }
      }} /></label>
      {documents.length > 0 && <p>{documents.map(d => d.name).join(", ")}</p>}
      <button type="button" disabled={busy || !name.trim() || !documents.length || state.packs.some(p => p.status === "uploading")} onClick={async () => {
        if (await mutate("packs", { name, files: documents })) { setDocuments([]); setName(""); if (fileInput.current) fileInput.current.value = ""; }
      }}>Загрузить и индексировать</button>
      <ul className="meeting-packs">{state.packs.map(pack => <li key={pack.id}>
        <strong>{pack.name}</strong> · {statuses[pack.status]} · {new Date(pack.createdAt).toLocaleString("ru-RU")}
        <p>{pack.filenames.length} файлов · {pack.sectionCount} разделов{pack.id === state.activePackId ? " · Активный" : ""}</p>
        {pack.error && <p className="error-text">{pack.error}</p>}
        <button type="button" disabled={busy || pack.status !== "ready" || pack.id === state.activePackId} onClick={() => void activate(pack.id)}>Использовать этот набор</button>
        {pack.status !== "uploading" && pack.status !== "indexing" && <button type="button" disabled={busy} onClick={() => setDeleteId(pack.id)}>Удалить набор</button>}
        {deleteId === pack.id && <div><p>Удалить файлы этого набора из OpenAI и локальный индекс? Это нельзя отменить.</p>
          <button type="button" disabled={busy} onClick={async () => { stop(); if (await mutate("delete", { packId: pack.id })) { setDeleteId(null); setOpening(null); setAnswer(null); } }}>Подтвердить удаление</button>
          <button type="button" onClick={() => setDeleteId(null)}>Отмена</button></div>}
      </li>)}</ul>
      {active && <button type="button" disabled={busy} onClick={() => void activate(null)}>Убрать активный набор</button>}
    </details>
    {error && <p role="alert" className="error-text">{error}</p>}
    <label className="meeting-mode-toggle"><input type="checkbox" checked={enabled} disabled={!active || busy} onChange={e => {
      if (e.target.checked) { setEnabled(true); setError(""); } else stop();
    }} />Вопросы ко мне</label>
    <p className="hint">{enabled ? "Начало и поиск запускаются автоматически. Выключи, когда разговор перейдёт к другим." : "Включи, когда обращаются к тебе. Учтём и последний прозвучавший вопрос."}</p>
    {question && <p className="meeting-question">{question}</p>}
    <p role="status">{progress}</p>
    {opening && <section className="meeting-opening"><h3>{opening.mode === "clarify" ? "Уточни" : "Начни так"}</h3><p lang="en">{opening.english}</p><p lang="ru">{opening.russian}</p></section>}
    {answer && <section className="meeting-answer"><h3>{answer.status === "grounded" ? (opening ? "Продолжи" : "Ответ") : "Возьми время на проверку"}</h3>
      <p lang="en">{answer.english}</p><p lang="ru">{answer.russian}</p>
      {answer.sources.length > 0 && <details><summary>Основания ответа</summary>{answer.sources.map(source => <div key={source.id}>
        <strong>{source.filename} → {source.heading}</strong>
        <p>{Object.entries(source.metadata).filter(([key]) => !["source_hash", "pack_id"].includes(key)).map(([key,value]) => `${key}: ${value}`).join(" · ")}</p>
        <pre>{source.text}</pre>
      </div>)}</details>}
    </section>}
    {enabled && question && <button type="button" onClick={() => setRetry(n => n+1)}>Повторить поиск</button>}
  </div>;
}
