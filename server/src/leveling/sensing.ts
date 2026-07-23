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
import { limitFor } from "./config.js";

// ---- Ported v1 constants (values unchanged; provenance: ac-leveling.ts) ----

/** Leaky-bucket capacity in points; empty (≤0) = act. */
export const OVER_LIMIT_BUDGET = 5;
/** Points drained by a reading more than OVER_LIMIT_SEVERE_AMPS over the limit. */
export const OVER_LIMIT_DRAIN_SEVERE = 3;
/** Points drained by a reading within OVER_LIMIT_SEVERE_AMPS over the limit. */
export const OVER_LIMIT_DRAIN_MILD = 1;
/** Amps above the raw limit that classify a reading as severely over. */
export const OVER_LIMIT_SEVERE_AMPS = 1;
/** Sudden measured drop ≥ this (vs the prior median) is a candidate trip. */
export const POWER_COLLAPSE_DROP_AMPS = 6;
/** …AND the reading must land at/below this floor (the AC load vanished). */
export const POWER_COLLAPSE_FLOOR_AMPS = 5;
/** Collapse clears when measured recovers to within this of the pre-collapse median. */
export const POWER_COLLAPSE_RECOVER_GAP = 3;
/** Safety cap on a collapse latch (never strand the controller). */
export const POWER_COLLAPSE_MAX_MS = 300_000;
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

export function initialMeterState(): MeterState {
  return {
    source: "none",
    lastReadingAt: 0,
    recent: [],
    overLimitBudget: OVER_LIMIT_BUDGET,
    overLimitReadings: [],
    calmSince: null,
    collapse: null,
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

  if (prev.lastReadingAt > 0 && now - prev.lastReadingAt > ESP_GAP_EVENT_MS) {
    events.push({ kind: "esp_gap", gapMs: now - prev.lastReadingAt });
  }

  const source = determineSource(reading, 0);
  let state: MeterState = { ...prev, lastReadingAt: now };

  if (source !== prev.source) {
    // Episodic state is per-source: bucket, calm, smoothing ring, collapse latch.
    events.push({ kind: "source_changed", from: prev.source, to: source });
    state = {
      source,
      lastReadingAt: now,
      recent: [],
      overLimitBudget: OVER_LIMIT_BUDGET,
      overLimitReadings: [],
      calmSince: null,
      collapse: null,
    };
  }

  if (source === "none") {
    return { state: { ...state, calmSince: null }, events };
  }

  const limit = limitFor(config, source);
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
  if (
    collapse == null &&
    priorMedian != null &&
    priorMedian - measured >= POWER_COLLAPSE_DROP_AMPS &&
    measured <= POWER_COLLAPSE_FLOOR_AMPS &&
    // Not right after a recovery event in this same ingest — a recovery reading
    // by definition sits near the pre-collapse median, so this cannot co-fire.
    !events.some((e) => e.kind === "collapse_recovered")
  ) {
    collapse = { preMedianAmps: priorMedian, until: now + POWER_COLLAPSE_MAX_MS };
    events.push({ kind: "collapse", fromAmps: priorMedian, toAmps: measured, source });
  }

  const recent = [...state.recent, measured].slice(-RECENT_RING);

  let overLimitBudget = state.overLimitBudget;
  let overLimitReadings = state.overLimitReadings;
  let calmSince = state.calmSince;

  if (measured > limit) {
    // Over the limit → drain, magnitude-weighted. Calm is broken.
    calmSince = null;
    const drain =
      measured - limit > OVER_LIMIT_SEVERE_AMPS ? OVER_LIMIT_DRAIN_SEVERE : OVER_LIMIT_DRAIN_MILD;
    overLimitBudget = Math.max(0, overLimitBudget - drain);
    overLimitReadings = [...overLimitReadings, measured].slice(-RECENT_RING);
    if (overLimitBudget <= 0) {
      // Re-fires on every over-limit reading while empty (a failed act retries);
      // the controller shell coalesces urgent evaluations.
      const severe = overLimitReadings.some((r) => r - limit > OVER_LIMIT_SEVERE_AMPS);
      events.push({ kind: "bucket_empty", severity: severe ? "severe" : "mild" });
    }
  } else if (measured <= limit - config.marginAmps) {
    if (collapse != null) {
      // Probable trip in progress — this low reading is lost AC load, not headroom.
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
    state: { source, lastReadingAt: now, recent, overLimitBudget, overLimitReadings, calmSince, collapse },
    events,
  };
}

/** Refill after the controller ACTED on an empty bucket (episode handled). */
export function refillBucket(state: MeterState): MeterState {
  return { ...state, overLimitBudget: OVER_LIMIT_BUDGET, overLimitReadings: [] };
}

/** Break calm (e.g. after a command batch: post-command readings are not pre-raise evidence). */
export function resetCalm(state: MeterState): MeterState {
  return { ...state, calmSince: null };
}

/** Derive the pipeline-facing view. `staleMs` is judged by the caller against `now`. */
export function meterView(state: MeterState, now: number): MeterView {
  const stale = state.lastReadingAt === 0 || now - state.lastReadingAt > STALE_POWER_MS;
  return {
    source: stale ? "none" : state.source,
    smoothedAmps: smoothedAmps(state),
    latestAmps: state.recent.length > 0 ? state.recent[state.recent.length - 1] : 0,
    sampleCount: Math.min(state.recent.length, SMOOTH_WINDOW),
    calmMs: state.calmSince != null && state.collapse == null ? Math.max(0, now - state.calmSince) : 0,
    overLimitBudget: state.overLimitBudget,
    overLimitReadings: state.overLimitReadings,
    collapsed: state.collapse != null,
  };
}
