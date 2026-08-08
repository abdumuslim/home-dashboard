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
import { commandedCutAmpsOf, modelFor, steadyDraw } from "./costs.js";
import { assessPressure } from "./pressure.js";
import { cutTrendOf, OVER_LIMIT_BUDGET } from "./sensing.js";
import { planReduction, SHED_NEED_GAP_C } from "./reduce.js";
import { invariantCorrections, planRaise, rampDebitAmps, type SwapDecision } from "./raise.js";
import { planFanRestore, recordFanCut, recordGentleRestoreHold, type FanHolds } from "./fan-trim.js";
import { ceilOf, floorOf } from "./needs.js";
import { planIdleDemotes } from "./demote.js";
import { attemptedWithin, canAttempt, RESTORE_CONFIRM_WAIT_MS, type PacingState } from "./pacing.js";

/** Outcome-grading delays: when the batch's meter effect is judged. */
export const GRADE_LEVEL_MS = 45_000;
/**
 * Must stay ABOVE `ATTEMPT_BLAME_WINDOW_MS` (300s). At 270s a restore was
 * declared a success 30 seconds before its blame window closed, and
 * `noteSuccess` resets the backoff ladder AND clears `attemptMeterAmps` — the
 * anchor invariant 22's probe re-arm reads. A bounce landing in those 30
 * seconds then found a ladder that had already forgotten the failure.
 */
export const GRADE_TURN_ON_MS = 315_000;
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
   * Measured worst-case non-AC house load on this source (house-load.ts),
   * added to the physics envelope for raises. Defaults to 0 — the AC-only
   * envelope v2 shipped with, so an un-sampled house is never more permissive.
   */
  nonAcAmps?: number;
  /**
   * Levels commanded to a device whose confirm has not been observed yet, with
   * their send times — the reconciler's view, injected so the pipeline stays
   * pure. Used for demote confirm-or-resend spacing. Defaults to "nothing in
   * flight" when the caller does not supply it.
   */
  inFlight?: (deviceId: string) => ReadonlyArray<{ level: number; sentAt: number }>;
  /** Devices that recently funded a peer's raise and may not re-take the level yet. */
  fundingCooldown?: (deviceId: string) => boolean;
  /** Devices the reducer just cut, which may not climb back yet. */
  victimCooldown?: (deviceId: string) => boolean;
  /**
   * This FLOORS window follows a dead circuit coming back — a breaker reset, or
   * a collapse we latched on entry. Every room returns AT ONCE with restart
   * protection already served, so the floor set arrives as one surge and the
   * meter cannot warn anybody in time (2026-08-04: 6.4 → 16.6A in 90 seconds).
   * Admission is decided on the ENVELOPE instead of the meter — see the FLOORS
   * branch. Defaults to the ordinary "clamp everyone to their floor".
   */
  recoveryAdmission?: boolean;
  /**
   * Per-room meter bar for a restore whose own shed is still recent — see
   * `RaiseInput.shedBarAmps`. Defaults to "no bar" (the pre-R9 admission).
   */
  shedBarAmps?: (deviceId: string) => number;
  /**
   * The gated proactive shed already in flight house-wide (donor → receiver),
   * or null. ONE at a time; the shell owns the record and clears it when the
   * receiver comes back. Defaults to "none in flight".
   */
  swapInFlight?: SwapDecision | null;
  /**
   * The ladder shipped an over-limit batch within `SWAP_QUIET_AFTER_OVER_MS`.
   * The meter gates below all read the CURRENT tick and none of them remembers
   * an episode the house is still digesting — see the constant. Defaults to
   * "nothing recent", which is what an un-wired caller had before this existed.
   */
  overLimitActedRecently?: boolean;
  /**
   * When each shed room first sat refused ONLY by the supply-flicker margin —
   * the shell owns the anchor and stamps it from `flickerRefused` below. Forwarded
   * to `RaiseInput.flickerRefusedSince`; defaults to "nothing refused".
   */
  flickerRefusedSince?: (deviceId: string) => number | undefined;
}

export interface PlanOutput extends Plan {
  severity: Severity | null;
  requiredAmps: number | null;
  /** Updated fan-hold records (cuts recorded, restore steps advanced). */
  fanHolds: FanHolds;
  /** Raise/restore attempts to stamp into pacing (blame windows). Restore
   *  attempts carry the committed meter admission saw (probe re-arm anchor). */
  attempts: Array<{ deviceId: string; kind: "raise" | "restore"; meterAmps?: number }>;
  /** True when this plan ships only fan commands (short settle window). */
  fanOnly: boolean;
  /** Devices demoted to fund a peer's raise — the shell stamps their cooldown. */
  fundingDonors?: string[];
  /** Devices the reducer took a level from — the shell stamps their cooldown. */
  reductionVictims?: string[];
  /**
   * The gated proactive shed this plan armed (donor → receiver), or null/absent.
   * The shell records it once the donor's `power_off` has actually shipped.
   */
  swap?: SwapDecision | null;
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
  const corrections = invariantCorrections(acs, now, source);

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
    //
    // ⚠ The threshold is the LIMIT, not the limit plus slack. It carried one
    // moderate rung (limit + 0.5) for a day, to stop a room being shed for
    // smoothed crossings of 0.02–0.31A during a turn-on. What that actually
    // bought was the 2026-08-02 17:40 break: a room came on at L3 onto a
    // 12.5A gen, the mean rode 15.0–15.5A for two minutes — under the slack the
    // whole time — and the one actuator with instant physics, undoing that very
    // turn-on, sat blocked while three batches of level cuts wound down too
    // slowly to matter. The breaker answered instead.
    //
    // The churn the slack was aimed at is now handled where it belongs and
    // without giving up reaction time: the flicker-aware bucket and calm
    // (invariant 24) stop noise-driven crossings reaching this branch at all,
    // and the escalation settle below holds the shed rung while a cut we
    // already sent is still landing.
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
    // Escalation settle: a reduction we already commanded is still travelling
    // to the meter, so the amps it frees are not gone — they are late. Live
    // 2026-08-02 16:55:29 a fan trim shipped, and 5s later the reducer shed a
    // room, and 1s after that a second room, all for a ~0.5A deficit that the
    // trim had already covered. `commandedCutCreditAmps` shrinks the demand,
    // but only until an unrelated fall absorbs the credit early; this holds the
    // SHED rung for one settle window while any credit is live. Levels and fans
    // still ship immediately.
    //
    // MILD alone was not enough. Live 2026-08-04 12:56:26 a fan trim plus a shed
    // went out at a 16.565A anchor; thirteen seconds later the meter read
    // 14.24A — 2.3A of the 2.9 commanded already gone, still falling — and a
    // SECOND room went off. Severity was `severe` from a banked 16.6A reading
    // (sensing only drops banked readings once the mean clears limit − margin,
    // and 14.24 against 13.9 just missed), so the mild-only hold never applied.
    // A cut the meter is visibly digesting is the one moment nothing further
    // should be spent from a room's comfort, whatever a stale reading says — so
    // a `arriving` trend extends the hold to SEVERE. It cannot extend to
    // extreme: that rung is itself gated on the same trend (`stalled`), and it
    // is the last one before the breaker.
    const cutTrend = cutTrendOf(meter);
    // …and the credit alone is still not the right gate for either hold,
    // because `pendingCutCredit` (invariant 38) zeroes it the INSTANT the
    // smoothed meter rises past the cut's send-time anchor by more than the
    // flicker — with no minimum age. That outrun revocation is correct and
    // load-bearing (a house genuinely outrunning its cut must reach the last
    // rung; it cost a breaker on 2026-08-03), but it means a SECOND compressor
    // ramping independently at the moment of a shed — a restore, or a
    // power-blink restart — ticks the smoothed meter past the anchor within a
    // reading or two, zeroes the credit, and drops BOTH holds. Live 2026-08-06
    // that shed a second room 2.5–5.5s after the first, four times in 24h
    // (#8929→#8930, #9180→#9181, #9213→#9214, #9369→#9370) — physically before
    // the first shed's off could reach the 8-wide smoothed median (median lag
    // alone is ~12–20s; a compressor wind-down is minutes).
    //
    // So both holds also fire while the cut is `settling` per `cutTrendOf` (a
    // cut exists, is younger than CREDIT_LANDING_GRACE_MS (60s), and its fall
    // is still short), whether or not the void has already zeroed its credit.
    // Inside that 60s a severe raw reading seconds after a shed is
    // overwhelmingly the not-yet-landed cut plus a ramping peer — the median
    // cannot have absorbed the cut yet — while a genuine runaway still reaches
    // the EXTREME rung, which is never held: its sustained clock and
    // required-sizing are the emergency escape (invariant 48's "fires on
    // stalled" contract stays intact).
    const cutLanding = meter.commandedCutCreditAmps > 0 || cutTrend === "settling";
    const escalationHold =
      mode === "SETTLING" &&
      cutLanding &&
      (pressure.severity === "mild" ||
        (pressure.severity === "severe" && (cutTrend === "arriving" || cutTrend === "settling")));
    // …and when what we have ALREADY commanded off covers the whole raw
    // deficit, the next batch is not an escalation, it is a duplicate. Live
    // 2026-08-03 00:41Z: three batches in 13 seconds took 12.9A off the house
    // for a 0.4A deficit, because each pass re-planned from the level it had
    // just sent (SETTLING substitutes the pending level for the confirmed one)
    // while none of it had reached the meter yet.
    //
    // Compared against `rawRequiredAmps`, not `requiredAmps`: the credit is
    // spent as the meter absorbs it, so the credited figure reads 0 exactly
    // when the cut is landing. Bounded three ways — SETTLE_MS ends the mode,
    // PENDING_CUT_MS expires the total, and 45s of mean-over-limit promotes
    // this to severe, which is never held.
    const settleHold =
      pressure.severity === "mild" &&
      mode === "SETTLING" &&
      cutLanding &&
      meter.commandedCutTotalAmps >= pressure.rawRequiredAmps;
    if (settleHold) {
      // Corrections still ship (they are hard invariants, and reductions), but
      // nothing new is planned this pass: the amps are already commanded.
      return {
        ...emptyPlan(input, `over_${pressure.severity}`, [
          {
            at: now,
            action: "reduce",
            blockedBy: "escalation settle",
            detail:
              `${meter.commandedCutTotalAmps.toFixed(1)}A already commanded off ` +
              `covers ${pressure.rawRequiredAmps.toFixed(1)}A owed — waiting for it to land`,
          },
          ...corrections.decisions,
        ]),
        commands: dedupeCommands(corrections.commands),
        severity: pressure.severity,
        requiredAmps: pressure.requiredAmps,
      };
    }
    const reduction = planReduction({
      acs: onManaged,
      requiredAmps: pressure.requiredAmps,
      requireShed,
      allowShed: !inrushBlanking && !escalationHold,
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
        detail:
          `est savings ${reduction.estimatedSavingsAmps.toFixed(1)}A, satisfied=${reduction.satisfied}` +
          `, smoothed ${meter.smoothedAmps.toFixed(1)}A vs ${limit.toFixed(1)}A, flicker ±${meter.flickerAmps.toFixed(1)}A`,
      },
      ...(inrushBlanking
        ? [
            {
              at: now,
              action: "shed",
              blockedBy: "turn-on inrush",
              detail: `smoothed ${meter.smoothedAmps.toFixed(1)}A ≤ ${limit.toFixed(1)}A, ${rampingNow.length} ramping, over ${(meter.smoothedOverMs / 1000).toFixed(0)}s`,
            } satisfies Decision,
          ]
        : []),
      ...(escalationHold
        ? [
            {
              at: now,
              action: "shed",
              blockedBy: "escalation settle",
              detail:
                `${meter.commandedCutCreditAmps.toFixed(1)}A already commanded off, still landing ` +
                `(${cutTrend}, ${Math.max(0, meter.commandedCutAnchorAmps - meter.smoothedAmps).toFixed(1)}A ` +
                `of ${meter.commandedCutTotalAmps.toFixed(1)}A gone in ${(meter.commandedCutAgeMs / 1000).toFixed(0)}s)`,
            } satisfies Decision,
          ]
        : []),
      // Every shed records the figures it was RANKED on (R13): the real-temp
      // need this room was compared to its peers with, and the thermometer
      // behind it. `needDelta` rides along because for one room it is a
      // feels-like figure, and a forensic pass that cannot see both cannot tell
      // a humid room from a hot one.
      ...reduction.toShed.map((deviceId) => {
        const ac = onManaged.find((a) => a.deviceId === deviceId);
        // …and when the two rooms were inside the gap and PRIORITY is what
        // settled it, say so (user, 2026-08-06). The thermometer alone shed the
        // top-priority room over 0.05°C at 14:38:11Z, and a tie-break nobody can
        // see in the journal is the next forensic mystery.
        const tie = reduction.priorityTieBreak;
        const spared = tie?.shedDeviceId === deviceId
          ? onManaged.find((a) => a.deviceId === tie.protectedDeviceId)
          : undefined;
        return {
          at: now,
          deviceId,
          action: "shed choice",
          detail:
            (ac == null
              ? "ranked on real temperature"
              : `real need ${ac.rankNeedDelta.toFixed(1)}°C` +
                `${ac.roomTempC != null ? ` (room ${ac.roomTempC.toFixed(1)}°C)` : " (thermometer dead — ranked on its own metric)"}` +
                `, own metric ${ac.needDelta.toFixed(1)}°C`) +
            (spared != null && ac != null
              ? `, within ${SHED_NEED_GAP_C.toFixed(1)}°C of ${spared.name}` +
                ` (${ac.rankNeedDelta.toFixed(1)} vs ${spared.rankNeedDelta.toFixed(1)}) — priority decided`
              : ""),
        } satisfies Decision;
      }),
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
      commandedCutAmps: commandedCutAmpsOf(finalCommands, onManaged, config, source, book, now),
      compareAfter: now + GRADE_LEVEL_MS,
      decisions,
      reason: `over_${pressure.severity}`,
      severity: pressure.severity,
      requiredAmps: pressure.requiredAmps,
      fanHolds,
      attempts: [],
      fanOnly: commands.length > 0 && commands.every((c) => c.kind === "set_fan") && corrections.commands.length === 0,
      // Rooms this batch took a level from. Sheds are NOT victims (a restore is
      // not a raise, and the restore path has its own pacing), and neither are
      // fan trims — those already owe FAN_RESTORE_AFTER_CUT_MS.
      reductionVictims: Object.keys(reduction.desiredLevels),
    };
  }

  // ---- FLOORS (no over-pressure): hold everyone at floors, re-asserting until
  // the shadow confirms (the reconciler paces the resends).
  //
  // Judged on `envelopeLevel` — the worst level the firmware might be at —
  // rather than the observed shadow alone. A shadow confirms minutes late, so
  // a level already sent but unconfirmed is invisible to `currentLevel`: live
  // 2026-08-03 00:13Z a room raised to L3 on grid two minutes before the
  // changeover was skipped by this clamp entirely, sat at L3 on a 15A
  // generator for 27 minutes, and was priced ~4A light by the envelope while a
  // peer was raised on top of it.
  if (mode === "FLOORS") {
    // RECOVERY ADMISSION (2026-08-04). A dead circuit coming back is the one
    // entry where "hold everyone at their floor" is not a safe answer: nothing
    // is drawing yet, so the meter says the house is empty, and every room
    // returns together the instant the breaker closes. Live arithmetic that
    // morning: floors modeled 10.4A + a measured ~6A house = 16.4A onto a 15A
    // generator — the surge was decided before the first reading arrived, and
    // the reducer could only answer it after the fact.
    //
    // So the floor set is admitted against the ENVELOPE, hottest room first:
    // rooms are taken while `Σ floor models + house` still fits under
    // `limit − margin`, and the rest are shed properly — ordinary shed rows,
    // ordinary one-by-one restore admission as real headroom appears. No
    // parallel queue, and the reducer stays the meter-truth backstop exactly as
    // before. Correct end-state for that morning: {Abdullah L2, Abdu L1,
    // Najat shed} ≈ 14.1A.
    const admitted = new Set(onManaged.map((a) => a.deviceId));
    const shedForFit: string[] = [];
    if (input.recoveryAdmission === true && source === "gen") {
      const ceiling = limit - config.marginAmps;
      const floorDraw = (a: AcView): number =>
        steadyDraw(floorOf(a), a.maxLevel, modelFor(config, a.deviceId, source));
      // A user-pinned room is admitted before the budget is spent at all: being
      // switched off is worse than any level (invariant 25), and a pin is the
      // clearest statement there is that this room is wanted. If the pinned set
      // alone does not fit, the reducer answers it on the meter like any other
      // overload — this phase never sheds a room the user asked for.
      const pinned = onManaged.filter((a) => a.manualTarget != null || a.manualCap != null);
      const rest = onManaged
        .filter((a) => !pinned.includes(a))
        // Hottest first; `acs` is pre-sorted by priority, so the index is the
        // existing tiebreak.
        .sort((a, b) => b.rankNeedDelta - a.rankNeedDelta || acs.indexOf(a) - acs.indexOf(b));
      let total = (input.nonAcAmps ?? 0) + pinned.reduce((sum, a) => sum + floorDraw(a), 0);
      // Once a room has been refused, a COOLER one may still fit in the amps it
      // could not use — but only if it is at least `SHED_NEED_GAP_C` milder.
      // Inside that gap the user has already ruled: a comparably warm room
      // running while a hotter one sits off is the complaint invariant 43 came
      // from ("why it turned off mine not najat?"). Reusing his calibrated gap
      // rather than inventing a second one.
      let refusedNeed: number | null = null;
      for (const ac of rest) {
        const draw = floorDraw(ac);
        const fits = total + draw <= ceiling;
        const notColdEnough = refusedNeed != null && ac.rankNeedDelta + SHED_NEED_GAP_C > refusedNeed;
        if (fits && !notColdEnough) {
          total += draw;
          continue;
        }
        if (fits) refusedNeed = Math.max(refusedNeed ?? 0, ac.rankNeedDelta);
        else refusedNeed = refusedNeed ?? ac.rankNeedDelta;
        admitted.delete(ac.deviceId);
        shedForFit.push(ac.deviceId);
      }
    }
    const commands: Command[] = [];
    for (const ac of onManaged) {
      if (!admitted.has(ac.deviceId)) continue;
      const floor = floorOf(ac);
      const worst = Math.max(ac.currentLevel, ac.envelopeLevel);
      if (worst === 0 || ac.currentLevel === 0 || worst > floor) {
        commands.push({ deviceId: ac.deviceId, kind: "set_level", level: floor });
      }
    }
    // Sheds last in emission order, like the reducer's — the executor sends in
    // array order, so the rooms that stay are floored before one goes off.
    for (const deviceId of shedForFit) {
      commands.push({ deviceId, kind: "power_off", reason: "shed" });
    }
    const decisions: Decision[] = [
      { at: now, action: "raises/restores", blockedBy: "gen-entry floors" },
      ...shedForFit.map(
        (deviceId): Decision => ({
          at: now,
          deviceId,
          action: "shed",
          detail:
            `recovery admission: floors + ${(input.nonAcAmps ?? 0).toFixed(1)}A house ` +
            `exceed ${(limit - config.marginAmps).toFixed(1)}A on ${source}`,
        }),
      ),
    ];
    return {
      ...emptyPlan(input, shedForFit.length > 0 ? "recovery_admission" : "floors", decisions),
      commands,
      // The SHEDS credit the collapse detector (invariant 11) — a whole room
      // leaving is exactly the fall shape a phantom collapse latches on.
      //
      // ⚠ The floor clamps deliberately do NOT, which is how this branch has
      // always behaved. Crediting them was tried and reverted the same hour:
      // gen entry clamps every room down, so the credit is live exactly when a
      // breaker is most likely to go, and it explained away a REAL second trip
      // in the 2026-07-26 cascade regression (derate stopped compounding at
      // 1A instead of 2A). Widening the credit here is its own investigation,
      // not a side effect of admission.
      commandedCutAmps: commandedCutAmpsOf(
        commands.filter((c) => c.kind === "power_off"),
        onManaged,
        config,
        source,
        book,
        now,
      ),
      compareAfter: commands.length > 0 ? now + (shedForFit.length > 0 ? GRADE_TURN_ON_MS : GRADE_LEVEL_MS) : 0,
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
      // Corrections carry real down-moves (a level-0 re-cap, a gen start clamp),
      // so they credit the collapse detector like every other cut — invariant 11.
      commandedCutAmps: commandedCutAmpsOf(corrections.commands, onManaged, config, source, book, now),
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
      // Gen only, the same split the envelope guard and ramp debit use: grid
      // starts every AC full by directive and leans on the reducer as its safety.
      nonAcAmps: source === "gen" ? (input.nonAcAmps ?? 0) : 0,
      // …and the wobble of the supply itself, charged as MARGIN against the
      // restore ceiling (2026-08-06 14:00–14:04Z). A restore admitted with
      // 0.48A to spare on a line flickering ±0.4–0.8A cannot survive, and a
      // restore that cannot survive costs the room an off/on cycle and — that
      // afternoon — a second room with it. 0 on a quiet line, so grid and every
      // steady generator hour are unchanged (see raise.ts restoreCeiling).
      flickerAmps: meter.flickerAmps,
      // Where a cut still in flight is taking the meter — a restore admitted on
      // the trough of its own shed comes straight back out (2026-08-03).
      cutAnchorAmps: meter.commandedCutAnchorAmps,
      commandedCutAmps: meter.commandedCutTotalAmps,
      limitAmps: limit,
      calmMs: meter.calmMs,
      config,
      book,
      source,
      now,
      pacing,
      fundingCooldown: input.fundingCooldown,
      // …and its involuntary twin. Declared on PlanInput and supplied by BOTH
      // the shell and the harness since invariant 35 shipped, but never handed
      // to the planner — so `RaiseInput.victimCooldown` was permanently
      // undefined and a room the reducer had just cut could climb straight back
      // into the overload that caused the cut. Found reviewing the 2026-08-04
      // dead-window work; the acceptance scenario that covers the live 00:41Z
      // bounce passes on the other gates (calm, settle, envelope), which is why
      // a missing wire could sit here unnoticed.
      victimCooldown: input.victimCooldown,
      // …and the per-room half of "judge a restore on where the meter is
      // heading" (invariant 41): the trough a room's own shed digs outlives the
      // commanded-cut credit, so the bar does too (R9).
      shedBarAmps: input.shedBarAmps,
      // The SITUATIONAL half of the proactive-shed gate. The arithmetic half
      // lives in `swapDonorFor`; this is the "is the house quiet enough to be
      // rearranging rooms at all" half, and it is deliberately strict — a swap
      // is a comfort optimisation, never an emergency tool:
      //
      //  - NORMAL only. FLOORS/GRID_FULL/SETTLING/COLLAPSED all return above,
      //    so reaching here already implies it; asserted anyway so a future
      //    branch cannot silently inherit the permission.
      //  - GEN only. On grid the entry policy is "start everything full" and
      //    the reducer is the safety (see GRID_FULL), so trading one room off
      //    for another is not the grid contract — and grid is not
      //    envelope-guarded, which is half of what makes the trade honest.
      //  - No derate (collapse OR strain): a line that has just proved it
      //    cannot hold its rating is not a line to spend a room's comfort on.
      //  - Nothing frozen, no over-limit episode in flight (mean over the
      //    limit, a drained bucket, or a cut still landing). `pressure.kind`
      //    being `calm` is not enough on its own — the bucket can still be
      //    refilling from an episode seconds old, which is exactly the 02:32
      //    storm this feature must stand down for.
      //  - …and none of those remembers an episode the meter has already
      //    absorbed. `overLimitActedRecently` is the memory; without it the
      //    acceptance replay traded a room away 50 s after a level cut.
      //  - …and NOTHING ELSE MAY SHIP THIS TICK. `invariantCorrections` are
      //    merged into the same batch below, so a tick that carries one would
      //    put the donor's `power_off` in a 2-command batch — and the grading
      //    shell only grades `meterCmds.length === 1`. The trade would then
      //    lose the free `on@L` sample AND the off-drop compressor evidence
      //    (invariant 55) the design counts on, while the SKILL's "ships ALONE"
      //    quietly stopped being true. Standing down costs one tick: corrections
      //    are one-shot clamps, and the swap re-arms on the next calm tick with
      //    every other gate re-evaluated.
      swapAllowed:
        mode === "NORMAL" &&
        source === "gen" &&
        corrections.commands.length === 0 &&
        !meter.frozen &&
        !meter.collapsed &&
        meter.derateAmps <= 0 &&
        meter.smoothedOverMs === 0 &&
        meter.overLimitBudget >= OVER_LIMIT_BUDGET &&
        meter.commandedCutCreditAmps <= 0 &&
        meter.commandedCutTotalAmps <= 0 &&
        input.overLimitActedRecently !== true,
      swapInFlight: input.swapInFlight ?? null,
      // …and the per-room flicker-patience anchor: a restore refused only by the
      // supply-flicker margin ages into a bare-ceiling admission (invariant 58
      // follow-up). The shell owns the map; the plan reports which rooms are
      // flicker-refused this tick via `flickerRefused` below.
      flickerRefusedSince: input.flickerRefusedSince,
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
        commandedCutAmps: commandedCutAmpsOf(raiseCommands, acs, config, source, book, now),
        compareAfter: now + (raisePlan.isTurnOn ? GRADE_TURN_ON_MS : GRADE_LEVEL_MS),
        decisions: [...corrections.decisions, ...raisePlan.decisions],
        // A proactive shed is its own reason in the journal — the user reads
        // this, and "raise" on a batch that switched a room OFF would be a lie.
        reason: raisePlan.swap != null ? "proactive_shed" : raisePlan.isTurnOn ? "restore" : "raise",
        severity: null,
        requiredAmps: null,
        fanHolds,
        attempts: raisePlan.attempts,
        fanOnly: false,
        fundingDonors: raisePlan.fundingDonors,
        swap: raisePlan.swap,
        flickerRefused: raisePlan.flickerRefused,
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
          flickerRefused: raisePlan.flickerRefused,
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
      // …and never into the wobble of the supply itself. A house riding the
      // limit with every level at its floor has only the fan left, so the
      // restore lands right back inside the flicker band that trimmed it —
      // live 2026-08-06, one fan commanded 10× in 22 minutes (see
      // planFanRestore). 0 on a quiet line, so this changes nothing there.
      flickerAmps: meter.flickerAmps,
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
        // The step names itself: a fast-path restore prints the arithmetic that
        // admitted it, because a fan that comes all the way back in one batch
        // and a fan that BOUNCED are the same line in a command log, and are
        // told apart only by what the budget was at the time (2026-08-06).
        decisions: [...raisePlan.decisions, { at: now, deviceId: fanStep.command.deviceId, action: fanStep.action }],
        reason: "fan_restore",
        severity: null,
        requiredAmps: null,
        fanHolds: fanStep.holds,
        attempts: [],
        fanOnly: true,
        flickerRefused: raisePlan.flickerRefused,
      };
    }
    // A pure flicker-only refusal ships no command — carry its `flickerRefused`
    // report through the idle return so the shell still anchors it.
    return { ...emptyPlan(input, "idle", raisePlan.decisions), flickerRefused: raisePlan.flickerRefused };
  }

  // ---- hold: the deliberate near-limit ride — do nothing, on purpose.
  return {
    ...emptyPlan(input, "hold"),
    commands: corrections.commands,
    commandedCutAmps: commandedCutAmpsOf(corrections.commands, onManaged, config, source, book, now),
    decisions: corrections.decisions,
    compareAfter: corrections.commands.length > 0 ? now + GRADE_LEVEL_MS : 0,
  };
}
