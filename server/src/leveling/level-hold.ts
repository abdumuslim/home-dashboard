// The LEARNED non-cooling hold: what this house has OBSERVED about a level,
// keyed on the outdoor temperature it observed it at.
//
// `boostZoneOf` (needs.ts) encodes what the user CONFIGURED — "above 39°C
// Abdullah does not cool at L1" — and the flex band above it deliberately keeps
// L1 legal for the reducer, because at ~39°C on 2026-08-03 he genuinely was
// cooling there. The configured number is an estimate, and estimates are wrong
// in both directions: the compressor's real failure point moves with humidity,
// condenser fouling and the generator's voltage.
//
// So the system is allowed to learn its own bar (user, 2026-08-04): "when the
// system observe that abdullah is not working on l1 (by own observation or
// manual raise), it should state the outside temp, so it will never reduce the
// level to l1 untill it drop below that temp or after [6] h".
//
// Two things make that a hold rather than a guess:
//
//   * it is keyed on the outdoor temperature of the observation, not on the
//     clock alone — L1 failing at 39° implies it fails at 41°, so the LOWER
//     observation always wins and the hold releases when the weather actually
//     goes back under it; and
//   * it is PERSISTED. A six-hour TTL that a deploy silently erases is not a
//     hold, it is a coin flip on how often we ship.
//
// Pure state + predicates only. The shell (controller.ts) owns the DB row, the
// evidence that arms it, and the composition into `AcView.minLevel` /
// `boostFloorHard`.

/** One room's learned "this level does not cool up here" record. */
export interface LevelHold {
  /**
   * The level observed NOT to cool. Always 1 today — both triggers the user
   * described are about L1 — but stored rather than assumed, because the floor
   * this produces is `level + 1` and a hard-coded 2 would be a second place
   * for the rule to drift.
   */
  level: number;
  /** Outdoor °C when the observation was made (`T_obs`). */
  outdoorC: number;
  /** When it was observed (epoch ms) — the TTL anchor. */
  observedAt: number;
}

/**
 * How long an observation stands without being renewed (user, 2026-08-04
 * afternoon; he revised his own first answer of 12 h down to 6).
 *
 * Largest single increment that can consume it (hard rule 5c): one Baghdad
 * afternoon. The observation is about a compressor at an outdoor temperature,
 * and the thing that invalidates it is the weather changing — which the
 * temperature bar below already catches directly. This is the backstop for the
 * case the bar cannot see: the hardware itself changing (a serviced condenser,
 * a different generator, a corrected amp model). Six hours is long enough to
 * cover the heat of one day, short enough that a morning observation is not
 * still governing the ladder at midnight. Compared against nothing else — it is
 * a clock, not a budget.
 */
export const LEVEL_HOLD_TTL_MS = 6 * 3_600_000;

/**
 * How far BELOW `T_obs` the outdoor reading must fall before the hold releases.
 *
 * Largest single increment that can consume it (hard rule 5c): the wobble of
 * the outdoor reading itself. The station reports in tenths and the ≤10-min
 * freshness window lets two consecutive ticks differ by a few of them; half a
 * degree is several times that, and it is the same *kind* of guard as the 1°C
 * release hysteresis every `boostZoneOf` boundary carries — deliberately
 * smaller, because this bar was measured rather than estimated. Compared
 * against: the outdoor °C feed, and nothing else.
 *
 * Without it a reading sitting exactly on `T_obs` flaps the room's whole
 * reduction ladder between "L1 is a rung" and "L1 is an off" on alternate
 * ticks.
 */
export const LEVEL_HOLD_RELEASE_C = 0.5;

/**
 * Fold a fresh observation into whatever we already hold for this room.
 *
 * The LOWER `T_obs` wins: a compressor that will not run at 39° will not run at
 * 44° either, so the colder observation is the more binding one and must not be
 * overwritten by a hotter afternoon. The observation TIME still advances —
 * evidence arriving now is evidence now, and letting a renewed observation
 * expire on the FIRST one's clock would retire a hold the room is still proving.
 */
export function recordLevelHold(prev: LevelHold | null, next: LevelHold): LevelHold {
  if (prev == null || next.level > prev.level) return next;
  if (next.level < prev.level) return { ...next, outdoorC: Math.min(prev.outdoorC, next.outdoorC) };
  return {
    level: prev.level,
    outdoorC: Math.min(prev.outdoorC, next.outdoorC),
    observedAt: Math.max(prev.observedAt, next.observedAt),
  };
}

/** When this hold lapses on the clock alone. */
export function levelHoldExpiresAt(hold: LevelHold): number {
  return hold.observedAt + LEVEL_HOLD_TTL_MS;
}

/**
 * Is this hold still binding?
 *
 * ⚠ A null/stale outdoor reading HOLDS, exactly as `boostZoneOf` holds its last
 * zone: the weather does not become mild because the station went quiet, and
 * the failure direction of holding is a room that keeps cooling one level
 * higher than it strictly needs. Falling back to permissive would let a dead
 * feed hand the reducer back the very rung the user banned.
 */
export function levelHoldLive(hold: LevelHold | null, outdoorC: number | null, now: number): boolean {
  if (hold == null) return false;
  if (now >= levelHoldExpiresAt(hold)) return false;
  if (outdoorC == null) return true;
  return outdoorC >= hold.outdoorC - LEVEL_HOLD_RELEASE_C;
}

/**
 * The floor this hold imposes: one level above the level it observed dead, or 1
 * (no opinion) when it is not live. Clamped to `maxLevel` so a hold can never
 * name a level the firmware does not have.
 *
 * Composed with the configured boost floor via `max` at the call site — the two
 * are independent statements about the same room and the stricter one governs.
 */
export function levelHoldFloor(
  hold: LevelHold | null,
  outdoorC: number | null,
  now: number,
  maxLevel: number,
): number {
  if (!levelHoldLive(hold, outdoorC, now)) return 1;
  return Math.max(1, Math.min(hold!.level + 1, Math.max(1, maxLevel)));
}

/** Human-readable "why is this room's floor above L1", for the status card. */
export function levelHoldDetail(hold: LevelHold): string {
  return (
    `L${hold.level} observed not cooling at ${hold.outdoorC.toFixed(1)}°C outdoor — ` +
    `holds until it drops below ${(hold.outdoorC - LEVEL_HOLD_RELEASE_C).toFixed(1)}°C ` +
    `or ${new Date(levelHoldExpiresAt(hold)).toISOString()}`
  );
}
