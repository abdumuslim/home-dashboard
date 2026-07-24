import { describe, it, expect } from "vitest";
import { assessPressure, requiredSavingsAmps } from "./pressure.js";
import { DEFAULT_LEVELING_CONFIG_V2, type LevelingConfigV2 } from "./config.js";
import type { MeterView } from "./types.js";

const cfg: LevelingConfigV2 = {
  ...DEFAULT_LEVELING_CONFIG_V2,
  gridLimitAmps: 30,
  genLimitAmps: 15,
  marginAmps: 0.1,
  restingBufferAmps: 0.2,
};

function view(overrides: Partial<MeterView> = {}): MeterView {
  return {
    source: "gen",
    smoothedAmps: 12,
    latestAmps: 12,
    sampleCount: 4,
    calmMs: 0,
    overLimitBudget: 5,
    overLimitReadings: [],
    collapsed: false,
    frozen: false,
    ...overrides,
  };
}

describe("requiredSavingsAmps", () => {
  it("sizes from min(severe readings) when a severe reading exists", () => {
    // severe = >16 on gen 15; min severe 16.5 → overshoot 1.5 + margin 0.1
    expect(requiredSavingsAmps(view({ overLimitReadings: [15.5, 16.5, 17.2] }), 15, 0.1)).toBeCloseTo(1.6);
  });

  it("sizes from the median for an all-mild episode", () => {
    expect(requiredSavingsAmps(view({ overLimitReadings: [15.3, 15.5, 15.4] }), 15, 0.1)).toBeCloseTo(0.5);
  });
});

describe("assessPressure", () => {
  it("bucket empty → over, severity from the readings", () => {
    const mild = assessPressure(view({ overLimitBudget: 0, overLimitReadings: [15.3, 15.4, 15.5, 15.3, 15.4] }), cfg);
    expect(mild).toMatchObject({ kind: "over", severity: "mild" });
    const severe = assessPressure(view({ overLimitBudget: 0, overLimitReadings: [17.0, 17.1] }), cfg);
    expect(severe).toMatchObject({ kind: "over", severity: "severe" });
  });

  it("extreme severity at ≥ max(3A, 20% of limit) required", () => {
    // gen 15 → extreme at 3A. Readings ~18.5 → required ≈ 3.5+0.1.
    const p = assessPressure(view({ overLimitBudget: 0, overLimitReadings: [18.5, 18.6] }), cfg);
    expect(p).toMatchObject({ kind: "over", severity: "extreme" });
    // grid 30 → extreme at 6A; a 4A overshoot stays severe.
    const grid = assessPressure(
      view({ source: "grid", overLimitBudget: 0, overLimitReadings: [34.0, 34.2] }),
      cfg,
    );
    expect(grid).toMatchObject({ kind: "over", severity: "severe" });
  });

  it("calm → headroom against the resting ceiling", () => {
    const p = assessPressure(view({ calmMs: 40_000, smoothedAmps: 12 }), cfg);
    // resting ceiling = 15 − 0.1 − 0.2 = 14.7
    expect(p).toMatchObject({ kind: "calm" });
    if (p.kind === "calm") expect(p.headroomAmps).toBeCloseTo(2.7);
  });

  it("margin-band ride and collapse → hold", () => {
    expect(assessPressure(view({ calmMs: 0, smoothedAmps: 14.8 }), cfg).kind).toBe("hold");
    expect(assessPressure(view({ calmMs: 50_000, collapsed: true }), cfg).kind).toBe("hold");
    expect(assessPressure(view({ source: "none" }), cfg).kind).toBe("hold");
  });

  it("a projected near-limit turn-on acts proactively (no over-limit readings yet)", () => {
    const p = assessPressure(view({ smoothedAmps: 13.5, calmMs: 10_000 }), cfg, { projectedExtraAmps: 2.5 });
    expect(p).toMatchObject({ kind: "over", severity: "mild" });
    if (p.kind === "over") expect(p.requiredAmps).toBeCloseTo(1.0 + 0.1);
    // Projection under the limit stays calm.
    expect(assessPressure(view({ smoothedAmps: 10, calmMs: 10_000 }), cfg, { projectedExtraAmps: 2 }).kind).toBe(
      "calm",
    );
  });
});
