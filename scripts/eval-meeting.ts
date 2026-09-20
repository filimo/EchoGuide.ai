import { createServer } from "vite";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// Synthetic-only live check. Creates billable OpenAI resources and removes them afterwards.
const loader = await createServer({ configFile: false, server: { middlewareMode: true, ws: false }, appType: "custom" });
try {
  const { MeetingService } = await loader.ssrLoadModule("/src/meeting/service.ts");
  const { readOpenAiApiKey } = await loader.ssrLoadModule("/src/realtime/realtimeSession.ts");
  const apiKey = readOpenAiApiKey(process.env, readFileSync(".env.local", "utf8"));
  if (!apiKey) throw new Error("API key is not configured.");
  const directory = resolve(`.echoguide/evals/meeting-${Date.now()}`);
  const service = new MeetingService({ directory, apiKey: () => apiKey });
  const snapshot = service.create("Synthetic meeting evaluation", [
    { name: "project.md", text: "# Проект Aurora\nПроект: Aurora\nАктуально на: 2026-09-19\n\n## Статус пилота\nТип: предложение\nQA checklist — кандидат первого эксперимента. Пилот ещё не выбран, дата запуска не согласована. Измеренной экономии времени пока нет. Сначала нужно сравнить обычную работу с AI, включая качество и доработки.\n\n## Обновление доступов\nСтатус: подтверждено\n18 сентября рабочие доступы проверены. Это не является разрешением передавать клиентские данные AI." },
    { name: "people.md", text: "# Команда Aurora\nПроект: Aurora\n\n## Роль участника\nРоль пользователя: искать возможности применения AI, проверять их на реальных задачах и измерять результаты. Это обязанности, а не свидетельство уже проведённых пилотов.\n\n## Мария Волкова\nМария Волкова подтвердила использование Codex для проверки небольшого учебного скрипта. Командное внедрение и измеренные результаты не подтверждены.\n\n## Олег Соколов\nРоль: QA\nОлег Соколов отвечает за ручное тестирование.\n\n## Олег Иванов\nРоль: DevOps\nОлег Иванов отвечает за инфраструктуру. Владелец UI-автотестов не назначен." }
  ]);
  const id = snapshot.packs[0].id;
  const started = Date.now();
  try {
    let pack;
    do {
      await new Promise(r => setTimeout(r, 1500));
      pack = (await service.refresh()).packs.find((p: any) => p.id === id);
      if (pack.status === "failed") throw new Error("Synthetic indexing failed.");
      if (Date.now() - started > 120000) throw new Error("Synthetic indexing timed out.");
    } while (pack.status !== "ready");
    service.activate(id);
    const cases = [
      { name: "product-name", question: "What has Maria confirmed about Codex usage?", context: [], expected: "grounded", source: "people.md" },
      { name: "spoken-product-name", question: "What has Maria confirmed about codecs usage, and what would be going too far beyond that?", context: [], expected: "grounded", source: "people.md" },
      { name: "actual-video-codecs", question: "Which video codecs has Maria tested for video compression?", context: [], expected: "no_answer", source: null },
      { name: "role-retrieval", question: "What is my role on the Aurora team?", context: [], expected: "grounded", source: "people.md" },
      { name: "opening-continuation", question: "What do we know about time savings so far?", context: [], expected: "grounded", source: "project.md",
        opening: { mode: "start", english: "We have no measured time savings yet.", russian: "Измеренной экономии времени у нас пока нет." } },
      { name: "next-week-guarantee", question: "What results can we guarantee next week?", context: [], expected: "grounded", source: "project.md",
        opening: { mode: "start", english: "We need to separate plans from confirmed results.", russian: "Нужно отделить планы от подтверждённых результатов." } },
      { name: "proposal-status", question: "Have we selected the QA pilot and agreed on a launch date?", context: [], expected: "grounded", source: "project.md" },
      { name: "people-disambiguation", question: "Which Oleg is responsible for infrastructure?", context: [], expected: "grounded", source: "people.md" },
      { name: "follow-up", question: "Has it started yet?", context: ["Interviewer: Let's discuss the QA checklist pilot."], expected: "grounded", source: "project.md" },
      { name: "unknown", question: "What is the approved budget in US dollars?", context: [], expected: "no_answer", source: null }
    ];
    const results = [];
    for (const item of cases) {
      const begin = Date.now(); const found = await service.search(id, item.question, item.context); const retrieved = Date.now();
      const answer = await service.answer(id, found.ticket, item.opening);
      const wrongProduct = item.name === "spoken-product-name" && (!/^If you mean Codex\b/i.test(answer.english) || !/^Если ты имеешь в виду Codex/iu.test(answer.russian));
      const repeatsOpening = item.opening && (answer.english.toLowerCase().startsWith(item.opening.english.toLowerCase()) || answer.russian.toLowerCase().startsWith(item.opening.russian.toLowerCase()));
      const passed = !wrongProduct && !repeatsOpening && answer.status === item.expected && (!item.source || answer.sources.some((s: any) => s.filename === item.source));
      results.push({ name: item.name, opening: item.opening, expected: item.expected, passed, retrievalMs: retrieved - begin, totalMs: Date.now() - begin, answer });
      console.log(`${item.name}: ${passed ? "PASS" : "FAIL"}; search ${retrieved-begin} ms; total ${Date.now()-begin} ms; ${answer.status}`);
    }
    mkdirSync(directory, { recursive: true }); writeFileSync(resolve(directory,"results.json"), JSON.stringify(results,null,2));
    if (results.some(r => !r.passed)) process.exitCode = 1;
  } finally {
    const pack = service.snapshot().packs.find((p: any) => p.id === id);
    if (pack?.status === "ready" || pack?.status === "failed") { try { await service.remove(id); console.log("Synthetic cloud files and index removed."); }
      catch { console.error(`Cleanup failed; retry removal using the manifest in ${directory}.`); process.exitCode = 1; } }
    else console.log("Synthetic upload remains pending; its local manifest records resources for cleanup.");
  }
} finally { await loader.close(); }
