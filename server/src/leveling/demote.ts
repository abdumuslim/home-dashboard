// Loaded-spring demote: walk a SATISFIED room's standing gen level down to the
// level its need actually justifies (`ceilOf`), freeing budget for a room that
// is still hot.
//
// v1 named this the "dormant-cap step-down" and deferred it ("Not built —
// ship the rest first; revisit after observing live"). 2026-07-28 is that
// observation: Najat sat at L3 with her room 0.5°C from target, holding 6.3A of
// a 15A generator, while Abdu's room ran 1.9°C hot and was pinned at L1 —
// the meter-anchored fill makes "stay where you are" free, so nothing ever
// reclaimed the amps her comfort no longer needed.
//
// The near-target cap (needs.ts `nearTargetNeedCap`) has always said a room
// inside the band buys nothing above L1; until now that cap only gated RAISES.

import { ceilOf } from "./needs.js";
import { commandedCutAmpsOf } from "./costs.js";
import type { LevelingConfigV2 } from "./config.js";
import type { AcView, Command, Decision, PowerSource } from "./types.js";

/**
 * How far INSIDE the near-target band a room must be before its level is walked
 * down. The gap between this and the band itself (which is what re-opens a
 * raise) is the anti-bounce dead zone: demote at ≤ band − 0.2, re-raise at
 * > band. At the 0.1°C sensor granularity that is two whole LSBs, so ordinary
 * reading noise cannot cross both edges.
 */
export const DEMOTE_HYSTERESIS_C = 0.2;

/**
 * How long the room must hold that satisfaction CONTINUOUSLY before we act. A
 * single reading dipping into the band proves nothing; a compressor that just
 * cooled the sensor's immediate air is the common false positive.
 */
export const DEMOTE_DWELL_MS = 120_000;

/**
 * Confirm-or-resend spacing for a demote command, deliberately slower than the
 * generic `LEVEL_RESEND_SPACING_MS` (30s). Every non-fan batch rewinds the
 * SHARED calm clock, and these rooms are exactly the ones whose shadow lags for
 * minutes — a 30s resend loop on a lagging device would starve the peer raise
 * this demote exists to fund, turning the feature into an anti-funding
 * mechanism.
 */
export const DEMOTE_RESEND_MS = 60_000;

export interface DemoteInput {
  /** ALL managed AC views (the caller filters nothing). */
  acs: readonly AcView[];
  config: LevelingConfigV2;
  source: Exclude<PowerSource, "none">;
  now: number;
  /**
   * Levels commanded to this device whose confirm we have not seen yet, and
   * when each was last sent. A demote is not re-sent while its own target is
   * still in flight (see DEMOTE_RESEND_MS).
   */
  inFlight: (deviceId: string) => ReadonlyArray<{ level: number; sentAt: number }>;
}

export interface DemotePlan {
  commands: Command[];
  decisions: Decision[];
  /** Model-priced total of the cuts, for the collapse detector's credit. */
  cutAmps: number;
}

/**
 * Walk every SATISFIED room that is parked above its need ceiling down to that
 * ceiling. One command per room, straight to the target: one command is one
 * settle window and one calm reset, the firmware applies the final cap either
 * way, and the collapse detector judges a fall from its anchor — so splitting
 * the drop into steps buys nothing and doubles the re-send surface.
 *
 * Deliberately NOT gated on the meter: this is a NEED-triggered mechanism. It
 * runs on both sources (user, 2026-07-28) — on gen it frees budget for a hot
 * room, on grid it stops paying for cooling nobody asked for. It never touches
 * the reduce-side trigger math, which by user decision fires only at or over
 * the raw limit.
 */
export function planIdleDemotes(input: DemoteInput): DemotePlan {
  const { acs, config, source, now } = input;
  const commands: Command[] = [];
  const decisions: Decision[] = [];

  for (const ac of acs) {
    if (!ac.on || !ac.managed || ac.shed) continue;
    // A ramping compressor has not reached the level it is heading for; judging
    // it satisfied would demote a room mid-pulldown.
    if (ac.ramping) continue;
    // An unrestricted (0) AC is handled by the never-level-0 correction, which
    // re-caps it; demoting from an unknown state would race that.
    if (ac.currentLevel <= 0) continue;

    const ceil = ceilOf(ac, config.nearTargetBandC);
    if (ac.currentLevel <= ceil) continue;
    if (ac.satisfiedForMs < DEMOTE_DWELL_MS) continue;

    // Confirm-or-resend: never stack a second demote on an unconfirmed one, and
    // space re-sends well beyond the generic level spacing — every non-fan
    // batch rewinds the SHARED calm clock, and these are exactly the rooms
    // whose shadow lags for minutes, so a tight resend loop here would starve
    // the peer raise this demote exists to fund.
    const pending = input.inFlight(ac.deviceId).filter((s) => s.level <= ceil);
    const lastSentAt = pending.reduce((max, s) => Math.max(max, s.sentAt), 0);
    if (pending.length > 0 && now - lastSentAt < DEMOTE_RESEND_MS) {
      decisions.push({
        at: now,
        deviceId: ac.deviceId,
        action: `demote L${ac.currentLevel}→L${ceil}`,
        blockedBy: "awaiting confirm",
      });
      continue;
    }

    commands.push({ deviceId: ac.deviceId, kind: "set_level", level: ceil });
    decisions.push({
      at: now,
      deviceId: ac.deviceId,
      action: `demote L${ac.currentLevel}→L${ceil}`,
      detail: `loaded spring: satisfied ${ac.needDelta.toFixed(1)}°C for ${Math.round(ac.satisfiedForMs / 1000)}s`,
    });
  }

  return { commands, decisions, cutAmps: commandedCutAmpsOf(commands, acs, config, source) };
}
