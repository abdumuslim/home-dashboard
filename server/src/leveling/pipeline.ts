// The ONE decision pipeline for leveling v2 — this file is the spec.
//
//   plan(input) → { commands, decisions, expected, reason, … }
//
// Every situation flows through here: normal fill, mild/severe/extreme
// over-limit, changeover floors, collapse, restores, warm restores, manual
// pins, fan trim. Mode overrides come first, then pressure, then the target
// planners, then emission. Severity only scales the deficit and the
// escalation tier — there is no separate emergency planner (v1 shipped two).

import type { AcView, Command, Decision, MeterView, Mode, Plan, Severity } from "./types.js";
import type { LevelingConfigV2 } from "./config.js";
import { limitFor } from "./config.js";
import type { CostBook } from "./costs.js";
import { assessPressure } from "./pressure.js";
import { planReduction } from "./reduce.js";
import { invariantCorrections, planRaise } from "./raise.js";
import { planFanRestore, recordFanCut, type FanHolds } from "./fan-trim.js";
import { floorOf } from "./needs.js";
import type { PacingState } from "./pacing.js";

/** Outcome-grading delays: when the batch's meter effect is judged. */
export const GRADE_LEVEL_MS = 45_000;
export const GRADE_TURN_ON_MS = 270_000;
export const GRADE_FAN_MS = 20_000;

export interface PlanInput {
  now: number;
  config: LevelingConfigV2;
  mode: Mode;
  meter: MeterView;
  /** Managed AC views, pre-sorted by priority (highest first). */
  acs: AcView[];
  book: CostBook;
  pacing: PacingState;
  fanHolds: FanHolds;
  /** Proactive projection extra (an AC just turned on near the limit). */
  projectedExtraAmps?: number;
}

export interface PlanOutput extends Plan {
  severity: Severity | null;
  requiredAmps: number | null;
  /** Updated fan-hold records (cuts recorded, restore steps advanced). */
  fanHolds: FanHolds;
  /** Raise/restore attempts to stamp into pacing (blame windows). */
  attempts: Array<{ deviceId: string; kind: "raise" | "restore" }>;
  /** True when this plan ships only fan commands (short settle window). */
  fanOnly: boolean;
}

function emptyPlan(input: PlanInput, reason: string, decisions: Decision[] = []): PlanOutput {
  return {
    commands: [],
    expectedDeltaAmps: 0,
    compareAfter: 0,
    decisions,
    reason,
    severity: null,
    requiredAmps: null,
    fanHolds: input.fanHolds,
    attempts: [],
    fanOnly: false,
  };
}

export function plan(input: PlanInput): PlanOutput {
  const { now, config, mode, meter, acs, book, pacing } = input;
  if (meter.source === "none") return emptyPlan(input, "no_power");
  const source = meter.source;
  const limit = limitFor(config, source);

  // COLLAPSED: the line is (probably) dead — no commands into it. Raises,
  // restores, corrections and even reductions wait; the latch clears on
  // recovery or its 5-min cap, and FLOORS handles the gen re-entry.
  if (mode === "COLLAPSED") {
    return emptyPlan(input, "collapsed", [
      { at: now, action: "all", blockedBy: "power collapse latched" },
    ]);
  }

  const pressure = assessPressure(meter, config, { projectedExtraAmps: input.projectedExtraAmps });
  const onManaged = acs.filter((a) => a.on && a.managed && !a.shed);
  const corrections = invariantCorrections(acs, now);

  // ---- Over-limit: the one graduated reducer, at every severity ----
  if (pressure.kind === "over") {
    const requireShed = pressure.severity === "extreme";
    const reduction = planReduction({
      acs: onManaged,
      requiredAmps: pressure.requiredAmps,
      requireShed,
      fanTrimEnabled: config.fanTrimEnabled,
      book,
      config,
      source,
      now,
    });
    const commands: Command[] = [];
    let fanHolds = input.fanHolds;
    // Reductions first (make room), sheds last in emission order — executor
    // sends in array order.
    for (const [deviceId, level] of Object.entries(reduction.desiredLevels)) {
      commands.push({ deviceId, kind: "set_level", level });
    }
    for (const cut of reduction.fanCuts) {
      const ac = onManaged.find((a) => a.deviceId === cut.deviceId);
      if (ac == null) continue;
      commands.push({ deviceId: cut.deviceId, kind: "set_fan", fan: cut.target, reason: "trim" });
      fanHolds = recordFanCut(fanHolds, ac, cut.target, now);
    }
    for (const deviceId of reduction.toShed) {
      commands.push({ deviceId, kind: "power_off", reason: "shed" });
    }
    // FLOORS mode additionally re-asserts floors on anything the reducer kept above.
    if (mode === "FLOORS") {
      for (const ac of onManaged) {
        if (reduction.toShed.includes(ac.deviceId)) continue;
        const floor = floorOf(ac);
        const kept = reduction.idealLevels[ac.deviceId] ?? ac.currentLevel;
        if (kept > floor && !(ac.deviceId in reduction.desiredLevels)) {
          commands.push({ deviceId: ac.deviceId, kind: "set_level", level: floor });
        }
      }
    }
    const decisions: Decision[] = [
      {
        at: now,
        action: `reduce ${pressure.requiredAmps.toFixed(1)}A (${pressure.severity})`,
        detail: `est savings ${reduction.estimatedSavingsAmps.toFixed(1)}A, satisfied=${reduction.satisfied}`,
      },
      ...corrections.decisions,
    ];
    return {
      commands: [...corrections.commands, ...commands],
      expectedDeltaAmps: -reduction.estimatedSavingsAmps,
      compareAfter: now + GRADE_LEVEL_MS,
      decisions,
      reason: `over_${pressure.severity}`,
      severity: pressure.severity,
      requiredAmps: pressure.requiredAmps,
      fanHolds,
      attempts: [],
      fanOnly: commands.length > 0 && commands.every((c) => c.kind === "set_fan") && corrections.commands.length === 0,
    };
  }

  // ---- FLOORS (no over-pressure): hold everyone at floors, re-asserting
  // against the OBSERVED shadow until it confirms (reconciler paces resends).
  if (mode === "FLOORS") {
    const commands: Command[] = [];
    for (const ac of onManaged) {
      const floor = floorOf(ac);
      if (ac.currentLevel === 0 || ac.currentLevel > floor) {
        commands.push({ deviceId: ac.deviceId, kind: "set_level", level: floor });
      }
    }
    return {
      ...emptyPlan(input, "floors", [
        { at: now, action: "raises/restores", blockedBy: "gen-entry floors" },
      ]),
      commands,
      compareAfter: commands.length > 0 ? now + GRADE_LEVEL_MS : 0,
    };
  }

  // ---- SETTLING: a batch is in flight — corrections only, no new spending.
  if (mode === "SETTLING") {
    return {
      ...emptyPlan(input, "settling", [{ at: now, action: "raises/restores", blockedBy: "settle window" }]),
      commands: corrections.commands,
      decisions: [...corrections.decisions, { at: now, action: "raises/restores", blockedBy: "settle window" }],
      compareAfter: corrections.commands.length > 0 ? now + GRADE_LEVEL_MS : 0,
    };
  }

  // ---- NORMAL + calm: spend headroom (restore ≫ warm ≫ raise ≫ fan restore).
  if (pressure.kind === "calm") {
    const raisePlan = planRaise({
      acs,
      headroomAmps: pressure.headroomAmps,
      smoothedAmps: meter.smoothedAmps,
      limitAmps: limit,
      calmMs: meter.calmMs,
      config,
      book,
      source,
      now,
      pacing,
    });
    if (raisePlan.commands.length > 0 || corrections.commands.length > 0) {
      return {
        commands: [...corrections.commands, ...raisePlan.commands],
        expectedDeltaAmps: 0, // graded per-command by the journal, not batch-summed here
        compareAfter: now + (raisePlan.isTurnOn ? GRADE_TURN_ON_MS : GRADE_LEVEL_MS),
        decisions: [...corrections.decisions, ...raisePlan.decisions],
        reason: raisePlan.isTurnOn ? "restore" : "raise",
        severity: null,
        requiredAmps: null,
        fanHolds: input.fanHolds,
        attempts: raisePlan.attempts,
        fanOnly: false,
      };
    }
    // Nothing to raise — a held fan may climb one sweet-spot step.
    const fanStep = planFanRestore(input.fanHolds, acs, {
      calmMs: meter.calmMs,
      headroomAmps: pressure.headroomAmps,
      book,
      source,
      now,
    });
    if (fanStep != null) {
      return {
        commands: [fanStep.command],
        expectedDeltaAmps: 0,
        compareAfter: now + GRADE_FAN_MS,
        decisions: [...raisePlan.decisions, { at: now, deviceId: fanStep.command.deviceId, action: "fan restore step" }],
        reason: "fan_restore",
        severity: null,
        requiredAmps: null,
        fanHolds: fanStep.holds,
        attempts: [],
        fanOnly: true,
      };
    }
    return { ...emptyPlan(input, "idle", raisePlan.decisions) };
  }

  // ---- hold: the deliberate near-limit ride — do nothing, on purpose.
  return {
    ...emptyPlan(input, "hold"),
    commands: corrections.commands,
    decisions: corrections.decisions,
    compareAfter: corrections.commands.length > 0 ? now + GRADE_LEVEL_MS : 0,
  };
}
