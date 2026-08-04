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
 *
 * Shipped at 10 min; the user cut it to 3 after watching an afternoon of it
 * (2026-08-04: "no need for 10 min, 3 min is enough"). What consumes the window
 * is a working compressor's own duty cycle — it must be able to show
 * SUBFLOOR_PROGRESS_C (0.2°C, two sensor LSBs) inside it or a healthy room
 * reads as dead. A TCL cycles in ones of minutes and a room that IS cooling
 * moves 0.2°C well inside three; ten minutes was simply longer than the
 * evidence needed, and every minute of it is a minute the hottest room spends
 * at a level its compressor is not running at.
 */
export const SUBFLOOR_WATCH_MS = 3 * 60 * 1000;

/** Cooling progress that re-bases the watch — two sensor LSBs, not noise. */
export const SUBFLOOR_PROGRESS_C = 0.2;

/** Open below-floor stretch: when it began, and the need it has yet to beat. */
export interface SubFloorWatch {
  at: number;
  need: number;
}

/**
 * One tick of the sub-floor watch — the SINGLE implementation behind
 * `AcView.subFloorStalledMs`, used by both the controller shell and the
 * scenario harness so the two can never drift (the mirror-drift trap that hid
 * bug 14 for five days).
 *
 * ⚠ The `tempKnown` gate is load-bearing, and it is where `satisfiedForMs`'s
 * no-stale-guard argument INVERTS. A dead room sensor maps to needDelta
 * EXACTLY 1 (computeAcNeed's sentinel) — inside the 2°C band and constant, so
 * it can never show the 0.2°C of progress that re-bases this clock; ten
 * minutes of dead sensor would read as "compressor never engaged" and the
 * recovery path would start SPENDING on a thermometer that is lying. For the
 * demote that failure mode was a harmless L1 cap; here it is a raise, so a
 * tick without a real reading reports 0 — acting always requires a live
 * thermometer. The record is kept, not reset: when the sensor returns, the two
 * REAL endpoint readings still answer "did this room get cooler" honestly.
 *
 * Known accepted edge: when an automation rule drives needDelta from a WEATHER
 * metric (e.g. the feels-like range rules), `tempKnown` reflects the AC's own
 * thermometer, not that feed — a frozen weather station freezes the delta and
 * the watch can accrue on it. Deliberately not plumbed (it needs a freshness
 * flag through LevelerDeviceContext): the worst outcome is one envelope-guarded
 * step up to the comfort floor, which is approximately what the floor asks for
 * absent better information — the same accepted-risk class as satisfiedForMs's
 * stale-but-plausible reading, with the same self-correction once the feed
 * recovers.
 */
export function nextSubFloorWatch(
  prev: SubFloorWatch | null,
  input: { active: boolean; belowFloor: boolean; needDelta: number; tempKnown: boolean; now: number },
): { watch: SubFloorWatch | null; stalledMs: number } {
  if (!input.active || !input.belowFloor) return { watch: null, stalledMs: 0 };
  if (!input.tempKnown) return { watch: prev, stalledMs: 0 };

  if (prev == null || input.needDelta <= prev.need - SUBFLOOR_PROGRESS_C) {
    return { watch: { at: input.now, need: input.needDelta }, stalledMs: 0 };
  }
  return { watch: prev, stalledMs: input.now - prev.at };
}

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

/**
 * Hard floor (≥1). Manual/slot/reachable clamps win over the boost minimum.
 *
 * `manualTarget` clamps it too (user, 2026-08-03 evening: "manual wins"). It
 * did not until then, and the asymmetry was invisible until someone used it:
 * `ceilOf` returns `max(floorOf, manualTarget)`, so a user pinning L1 under an
 * active L2 boost floor got `max(2, 1) = 2` and the leveler raised the room
 * straight back — live at 19:32:13 and again at 19:38:33, twenty seconds after
 * the pin each time. The dashboard reported the pin, the room ignored it. That
 * contradicts the project's own rule that a manual change beats automation.
 *
 * Consequence, deliberate: a pin below the boost floor also stops the room
 * being classified non-cooling (`isNonCooling` reads THIS floor), so no peer is
 * ever shed to recover a level the user chose to leave. The watch keeps
 * observing regardless — it keys off the boost minimum (`minLevel`), not this
 * — so `subFloorStalledMs` still accrues and can still say "you pinned this
 * room below its comfort floor and it has not cooled in ten minutes". Reported,
 * never enforced: that is what "manual wins" has to mean to be worth anything.
 */
export function floorOf(ac: AcView): number {
  let floor = Math.max(1, Math.min(ac.minLevel, ac.maxLevel));
  if (ac.manualTarget != null) floor = Math.min(floor, Math.max(1, ac.manualTarget));
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
 * How far above its configured threshold the outdoor temperature must be before
 * a room's boost floor stops being a preference and becomes a HARD bound on
 * every automatic path (user, 2026-08-04: "it is already 47 outside (8 c above
 * what specifyed for abdullah lowest level temp) that should never put it at
 * l1", then ~17:45 asking for the band).
 *
 * Largest single increment that can consume it (hard rule 5c): the gap between
 * "the temperature at which L1 STARTS to fail" and "the temperature at which it
 * certainly fails". The threshold is the user's estimate of the first; two
 * degrees is his allowance for being early. Compared against: the same
 * ≤10-min-fresh outdoor value `levelBoosts` already uses, and nothing else —
 * this is a temperature band, not an amps budget, so no load can eat it.
 *
 * Inside [threshold, threshold+2) the sub-floor rung keeps working: L1 might
 * genuinely cool there (live 2026-08-03 at ~39°C Abdullah was still running at
 * L1), and the R14 learned hold is what revokes it on evidence. Above the band
 * no evidence is needed — live 2026-08-04 17:27:18 at 47°C the reducer cut the
 * hottest room to L1 because it was the only level rung left, which is exactly
 * the move that produces a room that draws its fan and cools nothing.
 */
export const BOOST_FLOOR_FLEX_C = 2;

/**
 * How far BELOW its configured threshold a boosted room starts being watched at
 * L1 (user, 2026-08-04 ~17:50: "starting from 3 degrees below that temp and
 * above, the system should keep watching abdullah ac if the compressor could
 * not work, so it raise").
 *
 * Largest single increment that can consume it (hard rule 5c): the error in the
 * threshold itself. The user picked 39°C for a compressor whose real failure
 * point moves with humidity, condenser fouling and the generator's voltage —
 * three degrees is his allowance for the estimate being late, and inside it the
 * watch costs nothing, because a room that IS cooling shows 0.2°C of progress
 * and never trips it. Compared against: the same ≤10-min-fresh outdoor value
 * `levelBoosts` uses.
 */
export const BOOST_WATCH_BELOW_C = 3;

/**
 * Where a boosted room's outdoor temperature sits on its own gradient. One
 * function, four zones, because the alternative is four conditionals in four
 * files that drift apart (the mirror-drift trap, in its per-room form).
 *
 * Abdullah's configured 39°C, as the user described the whole ladder:
 *
 *   < 36    `none`   nothing special; L1 is an ordinary level.
 *   36–39   `watch`  L1 is still his legitimate floor, but he is WATCHED there
 *                    — the 3-min no-progress watch runs against the boost
 *                    minimum even though the floor has not armed. Evidence that
 *                    the compressor is not running makes the RAISE path lift
 *                    him, need-based and envelope-gated like any raise. Never a
 *                    floor assertion: re-asserting a comfort floor outside the
 *                    raise path is the 2026-08-02 limit cycle (invariant 25).
 *   39–41   `flex`   the floor binds raises and entry clamps as it always has,
 *                    and the sub-floor rung may STILL use L1 — at ~39°C on
 *                    2026-08-03 he was genuinely cooling there. Evidence can
 *                    revoke it (the R14 learned hold).
 *   > 41    `hard`   L1 is not a legal automatic target at all. No evidence
 *                    needed: live 2026-08-04 17:27:18 at 47°C the reducer cut
 *                    the hottest room to L1 because it was the only level rung
 *                    left, which is how a room ends up drawing its fan and
 *                    cooling nothing while the dashboard calls it healthy.
 *
 * Every boundary carries the same 1°C release hysteresis the boost floor has
 * always had — a reading wobbling across a line would otherwise flap a room's
 * whole reduction ladder. A stale/unknown reading holds the LAST zone rather
 * than falling back to permissive: the weather does not become mild because the
 * station went quiet, and the failure direction of holding is a room that keeps
 * cooling.
 */
export type BoostZone = "none" | "watch" | "flex" | "hard";

const ZONE_ORDER: readonly BoostZone[] = ["none", "watch", "flex", "hard"];

export function boostZoneOf(
  boost: { minLevel: number; outdoorAtLeastC: number } | undefined,
  outdoorC: number | null,
  wasZone: BoostZone,
): BoostZone {
  if (boost == null) return "none";
  if (outdoorC == null) return wasZone;
  const bars = [
    boost.outdoorAtLeastC - BOOST_WATCH_BELOW_C,
    boost.outdoorAtLeastC,
    boost.outdoorAtLeastC + BOOST_FLOOR_FLEX_C,
  ];
  const wasRank = ZONE_ORDER.indexOf(wasZone);
  let rank = 0;
  bars.forEach((bar, i) => {
    // Already at or past this zone → it takes a full degree BELOW the bar to
    // fall out of it; not yet in it → the bar itself is the entry.
    const held = wasRank >= i + 1 ? outdoorC > bar - 1 : outdoorC >= bar;
    if (held) rank = i + 1;
  });
  return ZONE_ORDER[rank];
}

/**
 * Outdoor-heat boost floor, ported from v1 minLevelFor and now expressed on top
 * of `boostZoneOf`: the floor arms in the `flex` zone and stays armed through
 * `hard`, which is exactly the old "activates at ≥ threshold, releases at
 * ≤ threshold − 1" behaviour.
 *
 * `watchMinLevel` is the level the sub-floor WATCH measures against, and it
 * arms three degrees earlier than the floor does — a room can be failing to
 * cool at L1 before L1 stops being its legitimate floor, and that is precisely
 * the evidence the learned hold is built from.
 */
export function boostFloor(
  boost: { minLevel: number; outdoorAtLeastC: number } | undefined,
  outdoorC: number | null,
  wasZone: BoostZone,
): { minLevel: number; active: boolean; hard: boolean; watchMinLevel: number; zone: BoostZone } {
  const zone = boostZoneOf(boost, outdoorC, wasZone);
  const active = zone === "flex" || zone === "hard";
  return {
    minLevel: active && boost != null ? boost.minLevel : 1,
    active,
    hard: zone === "hard",
    watchMinLevel: zone !== "none" && boost != null ? boost.minLevel : 1,
    zone,
  };
}

/**
 * The lowest level any AUTOMATIC path may target for this room right now.
 *
 * Normally 1 — the sub-floor rung (invariant 25) exists because being switched
 * off is worse for the occupant than any level, and that is still true for
 * every room whose low levels actually cool.
 *
 * But a comfort floor whose outdoor condition holds by more than
 * `BOOST_FLOOR_FLEX_C` is no longer a preference: below it the compressor does
 * not engage, so "cut a level" and "switch the room off" are the same physical
 * act with only one of them visible. Above the band the room's automatic ladder
 * is therefore L3 → L2 → off, and the off is priced as an off (invariants
 * 36/39), which is what sends it to the coolest room instead.
 *
 * ⚠ Manual wins in both directions (invariant 42): `floorOf` already clamps to
 * `manualTarget`/`manualCap`, so a user who pins L1 under an active boost gets
 * a hard floor of 1 and the rung back. Declining the floor is the user's to do.
 */
export function hardFloorOf(ac: AcView): number {
  return ac.boostFloorHard ? floorOf(ac) : 1;
}
