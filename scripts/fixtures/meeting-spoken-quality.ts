// Synthetic proposals, not approved policies or claims about a real team.
export const spokenQualityDocument = {
  name: "comparison.md",
  text: `# Proposed comparison for the fictional Aurora project
Type: proposal, not an approved procedure

## Proposed measurements
Compare total working time, including human review and rework, with the usual process. Check final quality against the task's quality requirements. Keep the usual human review. A faster initial draft alone does not establish time saved. No permission to accept failures of required quality checks is recorded.

## Comparable work
Choose tasks with similar scope and difficulty and apply the same quality criteria in both cases. Similar does not mean identical. Record material differences; recording them does not remove their effect. Large differences limit what the comparison can establish.

## Limited evidence
A single positive result is only an early signal. Check a few more similar tasks before drawing a firm conclusion. With only a few tasks, report an estimate and its limits. No grouping method, minimum sample size, acceptable drop in quality, or approved result is documented.
`
};
export const spokenQualityCases = [
  { name: "baseline-followup", question: "Which baseline would you choose to compare the two approaches?", context: [], expected: "grounded", source: "comparison.md" },
  { name: "higher-quality-slower", question: "How would you explain a usual process that takes longer but produces higher quality?", context: [], expected: "grounded", source: "comparison.md" },
  { name: "diplomatic-wording", question: "What short sentence could you say to invite a colleague to compare the options together?", context: [], expected: "grounded", source: "comparison.md" },
  { name: "one-result", question: "What would you say if one task looked faster, but there was no other evidence yet?", context: [], expected: "grounded", source: "comparison.md" },
  { name: "extra-rework", question: "What would you do if AI saved time on a task, but the result needed more rework?", context: ["Interviewer: What does one positive result prove?", "Me: It is an early signal, not a conclusion."], expected: "grounded", source: "comparison.md" },
  { name: "comparable-work", question: "How would you make sure the AI-assisted work and the usual work are comparable?", context: [], expected: "grounded", source: "comparison.md" },
  { name: "complexity", question: "How would you account for task complexity in that comparison?", context: ["Interviewer: We are comparing time and quality on AI-assisted and usual tasks."], expected: "grounded", source: "comparison.md" },
  { name: "remaining-differences", question: "And if they still differ in complexity and we only have a few tasks", context: ["Interviewer: We need to compare AI-assisted and usual tasks fairly."], expected: "grounded", source: "comparison.md" },
  { name: "quality-versus-speed", question: "What would you do if quality was slightly worse, but the time saving was large?", context: [], expected: "grounded", source: "comparison.md" },
  { name: "unapproved-policy", question: "What exact drop in quality has Aurora approved in exchange for faster work?", context: [], expected: "no_answer", source: null }
];

// These checks catch known regressions; a human still reviews grounding and EN/RU alignment.
export function checkSpokenQuality(name: string, opening: { english: string }, answer: { english: string; russian: string; status: string }) {
  if (name === "unapproved-policy") return { noInventedPolicy: answer.status === "no_answer" };
  const combined = `${opening.english} ${answer.english}`;
  const sentenceLengths = answer.english.split(/[.!?]+/).filter(s => s.trim()).map(s => s.trim().split(/\s+/).length);
  return {
    comparableTotals: !/compare (?:the )?time saved (?:with|against|to) (?:the )?total (?:effort|time)/i.test(combined),
    noEfficiencyOnlyQualityRule: !/quality.{0,100}only if it (?:reduces|lowers|saves)/i.test(combined),
    directWording: name !== "diplomatic-wording" || !/frame it|overrul|balancing/i.test(combined),
    noRepeatedBaseline: name !== "baseline-followup" || !(/I would use the usual process/i.test(opening.english) && /I would use the usual process/i.test(answer.english)),
    shortContinuation: answer.english.trim().split(/\s+/).length <= 45 && sentenceLengths.every(n => n <= 24),
    concreteLanguage: !/\b(?:balance (?:the )?impact|measure (?:the )?trade-off|consider their complexity)\b/i.test(combined),
    openingOnTopic: name !== "extra-rework" || /rework|extra (?:work|time)|total (?:time|effort)/i.test(opening.english),
    currentTopic: name !== "extra-rework" || (!/early signal|not a conclusion|few (?:similar )?tasks|sample size/i.test(answer.english) && /review|rework/i.test(combined) && /quality/i.test(combined) && /total|overall/i.test(combined)),
    noIdenticalTasks: name !== "comparable-work" || !/(?:same|identical) (?:tasks?|inputs?)\b(?!\s+(?:requirements|criteria|quality))/i.test(combined),
    noUnaskedDesign: !/time limit/i.test(combined) && (name !== "complexity" || !/separate complex|group|sort|stratif/i.test(opening.english)),
    noInventedRange: name !== "remaining-differences" || !/limited range|narrow range/i.test(opening.english),
    boundedSmallSample: name !== "remaining-differences" || (/estimate|limit|uncertain|firm|conclusion|cannot|can't/i.test(combined) && !/put .* into groups|split .* into groups|group (?:the )?tasks|within similar groups|stratif/i.test(combined)),
    qualityFirst: name !== "quality-versus-speed" || /quality requirements|quality criteria|quality checks|required quality|required standard|required check/i.test(combined),
    noRepeatedCaution: name !== "one-result" || !(/not enough|not a conclusion|early signal|firm conclusion|drawing conclusions/i.test(opening.english) && /early signal|not a conclusion/i.test(answer.english))
  };
}
