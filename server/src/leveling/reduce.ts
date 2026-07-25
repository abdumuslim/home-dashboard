// The ONE graduated reducer — used at every severity (v1 shipped two planners:
// the everyday path could only floor-everyone while only the emergency path
// searched graduated cuts; the everyday over-cut was structural). Ported from
// v1 selectReduction (its lexicographic comparator and never-level-0 pre-pass
// are the best-tested logic in the system) with three deliberate changes:
//
//   1. Savings are priced by the persistent cost model (costs.ts): a level cut
//      is credited at max(model delta, learned jump) — the static model
//      under-crediting cuts is what shed a 4.3A room to cover 0.3A.
//   2. Fan moves attach ONLY to an AC's floor-level move (and only when no
//      shed is being forced): the search therefore exhausts graduated level
//      cuts before it ever touches a fan, and a fan trim beats a shed only for
//      the small residual deficit — the user's "fans are a last-resort trim"
//      decision. (v1 priced fans 10× cheaper than levels and cut them FIRST —
//      57% of live fan cuts fired with level cuts still available.)
//   3. v1's fromFloor mode is gone — one pipeline always reduces from observed
//      levels, graduated.
//
// Lexicographic objective (unchanged from v1): feasible ≫ protect hot rooms
// (min Σ shedNeed) ≫ need-weighted disruption (shed ≫ level ≫ fan; top-priority
// level surcharge; re-shed-after-failed-restore penalty) ≫ less over-cut
// (bucketed) ≫ fewer commands ≫ fewer ACs disturbed.

import type { AcView, PowerSource } from "./types.js";
import type { CostBook } from "./costs.js";
import type { LevelingConfigV2 } from "./config.js";
import { fanTrimSavings, levelCutSavings, modelFor, steadyDraw } from "./costs.js";
import { ceilCapOf, floorOf } from "./needs.js";

export interface ReductionWeights {
  shed: number;
  levelStep: number;
  fan: number;
  needK: number;
  topPriority: number;
  reshedPenalty: number;
}

export const DEFAULT_REDUCTION_WEIGHTS: ReductionWeights = {
  shed: 100,
  levelStep: 10,
  fan: 1,
  needK: 1.5,
  topPriority: 25,
  reshedPenalty: 400,
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

  const perAc = acs.map((ac, index) => {
    const floor = floorOf(ac);
    // Upper candidate level: the observed level, except an unrestricted (0) AC
    // re-enters at its top commandable level (never level 0).
    const upper = ac.currentLevel > 0 ? Math.max(floor, ac.currentLevel) : ceilCapOf(ac);
    // Effective "from" for step counting & savings (level 0 = one above max).
    const effFrom = ac.currentLevel > 0 ? ac.currentLevel : ac.maxLevel + 1;
    const isTop = ac.deviceId === topId;
    const model = modelFor(config, ac.deviceId, source);
    const baselineDraw = steadyDraw(effFrom, ac.maxLevel + 1, model);

    const fanChoices = (level: number): Array<{ target: number | null; savings: number }> => {
      const choices: Array<{ target: number | null; savings: number }> = [{ target: null, savings: 0 }];
      // Fans are last-resort trim: only enumerable at the AC's floor level,
      // only when no shed is forced, and only when the user hasn't touched
      // the fan this episode.
      if (!input.fanTrimEnabled || requireShed || level !== floor) return choices;
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
    for (let level = floor; level <= upper; level++) {
      const steps = Math.max(0, effFrom - level);
      const levelChanged = level !== ac.currentLevel;
      const levelSavings = levelChanged && level < effFrom
        ? ac.currentLevel > 0
          ? levelCutSavings(book, config, ac.deviceId, source, effFrom, level, ac.maxLevel, now)
          : baselineDraw - steadyDraw(level, ac.maxLevel, model)
        : 0;
      for (const fanChoice of fanChoices(level)) {
        const fanDrop = fanChoice.target != null;
        let cost = steps * w.levelStep * needWeight(ac);
        if (fanDrop) cost += w.fan * needWeight(ac);
        if (levelChanged && isTop) cost += w.topPriority;
        moves.push({
          level,
          fanTarget: fanChoice.target,
          savings: levelSavings + fanChoice.savings,
          cost,
          commands: (levelChanged ? 1 : 0) + (fanDrop ? 1 : 0),
          disturbed: levelChanged || fanDrop,
          shedNeed: 0,
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
      });
    }
    return { ac, moves };
  });

  // Exhaustive cartesian search — ≤3 ACs × ~10 moves ≈ a few hundred leaves.
  const EPS = 1e-9;
  let best: ComboScore | null = null;
  const combo: AcMove[] = new Array(perAc.length);
  const recurse = (
    i: number,
    savings: number,
    cost: number,
    commands: number,
    disturbed: number,
    shedNeed: number,
    sheds: number,
  ): void => {
    if (i === perAc.length) {
      // ≤3 ACs, so scanning the leaf is cheaper than threading two more counters.
      const shedIds = combo.flatMap((mv, idx) => (mv.level == null ? [perAc[idx].ac.deviceId] : []));
      const candidate: ComboScore = {
        combo: combo.slice(),
        savings,
        cost,
        commands,
        disturbed,
        shedNeed,
        feasible: savings >= requiredAmps - EPS && (!requireShed || sheds > 0),
        exportsShed:
          preferShed != null &&
          shedIds.length > 0 &&
          !shedIds.includes(preferShed),
      };
      if (best == null || reductionBetter(candidate, best, requiredAmps)) best = candidate;
      return;
    }
    for (const mv of perAc[i].moves) {
      combo[i] = mv;
      recurse(
        i + 1,
        savings + mv.savings,
        cost + mv.cost,
        commands + mv.commands,
        disturbed + (mv.disturbed ? 1 : 0),
        shedNeed + mv.shedNeed,
        sheds + (mv.level == null ? 1 : 0),
      );
    }
  };
  recurse(0, 0, 0, 0, 0, 0, 0);

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
