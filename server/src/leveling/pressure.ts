// Pressure assessment — one place that decides whether this evaluation must
// RECOVER amps (over), may SPEND headroom (calm), or should do NOTHING (hold —
// the deliberate near-limit ride). Severity only scales the deficit and the
// escalation tier; the reducer is the same at every severity.

import type { MeterView, Pressure } from "./types.js";
import type { LevelingConfigV2 } from "./config.js";
import { effectiveLimit } from "./config.js";
import { OVER_LIMIT_SEVERE_AMPS, median } from "./sensing.js";

/** Extreme-overshoot shed escalation (ported 2026-07-10 values). */
export const EMERGENCY_SHED_OVERSHOOT_AMPS = 3;
export const EMERGENCY_SHED_OVERSHOOT_FRACTION = 0.2;

/**
 * Meter-sized savings target for an over-limit episode: the overshoot the
 * readings actually support, plus the margin so the landing point is just
 * under the limit (never deep below — the anti-over-reduction rule).
 * Severe streaks size from min(severe readings) — every reading supports it,
 * one spike can't inflate it; an all-mild/oscillating episode sizes from the
 * median of the over-limit readings.
 */
export function requiredSavingsAmps(view: MeterView, limit: number, marginAmps: number): number {
  const over = view.overLimitReadings;
  const severe = over.filter((r) => r - limit > OVER_LIMIT_SEVERE_AMPS);
  const overshoot = severe.length > 0 ? Math.min(...severe) - limit : median([...over]) - limit;
  return Math.max(0.1, overshoot) + marginAmps;
}

export function assessPressure(
  view: MeterView,
  config: LevelingConfigV2,
  opts: { projectedExtraAmps?: number } = {},
): Pressure {
  if (view.source === "none") return { kind: "hold" };
  // Derated after a recent trip — the same number sensing classified its
  // readings against, so severity and the leaky bucket stay in agreement.
  const limit = effectiveLimit(config, view.source, view.derateAmps);

  if (view.overLimitBudget <= 0 && view.overLimitReadings.length > 0) {
    // Demand side of invariant 5: readings taken while a cut we already
    // commanded is still landing describe a house that no longer exists. Only
    // the part the in-flight cut does NOT already cover is still owed.
    //
    // Live 2026-07-28 16:38 and 16:40: the reducer cut a room, the bucket
    // refilled on the act and drained again ~30-60s later on readings the
    // stopped compressor had not yet left, and the second pass — finding that
    // room already commanded — took the amps out of the HOT room instead.
    //
    // The EXTREME tier (which forces a shed) keys off the credited figure for
    // the same reason — escalating to a shed for amps already on their way out
    // is the double-cut this fixes. The SEVERE tier still keys off the raw
    // readings, and the credit both expires (PENDING_CUT_MS) and is spent as
    // the meter absorbs it, so a cut that never lands stops excusing anything.
    const rawRequired = requiredSavingsAmps(view, limit, config.marginAmps);
    const required = Math.max(0, rawRequired - view.commandedCutCreditAmps);
    const extremeAt = Math.max(EMERGENCY_SHED_OVERSHOOT_AMPS, EMERGENCY_SHED_OVERSHOOT_FRACTION * limit);
    const severity = required >= extremeAt
      ? "extreme"
      : view.overLimitReadings.some((r) => r - limit > OVER_LIMIT_SEVERE_AMPS)
        ? "severe"
        : "mild";
    return { kind: "over", requiredAmps: required, severity };
  }

  // Proactive projection (an AC just turned ON near the limit): the compressor
  // will ramp toward its floor draw over minutes — act on the projection now
  // instead of letting the bucket drain reading-by-reading during the ramp.
  const projected = view.smoothedAmps + (opts.projectedExtraAmps ?? 0);
  if (opts.projectedExtraAmps != null && view.sampleCount >= 2 && projected > limit) {
    return {
      kind: "over",
      requiredAmps: Math.max(0.1, projected - limit) + config.marginAmps,
      severity: "mild",
    };
  }

  if (view.calmMs > 0 && !view.collapsed) {
    const restingCeiling = limit - config.marginAmps - config.restingBufferAmps;
    return { kind: "calm", headroomAmps: restingCeiling - view.smoothedAmps };
  }

  return { kind: "hold" };
}
