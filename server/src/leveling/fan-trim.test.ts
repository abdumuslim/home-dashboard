import { describe, it, expect } from "vitest";
import {
  FAN_RESTORE_AFTER_CUT_MS,
  FAN_RESTORE_CALM_MS,
  FAN_RESTORE_CONTINUE_CALM_MS,
  FAN_RESTORE_MAX_STEP,
  planFanRestore,
  recordFanCut,
  releaseFanHold,
  type FanHolds,
} from "./fan-trim.js";
import { updateCost } from "./costs.js";
import type { AcView } from "./types.js";

const T = 1_000_000;

function ac(id: string, overrides: Partial<AcView> = {}): AcView {
  return {
    deviceId: id,
    name: id,
    on: true,
    managed: true,
    shed: false,
    maxLevel: 3,
    currentLevel: 1,
    fanSpeed: 1,
    fanExempt: false,
    needDelta: 1,
    minLevel: 1,
    manualCap: null,
    manualTarget: null,
    slotCap: null,
    reachableCap: null,
    warmStartLevel: null,
    ramping: false,
    startBaselineAmps: null,
    rampBaselineAmps: null,
    rampAbsorbedAmps: null,
    reshedPenalized: false,
    satisfiedForMs: 0,
    subFloorStalledMs: 0,
    compressorOffLikely: false,
    roomTempC: null,
    boostFloorHard: false,
    unmeteredJumpAmps: 0,
    ...overrides,
    envelopeLevel: overrides.envelopeLevel ?? overrides.currentLevel ?? 1,
    rankNeedDelta: overrides.rankNeedDelta ?? overrides.needDelta ?? 1,
  };
}

describe("hold records", () => {
  it("the first cut snapshots the original fan; later cuts keep it", () => {
    let holds: FanHolds = recordFanCut({}, ac("a", { fanSpeed: 6 }), 3, T);
    expect(holds.a.originalFan).toBe(6);
    holds = recordFanCut(holds, ac("a", { fanSpeed: 3 }), 1, T + 60_000);
    expect(holds.a.originalFan).toBe(6);
    expect(holds.a.lastSetFan).toBe(1);
    expect(releaseFanHold(holds, "a").a).toBeUndefined();
  });
});

describe("planFanRestore", () => {
  const opts = (over: Partial<Parameters<typeof planFanRestore>[2]> = {}) => ({
    calmMs: FAN_RESTORE_CALM_MS,
    headroomAmps: 1,
    book: {},
    source: "gen" as const,
    now: T,
    ...over,
  });

  /** A cut old enough that only the calm gate and the cost can block. */
  const cutLongAgo = (fanSpeed: number) =>
    recordFanCut({}, ac("a", { fanSpeed }), 1, T - FAN_RESTORE_AFTER_CUT_MS);

  it("does nothing before the long calm gate (v1's 61s bounce median is the disease)", () => {
    expect(
      planFanRestore(cutLongAgo(6), [ac("a", { fanSpeed: 1 })], opts({ calmMs: FAN_RESTORE_CALM_MS - 1 })),
    ).toBeNull();
  });

  it("holds a freshly-cut fan for the cut cooldown even when the meter is calm", () => {
    // Live 2026-07-31: Abdu's fan was cut at 17:30:24 and fully restored at
    // 17:31:44 — 80s. A fan-only batch never rewinds the shared calm clock, so
    // the calm gate alone could not see the cut that had just happened.
    const justCut = recordFanCut({}, ac("a", { fanSpeed: 7 }), 1, T - 80_000);
    expect(planFanRestore(justCut, [ac("a", { fanSpeed: 1 })], opts({ headroomAmps: 5 }))).toBeNull();
    const cooled = recordFanCut({}, ac("a", { fanSpeed: 7 }), 1, T - FAN_RESTORE_AFTER_CUT_MS);
    expect(planFanRestore(cooled, [ac("a", { fanSpeed: 1 })], opts({ headroomAmps: 5 }))).not.toBeNull();
  });

  it("a climb already under way does not re-pay the full anti-bounce window per gear", () => {
    // Live 2026-08-03 05:16:29 → 05:17:33: two gears of one recovery, a minute
    // apart, because every gear was charged the 60s gate. A fan restore SPENDS,
    // so each one also rewinds the shared calm clock — which is why the raise
    // path got no window for the length of the climb. The long gate decides
    // whether a cut fan may come back AT ALL; once the first gear has proved
    // itself the remaining question is only whether the last one has landed.
    const cut = cutLongAgo(7);
    const first = planFanRestore(cut, [ac("a", { fanSpeed: 1 })], opts({ headroomAmps: 5 }));
    expect(first).not.toBeNull();
    const climbing = first!.holds;
    // The next gear goes at the short gate…
    expect(
      planFanRestore(climbing, [ac("a", { fanSpeed: 3 })], opts({ calmMs: FAN_RESTORE_CONTINUE_CALM_MS, headroomAmps: 5 })),
    ).not.toBeNull();
    // …but not instantly: it still has to see the meter agree.
    expect(
      planFanRestore(climbing, [ac("a", { fanSpeed: 3 })], opts({ calmMs: FAN_RESTORE_CONTINUE_CALM_MS - 1, headroomAmps: 5 })),
    ).toBeNull();
  });

  it("a fresh cut ends the climb, so the next restore re-earns the long gate", () => {
    const cut = cutLongAgo(7);
    const first = planFanRestore(cut, [ac("a", { fanSpeed: 1 })], opts({ headroomAmps: 5 }));
    const recut = recordFanCut(first!.holds, ac("a", { fanSpeed: 3 }), 1, T - FAN_RESTORE_AFTER_CUT_MS);
    expect(recut.a.climbStartedAt).toBeUndefined();
    expect(
      planFanRestore(recut, [ac("a", { fanSpeed: 1 })], opts({ calmMs: FAN_RESTORE_CONTINUE_CALM_MS, headroomAmps: 5 })),
    ).toBeNull();
  });

  it("climbs at most FAN_RESTORE_MAX_STEP gears, however much headroom there is", () => {
    // The bug: the old search took the HIGHEST target whose cost fits, and a
    // 6-gear swing prices at ~0.9A — so 1→7 fitted essentially always. Abdu ran
    // 7→5→3→1→7→1→7→4 in nine minutes on 2026-07-31.
    const book = updateCost({}, "a", "gen", "fan:step", 0.1, T);
    const step = planFanRestore(cutLongAgo(7), [ac("a", { fanSpeed: 1 })], opts({ book, headroomAmps: 99 }));
    expect(step!.command).toMatchObject({ kind: "set_fan", fan: 1 + FAN_RESTORE_MAX_STEP });
    expect(step!.final).toBe(false);
    expect(step!.holds.a.lastSetFan).toBe(1 + FAN_RESTORE_MAX_STEP);
  });

  it("takes a smaller step when the bounded one does not fit", () => {
    // Learned 0.2A/step, headroom 0.3A: 2 gears cost 0.4 (no), 1 gear 0.2 (yes).
    const book = updateCost({}, "a", "gen", "fan:step", 0.2, T);
    const step = planFanRestore(cutLongAgo(6), [ac("a", { fanSpeed: 1 })], opts({ book, headroomAmps: 0.3 }));
    expect(step!.command).toMatchObject({ fan: 2 });
  });

  it("marks the step final only when it actually reaches the original", () => {
    const book = updateCost({}, "a", "gen", "fan:step", 0.1, T);
    const step = planFanRestore(cutLongAgo(3), [ac("a", { fanSpeed: 1 })], opts({ book, headroomAmps: 2 }));
    expect(step!.command).toMatchObject({ fan: 3 });
    expect(step!.final).toBe(true);
  });

  it("built-in auto restores as one indivisible jump (there is no half of auto)", () => {
    const step = planFanRestore(cutLongAgo(0), [ac("a", { fanSpeed: 1 })], opts({ headroomAmps: 2 }));
    expect(step!.command).toMatchObject({ fan: 0 });
    expect(step!.final).toBe(true);
  });

  it("does not move when not even one step fits", () => {
    const book = updateCost({}, "a", "gen", "fan:step", 0.5, T);
    expect(
      planFanRestore(cutLongAgo(6), [ac("a", { fanSpeed: 1 })], opts({ book, headroomAmps: 0.3 })),
    ).toBeNull();
  });

  it("skips OFF ACs and ACs without holds", () => {
    expect(planFanRestore(cutLongAgo(6), [ac("a", { on: false }), ac("b")], opts())).toBeNull();
  });
});
