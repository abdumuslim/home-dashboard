// Floor/ceiling precedence for one AC — ported from v1 (floorOf/ceilOf/
// ceilCapOf/nearTargetNeedCap) with the bounce-cap term removed (v2 replaces
// sticky bounce caps with per-AC pacing backoff). Precedence rules preserved:
//   floors:   boost minimum, unless manual/slot/reachable clamp below it
//   ceilings: manualTarget beats need+slot caps; manualCap/slotCap intersect;
//             reachableCap (firmware physics) clamps EVERYTHING;
//             never below the floor; never level 0.

import type { AcView } from "./types.js";

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
