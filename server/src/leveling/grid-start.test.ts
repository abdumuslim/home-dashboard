// G1 (2026-09-27): the budget-aware grid full start. Owner decision
// 2026-09-27, "Budget-aware full start: YES", superseding the blind 2026-07-23
// "on grid start all to full, then drop" directive. Live 2026-09-26 13:13Z:
// GRID_FULL put all three managed rooms at L3 (models 21.6A) on top of the
// grid-only house the CT02 has measured since 2026-08-29, the meter reached
// 34.4A on a 30A line, and three severe cut batches followed within 21 s.

import { describe, it, expect } from "vitest";
import { planGridFullStart, type GridStartInput } from "./raise.js";
import { initialPacingState, noteAttempt } from "./pacing.js";
import { attemptedWithin, canAttempt, RESTORE_CONFIRM_WAIT_MS } from "./pacing.js";
import { ceilOf } from "./needs.js";
import { DEFAULT_LEVELING_CONFIG_V2, type LevelingConfigV2 } from "./config.js";
import type { AcView, Command } from "./types.js";

const T = 1_000_000;

// base 2, step 2: L1 2A, L2 4A, L3 6A. Ceiling = 30 − 0.1 − 0.2 = 29.7A.
const cfg: LevelingConfigV2 = {
  ...DEFAULT_LEVELING_CONFIG_V2,
  gridLimitAmps: 30,
  marginAmps: 0.1,
  restingBufferAmps: 0.2,
  nearTargetBandC: 0.5,
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

function start(acs: AcView[], overrides: Partial<GridStartInput> = {}) {
  return planGridFullStart({
    acs,
    config: cfg,
    limitAmps: 30,
    houseAmps: 5,
    pacing: initialPacingState("grid"),
    now: T,
    ...overrides,
  });
}

/** The pre-2026-09-27 GRID_FULL command list, verbatim, for the parity checks. */
function blindFullStart(acs: AcView[], pacing = initialPacingState("grid")): Command[] {
  const commands: Command[] = [];
  for (const a of acs) {
    if (!a.managed) continue;
    const ceil = ceilOf(a, cfg.nearTargetBandC);
    if (a.shed && !a.on) {
      if (!canAttempt(pacing, a.deviceId, "restore", T)) continue;
      if (attemptedWithin(pacing, a.deviceId, "restore", RESTORE_CONFIRM_WAIT_MS, T)) continue;
      commands.push({ deviceId: a.deviceId, kind: "power_on", level: ceil, reason: "restore" });
    } else if (a.on && !a.shed && (a.currentLevel === 0 || a.currentLevel < ceil)) {
      commands.push({ deviceId: a.deviceId, kind: "set_level", level: ceil });
    }
  }
  return commands;
}

const levelOf = (commands: Command[], id: string): number | null => {
  const c = commands.find((x) => x.deviceId === id && (x.kind === "set_level" || x.kind === "power_on"));
  return c == null ? null : (c as { level: number }).level;
};

describe("G1 budget-aware grid full start: when everything fits, nothing changes", () => {
  const houses: AcView[][] = [
    [ac("a"), ac("b"), ac("c")],
    [ac("a", { currentLevel: 2 }), ac("b", { currentLevel: 0 }), ac("c", { on: false, shed: true })],
    [ac("a", { needDelta: 0.2 }), ac("b", { manualCap: 2 }), ac("c", { managed: false })],
  ];
  for (const [i, acs] of houses.entries()) {
    it(`house #${i + 1}: the batch is byte-identical to the blind full start`, () => {
      const out = start(acs, { houseAmps: 5 });
      expect(out.commands).toEqual(blindFullStart(acs));
      expect(out.limited).toBe(false);
      expect(out.decisions).toEqual([
        { at: T, action: "grid-entry full start", detail: "all managed ACs → ceiling; reduce on evidence" },
      ]);
    });
  }

  it("restores in flight and backed-off restores are skipped exactly as before", () => {
    let pacing = initialPacingState("grid");
    pacing = noteAttempt(pacing, "c", "restore", T - 5_000);
    const acs = [ac("a"), ac("c", { on: false, shed: true })];
    const out = start(acs, { pacing });
    expect(out.commands).toEqual(blindFullStart(acs, pacing));
    expect(out.commands.some((c) => c.deviceId === "c")).toBe(false);
  });
});

describe("G1 budget-aware grid full start: a tight house (the 2026-09-26 13:13Z shape)", () => {
  it("lifts the hottest room first and gives the next the highest level that fits", () => {
    // house 16 + 3 × L1 (6) = 22. a→L3 (+4) = 26; b→L3 would be 30 > 29.7, L2 → 28;
    // c→L2 would be 30 > 29.7, so c keeps L1.
    const acs = [ac("a", { needDelta: 3 }), ac("b", { needDelta: 2 }), ac("c", { needDelta: 1 })];
    const out = start(acs, { houseAmps: 16 });
    expect(levelOf(out.commands, "a")).toBe(3);
    expect(levelOf(out.commands, "b")).toBe(2);
    expect(levelOf(out.commands, "c")).toBe(null);
    expect(out.limited).toBe(true);
    const detail = out.decisions.map((d) => d.detail ?? "").join(" | ");
    expect(detail).toContain("house 16.0A");
    expect(detail).toContain("> 29.7A");
  });

  it("never cuts: a room that does not fit keeps its current level, and emission order is acs order", () => {
    const acs = [ac("c", { needDelta: 1, currentLevel: 2 }), ac("a", { needDelta: 3 })];
    // house 22 + c L2 (4) + a L1 (2) = 28; a→L2 = 30 > 29.7, nothing fits.
    const out = start(acs, { houseAmps: 22 });
    expect(out.commands.filter((c) => c.kind === "set_level")).toEqual([]);
    expect(out.limited).toBe(true);
  });

  it("an unconfirmed higher level already sent is charged, not re-bought", () => {
    // a has L3 in flight (envelopeLevel 3): charged 6A, so b cannot also take L3.
    const acs = [ac("a", { needDelta: 3, envelopeLevel: 3 }), ac("b", { needDelta: 2 })];
    // house 20 + a 6 + b 2 = 28; b→L2 = 30 > 29.7.
    const out = start(acs, { houseAmps: 20 });
    expect(levelOf(out.commands, "a")).toBe(3); // re-sent as today (the reconciler dedupes)
    expect(levelOf(out.commands, "b")).toBe(null);
  });

  it("manual pins are admitted before the budget is spent, ahead of a hotter room", () => {
    // c is pinned (manualTarget 3) and coolest; it still goes first.
    // house 18 + 6 = 24; c→L3 (+4) = 28; a→L2 = 30 > 29.7 → a keeps L1.
    const acs = [ac("a", { needDelta: 3 }), ac("b", { needDelta: 0.2 }), ac("c", { needDelta: 1, manualTarget: 3 })];
    const out = start(acs, { houseAmps: 18 });
    expect(levelOf(out.commands, "c")).toBe(3);
    expect(levelOf(out.commands, "a")).toBe(null);
  });

  it("configured priority breaks a need tie (acs order)", () => {
    const acs = [ac("b", { needDelta: 2 }), ac("a", { needDelta: 2 })];
    // house 22 + 4 = 26; first in acs (b) → L2 = 28; a → L2 = 30 > 29.7.
    const out = start(acs, { houseAmps: 22 });
    expect(levelOf(out.commands, "b")).toBe(2);
    expect(levelOf(out.commands, "a")).toBe(null);
  });

  it("a shed room restores at the highest level that fits, at or above its floor", () => {
    // house 18 + a L1 2 = 20; a is hotter → L3 (+4) = 24; c restore L2 (4) = 28, L3 = 30 > 29.7.
    const acs = [ac("a", { needDelta: 3 }), ac("c", { on: false, shed: true, needDelta: 2 })];
    const out = start(acs, { houseAmps: 18 });
    expect(out.commands).toContainEqual({ deviceId: "c", kind: "power_on", level: 2, reason: "restore" });
    expect(out.attempts).toEqual([{ deviceId: "c", kind: "restore" }]);
    expect(out.isTurnOn).toBe(true);
  });

  it("a shed room whose floor does not fit stays shed for the ordinary restore path", () => {
    // house 24 + a L1 2 = 26; a→L2 = 28, L3 = 30 no; c floor 2 → 30 > 29.7 → waits.
    const acs = [ac("a", { needDelta: 3 }), ac("c", { on: false, shed: true, needDelta: 2 })];
    const out = start(acs, { houseAmps: 24 });
    expect(out.commands.some((c) => c.deviceId === "c")).toBe(false);
    expect(out.attempts).toEqual([]);
    expect(out.decisions.map((d) => d.detail ?? "").join(" | ")).toContain("c waits");
  });

  it("a level-0 room is still re-capped at its ceiling (never level 0), and priced at its worst", () => {
    // Level 0 is unrestricted and priced past the top level (base + step × max =
    // 8A): house 16 + 8 + b 2 = 26; b→L2 = 28, L3 = 30 > 29.7.
    const acs = [ac("a", { currentLevel: 0, envelopeLevel: 0, needDelta: 3 }), ac("b", { needDelta: 2 })];
    const out = start(acs, { houseAmps: 16 });
    expect(levelOf(out.commands, "a")).toBe(3);
    expect(levelOf(out.commands, "b")).toBe(2);
  });
});
