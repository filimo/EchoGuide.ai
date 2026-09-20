import { describe, expect, it } from "vitest";
import { checkSpokenQuality } from "./meeting-spoken-quality";
const answer = (english: string) => ({ english, russian: "Синтетический перевод.", status: "grounded" });
describe("spoken comparison evaluation", () => {
  it("catches topic drift and repeated caution in complete generated sequences", () => {
    expect(checkSpokenQuality("extra-rework", { english: "I would count rework in the total time." },
      answer("One result is only an early signal, not a conclusion.")).currentTopic).toBe(false);
    expect(checkSpokenQuality("one-result", { english: "One result is not enough." },
      answer("It is an early signal, not a conclusion.")).noRepeatedCaution).toBe(false);
  });
  it("rejects identical-task promises and unsupported grouping for a small sample", () => {
    expect(checkSpokenQuality("comparable-work", { english: "I would use the same tasks and inputs." },
      answer("Then compare similar tasks.")).noIdenticalTasks).toBe(false);
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
    expect(checkSpokenQuality("remaining-differences", { english: "With few tasks, conclusions remain uncertain." },
      answer("Apply the same quality checks to both groups.")).boundedSmallSample).toBe(true);
    expect(checkSpokenQuality("unapproved-policy", { english: "" }, { ...answer(""), status: "no_answer" }).noInventedPolicy).toBe(true);
  });
});
