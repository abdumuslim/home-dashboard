// Headroom spending for leveling v2: shed restores, warm restores, one-step
// level raises, and the hard-invariant corrections (never level 0, boost
// floors). Pure — pacing gates are consulted here but mutated by the caller.
//
// Ordering (ported user decisions): a feasible shed RESTORE outranks every
// raise ("all ACs on beats higher levels"); a restore gated only by pacing
// RESERVES its amps so raises can't steal them (v2 change — v1 parked every
// raise globally, stranding rooms for 49m+); raises are meter-anchored and
// one-step, most-needy room first; on gen only ONE raise command per batch
// (the 07-23 double-raise landed 16.6A on a 14.9A limit).

import type { AcView, Command, Decision, PowerSource } from "./types.js";
import type { CostBook } from "./costs.js";
import { levelCutSavings, modelFor, raiseJumpAmps, steadyDraw, turnOnAmps } from "./costs.js";
import type { LevelingConfigV2 } from "./config.js";
import { ceilCapOf, ceilOf, floorOf } from "./needs.js";
import { canAttempt, type PacingState } from "./pacing.js";

/**
 * Physics-envelope total: worst-case steady draw of a commanded end-state,
 * summed from the per-AC cap models. A gen level is a firmware CAP — under
 * binding (hot) demand the compressor is entitled to the whole cap, and the
 * meter only shows that minutes later (or never, when the ESP hangs frozen).
 * This is the number that already knew "expected 16.9A > 15A" when the
 * 2026-07-23 double-L3 batch shipped and tripped the gen breaker.
 * Non-AC load is deliberately excluded: the cap models over-state cool-room
 * draw and v2 has no trustworthy non-AC split; the meter-side admission stays
 * the primary gate — this is the catastrophic-end-state backstop.
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

export interface RaiseInput {
  /** ALL managed AC views (on and off/shed), pre-sorted by priority. */
  acs: AcView[];
  /** Room under the resting ceiling (limit − margin − restingBuffer − smoothed). */
  headroomAmps: number;
  smoothedAmps: number;
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
  /** Attempts to record in pacing (blame windows) — deviceId × kind. */
  attempts: Array<{ deviceId: string; kind: "raise" | "restore" }>;
  /** True when the batch turns an AC on (longer settle/ramp downstream). */
  isTurnOn: boolean;
  /**
   * Amps held back for a feasible-but-gated shed restore. > 0 means the raise
   * phase was parked (see the parking guard) — the caller must also keep a fan
   * restore from spending these amps.
   */
  reservedAmps: number;
}

/**
 * Hard-invariant corrections that ship regardless of calm/pacing (but not in
 * COLLAPSED — no commands into a dead line): an ON managed AC observed at
 * level 0 is re-capped at its top commandable level; an AC below its boost
 * floor is lifted to it.
 */
export function invariantCorrections(acs: AcView[], now: number): { commands: Command[]; decisions: Decision[] } {
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
    }
  }
  return { commands, decisions };
}

export function planRaise(input: RaiseInput): RaisePlan {
  const { acs, config, book, source, now, pacing } = input;
  const decisions: Decision[] = [];
  const attempts: Array<{ deviceId: string; kind: "raise" | "restore" }> = [];
  const commands: Command[] = [];

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
          level: overrides[a.deviceId] ?? a.currentLevel,
          maxLevel: a.maxLevel,
        })),
        ...(extra != null ? [extra] : []),
      ],
      config,
      source,
    );

  // ---- Restore phase: most-needy shed AC first, no queue jumping ----
  // Restores are exempt from the resting buffer (a whole room off is worse
  // than riding near the limit): fits under limit − margin.
  const restoreCeiling = input.limitAmps - config.marginAmps;
  const restoreCalmOk = input.calmMs >= config.restoreCalmSeconds * 1000;
  let reservedAmps = 0;

  const shedCandidates = acs
    .filter((a) => a.shed && a.managed && !a.on)
    .sort((a, b) => b.needDelta - a.needDelta || acs.indexOf(a) - acs.indexOf(b));

  for (const candidate of shedCandidates) {
    const floor = floorOf(candidate);
    const cost = turnOnAmps(book, config, candidate.deviceId, source, floor, candidate.maxLevel, now);
    const candidateEntry = { deviceId: candidate.deviceId, level: floor, maxLevel: candidate.maxLevel };

    // Both feasibilities up front, BEFORE any gate — the reservation decision
    // needs to know whether this room could return at all (plain, or by pulling
    // every raised peer down to its floor in the same batch).
    const envelopePlainOk = !envelopeGuard || envelopeWith({}, candidateEntry) <= envelopeCeiling;
    const fitsPlain = envelopePlainOk && input.smoothedAmps + cost.amps <= restoreCeiling;

    const savingsAtFloors = onManaged.reduce((sum, a) => {
      const f = floorOf(a);
      return a.currentLevel > f
        ? sum + levelCutSavings(book, config, a.deviceId, source, a.currentLevel, f, a.maxLevel, now)
        : sum;
    }, 0);
    const floorOverrides = Object.fromEntries(onManaged.map((a) => [a.deviceId, floorOf(a)]));
    const envelopeFloorsOk = !envelopeGuard || envelopeWith(floorOverrides, candidateEntry) <= envelopeCeiling;
    const fitsAtFloors = envelopeFloorsOk && input.smoothedAmps - savingsAtFloors + cost.amps <= restoreCeiling;

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
        detail: `floors ${(input.smoothedAmps - savingsAtFloors + cost.amps).toFixed(1)}A vs ${restoreCeiling.toFixed(1)}A`,
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
    // pull every raised peer down to its floor in the same batch.
    if (fitsPlain) {
      commands.push({ deviceId: candidate.deviceId, kind: "power_on", level: floor, reason: "restore" });
      attempts.push({ deviceId: candidate.deviceId, kind: "restore" });
      decisions.push({ at: now, deviceId: candidate.deviceId, action: `restore @L${floor}` });
      return { commands, decisions, attempts, isTurnOn: true, reservedAmps };
    }
    for (const a of onManaged) {
      const f = floorOf(a);
      if (a.currentLevel > f) commands.push({ deviceId: a.deviceId, kind: "set_level", level: f });
    }
    commands.push({ deviceId: candidate.deviceId, kind: "power_on", level: floor, reason: "restore" });
    attempts.push({ deviceId: candidate.deviceId, kind: "restore" });
    decisions.push({ at: now, deviceId: candidate.deviceId, action: `restore @L${floor} with peer floor-downs` });
    return { commands, decisions, attempts, isTurnOn: true, reservedAmps };
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
    return { commands, decisions, attempts, isTurnOn: false, reservedAmps };
  }

  // ---- Raise phase: one-step, meter-anchored, most-needy first ----
  let available = input.headroomAmps;
  const raiseCalmOk = input.calmMs >= config.raiseCalmSeconds * 1000;

  const candidates = onManaged
    .filter((a) => a.currentLevel >= 1)
    .map((a) => ({ ac: a, ceil: ceilOf(a, config.nearTargetBandC) }))
    .filter(({ ac, ceil }) => ac.currentLevel < ceil)
    .sort((x, y) => y.ac.needDelta - x.ac.needDelta || acs.indexOf(x.ac) - acs.indexOf(y.ac));

  for (const { ac, ceil } of candidates) {
    const warmTarget =
      ac.warmStartLevel != null && ac.warmStartLevel > ac.currentLevel
        ? Math.min(ac.warmStartLevel, ceil)
        : null;
    // Warm restores are exempt from the calm gate (the level was recently
    // proven stable); ordinary raises need sustained calm and a settled meter.
    if (warmTarget == null) {
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
    let target = warmTarget ?? ac.currentLevel + 1;
    // Physics envelope BEFORE the meter gate: a frozen or ramp-lagging meter
    // can show room for an end-state the cap models know exceeds the breaker
    // (2026-07-23: two ACs at L3 on the 15A gen = 15.6A worst case → trip).
    // Envelope is monotonic in level, so a too-high warm target degrades to
    // the highest safe level instead of stranding the AC.
    if (envelopeGuard) {
      const desired = target;
      while (target > ac.currentLevel && envelopeWith({ [ac.deviceId]: target }) > envelopeCeiling) target--;
      if (target === ac.currentLevel) {
        decisions.push({
          at: now,
          deviceId: ac.deviceId,
          action: `raise L${desired}`,
          blockedBy: "physics envelope",
          detail: `worst case ${envelopeWith({ [ac.deviceId]: desired }).toFixed(1)}A > ${envelopeCeiling.toFixed(1)}A on ${source}`,
        });
        continue;
      }
    }
    const jump = raiseJumpAmps(book, config, ac.deviceId, source, ac.currentLevel, target, ac.maxLevel, now);
    if (jump.amps > available) {
      decisions.push({
        at: now,
        deviceId: ac.deviceId,
        action: `raise L${target}`,
        blockedBy: "no headroom",
        detail: `needs ${jump.amps.toFixed(1)}A (${jump.confidence}), ${Math.max(0, available).toFixed(1)}A available`,
      });
      continue;
    }
    commands.push({ deviceId: ac.deviceId, kind: "set_level", level: target });
    attempts.push({ deviceId: ac.deviceId, kind: "raise" });
    decisions.push({
      at: now,
      deviceId: ac.deviceId,
      action: `raise L${ac.currentLevel}→L${target}`,
      detail: `${jump.amps.toFixed(1)}A ${jump.confidence}`,
    });
    available -= jump.amps;
    // Gen: ONE raise command per batch — confirm on the meter, then the next.
    if (source === "gen") break;
  }

  return { commands, decisions, attempts, isTurnOn: false, reservedAmps };
}
