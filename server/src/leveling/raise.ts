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
    if (!canAttempt(pacing, candidate.deviceId, "restore", now)) {
      decisions.push({
        at: now,
        deviceId: candidate.deviceId,
        action: "restore",
        blockedBy: "backoff",
      });
      continue; // backoff = blocked; the next candidate may try (no permanent strand)
    }
    const floor = floorOf(candidate);
    const cost = turnOnAmps(book, config, candidate.deviceId, source, floor, candidate.maxLevel, now);
    const candidateEntry = { deviceId: candidate.deviceId, level: floor, maxLevel: candidate.maxLevel };
    const envelopePlainOk = !envelopeGuard || envelopeWith({}, candidateEntry) <= envelopeCeiling;
    const fitsPlain = envelopePlainOk && input.smoothedAmps + cost.amps <= restoreCeiling;

    if (fitsPlain && restoreCalmOk) {
      commands.push({ deviceId: candidate.deviceId, kind: "power_on", level: floor, reason: "restore" });
      attempts.push({ deviceId: candidate.deviceId, kind: "restore" });
      decisions.push({ at: now, deviceId: candidate.deviceId, action: `restore @L${floor}` });
      return { commands, decisions, attempts, isTurnOn: true };
    }

    if (fitsPlain && !restoreCalmOk) {
      // Feasible but waiting out its calm gate: reserve its amps so raises
      // can't steal them — but DON'T park the whole system (v2 change).
      reservedAmps = cost.amps;
      decisions.push({
        at: now,
        deviceId: candidate.deviceId,
        action: "restore",
        blockedBy: "calm",
        detail: `reserved ${cost.amps.toFixed(1)}A`,
      });
      break;
    }

    // Restore-with-reduction: judge feasibility at FLOORS — pull every raised
    // peer to its floor in the same batch when that makes the restore fit.
    const savingsAtFloors = onManaged.reduce((sum, a) => {
      const f = floorOf(a);
      return a.currentLevel > f
        ? sum + levelCutSavings(book, config, a.deviceId, source, a.currentLevel, f, a.maxLevel, now)
        : sum;
    }, 0);
    const floorOverrides = Object.fromEntries(onManaged.map((a) => [a.deviceId, floorOf(a)]));
    const envelopeFloorsOk = !envelopeGuard || envelopeWith(floorOverrides, candidateEntry) <= envelopeCeiling;
    if (envelopeFloorsOk && input.smoothedAmps - savingsAtFloors + cost.amps <= restoreCeiling) {
      if (!restoreCalmOk) {
        reservedAmps = cost.amps;
        decisions.push({ at: now, deviceId: candidate.deviceId, action: "restore", blockedBy: "calm" });
        break;
      }
      for (const a of onManaged) {
        const f = floorOf(a);
        if (a.currentLevel > f) commands.push({ deviceId: a.deviceId, kind: "set_level", level: f });
      }
      commands.push({ deviceId: candidate.deviceId, kind: "power_on", level: floor, reason: "restore" });
      attempts.push({ deviceId: candidate.deviceId, kind: "restore" });
      decisions.push({
        at: now,
        deviceId: candidate.deviceId,
        action: `restore @L${floor} with peer floor-downs`,
      });
      return { commands, decisions, attempts, isTurnOn: true };
    }

    // Infeasible even at floors: parks nothing (raises don't change floors math).
    decisions.push({ at: now, deviceId: candidate.deviceId, action: "restore", blockedBy: "no headroom" });
  }

  // ---- Raise phase: one-step, meter-anchored, most-needy first ----
  let available = input.headroomAmps - reservedAmps;
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

  return { commands, decisions, attempts, isTurnOn: false };
}
