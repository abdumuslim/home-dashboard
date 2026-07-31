// Pure meter-sensing reducer for leveling v2. Ports the proven v1 mechanisms
// verbatim where they worked: the over-limit leaky bucket (integral-style trip
// that tolerates near-limit noise), the power-collapse latch (probable breaker
// trip / blackout detection), and source detection. Replaces v1's count-based
// headroom streaks with time-based calm (the ESP cadence varies ~2.7–5s, so
// reading counts never meant a fixed duration).
//
// No I/O, no Date.now() — the caller passes `now`. Every ingest returns a new
// MeterState (immutable) plus the events it produced.

import type { CollapseLatch, MeterEvent, MeterState, MeterView, PowerSource } from "./types.js";
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
/** Smoothing window (median) size. */
const SMOOTH_WINDOW = 4;
/** Bounded ring of recent measured readings (trend + collapse baseline). */
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

export function initialMeterState(): MeterState {
  return {
    source: "none",
    lastReadingAt: 0,
    recent: [],
    overLimitBudget: OVER_LIMIT_BUDGET,
    overLimitReadings: [],
    calmSince: null,
    collapse: null,
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

/** Amps of commanded cut the meter has not shown yet (0 when none/expired). */
export function pendingCutCredit(state: MeterState, now: number): number {
  const cut = state.pendingCut;
  if (cut == null || now >= cut.until) return 0;
  return Math.max(0, cut.amps - cut.absorbedAmps);
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

/** Median of the newest `SMOOTH_WINDOW` readings. */
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
  if (gapped) {
    events.push({ kind: "esp_gap", gapMs: now - prev.lastReadingAt });
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
      collapse: null,
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
  if (collapse != null) {
    if (measured >= collapse.preMedianAmps - POWER_COLLAPSE_RECOVER_GAP) {
      collapse = null;
      events.push({ kind: "collapse_recovered", source });
    } else if (now >= collapse.until) {
      collapse = null;
    }
  }
  const priorMedian = state.recent.length >= SMOOTH_WINDOW ? smoothedAmps(state) : null;
  const liveCut = state.pendingCut != null && now < state.pendingCut.until ? state.pendingCut : null;
  const cutCredit = pendingCutCredit(state, now);
  if (
    collapse == null &&
    priorMedian != null &&
    priorMedian - measured >= POWER_COLLAPSE_DROP_AMPS &&
    measured <= POWER_COLLAPSE_FLOOR_AMPS &&
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
      liveCut != null ? liveCut.anchorAmps - measured - liveCut.amps : priorMedian - measured;
    if (unexplained >= POWER_COLLAPSE_DROP_AMPS) {
      collapse = { preMedianAmps: priorMedian, until: now + POWER_COLLAPSE_MAX_MS };
      events.push({ kind: "collapse", fromAmps: priorMedian, toAmps: measured, source });
    } else {
      events.push({
        kind: "collapse_suppressed",
        fromAmps: priorMedian,
        toAmps: measured,
        creditAmps: cutCredit,
        source,
      });
    }
  }

  // Walk the effective limit down on every collapse: the line just PROVED it
  // cannot hold what it was carrying, and a repeat trip inside the window
  // proves the derate was still not enough (live 15.65A → 14.48A → 13.99A).
  // Stacking is capped so a cascade cannot starve the house to nothing.
  // `standing` is the DECAYED rung, so a trip part-way up the recovery ladder
  // escalates from where the line actually was rather than from full rating.
  let derate = state.derate;
  if (collapse != null && state.collapse == null) {
    const standing = derateFor(state, source, now);
    derate = {
      source,
      amps: Math.min(COLLAPSE_DERATE_MAX_AMPS, standing + COLLAPSE_DERATE_AMPS),
      until: now + COLLAPSE_DERATE_MS,
    };
  } else if (derate != null && derateFor(state, derate.source, now) <= 0) {
    // Fully recovered — drop the record (judged on ITS line, so a gen derate
    // still retires while the house is on grid).
    derate = null;
  }
  // Classify this reading against the derated limit, so the leaky bucket and
  // the reducer can never disagree about what "over" means.
  const limit = effectiveLimit(config, source, derateFor({ ...state, derate }, source, now));

  const recent = [...state.recent, measured].slice(-RECENT_RING);

  // Spend the cut credit as the meter actually falls. One-way ratchet on the
  // DEEPEST fall below the anchor: a peer turning on afterwards lifts the house
  // again, but it cannot un-prove that the cut arrived. Absorption is read on
  // the SMOOTHED meter — the yardstick every other limit decision uses — so a
  // credit retires only once the smoothing window has digested the cut, not on
  // the first raw reading of it. Dropped once fully absorbed or expired, so a
  // stale credit never blinds the next episode.
  let pendingCut = state.pendingCut;
  if (pendingCut != null) {
    if (now >= pendingCut.until) {
      pendingCut = null;
    } else {
      const absorbedAmps = Math.max(pendingCut.absorbedAmps, pendingCut.anchorAmps - smoothedAmps(state));
      pendingCut = absorbedAmps >= pendingCut.amps ? null : { ...pendingCut, absorbedAmps };
    }
  }

  let overLimitBudget = state.overLimitBudget;
  let overLimitReadings = state.overLimitReadings;
  let calmSince = state.calmSince;

  // Defensive: a freshly-latched collapse means this reading is lost AC load,
  // never headroom — kill calm here regardless of which measured-branch runs
  // below. Today a ≤ POWER_COLLAPSE_FLOOR_AMPS collapse reading always lands in
  // the ≤ limit−margin branch (which already nulls it), so this only guards a
  // future floor/limit retune; the suspected stale-calm-after-recovery window
  // was NOT reproducible.
  if (collapse != null && state.collapse == null) calmSince = null;

  if (measured > limit) {
    // Over the limit → drain, magnitude-weighted. Calm is broken.
    calmSince = null;
    const over = measured - limit;
    const drain =
      over > OVER_LIMIT_SEVERE_AMPS
        ? OVER_LIMIT_DRAIN_SEVERE
        : over > OVER_LIMIT_MODERATE_AMPS
          ? OVER_LIMIT_DRAIN_MODERATE
          : OVER_LIMIT_DRAIN_MILD;
    overLimitBudget = Math.max(0, overLimitBudget - drain);
    overLimitReadings = [...overLimitReadings, measured].slice(-RECENT_RING);
    if (overLimitBudget <= 0) {
      // Re-fires on every over-limit reading while empty (a failed act retries);
      // the controller shell coalesces urgent evaluations.
      const severe = overLimitReadings.some((r) => r - limit > OVER_LIMIT_SEVERE_AMPS);
      events.push({ kind: "bucket_empty", severity: severe ? "severe" : "mild" });
    }
  } else if (measured <= limit - config.marginAmps) {
    if (collapse != null || frozen) {
      // Probable trip in progress — this low reading is lost AC load, not
      // headroom. A FROZEN value is equally not evidence of headroom: calm
      // built on repeats of a stale number must never admit a raise.
      calmSince = null;
    } else {
      calmSince = calmSince ?? now;
      if (now - calmSince >= CALM_REFILL_MS) {
        // Sustained calm = the over-limit episode is over. Episode-based refill,
        // NOT per-reading: a balanced oscillation must not refill as fast as it
        // drains (the 31A grid failure mode).
        overLimitBudget = OVER_LIMIT_BUDGET;
        overLimitReadings = [];
      }
    }
  } else {
    // Margin band (limit − margin, limit]: the deliberate near-limit ride —
    // neither genuine headroom nor over. Bucket holds; calm is broken.
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
      collapse,
      lastRaw,
      lastMicroChangeAt,
      frozen,
      derate,
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
    derateAmps: stale ? 0 : derateFor(state, state.source, now),
    source: stale ? "none" : state.source,
    smoothedAmps: smoothedAmps(state),
    latestAmps: state.recent.length > 0 ? state.recent[state.recent.length - 1] : 0,
    sampleCount: Math.min(state.recent.length, SMOOTH_WINDOW),
    calmMs: state.calmSince != null && state.collapse == null ? Math.max(0, now - state.calmSince) : 0,
    overLimitBudget: state.overLimitBudget,
    overLimitReadings: state.overLimitReadings,
    collapsed: state.collapse != null,
    frozen: state.frozen,
    commandedCutCreditAmps: pendingCutCredit(state, now),
  };
}
