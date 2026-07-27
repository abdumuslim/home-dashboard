import { describe, it, expect } from "vitest";
import { FAN_RESTORE_CALM_MS, planFanRestore, recordFanCut, releaseFanHold, type FanHolds } from "./fan-trim.js";
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
    ...overrides,
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

  it("does nothing before the long calm gate (v1's 61s bounce median is the disease)", () => {
    const holds = recordFanCut({}, ac("a", { fanSpeed: 6 }), 1, T);
    expect(planFanRestore(holds, [ac("a", { fanSpeed: 1 })], opts({ calmMs: FAN_RESTORE_CALM_MS - 1 }))).toBeNull();
  });

  it("climbs to the sweet spot the learned cost fits, one AC per evaluation", () => {
    // Learned 0.2A/step; headroom 0.7A; original 6, current 1 → full climb (5
    // steps = 1.0A) doesn't fit; 4 steps to fan 4 does (0.8 > 0.7? no — 0.8 > 0.7,
    // so 3 steps to fan 4 costs 0.6 ≤ 0.7 → target 4).
    const book = updateCost({}, "a", "gen", "fan:step", 0.2, T);
    const holds = recordFanCut({}, ac("a", { fanSpeed: 6 }), 1, T - FAN_RESTORE_CALM_MS);
    const step = planFanRestore(holds, [ac("a", { fanSpeed: 1 })], opts({ book, headroomAmps: 0.7 }));
    expect(step).not.toBeNull();
    expect(step!.command).toMatchObject({ kind: "set_fan", fan: 4 });
    expect(step!.final).toBe(false);
    expect(step!.holds.a.lastSetFan).toBe(4);
  });

  it("reaches the original in one jump when it fits and marks the step final", () => {
    const book = updateCost({}, "a", "gen", "fan:step", 0.1, T);
    const holds = recordFanCut({}, ac("a", { fanSpeed: 6 }), 1, T - FAN_RESTORE_CALM_MS);
    const step = planFanRestore(holds, [ac("a", { fanSpeed: 1 })], opts({ book, headroomAmps: 2 }));
    expect(step!.command).toMatchObject({ fan: 6 });
    expect(step!.final).toBe(true);
  });

  it("built-in auto restores as one indivisible jump", () => {
    const holds = recordFanCut({}, ac("a", { fanSpeed: 0 }), 1, T - FAN_RESTORE_CALM_MS);
    const step = planFanRestore(holds, [ac("a", { fanSpeed: 1 })], opts({ headroomAmps: 2 }));
    expect(step!.command).toMatchObject({ fan: 0 });
    expect(step!.final).toBe(true);
  });

  it("does not move when not even one step fits", () => {
    const book = updateCost({}, "a", "gen", "fan:step", 0.5, T);
    const holds = recordFanCut({}, ac("a", { fanSpeed: 6 }), 1, T - FAN_RESTORE_CALM_MS);
    expect(planFanRestore(holds, [ac("a", { fanSpeed: 1 })], opts({ book, headroomAmps: 0.3 }))).toBeNull();
  });

  it("skips OFF ACs and ACs without holds", () => {
    const holds = recordFanCut({}, ac("a", { fanSpeed: 6 }), 1, T - FAN_RESTORE_CALM_MS);
    expect(planFanRestore(holds, [ac("a", { on: false }), ac("b")], opts())).toBeNull();
  });
});
