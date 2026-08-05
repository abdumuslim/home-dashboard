// Last-resort fan trim — the ONLY fan involvement leveling v2 has. The cut
// side lives inside the reducer (fan moves attach only at floor level); this
// module owns the hold records and the restore side.
//
// Restore philosophy (evidence: v1's 61s cut→restore median fed two trips):
// generous hysteresis. A held fan climbs back only after a LONG sustained calm,
// to the highest target whose learned cost fits under the resting ceiling
// (sweet spot, no 1↔full bounce), one AC per evaluation.

import type { AcView, Command, PowerSource } from "./types.js";
import type { CostBook } from "./costs.js";
import { fanTrimSavings } from "./costs.js";

/**
 * Sustained calm required before a held fan starts climbing back. Kept short
 * (2026-07-24, user "make the fan restoration faster") — the bounded climb
 * below is what stops a 1↔full swing, so a fast gate just returns comfort
 * sooner once the meter is calm.
 */
export const FAN_RESTORE_CALM_MS = 60_000;

/**
 * Calm required for the SECOND and later gears of a climb that is already
 * under way.
 *
 * The 60 s gate above is the anti-bounce guard: it decides whether a fan that
 * was cut may start coming back at all. Charging it again for every gear made a
 * six-gear recovery cost three separate batches a minute apart, and because a
 * fan restore SPENDS (invariant 18) each one rewinds the shared calm clock —
 * so the raise path, which needs `raiseCalmSeconds`, never got a window for the
 * whole climb. Live 2026-08-03 05:16:29 and 05:17:33 are two steps of exactly
 * that. Once the first gear has proved itself the question is no longer "should
 * this fan come back" but "has the last gear landed", which is a much shorter
 * clock. Each gear is still individually gated on headroom and still arms its
 * own fan debit, and a fresh CUT clears the climb so the full 60 s applies again.
 */
export const FAN_RESTORE_CONTINUE_CALM_MS = 20_000;

/**
 * Gears a single restore step may climb. The old "sweet spot" search took the
 * HIGHEST target whose learned cost fit — and a 6-gear swing is priced at only
 * ~0.15A×6 = 0.9A, which fits almost always. So the anti-bounce design did a
 * full 1→7 jump every time. Live 2026-07-31 Abdu ran 7→5→3→1→7→1→7→4 in nine
 * minutes, and the two amps-hungriest of those restores were immediately
 * followed by the level raises that tripped the gen. Climb in small steps and
 * let the meter agree between them.
 */
export const FAN_RESTORE_MAX_STEP = 2;

/**
 * Quiet time required after the LAST cut of an episode before that fan may
 * climb at all. `FAN_RESTORE_CALM_MS` alone never covered this: a fan-only
 * batch does not rewind the shared calm clock, so a fan cut at 17:30:24 was
 * fully restored 80s later — v1's 61s bounce median, reproduced in v2.
 *
 * 180s → 120s on 2026-08-05 (user request, watching his fans sit at 1 after an
 * episode ended). Still comfortably past the 60s first-gear calm gate plus the
 * meter's smoothing window, and a fresh cut restarts it — the anti-bounce
 * argument is unchanged, the episode tail is a minute shorter.
 */
export const FAN_RESTORE_AFTER_CUT_MS = 120_000;

export interface FanHold {
  deviceId: string;
  /** Fan to eventually restore (0 = built-in auto). */
  originalFan: number;
  /** What the trim last commanded. */
  lastSetFan: number;
  heldAt: number;
  /**
   * This hold came from an over-limit CUT, so its restore owes the cut
   * cooldown. A gentle-restore hold does not: nothing was taken away, the fan
   * was merely pinned while the room came back, and the calm + ramp gates
   * already decide when it may be handed to the automation. Loaded holds
   * default to true — the persisted row is always a cut.
   */
  fromCut?: boolean;
  /**
   * When the last CUT landed — the anchor for `FAN_RESTORE_AFTER_CUT_MS`.
   * Distinct from `heldAt`, which is pinned to the FIRST cut of the episode and
   * must not move (it is the hold's identity). In-memory only, like `gentle`:
   * the persisted row has no column for it, and after a restart it falls back
   * to `heldAt` — which is always ≤ the real last cut, so a restored hold may
   * climb sooner than it would have, never later.
   */
  lastCutAt?: number;
  /**
   * When this hold's climb back began, or absent while it has not started. The
   * first gear pays the full `FAN_RESTORE_CALM_MS`; the rest of the same climb
   * pay `FAN_RESTORE_CONTINUE_CALM_MS`. Cleared by a fresh cut, so a new
   * episode always re-earns the long gate. In-memory only, like `lastCutAt` —
   * after a restart the climb simply starts over, which is the safe direction.
   */
  climbStartedAt?: number;
  /**
   * This restore was ADMITTED at the gentle PROBE price (steady floor draw),
   * not the learned plain cost — the controller's freshly-on projection must
   * re-price it at the same price admission charged (see restoreCostAmps;
   * disagreeing was the 2026-07-25 storm). Every gen restore pins the fan,
   * but only probe-priced ones set this. In-memory only: after a restart the
   * flag is lost and the projection falls back to the full learned cost,
   * which errs trip-safe.
   */
  gentle?: boolean;
}

export type FanHolds = Readonly<Record<string, FanHold>>;

export function recordFanCut(holds: FanHolds, ac: AcView, target: number, now: number): FanHolds {
  const existing = holds[ac.deviceId];
  return {
    ...holds,
    [ac.deviceId]: {
      deviceId: ac.deviceId,
      // The FIRST cut of an episode snapshots the fan to restore; later cuts keep it.
      originalFan: existing?.originalFan ?? ac.fanSpeed ?? 0,
      lastSetFan: target,
      heldAt: existing?.heldAt ?? now,
      fromCut: true,
      lastCutAt: now,
      // A new cut ends any climb in progress: the next one re-earns the full
      // anti-bounce window rather than inheriting a half-finished one.
      climbStartedAt: undefined,
    },
  };
}

/**
 * Record a fan hold for a gen restore (fan pinned to 1 on the power_on so the
 * range automation can't slam it to a hot-room smart-auto 3–7 while the
 * compressor is still ramping). The original is 0 (auto): hand the fan back
 * to the automation once a long sustained calm lets `planFanRestore` climb it
 * back in one jump. `probePriced` marks a restore admitted at the gentle
 * steady price instead of the learned cost — the freshly-on projection reads
 * it back as `hold.gentle` so re-pricing matches admission exactly.
 */
export function recordGentleRestoreHold(
  holds: FanHolds,
  deviceId: string,
  now: number,
  probePriced: boolean,
): FanHolds {
  return {
    ...holds,
    [deviceId]: {
      deviceId,
      originalFan: 0,
      lastSetFan: 1,
      heldAt: now,
      // Not a cut — no cooldown owed (see FanHold.fromCut).
      fromCut: false,
      gentle: probePriced,
    },
  };
}

export function releaseFanHold(holds: FanHolds, deviceId: string): FanHolds {
  if (holds[deviceId] == null) return holds;
  const next = { ...holds } as Record<string, FanHold>;
  delete next[deviceId];
  return next;
}

export interface FanRestoreStep {
  command: Command;
  /** True when this step reaches the original fan — the hold releases on confirm. */
  final: boolean;
  holds: FanHolds;
}

/**
 * Propose at most ONE fan-restore step. `headroomAmps` is the room under the
 * resting ceiling. Auto (0) originals restore in one jump (the gear is
 * indivisible — there is no "half of auto"); numeric originals climb at most
 * `FAN_RESTORE_MAX_STEP` gears, to the highest such target whose learned cost
 * fits, and nothing climbs until the last cut is `FAN_RESTORE_AFTER_CUT_MS`
 * behind us.
 */
export function planFanRestore(
  holds: FanHolds,
  acs: AcView[],
  opts: {
    calmMs: number;
    headroomAmps: number;
    book: CostBook;
    source: Exclude<PowerSource, "none">;
    now: number;
  },
): FanRestoreStep | null {
  // The calm gate is judged PER HOLD, not once for the batch: a climb already
  // under way asks a shorter question than one deciding whether to start.
  for (const ac of acs) {
    const hold = holds[ac.deviceId];
    if (hold == null || !ac.on) continue;
    const gate = hold.climbStartedAt == null ? FAN_RESTORE_CALM_MS : FAN_RESTORE_CONTINUE_CALM_MS;
    if (opts.calmMs < gate) continue;
    // Cut→restore hysteresis. A fan-only batch does not rewind the shared calm
    // clock, so without this the 60s calm gate let a fan cut come all the way
    // back 80s later and the over-limit episode simply repeated. Gentle-restore
    // holds are exempt: nothing was cut (see FanHold.fromCut).
    if (
      (hold.fromCut ?? true) &&
      opts.now - (hold.lastCutAt ?? hold.heldAt) < FAN_RESTORE_AFTER_CUT_MS
    ) {
      continue;
    }
    const current = ac.fanSpeed ?? hold.lastSetFan;
    if (hold.originalFan === 0) {
      // Built-in auto: single indivisible jump, costed as a full swing.
      const cost = fanTrimSavings(opts.book, ac.deviceId, opts.source, 6, opts.now);
      if (cost <= opts.headroomAmps) {
        const holds2 = { ...holds, [ac.deviceId]: { ...hold, lastSetFan: 0, climbStartedAt: hold.climbStartedAt ?? opts.now } };
        return {
          command: { deviceId: ac.deviceId, kind: "set_fan", fan: 0, reason: "trim_restore" },
          final: true,
          holds: holds2,
        };
      }
      continue;
    }
    if (current >= hold.originalFan) continue; // already there; reconciler confirms & releases
    // Highest target whose cumulative step cost fits, BOUNDED to a few gears —
    // the bound is what makes this a climb rather than a swing (the unbounded
    // search always reached originalFan, because a 6-gear swing prices at ~0.9A).
    const reach = Math.min(hold.originalFan, current + FAN_RESTORE_MAX_STEP);
    let target = current;
    for (let candidate = reach; candidate > current; candidate--) {
      const cost = fanTrimSavings(opts.book, ac.deviceId, opts.source, candidate - current, opts.now);
      if (cost <= opts.headroomAmps) {
        target = candidate;
        break;
      }
    }
    if (target === current) continue; // not even one step fits
    const final = target === hold.originalFan;
    const holds2 = {
      ...holds,
      [ac.deviceId]: { ...hold, lastSetFan: target, climbStartedAt: hold.climbStartedAt ?? opts.now },
    };
    return {
      command: { deviceId: ac.deviceId, kind: "set_fan", fan: target, reason: "trim_restore" },
      final,
      holds: holds2,
    };
  }
  return null;
}
