// Direct tests for the decision pipeline. Most pipeline behaviour is pinned by
// scenarios.test.ts through the physics harness; these cover the emission-layer
// rules that a whole-house simulation makes awkward to isolate.

import { describe, it, expect } from "vitest";
import { plan, type PlanInput } from "./pipeline.js";
import { DEFAULT_LEVELING_CONFIG_V2, type LevelingConfigV2 } from "./config.js";
import { initialPacingState } from "./pacing.js";
import type { AcView, Command, MeterView } from "./types.js";

const T = 1_000_000;

const cfg: LevelingConfigV2 = {
  ...DEFAULT_LEVELING_CONFIG_V2,
  enabled: true,
  controller: "v2",
  genLimitAmps: 15,
  marginAmps: 0.1,
  fanTrimEnabled: true,
  ampModels: { a: { baseAmps: 2, stepAmps: 2 }, b: { baseAmps: 2, stepAmps: 2 } },
  genAmpModels: { a: { baseAmps: 2, stepAmps: 2 }, b: { baseAmps: 2, stepAmps: 2 } },
};

function ac(id: string, overrides: Partial<AcView> = {}): AcView {
  return {
    deviceId: id,
    name: id,
    on: true,
    managed: true,
    shed: false,
    maxLevel: 3,
    currentLevel: 2,
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
    reshedPenalized: false,
    ...overrides,
  };
}

function meter(overrides: Partial<MeterView> = {}): MeterView {
  return {
    source: "gen",
    smoothedAmps: 12,
    latestAmps: 12,
    sampleCount: 4,
    calmMs: 0,
    overLimitBudget: 5,
    overLimitReadings: [],
    collapsed: false,
    frozen: false,
    derateAmps: 0,
    ...overrides,
  };
}

/** Bucket empty with these over-limit readings → assessPressure returns "over". */
function overMeter(readings: number[], smoothedAmps = 12): MeterView {
  return meter({ smoothedAmps, overLimitBudget: 0, overLimitReadings: readings });
}

function run(acs: AcView[], m: MeterView, overrides: Partial<PlanInput> = {}) {
  return plan({
    now: T,
    config: cfg,
    mode: "NORMAL",
    meter: m,
    acs,
    book: {},
    pacing: initialPacingState("gen"),
    fanHolds: {},
    ...overrides,
  });
}

const levelsFor = (commands: Command[], deviceId: string) =>
  commands.filter((c): c is Extract<Command, { kind: "set_level" }> => c.kind === "set_level" && c.deviceId === deviceId);

describe("batch command dedupe (live journal row 2701, 2026-07-25 05:33)", () => {
  it("a level-0 AC in an over-limit batch gets ONE set_level, not one per producer", () => {
    // Both the never-level-0 correction and the reducer's re-entry target this
    // AC; the live batch shipped `set_level 3` twice for the same device.
    const out = run([ac("a", { currentLevel: 0 })], overMeter([15.5]));
    expect(out.reason).toBe("over_mild");
    expect(levelsFor(out.commands, "a")).toHaveLength(1);
  });

  it("dedupe keeps the LAST command, so the reducer wins over a correction", () => {
    const out = run([ac("a", { currentLevel: 0, reachableCap: 2 })], overMeter([15.5]));
    const levels = levelsFor(out.commands, "a");
    expect(levels).toHaveLength(1);
    expect(levels[0].level).toBe(2);
  });

  it("a single-actuator batch stays single-actuator (cost grading depends on it)", () => {
    const out = run([ac("a", { currentLevel: 0 })], overMeter([15.5]));
    expect(out.commands.filter((c) => c.kind !== "set_fan")).toHaveLength(1);
  });
});

describe("turn-on inrush blanking (2026-07-25 restore-bounce storm)", () => {
  // Both rooms pinned at their floor with no fan slack → a shed is the only
  // cover the reducer can find, exactly like the live 20:23 state.
  const pinned = (ramping: boolean): AcView[] => [
    ac("a", { currentLevel: 1, fanSpeed: 1, needDelta: 2 }),
    ac("b", { currentLevel: 1, fanSpeed: 1, needDelta: 0.3, ramping }),
  ];

  it("no shed while a compressor ramps and the smoothed meter is under the limit", () => {
    const out = run(pinned(true), overMeter([15.9], 12));
    expect(out.severity).toBe("mild");
    expect(out.commands.filter((c) => c.kind === "power_off")).toHaveLength(0);
    expect(out.decisions.some((d) => d.blockedBy === "turn-on inrush")).toBe(true);
  });

  it("the same overshoot DOES shed when nothing is ramping", () => {
    const out = run(pinned(false), overMeter([15.9], 12));
    expect(out.commands.filter((c) => c.kind === "power_off")).toHaveLength(1);
  });

  it("the same overshoot DOES shed once the smoothed meter crosses the limit", () => {
    const out = run(pinned(true), overMeter([15.9], 15.4));
    expect(out.commands.filter((c) => c.kind === "power_off")).toHaveLength(1);
  });

  it("a severe overshoot is never blanked — a real breach still sheds", () => {
    const out = run(pinned(true), overMeter([16.5], 12));
    expect(out.severity).toBe("severe");
    expect(out.commands.filter((c) => c.kind === "power_off")).toHaveLength(1);
  });

  it("when a shed IS taken, the lone ramping room is the one undone", () => {
    // `a` is the bystander and would otherwise be a candidate; `b`'s own
    // turn-on caused this, so `b` pays.
    const out = run(pinned(true), overMeter([16.5], 12));
    const offs = out.commands.filter((c) => c.kind === "power_off");
    expect(offs.map((c) => c.deviceId)).toEqual(["b"]);
    expect(out.decisions.some((d) => d.action === "shed preference" && d.deviceId === "b")).toBe(true);
  });
});

// The ramp debit is computed here (gen only) and fences every spender in the
// calm branch — including the fan restore, which has no cost model of its own.
describe("ramp debit fencing (2026-07-26 gen trip #1)", () => {
  const held = { a: { deviceId: "a", originalFan: 0, lastSetFan: 1, heldAt: T - 600_000 } };

  it("a held fan does not climb back into a ramping compressor's committed amps", () => {
    // b came on 10s ago at L1 (model draw 2A) with the meter still at its
    // pre-start 13.0A → 2A committed, 1.6A of resting headroom. Live: Najat's
    // fan went 1→7 and Abdu's →auto 12s apart, both mid-ramp, and the house
    // crossed the breaker 65s later.
    const acs = [
      ac("a", { currentLevel: 1, fanSpeed: 1, needDelta: 0 }),
      ac("b", { currentLevel: 1, needDelta: 0, ramping: true, rampBaselineAmps: 13.0 }),
    ];
    const blocked = run(acs, meter({ smoothedAmps: 13.0, calmMs: 300_000 }), { fanHolds: held });
    expect(blocked.commands).toEqual([]);

    // Once the meter has absorbed b's draw the same step is allowed.
    const absorbed = run(
      [acs[0], ac("b", { currentLevel: 1, needDelta: 0, ramping: true, rampBaselineAmps: 11.0 })],
      meter({ smoothedAmps: 13.0, calmMs: 300_000 }),
      { fanHolds: held },
    );
    expect(absorbed.reason).toBe("fan_restore");
    expect(absorbed.commands).toEqual([{ deviceId: "a", kind: "set_fan", fan: 0, reason: "trim_restore" }]);
  });

  it("grid is deliberately not ramp-debited (it starts every AC full by directive)", () => {
    const gridCfg = { ...cfg, gridLimitAmps: 27 };
    const out = run(
      [
        ac("a", { currentLevel: 1, fanSpeed: 1, needDelta: 0 }),
        ac("b", { currentLevel: 1, needDelta: 0, ramping: true, rampBaselineAmps: 13.0 }),
      ],
      meter({ source: "grid", smoothedAmps: 13.0, calmMs: 300_000 }),
      { fanHolds: held, config: gridCfg },
    );
    expect(out.commands).toEqual([{ deviceId: "a", kind: "set_fan", fan: 0, reason: "trim_restore" }]);
  });

  it("the derate lowers every ceiling the pipeline works against", () => {
    // 14.2A is calm under the 15A rating but over-limit against a 1A derate.
    const acs = [ac("a", { currentLevel: 2 }), ac("b", { currentLevel: 2 })];
    const calm = run(acs, meter({ smoothedAmps: 14.2, calmMs: 300_000 }));
    expect(calm.reason).not.toMatch(/^over/);
    const derated = run(
      acs,
      meter({ smoothedAmps: 14.2, calmMs: 300_000, derateAmps: 1, overLimitBudget: 0, overLimitReadings: [14.2, 14.3] }),
    );
    expect(derated.reason).toMatch(/^over/);
  });
});
