// Floor/ceiling precedence for one AC — ported from v1 (floorOf/ceilOf/
// ceilCapOf/nearTargetNeedCap) with the bounce-cap term removed (v2 replaces
// sticky bounce caps with per-AC pacing backoff). Precedence rules preserved:
//   floors:   boost minimum, unless manual/slot/reachable clamp below it
//   ceilings: manualTarget beats need+slot caps; manualCap/slotCap intersect;
//             reachableCap (firmware physics) clamps EVERYTHING;
//             never below the floor; never level 0.

import type { AcView } from "./types.js";

/**
 * How far above its setpoint a room may sit before a level BELOW its active
 * comfort floor stops counting as cooling at all (user, 2026-08-03 evening).
 *
 * The boost floor exists because above a configured outdoor temperature the
 * compressor often will not engage at the level beneath it. Within a couple of
 * degrees of target that still does useful work — the demand is small enough
 * that the unit cycles and keeps up. Past it the room simply stops cooling: the
 * user held Abdullah at L1 through 47.3°C outdoors, watched the room climb
 * 30 → 34°C against a setpoint of 20, then switched the AC off and saw almost
 * no change on the meter. A level nothing was drawing, in a room nothing was
 * cooling.
 *
 * Above this, such a room is treated as OFF — see `isNonCooling`.
 */
export const NON_COOLING_NEED_C = 2;

/**
 * How long a room may sit below its comfort floor showing NO cooling progress
 * before it is declared non-cooling regardless of how close to target it is.
 *
 * The 2°C band above is a prediction ("this close, L1 still works"); this is
 * the check on it (user, 2026-08-03: "at the 2 degrees, the system should watch
 * it if the compressor fall"). Long enough that a slow room on a hot afternoon
 * is not misjudged, short enough to catch a compressor that never engaged well
 * before the room drifts out of the band on its own.
 */
export const SUBFLOOR_WATCH_MS = 10 * 60 * 1000;

/** Cooling progress that re-bases the watch — two sensor LSBs, not noise. */
export const SUBFLOOR_PROGRESS_C = 0.2;

/**
 * Is this AC, at `level`, effectively switched off? True only below an ACTIVE
 * comfort floor (`floorOf` > 1 means a boost or slot floor is in force), and
 * then on either of two grounds:
 *
 *  - the room is more than `NON_COOLING_NEED_C` from target, so the compressor
 *    will not engage at all (the user's rule, and his measurement: switching
 *    the AC off barely moved the meter); or
 *  - it IS within that band, but has sat there `SUBFLOOR_WATCH_MS` without the
 *    room getting any cooler — the prediction tested against the thermometer.
 *
 * Room temperature is the signal on purpose. The tempting alternative — "it is
 * not drawing its modelled amps" — is circular here: the house residual is
 * `smoothed − modelled draw`, so a room under-drawing its model moves the very
 * number you would be reading. That reasoning already produced one wrong
 * diagnosis on 2026-08-03 and the user corrected it.
 *
 * Both directions of the ladder consult this: the reducer prices such a move as
 * a room going out of service, and the recovery path ranks such a room
 * alongside shed rooms rather than behind them.
 */
export function isNonCooling(ac: AcView, level: number): boolean {
  if (level >= floorOf(ac)) return false;
  return ac.needDelta > NON_COOLING_NEED_C || ac.subFloorStalledMs >= SUBFLOOR_WATCH_MS;
}

/** Hard floor (≥1). Manual/slot/reachable clamps win over the boost minimum. */
export function floorOf(ac: AcView): number {
  let floor = Math.max(1, Math.min(ac.minLevel, ac.maxLevel));
  if (ac.manualCap != null) floor = Math.min(floor, Math.max(1, ac.manualCap));
  if (ac.slotCap != null) floor = Math.min(floor, Math.max(1, ac.slotCap));
  if (ac.reachableCap != null) floor = Math.min(floor, Math.max(1, ac.reachableCap));
  return floor;
}

/**
 * Near-target hard cap: within the band of the target the room is about to be
 * satisfied — amps spent there buy nothing → L1. Beyond the band the budget
 * decides (no intermediate tiers).
 */
export function nearTargetNeedCap(needDelta: number, nearTargetBandC: number, maxLevel: number): number {
  return needDelta <= nearTargetBandC ? 1 : maxLevel;
}

/** Raise ceiling. manualTarget bypasses need+slot caps (manual beats automation). */
export function ceilOf(ac: AcView, nearBandC: number): number {
  const cap = ac.manualTarget != null
    ? ac.manualTarget
    : Math.min(
        nearTargetNeedCap(ac.needDelta, nearBandC, ac.maxLevel),
        ac.manualCap ?? ac.maxLevel,
        ac.slotCap ?? ac.maxLevel,
      );
  return Math.max(floorOf(ac), Math.min(cap, ac.reachableCap ?? ac.maxLevel, ac.maxLevel));
}

/**
 * The highest-DRAW level among candidates — for worst-case (envelope) pricing.
 * Not `Math.max`: level 0 means "unrestricted", which draws MORE than L3, so a
 * numeric max would silently under-price an unrestricted AC as if it were at
 * whatever level happens to be in flight (`steadyDraw` treats 0 as base +
 * step × maxLevel — see costs.ts).
 */
export function worstCaseLevel(levels: readonly number[]): number {
  if (levels.length === 0) return 0;
  if (levels.some((l) => l <= 0)) return 0;
  return Math.max(...levels);
}

/** Never-level-0 re-entry ceiling: top commandable level under physics/user caps. */
export function ceilCapOf(ac: AcView): number {
  return Math.max(
    floorOf(ac),
    Math.min(ac.maxLevel, ac.reachableCap ?? ac.maxLevel, ac.slotCap ?? ac.maxLevel, ac.manualCap ?? ac.maxLevel),
  );
}

/**
 * Outdoor-heat boost floor with 1°C hysteresis, ported from v1 minLevelFor:
 * activates at outdoor ≥ threshold, releases at ≤ threshold − 1, holds its
 * last state when the outdoor reading is unknown/stale.
 */
export function boostFloor(
  boost: { minLevel: number; outdoorAtLeastC: number } | undefined,
  outdoorC: number | null,
  wasActive: boolean,
): { minLevel: number; active: boolean } {
  if (boost == null) return { minLevel: 1, active: false };
  if (outdoorC == null) return { minLevel: wasActive ? boost.minLevel : 1, active: wasActive };
  const active = wasActive ? outdoorC > boost.outdoorAtLeastC - 1 : outdoorC >= boost.outdoorAtLeastC;
  return { minLevel: active ? boost.minLevel : 1, active };
}
