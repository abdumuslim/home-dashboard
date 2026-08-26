import { describe, it, expect } from "vitest";
import {
  CALM_REFILL_MS,
  COLLAPSE_DERATE_AMPS,
  CREDIT_LANDING_GRACE_MS,
  SUSTAINED_OVER_SEVERE_MS,
  UNEXPLAINED_FALL_CALM_HOLD_MS,
  COLLAPSE_DERATE_MAX_AMPS,
  COLLAPSE_DERATE_MS,
  FLICKER_MAX_AMPS,
  FLICKER_MIN_AMPS,
  FLICKER_MIN_SAMPLES,
  METER_FROZEN_AFTER_MS,
  OVER_LIMIT_BUDGET,
  OVER_LIMIT_BUDGET_AFTER_ACT,
  OVER_LIMIT_DRAIN_SEVERE,
  PENDING_CUT_MS,
  POWER_COLLAPSE_MAX_MS,
  ESP_GAP_EVENT_MS,
  STRAIN_DERATE_AMPS,
  STRAIN_DERATE_MAX_AMPS,
  STRAIN_DERATE_MS,
  STRAIN_DERATE_RECOVERY_STEP,
  clearCollapse,
  cutTrendOf,
  determineSource,
  flickerAmps,
  flickerMarginAmps,
  ingestReading,
  latchCollapse,
  initialMeterState,
  isSevereOverReading,
  meterView,
  noteCommandedCut,
  pendingCutCredit,
  refillBucket,
  resetCalm,
  type CutTrendInput,
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

describe("flicker estimator (2026-08-02: gen wobbles, grid does not)", () => {
  it("is 0 until the ring can support an estimate — a fresh boot is never more permissive", () => {
    const spiky = (n: number): number[] => Array.from({ length: n }, (_, i) => (i % 2 === 0 ? 12 : 13));
    expect(flickerAmps(feedGen(spiky(FLICKER_MIN_SAMPLES - 1)).state)).toBe(0);
    expect(flickerAmps(feedGen(spiky(FLICKER_MIN_SAMPLES)).state)).toBeGreaterThan(0);
  });

  it("a quiet line reports NO flicker — it keeps exactly today's classification", () => {
    const { state } = feedGen([12, 12.01, 12, 12.01, 12, 12.01, 12, 12.01]);
    expect(flickerAmps(state)).toBe(0);
  });

  it("ONE genuine step — a shed landing — does not inflate it", () => {
    // A single cliff is exactly one large jump, and the second-largest filter
    // drops it. This is what stops a real event minting the noise tolerance
    // that would then hide the next one.
    const { state } = feedGen([15, 15.01, 15, 15.01, 11, 11.01, 11, 11.01]);
    expect(flickerAmps(state)).toBe(0);
  });

  it("a spiky supply reads its spike size (spikes go up AND come back)", () => {
    const { state } = feedGen([12, 12.1, 13.1, 12.05, 12, 13.0, 12.1, 12]);
    expect(flickerAmps(state)).toBeGreaterThan(0.8);
    expect(flickerAmps(state)).toBeLessThanOrEqual(FLICKER_MAX_AMPS);
  });

  it("a SINGLE reverting spike mints NOTHING — one event cannot satisfy the two-event guard (2026-08-08)", () => {
    // Until 2026-08-08 flickerOfRing pushed BOTH legs of one excursion as two
    // array entries, so the two-entry guard passed for a lone spike and the
    // second-largest returned that spike's own larger leg — 1.5A (capped) off ONE
    // reverting reading, flatly contradicting the estimator's documented contract
    // ("a single spike-shaped coincidence still mints nothing"). Counted as
    // EVENTS, a single spike is one event: mint nothing.
    const { state } = feedGen([13.5, 13.5, 13.5, 13.5, 13.5, 16.4, 13.6, 13.6]);
    expect(flickerAmps(state)).toBe(0);
  });

  it("two SEPARATED spikes read the second-largest EVENT, not the biggest spike's leg", () => {
    // Two clean reverting excursions of 0.8A and 1.3A on an otherwise flat line.
    // The old both-legs count put the 1.3A spike's two legs in the top two slots
    // and returned 1.3; per-event it returns the genuine runner-up, 0.8A.
    const { state } = feedGen([13, 13, 13.8, 13, 13, 13, 14.3, 13]);
    expect(flickerAmps(state)).toBeCloseTo(0.8, 5);
  });

  it("the spender MARGIN reads the LARGEST event, not the classification runner-up (2026-08-08)", () => {
    // Two different spikes: classification discounts by the honest runner-up
    // (0.8A), but a spender must survive the BIGGEST wobble (1.3A) or it re-crosses
    // on the next big spike and bounces (hard rule 5c; invariant 58).
    const { state } = feedGen([13, 13, 13.8, 13, 13, 13, 14.3, 13]);
    expect(flickerAmps(state)).toBeCloseTo(0.8, 5);
    expect(flickerMarginAmps(state)).toBeCloseTo(1.3, 5);
  });

  it("a SINGLE spike mints NOTHING for classification but the full wobble for the margin", () => {
    // The 2-event guard is a CLASSIFICATION rule (a lone spike must not loosen the
    // severe bar). A spender must survive even one observed spike, so the margin
    // is NOT gated on two events — it charges the spike's size (capped), matching
    // the old (double-counted) estimate the saturated-line restore refused on.
    const { state } = feedGen([13.5, 13.5, 13.5, 13.5, 13.5, 16.4, 13.6, 13.6]);
    expect(flickerAmps(state)).toBe(0);
    expect(flickerMarginAmps(state)).toBe(FLICKER_MAX_AMPS); // 2.9A spike, capped
  });

  it("margin equals the classification estimate on a quiet line (both 0)", () => {
    const { state } = feedGen([12, 12.01, 12, 12.01, 12, 12.01, 12, 12.01]);
    expect(flickerAmps(state)).toBe(0);
    expect(flickerMarginAmps(state)).toBe(0);
  });

  it("is capped, so noise tolerance can never grow without bound", () => {
    // A 2.5A swing — comfortably over the 1.5A cap, and deliberately NOT
    // collapse-shaped: the old fixture swung 5↔20, which under the relative
    // collapse floor is a textbook trip (a 15A uncommanded fall to a third of
    // the mean) and latches, resetting the estimator's window by design.
    const { state } = feedGen([12, 14.5, 12, 14.5, 12, 14.5, 12, 14.5]);
    expect(flickerAmps(state)).toBe(FLICKER_MAX_AMPS);
  });

  it("a steady ramp reads LOW — small even steps are not flicker", () => {
    const { state } = feedGen([9, 9.3, 9.6, 9.9, 10.2, 10.5, 10.8, 11.1]);
    expect(flickerAmps(state)).toBeLessThan(0.5);
  });

  it("TWO genuine steps in one window still read as no flicker (2026-08-03)", () => {
    // The shipped estimator's safety argument — "a spike is two jumps and
    // survives, a real step is one jump and is filtered" — held only while the
    // ring contained at most ONE event. Two compressors cycling inside eight
    // readings is the ordinary steady state of this house, and it pinned the
    // estimate at its 1.5A cap: severity, calm, the drain rung and the deficit
    // sizing all loosened at once, the second compressor's own start minting
    // the tolerance that then hid it.
    const { state } = feedGen([12, 12, 14, 14, 16, 16, 16, 16]);
    expect(flickerAmps(state)).toBe(0);
  });

  it("a post-shed wind-down does not read as flicker either", () => {
    // Monotonic decay: every step is in the same direction, so nothing reverts.
    const { state } = feedGen([16, 15.4, 14.8, 14.2, 13.6, 13, 12.4, 11.8]);
    expect(flickerAmps(state)).toBe(0);
  });

  it("isSevereOverReading discounts by the live flicker", () => {
    expect(isSevereOverReading(16.5, 15, 0)).toBe(true);
    expect(isSevereOverReading(16.5, 15, 1.0)).toBe(false);
    expect(isSevereOverReading(17.5, 15, 1.0)).toBe(true);
  });
});

describe("flicker-aware bucket & calm (the 2026-08-02 ratchet)", () => {
  // The live gen config: a 0.1A margin, so the near-limit ride the controller
  // is supposed to hold is genuinely close to the ceiling.
  const genCfg: LevelingConfigV2 = { ...cfg, marginAmps: 0.1 };
  /**
   * A generator riding under its limit with periodic spikes over it — the live
   * 2026-08-02 shape. One spike per smoothing window, so the MEAN stays honest
   * and only the raw readings cross.
   */
  const rideWithSpikes = (mean: number, spike: number, readings: number): number[] =>
    Array.from({ length: readings }, (_, i) =>
      i % 4 === 3 ? spike : mean + (i % 2 === 0 ? 0.1 : -0.1),
    );

  it("a spike over the limit against an UNDER-limit mean drains only the noise rung", () => {
    const primed = feedGen(rideWithSpikes(13.5, 15.6, 8), { config: genCfg });
    const before = primed.state.overLimitBudget;
    const after = feedGen([13.6, 13.4, 13.6, 15.6], {
      state: primed.state,
      startAt: primed.now + 5_000,
      config: genCfg,
    });
    expect(before - after.state.overLimitBudget).toBeLessThanOrEqual(1);
  });

  it("never acts while the MEAN sits under the limit — the shape that shed a room live", () => {
    // Live 2026-08-02 17:59: smoothed 14.215 against a 14.5 effective limit,
    // and a room was shed anyway, because every spike drained the bucket while
    // breaking the calm that refills it. 60 readings ≈ 5 minutes of that ride.
    const { events } = feedGen(rideWithSpikes(13.5, 15.6, 60), { config: genCfg });
    expect(events.filter((e) => e.kind === "bucket_empty")).toHaveLength(0);
  });

  it("calm survives the spikes, so the bucket can refill at all", () => {
    const { state, now } = feedGen(rideWithSpikes(13.5, 15.6, 30), { config: genCfg });
    expect(meterView(state, now).calmMs).toBeGreaterThan(CALM_REFILL_MS);
    expect(state.overLimitBudget).toBe(OVER_LIMIT_BUDGET);
  });

  it("a real overload still acts — the mean is never discounted", () => {
    // Same spiky supply, but now the MEAN itself is over the limit.
    const { events } = feedGen(rideWithSpikes(15.6, 16.6, 12), { config: genCfg });
    expect(events.filter((e) => e.kind === "bucket_empty").length).toBeGreaterThan(0);
  });

  it("a genuine step-up breaks calm immediately — it does not wait for the median", () => {
    // The load jump is one large jump, so it reads as LOW flicker and is not
    // mistaken for supply noise. Without this the two readings the median takes
    // to catch up would keep refilling the bucket they had just drained.
    const calm = feedGen([8, 8.01, 8, 8.01, 8, 8.01, 8, 8.01]);
    expect(calm.state.calmSince).not.toBeNull();
    const jump = ingestReading(calm.state, { gridAmps: 0, genAmps: 16.5 }, cfg, calm.now + 5_000);
    expect(jump.state.calmSince).toBeNull();
  });

  it("banked over-limit readings are dropped once the meter shows real headroom", () => {
    // Live 2026-08-02 17:40:22. A turn-on's ramp spiked the meter to ~16.3A;
    // its cuts landed and the meter fell to 6.455A. The readings from that
    // excursion were still banked 100s later, the bucket was still empty, and
    // the controller shed the TOP-priority room for a 0.5A "deficit" derived
    // entirely from them — at a smoothed 6.5A against a 15A limit. Severity
    // came from them too, which is what bypassed the inrush blanking and the
    // escalation settle (both mild-only, deliberately).
    const spiked = feedGen([16.3, 16.5, 16.4, 16.6, 16.3, 16.5, 16.4, 16.6]);
    expect(spiked.state.overLimitReadings.length).toBeGreaterThan(0);
    expect(spiked.state.overLimitBudget).toBe(0);
    // The premise is "its cuts landed", so the cuts must be on the books: an
    // uncommanded 10A fall to 6.4A is a breaker trip under the relative
    // collapse floor, and a latched collapse holds calm by design (that is the
    // 17:40 fix). Credit is what tells the two apart — invariant 5.
    const cutSent = noteCommandedCut(spiked.state, 10, spiked.now + 1_000);
    const fell = feedGen([6.4, 6.5, 6.45, 6.4, 6.5], { state: cutSent, startAt: spiked.now + 5_000 });
    expect(fell.state.overLimitReadings).toHaveLength(0);
    // …and the bucket still waits out the calm refill: clearing the evidence is
    // not the same as declaring the episode closed, so a fresh breach still
    // acts on the very next reading.
    expect(fell.state.overLimitBudget).toBe(0);
  });

  it("a rising load KEEPS its readings while the median lags behind", () => {
    // The case the clear must not break: during a genuine rise the raw readings
    // are over the limit while the 4-wide median is still catching up. Those
    // readings are evidence about the present and must survive.
    const rising = feedGen([12, 12, 12, 12, 16.5, 16.6]);
    expect(rising.state.overLimitReadings.length).toBeGreaterThan(0);
  });

  it("a severe breach still drains the severe rung on the FIRST reading", () => {
    // The 2026-07-31 latency guard: flicker tolerance must not cost a real
    // overload its reaction time.
    const primed = feedGen([12, 12.1, 12, 12.1, 12, 12.1, 12, 12.1]);
    const before = primed.state.overLimitBudget;
    const breach = ingestReading(primed.state, { gridAmps: 0, genAmps: 19 }, cfg, primed.now + 5_000);
    expect(before - breach.state.overLimitBudget).toBe(OVER_LIMIT_DRAIN_SEVERE);
  });

  // 2026-08-26 (hard rule 5d): a reading whose effOver is ≤ 0 (raw inside the
  // measured flicker band AND the mean at or under the limit) is the estimator's
  // own verdict of supply noise, and must neither drain nor bank. Before the gate
  // it drained the mild rung, so every raw spike took a point while the near-limit
  // ride never let calm refill; the bucket ratcheted empty and reductions and a
  // room shed fired at a displayed ~14.8A (journal #20062/#20066).
  it("a raw spike inside an established flicker band drains nothing and banks nothing", () => {
    // Flicker seats at 1.0A with the mean at 13A, well under the 15A limit. The
    // spike at 15.8 is inside the band (15.8 ≤ 15 + 1.0) and the mean stays under,
    // so effOver ≤ 0.
    const primed = feedGen([13, 13, 14, 13, 13, 14, 13, 13]);
    expect(flickerAmps(primed.state)).toBe(1);
    expect(primed.state.overLimitBudget).toBe(OVER_LIMIT_BUDGET);
    const spike = ingestReading(primed.state, { gridAmps: 0, genAmps: 15.8 }, cfg, primed.now + 5_000);
    expect(spike.state.overLimitBudget).toBe(OVER_LIMIT_BUDGET);
    expect(spike.state.overLimitReadings).toHaveLength(0);
    expect(spike.events.filter((e) => e.kind === "bucket_empty")).toHaveLength(0);
  });

  it("a raw reading inside the flicker band still drains once the MEAN is over (the mean is the truth)", () => {
    // Same flicker band, but the mean now sits just over the 15A limit, so
    // smoothedOver > 0 keeps effOver > 0 and the reading at 15.5 (inside the band)
    // drains anyway. The raw discount can never hide the mean itself.
    const primed = feedGen([14.55, 15.55, 14.55, 15.55, 14.55, 15.55, 14.55, 15.55]);
    const fresh = { ...primed.state, overLimitBudget: OVER_LIMIT_BUDGET, overLimitReadings: [] };
    const at = primed.now + 5_000;
    const spike = ingestReading(fresh, { gridAmps: 0, genAmps: 15.5 }, cfg, at);
    expect(meterView(spike.state, at).smoothedAmps).toBeGreaterThan(15);
    expect(spike.state.overLimitBudget).toBeLessThan(OVER_LIMIT_BUDGET);
  });

  it("a fresh ring under FLICKER_MIN_SAMPLES drains on a raw over-limit reading, exactly as before", () => {
    // Flicker is 0 until the ring seats (a boot, a source change, a post-collapse
    // window), so effOver = max(measured − limit, smoothedOver) and any raw reading
    // over the limit still drains: the gate is never more permissive than the old
    // code.
    const fresh = feedGen([16.5, 16.6, 16.7]);
    expect(fresh.state.recent.length).toBeLessThan(FLICKER_MIN_SAMPLES);
    expect(flickerAmps(fresh.state)).toBe(0);
    expect(fresh.state.overLimitBudget).toBeLessThan(OVER_LIMIT_BUDGET);
  });

  it("a genuine step far over the limit drains severe on the first reading, gate or no gate", () => {
    // Low flicker (~0.3A), then a real load step to 19A: measured − limit is 4A,
    // clear of the severe rung by margin, so the noise gate never touches it.
    const primed = feedGen([12, 12.3, 12, 12.3, 12, 12.3, 12, 12.3]);
    expect(flickerAmps(primed.state)).toBeGreaterThan(0);
    expect(flickerAmps(primed.state)).toBeLessThan(0.5);
    const before = primed.state.overLimitBudget;
    const breach = ingestReading(primed.state, { gridAmps: 0, genAmps: 19 }, cfg, primed.now + 5_000);
    expect(before - breach.state.overLimitBudget).toBe(OVER_LIMIT_DRAIN_SEVERE);
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

  // 2026-07-31: a raise put the gen at 15.93A on a 15A limit — 0.93A over, one
  // point per reading under the old binary drain, so the FIRST corrective
  // command came 52 seconds later. The breaker had about 90 seconds left.
  it("a clearly-over reading drains the moderate rung, not the noise rung", () => {
    // Limit 15, margin 1 in this file → 15.9 is 0.9 over: past MODERATE (0.5),
    // under SEVERE (1.0).
    const { events, state } = feedGen([15.9, 15.95]);
    expect(state.overLimitBudget).toBe(OVER_LIMIT_BUDGET - 4);
    const { events: third } = feedGen([15.9], { state, startAt: 1_000_000 + 15_000 });
    expect([...events, ...third].filter((e) => e.kind === "bucket_empty")).toHaveLength(1);
  });

  it("still tolerates genuine noise just over the line", () => {
    // 15.3 is 0.3 over — inside the moderate threshold, so it stays on the
    // 1-point rung and five readings are still required.
    const { events } = feedGen([15.3, 15.3, 15.3, 15.3]);
    expect(events.filter((e) => e.kind === "bucket_empty")).toHaveLength(0);
  });

  it("the post-act refill is PARTIAL — an under-sized cut escalates in seconds", () => {
    // The live 38-second gap: the first act was a 0.4A fan trim, the bucket
    // went back to full, and the level cut that should have come first waited
    // out another five readings.
    const { state } = feedGen([16.5, 16.6]);
    expect(state.overLimitBudget).toBe(0);
    const acted = refillBucket(state, OVER_LIMIT_BUDGET_AFTER_ACT);
    expect(acted.overLimitBudget).toBe(OVER_LIMIT_BUDGET_AFTER_ACT);
    // Two moderate readings (2 + 2) escalate — five were needed before.
    const { events } = feedGen([15.8, 15.8], { state: acted, startAt: 1_000_000 + 15_000 });
    expect(events.filter((e) => e.kind === "bucket_empty")).toHaveLength(1);
  });

  // Shipped at 2 for twenty minutes on 2026-07-31 and immediately double-shed:
  // 18:21:10 shed Najat at 15.32A; 16s later ONE lingering ~16.5A reading, still
  // inside the 4-wide smoothing window from before that shed landed, emptied the
  // 2-point bucket by itself and shed Abdu at a SMOOTHED 12.555A. The commanded-
  // cut credit could not help — the fall from 15.32 to 12.5 had already absorbed
  // it in full, so the stale reading was priced as a fresh breach.
  it("a SINGLE severe reading can never empty the post-act bucket", () => {
    expect(OVER_LIMIT_BUDGET_AFTER_ACT).toBeGreaterThan(OVER_LIMIT_DRAIN_SEVERE);
    const { state } = feedGen([16.5, 16.6]);
    const acted = refillBucket(state, OVER_LIMIT_BUDGET_AFTER_ACT);
    const one = feedGen([16.5], { state: acted, startAt: 1_000_000 + 15_000 });
    expect(one.events.filter((e) => e.kind === "bucket_empty")).toHaveLength(0);
    // A second one still escalates — the point is a partner, not a veto.
    const two = feedGen([16.5], { state: one.state, startAt: 1_000_000 + 20_000 });
    expect(two.events.filter((e) => e.kind === "bucket_empty")).toHaveLength(1);
  });
});

describe("power-collapse latch — the residual is the HOUSE (2026-08-03)", () => {
  it("latches when the AC load vanishes but the house keeps drawing over the 5A floor", () => {
    // Live 2026-08-02 17:39-17:40Z: the gen carried 15.6-16.0A, the AC circuit
    // died, and the meter settled at 5.88-6.2A of house load. The absolute 5A
    // floor missed it — twice — so nothing latched: no derate, no freeze, no
    // FLOORS on recovery, and the post-trip trough read as PERFECT calm. The
    // controller then raised three levels into a dead line and the second break
    // followed four minutes later.
    const steady = feedGen([15.5, 15.7, 15.9, 15.7, 15.5, 15.7, 15.9, 15.7]);
    const r = ingestReading(steady.state, { gridAmps: 0, genAmps: 6.2 }, cfg, steady.now + 5_000);
    expect(r.events.some((e) => e.kind === "collapse")).toBe(true);
    expect(r.state.collapse).not.toBeNull();
    // …and the line is derated, which is the protection the miss cost us.
    expect(r.state.derate?.amps).toBe(COLLAPSE_DERATE_AMPS);
  });

  it("a room switched off by hand is NOT a trip — the credit is what tells them apart", () => {
    // Same fall, same residual, but this one we know about (dashboard tap,
    // automation, or an observed off the shell priced). Without this the
    // relative floor would latch COLLAPSED every time the biggest room goes off.
    const steady = feedGen([15.5, 15.7, 15.9, 15.7, 15.5, 15.7, 15.9, 15.7]);
    const known = noteCommandedCut(steady.state, 9.3, steady.now + 1_000);
    const r = ingestReading(known, { gridAmps: 0, genAmps: 6.2 }, cfg, steady.now + 5_000);
    expect(r.events.some((e) => e.kind === "collapse")).toBe(false);
    expect(r.events.some((e) => e.kind === "collapse_suppressed")).toBe(true);
    expect(r.state.derate).toBeNull();
  });

  it("a fall that arrives in two steps still latches — the pre-fall mean is held", () => {
    // The window used to be two readings wide and did not know it: the median
    // eventually flips to the post-fall level, so a 10.5A fall reads as 4A and
    // fails the test it would have passed. At SMOOTH_WINDOW 8 the flip takes
    // FIVE post-cliff readings instead of three, so the first stage is five
    // readings long here — enough that the prior median really has moved to the
    // low level and only the held anchor can carry the second stage. The whole
    // sequence spans 25s, inside CLIFF_ANCHOR_MS (30s) with margin.
    const steady = feedGen([16, 16, 16, 16, 16, 16, 16, 16]);
    const step1 = feedGen([9.5, 9.4, 9.3, 9.2, 9.1], { state: steady.state, startAt: steady.now + 5_000 });
    expect(step1.events.some((e) => e.kind === "unexplained_fall")).toBe(true);
    expect(step1.state.cliffAnchor?.medianAmps).toBe(16);
    // The prior median has genuinely given up the pre-fall level by now — this
    // is what makes the anchor load-bearing rather than decorative.
    expect(meterView(step1.state, step1.now).smoothedAmps).toBeLessThan(10);
    const step2 = ingestReading(step1.state, { gridAmps: 0, genAmps: 5.5 }, cfg, step1.now + 5_000);
    expect(step2.events.some((e) => e.kind === "collapse")).toBe(true);
  });

  it("an unexplained fall that does NOT latch still stands calm down", () => {
    // Belt to the latch's braces: the line is still carrying load, so this is
    // not provably a trip — but it is equally not headroom, and the controller
    // may not spend into a trough it cannot explain.
    const steady = feedGen([15.5, 15.7, 15.9, 15.7, 15.5, 15.7, 15.9, 15.7]);
    const fell = ingestReading(steady.state, { gridAmps: 0, genAmps: 8.5 }, cfg, steady.now + 5_000);
    expect(fell.events.some((e) => e.kind === "collapse")).toBe(false);
    const ev = fell.events.find((e) => e.kind === "unexplained_fall");
    expect(ev).toMatchObject({ fromAmps: 15.7, toAmps: 8.5 });
    // Quiet, well-under-limit readings for a minute: still no calm. (Jittered —
    // a bit-identical stream would read as a hung sensor and zero calm anyway,
    // which would prove nothing about the hold.)
    const quiet = feedGen(
      Array.from({ length: 12 }, (_, i) => 8.5 + (i % 2) * 0.02),
      { state: fell.state, startAt: fell.state.lastReadingAt + 5_000 },
    );
    expect(meterView(quiet.state, quiet.now).calmMs).toBe(0);
    // …and it expires, so nothing is stranded.
    const later = feedGen([8.5, 8.52, 8.5], {
      state: quiet.state,
      startAt: quiet.now + UNEXPLAINED_FALL_CALM_HOLD_MS,
    });
    expect(meterView(later.state, later.now).calmMs).toBeGreaterThan(0);
  });

  it("the estimator forgets the ring after a trip — tolerance is lowest when the breaker is hot", () => {
    const steady = feedGen([15.5, 15.7, 15.9, 15.7, 15.5, 15.7, 15.9, 15.7]);
    const tripped = ingestReading(steady.state, { gridAmps: 0, genAmps: 6.2 }, cfg, steady.now + 5_000);
    expect(flickerAmps(tripped.state)).toBe(0);
    // Even a wobbly post-trip line stays at zero until a full clean window.
    const after = feedGen([6.2, 6.6, 6.2, 6.6], { state: tripped.state, startAt: steady.now + 10_000 });
    expect(flickerAmps(after.state)).toBe(0);
  });
});

describe("cutTrendOf — one trend judgment about a cut in flight (2026-08-04)", () => {
  const cut = (over: Partial<CutTrendInput> = {}): CutTrendInput => ({
    commandedCutTotalAmps: 3.0,
    commandedCutAnchorAmps: 16.0,
    commandedCutAgeMs: 0,
    smoothedAmps: 16.0,
    ...over,
  });

  it("nothing in flight is `none`", () => {
    expect(cutTrendOf(cut({ commandedCutTotalAmps: 0 }))).toBe("none");
  });

  it("young and unproven is `settling` — a compressor is allowed to be slow", () => {
    expect(cutTrendOf(cut({ commandedCutAgeMs: CREDIT_LANDING_GRACE_MS - 1, smoothedAmps: 15.8 }))).toBe("settling");
  });

  it("past its grace with the fall still short is `stalled` (the 12:39:57 trip)", () => {
    // 3.0A commanded, 0.49A delivered in 91 seconds.
    expect(cutTrendOf(cut({ commandedCutAgeMs: 91_000, smoothedAmps: 15.51 }))).toBe("stalled");
  });

  it("a fall past the bar is `arriving` BEFORE the grace, not merely young (the 12:56:39 shed)", () => {
    // 2.9A commanded at a 16.565A anchor; thirteen seconds later, 14.24A.
    const landing = cut({
      commandedCutTotalAmps: 2.9,
      commandedCutAnchorAmps: 16.565,
      commandedCutAgeMs: 13_000,
      smoothedAmps: 14.24,
    });
    expect(cutTrendOf(landing)).toBe("arriving");
  });

  it("a meter that has climbed back above the anchor is never arriving", () => {
    expect(cutTrendOf(cut({ commandedCutAgeMs: 91_000, smoothedAmps: 17.0 }))).toBe("stalled");
  });
});

describe("sustained-over clock (2026-08-03)", () => {
  it("counts only unbroken time with the MEAN over the limit", () => {
    const under = feedGen([14, 14, 14, 14]);
    expect(meterView(under.state, under.now).smoothedOverMs).toBe(0);
    // The clock starts when the MEDIAN crosses, which takes FIVE readings at
    // SMOOTH_WINDOW 8 (it was two at 4) — not on the first raw reading over the
    // line. That latency is the cost of the 2026-08-05 widening, and it is why
    // this fixture feeds 15 readings for the same 45s of clock. The jitter is
    // not decoration: a live CT always micro-moves, and a bit-identical stream
    // is a hung sensor, which stops this clock by design.
    const over = feedGen(
      Array.from({ length: 15 }, (_, i) => 15.6 + (i % 2) * 0.02),
      { state: under.state, startAt: under.now + 5_000 },
    );
    expect(meterView(over.state, over.now).smoothedOverMs).toBeGreaterThanOrEqual(SUSTAINED_OVER_SEVERE_MS);
    // One honest dip under the limit resets it — this clock is about a ride
    // that will not end, not about an oscillation that keeps touching the line.
    const dipped = feedGen([12, 12, 12, 12], { state: over.state, startAt: over.now + 5_000 });
    expect(meterView(dipped.state, dipped.now).smoothedOverMs).toBe(0);
  });

  it("rebases while a commanded cut is landing, and runs again the moment it stops", () => {
    // Live 2026-08-04 12:56:26 → :39. The clock had been running since ~12:53,
    // so the pass 13 seconds after a 2.9A cut inherited a "severe" and shed a
    // SECOND room while the meter was 2.3A below that cut's own anchor and
    // still falling. A ride we are visibly ending is not a ride that will not
    // end, which is the only thing this clock was ever meant to measure.
    // The 0.02A wobble is the live CT's micro-jitter: a bit-identical stream is
    // a hung sensor, and that stops this clock by design.
    const held = (amps: number, n: number): number[] => Array.from({ length: n }, (_, i) => amps + (i % 2) * 0.02);
    const riding = feedGen(held(21, 16));
    expect(meterView(riding.state, riding.now).smoothedOverMs).toBeGreaterThanOrEqual(SUSTAINED_OVER_SEVERE_MS);

    // 6.0A commanded off at a 21A anchor; the meter comes down to 18.5 — a 2.5A
    // fall, past the 35% bar — and the line is still 3.5A over the 15A limit,
    // so nothing else could have reset the clock. Five readings, not four: the
    // fall is judged on the SMOOTHED meter, and at SMOOTH_WINDOW 8 the median
    // does not clear the 35% bar until the majority of the window sits at the
    // new level (2026-08-05).
    const cutAt = riding.now + 5_000;
    const armed = noteCommandedCut(riding.state, 6.0, cutAt);
    const landing = feedGen(held(18.5, 5), { state: armed, startAt: cutAt });
    expect(meterView(landing.state, landing.now).smoothedAmps).toBeGreaterThan(15);
    expect(meterView(landing.state, landing.now).smoothedOverMs).toBe(0);

    // …and the fall is what buys that, not the cut's existence: hold the meter
    // flat at 18.5 with the same credit outstanding and the clock is back over
    // the severe rung. Otherwise a cut that delivered a third and stopped would
    // buy three minutes of silence on a line that is still over.
    const flat = feedGen(held(18.5, 14), { state: landing.state, startAt: landing.now + 5_000 });
    expect(meterView(flat.state, flat.now).smoothedOverMs).toBeGreaterThanOrEqual(SUSTAINED_OVER_SEVERE_MS);
  });
});

describe("power-collapse latch", () => {
  it("latches on a big drop to the floor and freezes calm", () => {
    const steady = feedGen([13, 13.2, 12.8, 13.1, 13, 13.2, 12.8, 13.1]);
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
    const calm = feedGen([12, 12, 12, 12, 12, 12, 12, 12]);
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
    const steady = feedGen([13, 13.2, 12.8, 13.1, 13, 13.2, 12.8, 13.1]);
    // Drop of ~5A but lands at 8A (> floor): a normal reduction, not a trip.
    const r = ingestReading(steady.state, { gridAmps: 0, genAmps: 8 }, cfg, steady.now + 5_000);
    expect(r.events.some((e) => e.kind === "collapse")).toBe(false);
  });

  it("recovers when measured returns near the pre-collapse median", () => {
    const steady = feedGen([13, 13.2, 12.8, 13.1, 13, 13.2, 12.8, 13.1]);
    const tripped = ingestReading(steady.state, { gridAmps: 0, genAmps: 4 }, cfg, steady.now + 5_000);
    const rec = ingestReading(tripped.state, { gridAmps: 0, genAmps: 11.5 }, cfg, steady.now + 60_000);
    expect(rec.events.some((e) => e.kind === "collapse_recovered")).toBe(true);
    expect(rec.state.collapse).toBeNull();
  });

  it("expires via the safety cap without a recovery event", () => {
    const steady = feedGen([13, 13.2, 12.8, 13.1, 13, 13.2, 12.8, 13.1]);
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
    const steady = feedGen([11.5, 11.6, 11.4, 11.5, 11.5, 11.6, 11.4, 11.5]);
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
    const steady = feedGen([15.6, 15.7, 15.5, 15.6, 15.6, 15.7, 15.5, 15.6]);
    const cut = noteCommandedCut(steady.state, 0.4, steady.now);
    const r = ingestReading(cut, { gridAmps: 0, genAmps: 3.9 }, cfg, steady.now + 5_000);
    expect(r.events.some((e) => e.kind === "collapse")).toBe(true);
    expect(r.state.derate?.amps).toBe(COLLAPSE_DERATE_AMPS);
  });

  it("a MODEL-priced demote credit cannot launder a real trip (learned pricing would)", () => {
    // The loaded-spring demote cuts SATISFIED rooms — rooms that by definition
    // draw below their cap — so the learned book's largest-ever jump wildly
    // over-states what the meter will actually lose (Najat L3→L1: 7.2A learned,
    // 4.0A model, ~2–3A real). Here a genuine breaker trip takes 11A while that
    // credit is live:
    //   model  4.0 → unexplained 13.5 − 2.5 − 4.0 = 7.0 ≥ 6 → LATCHES (correct)
    //   learned 7.2 → unexplained             = 3.8 <  6 → suppressed (silent)
    const steady = feedGen([13.5, 13.6, 13.4, 13.5, 13.5, 13.6, 13.4, 13.5]);
    const modelPriced = noteCommandedCut(steady.state, 4.0, steady.now);
    const real = ingestReading(modelPriced, { gridAmps: 0, genAmps: 2.5 }, cfg, steady.now + 30_000);
    expect(real.events.some((e) => e.kind === "collapse")).toBe(true);

    const learnedPriced = noteCommandedCut(steady.state, 7.2, steady.now);
    const masked = ingestReading(learnedPriced, { gridAmps: 0, genAmps: 2.5 }, cfg, steady.now + 30_000);
    expect(masked.events.some((e) => e.kind === "collapse")).toBe(false);
  });

  it("credit expires — a trip long after the shed is still a trip", () => {
    const steady = feedGen([11.5, 11.6, 11.4, 11.5, 11.5, 11.6, 11.4, 11.5]);
    const cut = noteCommandedCut(steady.state, 8, steady.now);
    const r = ingestReading(cut, { gridAmps: 0, genAmps: 4.5 }, cfg, steady.now + PENDING_CUT_MS + 1);
    expect(r.events.some((e) => e.kind === "collapse")).toBe(true);
  });

  it("credit is spent once the meter has shown the cut, so a later trip latches", () => {
    const steady = feedGen([14, 14.1, 13.9, 14, 14, 14.1, 13.9, 14]);
    const cut = noteCommandedCut(steady.state, 6, steady.now);
    // The cut arrives gradually and lands above the collapse floor: absorbed.
    // A full window of the new level — absorption is read on the SMOOTHED
    // meter, so the credit is only spent once the median has digested the fall.
    const settled = feedGen(new Array(8).fill(8), { state: cut, startAt: steady.now + 5_000 });
    expect(pendingCutCredit(settled.state, settled.now)).toBe(0);
    const r = ingestReading(settled.state, { gridAmps: 0, genAmps: 1 }, cfg, settled.now + 5_000);
    expect(r.events.some((e) => e.kind === "collapse")).toBe(true);
  });

  it("absorption ratchets — a peer turning back on does not re-arm spent credit", () => {
    const steady = feedGen([14, 14.1, 13.9, 14, 14, 14.1, 13.9, 14]);
    const cut = noteCommandedCut(steady.state, 6, steady.now);
    // Partial arrival of the cut, then a peer's start lifts the house again.
    // Half a window of the new level, so the median has moved partway and the
    // credit is partly — but only partly — spent.
    const dipped = feedGen([10, 10, 10, 10], { state: cut, startAt: steady.now + 5_000 });
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
    const steady = feedGen([11.5, 11.6, 11.4, 11.5, 11.5, 11.6, 11.4, 11.5]);
    const cut = noteCommandedCut(steady.state, 6, steady.now);
    const swapped = ingestReading(cut, { gridAmps: 12, genAmps: 0 }, cfg, steady.now + 5_000);
    expect(swapped.state.pendingCut).toBeNull();
    expect(pendingCutCredit(swapped.state, steady.now + 5_000)).toBe(0);
  });

  it("credits NOTHING while the house outruns the cut (2026-08-03 gen break)", () => {
    // 12:26–12:29 Baghdad: Abdu was switched on at 46°C outdoor. Two level cuts
    // armed 2.0A then 3.1A of credit against a ~0.3–1.6A overshoot, so the
    // demand read 0 and the reducer planned NOTHING for 2 min 24 s while the
    // meter climbed 15.6 → 16.6A. The 120s sustained-extreme rung is gated on
    // `required > 0`, so the one rung that would have undone the turn-on could
    // never fire. The breaker went first.
    const steady = feedGen([15.6, 15.7, 15.5, 15.6]);
    const cut = noteCommandedCut(steady.state, 3.1, steady.now); // anchor ≈ 15.6
    expect(pendingCutCredit(cut, steady.now)).toBeCloseTo(3.1, 5);

    // …and the meter goes the WRONG way: a compressor ramping up outpaces it.
    const climbing = feedGen([16.1, 16.4, 16.6, 16.6], { state: cut, startAt: steady.now + 5_000 });
    expect(pendingCutCredit(climbing.state, climbing.now)).toBe(0);
    expect(meterView(climbing.state, climbing.now).commandedCutCreditAmps).toBe(0);
  });

  it("still credits a cut that IS landing — the double-shed guard is intact", () => {
    // The mirror case (2026-07-31): the meter falls toward the anchor, so the
    // credit must survive, or a stale in-window reading sheds a second room.
    const steady = feedGen([15.6, 15.7, 15.5, 15.6]);
    const cut = noteCommandedCut(steady.state, 3.1, steady.now);
    const falling = feedGen([15.2, 14.6, 14.1, 13.9], { state: cut, startAt: steady.now + 5_000 });
    expect(pendingCutCredit(falling.state, falling.now)).toBeGreaterThan(0);
  });

  it("generator flicker alone does not revoke the credit", () => {
    // Revoking it on supply wobble would re-open the 2026-07-31 double-shed, so
    // the comparison clears the live flicker estimate first.
    const steady = feedGen([15.6, 15.7, 15.5, 15.6]);
    const cut = noteCommandedCut(steady.state, 3.1, steady.now);
    const wobbling = feedGen([15.7, 15.6, 15.75, 15.65], { state: cut, startAt: steady.now + 5_000 });
    expect(pendingCutCredit(wobbling.state, wobbling.now)).toBeGreaterThan(0);
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

  // Calm is judged on the SMOOTHED mean since 2026-08-02, not on each raw
  // reading: on a generator, single readings cross the band constantly while
  // the house sits well under it, and breaking calm on those made the bucket a
  // one-way ratchet (it could drain but never refill). The near-limit ride
  // still has to break calm — it just has to actually BE where the meter
  // lives.
  it("a sustained margin-band ride resets calm", () => {
    const calm = feedGen([12, 12, 12]);
    const ride = feedGen([14.5, 14.5, 14.5, 14.5], { state: calm.state, startAt: calm.now + 5_000 });
    expect(ride.state.calmSince).toBeNull();
  });

  it("a lone margin-band reading does NOT reset calm — one spike is not a ride", () => {
    const calm = feedGen([12, 12, 12]);
    const spike = ingestReading(calm.state, { gridAmps: 0, genAmps: 14.5 }, cfg, calm.now + 5_000);
    expect(spike.state.calmSince).not.toBeNull();
    expect(spike.state.calmSince).toBe(calm.state.calmSince);
  });

  it("view reports source none when the reading is stale", () => {
    const { state, now } = feedGen([12, 12]);
    expect(meterView(state, now).source).toBe("gen");
    expect(meterView(state, now + 20_000).source).toBe("none");
  });

  it("smoothing is the median of the last 8 readings", () => {
    const { state, now } = feedGen([10, 11, 12, 13, 14, 15, 16, 17, 100]);
    // window = [11,12,13,14,15,16,17,100] → median (14+15)/2 = 14.5. The oldest
    // reading has aged out and the lone 100A spike moves it not at all — which
    // is the whole point of widening the window (2026-08-05).
    expect(meterView(state, now).smoothedAmps).toBe(14.5);
  });
});

// The fan path keeps its OWN calm clock (2026-08-09, the 16:22Z gen cycle
// #11098-#11126). It is maintained EXACTLY in parallel with the main clock on
// the meter side, and diverges ONLY when a fan-only spend rewinds the main clock
// while sparing this one — so a fan hold's first gear is not queued behind
// another hold's fan step ("fans do not queue behind fans").
describe("fan calm clock (change A, 2026-08-09)", () => {
  it("fanCalmMs tracks calmMs while only the meter drives calm", () => {
    const { state, now } = feedGen([12, 12.1, 12, 11.9, 12]);
    const v = meterView(state, now);
    expect(v.fanCalmMs).toBe(v.calmMs);
    expect(v.fanCalmMs).toBe(20_000);
  });

  it("resetCalm defaults to nulling BOTH anchors (raise/restore/swap/correction)", () => {
    const { state } = feedGen([12, 12, 12, 12, 12, 12]);
    expect(state.calmSince).not.toBeNull();
    expect(state.fanCalmSince).not.toBeNull();
    const reset = resetCalm(state);
    expect(reset.calmSince).toBeNull();
    expect(reset.fanCalmSince).toBeNull();
  });

  it("a fan-only spend rewinds the MAIN clock but spares the fan clock (invariant 18 vs #11098-#11126)", () => {
    const { state, now } = feedGen([12, 12, 12, 12, 12, 12]);
    const reset = resetCalm(state, { fanSpend: true });
    // Raises still wait — the main clock is reset, so a raise 12s after a fan
    // restore is still calm-blocked (invariant 18: two fatal raises 12s/17s after
    // a fan restore).
    expect(meterView(reset, now).calmMs).toBe(0);
    // …but the fan path's own clock keeps running, so a peer fan hold's first
    // gear is not queued behind this spend.
    expect(meterView(reset, now).fanCalmMs).toBeGreaterThan(0);
  });

  it("a meter-side calm break nulls BOTH anchors, even a fan clock a spend just spared", () => {
    const { state, now } = feedGen([12, 12, 12, 12, 12, 12]);
    const spared = resetCalm(state, { fanSpend: true });
    expect(spared.fanCalmSince).not.toBeNull();
    // A sustained ride over the limit breaks calm on the meter side — the spared
    // fan clock is nulled with the main one (the 2026-08-08 revert cascade
    // protection is meter-side and unchanged).
    const over = feedGen([16, 16, 16, 16, 16, 16, 16, 16], { state: spared, startAt: now + 5_000 });
    expect(over.state.calmSince).toBeNull();
    expect(over.state.fanCalmSince).toBeNull();
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
    // 8 readings to seat the smoothing window (SMOOTH_WINDOW, 2026-08-05 — the
    // collapse baseline is null until the window is full), then the collapse,
    // then `after`.
    feedGen([14, 14, 14, 14, 14, 14, 14, 14, 3, ...after], opts);

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

// ---------------------------------------------------------------------------
// A collapse the READINGS cannot see (2026-08-04). `ingestReading` judges FALLS
// inside a source session, so a session that BEGINS with the AC circuit dead
// has no cliff to latch on. The evidence for that shape is device liveness, not
// a meter fact, so the caller owns it (dead-window.ts) — but the machinery it
// arms has to be the SAME one, or a real trip gets a weaker answer than a
// detected one.
// ---------------------------------------------------------------------------

describe("collapse latched on entry", () => {
  const settled = () => feedGen([6, 6, 6, 6]);

  it("arms the same derate the fall path arms", () => {
    const { state, now } = settled();
    const latched = latchCollapse(state, { source: "gen", now, preMedianAmps: 11.4 });
    expect(meterView(latched, now).collapsed).toBe(true);
    expect(meterView(latched, now).derateAmps).toBe(COLLAPSE_DERATE_AMPS);
    expect(effectiveLimit(cfg, "gen", meterView(latched, now).derateAmps)).toBe(14);
  });

  it("stacks on a rung still standing, exactly like a repeat trip", () => {
    // Invariant 15: a trip part-way up the recovery ladder escalates from where
    // the line actually was, and an entry latch is not a lesser event.
    const { state, now } = feedGen([14, 14, 14, 14, 14, 14, 14, 14, 3, 13, 13, 13, 13]);
    expect(meterView(state, now).derateAmps).toBe(COLLAPSE_DERATE_AMPS);
    const latched = latchCollapse(state, { source: "gen", now: now + 5_000, preMedianAmps: 14 });
    expect(meterView(latched, now + 5_000).derateAmps).toBe(2 * COLLAPSE_DERATE_AMPS);
  });

  it("breaks calm and never double-latches", () => {
    const { state, now } = settled();
    const latched = latchCollapse(state, { source: "gen", now, preMedianAmps: 11.4 });
    expect(meterView(latched, now).calmMs).toBe(0);
    // A second call must not stack a second derate on top of its own latch.
    const again = latchCollapse(latched, { source: "gen", now: now + 1_000, preMedianAmps: 11.4 });
    expect(again).toBe(latched);
  });

  it("clears on the caller's evidence, leaving the derate standing", () => {
    // The breaker is closed again — but it just opened, so the ceiling stays
    // down while it cools (invariants 2/15).
    const { state, now } = settled();
    const latched = latchCollapse(state, { source: "gen", now, preMedianAmps: 11.4 });
    const cleared = clearCollapse(latched);
    expect(meterView(cleared, now).collapsed).toBe(false);
    expect(meterView(cleared, now).derateAmps).toBe(COLLAPSE_DERATE_AMPS);
  });

  it("prices its reference at what the line SHOULD carry, so the meter can recover it", () => {
    // `preMedianAmps` is the house plus everything we believe is on. Against the
    // dead reading itself (6A) the metered recovery test — measured within
    // POWER_COLLAPSE_RECOVER_GAP of the reference — is satisfied by the very
    // reading that latched it, and the latch would clear on the next tick.
    const { state, now } = settled();
    const latched = latchCollapse(state, { source: "gen", now, preMedianAmps: 11.4 });
    const stillDead = feedGen([6, 6], { state: latched, startAt: now + 5_000 });
    expect(meterView(stillDead.state, stillDead.now).collapsed).toBe(true);
    const backAlive = feedGen([16, 16], { state: latched, startAt: now + 5_000 });
    expect(backAlive.events.some((e) => e.kind === "collapse_recovered")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Generator STRAIN (user, 2026-08-04: "consider the gen flickering, without
// leading to a power break").
//
// After the 11:22 surge the ESP logged power gaps of 28–47 s at 11:31–11:36
// while the controller rode 14.3–14.8A on the 15A generator and reported itself
// healthy. Those gaps are brownouts — at 46 °C a genset delivers under its
// plate rating — and they are the only evidence this house can produce that the
// real ceiling is lower than the configured one (there is no voltage channel).
//
// Deliberately NOT a collapse: no latch, no freeze, no push. The ceiling comes
// down and the ordinary ladder respects it.
// ---------------------------------------------------------------------------

describe("generator strain derate", () => {
  /** Feed readings with a gap before the last one (the gap ENDS on that reading). */
  const withGap = (before: number[], after: number, opts: { state?: MeterState; startAt?: number } = {}) => {
    const seeded = feedGen(before, opts);
    return ingestReading(
      seeded.state,
      { gridAmps: 0, genAmps: after },
      cfg,
      seeded.now + ESP_GAP_EVENT_MS + 10_000,
    );
  };

  it("one brownout near the limit is a generator having a moment", () => {
    // 14.6A on a 15A limit: 0.4A of margin, well inside the band. Once is not
    // a pattern, and answering it would cost comfort for noise.
    const r = withGap([14.6, 14.6, 14.6, 14.6], 14.6);
    expect(r.events.some((e) => e.kind === "strain_derate")).toBe(false);
    expect(meterView(r.state, r.state.lastReadingAt).derateAmps).toBe(0);
  });

  it("two inside the window bring the ceiling down", () => {
    const first = withGap([14.6, 14.6, 14.6, 14.6], 14.6);
    const second = withGap([14.6, 14.6, 14.6], 14.6, {
      state: first.state,
      startAt: first.state.lastReadingAt + 5_000,
    });
    expect(second.events.some((e) => e.kind === "strain_derate")).toBe(true);
    const now = second.state.lastReadingAt;
    expect(meterView(second.state, now).derateAmps).toBe(STRAIN_DERATE_AMPS);
    expect(effectiveLimit(cfg, "gen", meterView(second.state, now).derateAmps)).toBe(14.5);
    // …and it is NOT a trip: nothing latched, nothing frozen.
    expect(meterView(second.state, now).collapsed).toBe(false);
  });

  it("stacks to a cap, then stops", () => {
    let state = feedGen([14.6, 14.6, 14.6, 14.6]).state;
    let at = state.lastReadingAt;
    for (let i = 0; i < 12; i++) {
      const r = withGap([14.6, 14.6, 14.6], 14.6, { state, startAt: at + 5_000 });
      state = r.state;
      at = state.lastReadingAt;
    }
    expect(meterView(state, at).derateAmps).toBe(STRAIN_DERATE_MAX_AMPS);
  });

  it("hands the rating back in steps, never in one jump", () => {
    const first = withGap([14.6, 14.6, 14.6, 14.6], 14.6);
    const second = withGap([14.6, 14.6, 14.6], 14.6, {
      state: first.state,
      startAt: first.state.lastReadingAt + 5_000,
    });
    const armed = second.state.lastReadingAt;
    expect(meterView(second.state, armed).derateAmps).toBe(STRAIN_DERATE_AMPS);
    // Invariant 15's shape: a cliff hand-back is spent by the raise path within
    // seconds of expiring.
    expect(meterView(second.state, armed + STRAIN_DERATE_MS + 1).derateAmps).toBe(
      Math.max(0, STRAIN_DERATE_AMPS - STRAIN_DERATE_RECOVERY_STEP),
    );
  });

  it("ignores gaps at a quiet house — that is a Wi-Fi flake", () => {
    // 9A against a 15A limit is six amps of margin. Most gaps are this.
    const first = withGap([9, 9, 9, 9], 9);
    const second = withGap([9, 9, 9], 9, { state: first.state, startAt: first.state.lastReadingAt + 5_000 });
    expect(meterView(second.state, second.state.lastReadingAt).derateAmps).toBe(0);
  });

  it("ignores gaps on grid — the grid does not brown out under our AC load", () => {
    const seed = ingestReading(initialMeterState(), { gridAmps: 26.6, genAmps: 0 }, cfg, 1_000_000);
    let state = seed.state;
    let at = 1_000_000;
    for (let i = 0; i < 6; i++) {
      at += ESP_GAP_EVENT_MS + 10_000;
      state = ingestReading(state, { gridAmps: 26.6, genAmps: 0 }, cfg, at).state;
    }
    expect(meterView(state, at).derateAmps).toBe(0);
  });

  it("adds to a collapse derate rather than replacing it — every consumer sees the sum", () => {
    // A generator that tripped AND has been browning out is holding less than
    // either fact alone says. The two records decay independently.
    const tripped = feedGen([14, 14, 14, 14, 14, 14, 14, 14, 3, 13, 13, 13, 13]);
    expect(meterView(tripped.state, tripped.now).derateAmps).toBe(COLLAPSE_DERATE_AMPS);
    const first = withGap([14.6, 14.6, 14.6], 14.6, { state: tripped.state, startAt: tripped.now + 5_000 });
    const second = withGap([14.6, 14.6, 14.6], 14.6, {
      state: first.state,
      startAt: first.state.lastReadingAt + 5_000,
    });
    const now = second.state.lastReadingAt;
    expect(meterView(second.state, now).derateAmps).toBe(COLLAPSE_DERATE_AMPS + STRAIN_DERATE_AMPS);
  });

  it("is per-source and survives a changeover, like the collapse derate", () => {
    const first = withGap([14.6, 14.6, 14.6, 14.6], 14.6);
    const second = withGap([14.6, 14.6, 14.6], 14.6, {
      state: first.state,
      startAt: first.state.lastReadingAt + 5_000,
    });
    const at = second.state.lastReadingAt + 5_000;
    const onGrid = ingestReading(second.state, { gridAmps: 12, genAmps: 0 }, cfg, at);
    expect(meterView(onGrid.state, at).derateAmps).toBe(0);
    const backOnGen = ingestReading(onGrid.state, { gridAmps: 0, genAmps: 12 }, cfg, at + 5_000);
    expect(meterView(backOnGen.state, at + 5_000).derateAmps).toBe(STRAIN_DERATE_AMPS);
  });
});
