import { describe, expect, it } from "vitest";
import { levelMeter } from "./levelMeter";

describe("Mac audio level meter", () => {
  it("keeps both sources on the same dBFS scale", () => {
    expect(levelMeter(0, 0)).toMatchObject({ dbfs: -60, percent: 0, zone: "silent" });
    expect(levelMeter(0.01, 0.08)).toMatchObject({ dbfs: -40, zone: "good" });
    expect(levelMeter(0.01, 0.08).percent).toBeCloseTo(100 / 3);
    expect(levelMeter(0.1, 0.4)).toMatchObject({ dbfs: -20, zone: "good" });
    expect(levelMeter(0.1, 0.4).percent).toBeCloseTo(200 / 3);
    expect(levelMeter(1, 1)).toMatchObject({ dbfs: 0, percent: 100, zone: "clipping" });
  });

  it("flags clipping from peak without treating ordinary loud speech as clipping", () => {
    expect(levelMeter(0.03, 0.95).zone).toBe("clipping");
    expect(levelMeter(0.2, 0.5).zone).toBe("loud");
    expect(levelMeter(0.001, 0.01).zone).toBe("quiet");
  });
});
