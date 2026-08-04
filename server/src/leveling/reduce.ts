// The ONE graduated reducer — used at every severity (v1 shipped two planners:
// the everyday path could only floor-everyone while only the emergency path
// searched graduated cuts; the everyday over-cut was structural). Ported from
// v1 selectReduction (its lexicographic comparator and never-level-0 pre-pass
// are the best-tested logic in the system) with three deliberate changes:
//
//   1. Savings are priced by the persistent cost model (costs.ts): a level cut
//      is credited at max(model delta, learned jump) — the static model
//      under-crediting cuts is what shed a 4.3A room to cover 0.3A.
//   2. Fan moves are enumerable only when the WHOLE candidate set has run out
//      of level cuts (and only when no shed is being forced): levels first,
//      fans as the last try before turning a room off — the user's 2026-07-31
//      directive. (v1 priced fans 10× cheaper than levels and cut them FIRST —
//      57% of live fan cuts fired with level cuts still available.)
//   3. v1's fromFloor mode is gone — one pipeline always reduces from observed
//      levels, graduated.
//
// Lexicographic objective (unchanged from v1): feasible ≫ protect hot rooms
// (min Σ shedNeed — which counts a hot room parked below its comfort floor,
// see SUBFLOOR_NEED_FRACTION) ≫ need-weighted disruption (shed ≫ level ≫ fan;
// top-priority level surcharge; re-shed-after-failed-restore penalty) ≫ less
// over-cut (bucketed) ≫ fewer commands ≫ fewer ACs disturbed.

import type { AcView, PowerSource } from "./types.js";
import type { CostBook } from "./costs.js";
import type { LevelingConfigV2 } from "./config.js";
import { fanTrimSavings, levelCutSavings, modelFor, steadyDraw } from "./costs.js";
import { ceilCapOf, ceilOf, floorOf, isNonCooling } from "./needs.js";

export interface ReductionWeights {
  shed: number;
  levelStep: number;
  fan: number;
  needK: number;
  topPriority: number;
  reshedPenalty: number;
  /** Surcharge per level step taken BELOW an AC's comfort floor (see below). */
  subFloorStep: number;
}

/**
 * How much of a room's cooling need a sub-floor cut costs it, relative to
 * switching the room off outright (invariant 36).
 *
 * Below an ACTIVE comfort floor a hot room mostly stops cooling — that is the
 * whole reason the floor exists — so the "protect hot rooms" term counts it.
 * Not the FULL need, for one structural reason: at 1.0 a plan that sheds a cool
 * peer AND sub-floors the hot room scores worse than shedding the hot room
 * outright (0.3 + 7.0 > 7.0), and the reducer would answer by killing the room
 * it is meant to protect. Anything below 1.0 keeps "sub-floor beats off" true
 * for the SAME room at every need level; 0.9 also says something honest — the
 * room keeps its fan, and the user's report is "most of the time", not always.
 */
export const SUBFLOOR_NEED_FRACTION = 0.9;

/**
 * How much milder a running room must be than the room whose turn-on caused an
 * overload before it is shed INSTEAD of that room (user, 2026-08-03 evening:
 * "why it turned off mine not najat?").
 *
 * "Undo the turn-on, don't make a bystander pay" outranked "protect the hotter
 * room" absolutely, which is right when the two rooms are comparably warm — you
 * should not flip your AC on and find a different room switched off. It is
 * wrong when the bystander is barely warm: live 20:24:50, a 0.3A overshoot shed
 * the user's own 33°C room (need 4.2) while a 28.2°C room (need 2.5) kept
 * running, and shedding the milder one would have covered the deficit five
 * times over. The gap keeps the no-surprise rule for close calls and lets a
 * genuinely hotter room keep cooling.
 *
 * 1.5 → 1.0 on the user's own instruction, 2026-08-04: **"1 c is enough to
 * switch between acs"**. He lives with the consequence either way, and the
 * shape he objected to (a 1.7°C gap) still clears the smaller bar; what the
 * change buys is that a genuinely hotter room is protected sooner.
 *
 * Also read by the FLOORS recovery admission (pipeline.ts), which uses it for
 * the same question in the other direction: once a room has been refused, may a
 * COOLER one take the amps it could not use?
 */
export const SHED_NEED_GAP_C = 1.0;

export const DEFAULT_REDUCTION_WEIGHTS: ReductionWeights = {
  shed: 100,
  levelStep: 10,
  fan: 1,
  needK: 1.5,
  topPriority: 25,
  reshedPenalty: 400,
  // Between the fan rung (1) and the shed rung (100): the search exhausts
  // levels and fans first, and still reaches for a sub-floor level before it
  // will switch a room off.
  subFloorStep: 40,
};

export interface ReducePlan {
  /** Level-change commands: deviceId → new level (changed, non-shed ACs only). */
  desiredLevels: Record<string, number>;
  /** Power OFF — least-needy first, top-priority last. */
  toShed: string[];
  /** Fan trims with exact targets (floor-level ACs only, small residuals only). */
  fanCuts: Array<{ deviceId: string; target: number }>;
  /** End-state level of every non-shed AC. */
  idealLevels: Record<string, number>;
  estimatedSavingsAmps: number;
  overCutAmps: number;
  /** Whether the plan covers requiredAmps. */
  satisfied: boolean;
}

export interface ReduceInput {
  /** ON, managed, non-shed candidates, pre-sorted by priority (highest first). */
  acs: AcView[];
  requiredAmps: number;
  /** Extreme overshoot: a covering plan that sheds nothing is infeasible. */
  requireShed: boolean;
  /**
   * Turn-on inrush blanking (default true): when false the search may not
   * enumerate a power-off at all, so a transient that is about to decay can
   * only be answered with level cuts and fan trims. Set by the pipeline for a
   * MILD overshoot whose smoothed meter is still under the limit while a
   * compressor is ramping (the 2026-07-25 restore-bounce storm).
   */
  allowShed?: boolean;
  /**
   * When a shed IS taken, prefer this device: the room whose own turn-on caused
   * the overload. Ranked above the need ordering, so the re-shed penalty can
   * never export the shed to a bystander that did nothing.
   */
  preferShed?: string | null;
  fanTrimEnabled: boolean;
  book: CostBook;
  config: LevelingConfigV2;
  source: Exclude<PowerSource, "none">;
  now: number;
  weights?: ReductionWeights;
}

interface AcMove {
  level: number | null; // end level, or null = shed/off
  fanTarget: number | null;
  savings: number;
  cost: number;
  commands: number;
  disturbed: boolean;
  shedNeed: number;
  /**
   * Cooling this move costs a room by parking it below its active comfort floor
   * at a level that will not cool it (`isNonCooling`). Tracked separately from
   * `shedNeed` so the two remain legible in the leaf, where both are summed.
   */
  subFloorNeed: number;
  /** This move leaves the AC running ABOVE its floor — a level is still on offer. */
  aboveFloor: boolean;
}

interface ComboScore {
  combo: AcMove[];
  savings: number;
  cost: number;
  commands: number;
  disturbed: number;
  shedNeed: number;
  feasible: boolean;
  /**
   * This combo sheds a room OTHER than the one whose turn-on caused the
   * overload, while leaving that room running — "a bystander pays". Ranked
   * immediately after feasibility so it beats every other preference.
   */
  exportsShed: boolean;
}

/** Output order: least-needy first, top-priority last (historical shed-order semantics). */
function reductionOutputOrder(acs: AcView[]): AcView[] {
  const [top, ...rest] = acs;
  const sorted = rest.slice().sort((a, b) => a.needDelta - b.needDelta || acs.indexOf(b) - acs.indexOf(a));
  return top ? [...sorted, top] : sorted;
}

function reductionBetter(a: ComboScore, b: ComboScore, required: number): boolean {
  if (a.feasible !== b.feasible) return a.feasible;
  if (a.exportsShed !== b.exportsShed) return !a.exportsShed;
  if (a.feasible) {
    const an = Math.round(a.shedNeed * 10);
    const bn = Math.round(b.shedNeed * 10);
    if (an !== bn) return an < bn;
    if (Math.abs(a.cost - b.cost) > 1e-9) return a.cost < b.cost;
    const ao = Math.round(Math.max(0, a.savings - required) * 2);
    const bo = Math.round(Math.max(0, b.savings - required) * 2);
    if (ao !== bo) return ao < bo;
    if (a.commands !== b.commands) return a.commands < b.commands;
    return a.disturbed < b.disturbed;
  }
  if (a.savings !== b.savings) return a.savings > b.savings;
  return a.cost < b.cost;
}

export function planReduction(input: ReduceInput): ReducePlan {
  const { acs, requiredAmps, requireShed, book, config, source, now } = input;
  // A forced shed (extreme) always outranks the inrush blanking — a real breach
  // beats "this might be a transient".
  const allowShed = requireShed || (input.allowShed ?? true);
  const preferShed = input.preferShed ?? null;
  const w = input.weights ?? DEFAULT_REDUCTION_WEIGHTS;
  const needWeight = (ac: AcView): number => 1 + w.needK * Math.max(0, ac.needDelta);
  const topId = acs[0]?.deviceId ?? null;
  const needById = new Map(acs.map((a) => [a.deviceId, Math.max(0, a.needDelta)]));
  const preferShedNeed = preferShed != null ? (needById.get(preferShed) ?? 0) : 0;
  /** Every room this plan sheds is clearly milder than the room that caused it. */
  const shedsOnlyMilder = (shedIds: string[]): boolean =>
    shedIds.every((id) => (needById.get(id) ?? 0) + SHED_NEED_GAP_C <= preferShedNeed);

  // "Reduce the levels, then the fan speed as the last try before turning off"
  // (user, 2026-07-31). The floor gate used to be PER-AC: a room already at its
  // own floor offered its fan while a PEER still had a whole level to give, and
  // the comparator then took the fan every time — w.fan (1) against w.levelStep
  // (10) is a 100×-ish gap once needWeight is applied. Live 17:32:53 on a gen
  // 1.0A over its limit: Abdullah sat at L3 with a 2.5A cut available and the
  // reducer trimmed 0.4A off Abdu's fan instead. The level came down 38s later,
  // by which time the breaker had gone.
  //
  // The gate is now per-PLAN, enforced at the leaf (see `recurse`): a candidate
  // plan may cut a fan only if its own end-state leaves every AC at its floor.
  // Deliberately not a global "no fan while any level exists anywhere" — that
  // reading forces a SHED whenever levels alone fall a little short of the
  // deficit, which is the opposite of "fans are the last try BEFORE turning
  // off". Levels + fans together must always be reachable before a room dies.

  const perAc = acs.map((ac, index) => {
    const floor = floorOf(ac);
    // Upper candidate level: the observed level, except an unrestricted (0) AC
    // re-enters at its top commandable level (never level 0).
    const upper = ac.currentLevel > 0 ? Math.max(floor, ac.currentLevel) : ceilCapOf(ac);
    // Effective "from" for step counting & savings (level 0 = one above max).
    const effFrom = ac.currentLevel > 0 ? ac.currentLevel : ac.maxLevel + 1;
    const isTop = ac.deviceId === topId;
    // The level this room's own need justifies. Levels above it are dormant
    // capacity: giving them up costs the occupant nothing (see the surcharge
    // bound below). `ceilOf` honours manualTarget, so a user-pinned room keeps
    // its full protection.
    const ceil = ceilOf(ac, config.nearTargetBandC);
    const model = modelFor(config, ac.deviceId, source);
    const baselineDraw = steadyDraw(effFrom, ac.maxLevel + 1, model);

    const fanChoices = (level: number): Array<{ target: number | null; savings: number }> => {
      const choices: Array<{ target: number | null; savings: number }> = [{ target: null, savings: 0 }];
      // Fans are last-resort trim: only at this AC's floor level, only when no
      // shed is forced, and only when the user hasn't touched the fan this
      // episode. Whether the PLAN as a whole has earned a fan is decided at the
      // leaf, where the peers' end-states are known.
      if (!input.fanTrimEnabled || requireShed || level > floor) return choices;
      if (ac.fanExempt || ac.fanSpeed == null || (ac.fanSpeed !== 0 && ac.fanSpeed <= 1)) return choices;
      if (ac.fanSpeed === 0) {
        // Built-in auto is indivisible — one binary drop to 1.
        choices.push({ target: 1, savings: fanTrimSavings(book, ac.deviceId, source, 6, now) });
      } else {
        for (let target = ac.fanSpeed - 1; target >= 1; target--) {
          choices.push({
            target,
            savings: fanTrimSavings(book, ac.deviceId, source, ac.fanSpeed - target, now),
          });
        }
      }
      return choices;
    };

    const moves: AcMove[] = [];
    // The comfort floor (`minLevel` — the outdoor-heat boost) is a PREFERENCE,
    // and being switched off is worse for the occupant than any level. So the
    // ladder has one more rung below the floor before a room dies: levels down
    // to L1, surcharged so the search only reaches them once level cuts and fan
    // trims are exhausted, and always before a shed.
    //
    // User, 2026-08-02: the TOP-priority room was shed three times in ten
    // minutes while sitting at its L2 boost floor with both peers already at
    // L1 and fan 1 — its own fan trim (0.6A) could not cover a 1.14A deficit,
    // so the only feasible plan left was 4.8A of power_off to answer 1.1A. L1
    // would have covered it with the room still running.
    //
    // That rung stays — for the room itself it is still better than an off —
    // but it is no longer FREE when the room is hot: see the `shedNeed` term
    // below, where a sub-floor cut is priced as what it physically is.
    //
    // Never level 0: that is UNRESTRICTED draw, not a reduction (hard rule).
    const HARD_FLOOR = 1;
    for (let level = HARD_FLOOR; level <= upper; level++) {
      const belowFloorSteps = Math.max(0, floor - level);
      const steps = Math.max(0, effFrom - level);
      const levelChanged = level !== ac.currentLevel;
      const levelSavings = levelChanged && level < effFrom
        ? ac.currentLevel > 0
          ? levelCutSavings(book, config, ac.deviceId, source, effFrom, level, ac.maxLevel, now)
          : baselineDraw - steadyDraw(level, ac.maxLevel, model)
        : 0;
      for (const fanChoice of fanChoices(level)) {
        const fanDrop = fanChoice.target != null;
        let cost = (steps * w.levelStep + belowFloorSteps * w.subFloorStep) * needWeight(ac);
        if (fanDrop) cost += w.fan * needWeight(ac);
        // The top-priority surcharge protects a room's COMFORT, so it only
        // applies where comfort is actually at stake — a move that lands at or
        // above this AC's own need ceiling is giving up levels the near-target
        // cap already says buy nothing (2026-06-11: "within 0.5°C of target it
        // should not use more than L1").
        //
        // Without this bound the surcharge re-created, one tier down, the very
        // complaint the 2026-06-13 "priority is a tiebreak, not a shed shield"
        // decision fixed for sheds. Live 2026-07-28 16:06: Najat sat satisfied
        // at L3 and was first in priority among the ON ACs (Abdullah was off,
        // so she inherited the top slot); cutting her cost 17.5 + 25 = 42.5 vs
        // 38.5 to cut Abdu — whose room was 1.9°C hot. The reducer took the
        // amps from the hot room and left the dormant levels standing, twice
        // more at 16:38 and 16:40.
        if (levelChanged && isTop && level < ceil) cost += w.topPriority;
        moves.push({
          level,
          fanTarget: fanChoice.target,
          savings: levelSavings + fanChoice.savings,
          cost,
          commands: (levelChanged ? 1 : 0) + (fanDrop ? 1 : 0),
          disturbed: levelChanged || fanDrop,
          shedNeed: 0,
          // A level that does not cool is an off (user, 2026-08-03; invariant
          // 36). The comfort floor's whole meaning is "below this, this room
          // does not cool in this weather", so parking such a room under it
          // buys amps by stopping its compressor — the same outcome as a shed,
          // and the reducer used to score it at zero. Live 11:25:32 that made
          // {shed Najat (need 1.6) + Abdullah L2→L1} score 1.6 and beat
          // {shed Abdu} at 1.8: the hottest, top-priority room stopped cooling
          // to keep a milder one running, and — being a level and not a shed —
          // nothing tracked it as off. It sat at 28°C against a setpoint of 20
          // until the user intervened, and by that evening at 34°C against the
          // same setpoint, when switching it off changed the meter barely at all.
          //
          // `isNonCooling` owns the test: within 2°C of target the level still
          // works (and the watch checks that against the thermometer), so those
          // rooms keep their sub-floor rung free.
          subFloorNeed: isNonCooling(ac, level) ? Math.max(0, ac.needDelta) * SUBFLOOR_NEED_FRACTION : 0,
          aboveFloor: level > floor,
        });
      }
    }
    // Power-off move. Priority breaks equal-need ties (lowest priority first);
    // need is the real driver via the shedNeed comparison term.
    // Withheld entirely during turn-on inrush blanking (see ReduceInput).
    if (allowShed) {
      let shedCost = w.shed * needWeight(ac) + (acs.length - 1 - index) * 1e-3;
      // The room that caused this overload is exempt from the re-shed penalty:
      // undoing its own turn-on is the correct move, not a bounce to punish.
      if (ac.reshedPenalized && ac.deviceId !== preferShed) shedCost += w.reshedPenalty;
      moves.push({
        level: null,
        fanTarget: null,
        savings: baselineDraw,
        cost: shedCost,
        commands: 1,
        disturbed: true,
        shedNeed: Math.max(0, ac.needDelta),
        subFloorNeed: 0,
        aboveFloor: false, // a room that is off is not withholding a level
      });
    }
    return { ac, moves };
  });

  // Exhaustive cartesian search — ≤3 ACs × ~10 moves ≈ a few hundred leaves.
  const EPS = 1e-9;
  let best: ComboScore | null = null;
  let maxSheds = 1;
  const combo: AcMove[] = new Array(perAc.length);
  const recurse = (
    i: number,
    savings: number,
    cost: number,
    commands: number,
    disturbed: number,
    shedNeed: number,
    sheds: number,
    fanCuts: number,
    aboveFloor: number,
    subFloorNeed: number,
  ): void => {
    if (i === perAc.length) {
      // Levels before fans, judged on the PLAN: a candidate that trims a fan
      // while its own end-state still parks a room above that room's floor has
      // skipped a lever. Discard it outright rather than pricing it — the
      // comparator's cost terms are per-AC need-weighted and a satisfied room's
      // fan will always undercut a hot room's level (live: 4.6 vs 140).
      if (fanCuts > 0 && aboveFloor > 0) return;
      // ≤3 ACs, so scanning the leaf is cheaper than threading two more counters.
      const shedIds = combo.flatMap((mv, idx) => (mv.level == null ? [perAc[idx].ac.deviceId] : []));
      const candidate: ComboScore = {
        combo: combo.slice(),
        savings,
        cost,
        commands,
        disturbed,
        // The protection term ranks who pays with their cooling. A room parked
        // below its comfort floor while `isNonCooling` holds is paying in full
        // — it is off in everything but the paperwork — so it counts here like
        // a shed room, but ONLY once the plan is already taking a room out of
        // service.
        //
        // The user's rule ("L1 above the boost temperature should not happen")
        // argues for counting it unconditionally, and that was tried: on a line
        // whose MEAN sits under the limit it turns the stable answer into a
        // shed CYCLE — the acceptance scenario went shed → restore → shed →
        // restore, 4 power commands in 10 minutes, and parked the room at L1 in
        // the end anyway. The reducer refuses the silent answer, its only
        // alternative is a shed, and the restore path undoes each one because
        // the post-shed meter genuinely looks affordable.
        //
        // So the rule is honoured in the two places it changes an outcome
        // without that cost — this term when something is going off anyway, and
        // the recovery ranking in raise.ts — and the unconditional form waits on
        // a restore-bounce backoff, without which it has nowhere stable to land.
        shedNeed: shedNeed + (sheds > 0 ? subFloorNeed : 0),
        feasible: savings >= requiredAmps - EPS && (!requireShed || sheds > 0),
        // "A bystander pays" — but only when the bystander is not obviously the
        // right room to lose. A plan that sheds ONLY rooms clearly milder than
        // the causer (see SHED_NEED_GAP_C) is not exporting anything; it is the
        // hot-room protection doing its job, and it competes normally on the
        // shedNeed term below.
        exportsShed:
          preferShed != null &&
          shedIds.length > 0 &&
          !shedIds.includes(preferShed) &&
          !shedsOnlyMilder(shedIds),
      };
      if (best == null || reductionBetter(candidate, best, requiredAmps)) best = candidate;
      return;
    }
    for (const mv of perAc[i].moves) {
      if (mv.level == null && sheds >= maxSheds) continue;
      combo[i] = mv;
      recurse(
        i + 1,
        savings + mv.savings,
        cost + mv.cost,
        commands + mv.commands,
        disturbed + (mv.disturbed ? 1 : 0),
        shedNeed + mv.shedNeed,
        sheds + (mv.level == null ? 1 : 0),
        fanCuts + (mv.fanTarget != null ? 1 : 0),
        aboveFloor + (mv.aboveFloor ? 1 : 0),
        subFloorNeed + mv.subFloorNeed,
      );
    }
  };
  // One room at a time, and only more when the arithmetic says one cannot do it
  // (user, 2026-08-02): "it is not the best thing to turn off more than one then
  // try to bring back one by one, as that duration will raise the room temp fast
  // until the compressor works … it turn off one by one … unless the pump is big
  // that already need more than one to off."
  //
  // Live 16:51:11 both remaining rooms went off in ONE batch to answer a 3.96A
  // deficit that either room covered alone. So the search runs with a one-shed
  // ceiling first and only raises it when nothing at that ceiling covers the
  // deficit — which is exactly the "big pump" case, where waiting a pass would
  // only prolong the overload.
  //
  // …except at EXTREME, where the ceiling never lifts. Invariant 33 defines that
  // rung as "exactly ONE room off" — the user's own trade against losing the
  // whole house — and it exists to relieve a sustained strain, not to clear an
  // arithmetic bill. Live 2026-08-04 12:53:45Z the tier arrived with a 4.57A
  // deficit invented from a lone inrush spike (see SEVERE_STREAK_READINGS), no
  // single room covered it, the ceiling lifted, and BOTH remaining rooms went
  // off at once for a mean sitting 0.025A over the limit. A deficit that
  // genuinely needs a second room still gets one — from the NEXT evaluation,
  // re-priced against a meter that has seen the first shed, one room at a time
  // exactly as invariant 26 asks.
  const shedCeiling = requireShed ? 1 : perAc.length;
  for (maxSheds = 1; maxSheds <= shedCeiling; maxSheds++) {
    best = null;
    recurse(0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
    if (best != null && (best as ComboScore).feasible) break;
  }

  const chosen: ComboScore =
    best ?? {
      combo: [],
      savings: 0,
      cost: 0,
      commands: 0,
      disturbed: 0,
      shedNeed: 0,
      feasible: requiredAmps <= EPS,
      exportsShed: false,
    };
  const moveOf = new Map<string, AcMove>();
  perAc.forEach((p, i) => moveOf.set(p.ac.deviceId, chosen.combo[i]));

  const desiredLevels: Record<string, number> = {};
  const idealLevels: Record<string, number> = {};
  const toShed: string[] = [];
  const fanCuts: Array<{ deviceId: string; target: number }> = [];
  for (const ac of reductionOutputOrder(acs)) {
    const mv = moveOf.get(ac.deviceId);
    if (!mv) continue;
    if (mv.level == null) {
      toShed.push(ac.deviceId);
      continue;
    }
    idealLevels[ac.deviceId] = mv.level;
    // Reduce-only contract: never emit a raise (a boost floor above the
    // observed level is the raise path's job, not the reducer's).
    if (mv.level !== ac.currentLevel && !(mv.level > ac.currentLevel && ac.currentLevel > 0)) {
      desiredLevels[ac.deviceId] = mv.level;
    }
    if (mv.fanTarget != null) fanCuts.push({ deviceId: ac.deviceId, target: mv.fanTarget });
  }

  return {
    desiredLevels,
    toShed,
    fanCuts,
    idealLevels,
    estimatedSavingsAmps: chosen.savings,
    overCutAmps: Math.max(0, chosen.savings - requiredAmps),
    satisfied: chosen.feasible,
  };
}
