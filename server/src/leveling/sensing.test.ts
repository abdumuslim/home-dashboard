import { describe, it, expect } from "vitest";
import {
  CALM_REFILL_MS,
  COLLAPSE_DERATE_AMPS,
  COLLAPSE_DERATE_MAX_AMPS,
  COLLAPSE_DERATE_MS,
  METER_FROZEN_AFTER_MS,
  OVER_LIMIT_BUDGET,
  PENDING_CUT_MS,
  POWER_COLLAPSE_MAX_MS,
  determineSource,
  ingestReading,
  initialMeterState,
  meterView,
  noteCommandedCut,
  pendingCutCredit,
  refillBucket,
} from "./sensing.js";
import { DEFAULT_LEVELING_CONFIG_V2, effectiveLimit, type LevelingConfigV2 } from "./config.js";
import type { MeterEvent, MeterState } from "./types.js";

const cfg: LevelingConfigV2 = {
  ...DEFAULT_LEVELING_CONFIG_V2,
  gridLimitAmps: 30,
  genLimitAmps: 15,
  marginAmps: 1,
};

/** Feed a sequence of gen-line readings 5s apart; returns final state + all events. */
function feedGen(
  readings: number[],
  opts: { state?: MeterState; startAt?: number; stepMs?: number; config?: LevelingConfigV2 } = {},
): { state: MeterState; events: MeterEvent[]; now: number } {
  let state = opts.state ?? initialMeterState();
  const stepMs = opts.stepMs ?? 5_000;
  const config = opts.config ?? cfg;
  let now = opts.startAt ?? 1_000_000;
  const events: MeterEvent[] = [];
  for (const amps of readings) {
    const r = ingestReading(state, { gridAmps: 0, genAmps: amps }, config, now);
    state = r.state;
    events.push(...r.events);
    now += stepMs;
  }
  return { state, events, now: now - stepMs };
}

describe("determineSource", () => {
  it("detects grid, gen, both-larger-wins, none, stale", () => {
    expect(determineSource({ gridAmps: 10, genAmps: 0 }, 0)).toBe("grid");
    expect(determineSource({ gridAmps: 0, genAmps: 8 }, 0)).toBe("gen");
    expect(determineSource({ gridAmps: 3, genAmps: 8 }, 0)).toBe("gen");
    expect(determineSource({ gridAmps: 9, genAmps: 8 }, 0)).toBe("grid");
    expect(determineSource({ gridAmps: 0.05, genAmps: 0.05 }, 0)).toBe("none");
    expect(determineSource({ gridAmps: 10, genAmps: 0 }, 20_000)).toBe("none");
  });
});

describe("leaky bucket", () => {
  it("a sustained mild overload empties the bucket after 5 readings", () => {
    const { events } = feedGen([15.3, 15.4, 15.3, 15.5, 15.2]);
    const empties = events.filter((e) => e.kind === "bucket_empty");
    expect(empties).toHaveLength(1);
    expect(empties[0]).toMatchObject({ severity: "mild" });
  });

  it("two severe readings trip fast", () => {
    const { events } = feedGen([17.0, 17.1]);
    const empties = events.filter((e) => e.kind === "bucket_empty");
    expect(empties).toHaveLength(1);
    expect(empties[0]).toMatchObject({ severity: "severe" });
  });

  it("re-fires per over-limit reading while empty (failed act retries)", () => {
    const { events } = feedGen([17.0, 17.1, 15.3]);
    expect(events.filter((e) => e.kind === "bucket_empty")).toHaveLength(2);
  });

  it("a single blip then sustained calm refills instead of acting", () => {
    // One severe blip (drain 3 of 5), then calm for > CALM_REFILL_MS.
    const first = feedGen([17.0]);
    expect(first.state.overLimitBudget).toBe(OVER_LIMIT_BUDGET - 3);
    const calmReadings = new Array(8).fill(12); // 8×5s = 35s calm
    const second = feedGen(calmReadings, { state: first.state, startAt: first.now + 5_000 });
    expect(second.state.overLimitBudget).toBe(OVER_LIMIT_BUDGET);
    expect(second.events.filter((e) => e.kind === "bucket_empty")).toHaveLength(0);
  });

  it("the 29↔31 grid oscillation accumulates and trips (episode-based refill)", () => {
    // Alternating severe-over and calm readings on a 30A grid limit: the calm
    // dips never last CALM_REFILL_MS, so drains accumulate to empty.
    let state = initialMeterState();
    let now = 1_000_000;
    const events: MeterEvent[] = [];
    for (const amps of [31.2, 29, 31.3, 29, 31.1]) {
      const r = ingestReading(state, { gridAmps: amps, genAmps: 0 }, cfg, now);
      state = r.state;
      events.push(...r.events);
      now += 5_000;
    }
    expect(events.some((e) => e.kind === "bucket_empty" && e.severity === "severe")).toBe(true);
  });

  it("margin-band readings hold the bucket (no drain, no refill)", () => {
    // 14.5 on the 15A gen with margin 1: in (14, 15] — the deliberate ride.
    const first = feedGen([16.5]); // drain 3
    const ride = feedGen(new Array(10).fill(14.5), { state: first.state, startAt: first.now + 5_000 });
    expect(ride.state.overLimitBudget).toBe(OVER_LIMIT_BUDGET - 3);
    expect(ride.state.calmSince).toBeNull();
  });

  it("refillBucket restores capacity after the controller acted", () => {
    const { state } = feedGen([17, 17.2]);
    expect(state.overLimitBudget).toBe(0);
    const refilled = refillBucket(state);
    expect(refilled.overLimitBudget).toBe(OVER_LIMIT_BUDGET);
    expect(refilled.overLimitReadings).toHaveLength(0);
  });
});

describe("power-collapse latch", () => {
  it("latches on a big drop to the floor and freezes calm", () => {
    const steady = feedGen([13, 13.2, 12.8, 13.1]);
    const r = ingestReading(steady.state, { gridAmps: 0, genAmps: 4 }, cfg, steady.now + 5_000);
    expect(r.events.some((e) => e.kind === "collapse")).toBe(true);
    expect(r.state.collapse).not.toBeNull();
    // Low post-trip readings must not build calm.
    const after = feedGen([4, 4.1, 4.2], { state: r.state, startAt: steady.now + 10_000 });
    expect(meterView(after.state, after.now).calmMs).toBe(0);
  });

  it("calm dies the instant a collapse latches and rebuilds only from post-recovery readings", () => {
    // Build genuine calm, then trip: calmSince must be null on the very reading
    // that latches (not merely masked by the view), and calm must rebuild from
    // scratch after recovery — never resurface a stale pre-collapse timestamp.
    const calm = feedGen([12, 12, 12, 12]);
    expect(calm.state.calmSince).not.toBeNull();
    const tripped = ingestReading(calm.state, { gridAmps: 0, genAmps: 4 }, cfg, calm.now + 5_000);
    expect(tripped.state.collapse).not.toBeNull();
    expect(tripped.state.calmSince).toBeNull();
    // Recover, then feed fresh headroom: calm restarts at the first post-recovery
    // reading, so calmMs reflects only the new stretch, not the pre-trip one.
    const recovered = ingestReading(tripped.state, { gridAmps: 0, genAmps: 12 }, cfg, calm.now + 60_000);
    expect(recovered.state.collapse).toBeNull();
    const after = feedGen([12, 12], { state: recovered.state, startAt: calm.now + 65_000 });
    expect(meterView(after.state, after.now).calmMs).toBeLessThanOrEqual(15_000);
  });

  it("does NOT latch on a modest drop or a drop that stays above the floor", () => {
    const steady = feedGen([13, 13.2, 12.8, 13.1]);
    // Drop of ~5A but lands at 8A (> floor): a normal reduction, not a trip.
    const r = ingestReading(steady.state, { gridAmps: 0, genAmps: 8 }, cfg, steady.now + 5_000);
    expect(r.events.some((e) => e.kind === "collapse")).toBe(false);
  });

  it("recovers when measured returns near the pre-collapse median", () => {
    const steady = feedGen([13, 13.2, 12.8, 13.1]);
    const tripped = ingestReading(steady.state, { gridAmps: 0, genAmps: 4 }, cfg, steady.now + 5_000);
    const rec = ingestReading(tripped.state, { gridAmps: 0, genAmps: 11.5 }, cfg, steady.now + 60_000);
    expect(rec.events.some((e) => e.kind === "collapse_recovered")).toBe(true);
    expect(rec.state.collapse).toBeNull();
  });

  it("expires via the safety cap without a recovery event", () => {
    const steady = feedGen([13, 13.2, 12.8, 13.1]);
    const tripped = ingestReading(steady.state, { gridAmps: 0, genAmps: 4 }, cfg, steady.now + 5_000);
    // The line stays dead through the latch window (readings keep arriving).
    const dead = feedGen(new Array(6).fill(4.1), { state: tripped.state, startAt: steady.now + 10_000 });
    const later = ingestReading(
      dead.state,
      { gridAmps: 0, genAmps: 4.2 },
      cfg,
      steady.now + 5_000 + POWER_COLLAPSE_MAX_MS + 1,
    );
    expect(later.state.collapse).toBeNull();
    expect(later.events.some((e) => e.kind === "collapse_recovered")).toBe(false);
  });
});

// 2026-07-28 07:23 Baghdad: leveling shed Najat then Abdu AC over three minutes;
// their compressors actually stopped ~1 min after the last send and gen fell
// 11.5A → 4.5A in one step. That is trip-shaped, so COLLAPSED latched, every
// raise/restore froze for 5 min ("blockedBy: power collapse latched") and the
// gen limit derated to 14A — for a generator that never tripped. A drop the
// controller itself commanded is not evidence of a breaker.
describe("commanded-cut credit (self-inflicted collapse suppression)", () => {
  it("does NOT latch when our own shed explains the drop", () => {
    const steady = feedGen([11.5, 11.6, 11.4, 11.5]);
    // The reducer shed a room it priced at 3.5A (learned on@L1).
    const cut = noteCommandedCut(steady.state, 3.5, steady.now);
    const r = ingestReading(cut, { gridAmps: 0, genAmps: 4.5 }, cfg, steady.now + 60_000);
    expect(r.events.some((e) => e.kind === "collapse")).toBe(false);
    expect(r.state.collapse).toBeNull();
    // …and no phantom derate: the limit stays at its rating.
    expect(r.state.derate).toBeNull();
    const suppressed = r.events.find((e) => e.kind === "collapse_suppressed");
    expect(suppressed).toMatchObject({ toAmps: 4.5, creditAmps: 3.5 });
  });

  it("still latches when the drop is far bigger than what we commanded", () => {
    // The 2026-07-26 gen trip: a 0.4A mild trim was in flight when the breaker
    // went. 11.7A of the fall is unexplained — that is a trip.
    const steady = feedGen([15.6, 15.7, 15.5, 15.6]);
    const cut = noteCommandedCut(steady.state, 0.4, steady.now);
    const r = ingestReading(cut, { gridAmps: 0, genAmps: 3.9 }, cfg, steady.now + 5_000);
    expect(r.events.some((e) => e.kind === "collapse")).toBe(true);
    expect(r.state.derate?.amps).toBe(COLLAPSE_DERATE_AMPS);
  });

  it("credit expires — a trip long after the shed is still a trip", () => {
    const steady = feedGen([11.5, 11.6, 11.4, 11.5]);
    const cut = noteCommandedCut(steady.state, 8, steady.now);
    const r = ingestReading(cut, { gridAmps: 0, genAmps: 4.5 }, cfg, steady.now + PENDING_CUT_MS + 1);
    expect(r.events.some((e) => e.kind === "collapse")).toBe(true);
  });

  it("credit is spent once the meter has shown the cut, so a later trip latches", () => {
    const steady = feedGen([14, 14.1, 13.9, 14]);
    const cut = noteCommandedCut(steady.state, 6, steady.now);
    // The cut arrives gradually and lands above the collapse floor: absorbed.
    const settled = feedGen([8, 8, 8, 8], { state: cut, startAt: steady.now + 5_000 });
    expect(pendingCutCredit(settled.state, settled.now)).toBe(0);
    const r = ingestReading(settled.state, { gridAmps: 0, genAmps: 1 }, cfg, settled.now + 5_000);
    expect(r.events.some((e) => e.kind === "collapse")).toBe(true);
  });

  it("absorption ratchets — a peer turning back on does not re-arm spent credit", () => {
    const steady = feedGen([14, 14.1, 13.9, 14]);
    const cut = noteCommandedCut(steady.state, 6, steady.now);
    // Partial arrival of the cut, then a peer's start lifts the house again.
    const dipped = feedGen([10, 10], { state: cut, startAt: steady.now + 5_000 });
    const spent = pendingCutCredit(dipped.state, dipped.now);
    expect(spent).toBeLessThan(6);
    const lifted = feedGen([14, 14, 14], { state: dipped.state, startAt: dipped.now + 5_000 });
    expect(pendingCutCredit(lifted.state, lifted.now)).toBeLessThanOrEqual(spent);
  });

  it("stacked sheds accumulate credit while unabsorbed", () => {
    const steady = feedGen([15, 15.1, 14.9, 15]);
    const first = noteCommandedCut(steady.state, 6.5, steady.now);
    // Nothing moved yet (the confirm lag) — a second shed adds to the credit.
    const held = feedGen([15, 15, 15], { state: first, startAt: steady.now + 5_000 });
    const second = noteCommandedCut(held.state, 3.5, held.now);
    expect(pendingCutCredit(second, held.now)).toBeGreaterThan(9.8);
    expect(pendingCutCredit(second, held.now)).toBeLessThanOrEqual(10);
  });

  it("a cut commanded on the old line credits nothing after a changeover", () => {
    const steady = feedGen([11.5, 11.6, 11.4, 11.5]);
    const cut = noteCommandedCut(steady.state, 6, steady.now);
    const swapped = ingestReading(cut, { gridAmps: 12, genAmps: 0 }, cfg, steady.now + 5_000);
    expect(swapped.state.pendingCut).toBeNull();
    expect(pendingCutCredit(swapped.state, steady.now + 5_000)).toBe(0);
  });
});

describe("source changes & gaps", () => {
  it("emits source_changed and resets episodic state", () => {
    const onGen = feedGen([17, 17]); // empty bucket on gen
    const r = ingestReading(onGen.state, { gridAmps: 18, genAmps: 0 }, cfg, onGen.now + 5_000);
    expect(r.events.some((e) => e.kind === "source_changed" && e.to === "grid")).toBe(true);
    expect(r.state.overLimitBudget).toBe(OVER_LIMIT_BUDGET);
    expect(r.state.recent).toHaveLength(1);
    expect(r.state.collapse).toBeNull();
  });

  it("emits esp_gap for a reading stream gap > 20s", () => {
    const first = feedGen([12]);
    const r = ingestReading(first.state, { gridAmps: 0, genAmps: 12 }, cfg, first.now + 25_000);
    expect(r.events.some((e) => e.kind === "esp_gap")).toBe(true);
  });
});

describe("calm tracking & view", () => {
  it("calmMs grows across sustained-headroom readings", () => {
    const { state, now } = feedGen([12, 12.1, 12, 11.9, 12]);
    expect(meterView(state, now).calmMs).toBe(20_000);
  });

  it("a margin-band reading resets calm", () => {
    const calm = feedGen([12, 12, 12]);
    const ride = ingestReading(calm.state, { gridAmps: 0, genAmps: 14.5 }, cfg, calm.now + 5_000);
    expect(ride.state.calmSince).toBeNull();
  });

  it("view reports source none when the reading is stale", () => {
    const { state, now } = feedGen([12, 12]);
    expect(meterView(state, now).source).toBe("gen");
    expect(meterView(state, now + 20_000).source).toBe("none");
  });

  it("smoothing is the median of the last 4 readings", () => {
    const { state, now } = feedGen([10, 11, 12, 13, 100]);
    // window = [11,12,13,100] → median 12.5
    expect(meterView(state, now).smoothedAmps).toBe(12.5);
  });
});

describe("frozen-meter detection (2026-07-23: ESP hung at ~14.8A for 17.5 min)", () => {
  /** 5s cadence: n readings span (n−1)×5s; 14 identical readings = 65s ≥ 60s. */
  const frozenFeed = (amps: number, n = 14): number[] => new Array(n).fill(amps);

  it("flags frozen after METER_FROZEN_AFTER_MS of bit-identical readings", () => {
    const { state, events, now } = feedGen(frozenFeed(12));
    const frozenEvents = events.filter((e) => e.kind === "meter_frozen");
    expect(frozenEvents).toHaveLength(1);
    expect(frozenEvents[0]).toMatchObject({ amps: 12 });
    expect(state.frozen).toBe(true);
    expect(meterView(state, now).frozen).toBe(true);
  });

  it("frozen kills calm — repeats of a stale value are not headroom evidence", () => {
    const { state, now } = feedGen(frozenFeed(12));
    expect(meterView(state, now).calmMs).toBe(0);
  });

  it("micro-changes keep the meter trusted (no event, calm accumulates)", () => {
    // Alternating ±0.01 — ordinary CT jitter.
    const readings = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 12 : 12.01));
    const { state, events, now } = feedGen(readings);
    expect(events.some((e) => e.kind === "meter_frozen")).toBe(false);
    expect(state.frozen).toBe(false);
    expect(meterView(state, now).calmMs).toBeGreaterThan(0);
  });

  it("a change on EITHER channel unfreezes and reports the frozen span", () => {
    const frozen = feedGen(frozenFeed(12));
    const r = ingestReading(frozen.state, { gridAmps: 0.02, genAmps: 12 }, cfg, frozen.now + 5_000);
    const unfrozen = r.events.filter((e) => e.kind === "meter_unfrozen");
    expect(unfrozen).toHaveLength(1);
    expect(unfrozen[0]).toMatchObject({ frozenForMs: METER_FROZEN_AFTER_MS + 10_000 });
    expect(r.state.frozen).toBe(false);
  });

  it("calm resumes accumulating after the meter unfreezes", () => {
    const frozen = feedGen(frozenFeed(12));
    const live = feedGen([12.02, 12, 12.03, 12.01], { state: frozen.state, startAt: frozen.now + 5_000 });
    expect(live.state.frozen).toBe(false);
    expect(meterView(live.state, live.now).calmMs).toBeGreaterThan(0);
  });

  it("an ESP gap resets the frozen clock — a fresh stream is judged anew", () => {
    // 9 identical readings (40s — under the threshold), a 25s gap, then more
    // identical readings: the clock restarts at the gap, so no false flag
    // until the POST-gap stream itself runs 60s frozen.
    const before = feedGen(frozenFeed(12, 9));
    const after = feedGen(frozenFeed(12, 9), { state: before.state, startAt: before.now + 25_000 });
    expect(after.events.some((e) => e.kind === "meter_frozen")).toBe(false);
    // …and a post-gap stream that DOES run long enough still flags.
    const later = feedGen(frozenFeed(12, 6), { state: after.state, startAt: after.now + 5_000 });
    expect(later.events.some((e) => e.kind === "meter_frozen")).toBe(true);
  });

  it("frozen tracking survives a source change", () => {
    // Freeze accumulates 40s on gen, source flips to grid with the SAME stuck
    // pair continuing — the device-level clock keeps counting.
    const onGen = feedGen(frozenFeed(12, 9));
    let state = onGen.state;
    let now = onGen.now + 5_000;
    const events: MeterEvent[] = [];
    for (let i = 0; i < 6; i++) {
      const r = ingestReading(state, { gridAmps: 18, genAmps: 0 }, cfg, now);
      state = r.state;
      events.push(...r.events);
      now += 5_000;
    }
    // The grid flip itself is a micro-change (pair moved), so the clock reset
    // at the changeover — but the stuck 18/0 pair then accumulates its own 60s.
    const more = Array.from({ length: 9 }, () => 18);
    let s2 = state;
    let n2 = now;
    for (const amps of more) {
      const r = ingestReading(s2, { gridAmps: amps, genAmps: 0 }, cfg, n2);
      s2 = r.state;
      events.push(...r.events);
      n2 += 5_000;
    }
    expect(events.some((e) => e.kind === "meter_frozen")).toBe(true);
    expect(s2.frozen).toBe(true);
  });
});

describe("calm refill timing", () => {
  it("does not refill before CALM_REFILL_MS of calm", () => {
    const drained = feedGen([16.5]); // -3
    const briefCalm = feedGen(new Array(3).fill(12), { state: drained.state, startAt: drained.now + 5_000 });
    // 3 readings = 10s of calm < 30s
    expect(briefCalm.now - (briefCalm.state.calmSince ?? 0)).toBeLessThan(CALM_REFILL_MS);
    expect(briefCalm.state.overLimitBudget).toBe(OVER_LIMIT_BUDGET - 3);
  });
});

// The 2026-07-26 triple gen trip: 15.65A, then 14.48A, then 13.99A on a 15A
// configured limit. Every gate correctly admitted the third raise — against a
// limit the hot breaker was no longer holding.
describe("post-collapse limit derate", () => {
  const collapseThen = (after: number[], opts: { state?: MeterState; startAt?: number } = {}) =>
    // 4 readings to seat the smoothing window, then the collapse, then `after`.
    feedGen([14, 14, 14, 14, 3, ...after], opts);

  it("a collapse derates the limit for its window, then releases it", () => {
    const { state, now } = collapseThen([]);
    expect(meterView(state, now).derateAmps).toBe(COLLAPSE_DERATE_AMPS);
    expect(effectiveLimit(cfg, "gen", meterView(state, now).derateAmps)).toBe(14);
    // Past the window the rating comes back.
    expect(meterView(state, now + COLLAPSE_DERATE_MS + 1).derateAmps).toBe(0);
  });

  it("repeat trips inside the window stack, capped", () => {
    // Recover (≥ preMedian − 3), settle, then trip again.
    let { state, now } = collapseThen([13, 13, 13, 13]);
    expect(meterView(state, now).derateAmps).toBe(COLLAPSE_DERATE_AMPS);
    ({ state, now } = feedGen([3, 13, 13, 13, 13], { state, startAt: now + 5_000 }));
    expect(meterView(state, now).derateAmps).toBe(2 * COLLAPSE_DERATE_AMPS);
    ({ state, now } = feedGen([3, 13, 13, 13, 13], { state, startAt: now + 5_000 }));
    ({ state, now } = feedGen([3, 13, 13, 13, 13], { state, startAt: now + 5_000 }));
    expect(meterView(state, now).derateAmps).toBe(COLLAPSE_DERATE_MAX_AMPS);
  });

  it("the leaky bucket judges readings against the derated limit", () => {
    // 14.2A is UNDER the configured 15A limit but OVER the 14A derated one:
    // exactly the band the gen tripped in at 13.99A.
    const { state } = collapseThen([]);
    const fresh = { ...state, overLimitBudget: OVER_LIMIT_BUDGET, overLimitReadings: [] };
    const { events } = feedGen([14.2, 14.2, 14.2, 14.2, 14.2], { state: fresh, startAt: 2_000_000 });
    expect(events.some((e) => e.kind === "bucket_empty")).toBe(true);
  });

  it("is per-source and survives a changeover (a hot gen stays hot)", () => {
    const { state, now } = collapseThen([]);
    // Bounce to grid and back: the grid line was never the one that tripped.
    const onGrid = ingestReading(state, { gridAmps: 12, genAmps: 0 }, cfg, now + 5_000);
    expect(meterView(onGrid.state, now + 5_000).derateAmps).toBe(0);
    const backOnGen = ingestReading(onGrid.state, { gridAmps: 0, genAmps: 12 }, cfg, now + 10_000);
    expect(meterView(backOnGen.state, now + 10_000).derateAmps).toBe(COLLAPSE_DERATE_AMPS);
  });
});
