import { describe, it, expect } from "vitest";
import { invariantCorrections, planRaise, type RaiseInput } from "./raise.js";
import { initialPacingState, noteFailure } from "./pacing.js";
import { updateCost } from "./costs.js";
import { DEFAULT_LEVELING_CONFIG_V2, type LevelingConfigV2 } from "./config.js";
import type { AcView } from "./types.js";

const T = 1_000_000;

// base 2, step 2 → model jump 2A per step; turn-on at L1 = 2A.
const cfg: LevelingConfigV2 = {
  ...DEFAULT_LEVELING_CONFIG_V2,
  genLimitAmps: 15,
  marginAmps: 0.1,
  restingBufferAmps: 0.2,
  raiseCalmSeconds: 30,
  restoreCalmSeconds: 15,
  ampModels: {
    a: { baseAmps: 2, stepAmps: 2 },
    b: { baseAmps: 2, stepAmps: 2 },
    c: { baseAmps: 2, stepAmps: 2 },
  },
};

function ac(id: string, overrides: Partial<AcView> = {}): AcView {
  return {
    deviceId: id,
    name: id,
    on: true,
    managed: true,
    shed: false,
    maxLevel: 3,
    currentLevel: 1,
    fanSpeed: 3,
    fanExempt: false,
    needDelta: 2,
    minLevel: 1,
    manualCap: null,
    manualTarget: null,
    slotCap: null,
    reachableCap: null,
    warmStartLevel: null,
    ramping: false,
    reshedPenalized: false,
    ...overrides,
  };
}

function raise(acs: AcView[], overrides: Partial<RaiseInput> = {}) {
  return planRaise({
    acs,
    headroomAmps: 2.6, // e.g. smoothed 12.1 vs resting ceiling 14.7
    smoothedAmps: 12.1,
    limitAmps: 15,
    calmMs: 60_000,
    config: cfg,
    book: {},
    source: "gen",
    now: T,
    pacing: initialPacingState("gen"),
    ...overrides,
  });
}

describe("restore outranks raises", () => {
  it("a feasible shed restore ships alone at its floor", () => {
    const p = raise([ac("a", { needDelta: 3 }), ac("b", { on: false, shed: true, needDelta: 4 })]);
    expect(p.commands).toEqual([{ deviceId: "b", kind: "power_on", level: 1, reason: "restore" }]);
    expect(p.isTurnOn).toBe(true);
  });

  it("restores are exempt from the resting buffer (fit under limit − margin)", () => {
    // smoothed 13.2 + cost 2 = 15.2 > 14.9 → blocked; smoothed 12.8 + 2 = 14.8 ≤ 14.9 → fits,
    // even though the resting-ceiling headroom (14.7 − 12.8 = 1.9) is < cost.
    const shed = ac("b", { on: false, shed: true, needDelta: 4 });
    const blocked = raise([ac("a"), shed], { smoothedAmps: 13.2, headroomAmps: 1.5 });
    expect(blocked.commands.every((c) => c.kind !== "power_on")).toBe(true);
    const fits = raise([ac("a"), shed], { smoothedAmps: 12.8, headroomAmps: 1.9 });
    expect(fits.commands).toContainEqual({ deviceId: "b", kind: "power_on", level: 1, reason: "restore" });
  });

  it("a backoff-blocked candidate does not strand the next one (v1 49m strand)", () => {
    const pacing = noteFailure(initialPacingState("gen"), "b", "restore", T - 1_000);
    const p = raise(
      [ac("a"), ac("b", { on: false, shed: true, needDelta: 4 }), ac("c", { on: false, shed: true, needDelta: 2 })],
      { pacing },
    );
    expect(p.commands).toContainEqual({ deviceId: "c", kind: "power_on", level: 1, reason: "restore" });
  });

  it("a calm-gated feasible restore reserves its amps — raises can't steal them", () => {
    // Config with a restore gate ABOVE the raise gate: calm 35s unlocks raises
    // but not the restore. Restore cost 2A is reserved; headroom 2.6 → 0.6 left;
    // the raise needs 2A → blocked by "no headroom", NOT by a global park.
    const p = raise([ac("a", { needDelta: 3 }), ac("b", { on: false, shed: true, needDelta: 4 })], {
      calmMs: 35_000,
      config: { ...cfg, restoreCalmSeconds: 45 },
    });
    expect(p.commands).toHaveLength(0);
    expect(p.decisions.some((d) => d.deviceId === "b" && d.blockedBy === "calm")).toBe(true);
    expect(p.decisions.some((d) => d.deviceId === "a" && d.blockedBy === "no headroom")).toBe(true);
  });

  it("restore-with-reduction pulls raised peers to floors in the same batch", () => {
    // smoothed 14.5: restore cost 2 → 16.5 > 14.9. Peer at L3 saves 4A at floors → fits.
    const p = raise([ac("a", { currentLevel: 3, needDelta: 0.6 }), ac("b", { on: false, shed: true, needDelta: 4 })], {
      smoothedAmps: 14.5,
      headroomAmps: 0.2,
    });
    expect(p.commands).toEqual([
      { deviceId: "a", kind: "set_level", level: 1 },
      { deviceId: "b", kind: "power_on", level: 1, reason: "restore" },
    ]);
  });
});

describe("one-step meter-anchored raises", () => {
  it("raises the most-needy AC one step on gen — one command per batch", () => {
    const p = raise([ac("a", { needDelta: 1 }), ac("b", { needDelta: 3 })], { headroomAmps: 5 });
    expect(p.commands).toEqual([{ deviceId: "b", kind: "set_level", level: 2 }]);
  });

  it("grid may raise several ACs one step each, admission-checked cumulatively", () => {
    const gridCfg = { ...cfg, gridLimitAmps: 27 };
    const p = raise([ac("a", { needDelta: 3 }), ac("b", { needDelta: 2 })], {
      source: "grid",
      config: gridCfg,
      headroomAmps: 5,
    });
    expect(p.commands).toEqual([
      { deviceId: "a", kind: "set_level", level: 2 },
      { deviceId: "b", kind: "set_level", level: 2 },
    ]);
    // headroom 3.5 fits only the first 2A jump.
    const tight = raise([ac("a", { needDelta: 3 }), ac("b", { needDelta: 2 })], {
      source: "grid",
      config: gridCfg,
      headroomAmps: 3.5,
    });
    expect(tight.commands).toEqual([{ deviceId: "a", kind: "set_level", level: 2 }]);
  });

  it("the learned hot-case jump blocks a raise the static model would admit", () => {
    const book = updateCost({}, "a", "gen", "level:1>2", 3.8, T);
    const p = raise([ac("a")], { book, headroomAmps: 2.5 });
    expect(p.commands).toHaveLength(0);
    expect(p.decisions.some((d) => d.blockedBy === "no headroom" && d.detail?.includes("3.8"))).toBe(true);
  });

  it("calm gate + ramping block ordinary raises", () => {
    expect(raise([ac("a")], { calmMs: 10_000 }).commands).toHaveLength(0);
    expect(raise([ac("a", { ramping: true })]).commands).toHaveLength(0);
  });

  it("near-target rooms are capped at L1; manualTarget overrides the cap", () => {
    expect(raise([ac("a", { needDelta: 0.3 })]).commands).toHaveLength(0);
    const p = raise([ac("a", { needDelta: 0.3, manualTarget: 3 })], { headroomAmps: 5 });
    expect(p.commands).toEqual([{ deviceId: "a", kind: "set_level", level: 2 }]);
  });
});

describe("warm restore", () => {
  it("jumps straight to the remembered level, exempt from the calm gate", () => {
    const p = raise([ac("a", { warmStartLevel: 3, ramping: true })], { calmMs: 0, headroomAmps: 5 });
    expect(p.commands).toEqual([{ deviceId: "a", kind: "set_level", level: 3 }]);
  });

  it("still admission-checked and ceiling-clamped", () => {
    const tight = raise([ac("a", { warmStartLevel: 3 })], { calmMs: 0, headroomAmps: 3 });
    expect(tight.commands).toHaveLength(0); // 2-step jump = 4A model > 3A headroom
    const capped = raise([ac("a", { warmStartLevel: 3, slotCap: 2 })], { calmMs: 0, headroomAmps: 5 });
    expect(capped.commands).toEqual([{ deviceId: "a", kind: "set_level", level: 2 }]);
  });
});

describe("invariant corrections", () => {
  it("re-caps a level-0 AC at its top commandable level and lifts below-floor ACs", () => {
    const { commands } = invariantCorrections(
      [ac("a", { currentLevel: 0 }), ac("b", { currentLevel: 1, minLevel: 2 }), ac("c", { currentLevel: 2 })],
      T,
    );
    expect(commands).toEqual([
      { deviceId: "a", kind: "set_level", level: 3 },
      { deviceId: "b", kind: "set_level", level: 2 },
    ]);
  });

  it("ignores off/unmanaged/shed ACs", () => {
    const { commands } = invariantCorrections(
      [ac("a", { currentLevel: 0, on: false }), ac("b", { currentLevel: 0, managed: false })],
      T,
    );
    expect(commands).toHaveLength(0);
  });
});
