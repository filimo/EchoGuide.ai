import { describe, expect, it } from "vitest";
import { checkSpokenQuality } from "./meeting-spoken-quality";
const answer = (english: string) => ({ english, russian: "Синтетический перевод.", status: "grounded" });
describe("spoken comparison evaluation", () => {
  it("keeps provisional decisions distinct from unreliable conclusions", () => {
    expect(checkSpokenQuality("limited-evidence-decision", {
      english: "With limited evidence, I would describe the decision as provisional and potentially unreliable."
    }, answer("I would compare it with the usual process.")).provisionalDecisionWording).toBe(false);
    expect(checkSpokenQuality("limited-evidence-decision", {
      english: "I would describe the decision as provisional because limited evidence makes the conclusion uncertain."
    }, answer("I would check a similar task.")).oneCautionInOpening).toBe(false);
    expect(checkSpokenQuality("limited-evidence-decision", {
      english: "With limited evidence, I would treat the decision as provisional."
    }, answer("I would check the result against the usual process before making a firm decision.")).provisionalDecisionWording).toBe(true);
  });
  it("rejects mismatched time comparisons and an invented efficiency-only quality rule", () => {
    expect(checkSpokenQuality("higher-quality-slower", { english: "" },
      answer("Compare the time saved with total effort.")).comparableTotals).toBe(false);
    expect(checkSpokenQuality("higher-quality-slower", { english: "" },
      answer("Better quality is worthwhile only if it reduces total effort.")).noEfficiencyOnlyQualityRule).toBe(false);
    expect(checkSpokenQuality("higher-quality-slower", { english: "" },
      answer("Compare total time for both options and check required quality.")).comparableTotals).toBe(true);
  });
  it("flags repeated baseline selection and indirect diplomatic wording", () => {
    expect(checkSpokenQuality("baseline-followup", { english: "I would use the usual process as baseline." },
      answer("I would use the usual process on a similar task.")).noRepeatedBaseline).toBe(false);
    expect(checkSpokenQuality("diplomatic-wording", { english: "I would frame it as balancing the options." },
      answer("Let us compare them.")).directWording).toBe(false);
    expect(checkSpokenQuality("diplomatic-wording", { english: "Let us compare both options." },
      answer("We can check total time and required quality together.")).directWording).toBe(true);
  });
  it("catches topic drift and repeated caution in complete generated sequences", () => {
    expect(checkSpokenQuality("extra-rework", { english: "I would count rework in the total time." },
      answer("One result is only an early signal, not a conclusion.")).currentTopic).toBe(false);
    expect(checkSpokenQuality("one-result", { english: "One result is not enough." },
      answer("It is an early signal, not a conclusion.")).noRepeatedCaution).toBe(false);
  });
  it("rejects identical-task promises and unsupported grouping for a small sample", () => {
    expect(checkSpokenQuality("comparable-work", { english: "I would use the same tasks and inputs." },
      answer("Then compare similar tasks.")).noIdenticalTasks).toBe(false);
    expect(checkSpokenQuality("comparable-work", { english: "I would compare similar work." },
      answer("Check final quality against the same task requirements.")).noIdenticalTasks).toBe(true);
    expect(checkSpokenQuality("remaining-differences", { english: "Few tasks imply a limited range of complexity." },
      answer("Report an estimate with limits.")).noInventedRange).toBe(false);
    expect(checkSpokenQuality("remaining-differences", { english: "I would record the differences." },
      answer("Put the tasks into groups and report an estimate.")).boundedSmallSample).toBe(false);
  });
  it("accepts concrete current-topic details and does not ban required technical vocabulary", () => {
    const checks = checkSpokenQuality("extra-rework", { english: "I would count rework in the total time." },
      answer("Then compare total time and final quality with the usual process."));
    expect(Object.values(checks).every(Boolean)).toBe(true);
    expect(checkSpokenQuality("technical-question", { english: "The latency threshold matters." },
      answer("Compare the required threshold with the measured latency.")).concreteLanguage).toBe(true);
    expect(checkSpokenQuality("quality-versus-speed", { english: "First check the required standard." },
      answer("If it passes, compare total time.")).qualityFirst).toBe(true);
    expect(checkSpokenQuality("remaining-differences", { english: "With few tasks, conclusions remain uncertain." },
      answer("Apply the same quality checks to both groups.")).boundedSmallSample).toBe(true);
    expect(checkSpokenQuality("unapproved-policy", { english: "" }, { ...answer(""), status: "no_answer" }).noInventedPolicy).toBe(true);
  });
});
