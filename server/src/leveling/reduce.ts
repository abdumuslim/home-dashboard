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
import { ceilCapOf, ceilOf, floorOf, hardFloorOf, isNonCooling } from "./needs.js";

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
 * Amended 2026-08-06 for the TOP-PRIORITY room ONLY: when IT is the causer the
 * bar drops to "strictly cooler" (see `exportBarClearedBy` in planReduction).
 * Every other causer keeps the full degree described above.
 *
 * Also read by the FLOORS recovery admission (pipeline.ts), which uses it for
 * the same question in the other direction: once a room has been refused, may a
 * COOLER one take the amps it could not use? — and by the shed-choice priority
 * tie-break below, which asks it of two candidate plans.
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
  /**
   * Set when the priority tie-break (see `shedPriorityTieBreak`) actually
   * CHANGED the shed choice — the room the raw need ordering would have taken,
   * and the lower-priority room that goes off in its place. Null otherwise.
   *
   * Forensics on shed choices is how every one of these rules got debugged, so
   * the pipeline names it in the `shed choice` decision. A silent tie-break is
   * a future mystery.
   */
  priorityTieBreak: { shedDeviceId: string; protectedDeviceId: string } | null;
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
  /**
   * This move takes the room OUT OF SERVICE: a shed, or a level parked below an
   * active comfort floor that will not cool it (invariant 36 — "a level that
   * does not cool is an off"). The priority tie-break protects rooms by this
   * test, not by `level == null`, so it cannot save a room from the off and then
   * hand it a silent one.
   */
  outOfService: boolean;
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
  /**
   * Index in the priority-ordered `acs` array of the BEST-PROTECTED room this
   * plan takes out of service (0 = top priority), or -1 when it takes nobody
   * out. The key the priority tie-break compares — a scalar `shedNeed` cannot
   * say WHICH rooms a plan sheds, and that is the whole question.
   */
  protectedIndex: number;
}

/** Output order: least-needy first, top-priority last (historical shed-order semantics). */
function reductionOutputOrder(acs: AcView[]): AcView[] {
  const [top, ...rest] = acs;
  const sorted = rest.slice().sort((a, b) => a.rankNeedDelta - b.rankNeedDelta || acs.indexOf(b) - acs.indexOf(a));
  return top ? [...sorted, top] : sorted;
}

/**
 * May PRIORITY promote this plan over the thermometer's own pick?
 *
 * Three conditions, all measured against the ANCHOR — the plan the raw need
 * ordering took (see `reductionBetter`):
 *
 *  - it protects a better room than the anchor does. The whole rule is "the
 *    top-priority room survives", so a promotion may only ever move the off
 *    DOWN the priority list; a plan that sacrifices a better-placed room than
 *    the thermometer's own pick has nothing to offer here;
 *  - it sits INSIDE the gap of the anchor. The boundary is exclusive, to match
 *    every other reader of this constant: `shedsOnlyMilder` calls a room
 *    "clearly milder" at exactly the gap, and so does the recovery admission in
 *    pipeline.ts. One constant, one meaning — live 2026-07-28 07:18 two rooms
 *    sat exactly 1.0°C apart, and an inclusive boundary would have re-decided
 *    that shed on priority;
 *  - the thermometer ranks it STRICTLY needier than the anchor. The tie-break
 *    only ever promotes a plan the need rung would have refused; plans the need
 *    rung calls equal (it rounds to a tenth) never reached it in the first
 *    place and keep the tail that has decided them since v1 — the shed cost's
 *    own `(acs.length - 1 - index)` term, which already breaks equal-need ties
 *    toward the lowest priority, and the re-shed penalty, which on an equal-need
 *    pair still moves the shed off a room that just bounced.
 */
function priorityPromotable(score: ComboScore, anchor: ComboScore): boolean {
  if (score.protectedIndex <= anchor.protectedIndex) return false;
  if (Math.abs(score.shedNeed - anchor.shedNeed) >= SHED_NEED_GAP_C - 1e-9) return false;
  return Math.round(score.shedNeed * 10) !== Math.round(anchor.shedNeed * 10);
}

/**
 * Rank reduction plans. `anchor` — when non-null — turns on the shed-choice
 * priority tie-break (user, 2026-08-06 14:38:11Z).
 *
 * Shed choice has been thermometer-only since 2026-08-04, top priority
 * included — and at 14:38 that shed Abdullah, priority #1, real need 4.0°C,
 * because Abdu ranked 0.05°C hotter and this rung rounds `shedNeed` to a tenth.
 * Both rooms sat far inside `SHED_NEED_GAP_C` of each other: the band the user
 * himself calibrated as "equally hot — 1 c is enough to switch between acs".
 * His rule, verbatim that afternoon: when the shed candidates are inside the
 * gap the configured priority list breaks the tie, and the top-priority room
 * survives. Outside it the thermometer still decides absolutely.
 *
 * The gap is measured against ONE anchor — the protection total of the plan the
 * raw need ordering would have taken — and never pairwise between the two plans
 * in hand. A pairwise gap test is not a transitive relation, and `best` is a
 * streaming best-so-far scan, so the winner of a chain would depend on the
 * order the search happens to enumerate leaves in. Staircase three rooms 0.6°C
 * apart (4.0 / 4.6 / 5.4): every adjacent pair is inside the gap and the ends
 * are not, so shed-mid loses to shed-low on priority, then shed-TOP takes the
 * incumbent on raw need — and the room the rule exists to protect goes off,
 * silently, with the journal reporting a plain thermometer choice. Anchoring
 * makes the rule a property of the FIELD of candidates, which is what the user
 * stated, and a total order, which is what the scan needs.
 *
 * The tie-break refines the shedNeed rung and nothing else: the lexicographic
 * ladder above it (feasibility, then `exportsShed` — "undo the turn-on, don't
 * make a bystander pay", invariant 43) and the cost/overcut/commands/disturbed
 * tail below are untouched, and only a plan the need rung ranks strictly worse
 * than the anchor can be promoted (see `priorityPromotable`). It is a plain
 * lexicographic key — promotable first, then best-protected — so the streaming
 * scan cannot be talked into a different answer by a different enumeration
 * order.
 *
 * A plan that takes NOBODY out of service is never promotable, so it keeps its
 * whole ordering against a shed plan: there is no tie to break, and such a plan
 * must never be ranked against one that sheds on anything but the need total.
 * (It cannot be on the losing side of a promotion either — a feasible non-
 * exporting no-shed plan has `shedNeed` 0 and would be the anchor itself.)
 *
 * Protection totals are the full scalars, so a plan that "spares" the
 * top-priority room by parking it below a floor that will not cool it is not
 * inside the gap of one that simply sheds a peer (invariant 36).
 */
function reductionBetter(a: ComboScore, b: ComboScore, required: number, anchor: ComboScore | null = null): boolean {
  if (a.feasible !== b.feasible) return a.feasible;
  if (a.exportsShed !== b.exportsShed) return !a.exportsShed;
  if (a.feasible) {
    if (anchor != null) {
      const aUp = priorityPromotable(a, anchor);
      const bUp = priorityPromotable(b, anchor);
      // A promotable plan is inside the gap of the cheapest-in-need plan there
      // is, so it beats one that is not: the other plan is either the anchor's
      // own need class — the class priority is being asked to overrule — or
      // genuinely needier, where the raw ordering says the same thing.
      if (aUp !== bUp) return aUp;
      // Lower priority pays: the LARGER index is the better-protected plan.
      if (aUp && a.protectedIndex !== b.protectedIndex) return a.protectedIndex > b.protectedIndex;
    }
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
  const needWeight = (ac: AcView): number => 1 + w.needK * Math.max(0, ac.rankNeedDelta);
  const topId = acs[0]?.deviceId ?? null;
  const needById = new Map(acs.map((a) => [a.deviceId, Math.max(0, a.rankNeedDelta)]));
  const preferShedNeed = preferShed != null ? (needById.get(preferShed) ?? 0) : 0;
  // The TOP-priority room's own turn-on exports to any room that is genuinely
  // cooler — the user's amendment of his own causer rule, 2026-08-06 evening
  // ("can turn Najat off instead"), for that one room only.
  //
  // The rule it amends is 2026-08-03 ("why it turned off mine not najat?"),
  // which bought the SHED_NEED_GAP_C bar below: inside a degree the rooms are
  // comparably warm, and flipping your AC on must not switch off a bystander.
  // Live 15:48:47Z that protected Najat (3.4) from Abdullah's own click
  // (priority #1, need 4.0) in a house where a room off was the only rung left
  // — the third such cycle of the day on the room the priority list exists to
  // keep cooling. Told the cost, the user took the trade: for the top room, a
  // comparably warm peer may pay, provided it really is cooler.
  //
  // "Cooler" at the shedNeed rung's OWN resolution (it rounds to a tenth), so a
  // room the thermometer cannot distinguish from the causer is not cooler and
  // the causer still undoes its own turn-on. Every other causer keeps the full
  // degree, unchanged.
  //
  // ⚠ The top room is the head of the CONFIGURED priority list, not `topId`
  // (= acs[0], the first room that happens to be ON). The two differ exactly
  // when the #1 room is off, and conflating them is a bug this file has already
  // paid for once — invariant 10, live 2026-07-28 16:06, where Najat inherited
  // the top slot and the surcharge meant for the #1 room started shielding a
  // satisfied one. Here it would let a #2 room export the overload of its own
  // leveler RESTORE onto a peer a tenth of a degree cooler (the 2026-07-27
  // evening bounce loop pins the opposite: her ramp must undo HER turn-on).
  // The user amended the rule for his top room; this keeps it that narrow.
  // With no configured list the order handed to the reducer IS the priority, so
  // acs[0] is the top room by definition.
  const topPriorityId = config.priority[0] ?? topId;
  const exportBarClearedBy = (shedNeed: number): boolean =>
    preferShed != null && preferShed === topPriorityId
      ? Math.round(shedNeed * 10) < Math.round(preferShedNeed * 10)
      : shedNeed + SHED_NEED_GAP_C <= preferShedNeed;
  /** Every room this plan sheds is clearly milder than the room that caused it. */
  const shedsOnlyMilder = (shedIds: string[]): boolean =>
    shedIds.every((id) => exportBarClearedBy(needById.get(id) ?? 0));

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
    //
    // …and never below `hardFloorOf` either (R14-hard, user 2026-08-04 at 47°C
    // outdoor: "that should never put it at l1"). More than BOOST_FLOOR_FLEX_C
    // above a room's configured boost threshold the compressor does not engage
    // beneath its floor at all, so a sub-floor cut is not a cheaper rung than a
    // shed — it IS the shed, minus the shed row, the restore queue and the push.
    // Live 17:27:18 the reducer took exactly that move on the hottest room
    // because it was the only level rung left. Above the band the room's
    // automatic ladder is L3 → L2 → off, and the off is priced as an off
    // (invariants 36/39), which is what routes it to the coolest room instead.
    //
    // Pricing alone was not enough: R9b prices such a cut as an off, and the
    // live batch still executed it, because the reducer will pay any price when
    // the alternative is infeasible. A target the search cannot enumerate is
    // the only form of "never" that holds.
    //
    // Clamped to `upper` — a room already BELOW its hard floor (the learned
    // hold can arm while a room sits at L1, and a boost band can arm around it)
    // must still be able to STAY there. Without the clamp such a room
    // enumerates no level move at all, and the only thing left on its board is
    // the power_off: the search would answer "L1 is not a target" by switching
    // the room off. The hard floor bans DESCENDING past it; buying the room
    // back up is the raise path's job (invariant 25's ⚠ — re-asserting a
    // comfort floor outside the raise path is the 2026-08-02 limit cycle).
    const HARD_FLOOR = Math.min(hardFloorOf(ac), upper);
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
          subFloorNeed: isNonCooling(ac, level) ? Math.max(0, ac.rankNeedDelta) * SUBFLOOR_NEED_FRACTION : 0,
          aboveFloor: level > floor,
          outOfService: isNonCooling(ac, level),
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
        shedNeed: Math.max(0, ac.rankNeedDelta),
        subFloorNeed: 0,
        aboveFloor: false, // a room that is off is not withholding a level
        outOfService: true,
      });
    }
    return { ac, moves };
  });

  // Exhaustive cartesian search — ≤3 ACs × ~10 moves ≈ a few hundred leaves.
  const EPS = 1e-9;
  let best: ComboScore | null = null;
  // The winner of the SAME search scored without the priority tie-break — the
  // thermometer's own pick. It is both the anchor the tie-break measures its gap
  // against and, at the end, how the journal knows whether priority actually
  // changed the answer.
  let bestRaw: ComboScore | null = null;
  // Non-null only on the second pass (see the maxSheds loop below).
  let anchor: ComboScore | null = null;
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
        // the recovery ranking in raise.ts.
        //
        // ⚠ RE-TESTED 2026-08-04 (R9b) once the restore-bounce backoff and the
        // per-room shed bar (R9) existed, which was the named prerequisite. It
        // still cycles, and the backoff is not what is missing. On the gen
        // flicker trio riding a MEAN of ~14.6A under a 14.9A ceiling, forty
        // minutes produced 41 commands against the conditional form's 4:
        //
        //   t+125  shed najat            (unconditional: 1.0 beats 2.7)
        //   t+160  abdullah → L3         (the shed freed real amps; the raise
        //                                 path spent them, correctly)
        //   t+400  restore najat, abdullah floor-down funding it
        //   t+1605 shed najat again … and round.
        //
        // The bar did NOT fail: the second restore was funded by a peer's
        // genuine floor-down, so it fits at floors honestly. The loop is
        // structural — the shed frees headroom, the raise path is entitled to
        // it, and the line goes over again — and closing it means a shed that
        // does not hand its amps straight back.
        //
        // ⚠ UPDATE 2026-08-06: that prerequisite now EXISTS. The user approved
        // the parked "gated proactive shed" after the 02:21 heater episode, and
        // it lives in `raise.ts` (`swapDonorFor` + the swap branch of the
        // restore phase): a shed whose freed amps are RESERVED for a named
        // hotter room, with the donor barred from taking them back. It is not,
        // however, the same thing as flipping this term — it fires from the
        // RECOVERY side, on a calm line, for a room that is already off. This
        // term would still have to answer "shed a running room because a level
        // is not cooling it", and the 41-commands-in-40-minutes evidence above
        // is about THAT question.
        //
        // Left conditional, on evidence, for the second time. Do not flip it
        // without re-running that scenario and reading the command list — now
        // with the swap live, which changes what the restore path does next.
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
        // Priority order IS the `acs`/`combo` index order, so the first room
        // this plan takes out of service is the best-protected one it sacrifices.
        // A non-cooling sub-floor counts only once the plan already sheds —
        // exactly the condition the protection term above is gated on.
        protectedIndex: sheds > 0 ? combo.findIndex((mv) => mv.outOfService) : -1,
      };
      if (best == null || reductionBetter(candidate, best, requiredAmps, anchor)) best = candidate;
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
  // The ceiling stops at TWO, and the whole shed policy is the user's, stated
  // in full on 2026-08-04 (~17:25) after he watched 12:53:45Z shed both
  // remaining rooms for a mean sitting 0.025A over the limit:
  //
  //   "if the system knows that it can cover with the coolest room ac, let it
  //    do it. if not, and knows the other 2 ton will be enough, it can turn it
  //    off only. if the spike is too much and no single ac can cover it, let it
  //    turn off the coolest 2 acs."
  //
  // Which is exactly what this search already expresses, once the deficit it is
  // handed is honest (SEVERE_STREAK_READINGS — a lone inrush spike used to size
  // 4.57A at zero real overshoot, and no single room could cover THAT):
  //
  //   maxSheds 1 → every feasible single-shed plan; the comparator ranks them
  //                by `shedNeed`, which since R13 is REAL room temperature, so
  //                the winner is the coolest room whose off actually covers it.
  //                If the coolest cannot and the 2-ton can, the 2-ton is the
  //                only feasible single and wins on feasibility.
  //   maxSheds 2 → no single room covers it: the coolest PAIR, in one batch.
  //
  // Capping at two is what makes "the hottest room always survives" true with
  // three rooms — and with two rooms it is no cap at all, so the 2026-08-02
  // "big pump" case is unchanged. A deficit that outruns even the coolest pair
  // leaves the batch infeasible and the next evaluation re-decides against a
  // meter that has seen this one, which is invariant 26's own answer.
  //
  // ⚠ This SUPERSEDES the stage-1 rule (same afternoon) that capped the extreme
  // rung at exactly one shed and left a second room to the next pass. Invariant
  // 33's "exactly ONE room off" holds for every deficit a single room can cover,
  // which is the case it was written for; the user's ruling is what governs the
  // case where none can.
  const SHED_BATCH_MAX = 2;
  const shedCeiling = Math.min(perAc.length, SHED_BATCH_MAX);
  for (maxSheds = 1; maxSheds <= shedCeiling; maxSheds++) {
    // Two passes, because the priority tie-break is anchored on the answer the
    // thermometer alone would give and that answer is not known until the field
    // has been scored once (see reductionBetter). The second pass runs only when
    // there IS a shed to re-decide, and a pass is a few hundred leaves.
    anchor = null;
    best = null;
    recurse(0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
    // `recurse` fills `best` through the closure, which the narrowing from the
    // assignment above cannot see (same reason as the cast on the break below).
    const raw = best as ComboScore | null;
    bestRaw = raw;
    // Nothing to re-decide unless the thermometer's pick took a room out of
    // service and some LOWER-priority room could take its place instead.
    if (
      raw != null &&
      raw.feasible &&
      !raw.exportsShed &&
      raw.protectedIndex >= 0 &&
      raw.protectedIndex < perAc.length - 1
    ) {
      anchor = raw;
      best = null;
      recurse(0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
    }
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
      protectedIndex: -1,
    };
  const shedIdsOf = (score: ComboScore): string[] =>
    score.combo.flatMap((mv, idx) => (mv.level == null ? [perAc[idx].ac.deviceId] : []));
  // "The tie-break decided" = the priority pick and the raw-need pick disagree
  // about who goes off. Anything less (the same shed set reached by a different
  // level combination) is not a shed choice and does not belong in the journal.
  const rawShed = bestRaw != null ? shedIdsOf(bestRaw) : [];
  const tieShed = shedIdsOf(chosen);
  const protectedDeviceId = rawShed.find((id) => !tieShed.includes(id));
  const shedDeviceId = tieShed.find((id) => !rawShed.includes(id));
  const priorityTieBreak =
    protectedDeviceId != null && shedDeviceId != null ? { shedDeviceId, protectedDeviceId } : null;

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
    priorityTieBreak,
  };
}
