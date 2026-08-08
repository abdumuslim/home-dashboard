import { describe, it, expect } from "vitest";
import { assessPressure, requiredSavingsAmps } from "./pressure.js";
import {
  CREDIT_LANDING_GRACE_MS,
  SUSTAINED_OVER_EXTREME_MS,
  SUSTAINED_OVER_SEVERE_MS,
} from "./sensing.js";
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
    flickerMarginAmps: 0,
    derateAmps: 0,
    commandedCutCreditAmps: 0,
    commandedCutAnchorAmps: 0,
    commandedCutTotalAmps: 0,
    commandedCutAgeMs: 0,
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

  it("ONE severe reading is a spike, not a streak — it may not size the deficit", () => {
    // Live 2026-08-04 12:53:45Z (journal 7635). Gen re-entry, all three rooms at
    // L1 with their fans already trimmed, mean sitting AT the 15A limit, flicker
    // pinned at its 1.5A cap — and one ~19.5A compressor-inrush sample in the
    // banked ring. `min(severe)` over a set of one IS that sample: it sized
    // 4.57A, which no single room could cover, so the extreme rung shed two.
    const spike = view({
      overLimitReadings: [15.4, 15.8, 19.47, 15.6, 15.2],
      flickerAmps: 1.5,
      smoothedAmps: 15.025,
    });
    expect(requiredSavingsAmps(spike, 15, 0.1)).toBeLessThan(0.6);
    // The old rule, for the record: 19.47 − 15 + 0.1.
    expect(requiredSavingsAmps(spike, 15, 0.1)).not.toBeCloseTo(4.57);
  });

  it("…but a genuine severe streak still sizes from its min, undiscounted", () => {
    // Same flicker, same limit: the newest readings are severe, so the line
    // really is that far over and the median has simply not caught up.
    const streak = view({ overLimitReadings: [15.4, 19.0, 19.47], flickerAmps: 1.5, smoothedAmps: 15.5 });
    expect(requiredSavingsAmps(streak, 15, 0.1)).toBeCloseTo(4.1);
  });

  it("never sizes below the SMOOTHED overshoot, whatever the flicker", () => {
    // The mean is the floor on the answer: if the house really is 0.6A over,
    // that is owed no matter how noisy the line is.
    const v = view({ overLimitReadings: [15.4], flickerAmps: 1.5, smoothedAmps: 15.6 });
    expect(requiredSavingsAmps(v, 15, 0.1)).toBeCloseTo(0.7);
  });

  it("a lone banked inrush reading does not size the deficit (#9343 2026-08-07)", () => {
    // Live #9343: one ~17.84A compressor-inrush sample banked while the SMOOTHED
    // mean sat 12.675A against a 14A limit, flicker 0 (a lone non-reverting spike
    // is no excursion the estimator sees). `median([17.84]) − 14 − 0` sized a
    // 3.94A deficit that read "extreme" on the sole strength of that one sample,
    // and a 2-ton room went off with 1.3A of real headroom. With the mean under
    // the limit the honest floor is the margin — one raw reading is not a median.
    const spike = view({ overLimitReadings: [17.84], smoothedAmps: 12.675, flickerAmps: 0 });
    expect(requiredSavingsAmps(spike, 14, 0.1)).toBeCloseTo(0.2); // max(0.1, −1.325) + 0.1
    // The old rule, for the record: 17.84 − 14 + 0.1.
    expect(requiredSavingsAmps(spike, 14, 0.1)).not.toBeCloseTo(3.94);
  });

  it("two banked readings that are not both severe still fall to the floor", () => {
    // #9308: not a streak (the newest reading is mild) and short of
    // OVER_MEDIAN_MIN_READINGS, so the median — which would time 15.795 off two
    // readings — may not speak; the 13.215A mean is the floor.
    const v = view({ overLimitReadings: [16.39, 15.2], smoothedAmps: 13.215, flickerAmps: 0 });
    expect(requiredSavingsAmps(v, 15, 0.1)).toBeCloseTo(0.2); // max(0.1, −1.785) + 0.1
    expect(requiredSavingsAmps(v, 15, 0.1)).not.toBeCloseTo(0.895); // the old median sizing
  });

  it("three banked readings size from the median exactly as before", () => {
    // At OVER_MEDIAN_MIN_READINGS the median can no longer be a single transient,
    // so its flicker-discounted term sizes the deficit unchanged.
    const v = view({ overLimitReadings: [15.6, 15.8, 15.7], smoothedAmps: 13.0, flickerAmps: 0 });
    expect(requiredSavingsAmps(v, 15, 0.1)).toBeCloseTo(0.8); // median 15.7 − 15 + 0.1
  });

  it("two banked readings that ARE both severe still size from their min", () => {
    // The streak branch is untouched by OVER_MEDIAN_MIN_READINGS: two severe
    // readings are a genuine fast overload, not a lone spike, so min(severe)
    // speaks even though the mean sits well under the limit.
    const streak = view({ overLimitReadings: [17.0, 17.2], smoothedAmps: 13.0, flickerAmps: 0 });
    expect(requiredSavingsAmps(streak, 15, 0.1)).toBeCloseTo(2.1); // 17.0 − 15 + 0.1
  });

  it("an attributable inrush stands the severe streak down to the smoothed floor (#10375 2026-08-08)", () => {
    // Our own restore's compressor start spans two consecutive samples that both
    // clear the severe bar, while the SMOOTHED mean sits 1.3A under the limit and
    // flicker is 0 (a start does not revert). The streak's "two spikes are still
    // two spikes" argument fails for ONE physical event, so it stands down and
    // the honest smoothed floor sizes it — 1.3A shed of a room restored 82s
    // earlier becomes max(0.1, 13.7−15) + 0.1.
    const banked = view({ overLimitReadings: [16.2, 16.4], smoothedAmps: 13.7, flickerAmps: 0 });
    expect(requiredSavingsAmps(banked, 15, 0.1, true)).toBeCloseTo(0.2);
    // …and with no turn-on in flight the SAME raws still size from the streak.
    expect(requiredSavingsAmps(banked, 15, 0.1)).toBeCloseTo(1.3); // min(16.2, 16.4) − 15 + 0.1
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

  it("caps severity at mild during an attributable inrush with the mean under the limit (#10375)", () => {
    // The classification half of F3: the raw-banked severe term stands down while
    // a room is ramping and the mean has not crossed, exactly as the streak
    // sizing does. Without the flag the same two raws classify severe.
    const banked = view({ overLimitBudget: 0, overLimitReadings: [16.2, 16.4], smoothedAmps: 13.7, flickerAmps: 0 });
    expect(assessPressure(banked, cfg, { attributableInrush: true })).toMatchObject({
      kind: "over",
      severity: "mild",
    });
    expect(assessPressure(banked, cfg)).toMatchObject({ kind: "over", severity: "severe" });
  });

  it("the sustained clock still escalates during an attributable inrush — it reads the honest mean", () => {
    // The escape hatch: the flag suppresses only the RAW-banked evidence. Once
    // the SMOOTHED mean has been over for 45s the tier stops depending on it, so
    // a ride the reducer cannot fix still reaches severe even mid-ramp.
    const riding = view({
      overLimitBudget: 0,
      overLimitReadings: [16.2, 16.4],
      smoothedAmps: 14.9,
      smoothedOverMs: SUSTAINED_OVER_SEVERE_MS,
      flickerAmps: 0,
    });
    expect(assessPressure(riding, cfg, { attributableInrush: true })).toMatchObject({ severity: "severe" });
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

// ---------------------------------------------------------------------------
// The SECOND generator break of 2026-08-04 (12:39:57), and the defect it found
// on the ladder rather than in the sensing:
//
//   12:38:23  over_severe  pre 15.615 → fan trims {Abdu→1, Najat→1}, ~1.5A
//   12:38:26  over_mild    pre 16.145 → Abdullah L2→L1, ~1.9A  (≈3.0A commanded)
//   12:38:29  "escalation settle: 3.0A already commanded covers 1.2A owed"
//   …the meter falls 0.49A in 91 seconds…
//   12:39:57  COLLAPSED — the breaker got there first.
//
// A credit is the claim that amps are LATE. Lateness that never shrinks is not
// a claim, it is a bet — and the credited deficit reading 0 silenced the one
// rung that forces a room off, for two and a half minutes at 0.6–1.1A over.
// ---------------------------------------------------------------------------

describe("a credit that is not arriving is not protection (2026-08-04 12:39)", () => {
  /** The live 12:39:30 view: mean 0.65A over, ~3A commanded, 0.49A delivered. */
  const notArriving = () =>
    view({
      overLimitBudget: 0,
      overLimitReadings: [15.6, 15.7],
      smoothedAmps: 15.655,
      smoothedOverMs: 150_000,
      commandedCutAnchorAmps: 16.145,
      commandedCutTotalAmps: 3.0,
      commandedCutCreditAmps: 2.51, // 0.49A of the 3.0 absorbed
      commandedCutAgeMs: 91_000,
    });

  it("sheds instead of tripping when 91 seconds have delivered 16% of the cut", () => {
    const p = assessPressure(notArriving(), cfg);
    expect(p).toMatchObject({ kind: "over", severity: "extreme" });
    // …and the credited deficit really is zero, which is exactly why the old
    // `required > 0` gate could never fire here.
    if (p.kind === "over") expect(p.requiredAmps).toBe(0);
  });

  it("…but a credit that IS landing still holds the rung, exactly as before", () => {
    // Same ride, same commanded amps — the meter has come down 1.4A of the 3.0,
    // past the bar. The cut is working; escalating would shed a second room for
    // amps already on their way out (2026-07-31).
    const arriving = { ...notArriving(), commandedCutAnchorAmps: 17.055 };
    expect(assessPressure(arriving, cfg)).toMatchObject({ severity: "severe" });
  });

  it("trusts a fresh cut inside its landing grace — fan trims land in seconds", () => {
    const fresh = { ...notArriving(), commandedCutAgeMs: CREDIT_LANDING_GRACE_MS - 1 };
    expect(assessPressure(fresh, cfg)).toMatchObject({ severity: "severe" });
  });

  it("a shed it fires re-arms the anchor, so the next window is trusted again", () => {
    // `noteCommandedCut` re-anchors on every batch, so the tick after the
    // escalation shed looks like a fresh cut — which is what stops this rung
    // cascading through the house.
    const afterShed = { ...notArriving(), commandedCutAgeMs: 0, commandedCutTotalAmps: 5.5 };
    expect(assessPressure(afterShed, cfg)).toMatchObject({ severity: "severe" });
  });

  it("does not fire before the mean has been over for the full two minutes", () => {
    const early = { ...notArriving(), smoothedOverMs: SUSTAINED_OVER_EXTREME_MS - 1 };
    expect(assessPressure(early, cfg)).not.toMatchObject({ severity: "extreme" });
  });
});
