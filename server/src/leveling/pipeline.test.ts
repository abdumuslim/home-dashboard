// Direct tests for the decision pipeline. Most pipeline behaviour is pinned by
// scenarios.test.ts through the physics harness; these cover the emission-layer
// rules that a whole-house simulation makes awkward to isolate.

import { describe, it, expect } from "vitest";
import { plan, type PlanInput } from "./pipeline.js";
import { DEFAULT_LEVELING_CONFIG_V2, type LevelingConfigV2 } from "./config.js";
import { initialPacingState } from "./pacing.js";
import { updateCost } from "./costs.js";
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
    rampAbsorbedAmps: null,
    reshedPenalized: false,
    satisfiedForMs: 0,
    unmeteredJumpAmps: 0,
    ...overrides,
    envelopeLevel: overrides.envelopeLevel ?? overrides.currentLevel ?? 2,
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
    flickerAmps: 0,
    derateAmps: 0,
    commandedCutCreditAmps: 0,
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

describe("escalation settle (2026-08-02 trim → double shed in 7 seconds)", () => {
  const pinned = (): AcView[] => [
    ac("a", { currentLevel: 1, fanSpeed: 1, needDelta: 2 }),
    ac("b", { currentLevel: 1, fanSpeed: 1, needDelta: 0.3 }),
  ];

  it("holds the shed while a commanded cut is still landing", () => {
    // Live 16:55:29 a fan trim shipped; 16:55:34 and :35 two rooms went off for
    // the ~0.5A that trim had already covered.
    const out = run(pinned(), overMeter([15.3], 15.2), {
      mode: "SETTLING",
      meter: { ...overMeter([15.3], 15.2), commandedCutCreditAmps: 0.6 },
    });
    expect(out.severity).toBe("mild");
    expect(out.commands.filter((c) => c.kind === "power_off")).toHaveLength(0);
    expect(out.decisions.some((d) => d.blockedBy === "escalation settle")).toBe(true);
  });

  it("does NOT hold a severe breach", () => {
    const out = run(pinned(), overMeter([16.5], 15.2), {
      mode: "SETTLING",
      meter: { ...overMeter([16.5], 15.2), commandedCutCreditAmps: 0.6 },
    });
    expect(out.severity).toBe("severe");
    expect(out.commands.filter((c) => c.kind === "power_off")).toHaveLength(1);
  });

  it("a fan trim is credited what the planner claimed, not zero", () => {
    // The credit is what shrinks the next evaluation's demand; at zero the
    // reducer re-demanded amps that were already leaving.
    const out = run([ac("a", { currentLevel: 1, fanSpeed: 5, needDelta: 2 })], overMeter([15.2], 15.1));
    expect(out.commands.some((c) => c.kind === "set_fan" && c.reason === "trim")).toBe(true);
    expect(out.commandedCutAmps).toBeGreaterThan(0);
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

  it("the same overshoot DOES shed once the smoothed meter clears the blanking band", () => {
    const out = run(pinned(true), overMeter([15.9], 15.6));
    expect(out.commands.filter((c) => c.kind === "power_off")).toHaveLength(1);
  });

  it("a smoothed crossing INSIDE the flicker band is still blanked (2026-08-02)", () => {
    // Live: a room was shed for smoothed crossings of 0.02–0.31A over the
    // limit, five times in fifteen minutes, while its compressor was still
    // ramping. A fresh turn-on gets the same noise tolerance steady state does.
    const out = run(pinned(true), overMeter([15.9], 15.3));
    expect(out.commands.filter((c) => c.kind === "power_off")).toHaveLength(0);
    expect(out.decisions.some((d) => d.blockedBy === "turn-on inrush")).toBe(true);
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

describe("commandedCutAmps — the single collapse-credit source", () => {
  it("an over-limit batch reports its cuts at MODEL price, not the learned jump", () => {
    // a: base 2 step 2 → L3 6.0, L2 4.0. One step down = 2.0A of model.
    // The learned book says the 2>3 jump was 5.5A; crediting THAT would let a
    // real cliff hide behind our own cut.
    const book = updateCost({}, "a", "gen", "level:2>3", 5.5, T);
    const out = run([ac("a", { currentLevel: 3, needDelta: 2 })], overMeter([15.5]), { book });
    expect(levelsFor(out.commands, "a")).toEqual([{ deviceId: "a", kind: "set_level", level: 2 }]);
    expect(out.commandedCutAmps).toBeCloseTo(2.0, 5);
  });

  it("a shed is credited its whole modeled draw", () => {
    const out = run([ac("a", { currentLevel: 3, needDelta: 0 }), ac("b", { currentLevel: 1, needDelta: 4 })], overMeter([19, 19.5]));
    expect(out.commands.some((c) => c.kind === "power_off" && c.deviceId === "a")).toBe(true);
    expect(out.commandedCutAmps).toBeGreaterThanOrEqual(6.0);
  });

  it("a pure raise batch credits nothing (an up-move can never claim a cut)", () => {
    const out = run([ac("a", { currentLevel: 1, needDelta: 3 })], meter({ smoothedAmps: 4, calmMs: 300_000 }));
    expect(out.commands).toEqual([{ deviceId: "a", kind: "set_level", level: 2 }]);
    expect(out.commandedCutAmps).toBe(0);
  });

  it("a restore that pulls a peer to floors credits the peer's cut (was invisible before)", () => {
    // b is shed and can only return if a comes down; that batch reports a NET
    // delta of 0, so the old `expectedDeltaAmps < 0` credit never fired for it.
    const out = run(
      [ac("a", { currentLevel: 3, needDelta: 0.2 }), ac("b", { on: false, shed: true, currentLevel: 1, needDelta: 5 })],
      // 13.5 + b's 2.0 turn-on = 15.5 > the restore ceiling, so the restore is
      // only feasible if a comes down to its floor first.
      meter({ smoothedAmps: 13.5, calmMs: 300_000 }),
    );
    const cut = out.commands.find((c) => c.kind === "set_level" && c.deviceId === "a");
    const restore = out.commands.find((c) => c.kind === "power_on" && c.deviceId === "b");
    expect(cut).toBeDefined();
    expect(restore).toBeDefined();
    expect(out.expectedDeltaAmps).toBe(0); // net-zero on paper — the old blind spot
    expect(out.commandedCutAmps).toBeGreaterThan(0);
  });
});

describe("idle demote precedence in the calm branch", () => {
  const satisfied = (id: string, o: Partial<AcView> = {}) =>
    ac(id, { currentLevel: 3, needDelta: 0.2, satisfiedForMs: 300_000, fanSpeed: 1, ...o });

  it("reclaims a satisfied room's dormant levels when there is nothing to raise", () => {
    const out = run([satisfied("a")], meter({ smoothedAmps: 6, calmMs: 300_000 }));
    expect(out.reason).toBe("demote");
    expect(out.commands).toEqual([{ deviceId: "a", kind: "set_level", level: 1 }]);
    expect(out.commandedCutAmps).toBeGreaterThan(0);
  });

  it("a raise wins the batch — funding demotes ride with it, not against it", () => {
    const out = run(
      [satisfied("a"), ac("b", { currentLevel: 1, needDelta: 3 })],
      meter({ smoothedAmps: 6, calmMs: 300_000 }),
    );
    expect(out.reason).toBe("raise");
    expect(out.commands.some((c) => c.kind === "set_level" && c.deviceId === "b" && c.level === 2)).toBe(true);
  });

  it("PARKS under a restore reservation — a demote batch would rewind the shared calm clock", () => {
    // b is shed and its restore is gated by calm, so it reserves amps. Even
    // though demoting a would FREE amps, churning here re-arms the calm gate
    // the parked restore is counting down.
    const out = run(
      [satisfied("a"), ac("b", { on: false, shed: true, currentLevel: 1, needDelta: 5 })],
      meter({ smoothedAmps: 13.5, calmMs: 1_000 }),
    );
    expect(out.decisions.some((d) => d.blockedBy === "restore reservation")).toBe(true);
    expect(out.commands.filter((c) => c.kind === "set_level" && c.deviceId === "a")).toHaveLength(0);
    expect(out.reason).not.toBe("demote");
  });

  it("outranks a fan restore (dormant compressor levels are the cheaper amps)", () => {
    const held = { a: { deviceId: "a", originalFan: 0, lastSetFan: 1, heldAt: T - 600_000 } };
    const m = meter({ smoothedAmps: 6, calmMs: 600_000 });
    // Control: with nothing to demote, that same hold DOES produce a fan step —
    // so the assertion below is a real ordering, not an absent alternative.
    const fanOnly = run([ac("a", { currentLevel: 1, fanSpeed: 1, needDelta: 0 })], m, { fanHolds: held });
    expect(fanOnly.reason).toBe("fan_restore");

    const out = run([satisfied("a")], m, { fanHolds: held });
    expect(out.reason).toBe("demote");
  });
});

// The clamp lives in invariantCorrections, so it must reach the batch from
// every non-COLLAPSED branch — which is the whole point of putting it there.
// A gen turn-on is over-limit by definition on a 15A line, so the branch that
// matters most is the reducer's (live 2026-07-30 05:51: the only batches that
// ran for the next two minutes were `over_mild` and `over_severe`).
describe("gen start clamp reaches the batch (2026-07-30)", () => {
  const starting = (overrides: Partial<AcView> = {}) =>
    ac("a", { currentLevel: 3, startBaselineAmps: 13.2, ...overrides });

  it("ships inside an over-limit batch, and converges on the floor after it", () => {
    // The documented precedence stands: one command per device, and the
    // REDUCER's choice is the one that lands (dedupe keeps the last writer).
    // A shallower reducer cut is not a lost clamp — the window stays open, so
    // the very next non-over tick finishes the job.
    const over = run([starting(), ac("b", { currentLevel: 1 })], overMeter([15.5]));
    expect(over.reason).toBe("over_mild");
    const cut = levelsFor(over.commands, "a");
    expect(cut).toHaveLength(1);
    expect(cut[0].level).toBeLessThan(3);

    const after = run(
      [starting({ currentLevel: cut[0].level }), ac("b", { currentLevel: 1 })],
      meter({ smoothedAmps: 6, calmMs: 600_000 }),
    );
    expect(levelsFor(after.commands, "a")).toEqual([{ deviceId: "a", kind: "set_level", level: 1 }]);
  });

  it("ships on a calm tick, alongside the raise phase", () => {
    const out = run([starting(), ac("b", { currentLevel: 1 })], meter({ smoothedAmps: 6, calmMs: 600_000 }));
    expect(levelsFor(out.commands, "a")).toEqual([{ deviceId: "a", kind: "set_level", level: 1 }]);
  });

  it("ships while SETTLING, and credits the collapse detector for what it cut", () => {
    const out = run([starting()], meter(), { mode: "SETTLING" });
    expect(out.reason).toBe("settling");
    expect(levelsFor(out.commands, "a")).toEqual([{ deviceId: "a", kind: "set_level", level: 1 }]);
    // L3 → L1 on a base-2/step-2 model = 4A off the line. Uncredited, a fall
    // that size is what a phantom collapse latches on (invariant 11).
    expect(out.commandedCutAmps).toBeCloseTo(4, 5);
  });

  it("ships on a hold tick (the deliberate near-limit ride)", () => {
    const out = run([starting()], meter({ smoothedAmps: 14.95, calmMs: 0 }));
    expect(out.reason).toBe("hold");
    expect(levelsFor(out.commands, "a")).toHaveLength(1);
    expect(out.commandedCutAmps).toBeGreaterThan(0);
  });

  it("never fires into a collapsed line", () => {
    const out = run([starting()], meter(), { mode: "COLLAPSED" });
    expect(out.commands).toHaveLength(0);
  });

  it("loses the dedupe to a reducer that wants to cut deeper", () => {
    // Both producers target this AC; the executor sends in array order, so the
    // LAST command must be the reducer's — never the clamp re-lifting a room
    // the meter just objected to.
    const out = run([starting({ minLevel: 2, needDelta: 4 })], overMeter([18]));
    const levels = levelsFor(out.commands, "a");
    expect(levels).toHaveLength(1);
    expect(levels[0].level).toBeLessThanOrEqual(2);
  });
});
