function sentences(text: string, language: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (typeof Intl.Segmenter !== "function") return [trimmed];
  return Array.from(new Intl.Segmenter(language, { granularity: "sentence" }).segment(trimmed),
    item => item.segment.trim()).filter(Boolean);
}

export function BilingualSentences({ english, russian, showEnglish = true }: { english: string; russian: string; showEnglish?: boolean }) {
  const en = sentences(english, "en");
  const ru = sentences(russian, "ru");
  // Older cards may have different sentence counts. Keep their translations together.
  const pairs = en.length === ru.length
    ? en.map((text, index) => ({ english: text, russian: ru[index] }))
    : [{ english: english.trim(), russian: russian.trim() }];
  return <div className={`bilingual-sentences${showEnglish ? "" : " russian-only"}`}>
    {pairs.map((pair, index) => <div className="bilingual-sentence-pair" key={index}>
      {showEnglish && pair.english && <p className="bilingual-sentence-english" lang="en">{pair.english}</p>}
      {pair.russian && <p className="bilingual-sentence-russian" lang="ru">{pair.russian}</p>}
    </div>)}
  </div>;
}
