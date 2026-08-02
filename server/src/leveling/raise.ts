// Headroom spending for leveling v2: shed restores, warm restores, one-step
// level raises, and the hard-invariant corrections (never level 0, boost
// floors, gen start clamp). Pure — pacing gates are consulted here but mutated
// by the caller.
//
// Ordering (ported user decisions): a feasible shed RESTORE outranks every
// raise ("all ACs on beats higher levels"); a restore gated only by pacing
// RESERVES its amps so raises can't steal them (v2 change — v1 parked every
// raise globally, stranding rooms for 49m+); raises are meter-anchored and
// one-step, most-needy room first; on gen only ONE raise command per batch
// (the 07-23 double-raise landed 16.6A on a 14.9A limit).

import type { AcView, Command, CostEstimate, Decision, PowerSource } from "./types.js";
import type { CostBook } from "./costs.js";
import { levelCutSavings, modelCutAmps, modelFor, raiseJumpAmps, restoreCostAmps, steadyDraw } from "./costs.js";
import type { LevelingConfigV2 } from "./config.js";
import { ceilCapOf, ceilOf, floorOf } from "./needs.js";
import {
  attemptedWithin,
  canAttempt,
  probeRearmed,
  RESTORE_CONFIRM_WAIT_MS,
  restoreFailures,
  type PacingState,
} from "./pacing.js";

/**
 * Physics-envelope total: worst-case steady draw of a commanded end-state,
 * summed from the per-AC cap models. A gen level is a firmware CAP — under
 * binding (hot) demand the compressor is entitled to the whole cap, and the
 * meter only shows that minutes later (or never, when the ESP hangs frozen).
 * This is the number that already knew "expected 16.9A > 15A" when the
 * 2026-07-23 double-L3 batch shipped and tripped the gen breaker.
 *
 * AC-ONLY by construction. The non-AC term is supplied separately by the
 * caller (see `RaiseInput.nonAcAmps` and house-load.ts) because the two
 * consumers want different answers: a RAISE must be priced against the whole
 * house, while a shed RESTORE is deliberately left on the AC-only figure —
 * refusing a restore strands a room off entirely, which the user has ranked
 * worse than riding near the limit, and the restore path already has a
 * meter-anchored gate that includes the house load by definition.
 */
export function envelopeTotalAmps(
  entries: Array<{ deviceId: string; level: number; maxLevel: number }>,
  config: LevelingConfigV2,
  source: Exclude<PowerSource, "none">,
): number {
  return entries.reduce(
    (sum, e) => sum + steadyDraw(e.level, e.maxLevel, modelFor(config, e.deviceId, source)),
    0,
  );
}

/**
 * Amps that ramping ACs have already COMMITTED but the meter has not absorbed
 * yet — the budget the house owes but cannot see.
 *
 * A compressor reaches its cap over ~4 minutes, so for those minutes the meter
 * under-reports the load that is already on its way. `planRaise` has always
 * refused to raise an AC while IT is ramping — but nothing stopped it raising a
 * PEER on the same phantom headroom, and that is exactly what tripped the gen
 * on 2026-07-26: Abdu was restored at 10:25:45, and 37s later the journal shows
 * `Abdu: raise blockedBy "ramping"` in the SAME batch that raised Najat L1→L2,
 * then L2→L3 35s after that. Both were admitted against a meter that had seen
 * almost none of Abdu's 4.3A. The controller's freshly-on projection could not
 * cover it either: it lives for exactly ONE tick (`freshlyOn` is cleared at the
 * top of every tick), and both raises landed after it.
 *
 * Per AC: what the cap model says it will pull at its current level, minus what
 * the meter has actually risen since its compressor started. Deliberately
 * conservative in three ways — a null baseline charges the WHOLE draw (unknown
 * absorption is not evidence of absorption), level 0 charges the unrestricted
 * draw, and with two ACs ramping each measures the rise from its own baseline,
 * so shared rise is counted twice. All three err toward not spending.
 *
 * Absorption RATCHETS (2026-07-27). The live rise is only half the story: it is
 * a whole-house delta, so any load that leaves after the ramp armed masks it.
 * On 2026-07-27 the reducer cut ~2.5A off two peers two minutes into Najat's
 * ramp, dropping the house 1.5A below her baseline — `smoothed − baseline`
 * clamped to 0 and she was re-charged her entire 2.3A for the remaining half of
 * her window, fencing a fan restore (and every raise) on a meter that had been
 * calm and 1.5A under the ceiling the whole time. So the credit is the LARGER
 * of the live rise and the peak rise this ramp has already shown: absorption is
 * a one-way fact, and a peer's departure cannot un-prove amps the meter saw
 * arrive. Still bounded by the baseline — no baseline, no credit, ratchet or not.
 *
 * SPENDING SIDE ONLY. This must never inflate the reducer's savings target: a
 * ramping AC's inrush is transient and the 2026-07-25 storm proved that acting
 * on it sheds rooms for load that decays on its own (see pipeline.ts inrush
 * blanking). It gates what we ADD, never what we cut.
 */
export function rampDebitAmps(
  acs: AcView[],
  smoothedAmps: number,
  config: LevelingConfigV2,
  source: Exclude<PowerSource, "none">,
): number {
  return acs.reduce((sum, ac) => {
    if (!ac.on || !ac.managed || ac.shed) return sum;
    if (!ac.ramping) {
      // Not starting, but a recent level raise may still be arriving. Charged
      // only here: a RAMPING AC is already charged its whole steady draw at its
      // current (raised) level below, which subsumes the jump.
      return sum + Math.max(0, ac.unmeteredJumpAmps);
    }
    const committed = steadyDraw(ac.currentLevel, ac.maxLevel, modelFor(config, ac.deviceId, source));
    const absorbed =
      ac.rampBaselineAmps == null
        ? 0
        : Math.max(0, smoothedAmps - ac.rampBaselineAmps, ac.rampAbsorbedAmps ?? 0);
    return sum + Math.max(0, committed - absorbed);
  }, 0);
}

/**
 * Highest level a freshly-turned-on AC may be driven to on GRID, priced as
 * `pre-start house load + its own modeled steady draw at that level` against
 * the resting ceiling. Returns null when not even one step above its current
 * level fits.
 *
 * Why not the meter (2026-07-25): a TCL restores the gen level it was last
 * left at, so an AC turned on while on grid comes back at its previous gen
 * floor (L1) — and for `AC_RAMP_MS` the compressor is still ramping, which
 * blocks the ordinary raise path entirely (live: Abdu came on at L1 at 08:00:45
 * with ~5A of headroom and only reached L3 at 08:05:26). Lifting it during the
 * ramp means the meter has NOT yet absorbed this AC's own draw, so
 * meter-anchored admission would spend phantom headroom. The pre-start baseline
 * is the honest anchor: it is the rest of the house, and the AC's whole steady
 * draw at the target level is charged on top of it.
 */
export function gridStartLevel(
  ac: AcView,
  ceil: number,
  config: LevelingConfigV2,
  ceilingAmps: number,
): number | null {
  if (ac.startBaselineAmps == null) return null;
  const model = modelFor(config, ac.deviceId, "grid");
  let target = Math.min(ceil, ac.maxLevel);
  while (
    target > ac.currentLevel &&
    ac.startBaselineAmps + steadyDraw(target, ac.maxLevel, model) > ceilingAmps
  ) {
    target--;
  }
  return target > ac.currentLevel ? target : null;
}

/**
 * How much HOTTER (°C above its own target) a blocked raiser must run than a
 * peer before the peer's standing level is traded over (user, 2026-08-01:
 * "the extra level should switch to the hotter room"). At the 0.1°C sensor
 * granularity this is seven whole LSBs — reading noise cannot arm a trade, and
 * a reverse trade needs the rooms to genuinely cross by the same margin.
 */
export const REBALANCE_NEED_GAP_C = 0.7;

/**
 * A comparative-need trade must leave the receiver's raise fitting with this
 * much to SPARE once the donor's cut lands. The deficit is read off a noisy
 * meter — the acceptance suite's ±0.5A resting-point noise armed a trade on
 * every dip, and because the freed amps then fit the DONOR's cheaper re-raise
 * but not the receiver's step, the level bounced donor↔receiver on a 35s
 * period. Sized to the observed noise band so a trade can only arm when it
 * fits across the whole band.
 */
export const REBALANCE_FUND_MARGIN_AMPS = 0.5;

export interface RaiseInput {
  /** ALL managed AC views (on and off/shed), pre-sorted by priority. */
  acs: AcView[];
  /** Room under the resting ceiling (limit − margin − restingBuffer − smoothed). */
  headroomAmps: number;
  smoothedAmps: number;
  /**
   * Committed-but-unmetered draw of ramping ACs (see rampDebitAmps). Charged
   * against BOTH the restore admission and the raise budget: the meter is not
   * a valid anchor while load it has not seen is still arriving.
   */
  rampDebitAmps: number;
  /**
   * Measured worst-case non-AC house load on this source (house-load.ts). Added
   * to the physics envelope for RAISES only — the 2026-07-31 gen trip was an
   * envelope of 13.9A admitting an end-state that measured 15.95A, and the
   * whole 2.0A gap was the house the guard never counted.
   */
  nonAcAmps: number;
  limitAmps: number;
  calmMs: number;
  config: LevelingConfigV2;
  book: CostBook;
  source: Exclude<PowerSource, "none">;
  now: number;
  pacing: PacingState;
}

export interface RaisePlan {
  commands: Command[];
  decisions: Decision[];
  /** Attempts to record in pacing (blame windows) — deviceId × kind. Restore
   *  attempts carry the committed meter admission saw (probe re-arm anchor). */
  attempts: Array<{ deviceId: string; kind: "raise" | "restore"; meterAmps?: number }>;
  /** True when the batch turns an AC on (longer settle/ramp downstream). */
  isTurnOn: boolean;
  /**
   * Amps held back for a feasible-but-gated shed restore. > 0 means the raise
   * phase was parked (see the parking guard) — the caller must also keep a fan
   * restore from spending these amps.
   */
  reservedAmps: number;
  /**
   * Restores in `commands` that were admitted at the gentle PROBE price
   * instead of the learned plain price — the recorded fan hold must carry
   * gentle=true so the freshly-on projection re-prices them identically.
   */
  probeRestoreIds: string[];
  /**
   * Model-priced total of any down-moves this plan emitted (funding demotes and
   * restore peer floor-downs) — the collapse detector's credit.
   */
  cutAmps: number;
}

/**
 * Hard-invariant corrections that ship regardless of calm/pacing (but not in
 * COLLAPSED — no commands into a dead line): an ON managed AC observed at
 * level 0 is re-capped at its top commandable level; an AC below its boost
 * floor is lifted to it; and on GEN an AC still inside its turn-on window is
 * clamped down to its floor.
 *
 * **Gen start clamp (2026-07-30).** A TCL restores the generator level it was
 * last left at, and since GRID_FULL shipped that level is L3 — so a room turned
 * on mid-gen-session arrives at 6.3A on a 15A line with nothing admitting it.
 * FLOORS only arms on ENTRY into gen and ends within 5 minutes, so it does not
 * cover this (live 05:51 Baghdad: Najat came on at L3 33 minutes in, the house
 * rode 16.77A, and the user hand-set both rooms to L1 two minutes later).
 *
 * This is the per-device form of FLOORS, and it lives here rather than in the
 * raise planner for three reasons: it must ship in EVERY non-COLLAPSED mode
 * (a gen turn-on is over-limit by definition, so the raise phase never runs);
 * it is a reduction, so it can never fight the reducer; and `dedupeCommands`
 * gives the reducer the last word if it wants to cut deeper. Re-emitting while
 * unconfirmed is deliberate — same contract as FLOORS, and it doubles as the
 * confirm-or-resend Najat's firmware needs. It self-cancels once the shadow
 * confirms at or below the floor, and `floorOf` honours manual/slot/boost caps.
 */
export function invariantCorrections(
  acs: AcView[],
  now: number,
  source: PowerSource,
): { commands: Command[]; decisions: Decision[] } {
  const commands: Command[] = [];
  const decisions: Decision[] = [];
  for (const ac of acs) {
    if (!ac.on || !ac.managed || ac.shed) continue;
    if (ac.currentLevel === 0) {
      const cap = ceilCapOf(ac);
      commands.push({ deviceId: ac.deviceId, kind: "set_level", level: cap });
      decisions.push({ at: now, deviceId: ac.deviceId, action: `re-cap L${cap}`, detail: "never level 0" });
      continue;
    }
    const floor = floorOf(ac);
    if (ac.currentLevel < floor) {
      commands.push({ deviceId: ac.deviceId, kind: "set_level", level: floor });
      decisions.push({ at: now, deviceId: ac.deviceId, action: `floor L${floor}`, detail: "below boost floor" });
      continue;
    }
    if (source === "gen" && ac.startBaselineAmps != null && ac.currentLevel > floor) {
      commands.push({ deviceId: ac.deviceId, kind: "set_level", level: floor });
      decisions.push({
        at: now,
        deviceId: ac.deviceId,
        action: `gen start L${floor}`,
        detail: `came on at L${ac.currentLevel} — gen turn-ons enter at their floor`,
      });
    }
  }
  return { commands, decisions };
}

export function planRaise(input: RaiseInput): RaisePlan {
  const { acs, config, book, source, now, pacing } = input;
  const decisions: Decision[] = [];
  const attempts: Array<{ deviceId: string; kind: "raise" | "restore"; meterAmps?: number }> = [];
  const commands: Command[] = [];
  /** Model-priced down-moves this plan emits (funding demotes, peer floor-downs). */
  let cutAmps = 0;

  const onManaged = acs.filter((a) => a.on && a.managed && !a.shed);

  // Physics-envelope veto (gen only — grid deliberately starts FULL and lets
  // the reducer trim): never command an end-state whose worst-case modeled
  // draw exceeds limit − margin, no matter how much room the meter shows.
  const envelopeCeiling = input.limitAmps - config.marginAmps;
  const envelopeGuard = source === "gen";
  const envelopeWith = (overrides: Record<string, number>, extra?: { deviceId: string; level: number; maxLevel: number }): number =>
    envelopeTotalAmps(
      [
        ...onManaged.map((a) => ({
          deviceId: a.deviceId,
          // `envelopeLevel`, not `currentLevel`: the shadow confirms minutes
          // late on some firmware, and a worst-case guard that prices a peer at
          // a level we already commanded it away from is not a guard at all
          // (2026-07-28 15:55:36 — Abdu L2→L3 admitted at a 13.6A envelope
          // because Najat's L3, sent 16 min earlier, had not confirmed; the
          // same end-state was vetoed at 15.6A once it did). An explicit
          // override always wins — those are commanded end-states this batch.
          level: overrides[a.deviceId] ?? a.envelopeLevel,
          maxLevel: a.maxLevel,
        })),
        ...(extra != null ? [extra] : []),
      ],
      config,
      source,
    );
  /**
   * The envelope a RAISE is judged against: the AC caps plus the measured
   * house. Restores keep using `envelopeWith` bare — see envelopeTotalAmps.
   */
  const raiseEnvelope = (
    overrides: Record<string, number>,
    extra?: { deviceId: string; level: number; maxLevel: number },
  ): number => envelopeWith(overrides, extra) + input.nonAcAmps;

  // ---- Restore phase: most-needy shed AC first, no queue jumping ----
  // Restores are exempt from the resting buffer (a whole room off is worse
  // than riding near the limit): fits under limit − margin.
  const restoreCeiling = input.limitAmps - config.marginAmps;
  const restoreCalmOk = input.calmMs >= config.restoreCalmSeconds * 1000;
  let reservedAmps = 0;
  // The meter plus the load already on its way to it — the honest picture of
  // what this house is committed to right now.
  const committedAmps = input.smoothedAmps + input.rampDebitAmps;
  const rampNote = input.rampDebitAmps > 0 ? ` (+${input.rampDebitAmps.toFixed(1)}A ramping in)` : "";

  const shedCandidates = acs
    .filter((a) => a.shed && a.managed && !a.on)
    .sort((a, b) => b.needDelta - a.needDelta || acs.indexOf(a) - acs.indexOf(b));

  for (const candidate of shedCandidates) {
    const floor = floorOf(candidate);
    // On gen every restore ships GENTLE (fan pinned to 1), but gentleness is
    // NOT a discount: 2026-07-27 proved the pin doesn't shrink the compressor
    // draw — three fan-pinned restores of Najat admitted at her steady 2.3A
    // each ramped the meter +3.5–3.8A and bounced back to shed within ~3 min.
    // Admission prices at the PLAIN learned cost; the steady price survives
    // only as a bounded PROBE below, for stale-HIGH learned costs (2026-07-24:
    // a phantom 3.7A stranded a room that really fit). `restoreCostAmps` is
    // shared with the controller's freshly-on projection so admission and
    // re-pricing can never disagree (the 2026-07-25 storm) — probeRestoreIds
    // tells the caller which price this restore carried.
    const gentleRestore = source === "gen";
    const plainCost: CostEstimate = restoreCostAmps(
      book,
      config,
      candidate.deviceId,
      source,
      floor,
      candidate.maxLevel,
      now,
      { gentle: false },
    );
    const probeCost: CostEstimate = restoreCostAmps(
      book,
      config,
      candidate.deviceId,
      source,
      floor,
      candidate.maxLevel,
      now,
      { gentle: true },
    );
    const candidateEntry = { deviceId: candidate.deviceId, level: floor, maxLevel: candidate.maxLevel };

    // Both feasibilities up front, BEFORE any gate — the reservation decision
    // needs to know whether this room could return at all (plain, or by pulling
    // every raised peer down to its floor in the same batch).
    const envelopePlainOk = !envelopeGuard || envelopeWith({}, candidateEntry) <= envelopeCeiling;
    const savingsAtFloors = onManaged.reduce((sum, a) => {
      const f = floorOf(a);
      return a.currentLevel > f
        ? sum + levelCutSavings(book, config, a.deviceId, source, a.currentLevel, f, a.maxLevel, now)
        : sum;
    }, 0);
    const floorOverrides = Object.fromEntries(onManaged.map((a) => [a.deviceId, floorOf(a)]));
    const envelopeFloorsOk = !envelopeGuard || envelopeWith(floorOverrides, candidateEntry) <= envelopeCeiling;
    const fitsWith = (amps: number): { plain: boolean; atFloors: boolean } => ({
      plain: envelopePlainOk && committedAmps + amps <= restoreCeiling,
      atFloors: envelopeFloorsOk && committedAmps - savingsAtFloors + amps <= restoreCeiling,
    });

    let cost = plainCost;
    let probe = false;
    let fits = fitsWith(cost.amps);
    // PROBE: the learned price blocks, but it may be stale-high — while there
    // is ZERO bounce evidence this source-session, try once at the steady
    // floor price. A bounce feeds the pacing ladder (failures > 0 disables
    // further probes) and re-learns the on-cost from the shed's off-drop; a
    // probe that sticks re-grades the learned cost cheap. Both wrong beliefs
    // self-correct from the meter instead of stranding or storming.
    //
    // EVIDENCE RE-ARM (2026-08-02): a bounce is evidence about the house the
    // probe bounced IN, not the house forever. Najat's probe failed at a
    // committed 11.9A; the meter then sat at 10.8–11.2A for 17 minutes — room
    // for her real ~3.5A cost — while the once-per-session rule left the
    // learned 4.1A price to refuse every restore until the user acted by hand.
    // A committed meter ≥ PROBE_REARM_DROP_AMPS below the failed attempt's own
    // committed amps re-arms one probe (see probeRearmed — re-anchoring keeps
    // retries bounded).
    if (
      !fits.plain &&
      !fits.atFloors &&
      gentleRestore &&
      plainCost.amps > probeCost.amps + 1e-9 &&
      (restoreFailures(pacing, candidate.deviceId) === 0 ||
        probeRearmed(pacing, candidate.deviceId, committedAmps))
    ) {
      const probeFits = fitsWith(probeCost.amps);
      if (probeFits.plain || probeFits.atFloors) {
        cost = probeCost;
        probe = true;
        fits = probeFits;
      }
    }
    const fitsPlain = fits.plain;
    const fitsAtFloors = fits.atFloors;

    // Can't return this tick even with peer floor-downs → reserve NOTHING
    // (raises don't change floors math, so parking here would be a permanent
    // strand); the next-most-needy candidate may still fit.
    if (!fitsPlain && !fitsAtFloors) {
      decisions.push({
        at: now,
        deviceId: candidate.deviceId,
        action: "restore",
        // envelopeFloorsOk is the most permissive envelope case (everyone at
        // floors); if even that is over the breaker model, physics is the
        // blocker, not the meter — label it so the journal is diagnosable.
        blockedBy: !envelopeFloorsOk ? "physics envelope" : "no headroom",
        detail: `floors ${(committedAmps - savingsAtFloors + cost.amps).toFixed(1)}A vs ${restoreCeiling.toFixed(1)}A${rampNote}`,
      });
      continue;
    }

    // Feasible but its restore backoff is cooling (a recent restore bounced):
    // reserve its amps AND park raises (below) so a running AC can't grab the
    // headroom the moment the backoff clears. Bounded by the backoff ladder
    // (≤15 min) — never permanent. Keep scanning: a less-needy room may ship.
    if (!canAttempt(pacing, candidate.deviceId, "restore", now)) {
      reservedAmps = Math.max(reservedAmps, cost.amps);
      decisions.push({
        at: now,
        deviceId: candidate.deviceId,
        action: "restore",
        blockedBy: "backoff",
        detail: `reserved ${cost.amps.toFixed(1)}A`,
      });
      continue;
    }

    // A restore was SENT within the confirm window and the shadow still shows
    // OFF (shed clears only on confirmed ON since 2026-07-27): the turn-on is
    // in flight, its draw is neither metered nor ramp-debited yet. Reserve its
    // amps and STOP — nothing else may spend into a meter picture that is
    // about to change wholesale. Past the window the loop re-sends (Najat's
    // firmware drops commands; confirm-or-resend is the cure).
    if (attemptedWithin(pacing, candidate.deviceId, "restore", RESTORE_CONFIRM_WAIT_MS, now)) {
      reservedAmps = Math.max(reservedAmps, cost.amps);
      decisions.push({
        at: now,
        deviceId: candidate.deviceId,
        action: "restore",
        blockedBy: "awaiting confirm",
        detail: `reserved ${cost.amps.toFixed(1)}A`,
      });
      break;
    }

    // Feasible but waiting out its calm gate: reserve its amps and STOP — no
    // queue-jumping past a needier room that is merely time-gated.
    if (!restoreCalmOk) {
      reservedAmps = Math.max(reservedAmps, cost.amps);
      decisions.push({
        at: now,
        deviceId: candidate.deviceId,
        action: "restore",
        blockedBy: "calm",
        detail: `reserved ${cost.amps.toFixed(1)}A`,
      });
      break;
    }

    // Calm-clear and feasible → ship it now. Plain if it fits alone; otherwise
    // pull every raised peer down to its floor in the same batch. On gen the
    // room comes back GENTLE — fan pinned to 1 — so the range automation's
    // hot-room fan-slam (3–7, un-modeled) can't re-push the meter over; grid is
    // roomy enough to restore plain. Over-estimating a restore errs trip-safe,
    // and graded restores drift the on-cost EWMA down over time.
    const restoreCmd = (): Command =>
      gentleRestore
        ? { deviceId: candidate.deviceId, kind: "power_on", level: floor, reason: "restore", fan: 1 }
        : { deviceId: candidate.deviceId, kind: "power_on", level: floor, reason: "restore" };
    const probeIds = probe ? [candidate.deviceId] : [];
    const probeDetail = probe
      ? `probe at ${cost.amps.toFixed(1)}A (learned ${plainCost.amps.toFixed(1)}A unproven)`
      : undefined;
    if (fitsPlain) {
      commands.push(restoreCmd());
      attempts.push({ deviceId: candidate.deviceId, kind: "restore", meterAmps: committedAmps });
      decisions.push({ at: now, deviceId: candidate.deviceId, action: `restore @L${floor}`, detail: probeDetail });
      return { commands, decisions, attempts, isTurnOn: true, reservedAmps, probeRestoreIds: probeIds, cutAmps };
    }
    for (const a of onManaged) {
      const f = floorOf(a);
      if (a.currentLevel > f) {
        commands.push({ deviceId: a.deviceId, kind: "set_level", level: f });
        cutAmps += modelCutAmps(config, a.deviceId, source, a.currentLevel, f, a.maxLevel);
      }
    }
    commands.push(restoreCmd());
    attempts.push({ deviceId: candidate.deviceId, kind: "restore", meterAmps: committedAmps });
    decisions.push({
      at: now,
      deviceId: candidate.deviceId,
      action: `restore @L${floor} with peer floor-downs`,
      detail: probeDetail,
    });
    return { commands, decisions, attempts, isTurnOn: true, reservedAmps, probeRestoreIds: probeIds, cutAmps };
  }

  // A feasible restore is reserved but gated (backoff/calm) — park the ENTIRE
  // raise phase, warm raises included. Per-amp reservation alone can't stop a
  // warm raise (it's calm-exempt) from rewinding the shared calm clock the
  // pending restore depends on (the shell resetCalm()s after every non-fan
  // batch), so the whole phase stands down. Never a permanent strand: an
  // infeasible-at-floors candidate reserves nothing, and a reserved one is
  // bounded by restoreCalmSeconds (~15s) or one backoff rung.
  if (reservedAmps > 0) {
    decisions.push({
      at: now,
      action: "raises",
      blockedBy: "restore reservation",
      detail: `${reservedAmps.toFixed(1)}A reserved`,
    });
    return { commands, decisions, attempts, isTurnOn: false, reservedAmps, probeRestoreIds: [], cutAmps };
  }

  // ---- Raise phase: one-step, meter-anchored, most-needy first ----
  // `available` is the meter-anchored budget; every command debits what the
  // meter has NOT yet seen — a level raise its delta, a grid start the whole
  // steady draw of the AC that just came on (see gridStartLevel).
  // …minus what ramping compressors have committed but not yet spent on the
  // meter, or a peer raise buys amps a neighbour is already on its way to using.
  let available = input.headroomAmps - input.rampDebitAmps;
  const raiseCalmOk = input.calmMs >= config.raiseCalmSeconds * 1000;
  const restingCeiling = input.limitAmps - config.marginAmps - config.restingBufferAmps;

  const candidates = onManaged
    .filter((a) => a.currentLevel >= 1)
    .map((a) => ({ ac: a, ceil: ceilOf(a, config.nearTargetBandC) }))
    .filter(({ ac, ceil }) => ac.currentLevel < ceil)
    .sort((x, y) => y.ac.needDelta - x.ac.needDelta || acs.indexOf(x.ac) - acs.indexOf(y.ac));

  /**
   * Rooms parked above the level their own need justifies — dormant capacity a
   * hot peer may reclaim. No dwell requirement here (unlike the idle demote): a
   * room that is actually waiting on these amps is evidence enough. `ceilOf`
   * honours manualTarget, so a user-pinned room is never harvested.
   */
  const harvestableFor = (raiser: AcView): Array<{ ac: AcView; target: number }> =>
    onManaged
      .filter((a) => a.deviceId !== raiser.deviceId && !a.ramping && a.currentLevel >= 1)
      .map((a) => ({ ac: a, target: ceilOf(a, config.nearTargetBandC) }))
      .filter(({ ac: peer, target }) => peer.currentLevel > target);

  /**
   * Comparative-need donors (user, 2026-08-01): peers holding a level above
   * their FLOOR whose room is at least `REBALANCE_NEED_GAP_C` cooler than the
   * blocked raiser — ONE step each, coolest room first. Unlike the satisfied
   * harvest, a donor is still paying for cooling it wants, so the gap is the
   * whole justification: the hotter room's need outranks it. The gap doubles
   * as the anti-bounce hysteresis — after the trade the receiver runs at least
   * gap-hotter than the donor, so the reverse trade cannot arm until the rooms
   * genuinely cross by the same margin. Never past the floor, never a manual
   * pin (a pinned level is user intent, not spare capacity), never a ramping
   * compressor. An unconfirmed donor demote does not ratchet: `currentLevel`
   * moves only on confirm, so a re-plan re-emits the SAME target (a resend).
   *
   * Only a receiver sitting AT ITS FLOOR may take a trade — that is the user's
   * literal ask ("the other on the base level"), and it is load-bearing: a
   * receiver already holding an extra level competes through the ordinary
   * budget, and letting it trade re-broke the resting-point quiet acceptance
   * (a warm L2 room endlessly milked a milder L2 peer for an L3 it could
   * never actually fund).
   */
  const rebalanceDonorsFor = (raiser: AcView): Array<{ ac: AcView; target: number }> => {
    if (raiser.currentLevel > floorOf(raiser)) return [];
    return onManaged
      .filter(
        (a) =>
          a.deviceId !== raiser.deviceId &&
          !a.ramping &&
          a.manualTarget == null &&
          a.currentLevel > floorOf(a) &&
          a.needDelta + REBALANCE_NEED_GAP_C <= raiser.needDelta,
      )
      .sort((x, y) => x.needDelta - y.needDelta)
      .map((a) => ({ ac: a, target: Math.max(floorOf(a), a.currentLevel - 1) }));
  };

  const cutOfFunding = (f: { ac: AcView; target: number }): number =>
    modelCutAmps(config, f.ac.deviceId, source, f.ac.currentLevel, f.target, f.ac.maxLevel);

  const emitDemotes = (peers: Array<{ ac: AcView; target: number }>): number => {
    let cut = 0;
    for (const { ac: peer, target } of peers) {
      commands.push({ deviceId: peer.deviceId, kind: "set_level", level: target });
      cut += modelCutAmps(config, peer.deviceId, source, peer.currentLevel, target, peer.maxLevel);
    }
    return cut;
  };

  for (const { ac, ceil } of candidates) {
    // A gen start window is an ENTRY POLICY, and entry policy outranks the
    // raise phase for that device — the same rule FLOORS gets. Without this the
    // clamp and the raise phase fight inside one batch: `invariantCorrections`
    // emits L1, the raise emits L2/L3, and dedupe (last writer wins) hands the
    // room straight back to the level nobody admitted. A warm restore would win
    // it even mid-ramp, since `warmStartLevel` is exempt from the ramping gate.
    // The room climbs normally once the window closes and the meter agrees.
    if (source === "gen" && ac.startBaselineAmps != null) {
      decisions.push({ at: now, deviceId: ac.deviceId, action: "raise", blockedBy: "gen start floor" });
      continue;
    }
    // Grid turn-on full start (user directive "on grid start all to full"):
    // an AC that just came on restores its last gen level (usually L1 from the
    // previous gen episode) — lift it to the affordable ceiling in ONE command
    // instead of making it wait out the 4-min ramp gate and creep up a step at
    // a time. Priced against its pre-start baseline, minus whatever this batch
    // already committed, so two simultaneous starts can't spend the same amps.
    const startBaseline = source === "grid" ? ac.startBaselineAmps : null;
    const startTarget =
      startBaseline == null
        ? null
        : gridStartLevel(ac, ceil, config, restingCeiling - (input.headroomAmps - available));
    const warmTarget =
      ac.warmStartLevel != null && ac.warmStartLevel > ac.currentLevel
        ? Math.min(ac.warmStartLevel, ceil)
        : null;
    // A grid start and a warm restore are both exempt from the calm gate (one
    // is the entry policy, the other a recently-proven level) and from the ramp
    // gate; ordinary raises need sustained calm and a settled meter.
    if (startBaseline != null) {
      if (startTarget == null) {
        decisions.push({
          at: now,
          deviceId: ac.deviceId,
          action: `grid start L${ceil}`,
          blockedBy: "no headroom",
          detail: `${startBaseline.toFixed(1)}A before start + L${ac.currentLevel + 1} draw > ${restingCeiling.toFixed(1)}A`,
        });
        continue;
      }
    } else if (warmTarget == null) {
      if (!raiseCalmOk) {
        decisions.push({ at: now, deviceId: ac.deviceId, action: "raise", blockedBy: "calm" });
        continue;
      }
      if (ac.ramping) {
        decisions.push({ at: now, deviceId: ac.deviceId, action: "raise", blockedBy: "ramping" });
        continue;
      }
    }
    if (!canAttempt(pacing, ac.deviceId, "raise", now)) {
      decisions.push({ at: now, deviceId: ac.deviceId, action: "raise", blockedBy: "backoff" });
      continue;
    }
    let target = startTarget ?? warmTarget ?? ac.currentLevel + 1;
    // Physics envelope BEFORE the meter gate: a frozen or ramp-lagging meter
    // can show room for an end-state the cap models know exceeds the breaker
    // (2026-07-23: two ACs at L3 on the 15A gen = 15.6A worst case → trip).
    // Envelope is monotonic in level, so a too-high warm target degrades to
    // the highest safe level instead of stranding the AC.
    if (envelopeGuard) {
      const desired = target;
      while (target > ac.currentLevel && raiseEnvelope({ [ac.deviceId]: target }) > envelopeCeiling) target--;
      if (target === ac.currentLevel) {
        // FUNDING SWAP, envelope-blocked case. The cap models object, but the
        // METER may already hold the amps — and the peers standing in the way
        // are satisfied, i.e. drawing well under the caps the envelope charges
        // them for. Pull them to their own ceilings in the SAME batch and
        // re-check the end-state. When the satisfied harvest alone cannot fix
        // the end-state, comparative-need donors join one at a time (coolest
        // room first) — never more comfort spent than the envelope needs.
        //
        // Same-batch is only sound here. When the meter itself is short (the
        // branch below) the raise would be riding savings that have not landed,
        // and a satisfied compressor can take minutes to throttle down — on a
        // breaker that tripped at 15.65A on 2026-07-26 that is a real breach,
        // not a modelling nicety.
        const funding = harvestableFor(ac);
        const satCount = funding.length;
        const donors = rebalanceDonorsFor(ac).filter(
          (d) => !funding.some((f) => f.ac.deviceId === d.ac.deviceId),
        );
        const overridesOf = (list: Array<{ ac: AcView; target: number }>): Record<string, number> => {
          const o: Record<string, number> = { [ac.deviceId]: desired };
          for (const f of list) o[f.ac.deviceId] = f.target;
          return o;
        };
        while (donors.length > 0 && raiseEnvelope(overridesOf(funding)) > envelopeCeiling) {
          funding.push(donors.shift()!);
        }
        const swapJump = raiseJumpAmps(book, config, ac.deviceId, source, ac.currentLevel, desired, ac.maxLevel, now);
        // A donor-funded await must also clear the conservative fund check —
        // a satisfied-only harvest is comfort-free and keeps its old
        // unconditional behavior.
        const freedByFunding = funding.reduce((sum, f) => sum + cutOfFunding(f), 0);
        const donorFundOk =
          funding.length === satCount ||
          swapJump.amps <= Math.max(0, available) + freedByFunding - REBALANCE_FUND_MARGIN_AMPS;
        if (funding.length > 0 && raiseEnvelope(overridesOf(funding)) <= envelopeCeiling && donorFundOk) {
          if (swapJump.amps <= available) {
            // The meter already holds the amps — only the cap models objected.
            // Ship it as one batch.
            cutAmps += emitDemotes(funding);
            commands.push({ deviceId: ac.deviceId, kind: "set_level", level: desired });
            attempts.push({ deviceId: ac.deviceId, kind: "raise" });
            decisions.push({
              at: now,
              deviceId: ac.deviceId,
              action: `raise L${ac.currentLevel}→L${desired} funded by peer demote`,
              detail: `${funding.map((f) => `${f.ac.deviceId}→L${f.target}`).join(", ")}; ${swapJump.amps.toFixed(1)}A ${swapJump.confidence}`,
            });
            available -= swapJump.amps;
            if (source === "gen") break;
            continue;
          }
          // The swap fixes the envelope but the METER is short: free the amps
          // now, raise in a later calm window once they have actually landed.
          const freed = emitDemotes(funding);
          cutAmps += freed;
          decisions.push({
            at: now,
            deviceId: ac.deviceId,
            action: `raise L${desired}`,
            blockedBy: "awaiting demote",
            detail: `freeing ~${freed.toFixed(1)}A from ${funding.map((f) => `${f.ac.deviceId}→L${f.target}`).join(", ")}`,
          });
          break;
        }
        decisions.push({
          at: now,
          deviceId: ac.deviceId,
          action: `raise L${desired}`,
          blockedBy: "physics envelope",
          detail:
            `worst case ${raiseEnvelope({ [ac.deviceId]: desired }).toFixed(1)}A ` +
            `(incl. ${input.nonAcAmps.toFixed(1)}A house) > ${envelopeCeiling.toFixed(1)}A on ${source}`,
        });
        continue;
      }
    }
    const jump = raiseJumpAmps(book, config, ac.deviceId, source, ac.currentLevel, target, ac.maxLevel, now);
    // A grid start was already admitted against its pre-start baseline — the
    // meter cannot price it while the compressor is still ramping.
    if (startTarget == null && jump.amps > available) {
      // FUNDING SWAP, meter-blocked case: free the amps NOW, raise LATER.
      // Deliberately not one batch — the credit for a demote is a prediction,
      // and this room's raise is admissible only if that prediction is already
      // true. Shipping both together would commit ~16A on a 15A generator for
      // however long the demoted compressor takes to actually throttle down
      // (seconds to minutes on this firmware). The raise follows in the next
      // calm window, against a meter that has really fallen.
      //
      // Satisfied rooms are demoted regardless of coverage (dormant levels are
      // not comfort); a comparative-need donor pays real comfort, so donors
      // join only while the deficit is still uncovered — and when even every
      // donor cannot cover it, none of them pay.
      const satisfied = harvestableFor(ac);
      const donors = rebalanceDonorsFor(ac).filter(
        (d) => !satisfied.some((f) => f.ac.deviceId === d.ac.deviceId),
      );
      // Conservative funding target: the raise must fit AFTER the cuts land
      // with REBALANCE_FUND_MARGIN_AMPS to spare — the deficit is read off a
      // noisy meter, and a trade armed on a noise dip is the donor↔receiver
      // limit cycle the acceptance suite caught.
      const needed = jump.amps - Math.max(0, available) + REBALANCE_FUND_MARGIN_AMPS;
      let covered = satisfied.reduce((sum, f) => sum + cutOfFunding(f), 0);
      const picked: Array<{ ac: AcView; target: number }> = [];
      for (const d of donors) {
        if (covered >= needed) break;
        picked.push(d);
        covered += cutOfFunding(d);
      }
      const funding = picked.length === 0 || covered >= needed ? [...satisfied, ...picked] : satisfied;
      if (funding.length > 0) {
        const freed = emitDemotes(funding);
        cutAmps += freed;
        decisions.push({
          at: now,
          deviceId: ac.deviceId,
          action: `raise L${target}`,
          blockedBy: "awaiting demote",
          detail: `freeing ~${freed.toFixed(1)}A from ${funding.map((f) => `${f.ac.deviceId}→L${f.target}`).join(", ")}`,
        });
        break;
      }
      decisions.push({
        at: now,
        deviceId: ac.deviceId,
        action: `raise L${target}`,
        blockedBy: "no headroom",
        detail: `needs ${jump.amps.toFixed(1)}A (${jump.confidence}), ${Math.max(0, available).toFixed(1)}A available${rampNote}`,
      });
      continue;
    }
    commands.push({ deviceId: ac.deviceId, kind: "set_level", level: target });
    attempts.push({ deviceId: ac.deviceId, kind: "raise" });
    if (startTarget != null) {
      // The meter has seen ~none of this AC yet → debit its WHOLE steady draw.
      const wholeDraw = steadyDraw(target, ac.maxLevel, modelFor(config, ac.deviceId, source));
      decisions.push({
        at: now,
        deviceId: ac.deviceId,
        action: `grid start L${ac.currentLevel}→L${target}`,
        detail: `${(startBaseline ?? 0).toFixed(1)}A before start + ${wholeDraw.toFixed(1)}A modeled`,
      });
      available -= wholeDraw;
    } else {
      decisions.push({
        at: now,
        deviceId: ac.deviceId,
        action: `raise L${ac.currentLevel}→L${target}`,
        detail: `${jump.amps.toFixed(1)}A ${jump.confidence}`,
      });
      available -= jump.amps;
    }
    // Gen: ONE raise command per batch — confirm on the meter, then the next.
    if (source === "gen") break;
  }

  return { commands, decisions, attempts, isTurnOn: false, reservedAmps, probeRestoreIds: [], cutAmps };
}
