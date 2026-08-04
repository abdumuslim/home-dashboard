// The changeover dead window: the minutes after a power event when our ACs are
// ON, modeled at their full steady draw, and physically drawing nothing.
//
// 2026-08-04, 11:16:10 Baghdad. A grid→gen changeover power-cycled all three
// ACs, and TCL compressor restart protection then held every compressor off for
// roughly six minutes while the rooms drew about their fans. Two mechanisms
// failed inside those six minutes, and both are the same mistake — a TIMER
// standing in for physics:
//
//   * `rearmRamp` armed a 240 s window per AC and the windows EXPIRED ON THE
//     CLOCK at ~11:20:10 with no compressor yet running. FLOORS cleared four
//     seconds later (`clearFloorsIfDone` needs "nothing ramping"), and the raise
//     path opened onto a 6.1 A meter that was pure house load: Abdullah L2→L3
//     admitted at 11:20:14, Abdu L1→L2 at 11:20:49.
//   * the house sampler, freed by the same expiry, recorded
//     `max(0, 6.1 − 10.4) = 0` — fictitious ZERO-amp house samples tagged with
//     the current running set, which is what let the envelope admit those raises
//     "incl. 0.0A house" against a house that was really ~6 A.
//
// At 11:22:10–49 all three compressors engaged together: 6.4 → 15.7 → 16.6 A
// smoothed on a 15 A generator, two severe cuts, and the user switching a room
// off by hand to rescue the line. Generator brownouts followed for fifteen
// minutes while the controller rode 14.3–14.8 A calling itself healthy.
//
// Class: invariants 5b and 5c again — a guard sized against only half of what it
// guards. `max(0, …)` assumed the residual could only be wrong-HIGH (a dying
// compressor booked as house, invariant 20). With the compressors dead it is
// wrong-LOW, and wrong-low is the permissive direction.
//
// So the dead window is now DETECTED, from two independent pieces of evidence
// that must both agree:
//
//   (a) per AC — its ramp has absorbed almost nothing (`rampAbsorbedAmps`
//       against the bar below), and
//   (b) whole-house — the modeled running total sits well ABOVE the smoothed
//       meter, with no reducing cut of ours in flight to explain the gap.
//
// (a) alone is not enough: a room whose compressor is genuinely off at the wall
// looks identical. (b) alone is not enough either: it is a statement about the
// house, and one dead room among two running ones can produce it. Only the pair
// says "this specific compressor has not started, and the meter agrees".

import type { AcView, PowerSource } from "./types.js";
import type { LevelingConfigV2 } from "./config.js";
import { modelFor, steadyDraw } from "./costs.js";

/**
 * The AC fields the modeled-draw sum needs. `AcView` satisfies it structurally,
 * and so does the thin projection the controller shell builds straight off its
 * device context before views exist (the hold has to be decided BEFORE
 * `buildViews`, because `buildViews` is what turns `rampUntil` into `ramping`).
 */
export type ModeledAc = Pick<
  AcView,
  "deviceId" | "on" | "managed" | "shed" | "currentLevel" | "maxLevel"
>;

/** Σ modeled steady draw of the ACs we believe are running on `source`. */
export function modeledRunningAmps(
  acs: readonly ModeledAc[],
  config: LevelingConfigV2,
  source: Exclude<PowerSource, "none">,
): number {
  return acs
    .filter((a) => a.on && a.managed && !a.shed)
    .reduce(
      (sum, a) =>
        sum + steadyDraw(a.currentLevel, a.maxLevel, modelFor(config, a.deviceId, source)),
      0,
    );
}

/**
 * How far the MODEL may sit above the meter before the residual is fiction
 * rather than measurement.
 *
 * Compared against `Σ modeled steady draw of the running managed ACs − smoothed
 * meter`; on this house that sum runs from 2.2 A (one 1-ton at L1) to ~19 A
 * (three rooms at L3). The largest single increment that can consume this
 * threshold is one modeled-ON compressor not running, and the SMALLEST of those
 * here is a 1-ton at L1 (~2.2–2.3 A) — more than twice the bar, so no single
 * dead compressor can hide beneath it. What is left below 1.0 A is ordinary
 * under-draw (a satisfied compressor cycling below its cap) and the smoothing
 * window's own lag: readings whose residual is still honest.
 */
export const RESIDUAL_TRUST_GAP_AMPS = 1.0;

/**
 * The gap that says our compressors are not drawing AT ALL.
 *
 * Same quantity as `RESIDUAL_TRUST_GAP_AMPS`, less any commanded cut still in
 * flight — a cut we sent drops the model instantly and reaches the meter over
 * minutes, so that gap is explained, not evidence (invariant 5).
 *
 * Sized above `FLICKER_MAX_AMPS` (1.5 A, sensing.ts) so generator supply wobble
 * alone can never arm it, and at or below the smallest whole compressor on this
 * house (~2.2 A) so ONE dead room still registers. The full set it is compared
 * against: the modeled running total (2.2–19 A), the smoothed meter, and
 * `MeterView.commandedCutCreditAmps` (0–13 A during a reduction train).
 */
export const DEAD_WINDOW_GAP_AMPS = 2.0;

/**
 * Fraction of an AC's modeled steady draw the meter must have absorbed before
 * its power-event ramp is allowed to expire on the clock.
 *
 * Deliberately NOT 100%: a compressor legitimately running under its model must
 * release normally, or every healthy house freezes its own raise path. Abdullah
 * measured 1.8 A at an L1 modeled 2.3 A on 2026-08-03 (78%) and must not extend.
 */
export const RAMP_RELEASE_FRACTION = 0.4;

/**
 * …capped in absolute amps, so the bar stays reachable for a big compressor:
 * 40% of Abdu's 9.0 A L3 model is 3.6 A, more than the entire draw of either
 * 1-ton room. The question this bar answers is "did a compressor START", not
 * "did it finish".
 *
 * What it is compared against: `AcView.rampAbsorbedAmps`, the ratcheted peak
 * rise of the SMOOTHED meter since the ramp armed. Largest single increment
 * that can consume 1.0 A of it without a compressor starting: supply flicker,
 * which `flickerAmps()` caps at 1.5 A on RAW readings — but the 4-wide median
 * this is measured on removes single-reading spikes, so the smoothed excursion
 * is a fraction of that. And the failure direction is benign either way: a
 * premature release restores exactly the pre-2026-08-04 behaviour (expire on
 * the timer), it cannot make anything more permissive than that.
 */
export const RAMP_RELEASE_MAX_AMPS = 1.0;

/** Absorption an AC must show before its power-event ramp may close. */
export function rampReleaseBarAmps(modeledSteadyAmps: number): number {
  return Math.min(RAMP_RELEASE_MAX_AMPS, RAMP_RELEASE_FRACTION * modeledSteadyAmps);
}

/** Has this AC's compressor demonstrably started? (evidence (a)) */
export function rampAbsorptionLanded(
  absorbedAmps: number,
  ac: ModeledAc,
  config: LevelingConfigV2,
  source: Exclude<PowerSource, "none">,
): boolean {
  const modeled = steadyDraw(ac.currentLevel, ac.maxLevel, modelFor(config, ac.deviceId, source));
  return absorbedAmps >= rampReleaseBarAmps(modeled);
}

/**
 * How far the model sits ABOVE the meter, net of a reducing cut we commanded
 * and the meter has not shown yet. Positive means "we believe we are drawing
 * more than the line is carrying"; negative is the ordinary case (the meter
 * carries the house on top of the ACs).
 */
export function modeledGapAmps(opts: {
  smoothedAmps: number;
  acs: readonly ModeledAc[];
  config: LevelingConfigV2;
  source: Exclude<PowerSource, "none">;
  /** `MeterView.commandedCutCreditAmps` — amps already commanded off, still landing. */
  commandedCutCreditAmps?: number;
}): number {
  return (
    modeledRunningAmps(opts.acs, opts.config, opts.source) -
    opts.smoothedAmps -
    (opts.commandedCutCreditAmps ?? 0)
  );
}

/** Whole-house evidence that nothing of ours is drawing (evidence (b)). */
export function houseIsDead(gapAmps: number): boolean {
  return gapAmps >= DEAD_WINDOW_GAP_AMPS;
}

/**
 * How far the newest RAW reading may sit above the smoothed mean while a DIRECT
 * house sample is taken.
 *
 * "The meter is the house" is only true while the meter is not moving. When a
 * compressor finally engages, the raw reading jumps at once and the 4-wide
 * median follows over the next readings — so for two or three ticks the
 * smoothed value is a BLEND of house and compressor while the whole-house gap
 * has not yet fallen under `DEAD_WINDOW_GAP_AMPS`. The acceptance run booked a
 * 6.5A "house" on the tick the median was halfway up from a real 2.0A, and that
 * peak then refused every raise for the next fifteen minutes.
 *
 * Compared against `latestAmps − smoothedAmps`. The largest single increment
 * that can consume it while the house really is alone on the line is supply
 * flicker, which `flickerAmps()` caps at 1.5A on raw readings — so it sits
 * above that, and below the smallest compressor that can start (a 1-ton at L1,
 * ~2.2A modeled, and its inrush is larger still). Only the rising direction is
 * checked: a raw reading BELOW the mean means the house shrank, and recording
 * the higher smoothed value merely over-states it, which over-blocks.
 */
export const DIRECT_SAMPLE_DRIFT_AMPS = 1.6;

/** Is the meter still enough for its reading to BE the house? */
export function meterIsSteady(view: { latestAmps: number; smoothedAmps: number }): boolean {
  return view.latestAmps - view.smoothedAmps <= DIRECT_SAMPLE_DRIFT_AMPS;
}
