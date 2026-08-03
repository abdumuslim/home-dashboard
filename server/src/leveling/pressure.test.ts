import { describe, it, expect } from "vitest";
import { assessPressure, requiredSavingsAmps } from "./pressure.js";
import { SUSTAINED_OVER_EXTREME_MS, SUSTAINED_OVER_SEVERE_MS } from "./sensing.js";
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
    smoothedOverMs: 0,
    overLimitBudget: 5,
    overLimitReadings: [],
    collapsed: false,
    frozen: false,
    flickerAmps: 0,
    derateAmps: 0,
    commandedCutCreditAmps: 0,
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

  it("discounts the flicker from a mild episode's median", () => {
    // Same readings, but the supply is known to wobble ±0.4A — only what is
    // left after the wobble is real demand.
    const v = view({ overLimitReadings: [15.3, 15.5, 15.4], flickerAmps: 0.4, smoothedAmps: 14.6 });
    expect(requiredSavingsAmps(v, 15, 0.1)).toBeCloseTo(0.2); // max(0.1, −0.4, 0.0) + 0.1
  });

  it("never sizes below the SMOOTHED overshoot, whatever the flicker", () => {
    // The mean is the floor on the answer: if the house really is 0.6A over,
    // that is owed no matter how noisy the line is.
    const v = view({ overLimitReadings: [15.4], flickerAmps: 1.5, smoothedAmps: 15.6 });
    expect(requiredSavingsAmps(v, 15, 0.1)).toBeCloseTo(0.7);
  });
});

describe("assessPressure", () => {
  it("bucket empty → over, severity from the readings", () => {
    const mild = assessPressure(view({ overLimitBudget: 0, overLimitReadings: [15.3, 15.4, 15.5, 15.3, 15.4] }), cfg);
    expect(mild).toMatchObject({ kind: "over", severity: "mild" });
    const severe = assessPressure(view({ overLimitBudget: 0, overLimitReadings: [17.0, 17.1] }), cfg);
    expect(severe).toMatchObject({ kind: "over", severity: "severe" });
  });

  it("a lone spike inside the flicker band stays MILD (2026-08-02)", () => {
    // Live 16:27 UTC: one raw 16.04A reading against a 14.92A mean on a
    // flickering gen classified SEVERE, which skips inrush blanking — and the
    // reducer shed the top-priority room to answer it.
    const p = assessPressure(
      view({ overLimitBudget: 0, overLimitReadings: [16.04], smoothedAmps: 14.92, flickerAmps: 1.0 }),
      cfg,
    );
    expect(p).toMatchObject({ kind: "over", severity: "mild" });
  });

  it("the same overshoot on a QUIET line is still severe", () => {
    // A quiet line estimates NO flicker, so this is the pre-2026-08-02 rule
    // unchanged — the tolerance only exists where the meter demonstrated it.
    const p = assessPressure(
      view({ overLimitBudget: 0, overLimitReadings: [16.04], smoothedAmps: 14.92, flickerAmps: 0 }),
      cfg,
    );
    expect(p).toMatchObject({ kind: "over", severity: "severe" });
  });

  it("a severe MEAN is severe however noisy the supply", () => {
    const p = assessPressure(
      view({ overLimitBudget: 0, overLimitReadings: [16.2, 16.4], smoothedAmps: 16.3, flickerAmps: 1.5 }),
      cfg,
    );
    expect(p).toMatchObject({ kind: "over", severity: "severe" });
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

  it("an empty bucket with no evidence HOLDS — it is never an invitation to spend", () => {
    // Live 2026-08-02: one raw spike inside the flicker band drained the last
    // point AND cleared the banked readings in the same ingest. The urgent
    // evaluation that spike triggered found no readings, fell through to the
    // calm branch, and ran the RAISE path — spending headroom on the strength
    // of an over-limit episode that had not been closed.
    const p = assessPressure(view({ overLimitBudget: 0, overLimitReadings: [], calmMs: 40_000 }), cfg);
    expect(p.kind).toBe("hold");
  });

  it("a mean over the limit for 45s is SEVERE however small the overshoot", () => {
    // 15.6A on a 15A gen is 0.6A over: mild forever under magnitude alone, and
    // mild can only answer with level cuts whose compressors wind down over
    // minutes. Live 2026-08-02 that ride tripped the breaker twice.
    const riding = view({
      overLimitBudget: 0,
      overLimitReadings: [15.6, 15.7],
      smoothedAmps: 15.6,
      flickerAmps: 0.9,
    });
    expect(assessPressure(riding, cfg)).toMatchObject({ severity: "mild" });
    expect(assessPressure({ ...riding, smoothedOverMs: SUSTAINED_OVER_SEVERE_MS }, cfg)).toMatchObject({
      severity: "severe",
    });
  });

  it("two minutes over the limit is EXTREME — but only once our own cuts have landed", () => {
    const riding = view({
      overLimitBudget: 0,
      overLimitReadings: [15.6, 15.7],
      smoothedAmps: 15.6,
      smoothedOverMs: SUSTAINED_OVER_EXTREME_MS,
    });
    expect(assessPressure(riding, cfg)).toMatchObject({ severity: "extreme" });
    // A cut still travelling to the meter covers the deficit: escalating here
    // would shed a second room for amps already on their way out (2026-07-31).
    expect(assessPressure({ ...riding, commandedCutCreditAmps: 5 }, cfg)).not.toMatchObject({
      severity: "extreme",
    });
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

// 2026-07-28 16:38 and 16:40: the reducer cut a room, the leaky bucket refilled
// on the act and drained again ~30-60s later on readings the stopped compressor
// had not yet left the meter — and the second pass, finding that room already
// commanded, took the amps out of the HOT room instead.
describe("demand-side commanded-cut credit", () => {
  it("only demands what an in-flight cut does not already cover", () => {
    const over = view({ overLimitBudget: 0, overLimitReadings: [16.5], smoothedAmps: 16.5 });
    const raw = assessPressure(over, cfg);
    expect(raw.kind).toBe("over");
    const credited = assessPressure({ ...over, commandedCutCreditAmps: 1.0 }, cfg);
    expect(credited.kind).toBe("over");
    if (raw.kind !== "over" || credited.kind !== "over") throw new Error("expected over");
    expect(credited.requiredAmps).toBeCloseTo(raw.requiredAmps - 1.0, 5);
  });

  it("demands nothing more once the cut fully covers the overshoot", () => {
    const over = view({ overLimitBudget: 0, overLimitReadings: [16.5], smoothedAmps: 16.5 });
    const p = assessPressure({ ...over, commandedCutCreditAmps: 10 }, cfg);
    if (p.kind !== "over") throw new Error("expected over");
    expect(p.requiredAmps).toBe(0);
  });

  it("does not escalate to a forced shed for amps already on their way out", () => {
    const extreme = view({ overLimitBudget: 0, overLimitReadings: [19.5], smoothedAmps: 19.5 });
    const raw = assessPressure(extreme, cfg);
    if (raw.kind !== "over") throw new Error("expected over");
    expect(raw.severity).toBe("extreme");
    const credited = assessPressure({ ...extreme, commandedCutCreditAmps: 6 }, cfg);
    if (credited.kind !== "over") throw new Error("expected over");
    expect(credited.severity).not.toBe("extreme");
  });

  it("a credit that never lands stops excusing anything (expiry is upstream)", () => {
    // pendingCutCredit already returns 0 past PENDING_CUT_MS / once absorbed —
    // so a zero credit must reproduce the raw demand exactly.
    const over = view({ overLimitBudget: 0, overLimitReadings: [16.5], smoothedAmps: 16.5 });
    const a = assessPressure(over, cfg);
    const b = assessPressure({ ...over, commandedCutCreditAmps: 0 }, cfg);
    expect(a).toEqual(b);
  });
});
