// G2 (2026-09-27): the grid roomy lane, at the planner level. Owner decision
// 2026-09-27, "Grid fast lane: YES". Seven days of grid: 64% of the 290
// blocked grid raise/restore decisions were pacing gates (settle window 128,
// calm 43) with a MEDIAN 13A of the 30A line unused at those moments.
//
// The situational half of the gate (grid, calm pressure, no corrections, no
// recent over-limit batch, no derate/collapse/frozen) lives in pipeline.ts and
// is pinned in pipeline.test.ts; here the lane is simply present or absent.

import { describe, it, expect } from "vitest";
import { GRID_ROOMY_SPARE_AMPS, planRaise, type RaiseInput } from "./raise.js";
import { initialPacingState, noteFailure } from "./pacing.js";
import { DEFAULT_LEVELING_CONFIG_V2, type LevelingConfigV2 } from "./config.js";
import type { AcView, Command } from "./types.js";

const T = 1_000_000;

// base 2, step 2: L1 2A, L2 4A, L3 6A. "big" steps 5A.
const cfg: LevelingConfigV2 = {
  ...DEFAULT_LEVELING_CONFIG_V2,
  gridLimitAmps: 30,
  marginAmps: 0.1,
  restingBufferAmps: 0.2,
  raiseCalmSeconds: 30,
  restoreCalmSeconds: 15,
  nearTargetBandC: 0.5,
  ampModels: {
    a: { baseAmps: 2, stepAmps: 2 },
    b: { baseAmps: 2, stepAmps: 2 },
    c: { baseAmps: 2, stepAmps: 2 },
    big: { baseAmps: 2, stepAmps: 5 },
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
    startBaselineAmps: null,
    rampBaselineAmps: null,
    rampAbsorbedAmps: null,
    reshedPenalized: false,
    recentlyExternalOn: false,
    satisfiedForMs: 0,
    subFloorStalledMs: 0,
    compressorOffLikely: false,
    roomTempC: null,
    boostFloorHard: false,
    unmeteredJumpAmps: 0,
    ...overrides,
    envelopeLevel: overrides.envelopeLevel ?? overrides.currentLevel ?? 1,
    rankNeedDelta: overrides.rankNeedDelta ?? overrides.needDelta ?? 2,
  };
}

/** A grid tick 5 s after a batch: calm has NOT run (the gate the lane waives). */
function plan(acs: AcView[], overrides: Partial<RaiseInput> = {}) {
  const smoothed = overrides.smoothedAmps ?? 12;
  return planRaise({
    acs,
    headroomAmps: 30 - 0.1 - 0.2 - smoothed, // to the resting ceiling, 29.7A
    smoothedAmps: smoothed,
    rampDebitAmps: 0,
    nonAcAmps: 0, // grid: the pipeline passes 0 here (the house rides in the lane)
    flickerMarginAmps: 0,
    cutAnchorAmps: 0,
    commandedCutAmps: 0,
    limitAmps: 30,
    calmMs: 5_000,
    config: cfg,
    book: {},
    source: "grid",
    now: T,
    pacing: initialPacingState("grid"),
    roomyLane: { houseAmps: 6 },
    ...overrides,
  });
}

const kinds = (commands: Command[]) => commands.map((c) => `${c.kind}:${c.deviceId}`);
const blocked = (out: ReturnType<typeof plan>, id: string) =>
  out.decisions.filter((d) => d.deviceId === id && d.blockedBy != null).map((d) => d.blockedBy);

describe("G2 grid roomy lane: waives the calm gate only with spare on BOTH tests", () => {
  it("a raise ships inside the calm window and says why", () => {
    const out = plan([ac("a")]);
    expect(kinds(out.commands)).toEqual(["set_level:a"]);
    const d = out.decisions.find((x) => x.deviceId === "a" && x.action.startsWith("raise L1→L2"));
    expect(d?.detail).toContain("grid roomy lane:");
  });

  it("control: without the lane the same raise waits for calm", () => {
    const out = plan([ac("a")], { roomyLane: undefined });
    expect(out.commands).toEqual([]);
    expect(blocked(out, "a")).toContain("calm");
  });

  it("a restore ships inside the calm window", () => {
    const out = plan([ac("a", { needDelta: 0.2 }), ac("b", { on: false, shed: true })]);
    expect(out.commands).toContainEqual({ deviceId: "b", kind: "power_on", level: 1, reason: "restore" });
    const d = out.decisions.find((x) => x.deviceId === "b" && x.action.startsWith("restore @L"));
    expect(d?.detail).toContain("grid roomy lane:");
  });

  it("refuses when the METER is tight (spare after < 3A), whatever the model says", () => {
    // Resting ceiling 29.7, meter 25: 4.7A available, the 2A step leaves 2.7A.
    const out = plan([ac("a")], { smoothedAmps: 25 });
    expect(out.commands).toEqual([]);
    expect(blocked(out, "a")).toContain("calm");
  });

  it("refuses when the MODEL is tight (grid house + modeled rooms), whatever the meter says", () => {
    // Meter 12 (17.7A available), but house 22 + a L1→L2 (4) + b L1 (2) = 28 → 1.7A spare.
    const out = plan([ac("a"), ac("b", { needDelta: 0.2 })], { roomyLane: { houseAmps: 22 } });
    expect(out.commands).toEqual([]);
    expect(blocked(out, "a")).toContain("calm");
  });

  it("the bar is max(3A, the candidate's own cost): a 5A step needs 5A spare", () => {
    expect(GRID_ROOMY_SPARE_AMPS).toBe(3);
    // big L1→L2 = 5A. Model: house 16 + big L2 (7A) = 23 → 6.7A spare: ships.
    expect(kinds(plan([ac("big")], { roomyLane: { houseAmps: 16 } }).commands)).toEqual(["set_level:big"]);
    // House 18: 25 → 4.7A spare, ≥ 3A but < the 5A step: refused.
    const out = plan([ac("big")], { roomyLane: { houseAmps: 18 } });
    expect(out.commands).toEqual([]);
    expect(blocked(out, "big")).toContain("calm");
  });

  it("counts this batch's own admissions: the second raise sees the first", () => {
    const out = plan([ac("a", { needDelta: 3 }), ac("b", { needDelta: 2 }), ac("c", { needDelta: 1 })], {
      roomyLane: { houseAmps: 15 },
    });
    // 15 + 2+2+2 = 21. a→L2: 23 (6.7). b→L2: 25 (4.7). c→L2: 27 (2.7) refused.
    expect(kinds(out.commands)).toEqual(["set_level:a", "set_level:b"]);
    expect(blocked(out, "c")).toContain("calm");
  });

  it("counts unconfirmed sends: a peer's in-flight L3 is charged at L3", () => {
    // b at L1 with L3 in flight (envelopeLevel 3): house 17 + b 6 + a L2 4 = 27 → 2.7 spare.
    const out = plan([ac("a", { needDelta: 3 }), ac("b", { needDelta: 0.2, envelopeLevel: 3 })], {
      roomyLane: { houseAmps: 17 },
    });
    expect(out.commands).toEqual([]);
  });

  it("the CANDIDATE is charged at its worst unconfirmed level, not its proposed step (Sol, 2026-09-27)", () => {
    // a observes L1 but L3 is in flight (envelopeLevel 3). Its next step is L2,
    // but the firmware may still apply L3: house 21 + L3 (6) = 27 → 2.7A spare,
    // under the 3A bar. Priced at the new L2 it read 25 → 4.7A and cleared it.
    const out = plan([ac("a", { envelopeLevel: 3 })], { roomyLane: { houseAmps: 21 } });
    expect(out.commands).toEqual([]);
    expect(blocked(out, "a")).toContain("calm");
  });

  it("…and an unrestricted level-0 send in flight is priced as unrestricted (8A here)", () => {
    // house 19 + level 0 (2 + 2 × 3 = 8A) = 27 → 2.7A spare: refused.
    const out = plan([ac("a", { envelopeLevel: 0 })], { roomyLane: { houseAmps: 19 } });
    expect(out.commands).toEqual([]);
  });

  it("a same-batch PEER is charged at max(its envelope worst case, the level this batch sent it)", () => {
    // b (hotter) observes L1 with L3 in flight; this batch sends it L2. For a's
    // test b must still count as L3: house 18 + b 6 + a L2 4 = 28 → 1.7A spare.
    // Priced at the batch's L2 it read 26 → 3.7A and a shipped too.
    const out = plan([ac("b", { needDelta: 3, envelopeLevel: 3 }), ac("a", { needDelta: 2 })], {
      roomyLane: { houseAmps: 18 },
    });
    // b's own test: 18 + b L3 (worst) 6 + a L1 2 = 26 → 3.7A: ships.
    expect(kinds(out.commands)).toEqual(["set_level:b"]);
    expect(blocked(out, "a")).toContain("calm");
  });

  it("never on gen, even if a lane is passed", () => {
    const out = plan([ac("a")], { source: "gen", limitAmps: 30 });
    expect(out.commands).toEqual([]);
    expect(blocked(out, "a")).toContain("calm");
  });
});

describe("G2 grid roomy lane: every other gate stays", () => {
  it("a ramping room still waits", () => {
    const out = plan([ac("a", { ramping: true })]);
    expect(out.commands).toEqual([]);
    expect(blocked(out, "a")).toContain("ramping");
  });

  it("backoff still holds a raise", () => {
    let pacing = initialPacingState("grid");
    pacing = noteFailure(pacing, "a", "raise", T - 1_000);
    const out = plan([ac("a")], { pacing });
    expect(out.commands).toEqual([]);
    expect(blocked(out, "a")).toContain("backoff");
  });

  it("victim and funding cooldowns still hold a raise", () => {
    expect(plan([ac("a")], { victimCooldown: () => true }).commands).toEqual([]);
    expect(plan([ac("a")], { fundingCooldown: () => true }).commands).toEqual([]);
  });

  it("a restore that needs peer floor-downs does not ride the lane", () => {
    // Meter 26: b's 2A restore does not fit plain under 29.9 with 3A spare → calm reserve.
    const out = plan([ac("a", { currentLevel: 3, envelopeLevel: 3, needDelta: 0.2 }), ac("b", { on: false, shed: true })], {
      smoothedAmps: 26,
    });
    expect(out.commands).toEqual([]);
  });

  it("a restore's own shed bar still holds it", () => {
    const out = plan([ac("a", { needDelta: 0.2 }), ac("b", { on: false, shed: true })], {
      shedBarAmps: (id) => (id === "b" ? 29 : 0),
    });
    expect(out.commands).toEqual([]);
    expect(blocked(out, "b")).toContain("own shed trough");
  });
});

describe("G2 grid roomy lane: inside the settle window (fundedOnly lane flag)", () => {
  it("a roomy raise ships inside a settle window", () => {
    const out = plan([ac("a")], { fundedOnly: true });
    expect(kinds(out.commands)).toEqual(["set_level:a"]);
  });

  it("…a non-roomy one does not", () => {
    const out = plan([ac("a")], { fundedOnly: true, smoothedAmps: 25 });
    expect(out.commands).toEqual([]);
    // (the calm gate is checked first; either way the raise waits)
    expect(blocked(out, "a").some((b) => b === "calm" || b === "settle window")).toBe(true);
  });

  it("…and without the lane the settle window holds exactly as before", () => {
    const out = plan([ac("a")], { fundedOnly: true, roomyLane: undefined });
    expect(out.commands).toEqual([]);
    expect(blocked(out, "a").some((b) => b === "calm" || b === "settle window")).toBe(true);
    // …and a calm-clear tick without the lane still meets the settle window.
    const calm = plan([ac("a")], { fundedOnly: true, roomyLane: undefined, calmMs: 60_000 });
    expect(calm.commands).toEqual([]);
    expect(blocked(calm, "a")).toContain("settle window");
  });
});
