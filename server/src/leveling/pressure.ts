// Pressure assessment — one place that decides whether this evaluation must
// RECOVER amps (over), may SPEND headroom (calm), or should do NOTHING (hold —
// the deliberate near-limit ride). Severity only scales the deficit and the
// escalation tier; the reducer is the same at every severity.

import type { MeterView, Pressure } from "./types.js";
import type { LevelingConfigV2 } from "./config.js";
import { effectiveLimit } from "./config.js";
import {
  OVER_LIMIT_SEVERE_AMPS,
  SUSTAINED_OVER_EXTREME_MS,
  SUSTAINED_OVER_SEVERE_MS,
  cutTrendOf,
  isSevereOverReading,
  median,
} from "./sensing.js";

/** Extreme-overshoot shed escalation (ported 2026-07-10 values). */
export const EMERGENCY_SHED_OVERSHOOT_AMPS = 3;
export const EMERGENCY_SHED_OVERSHOOT_FRACTION = 0.2;

/**
 * How many of the NEWEST banked over-limit readings must be severe before the
 * severe-streak rule may size the deficit from them.
 *
 * Largest single increment that can consume this (hard rule 5c): ONE compressor
 * inrush reading. A TCL's locked-rotor draw is several times its running amps
 * and the ESP samples every ~2.7–5s, so exactly one sample can land on it —
 * live 2026-08-04 12:53:45Z, a reading of ~19.5A against a **15.025A smoothed
 * mean** on a 15A generator. Compared against: the whole banked ring
 * (`overLimitReadings`, up to 8 readings) as classified by `isSevereOverReading`
 * at the LIVE flicker, which on a generator is routinely pinned at its 1.5A cap
 * — and a high flicker raises the severe bar, so it is precisely the lone
 * inrush spike that survives the filter while the ordinary 15.5–16.5A readings
 * do not. `Math.min(...severe)` over a set of ONE is that spike, and it sized a
 * 4.57A deficit at 0.025A of real overshoot, which the reducer paid by shedding
 * TWO rooms.
 *
 * Two is the smallest number that can distinguish load from a spike, and it
 * costs no reaction time on a genuine step-up: the leaky bucket needs
 * OVER_LIMIT_DRAIN_SEVERE (3) per severe reading out of a 5-point budget, so a
 * real step has always banked its second severe reading by the time the bucket
 * empties and this function is consulted at all. What a lone spike falls back
 * to is not nothing — it is the median/smoothed sizing, whose floor IS the
 * smoothed overshoot: the honest figure for a house whose mean sits at the line.
 */
export const SEVERE_STREAK_READINGS = 2;

/**
 * Meter-sized savings target for an over-limit episode: the overshoot the
 * readings actually support, plus the margin so the landing point is just
 * under the limit (never deep below — the anti-over-reduction rule).
 * Severe STREAKS size from min(severe readings) — every reading in the streak
 * supports it, so one spike cannot inflate it; an all-mild/oscillating episode
 * sizes from the median of the over-limit readings, discounted by the live
 * flicker.
 *
 * ⚠ "Streak" is load-bearing and was not enforced until 2026-08-04. The rule
 * shipped as `severe.length > 0`, and the safety argument — a min over several
 * readings cannot be inflated by one of them — is only true when there ARE
 * several. Over a set of one, min IS the spike: live 12:53:45Z one ~19.5A
 * inrush sample sized a 4.57A deficit while the smoothed mean sat 0.025A over
 * a 15A generator, and the extreme rung paid it with two rooms. So the newest
 * `SEVERE_STREAK_READINGS` banked readings must ALL be severe before their min
 * may speak; anything less falls back to the median/smoothed sizing.
 *
 * In the median branch the SMOOTHED overshoot is a floor on the answer and is
 * never discounted: whatever the raw readings look like, if the mean is over the
 * limit that much really is owed. (The streak branch does not take that max —
 * it is already bounded below by limit + OVER_LIMIT_SEVERE_AMPS + flicker, and
 * raising it to the mean would change sizing in a case no live incident has
 * asked for.) What the flicker discount removes is the
 * 2026-08-02 failure — a lone 16.04A spike against a 14.92A mean sized a 1.14A
 * demand, and the reducer paid it by shedding a 4.8A room.
 */
export function requiredSavingsAmps(view: MeterView, limit: number, marginAmps: number): number {
  const over = view.overLimitReadings;
  const isSevere = (r: number): boolean => isSevereOverReading(r, limit, view.flickerAmps);
  const severe = over.filter(isSevere);
  // The newest readings, not merely the count: two spikes minutes apart in an
  // 8-deep ring are still two spikes, and the question this answers is whether
  // the line is severe NOW, before the 4-wide median has caught up with it.
  const streak = over.length >= SEVERE_STREAK_READINGS && over.slice(-SEVERE_STREAK_READINGS).every(isSevere);
  const overshoot = streak
    ? Math.min(...severe) - limit
    : Math.max(view.smoothedAmps - limit, median([...over]) - limit - view.flickerAmps);
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

  // Note: banked readings are cleared by sensing.ts the moment the meter shows
  // genuine headroom AND the raw reading is supply noise — so an episode the
  // meter has moved past cannot reach here at all. That gate deliberately lives
  // there and not here: only the reducer's own view knows whether a LOW smoothed
  // value means "the excursion is over" or "the median has not caught up with a
  // rise yet", and `rawIsSupplyNoise` is what separates them.
  if (view.overLimitBudget <= 0 && view.overLimitReadings.length === 0) {
    // The bucket is empty but the evidence has been dropped (sensing clears it
    // the moment the mean shows genuine headroom). The episode is not closed —
    // only the calm refill closes it — so there is nothing to size a cut from
    // and nothing to spend either. Live 2026-08-02: one in-band spike drained
    // the last point and cleared the readings in the SAME ingest, and the
    // urgent evaluation it triggered fell through to `calm` and ran the RAISE
    // path. An empty bucket must never be an invitation to spend.
    return { kind: "hold" };
  }

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
    // Severe keys off the mean OR a reading that clears the rung by more than
    // the live flicker. On a stable line (flicker 0, or its 0.2 floor) this is
    // the old rule; on a flickering generator it stops one spike promoting a
    // mild episode to the tier that skips inrush blanking and sheds a room.
    //
    // TIME is the third tier alongside magnitude. A mean 0.6–1.0A over the gen
    // limit classifies mild forever, and mild can only answer with level cuts
    // whose compressors wind down over minutes — live 2026-08-02 the meter rode
    // 15.6–16.0A on a 15A gen for two minutes while three cut batches went out,
    // and the breaker got there first. Twice. Once the MEAN has been over for
    // SUSTAINED_OVER_SEVERE_MS the tier stops depending on how far over it is.
    const sustainedSevere = view.smoothedOverMs >= SUSTAINED_OVER_SEVERE_MS;
    const severe =
      sustainedSevere ||
      view.smoothedAmps - limit > OVER_LIMIT_SEVERE_AMPS ||
      view.overLimitReadings.some((r) => isSevereOverReading(r, limit, view.flickerAmps));
    // Two full minutes of mean-over-limit: whatever the reducer could cut, it
    // has cut, and it is not arriving fast enough. This is the last rung — it
    // forces exactly ONE room off (invariant 26's one-shed ceiling is
    // unchanged), which is the trade the user chose over losing the whole house
    // to the breaker (2026-08-03).
    //
    // ⚠ `required > 0` is load-bearing, not decoration: it is the credited
    // figure, so while a cut we already sent still covers the deficit this can
    // never fire. Without it the tier would re-arm every few seconds during the
    // wind-down and shed a second room for amps that were already on their way
    // out — the 2026-07-31 double-shed, re-created from a clock instead of a
    // stale reading. "Not landing fast enough" is only knowable once the credit
    // has been absorbed and the mean is STILL over.
    //
    // …and that carve-out is what killed the generator at 12:39:57 on
    // 2026-08-04. A credit is the claim that amps are LATE. Lateness that never
    // shrinks is not a claim, it is a bet: at 12:38 the reducer commanded ~3.0A
    // (two fan trims plus Abdullah L2→L1), the meter fell **0.49A in 91
    // seconds**, and because the credited deficit read 0 the last rung on the
    // ladder stayed silent while the mean sat 0.6–1.1A over for two and a half
    // minutes. Invariant 38's revocation could not help either: it fires when
    // the meter RISES above the cut's anchor, and this one sat pinned AT it.
    //
    // So the credit keeps the rung only while it is demonstrably arriving —
    // past `CREDIT_LANDING_GRACE_MS`, at least `CREDIT_LANDING_FRACTION` of what
    // was commanded has actually left the meter. Inside the grace it is trusted
    // (fan trims land in seconds, compressors do not), and a fired shed re-arms
    // both the credit and the anchor, so the double-shed shapes this carve-out
    // was written for stay covered. `cutTrendOf` is that judgment, shared with
    // the sustained clock and the escalation hold — one predicate, so the three
    // rungs cannot disagree about whether the same cut is working.
    const sustainedExtreme =
      view.smoothedOverMs >= SUSTAINED_OVER_EXTREME_MS && (required > 0 || cutTrendOf(view) === "stalled");
    const severity = required >= extremeAt || sustainedExtreme ? "extreme" : severe ? "severe" : "mild";
    return { kind: "over", requiredAmps: required, severity, rawRequiredAmps: rawRequired };
  }

  // Proactive projection (an AC just turned ON near the limit): the compressor
  // will ramp toward its floor draw over minutes — act on the projection now
  // instead of letting the bucket drain reading-by-reading during the ramp.
  const projected = view.smoothedAmps + (opts.projectedExtraAmps ?? 0);
  if (opts.projectedExtraAmps != null && view.sampleCount >= 2 && projected > limit) {
    const projectedRequired = Math.max(0.1, projected - limit) + config.marginAmps;
    return {
      kind: "over",
      requiredAmps: projectedRequired,
      severity: "mild",
      rawRequiredAmps: projectedRequired,
    };
  }

  if (view.calmMs > 0 && !view.collapsed) {
    const restingCeiling = limit - config.marginAmps - config.restingBufferAmps;
    return { kind: "calm", headroomAmps: restingCeiling - view.smoothedAmps };
  }

  return { kind: "hold" };
}
