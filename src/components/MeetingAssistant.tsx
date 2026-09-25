import { RotateCw } from "lucide-react";
import { prepareGenerationInput } from "../realtime/generationInput";
import { useEffect, useRef, useState } from "react";
import { isQuickStart, type QuickStart } from "../realtime/quickStart";
import { meetingHistoryClient } from "../meeting/historyClient";
import { latestMeetingCard, meetingCardKey, type MeetingCardSnapshot } from "../meeting/history";
import { meetingRequest } from "../meeting/client";
import { meetingFallbackFor, type MeetingAnswer, type MeetingAnswerReason, type MeetingPackState, type MeetingDocument } from "../meeting/types";

export type MeetingSelection = { id: string; text: string; speaker: string; context: string[]; summary?: string };
type Props = {
  sessionId: string;
  selection: MeetingSelection | null;
  russianMeaning?: string;
  conversationContextWarning?: boolean;
  quickStart: (text: string, context: string[], speaker: string, signal: AbortSignal) => Promise<QuickStart | null>;
};
const statuses = { uploading: "Загружается", indexing: "Индексируется", ready: "Готов", failed: "Ошибка" };
const diagnosticReasons: Record<MeetingAnswerReason, string> = {
  grounded: "Ответ подтверждён материалами", no_hits: "Поиск не нашёл подходящих разделов",
  model_no_answer: "Модель не нашла достаточных оснований в найденных разделах",
  conflict: "В найденных разделах есть противоречие", invalid_answer: "Ответ не прошёл проверку формата или источников",
  search_error: "Запрос поиска завершился ошибкой", answer_error: "Подготовка полного ответа завершилась ошибкой"
};
export function MeetingAssistant({ sessionId, selection, russianMeaning = "", conversationContextWarning = false, quickStart }: Props) {
  const [state, setState] = useState<MeetingPackState>({ packs: [], activePackId: null });
  const [name, setName] = useState("");
  const [documents, setDocuments] = useState<MeetingDocument[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [opening, setOpening] = useState<QuickStart | null>(null);
  const [answer, setAnswer] = useState<MeetingAnswer | null>(null);
  const [timings, setTimings] = useState<{ openingMs?: number; answerMs?: number }>({});
  const [question, setQuestion] = useState("");
  const [progress, setProgress] = useState("");
  const [historyError, setHistoryError] = useState("");
  const [historyLoading, setHistoryLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [requestVersion, setRequestVersion] = useState(0);
  const regenerate = useRef<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const mounted = useRef(true);
  const request = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const stateRevision = useRef(0);
  const fileRevision = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const quickRef = useRef(quickStart); quickRef.current = quickStart;
  const active = state.packs.find(p => p.id === state.activePackId && p.status === "ready");
  const selected = JSON.stringify(selection);

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
    request.current?.abort(); generation.current++; setProgress("");
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
    stop(); setOpening(null); setAnswer(null); setTimings({}); setQuestion("");
    await mutate("active", { packId });
  }

  useEffect(() => {
    request.current?.abort();
    const revision = ++generation.current;
    setOpening(null); setAnswer(null); setTimings({}); setQuestion(""); setProgress("");
    setGenerating(false); setHistoryLoading(false);
    if (!active || !selection) return;
    const last = JSON.parse(selected) as MeetingSelection;
    const identity = { sessionId, phraseId: last.id, text: last.text.slice(0, 4000), speaker: last.speaker, context: last.context, summary: last.summary, packId: active.id };
    const key = meetingCardKey(identity);
    const force = regenerate.current === key; regenerate.current = null;
    const controller = new AbortController(); request.current = controller;
    const current = () => mounted.current && !controller.signal.aborted && generation.current === revision;
    setQuestion(identity.text); setHistoryLoading(true); setProgress("Проверяю сохранённый ответ…");
    void (async () => {
      let records: MeetingCardSnapshot[];
      try { records = await meetingHistoryClient.load(sessionId); }
      catch {
        if (current()) { setHistoryLoading(false); setHistoryError("Не удалось прочитать историю. Повтори загрузку; новый ответ не генерировался."); setProgress(""); }
        return;
      }
      if (!current()) return;
      setHistoryLoading(false);
      if (!meetingHistoryClient.hasPending()) setHistoryError("");
      const matching = records.filter(r => meetingCardKey(r.identity) === key);
      const cached = latestMeetingCard(matching);
      if (cached && !force) {
        setOpening(cached.opening); setAnswer(cached.answer); setTimings(cached.timings);
        setQuestion(cached.generationInput?.transcript ?? identity.text);
        setProgress(cached.phase === "complete" || cached.phase === "error" ? `Сохранённый ответ · ${new Date(cached.savedAt).toLocaleString("ru-RU")}${cached.generationInput ? "" : " · До фильтрации входа; для обновления нажми «Новый вариант»."}` : "Сохранено начало или незавершённая попытка. Для нового ответа нажми «Новый вариант».");
        return;
      }
      const generationInput = prepareGenerationInput(identity.text, identity.context);
      if (!generationInput.transcript) {
        setProgress("Это служебный текст распознавания. Выбери реплику разговора.");
        return;
      }
      setQuestion(generationInput.transcript);
      setGenerating(true);
      const started = performance.now();
      let snapshot: MeetingCardSnapshot = { version: 1, identity, attemptId: crypto.randomUUID(), sequence: 0,
        generationInput, savedAt: new Date().toISOString(), packName: active.name, packCreatedAt: active.createdAt,
        opening: null, answer: null, phase: "started", progress: "Готовлю начало и ищу основания…", timings: {} };
      function publish(changes: Partial<MeetingCardSnapshot>) {
        if (!current()) return;
        snapshot = { ...snapshot, ...changes, sequence: snapshot.sequence + 1, savedAt: new Date().toISOString() };
        setOpening(snapshot.opening); setAnswer(snapshot.answer); setTimings(snapshot.timings); setProgress(snapshot.progress);
        // Do not abort this write on selection change: this is text already delivered to the screen.
        void meetingHistoryClient.save(snapshot).catch(() => {
          if (mounted.current) setHistoryError("Карточка показана, но не сохранена на диск. Нажми «Повторить сохранение» до закрытия страницы.");
        });
      }
      publish({});
      const search = meetingRequest<{ ticket: string; found: number }>("search", { packId: active.id, transcript: generationInput.transcript,
        recentContext: generationInput.recentContext, ...(last.summary ? { summary: last.summary } : {}) }, controller.signal)
        .then(value => ({ value, error: false as const })).catch(() => ({ error: true as const }));
      const firstPiece = await quickRef.current(generationInput.transcript, generationInput.recentContext, last.speaker,
        AbortSignal.any([controller.signal, AbortSignal.timeout(4000)])).catch(() => null);
      if (!current()) return;
      if (isQuickStart(firstPiece) && firstPiece.mode !== "wait") {
        publish({ opening: firstPiece, phase: "opening", timings: { openingMs: performance.now() - started }, progress: "Ищу подтверждённые сведения…" });
      }
      const found = await search;
      if (!current()) return;
      if (found.error) {
        publish({ answer: meetingFallbackFor("search_error"), phase: "error", progress: "Поиск временно недоступен. Можно запросить новый вариант." }); setGenerating(false); return;
      }
      try {
        const result = await meetingRequest<MeetingAnswer>("answer", { packId: active.id, ticket: found.value.ticket,
          ...(isQuickStart(firstPiece) && ["start", "continue"].includes(firstPiece.mode) ? { opening: firstPiece } : {}) }, controller.signal);
        if (!current()) return;
        publish({ opening: firstPiece?.mode === "clarify" ? null : snapshot.opening, answer: result, phase: "complete",
          timings: { ...snapshot.timings, answerMs: performance.now() - started },
          progress: result.status === "grounded" ? "Готово" : result.status === "conflict" ? "В материалах есть расхождение — нужна проверка." : "В этом наборе недостаточно оснований для ответа." });
      } catch {
        publish({ answer: meetingFallbackFor("answer_error", found.value.found), phase: "error", progress: "Не удалось подготовить ответ. Можно запросить новый вариант." });
      }
      if (current()) setGenerating(false);
    })();
    return () => controller.abort();
  }, [active?.id, sessionId, selected, requestVersion]);

  return <div className="meeting-assistant">
    <div className="meeting-card-header"><h2>Помощник на встрече</h2>
    {active && selection && <button className="meeting-regenerate" aria-label="Новый вариант" title="Новый вариант" type="button" disabled={historyLoading || generating || !!historyError} onClick={() => {
      regenerate.current = meetingCardKey({ sessionId, phraseId: selection.id, text: selection.text.slice(0,4000), speaker: selection.speaker, context: selection.context, summary: selection.summary, packId: active.id });
      setRequestVersion(v => v + 1);
    }}><RotateCw size={17} aria-hidden="true" /></button>}
    </div>
    {conversationContextWarning && <p role="alert">Не удалось обновить резюме разговора. В длинной встрече часть раннего контекста может быть недоступна.</p>}
    {historyError && <div role="alert"><p>{historyError}</p>
      <button type="button" onClick={async () => { try { await meetingHistoryClient.retry(); setHistoryError(""); setRequestVersion(v => v + 1); } catch { setHistoryError("Не удалось сохранить историю. Не закрывай страницу и повтори попытку."); } }}>Повторить сохранение / загрузку</button>
    </div>}

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
          <button type="button" disabled={busy} onClick={async () => { stop(); if (await mutate("delete", { packId: pack.id })) { setDeleteId(null); setOpening(null); setAnswer(null); setTimings({}); } }}>Подтвердить удаление</button>
          <button type="button" onClick={() => setDeleteId(null)}>Отмена</button></div>}
      </li>)}</ul>
      {active && <button type="button" disabled={busy} onClick={() => void activate(null)}>Убрать активный набор</button>}
    </details>
    {error && <p role="alert" className="error-text">{error}</p>}
    {!question && <p className="hint">Выбери реплику в разговоре, чтобы подготовить ответ.</p>}
    {question && <div className="meeting-question">
      <p lang="ru">{russianMeaning.trim() || "Готовим русский смысл…"}</p>
      <details>
        <summary>English original</summary>
        <p lang="en">{question}</p>
      </details>
    </div>}
    <div className="meeting-answer-meta">
    {progress && progress !== "Готово" && <p role="status">{progress}</p>}
    {(timings.openingMs !== undefined || timings.answerMs !== undefined) && <p className="hint" aria-label="Время подготовки ответа" title="От запуска запросов: полный ответ включает поиск по материалам и подготовку текста.">
      {timings.openingMs !== undefined && <span>Начало: {(timings.openingMs / 1000).toFixed(1)} с</span>}
      {timings.openingMs !== undefined && timings.answerMs !== undefined && " · "}
      {timings.answerMs !== undefined && <span>Поиск и полный ответ: {(timings.answerMs / 1000).toFixed(1)} с</span>}
    </p>}
    </div>
    {opening && <section className="meeting-opening"><h3>{opening.mode === "clarify" ? "Уточни" : "Начни так"}</h3><p lang="en">{opening.english}</p><p lang="ru">{opening.russian}</p></section>}
    {answer && <section className="meeting-answer"><h3>{answer.status === "grounded" ? (opening ? "Продолжи" : "Ответ") : "Возьми время на проверку"}</h3>
      <p lang="en">{answer.english}</p><p lang="ru">{answer.russian}</p>
      {answer.status !== "grounded" && <details><summary>Диагностика ответа</summary><p>{answer.diagnostics
        ? `${diagnosticReasons[answer.diagnostics.reason]} (${answer.diagnostics.reason}) · Найдено разделов: ${answer.diagnostics.found ?? "неизвестно"}`
        : "Причина не сохранена в этой старой карточке. Для новой проверки нажми «Новый вариант»."}</p></details>}
      {answer.sources.length > 0 && <details><summary>Основания ответа</summary>{answer.sources.map(source => <div key={source.id}>
        <strong>{source.filename} → {source.heading}</strong>
        <p>{Object.entries(source.metadata).filter(([key]) => !["source_hash", "pack_id"].includes(key)).map(([key,value]) => `${key}: ${value}`).join(" · ")}</p>
        <pre>{source.text}</pre>
      </div>)}</details>}
    </section>}
  </div>;
}
