import { describe, it, expect } from "vitest";
import {
  CALM_REFILL_MS,
  OVER_LIMIT_BUDGET,
  POWER_COLLAPSE_MAX_MS,
  determineSource,
  ingestReading,
  initialMeterState,
  meterView,
  refillBucket,
} from "./sensing.js";
import { DEFAULT_LEVELING_CONFIG_V2, type LevelingConfigV2 } from "./config.js";
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

describe("calm refill timing", () => {
  it("does not refill before CALM_REFILL_MS of calm", () => {
    const drained = feedGen([16.5]); // -3
    const briefCalm = feedGen(new Array(3).fill(12), { state: drained.state, startAt: drained.now + 5_000 });
    // 3 readings = 10s of calm < 30s
    expect(briefCalm.now - (briefCalm.state.calmSince ?? 0)).toBeLessThan(CALM_REFILL_MS);
    expect(briefCalm.state.overLimitBudget).toBe(OVER_LIMIT_BUDGET - 3);
  });
});
