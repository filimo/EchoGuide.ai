import { Copy, HelpCircle, RotateCw, Send } from "lucide-react";
import { BilingualSentences } from "./BilingualSentences";
import { prepareGenerationInput } from "../realtime/generationInput";
import { useEffect, useRef, useState } from "react";
import { isQuickStart, type QuickStart } from "../realtime/quickStart";
import { meetingHistoryClient } from "../meeting/historyClient";
import { latestMeetingCard, meetingCardKey, type MeetingCardSnapshot } from "../meeting/history";
import { meetingRequest } from "../meeting/client";
import { meetingFallbackFor, type MeetingAnswer, type MeetingAnswerReason, type MeetingPackState, type MeetingDocument } from "../meeting/types";
import { isMeetingGeneralAnswer, type MeetingGeneralAnswer } from "../meeting/generalAnswer";

export type MeetingSelection = { id: string; text: string; speaker: string; context: string[]; summary?: string };
function CardInfo({ label, children }: { label: string; children: React.ReactNode }) {
  return <details className="meeting-info"><summary aria-label={label} title={label}><HelpCircle size={16} aria-hidden="true" /></summary><div className="meeting-info-content">{children}</div></details>;
}
type Props = {
  sessionId: string;
  selection: MeetingSelection | null;
  russianMeaning?: string;
  conversationContextWarning?: boolean;
  generalAnswer?: (text: string, context: string[], speaker: string, signal: AbortSignal) => Promise<MeetingGeneralAnswer | QuickStart | null>;
};
const statuses = { uploading: "Загружается", indexing: "Индексируется", ready: "Готов", failed: "Ошибка" };
const diagnosticReasons: Record<MeetingAnswerReason, string> = {
  grounded: "Ответ подтверждён материалами", no_hits: "Поиск не нашёл подходящих разделов",
  model_no_answer: "Модель не нашла достаточных оснований в найденных разделах",
  conflict: "В найденных разделах есть противоречие", invalid_answer: "Ответ не прошёл проверку формата или источников",
  search_error: "Запрос поиска завершился ошибкой", answer_error: "Подготовка полного ответа завершилась ошибкой"
};
export function MeetingAssistant({ sessionId, selection, russianMeaning = "", conversationContextWarning = false, generalAnswer }: Props) {
  const [state, setState] = useState<MeetingPackState>({ packs: [], activePackId: null });
  const [name, setName] = useState("");
  const [documents, setDocuments] = useState<MeetingDocument[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [opening, setOpening] = useState<QuickStart | null>(null);
  const [answer, setAnswer] = useState<MeetingAnswer | null>(null);
  const [general, setGeneral] = useState<MeetingGeneralAnswer | null>(null);
  const [timings, setTimings] = useState<{ openingMs?: number; answerMs?: number }>({});
  const [question, setQuestion] = useState("");
  const [progress, setProgress] = useState("");
  const [historyError, setHistoryError] = useState("");
  const [historyLoading, setHistoryLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [requestVersion, setRequestVersion] = useState(0);
  const [answerHint, setAnswerHint] = useState("");
  const submittedHint = useRef("");
  const [copyStatus, setCopyStatus] = useState("");
  const regenerate = useRef<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const mounted = useRef(true);
  const request = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const stateRevision = useRef(0);
  const fileRevision = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const generalRef = useRef(generalAnswer); generalRef.current = generalAnswer;
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
  function regenerateCard() {
    if (!active || !selection) return;
    submittedHint.current = answerHint.trim();
    regenerate.current = meetingCardKey({ sessionId, phraseId: selection.id, text: selection.text.slice(0,4000), speaker: selection.speaker, context: selection.context, summary: selection.summary, packId: active.id });
    setRequestVersion(v => v + 1);
  }
  async function copyReply(full = false, material = false) {
    const text = material ? answer?.english ?? "" : full ? [general?.opening.english, general?.continuation?.english].filter(Boolean).join(" ") : opening?.english ?? "";
    try { await navigator.clipboard.writeText(text); setCopyStatus("Скопировано"); }
    catch { setCopyStatus("Не удалось скопировать ответ"); }
  }

  useEffect(() => {
    request.current?.abort();
    const revision = ++generation.current;
    setOpening(null); setAnswer(null); setGeneral(null); setTimings({}); setQuestion(""); setProgress("");
    setCopyStatus("");
    setGenerating(false); setHistoryLoading(false);
    if (!active || !selection) return;
    const last = JSON.parse(selected) as MeetingSelection;
    const identity = { sessionId, phraseId: last.id, text: last.text.slice(0, 4000), speaker: last.speaker, context: last.context, summary: last.summary, packId: active.id };
    const key = meetingCardKey(identity);
    const force = regenerate.current === key; regenerate.current = null;
    const hint = force ? submittedHint.current : "";
    if (!force) { submittedHint.current = ""; setAnswerHint(""); }
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
        setOpening(cached.opening); setAnswer(cached.answer); setGeneral(cached.general ?? null); setTimings(cached.timings);
        setQuestion(cached.generationInput?.transcript ?? identity.text);
        setAnswerHint(cached.answerHint ?? ""); submittedHint.current = cached.answerHint ?? "";
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
        opening: null, answer: null, general: null, ...(hint ? { answerHint: hint } : {}), phase: "started", progress: "Готовлю варианты и ищу основания…", timings: {} };
      function publish(changes: Partial<MeetingCardSnapshot>) {
        if (!current()) return;
        snapshot = { ...snapshot, ...changes, sequence: snapshot.sequence + 1, savedAt: new Date().toISOString() };
        setOpening(snapshot.opening); setAnswer(snapshot.answer); setGeneral(snapshot.general ?? null); setTimings(snapshot.timings); setProgress(snapshot.progress);
        // Do not abort this write on selection change: this is text already delivered to the screen.
        void meetingHistoryClient.save(snapshot).catch(() => {
          if (mounted.current) setHistoryError("Карточка показана, но не сохранена на диск. Нажми «Повторить сохранение» до закрытия страницы.");
        });
      }
      publish({});
      const search = meetingRequest<{ ticket: string; found: number }>("search", { packId: active.id, transcript: generationInput.transcript,
        recentContext: generationInput.recentContext, ...(last.summary ? { summary: last.summary } : {}) }, controller.signal)
        .then(value => ({ value, error: false as const })).catch(() => ({ error: true as const }));
      const body = { transcript: generationInput.transcript, recentContext: generationInput.recentContext,
        speakerLabel: last.speaker, ...(hint ? { answerHint: hint } : {}) };
      const injected = generalRef.current && !hint ? generalRef.current(generationInput.transcript,
        generationInput.recentContext, last.speaker, AbortSignal.any([controller.signal, AbortSignal.timeout(6500)])).catch(() => null) : null;
      const fast = (injected ?? meetingRequest<QuickStart>("opening", body,
        AbortSignal.any([controller.signal, AbortSignal.timeout(4000)])).catch(() => null)).then(value => {
        const first = isMeetingGeneralAnswer(value) ? value.opening : isQuickStart(value) ? value : null;
        if (current() && first && first.mode !== "wait") publish({ opening: first, phase: "opening",
          timings: { ...snapshot.timings, openingMs: performance.now() - started } });
        return first;
      });
      const generalTask = (injected ?? meetingRequest<MeetingGeneralAnswer>("general", body,
        AbortSignal.any([controller.signal, AbortSignal.timeout(10000)])).catch(() => null)).then(value => {
        const pair = isMeetingGeneralAnswer(value) ? value : null;
        if (current() && pair) publish({ general: pair });
        return pair;
      });
      const materialTask = (async () => {
        const found = await search;
        const first = await fast;
        if (!current()) return;
        if (first?.mode === "wait") return;
        if (found.error) {
          publish({ answer: meetingFallbackFor("search_error"), phase: "error", progress: "Поиск временно недоступен. Общий ответ готовится отдельно." }); return;
        }
        try {
          const result = await meetingRequest<MeetingAnswer>("answer", { packId: active.id, ticket: found.value.ticket,
            ...(first && ["start", "continue"].includes(first.mode) ? { opening: first } : {}) }, controller.signal);
          if (!current()) return;
          publish({ answer: result,
            timings: { ...snapshot.timings, answerMs: performance.now() - started },
            progress: result.status === "grounded" ? "Готово" : result.status === "conflict" ? "В материалах есть расхождение — нужна проверка." : "В этом наборе недостаточно оснований. Используй общий вариант ответа." });
        } catch {
          publish({ answer: meetingFallbackFor("answer_error", found.value.found), phase: "error", progress: "Не удалось подготовить ответ по материалам. Общий ответ готовится отдельно." });
        }
      })();
      const [first, pair] = await Promise.all([fast, generalTask, materialTask]);
      if (current()) {
        publish({ phase: snapshot.phase === "error" ? "error" : "complete",
          ...(!snapshot.answer && (first?.mode === "wait" || pair?.opening.mode === "wait") ? { progress: "Вопрос ещё не закончен или ответ не требуется." } : {}) });
        setGenerating(false);
      }

    })();
    return () => controller.abort();
  }, [active?.id, sessionId, selected, requestVersion]);

  return <div className="meeting-assistant">
    {conversationContextWarning && <p role="alert">Не удалось обновить резюме разговора. В длинной встрече часть раннего контекста может быть недоступна.</p>}
    {historyError && <div role="alert"><p>{historyError}</p>
      <button type="button" onClick={async () => { try { await meetingHistoryClient.retry(); setHistoryError(""); setRequestVersion(v => v + 1); } catch { setHistoryError("Не удалось сохранить историю. Не закрывай страницу и повтори попытку."); } }}>Повторить сохранение / загрузку</button>
    </div>}

    <div className="meeting-help-row"><div className="meeting-block-tools"><CardInfo label="О материалах встречи"><p>Выбранный набор документов для поиска. Здесь можно загрузить файлы или сменить набор; общий ответ готовится без этих материалов.</p></CardInfo></div>
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
    </div>
    {error && <p role="alert" className="error-text">{error}</p>}
    {!question && <p className="hint">Выбери реплику в разговоре, чтобы подготовить ответ.</p>}
    {active && selection && <div className="meeting-point">
      <input aria-label="Моя мысль" value={answerHint} maxLength={1200}
        placeholder="Моя мысль — можно по-русски" onChange={e => setAnswerHint(e.target.value)} />
      <button className="meeting-icon" aria-label="Подготовить ответ" title="Подготовить ответ" type="button" disabled={historyLoading || generating || !!historyError || !answerHint.trim()} onClick={regenerateCard}><Send size={16} aria-hidden="true" /></button>
      <button className="meeting-icon" aria-label="Новый вариант" title="Новый вариант" type="button" disabled={historyLoading || generating || !!historyError} onClick={regenerateCard}><RotateCw size={16} aria-hidden="true" /></button>
      {question && <CardInfo label="О чём речь"><div className="meeting-question">
        <strong>О чём речь</strong>
        <p lang="ru">{general?.presentation?.gist || russianMeaning.trim() || "Готовим русский смысл…"}</p>
        {general?.presentation?.intent && <p><strong>Что от тебя хотят: </strong>{general.opening.mode === "wait" ? "Пока нет законченного вопроса или просьбы ответить." : general.presentation.intent}</p>}
        <details><summary>English original</summary><p lang="en">{question}</p></details>
      </div></CardInfo>}
    </div>}
    <div className="meeting-answer-meta">
    {progress && progress !== "Готово" && <p role="status">{progress}</p>}
    </div>
    {opening && <section className="meeting-opening meeting-reply-block" aria-label="Начни так">
      <h3>{opening.mode === "clarify" ? "Уточни" : "Начни так"}</h3>
      <div className="meeting-block-tools">
        <CardInfo label="О быстром начале"><p>Короткая фраза из отдельного быстрого запроса, без поиска по материалам. Общий ответ ниже готовится независимо.</p></CardInfo>
        <button className="meeting-icon" aria-label="Скопировать" title="Скопировать" type="button" onClick={() => void copyReply()}><Copy size={15} aria-hidden="true" /></button>
      </div>
      <BilingualSentences english={opening.english} russian={opening.russian} />
      <p className="meeting-reply-caption">{opening.mode === "clarify" ? "Уточнение" : "Быстрое начало · без поиска по материалам"}</p>
    </section>}
    {general?.continuation && <details className="meeting-general meeting-reply-block" open><summary>Общий ответ · без поиска</summary>
      <div className="meeting-block-tools"><CardInfo label="Об общем ответе"><p>Самостоятельный вариант по вопросу и контексту разговора, без поиска в документах. Он готовится отдельно от быстрого начала и может не содержать фактов из базы. «Моя мысль» задаёт направление этого ответа.</p></CardInfo><button className="meeting-icon" aria-label="Скопировать весь ответ" title="Скопировать весь ответ" type="button" onClick={() => void copyReply(true)}><Copy size={15} aria-hidden="true" /></button></div>
      <BilingualSentences english={`${general.opening.english} ${general.continuation.english}`} russian={`${general.opening.russian} ${general.continuation.russian}`} />
    </details>}
    {general?.presentation?.clarification && opening?.mode !== "clarify" && <div className="meeting-help-row"><div className="meeting-block-tools"><CardInfo label="Об уточнении"><p>Короткий вопрос собеседнику, если для ответа не хватает важной детали. Можно произнести английскую фразу; русский текст передаёт её смысл.</p></CardInfo></div><details className="meeting-extra" open><summary>Уточнить у собеседника</summary>
      <BilingualSentences {...general.presentation.clarification} />
    </details></div>}
    {answer && <details className="meeting-answer meeting-reply-block" open><summary>Ответ по материалам</summary>
      <div className="meeting-block-tools">
        <CardInfo label="Об ответе по материалам"><p>{answer.status === "grounded" ? "Ответ подтверждён материалами выбранного набора. Общий вариант выше подготовлен отдельно." : "В материалах не удалось подтвердить ответ. Причина доступна в диагностике."}</p></CardInfo>
        {answer.status === "grounded" && <button className="meeting-icon" aria-label="Скопировать ответ по материалам" title="Скопировать ответ по материалам" type="button" onClick={() => void copyReply(false, true)}><Copy size={15} aria-hidden="true" /></button>}
      </div>
      {answer.status === "grounded" && <BilingualSentences english={answer.english} russian={answer.russian} />}
      {answer.status !== "grounded" && <div className="meeting-help-row"><div className="meeting-block-tools"><CardInfo label="О диагностике ответа"><p>Причина, по которой ответ по материалам не получен: отсутствие подходящих разделов, недостаточно оснований или ошибка запроса.</p></CardInfo></div><details><summary>Диагностика ответа</summary><p>{answer.diagnostics
        ? `${diagnosticReasons[answer.diagnostics.reason]} (${answer.diagnostics.reason}) · Найдено разделов: ${answer.diagnostics.found ?? "неизвестно"}`
        : "Причина не сохранена в этой старой карточке. Для новой проверки нажми «Новый вариант»."}</p></details></div>}
      {answer.sources.length > 0 && <div className="meeting-help-row"><div className="meeting-block-tools"><CardInfo label="Об основаниях ответа"><p>Найденные фрагменты документов: файл, раздел и исходный текст. По ним можно проверить, на чём основан зелёный ответ.</p></CardInfo></div><details><summary>Основания ответа</summary>{answer.sources.map(source => <div key={source.id}>
        <strong>{source.filename} → {source.heading}</strong>
        <p>{Object.entries(source.metadata).filter(([key]) => !["source_hash", "pack_id"].includes(key)).map(([key,value]) => `${key}: ${value}`).join(" · ")}</p>
        <pre>{source.text}</pre>
      </div>)}</details></div>}
    </details>}
    {!!general?.presentation?.vocabulary.length && <div className="meeting-help-row"><div className="meeting-block-tools"><CardInfo label="Об опорных словах"><p>До трёх полезных английских слов или выражений из общего ответа с коротким русским смыслом. Подсказка для чтения и разговора.</p></CardInfo></div><details className="meeting-extra" open><summary>Опорные слова</summary>
      <ul>{general.presentation.vocabulary.map((word, index) => <li key={index}><strong>{word.english}</strong> — {word.russian}</li>)}</ul>
    </details></div>}
    {copyStatus && <p role="status" className="hint">{copyStatus}</p>}
    <div className="meeting-answer-meta">
    {(timings.openingMs !== undefined || timings.answerMs !== undefined) && <p className="hint" aria-label="Время подготовки ответа" title="От запуска запросов: полный ответ включает поиск по материалам и подготовку текста.">
      {timings.openingMs !== undefined && <span>Начало: {(timings.openingMs / 1000).toFixed(1)} с</span>}
      {timings.openingMs !== undefined && timings.answerMs !== undefined && " · "}
      {timings.answerMs !== undefined && <span>Поиск и полный ответ: {(timings.answerMs / 1000).toFixed(1)} с</span>}
    </p>}
    </div>
  </div>;
}
