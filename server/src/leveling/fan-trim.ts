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
 * (2026-07-24, user "make the fan restoration faster") — the sweet-spot climb
 * only advances to a target whose learned cost fits the headroom, so a fast
 * gate can't 1↔full bounce; it just returns comfort sooner once the meter is calm.
 */
export const FAN_RESTORE_CALM_MS = 60_000;

export interface FanHold {
  deviceId: string;
  /** Fan to eventually restore (0 = built-in auto). */
  originalFan: number;
  /** What the trim last commanded. */
  lastSetFan: number;
  heldAt: number;
  /**
   * This hold came from a GENTLE restore (fan pinned on the power_on), not a
   * trim — so the controller's freshly-on projection must price that turn-on at
   * the same gentle cost the restore was admitted at (see restoreCostAmps).
   * In-memory only: after a restart the flag is lost and the projection falls
   * back to the full fan-slam cost, which errs trip-safe.
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
    },
  };
}

/**
 * Record a fan hold for a GENTLE restore. A shed room comes back with its fan
 * pinned to 1 (the `fan` field on the power_on command) instead of letting the
 * range automation slam it to a hot-room smart-auto 3–7. That fan-slam is the
 * bulk of a restore's un-modeled surge (fans aren't in the amp model), so
 * pinning it lets a shed room fit next to a running AC on the tight gen budget.
 * The original is 0 (auto): hand the fan back to the automation once a long
 * sustained calm lets `planFanRestore` climb it back in one jump.
 */
export function recordGentleRestoreHold(holds: FanHolds, deviceId: string, now: number): FanHolds {
  return {
    ...holds,
    [deviceId]: { deviceId, originalFan: 0, lastSetFan: 1, heldAt: now, gentle: true },
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
 * resting ceiling. Auto (0) originals restore in one jump (indivisible);
 * numeric originals climb to the highest target whose learned per-step cost
 * fits — and only move if at least one step fits.
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
  if (opts.calmMs < FAN_RESTORE_CALM_MS) return null;
  // Highest-priority AC with a live hold and a known current fan (acs are priority-sorted).
  for (const ac of acs) {
    const hold = holds[ac.deviceId];
    if (hold == null || !ac.on) continue;
    const current = ac.fanSpeed ?? hold.lastSetFan;
    if (hold.originalFan === 0) {
      // Built-in auto: single indivisible jump, costed as a full swing.
      const cost = fanTrimSavings(opts.book, ac.deviceId, opts.source, 6, opts.now);
      if (cost <= opts.headroomAmps) {
        const holds2 = { ...holds, [ac.deviceId]: { ...hold, lastSetFan: 0 } };
        return {
          command: { deviceId: ac.deviceId, kind: "set_fan", fan: 0, reason: "trim_restore" },
          final: true,
          holds: holds2,
        };
      }
      continue;
    }
    if (current >= hold.originalFan) continue; // already there; reconciler confirms & releases
    // Sweet spot: highest target whose cumulative step cost fits the headroom.
    let target = current;
    for (let candidate = hold.originalFan; candidate > current; candidate--) {
      const cost = fanTrimSavings(opts.book, ac.deviceId, opts.source, candidate - current, opts.now);
      if (cost <= opts.headroomAmps) {
        target = candidate;
        break;
      }
    }
    if (target === current) continue; // not even one step fits
    const final = target === hold.originalFan;
    const holds2 = { ...holds, [ac.deviceId]: { ...hold, lastSetFan: target } };
    return {
      command: { deviceId: ac.deviceId, kind: "set_fan", fan: target, reason: "trim_restore" },
      final,
      holds: holds2,
    };
  }
  return null;
}
