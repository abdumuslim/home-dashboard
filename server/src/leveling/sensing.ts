// Pure meter-sensing reducer for leveling v2. Ports the proven v1 mechanisms
// verbatim where they worked: the over-limit leaky bucket (integral-style trip
// that tolerates near-limit noise), the power-collapse latch (probable breaker
// trip / blackout detection), and source detection. Replaces v1's count-based
// headroom streaks with time-based calm (the ESP cadence varies ~2.7–5s, so
// reading counts never meant a fixed duration).
//
// No I/O, no Date.now() — the caller passes `now`. Every ingest returns a new
// MeterState (immutable) plus the events it produced.

import type { CollapseLatch, CutTrend, MeterEvent, MeterState, MeterView, PowerSource } from "./types.js";
import type { LevelingConfigV2 } from "./config.js";
import { effectiveLimit } from "./config.js";

// ---- Ported v1 constants (values unchanged; provenance: ac-leveling.ts) ----

/** Leaky-bucket capacity in points; empty (≤0) = act. */
export const OVER_LIMIT_BUDGET = 5;
/** Points drained by a reading more than OVER_LIMIT_SEVERE_AMPS over the limit. */
export const OVER_LIMIT_DRAIN_SEVERE = 3;
/**
 * Points drained by a reading meaningfully — but not severely — over the limit.
 *
 * The drain used to be binary, 3 or 1, with the step at a full amp over. Live
 * 2026-07-31 the gen sat at 15.93A on a 15A limit: 0.93A over, one point per
 * reading, five readings to act — **52 seconds** before the first corrective
 * command, on a breaker that had ~90 seconds left in it. Anything half an amp
 * over is not meter noise, and this middle rung gets the first act out in
 * ~2–3 readings without touching the noise tolerance the bucket exists for.
 */
export const OVER_LIMIT_DRAIN_MODERATE = 2;
/** Points drained by a reading within OVER_LIMIT_MODERATE_AMPS over the limit. */
export const OVER_LIMIT_DRAIN_MILD = 1;
/** Amps above the raw limit that classify a reading as severely over. */
export const OVER_LIMIT_SEVERE_AMPS = 1;
/** Amps above the raw limit past which a reading is more than noise. */
export const OVER_LIMIT_MODERATE_AMPS = 0.5;
/** Sudden measured drop ≥ this (vs the prior median) is a candidate trip. */
export const POWER_COLLAPSE_DROP_AMPS = 6;
/** …AND the reading must land at/below this floor (the AC load vanished). */
export const POWER_COLLAPSE_FLOOR_AMPS = 5;
/**
 * …or at/below this FRACTION of the pre-fall mean, whichever is higher.
 *
 * The absolute floor encodes "the AC load vanished" and silently assumes the
 * rest of the house draws under 5A. Live 2026-08-02 the AC circuit died twice
 * on the generator and the house kept drawing **5.76–6.2A** — over the floor
 * both times, so neither break latched. No derate, no freeze, no FLOORS on
 * recovery, and (because a post-trip trough reads as perfect calm) the
 * controller raised three levels into a dead line and caused the second break.
 *
 * A guard must be sized against the whole quantity it guards (hard rule 5c):
 * the residual is the HOUSE, and the house is not a constant. Relative to the
 * mean it was carrying, both breaks left ~0.36–0.40 — well inside 0.5.
 *
 * ⚠ This cannot distinguish a trip from someone turning off the biggest AC by
 * remote, because that room IS most of the load. What separates them is the
 * commanded-cut credit: every off we know about — ours, the dashboard's, the
 * automation's, or one we merely OBSERVE — is priced and credited, and only the
 * unexplained remainder latches. Keep those hooks wired (controller
 * `onUserPowerOff` / the observed-off scan) or this floor will false-latch.
 */
export const POWER_COLLAPSE_FLOOR_FRACTION = 0.5;
/**
 * How long the pre-fall mean stays available as the collapse baseline.
 *
 * The latch had a two-reading window and did not know it: with `SMOOTH_WINDOW`
 * 4, the median flipped on the third post-cliff reading (two low + two high
 * averages one of each), so a 9.8A measured drop read as 5.2A and failed the
 * test it passed twice. A fall that is still arriving must be judged against
 * where it started.
 *
 * At `SMOOTH_WINDOW` 8 (2026-08-05) the same arithmetic runs slower, and in the
 * safe direction: the median is still fully pre-fall for THREE post-cliff
 * readings, halfway on the fourth (four low + four high averages one of each),
 * and fully post-fall on the fifth — 12–20 s after the cliff at the 3–5 s
 * cadence, inside this 30 s hold with room to spare. The anchor is armed on the
 * first reading that qualifies as a fall, so a wider window makes it needed
 * LESS often (the prior median stays honest longer), never later.
 */
export const CLIFF_ANCHOR_MS = 30_000;
/**
 * Calm stand-down after an unexplained collapse-shaped fall that did NOT latch.
 * Belt to the latch's braces: whatever the trough is, it is not evidence of
 * headroom, and nothing may be spent into it until the line proves otherwise.
 */
export const UNEXPLAINED_FALL_CALM_HOLD_MS = 120_000;
/**
 * The SMOOTHED mean sitting continuously over the limit for this long is
 * SEVERE, whatever its magnitude — it un-gates the shed rung (inrush blanking
 * and the escalation settle are both mild-only, deliberately).
 */
export const SUSTAINED_OVER_SEVERE_MS = 45_000;
/**
 * …and for this long is EXTREME: two full minutes of mean-over-limit means the
 * reducer has already cut what it could and the compressors are not winding
 * down fast enough. A breaker's thermal budget is ~2–4 min, so this is the last
 * moment a decision of ours can still beat it. Forces exactly ONE room off
 * (invariant 26's one-shed ceiling is unchanged) — the user's own trade
 * (2026-08-03): a break turns off every room.
 */
export const SUSTAINED_OVER_EXTREME_MS = 120_000;
/**
 * How long a commanded cut gets before its progress is judged at all.
 *
 * A fan trim reaches the meter in seconds; a level cut's compressor throttles
 * down over a minute or more, and a shed's off lands anywhere from 6 s to
 * minutes after the send. Sixty seconds is past the fast actuators and into the
 * slow ones, so a cut that has shown nothing by now is not merely late.
 *
 * ⚠ The residual risk is named on purpose: a genuinely slow shed can look
 * un-landed at 60 s and cost ONE extra room. That is the trade the user made
 * when he chose the extreme rung (2026-08-03) — a break turns off every room —
 * and the fired shed re-arms the credit and the anchor, so nothing can cascade
 * inside the next window.
 */
export const CREDIT_LANDING_GRACE_MS = 60_000;
/**
 * How much of a commanded cut must have reached the meter by then for the
 * credit to still count as "late amps" rather than amps that are not coming.
 *
 * Compared against `commandedCutTotalAmps` (0.4–13 A across observed episodes)
 * measured as the fall from that cut's own anchor. What consumes it is the
 * compressor wind-down curve against the breaker's thermal one: live 2026-08-04
 * 12:38–12:39, ~3.0 A of fan trims and a level cut delivered **0.49 A in 91 s**
 * — 16% — while the mean sat 0.6–1.1 A over a 15 A generator, and the breaker
 * went at 12:39:57. A fan trim alone lands ~100% inside the grace, and a real
 * level cut shows well over a third of itself, so the bar separates "arriving"
 * from "not arriving" without punishing the fast actuators.
 */
export const CREDIT_LANDING_FRACTION = 0.35;
/** Collapse clears when measured recovers to within this of the pre-collapse median. */
export const POWER_COLLAPSE_RECOVER_GAP = 3;
/** Safety cap on a collapse latch (never strand the controller). */
export const POWER_COLLAPSE_MAX_MS = 300_000;
/**
 * How long a commanded cut stays creditable against a collapse-shaped drop.
 * The send→compressor-stop lag is 6 s to minutes, so the credit must outlive
 * the batch; it must NOT outlive it by so much that a genuine trip minutes
 * later is laundered as "ours". Three minutes covers the observed lag (64 s on
 * 2026-07-28) with margin and still latches anything later.
 */
export const PENDING_CUT_MS = 180_000;
/** Reading older than this = no electricity (matches /api/current/power). */
export const STALE_POWER_MS = 15_000;
/** Same noise floor the power card uses to consider a line active. */
export const NOISE_THRESHOLD = 0.1;
/** A gap in the ESP reading stream longer than this is a blackout signature. */
export const ESP_GAP_EVENT_MS = 20_000;

// ---- v2 constants ----

/** Sustained calm required to refill the bucket and close an over-limit episode. */
export const CALM_REFILL_MS = 30_000;
/**
 * Smoothing window (median) size — how many readings the "mean" is taken over.
 *
 * Widened 4 → 8 on 2026-08-05 at the user's request. The smoothed meter is the
 * controller's statement about LOAD (invariant 24: a generator is not a stable
 * line, so the mean is the truth and a raw spike is not), and at four readings
 * — ~12–20 s at the 2.7–5 s ESP cadence — it still partially TRACKED the slow
 * wobble it exists to remove: a genset governor hunting, and two compressors
 * cycling against each other on a period of tens of seconds. Eight readings is
 * ~25–40 s, comfortably longer than that wobble, so the mean irons it out
 * instead of following it.
 *
 * What it costs, stated plainly so the next forensic session does not have to
 * rediscover it: everything judged on the SMOOTHED meter moves about two
 * readings (~6–10 s) later. A genuine load step reaches the median on the fifth
 * post-step reading instead of the third, so `smoothedOverSince` — and with it
 * SUSTAINED_OVER_SEVERE_MS and SUSTAINED_OVER_EXTREME_MS — starts that much
 * later, and a commanded cut's absorption is credited that much more slowly.
 *
 * The fast paths are deliberately untouched, and that is what makes the trade
 * affordable: the leaky bucket drains on RAW readings and calm breaks on a raw
 * reading past the live flicker (`rawIsSupplyNoise`). Both were put on the raw
 * yardstick precisely so a real breach never has to wait for the median.
 */
const SMOOTH_WINDOW = 8;
/**
 * Bounded ring of recent measured readings (trend + collapse baseline).
 *
 * Deliberately EQUAL to `SMOOTH_WINDOW` since 2026-08-05, not an accident of
 * the widening: nothing in this file reads a ring entry OLDER than the
 * smoothing window, so a wider ring would buy nothing — and it would silently
 * widen two other things that are bounded by it. `flickerSamples` caps at
 * RECENT_RING, so the flicker estimator would look further back than the ~8
 * readings its thresholds were measured against; and `overLimitReadings` banks
 * `slice(-RECENT_RING)`, so the deficit sizing would draw on older evidence
 * about a house that has since moved. Widen it only with both of those in hand.
 */
const RECENT_RING = 8;
/**
 * Frozen-meter detection (2026-07-23 incident: ESP hung showing ~14.8A for
 * 17.5 min): a live CT always micro-jitters between readings; when NEITHER
 * channel moves by ≥ this across consecutive readings the payload is a repeat.
 */
export const FROZEN_EPSILON_AMPS = 0.005;
/** Readings with no micro-change on either channel for this long = frozen sensor. */
export const METER_FROZEN_AFTER_MS = 60_000;

/**
 * Deadband: an estimate below this rounds to ZERO rather than up. A quiet line
 * has no flicker to tolerate, so it keeps exactly the classification it had
 * before any of this existed — the tolerance only ever appears where the meter
 * has actually demonstrated it.
 */
export const FLICKER_MIN_AMPS = 0.2;
/**
 * Cap. This bounds what noise tolerance can ever cost on a real breach: a
 * reading must clear `OVER_LIMIT_SEVERE_AMPS + flicker` to be severe, so at
 * most 2.5A over — and the SMOOTHED overshoot (below) is never discounted at
 * all, which is what keeps a genuine overload's latency where it was.
 */
export const FLICKER_MAX_AMPS = 1.5;
/** Ring readings required before flicker is estimable at all. */
export const FLICKER_MIN_SAMPLES = 6;

/**
 * How close to its origin the signal must return for an excursion to count as
 * supply flicker rather than load: within half the excursion's own size.
 */
export const FLICKER_REVERT_FRACTION = 0.5;
/** …and within this many readings. Flicker comes back; load does not. */
export const FLICKER_REVERT_WINDOW = 2;

/**
 * Live supply-flicker estimate: the second-largest REVERTING excursion in the
 * ring.
 *
 * A generator is not a stable line — live 2026-08-02 the gen wobbled ~±1A
 * reading-to-reading while the mean sat comfortably under the limit, and every
 * one of those spikes drained the leaky bucket and broke the calm that refills
 * it. The bucket could only ratchet down, so the reducer eventually shed a room
 * at a SMOOTHED 14.215A against a 14.5A effective limit — the mean was 0.3A
 * UNDER. Riding near the limit is the whole point of the controller, and on gen
 * it was self-defeating.
 *
 * What makes an estimate of noise safe to trust is that LOAD can never mint it.
 * This shipped as "second-largest jump between consecutive readings", whose
 * stated argument — a spike is two jumps and survives, a genuine step is one
 * jump and is filtered — holds only while the ring contains at most ONE real
 * event. Two compressors cycling inside one 8-reading window (the ordinary
 * steady state of this house) are two large jumps, so the estimate pinned at
 * its 1.5A cap and loosened severity, calm, the drain rung and the deficit
 * sizing all at once — the second compressor's own start minting the tolerance
 * that then hid it. A monotonic ramp (or a shed's own wind-down) read as its
 * per-reading step for the same reason.
 *
 * So an excursion counts only if the signal comes BACK: flicker spikes and
 * returns within a reading or two, while a compressor step, a shed landing and
 * a ramp all walk away from where they started and stay there. Two qualifying
 * excursions are required, so a single spike-shaped coincidence — a turn-on
 * that we shed two readings later, say — still mints nothing.
 *
 * Returns 0 below `FLICKER_MIN_SAMPLES` clean readings, so a fresh boot, a
 * source change, an ESP gap or a post-collapse window behaves exactly as it did
 * before this existed — never more permissive than the code it replaced.
 */
function flickerOfRing(recent: readonly number[]): number {
  if (recent.length < FLICKER_MIN_SAMPLES) return 0;
  const excursions: number[] = [];
  for (let i = 1; i < recent.length; i++) {
    const origin = recent[i - 1];
    const size = Math.abs(recent[i] - origin);
    if (size < FLICKER_MIN_AMPS) continue;
    const last = Math.min(i + FLICKER_REVERT_WINDOW, recent.length - 1);
    for (let j = i + 1; j <= last; j++) {
      if (Math.abs(recent[j] - origin) <= size * FLICKER_REVERT_FRACTION) {
        // BOTH legs — the excursion out and the return. This is what the
        // original "second-largest jump" was really counting whenever the
        // signal was genuinely noisy, and dropping it here would make the
        // estimate collapse to the baseline wobble whenever the newest reading
        // happened to BE the spike (its return leg is not in the ring yet).
        excursions.push(size, size);
        break;
      }
    }
  }
  if (excursions.length < 2) return 0;
  excursions.sort((a, b) => b - a);
  return Math.min(FLICKER_MAX_AMPS, excursions[1]);
}

/**
 * The readings the estimator may look at: only those since the last
 * discontinuity. `slice(-0)` returns the WHOLE array, so the zero case is
 * explicit.
 */
function flickerWindowOf(recent: readonly number[], samples: number): readonly number[] {
  const n = Math.min(samples, recent.length);
  return n <= 0 ? [] : recent.slice(-n);
}

export function flickerAmps(state: MeterState): number {
  return flickerOfRing(flickerWindowOf(state.recent, state.flickerSamples));
}

/**
 * The ONE definition of a severely-over reading, shared by the bucket-empty
 * event and by pressure's severity tier so they can never disagree. A raw
 * reading must clear the severe rung by more than the live flicker to count —
 * on a quiet line (flicker 0 or the 0.2 floor) this is within a rounding error
 * of the old fixed rule.
 */
export function isSevereOverReading(reading: number, limit: number, flicker: number): boolean {
  return reading - limit > OVER_LIMIT_SEVERE_AMPS + flicker;
}

/**
 * Post-collapse limit derate (2026-07-26 triple gen trip). A thermal-magnetic
 * breaker that just tripped is hot and re-trips well below its rating until it
 * cools: the same 15A gen went at 15.65A, then 14.48A 11 min later, then
 * 13.99A 9 min after that — the third on an ordinary single raise that every
 * meter- and model-side gate correctly admitted against the CONFIGURED limit.
 * No decision logic can survive a limit that is above what the hardware holds,
 * so each collapse walks the effective limit down and every consumer follows.
 */
export const COLLAPSE_DERATE_AMPS = 1;
/** Ceiling on the stacked derate — a cascade must not starve the line to nothing. */
export const COLLAPSE_DERATE_MAX_AMPS = 3;
/**
 * How long ONE rung of the derate lasts; each new collapse refreshes it (and
 * adds a step). Longer than the observed 9–11 min between cascade trips, so a
 * repeat trip lands INSIDE the window and stacks rather than starting over.
 */
export const COLLAPSE_DERATE_MS = 20 * 60_000;
/**
 * How much of the derate the line earns back per quiet rung.
 *
 * The derate used to CLIFF-expire — one rung, then straight back to full
 * rating. Live 2026-07-30: the gen tripped at 09:25:06 (derate → 14.0A), the
 * rung ended at 09:45:06, and the leveler spent the reclaimed amps on a raise
 * **2 seconds later**; it tripped again at 09:51:40. Worse, that second trip
 * found `standing` back at 0 and re-armed at 1.0A instead of escalating — the
 * "walk the limit down on every collapse" design defeated by its own expiry.
 * Handing the rating back in steps keeps the ladder standing between trips, so
 * a repeat trip escalates (0.5 → 1.5) the way it was meant to.
 */
export const COLLAPSE_DERATE_RECOVERY_STEP = 0.5;

/**
 * Generator STRAIN (user, 2026-08-04: "consider the gen flickering, without
 * leading to a power break").
 *
 * After the 11:22 surge the ESP logged power gaps of 28–47 s at 11:31–11:36
 * while the controller rode 14.3–14.8A on the 15A generator and reported itself
 * healthy. Those gaps are brownouts: at 46 °C ambient a genset delivers less
 * than its plate rating, and the line browning out while we sit within an amp
 * of the limit is the only evidence this house can produce that the real
 * ceiling is lower than the configured one.
 *
 * A strain event is an ESP gap of at least `ESP_GAP_EVENT_MS` that ENDS on gen
 * with the pre-gap smoothed meter within `STRAIN_NEAR_LIMIT_AMPS` of the
 * effective limit. It is deliberately NOT a collapse: nothing latches, nothing
 * freezes, no push — the ceiling comes down and the ordinary ladder respects it.
 */
export const STRAIN_DERATE_AMPS = 0.5;
/**
 * Ceiling on the stacked strain derate. Three rungs — a generator that cannot
 * hold 1.5A under its rating is a hardware problem, not something the leveler
 * should keep answering by starving the house.
 */
export const STRAIN_DERATE_MAX_AMPS = 1.5;
/**
 * How near the limit the pre-gap mean must have been for a gap to count as
 * strain rather than a Wi-Fi flake.
 *
 * Compared against `effectiveLimit − smoothedAmps(pre-gap)`. The largest single
 * increment that can consume it is supply flicker, capped at
 * `FLICKER_MAX_AMPS` (1.5) on RAW readings — but this is measured on the
 * SMOOTHED mean, where the 8-wide median has already removed the single-reading
 * spikes, so a mean this close to the limit is genuine load. Live evidence:
 * 14.3–14.8A against a 15A limit is 0.2–0.7A of margin, comfortably inside;
 * an ESP dropout at a 9A house is 6A out and must do nothing.
 */
export const STRAIN_NEAR_LIMIT_AMPS = 1.5;
/**
 * Two strain events inside this window arm (or step) the derate. ONE brownout
 * is a generator having a moment — a fuel slug, a governor hunting — and
 * answering it would cost comfort for noise. Two is a pattern, and the live
 * cluster was five gaps inside six minutes.
 */
export const STRAIN_WINDOW_MS = 10 * 60_000;
/** Events needed inside `STRAIN_WINDOW_MS`. */
export const STRAIN_EVENTS_TO_DERATE = 2;
/**
 * One rung of the strain derate, and how much is handed back per quiet rung.
 * Same shape as the collapse derate for the same reason (invariant 15): a cliff
 * hand-back is spent within seconds by the raise path, so the line earns its
 * rating back in steps or not at all. A full 1.5A stack therefore takes an hour
 * of quiet to retire.
 */
export const STRAIN_DERATE_MS = 20 * 60_000;
export const STRAIN_DERATE_RECOVERY_STEP = 0.5;

/**
 * Live strain derate for `source` — the same stepped decay `derateFor` applies
 * to a collapse, kept as its own record so the two caps stay independent and a
 * brownout can never be mistaken for a trip.
 */
export function strainDerateFor(state: MeterState, source: PowerSource, now: number): number {
  const d = state.strainDerate;
  if (d == null || d.source !== source) return 0;
  if (now < d.until) return d.amps;
  const rungsElapsed = 1 + Math.floor((now - d.until) / STRAIN_DERATE_MS);
  return Math.max(0, d.amps - rungsElapsed * STRAIN_DERATE_RECOVERY_STEP);
}

/**
 * Everything shrinking the ceiling on `source` right now: a breaker that
 * tripped, plus a generator that has been browning out. EVERY limit consumer
 * must read this one — the leaky bucket, the reducer and the raise envelope
 * disagreeing about what "over" means is how episodes drag.
 */
export function totalDerateFor(state: MeterState, source: PowerSource, now: number): number {
  return derateFor(state, source, now) + strainDerateFor(state, source, now);
}

/**
 * Live derate for `source`, or 0 (fully recovered / different line / never
 * tripped). Pure function of time: `until` ends the CURRENT rung, and every
 * further elapsed rung hands back one `COLLAPSE_DERATE_RECOVERY_STEP`. A line
 * carrying nothing cools fastest, so recovery deliberately does not require
 * readings — but it is still per-source, so a gen→grid→gen bounce cannot
 * launder a breaker that only just tripped.
 */
export function derateFor(state: MeterState, source: PowerSource, now: number): number {
  const d = state.derate;
  if (d == null || d.source !== source) return 0;
  if (now < d.until) return d.amps;
  const rungsElapsed = 1 + Math.floor((now - d.until) / COLLAPSE_DERATE_MS);
  return Math.max(0, d.amps - rungsElapsed * COLLAPSE_DERATE_RECOVERY_STEP);
}

/**
 * The derate a fresh collapse on `source` arms, stacking on whatever rung is
 * still standing. ONE definition, shared by the fall-latched collapse inside
 * `ingestReading` and the entry-latched one below — a second copy would drift,
 * and the whole point of invariant 15 is that a repeat trip escalates from
 * where the line actually was rather than from full rating.
 */
export function collapseDerate(
  state: MeterState,
  source: PowerSource,
  now: number,
): NonNullable<MeterState["derate"]> {
  const standing = derateFor(state, source, now);
  return {
    source,
    amps: Math.min(COLLAPSE_DERATE_MAX_AMPS, standing + COLLAPSE_DERATE_AMPS),
    until: now + COLLAPSE_DERATE_MS,
  };
}

/**
 * Latch a collapse the READINGS cannot see: a source session that BEGINS with
 * the AC circuit already dead has no cliff for `ingestReading` to judge (see
 * dead-window.ts for the 2026-08-04 trip this missed). The caller owns the
 * evidence — it needs device liveness, which is not a meter fact — and this
 * arms exactly what the fall path arms: the latch, the stacked derate, and a
 * broken calm.
 *
 * `preMedianAmps` is what the line SHOULD be carrying (the meter plus the
 * modeled draw of the rooms we believe are on), not the dead reading itself.
 * Recovery in `ingestReading` is "the meter came back to within
 * POWER_COLLAPSE_RECOVER_GAP of the pre-collapse mean", and against a
 * house-only reading that is satisfied by the very reading that latched it.
 */
export function latchCollapse(
  state: MeterState,
  opts: { source: Exclude<PowerSource, "none">; now: number; preMedianAmps: number },
): MeterState {
  if (state.collapse != null) return state;
  return {
    ...state,
    collapse: { preMedianAmps: opts.preMedianAmps, until: opts.now + POWER_COLLAPSE_MAX_MS },
    derate: collapseDerate(state, opts.source, opts.now),
    calmSince: null,
  };
}

/** Release a latch the caller armed, once its own evidence has cleared. */
export function clearCollapse(state: MeterState): MeterState {
  return state.collapse == null ? state : { ...state, collapse: null, calmSince: null };
}

export function initialMeterState(): MeterState {
  return {
    source: "none",
    lastReadingAt: 0,
    recent: [],
    overLimitBudget: OVER_LIMIT_BUDGET,
    overLimitReadings: [],
    calmSince: null,
    calmHoldUntil: 0,
    cliffAnchor: null,
    flickerSamples: 0,
    smoothedOverSince: null,
    collapse: null,
    strainDerate: null,
    strainEvents: [],
    lastRaw: null,
    lastMicroChangeAt: 0,
    frozen: false,
    derate: null,
    pendingCut: null,
  };
}

/**
 * Arm/extend the commanded-cut credit after a reducing batch was SENT.
 * `amps` is the batch's own priced saving (learned/model), so the credit can
 * never exceed what the pipeline believed it was cutting. Stacking sheds add
 * up; the anchor re-bases on the meter as it stood when this batch went out.
 */
export function noteCommandedCut(state: MeterState, amps: number, now: number): MeterState {
  if (!(amps > 0)) return state;
  const live = state.pendingCut != null && now < state.pendingCut.until ? state.pendingCut : null;
  const carried = live != null ? Math.max(0, live.amps - live.absorbedAmps) : 0;
  return {
    ...state,
    pendingCut: {
      anchorAmps: smoothedAmps(state),
      amps: carried + amps,
      absorbedAmps: 0,
      until: now + PENDING_CUT_MS,
    },
  };
}

/**
 * Amps of commanded cut the meter has not shown yet (0 when none/expired).
 *
 * ZERO while the house is OUTRUNNING the cut. The credit's premise is "these
 * amps are not gone, they are late" — true whenever the net load is falling
 * toward the anchor. It is false when something else is ramping UP harder than
 * our cut is winding down: the amps really are still coming off, and the meter
 * is still climbing anyway, so excusing the ladder is excusing nothing.
 *
 * Live 2026-08-03 12:26–12:29: Abdu was switched back on at 46°C outdoor. Two
 * level cuts armed 2.0A then 3.1A of credit against a ~0.3–1.6A overshoot, so
 * `requiredAmps` read 0 and the reducer planned NOTHING for 2 min 24 s while
 * the meter climbed 15.6 → 16.6A. The 120 s sustained-extreme rung — added the
 * day before for exactly this shape — is gated on `required > 0` and could
 * never fire. The breaker did.
 *
 * The anchor is the meter as the batch went out, so "above the anchor" means
 * the house is drawing more now than when we started cutting. Compared past the
 * live flicker so supply wobble on a generator cannot revoke a real credit —
 * revoking it wrongly re-opens the 2026-07-31 double-shed.
 */
export function pendingCutCredit(state: MeterState, now: number): number {
  const cut = state.pendingCut;
  if (cut == null || now >= cut.until) return 0;
  const outrun = smoothedAmps(state) - cut.anchorAmps;
  if (outrun > Math.max(flickerAmps(state), FLICKER_MIN_AMPS)) return 0;
  return Math.max(0, cut.amps - cut.absorbedAmps);
}

/** The four numbers a cut's trend is judged from — `MeterView` satisfies it. */
export interface CutTrendInput {
  commandedCutTotalAmps: number;
  commandedCutAnchorAmps: number;
  commandedCutAgeMs: number;
  smoothedAmps: number;
}

/**
 * ONE trend judgment about a reducing batch already in flight, shared by every
 * consumer that used to ask the question its own way (2026-08-04, R12b).
 *
 * Both faces of the same defect were live on 2026-08-04 within thirteen
 * minutes, and they are opposites:
 *
 *  - 12:38→12:39:57 — ~3.0A commanded, **0.49A delivered in 91s**, mean 0.6–1.1A
 *    over. The credited deficit read 0, so the last rung stayed silent and the
 *    breaker went. That cut was `stalled`.
 *  - 12:56:26→12:56:39 — 2.9A commanded at a 16.565A anchor, and thirteen
 *    seconds later the smoothed meter was 14.24A: **2.3A of the 2.9 already
 *    gone**, falling fast. A second room was shed anyway. That cut was
 *    `arriving`, and arriving is exactly when nothing more should be spent from
 *    a room's comfort.
 *
 * `arriving` is deliberately checked BEFORE the grace: a cut that proves itself
 * in ten seconds (fan trims do) is arriving, not merely young. `stalled` is
 * only ever claimed after `CREDIT_LANDING_GRACE_MS`, so the fast actuators are
 * never called liars for physics they have not had time to deliver.
 */
export function cutTrendOf(v: CutTrendInput): CutTrend {
  if (!(v.commandedCutTotalAmps > 0)) return "none";
  const fallenAmps = Math.max(0, v.commandedCutAnchorAmps - v.smoothedAmps);
  if (fallenAmps >= CREDIT_LANDING_FRACTION * v.commandedCutTotalAmps) return "arriving";
  return v.commandedCutAgeMs < CREDIT_LANDING_GRACE_MS ? "settling" : "stalled";
}

/**
 * The in-flight cut's figures exactly as `MeterView` publishes them (zeros when
 * nothing is in flight). One definition, so the clock inside `ingestReading`
 * and the view the pipeline reads can never disagree about the same cut.
 */
function liveCutFigures(
  pendingCut: MeterState["pendingCut"],
  now: number,
): Omit<CutTrendInput, "smoothedAmps"> {
  if (pendingCut == null || now >= pendingCut.until) {
    return { commandedCutTotalAmps: 0, commandedCutAnchorAmps: 0, commandedCutAgeMs: 0 };
  }
  return {
    commandedCutTotalAmps: pendingCut.amps,
    commandedCutAnchorAmps: pendingCut.anchorAmps,
    commandedCutAgeMs: Math.max(0, PENDING_CUT_MS - (pendingCut.until - now)),
  };
}

/** Mirrors the power card's active-source logic. */
export function determineSource(
  reading: { gridAmps: number; genAmps: number } | null,
  staleMs: number,
): PowerSource {
  if (!reading || staleMs > STALE_POWER_MS) return "none";
  const gridActive = reading.gridAmps > NOISE_THRESHOLD;
  const genActive = reading.genAmps > NOISE_THRESHOLD;
  if (gridActive && genActive) return reading.gridAmps >= reading.genAmps ? "grid" : "gen";
  if (gridActive) return "grid";
  if (genActive) return "gen";
  return "none";
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Median of the newest `SMOOTH_WINDOW` (8) readings — ~25–40s at the ESP cadence. */
export function smoothedAmps(state: MeterState): number {
  return median(state.recent.slice(-SMOOTH_WINDOW));
}

export interface IngestResult {
  state: MeterState;
  events: MeterEvent[];
}

/**
 * Ingest one ESP reading. Order of concerns (ported from v1 onPowerReading):
 * ESP-gap detection → source change (episodic reset) → none early-return →
 * collapse resolve/latch → ring update → bucket / calm accounting.
 */
export function ingestReading(
  prev: MeterState,
  reading: { gridAmps: number; genAmps: number },
  config: LevelingConfigV2,
  now: number,
): IngestResult {
  const events: MeterEvent[] = [];

  const gapped = prev.lastReadingAt > 0 && now - prev.lastReadingAt > ESP_GAP_EVENT_MS;
  const gapMs = now - prev.lastReadingAt;
  if (gapped) {
    events.push({ kind: "esp_gap", gapMs });
  }

  // Frozen-meter tracking (device-level — survives source changes): a live CT
  // always micro-jitters, so a stream of payloads where NEITHER channel moves
  // is a hung sensor reporting a stale value, not a flat load. A gap breaks
  // the clock (a fresh stream after silence starts a new judgment window).
  const moved =
    prev.lastRaw == null ||
    Math.abs(reading.gridAmps - prev.lastRaw.gridAmps) >= FROZEN_EPSILON_AMPS ||
    Math.abs(reading.genAmps - prev.lastRaw.genAmps) >= FROZEN_EPSILON_AMPS;
  let lastMicroChangeAt = prev.lastMicroChangeAt > 0 ? prev.lastMicroChangeAt : now;
  let frozen = prev.frozen;
  if (gapped || moved) {
    if (frozen) events.push({ kind: "meter_unfrozen", frozenForMs: now - lastMicroChangeAt });
    frozen = false;
    lastMicroChangeAt = now;
  } else if (!frozen && now - lastMicroChangeAt >= METER_FROZEN_AFTER_MS) {
    frozen = true;
    events.push({
      kind: "meter_frozen",
      frozenForMs: now - lastMicroChangeAt,
      amps: Math.max(reading.gridAmps, reading.genAmps),
    });
  }
  const lastRaw = { gridAmps: reading.gridAmps, genAmps: reading.genAmps };

  const source = determineSource(reading, 0);
  let state: MeterState = { ...prev, lastReadingAt: now, lastRaw, lastMicroChangeAt, frozen };

  if (source !== prev.source) {
    // Episodic state is per-source: bucket, calm, smoothing ring, collapse latch.
    // Frozen tracking is device-level and rides through; so does the derate —
    // it is knowledge about a LINE that just tripped, not episode bookkeeping,
    // and it carries its own source tag so it only binds where it was earned
    // (a gen→grid→gen bounce must not launder a hot gen breaker back to full).
    events.push({ kind: "source_changed", from: prev.source, to: source });
    state = {
      source,
      lastReadingAt: now,
      recent: [],
      overLimitBudget: OVER_LIMIT_BUDGET,
      overLimitReadings: [],
      calmSince: null,
      calmHoldUntil: 0,
      cliffAnchor: null,
      flickerSamples: 0,
      smoothedOverSince: null,
      collapse: null,
      // Knowledge about a LINE rides through (it carries its own source tag);
      // the events that produced it are episode bookkeeping and do not.
      strainDerate: prev.strainDerate,
      strainEvents: [],
      lastRaw,
      lastMicroChangeAt,
      frozen,
      derate: prev.derate,
      // Amps on the OLD line — a cut we commanded there explains nothing here.
      pendingCut: null,
    };
  }

  if (source === "none") {
    return { state: { ...state, calmSince: null }, events };
  }

  const measured = source === "grid" ? reading.gridAmps : reading.genAmps;

  // Collapse latch: resolve an active latch first (recovery or safety expiry),
  // then judge this reading against the trend BEFORE it joins the window.
  let collapse: CollapseLatch | null = state.collapse;
  let cliffAnchor = state.cliffAnchor;
  let calmHoldUntil = state.calmHoldUntil;
  if (collapse != null) {
    if (measured >= collapse.preMedianAmps - POWER_COLLAPSE_RECOVER_GAP) {
      collapse = null;
      events.push({ kind: "collapse_recovered", source });
    } else if (now >= collapse.until) {
      collapse = null;
    }
  }
  // Still a PRIOR value with `SMOOTH_WINDOW === RECENT_RING` (2026-08-05): the
  // ring is updated further down, so this median spans the readings BEFORE this
  // one whether it covers part of the ring or all of it. What the widening does
  // cost is seating time — the baseline now needs eight readings on the current
  // source (~25–40 s) rather than four, so a fall inside the first half-minute
  // of a changeover has no baseline to be judged against. That hole is what
  // `entryCollapseEvidence` (dead-window.ts, invariant 45) exists to cover: a
  // session that begins dead never had a cliff for this path to see either.
  const priorMedian = state.recent.length >= SMOOTH_WINDOW ? smoothedAmps(state) : null;
  // A fall still arriving is judged from where it STARTED, not from a median
  // that has already swallowed half of it (see CLIFF_ANCHOR_MS).
  const anchorMedian =
    cliffAnchor != null && now < cliffAnchor.at + CLIFF_ANCHOR_MS ? cliffAnchor.medianAmps : null;
  const baseline =
    priorMedian != null && anchorMedian != null
      ? Math.max(priorMedian, anchorMedian)
      : (priorMedian ?? anchorMedian);
  // "The AC load vanished" is a statement about the load that WAS there, not a
  // constant: the residual house draw is whatever the house happens to be.
  const collapseFloor =
    baseline != null
      ? Math.max(POWER_COLLAPSE_FLOOR_AMPS, baseline * POWER_COLLAPSE_FLOOR_FRACTION)
      : POWER_COLLAPSE_FLOOR_AMPS;
  const liveCut = state.pendingCut != null && now < state.pendingCut.until ? state.pendingCut : null;
  const cutCredit = pendingCutCredit(state, now);
  if (
    collapse == null &&
    baseline != null &&
    baseline - measured >= POWER_COLLAPSE_DROP_AMPS &&
    // Not right after a recovery event in this same ingest — a recovery reading
    // by definition sits near the pre-collapse median, so this cannot co-fire.
    !events.some((e) => e.kind === "collapse_recovered")
  ) {
    // A shed we sent removes exactly this shape from the meter (drop past the
    // floor, arriving as one cliff once the compressor finally stops). Only the
    // part of the fall our own commands do NOT explain is evidence of a trip —
    // an unexplained remainder still latches, so a genuine breaker going while
    // a small cut is in flight is not laundered.
    //
    // With a cut in flight the fall is judged from the ANCHOR (the meter when
    // we started cutting), not from this reading's step: median smoothing
    // spreads one cliff across several readings, and judging each step on its
    // own let the tail latch what the head had already explained (the raw
    // 4.3A floor arrives instantly while the median is still draining 16 → 13
    // → 9). Anchor-relative, the whole cliff is one comparison.
    const unexplained =
      liveCut != null ? liveCut.anchorAmps - measured - liveCut.amps : baseline - measured;
    if (unexplained < POWER_COLLAPSE_DROP_AMPS) {
      events.push({
        kind: "collapse_suppressed",
        fromAmps: baseline,
        toAmps: measured,
        // The RAW unabsorbed credit, not pendingCutCredit(): the outrun void
        // (invariant 38) zeroes the spendable figure while the meter rides
        // above the anchor, but suppression fired on the raw fields — a
        // journal row saying "suppressed, credit 0A" would send the next
        // forensic session down a hole.
        creditAmps: liveCut != null ? Math.max(0, liveCut.amps - liveCut.absorbedAmps) : cutCredit,
        source,
      });
      // Ours — nothing left to watch for.
      cliffAnchor = null;
    } else if (measured <= collapseFloor) {
      collapse = { preMedianAmps: baseline, until: now + POWER_COLLAPSE_MAX_MS };
      events.push({ kind: "collapse", fromAmps: baseline, toAmps: measured, source });
      cliffAnchor = null;
    } else {
      // A big fall nobody commanded, but the line is still carrying real load:
      // not provably a trip, so no latch, no derate, no freeze. It is equally
      // not headroom — so calm stands down, and the pre-fall mean is held as
      // the baseline in case the fall is still arriving.
      calmHoldUntil = Math.max(calmHoldUntil, now + UNEXPLAINED_FALL_CALM_HOLD_MS);
      cliffAnchor = cliffAnchor ?? { medianAmps: baseline, at: now };
      events.push({
        kind: "unexplained_fall",
        fromAmps: baseline,
        toAmps: measured,
        unexplainedAmps: unexplained,
        source,
      });
    }
  }
  if (cliffAnchor != null && now >= cliffAnchor.at + CLIFF_ANCHOR_MS) cliffAnchor = null;

  // Walk the effective limit down on every collapse: the line just PROVED it
  // cannot hold what it was carrying, and a repeat trip inside the window
  // proves the derate was still not enough (live 15.65A → 14.48A → 13.99A).
  // Stacking is capped so a cascade cannot starve the house to nothing.
  // `standing` is the DECAYED rung, so a trip part-way up the recovery ladder
  // escalates from where the line actually was rather than from full rating.
  let derate = state.derate;
  if (collapse != null && state.collapse == null) {
    derate = collapseDerate(state, source, now);
  } else if (derate != null && derateFor(state, derate.source, now) <= 0) {
    // Fully recovered — drop the record (judged on ITS line, so a gen derate
    // still retires while the house is on grid).
    derate = null;
  }

  // Classify this reading against the derated limit, so the leaky bucket and
  // the reducer can never disagree about what "over" means.
  const limit = effectiveLimit(config, source, totalDerateFor({ ...state, derate }, source, now));

  // GENERATOR STRAIN (2026-08-04). A gap in the reading stream that ENDS here,
  // with the pre-gap mean sitting within an amp and a half of the ceiling, is
  // the generator browning out under a load we chose. It is the only evidence
  // this house produces that a 46 °C genset holds less than its plate rating —
  // there is no voltage channel — and the answer is to back away from the edge,
  // never to latch anything: a strain derate freezes no restore and latches no
  // collapse, it just lowers the ceiling the ordinary ladder already respects.
  //
  // Gaps on grid do nothing (the grid does not brown out under our AC load),
  // and a gap at a quiet house is a Wi-Fi flake, which is most of them.
  let strainDerate = state.strainDerate;
  let strainEvents = state.strainEvents.filter((at) => now - at < STRAIN_WINDOW_MS);
  const preGapAmps = smoothedAmps(state);
  if (
    gapped &&
    source === "gen" &&
    prev.source === "gen" &&
    state.recent.length > 0 &&
    limit - preGapAmps <= STRAIN_NEAR_LIMIT_AMPS
  ) {
    strainEvents = [...strainEvents, now].slice(-STRAIN_EVENTS_TO_DERATE * 4);
    if (strainEvents.length >= STRAIN_EVENTS_TO_DERATE) {
      const standing = strainDerateFor(state, source, now);
      const amps = Math.min(STRAIN_DERATE_MAX_AMPS, standing + STRAIN_DERATE_AMPS);
      // Already at the cap and still standing: re-arming would be a no-op that
      // refreshes the rung forever. Let the existing one age.
      if (amps > standing || now >= (strainDerate?.until ?? 0)) {
        strainDerate = { source, amps, until: now + STRAIN_DERATE_MS };
        // The clock restarts: the next pair is a fresh pattern, not this one.
        strainEvents = [];
        events.push({ kind: "strain_derate", amps, source, gapMs, preGapAmps });
      }
    }
  } else if (strainDerate != null && strainDerateFor(state, strainDerate.source, now) <= 0) {
    strainDerate = null;
  }

  const recent = [...state.recent, measured].slice(-RECENT_RING);

  // Readings the flicker estimator may look at. A discontinuity — an ESP gap, a
  // trip, a recovery — contributes a jump that is not supply noise, and letting
  // one into the estimate pinned it at its cap for the following ~8 readings.
  // That window is the LAST place tolerance belongs: the breaker has just
  // proved it cannot hold what it was carrying, and the limit is derated for it.
  const discontinuity =
    gapped || (collapse != null && state.collapse == null) || events.some((e) => e.kind === "collapse_recovered");
  const flickerSamples = discontinuity ? 1 : Math.min(RECENT_RING, state.flickerSamples + 1);

  // Spend the cut credit as the meter actually falls. One-way ratchet on the
  // DEEPEST fall below the anchor: a peer turning on afterwards lifts the house
  // again, but it cannot un-prove that the cut arrived. Absorption is read on
  // the SMOOTHED meter — the yardstick every other limit decision uses — so a
  // credit retires only once the smoothing window has digested the cut, not on
  // the first raw reading of it. Dropped once fully absorbed or expired, so a
  // stale credit never blinds the next episode.
  let pendingCut = state.pendingCut;
  // …and whether it absorbed MORE on this reading than on any before it: the
  // difference between a cut that is landing and one that landed a little and
  // then stopped. `absorbedAmps` is a level, so it cannot answer that on its
  // own, and the sustained clock below needs the rate, not the level.
  let cutFellThisReading = false;
  if (pendingCut != null) {
    if (now >= pendingCut.until) {
      pendingCut = null;
    } else {
      const absorbedAmps = Math.max(pendingCut.absorbedAmps, pendingCut.anchorAmps - smoothedAmps(state));
      cutFellThisReading = absorbedAmps > pendingCut.absorbedAmps;
      pendingCut = absorbedAmps >= pendingCut.amps ? null : { ...pendingCut, absorbedAmps };
    }
  }

  let overLimitBudget = state.overLimitBudget;
  let overLimitReadings = state.overLimitReadings;
  let calmSince = state.calmSince;

  // The bucket and calm are now judged on DIFFERENT yardsticks, deliberately:
  // the bucket still triggers on any raw reading over the limit (a real breach
  // must not wait for the median), while calm — the thing that decides whether
  // the episode is over — follows the smoothed mean. Live 2026-08-02 they were
  // the same yardstick and the generator's ~±1A flicker made the bucket a
  // one-way ratchet: every spike drained it and broke the calm that refills it,
  // so a house whose MEAN sat 0.3A under the limit still got a room shed.
  const flicker = flickerOfRing(flickerWindowOf(recent, flickerSamples));
  const smoothed = median(recent.slice(-SMOOTH_WINDOW));
  const smoothedOver = smoothed - limit;
  // How long the MEAN has been over the limit without a break. Magnitude cannot
  // classify a slow kill — 15.9A on a 15A gen is "mild" forever, and the level
  // cuts mild allows wind down over minutes the breaker does not have. A frozen
  // or collapsed meter is not evidence of anything, so the clock stops there.
  //
  // …and neither is a ride we are already visibly ending. The clock promotes on
  // TIME alone (45s ⇒ severe, 120s ⇒ extreme), and it kept accruing straight
  // through a cut that was landing: live 2026-08-04 12:56:26 a fan trim plus a
  // shed went out at a 16.565A anchor, thirteen seconds later the meter read
  // 14.24A — 2.3A of the 2.9 commanded already gone — and a clock that had been
  // running since ~12:53 handed the next pass a "severe" that shed a SECOND
  // room. So while a cut is landing the clock rebases (it restarts from this
  // reading; it does not freeze).
  //
  // ⚠ BOTH conditions are load-bearing, and the second is what keeps this from
  // becoming a licence. `arriving` is a LEVEL test (35% of the commanded amps
  // are gone), so a cut that delivered its third and then went flat would
  // satisfy it for the whole of PENDING_CUT_MS — three minutes of a mild ride
  // that could never promote, on a breaker whose thermal budget is two to four.
  // Requiring the meter to have fallen FURTHER on this very reading makes the
  // rebase a statement about the present: the clock resumes the moment the fall
  // stops, which is exactly invariant 33's case.
  const cutTrend = cutTrendOf({ ...liveCutFigures(pendingCut, now), smoothedAmps: smoothed });
  const cutIsLanding = cutTrend === "arriving" && cutFellThisReading;
  const smoothedOverSince =
    frozen || collapse != null || cutIsLanding
      ? null
      : smoothedOver > 0
        ? (state.smoothedOverSince ?? now)
        : null;

  if (measured > limit) {
    // The raw overshoot is discounted by the live flicker before it is
    // classified: on a generator a single reading a full amp high, against a
    // mean that is UNDER the limit, is supply wobble, not load. What the
    // discount can never hide is the mean itself — once the SMOOTHED meter is
    // over, its overshoot classifies the drain directly and undiscounted, so a
    // genuine overload drains exactly as fast as it did before.
    const effOver = Math.max(measured - limit - flicker, smoothedOver);
    const drain =
      effOver > OVER_LIMIT_SEVERE_AMPS
        ? OVER_LIMIT_DRAIN_SEVERE
        : effOver > OVER_LIMIT_MODERATE_AMPS
          ? OVER_LIMIT_DRAIN_MODERATE
          : OVER_LIMIT_DRAIN_MILD;
    overLimitBudget = Math.max(0, overLimitBudget - drain);
    overLimitReadings = [...overLimitReadings, measured].slice(-RECENT_RING);
    if (overLimitBudget <= 0) {
      // Re-fires on every over-limit reading while empty (a failed act retries);
      // the controller shell coalesces urgent evaluations.
      // The raw path keeps its own discount (`isSevereOverReading`) rather than
      // a mean-is-over gate: a genuine step-up must still be able to classify
      // severe before the 8-wide median has caught up with it, which is the
      // whole reason the bucket reads raw readings at all.
      const severe =
        smoothedOver > OVER_LIMIT_SEVERE_AMPS ||
        overLimitReadings.some((r) => isSevereOverReading(r, limit, flicker));
      events.push({ kind: "bucket_empty", severity: severe ? "severe" : "mild" });
    }
  }

  // A raw reading over the limit by MORE than the flicker is not supply noise,
  // and calm must break on it immediately — waiting for the median would let
  // calm keep accruing (and REFILL the bucket this very reading just drained)
  // for the two readings a genuine step-up takes to reach the smoothed meter.
  // The estimator is what separates the two cases: a load step is one jump and
  // reads as low flicker, so it breaks calm; supply wobble spikes and returns,
  // reads as high flicker, and does not.
  const rawIsSupplyNoise = measured <= limit + flicker;

  if (collapse != null || frozen || now < calmHoldUntil) {
    // Probable trip in progress — a low reading here is lost AC load, not
    // headroom. A FROZEN value is equally not evidence of headroom: calm built
    // on repeats of a stale number must never admit a raise. (This also covers
    // the freshly-latched collapse the old code guarded separately.) And an
    // unexplained fall stands calm down for its hold: the trough after a break
    // looks exactly like the trough after a room was switched off, and we do
    // not get to spend either one until we know which it was.
    calmSince = null;
  } else if (smoothed <= limit - config.marginAmps && rawIsSupplyNoise) {
    // The mean now has real headroom under it, so whatever the banked readings
    // recorded is over. Drop them IMMEDIATELY — they are what sizes the deficit
    // and sets the severity tier, and a stale set describes a house that no
    // longer exists (live 2026-08-02: a room shed for a 0.5A "deficit" derived
    // from readings 100s old, at a smoothed 6.5A against a 15A limit).
    //
    // The BUCKET deliberately still waits out CALM_REFILL_MS: that is the
    // balanced-oscillation guard (a house cycling across the limit must not
    // refill as fast as it drains). Clearing the readings without refilling
    // leaves the controller armed — the next genuine over-limit reading acts at
    // once, sized from evidence about the present.
    overLimitReadings = [];
    calmSince = calmSince ?? now;
    if (now - calmSince >= CALM_REFILL_MS) {
      // Sustained calm = the over-limit episode is over. Episode-based refill,
      // NOT per-reading: a balanced oscillation must not refill as fast as it
      // drains (the 31A grid failure mode). That guard is intact — it keys off
      // the smoothed mean, so an oscillation CENTRED on the limit still never
      // refills. What refills now is the case that should always have: a mean
      // with real headroom under it, crossed occasionally by supply noise.
      overLimitBudget = OVER_LIMIT_BUDGET;
      overLimitReadings = [];
    }
  } else {
    // Smoothed mean is in the margin band or over the limit — the deliberate
    // near-limit ride. Bucket holds; calm is broken.
    calmSince = null;
  }

  return {
    state: {
      source,
      lastReadingAt: now,
      recent,
      overLimitBudget,
      overLimitReadings,
      calmSince,
      calmHoldUntil,
      cliffAnchor,
      flickerSamples,
      smoothedOverSince,
      collapse,
      lastRaw,
      lastMicroChangeAt,
      frozen,
      derate,
      strainDerate,
      strainEvents,
      pendingCut,
    },
    events,
  };
}

/** Refill after the controller ACTED on an empty bucket (episode handled). */
/**
 * Points the bucket is refilled to after an over-limit act. Deliberately NOT
 * full: a full refill made the second act wait out another five readings, and
 * on 2026-07-31 those were the 38 seconds between a 0.4A fan trim (all the
 * first act managed) and the level cut that should have come first.
 *
 * But it MUST stay above `OVER_LIMIT_DRAIN_SEVERE`, so that no single reading
 * can empty it. Shipped at 2 for twenty minutes on 2026-07-31 and immediately
 * double-shed: 18:21:10 shed Najat at 15.32A, and 16s later ONE lingering
 * ~16.5A reading — still inside the 4-wide smoothing window from before that
 * shed landed — drained 3 points, emptied the bucket alone, and shed Abdu at a
 * SMOOTHED 12.555A. The `commandedCutCreditAmps` credit could not save it: the
 * meter's fall from 15.32 to 12.5 had already absorbed the whole credit, so the
 * stale reading was priced as a fresh breach. Restored 38s later.
 *
 * At 4 a severe reading still needs a partner (as it did at 5), while a
 * moderate pair or four mild readings act sooner — which is where the live
 * latency actually was.
 */
export const OVER_LIMIT_BUDGET_AFTER_ACT = OVER_LIMIT_DRAIN_SEVERE + 1;

export function refillBucket(state: MeterState, points = OVER_LIMIT_BUDGET): MeterState {
  return { ...state, overLimitBudget: points, overLimitReadings: [] };
}

/** Break calm (e.g. after a command batch: post-command readings are not pre-raise evidence). */
export function resetCalm(state: MeterState): MeterState {
  return { ...state, calmSince: null };
}

/** Derive the pipeline-facing view. `staleMs` is judged by the caller against `now`. */
export function meterView(state: MeterState, now: number): MeterView {
  const stale = state.lastReadingAt === 0 || now - state.lastReadingAt > STALE_POWER_MS;
  return {
    derateAmps: stale ? 0 : totalDerateFor(state, state.source, now),
    source: stale ? "none" : state.source,
    smoothedAmps: smoothedAmps(state),
    latestAmps: state.recent.length > 0 ? state.recent[state.recent.length - 1] : 0,
    sampleCount: Math.min(state.recent.length, SMOOTH_WINDOW),
    calmMs: state.calmSince != null && state.collapse == null ? Math.max(0, now - state.calmSince) : 0,
    smoothedOverMs:
      stale || state.smoothedOverSince == null ? 0 : Math.max(0, now - state.smoothedOverSince),
    overLimitBudget: state.overLimitBudget,
    overLimitReadings: state.overLimitReadings,
    collapsed: state.collapse != null,
    frozen: state.frozen,
    flickerAmps: stale ? 0 : flickerAmps(state),
    commandedCutCreditAmps: pendingCutCredit(state, now),
    ...liveCutFigures(state.pendingCut, now),
  };
}
