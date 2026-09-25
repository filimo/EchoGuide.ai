const targets = "button, select, [role='status'], .status, [role='meter']";

const buttonHints: Record<string, string> = {
  "New session": "Начать новую сессию с пустой расшифровкой и карточками.",
  Sessions: "Открыть сохранённые сессии и аудиозаписи.",
  Notes: "Открыть личные заметки, которые помогают готовить ответы.",
  "Copy transcript": "Скопировать текст текущего разговора.",
  "Начать встречу ▾": "Выбрать режим встречи: подсказки с расшифровкой или только запись аудио.",
  "С подсказками и расшифровкой": "Начать захват звука, расшифровку и подсказки.",
  "Только записать аудио": "Начать локальную запись без расшифровки и запросов к OpenAI.",
  "Остановить встречу": "Остановить захват звука и завершить запись встречи.",
  "Остановить запись": "Завершить и сохранить локальную аудиозапись.",
  "Оставить на экране": "Закрепить текущую подсказку, пока разговор продолжается."
};

function text(element: Element): string {
  if (element instanceof HTMLSelectElement) {
    const label = element.getAttribute("aria-label") || "список";
    const selected = element.selectedOptions.item(0)?.textContent?.trim();
    return selected ? `${label}: ${selected}` : label;
  }
  return (element.getAttribute("aria-label") || element.textContent || "").replace(/\s+/g, " ").trim();
}

function hint(element: Element): string {
  const label = text(element);
  if (element.matches("button")) return buttonHints[label] || (label ? `Кнопка: ${label}` : "Выполнить действие");
  if (element.matches("select")) return `Текущий выбор — ${label}. Нажмите, чтобы изменить.`;
  if (element.classList.contains("recording-status")) return `Локальная аудиозапись: ${label.slice(0, 180)}`;
  if (label.startsWith("Realtime:")) return "Состояние соединения с распознаванием речи: " + label.slice(9).trim();
  if (label.startsWith("Microphone:")) return "Состояние выбранного микрофона: " + label.slice(11).trim();
  if (label.startsWith("Notes:")) return "Объём личных заметок: " + label.slice(6).trim();
  return label ? `Состояние: ${label.slice(0, 180)}` : "Текущий уровень звука";
}

export function installHoverHints(root: HTMLElement): () => void {
  let scheduled = false;
  let cancelled = false;
  const refresh = () => {
    scheduled = false;
    if (cancelled) return;
    root.querySelectorAll(targets).forEach(element => {
      if (element.hasAttribute("title") && !element.hasAttribute("data-auto-hover-hint")) return;
      const description = hint(element);
      if (description) {
        element.setAttribute("title", description);
        element.setAttribute("data-auto-hover-hint", "");
      }
    });
  };
  const observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(refresh);
  });
  observer.observe(root, { childList: true, characterData: true, subtree: true });
  refresh();
  return () => { cancelled = true; observer.disconnect(); };
}
