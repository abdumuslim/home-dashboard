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
import { effectiveLimit } from "./config.js";
import type { CostBook } from "./costs.js";
import { commandedCutAmpsOf } from "./costs.js";
import { assessPressure } from "./pressure.js";
import { planReduction } from "./reduce.js";
import { invariantCorrections, planRaise, rampDebitAmps } from "./raise.js";
import { planFanRestore, recordFanCut, recordGentleRestoreHold, type FanHolds } from "./fan-trim.js";
import { ceilOf, floorOf } from "./needs.js";
import { planIdleDemotes } from "./demote.js";
import { attemptedWithin, canAttempt, RESTORE_CONFIRM_WAIT_MS, type PacingState } from "./pacing.js";

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
  /**
   * Levels commanded to a device whose confirm has not been observed yet, with
   * their send times — the reconciler's view, injected so the pipeline stays
   * pure. Used for demote confirm-or-resend spacing. Defaults to "nothing in
   * flight" when the caller does not supply it.
   */
  inFlight?: (deviceId: string) => ReadonlyArray<{ level: number; sentAt: number }>;
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

/**
 * One command per device+kind, last writer wins. The corrections block and the
 * reducer/raise blocks are computed independently and can land on the same AC:
 * live journal row 2701 (2026-07-25 05:33) shipped `set_level 3` TWICE for one
 * device — harmless on the wire, but it made the batch multi-command, which
 * silently disables single-actuator cost grading and misreads the journal.
 * Emission order is preserved (the executor sends in array order) and the LAST
 * command is what the device would have ended at anyway, so in an over-limit
 * batch the reducer wins over a correction and in a calm batch a raise wins
 * over a floor lift — both the intended precedence.
 */
function dedupeCommands(commands: Command[]): Command[] {
  const lastIndex = new Map<string, number>();
  commands.forEach((c, i) => lastIndex.set(`${c.deviceId}|${c.kind}`, i));
  return commands.filter((c, i) => lastIndex.get(`${c.deviceId}|${c.kind}`) === i);
}

function emptyPlan(input: PlanInput, reason: string, decisions: Decision[] = []): PlanOutput {
  return {
    commands: [],
    expectedDeltaAmps: 0,
    commandedCutAmps: 0,
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
  // Derated while a recent collapse is still cooling — the limit the hardware
  // has actually been holding, not the one it is rated for.
  const limit = effectiveLimit(config, source, meter.derateAmps);

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
    // Inrush blanking (2026-07-25 restore-bounce storm). A compressor that just
    // started draws its startup transient for ~1 min before settling to its cap.
    // Those raw readings drain the leaky bucket while the SMOOTHED meter is
    // still well under the limit: six live sheds fired at 11.9–12.6A on a 15A
    // gen, five of them within 14s of the restore that caused them, and the
    // sixth shed a bystander room the user then found off. While a compressor
    // is ramping and the smoothed meter has NOT crossed the limit, a MILD
    // overshoot may still cut levels and trim fans — but it may not shed a whole
    // room for a transient that is about to decay on its own. Severe and extreme
    // are deliberately untouched: a real breach still sheds immediately.
    const rampingNow = onManaged.filter((a) => a.ramping);
    const inrushBlanking =
      pressure.severity === "mild" && meter.smoothedAmps <= limit && rampingNow.length > 0;
    // If a shed IS unavoidable while exactly one room is ramping (its own
    // turn-on caused this), undo THAT turn-on rather than exporting the shed to
    // a bystander — the re-shed penalty otherwise protects the bouncing room and
    // moves the pain to a peer (live: Abdu, 21:03:14).
    const preferShed =
      !inrushBlanking && rampingNow.length === 1 && onManaged.length > 1
        ? rampingNow[0].deviceId
        : null;
    const reduction = planReduction({
      acs: onManaged,
      requiredAmps: pressure.requiredAmps,
      requireShed,
      allowShed: !inrushBlanking,
      preferShed,
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
      ...(inrushBlanking
        ? [
            {
              at: now,
              action: "shed",
              blockedBy: "turn-on inrush",
              detail: `smoothed ${meter.smoothedAmps.toFixed(1)}A ≤ ${limit.toFixed(1)}A, ${rampingNow.length} ramping`,
            } satisfies Decision,
          ]
        : []),
      ...(preferShed != null
        ? [
            {
              at: now,
              deviceId: preferShed,
              action: "shed preference",
              detail: "its own turn-on caused this — undo it, not a peer",
            } satisfies Decision,
          ]
        : []),
      ...corrections.decisions,
    ];
    const finalCommands = dedupeCommands([...corrections.commands, ...commands]);
    return {
      commands: finalCommands,
      expectedDeltaAmps: -reduction.estimatedSavingsAmps,
      commandedCutAmps: commandedCutAmpsOf(finalCommands, onManaged, config, source),
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

  // ---- GRID_FULL (no over-pressure): grid entry — drive every ON managed AC
  // to its ceiling in one batch and restore sheds at theirs ("on grid, start
  // all to full, then drop when needed" — user 2026-07-23). The over-limit
  // branch above still wins whenever the meter objects, and a bucket_empty
  // ends the window entirely (modes.ts) so entry policy never fights the
  // reducer. Deliberately NOT envelope-guarded: grid is the roomy source and
  // full-start is an explicit user directive; the reducer is the safety.
  if (mode === "GRID_FULL") {
    const commands: Command[] = [];
    const attempts: Array<{ deviceId: string; kind: "raise" | "restore" }> = [];
    let isTurnOn = false;
    for (const ac of acs) {
      if (!ac.managed) continue;
      const ceil = ceilOf(ac, config.nearTargetBandC);
      if (ac.shed && !ac.on) {
        // Restores ride the pacing backoff so a dead cloud can't be hammered.
        if (!canAttempt(pacing, ac.deviceId, "restore", now)) continue;
        // In flight, shadow not confirmed yet — don't re-send every batch.
        if (attemptedWithin(pacing, ac.deviceId, "restore", RESTORE_CONFIRM_WAIT_MS, now)) continue;
        commands.push({ deviceId: ac.deviceId, kind: "power_on", level: ceil, reason: "restore" });
        attempts.push({ deviceId: ac.deviceId, kind: "restore" });
        isTurnOn = true;
      } else if (ac.on && !ac.shed && (ac.currentLevel === 0 || ac.currentLevel < ceil)) {
        commands.push({ deviceId: ac.deviceId, kind: "set_level", level: ceil });
      }
    }
    return {
      ...emptyPlan(input, "grid_full", [
        { at: now, action: "grid-entry full start", detail: "all managed ACs → ceiling; reduce on evidence" },
      ]),
      commands,
      attempts,
      compareAfter: commands.length > 0 ? now + (isTurnOn ? GRADE_TURN_ON_MS : GRADE_LEVEL_MS) : 0,
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
    // Committed-but-unmetered draw of ramping compressors. GEN only, the same
    // split the physics envelope uses: grid starts every AC FULL by explicit
    // user directive and leans on the reducer as its safety, so charging a
    // ramp there would fight the entry policy on the roomy source. On gen the
    // budget is ~15A against ~8A of non-AC load — there is nothing to spare for
    // load the meter has not caught up with (2026-07-26 trip #1).
    const rampDebit = source === "gen" ? rampDebitAmps(onManaged, meter.smoothedAmps, config, source) : 0;
    const raisePlan = planRaise({
      acs,
      headroomAmps: pressure.headroomAmps,
      smoothedAmps: meter.smoothedAmps,
      rampDebitAmps: rampDebit,
      limitAmps: limit,
      calmMs: meter.calmMs,
      config,
      book,
      source,
      now,
      pacing,
    });
    if (raisePlan.commands.length > 0 || corrections.commands.length > 0) {
      // A gentle restore (power_on carrying a pinned fan) records a fan hold so
      // the range automation can't slam the fan back up before the room settles.
      // The hold's gentle flag mirrors the ADMISSION price (probe vs learned),
      // so the freshly-on projection re-prices exactly what admission charged.
      let fanHolds = input.fanHolds;
      for (const cmd of raisePlan.commands) {
        if (cmd.kind === "power_on" && cmd.fan != null) {
          fanHolds = recordGentleRestoreHold(fanHolds, cmd.deviceId, now, raisePlan.probeRestoreIds.includes(cmd.deviceId));
        }
      }
      const raiseCommands = dedupeCommands([...corrections.commands, ...raisePlan.commands]);
      return {
        commands: raiseCommands,
        expectedDeltaAmps: 0, // graded per-command by the journal, not batch-summed here
        // A restore that pulls peers down to floors — and a funding swap —
        // ship real cuts. Until now they were invisible to the collapse
        // detector (this branch reports a net delta of 0, and the credit hung
        // off `expectedDeltaAmps < 0`), so a large commanded fall here could
        // latch a phantom collapse. Priced from the final list so a correction
        // that overrode a cut cannot leave a stale credit behind.
        commandedCutAmps: commandedCutAmpsOf(raiseCommands, acs, config, source),
        compareAfter: now + (raisePlan.isTurnOn ? GRADE_TURN_ON_MS : GRADE_LEVEL_MS),
        decisions: [...corrections.decisions, ...raisePlan.decisions],
        reason: raisePlan.isTurnOn ? "restore" : "raise",
        severity: null,
        requiredAmps: null,
        fanHolds,
        attempts: raisePlan.attempts,
        fanOnly: false,
      };
    }
    // Nothing to raise — walk any SATISFIED room parked above its need ceiling
    // back down (the loaded spring). Ordered here deliberately:
    //  - AFTER the raise phase, because a raise batch may already carry funding
    //    demotes of its own and two producers must not fight over one device;
    //  - BEFORE the fan restore, because reclaiming dormant compressor levels is
    //    strictly better than spending headroom on a fan;
    //  - and NEVER while a shed restore has amps reserved. A demote frees amps,
    //    so parking it looks wrong at first glance — but every non-fan batch
    //    rewinds the SHARED calm clock the parked restore is waiting on, and the
    //    restore's own feasibility already prices peer floor-downs (floors sit
    //    at or below ceilings). Letting demotes churn here would strand exactly
    //    the room the reservation exists to bring back.
    if (raisePlan.reservedAmps <= 0) {
      const demotes = planIdleDemotes({
        acs,
        config,
        source,
        now,
        inFlight: input.inFlight ?? (() => []),
      });
      if (demotes.commands.length > 0) {
        return {
          commands: demotes.commands,
          expectedDeltaAmps: 0,
          commandedCutAmps: demotes.cutAmps,
          compareAfter: now + GRADE_LEVEL_MS,
          decisions: [...raisePlan.decisions, ...demotes.decisions],
          reason: "demote",
          severity: null,
          requiredAmps: null,
          fanHolds: input.fanHolds,
          attempts: [],
          fanOnly: false,
        };
      }
      raisePlan.decisions.push(...demotes.decisions);
    }
    // A held fan may climb one sweet-spot step, but never
    // into amps reserved for a pending shed restore (raises were parked; a fan
    // restore must not spend that headroom either) and never into amps a
    // ramping compressor is already committed to. Two fan restores 12s apart
    // rode exactly that phantom budget into the 2026-07-26 trip (Najat 1→7 at
    // 10:28:00, Abdu →auto at 10:28:12, both while Abdu was still ramping).
    const fanStep = planFanRestore(input.fanHolds, acs, {
      calmMs: meter.calmMs,
      headroomAmps: pressure.headroomAmps - raisePlan.reservedAmps - rampDebit,
      book,
      source,
      now,
    });
    if (fanStep != null) {
      return {
        commands: [fanStep.command],
        expectedDeltaAmps: 0,
        commandedCutAmps: 0,
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
