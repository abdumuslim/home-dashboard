// Raise-side pacing for leveling v2. Reductions are NEVER gated — every gate
// in this file applies only to spending headroom (level raises, shed restores,
// fan-trim restores).
//
// Replaces v1's bounce caps / restoreBlocked / sticky evidence clears with the
// user-approved HYBRID: a retry needs BOTH the evidence condition (the meter
// fits the learned cost — checked by the caller at plan time) AND a capped,
// growing backoff. Early retries are evidence-dominated (30s is nothing); only
// repeated failures grow the timer; the cap (15m) is what kills the v1
// 49m/1h18m user-rescue strands. Reset on success or source change.

import type { PowerSource } from "./types.js";

/** Backoff ladder after consecutive failures of the same kind on one AC. */
export const BACKOFF_LADDER_MS = [30_000, 120_000, 300_000, 900_000] as const;
/** How long after a raise/restore a reduction of the same AC counts as its failure. */
export const ATTEMPT_BLAME_WINDOW_MS = 300_000;
/**
 * Minimum spacing between restore SENDS of one AC while its shadow has not
 * confirmed the ON. Shed now clears on shadow CONFIRM, not on command send
 * (2026-07-27: clearing at send let a 5.8s shadow lag mint a bogus manual-off
 * lock), so an in-flight restore stays a shed candidate for a while — this
 * gate keeps it from being re-sent every batch, and doubles as the
 * confirm-or-resend retry pace for firmware that drops commands (Najat).
 */
export const RESTORE_CONFIRM_WAIT_MS = 60_000;

export type AttemptKind = "raise" | "restore" | "fan_restore";

export interface AcPacing {
  failures: number;
  cooldownUntil: number;
  /** Last attempt of this kind (blame window for bounce attribution). */
  lastAttemptAt: number;
  /**
   * Committed meter (smoothed + ramp debit) when the last restore attempt
   * shipped — the evidence anchor for re-arming a probe after a bounce.
   * 2026-08-02: Najat's probe bounced at a committed 11.9A; from 11:31 the
   * meter sat at 10.8–11.2A but failures > 0 kept the probe off and the
   * learned 4.1A price refused every restore until the user turned her on by
   * hand 17 minutes later. Restore attempts only; cleared on success.
   */
  attemptMeterAmps?: number;
}

export interface PacingState {
  source: PowerSource;
  perAc: Readonly<Record<string, Readonly<Partial<Record<AttemptKind, AcPacing>>>>>;
}

export function initialPacingState(source: PowerSource = "none"): PacingState {
  return { source, perAc: {} };
}

export function backoffDelayMs(failures: number): number {
  const idx = Math.min(Math.max(0, failures - 1), BACKOFF_LADDER_MS.length - 1);
  return BACKOFF_LADDER_MS[idx];
}

function entry(state: PacingState, deviceId: string, kind: AttemptKind): AcPacing {
  return state.perAc[deviceId]?.[kind] ?? { failures: 0, cooldownUntil: 0, lastAttemptAt: 0 };
}

function withEntry(state: PacingState, deviceId: string, kind: AttemptKind, next: AcPacing): PacingState {
  return {
    ...state,
    perAc: { ...state.perAc, [deviceId]: { ...state.perAc[deviceId], [kind]: next } },
  };
}

/** Is this AC allowed to attempt `kind` right now (backoff side of the hybrid)? */
export function canAttempt(state: PacingState, deviceId: string, kind: AttemptKind, now: number): boolean {
  return now >= entry(state, deviceId, kind).cooldownUntil;
}

export function cooldownRemainingMs(state: PacingState, deviceId: string, kind: AttemptKind, now: number): number {
  return Math.max(0, entry(state, deviceId, kind).cooldownUntil - now);
}

/** Record that an attempt shipped (opens the blame window). `meterAmps` is the
 *  committed meter the admission saw — restore attempts pass it (the probe
 *  re-arm anchor), raises don't. */
export function noteAttempt(
  state: PacingState,
  deviceId: string,
  kind: AttemptKind,
  now: number,
  meterAmps?: number,
): PacingState {
  const prev = entry(state, deviceId, kind);
  return withEntry(state, deviceId, kind, {
    ...prev,
    lastAttemptAt: now,
    attemptMeterAmps: meterAmps ?? prev.attemptMeterAmps,
  });
}

/**
 * The attempt failed: the meter went over and the reducer cut/shed this AC
 * within the blame window. Grows the capped backoff.
 */
export function noteFailure(state: PacingState, deviceId: string, kind: AttemptKind, now: number): PacingState {
  const prev = entry(state, deviceId, kind);
  const failures = prev.failures + 1;
  return withEntry(state, deviceId, kind, {
    ...prev, // keeps attemptMeterAmps — the failed attempt's anchor is what probeRearmed reads
    failures,
    cooldownUntil: now + backoffDelayMs(failures),
  });
}

/** The attempt survived (graded stable) — reset the ladder (and the probe's
 *  evidence anchor: a success means the next episode starts fresh). */
export function noteSuccess(state: PacingState, deviceId: string, kind: AttemptKind): PacingState {
  const prev = entry(state, deviceId, kind);
  if (prev.failures === 0 && prev.cooldownUntil === 0) return state;
  return withEntry(state, deviceId, kind, { ...prev, failures: 0, cooldownUntil: 0, attemptMeterAmps: undefined });
}

/** Was `kind` attempted on this AC within the last `withinMs`? */
export function attemptedWithin(
  state: PacingState,
  deviceId: string,
  kind: AttemptKind,
  withinMs: number,
  now: number,
): boolean {
  const at = entry(state, deviceId, kind).lastAttemptAt;
  return at > 0 && now - at <= withinMs;
}

/** Was `kind` attempted on this AC within the blame window? */
export function attemptedRecently(
  state: PacingState,
  deviceId: string,
  kind: AttemptKind,
  now: number,
): boolean {
  return attemptedWithin(state, deviceId, kind, ATTEMPT_BLAME_WINDOW_MS, now);
}

/** A restore of this AC recently failed (feeds the reducer's re-shed penalty). */
export function reshedPenalized(state: PacingState, deviceId: string, now: number): boolean {
  const e = entry(state, deviceId, "restore");
  return e.failures > 0 && now < e.cooldownUntil;
}

/**
 * Consecutive unresolved restore failures for this AC. 0 = no bounce evidence
 * this source-session — the condition for probing a restore at the gentle
 * steady price when the learned on-cost would block it (see restoreCostAmps).
 * Resets on a graded success or a source change (new physics, fair to re-probe).
 */
export function restoreFailures(state: PacingState, deviceId: string): number {
  return entry(state, deviceId, "restore").failures;
}

/**
 * A committed meter this far below the failed attempt's own committed amps is
 * evidence the house materially changed — not noise (smoothed wobble is ±0.3A).
 */
export const PROBE_REARM_DROP_AMPS = 1.0;

/**
 * Evidence re-arm for the restore probe (2026-08-02 strand): after a bounce
 * the probe is off (failures > 0) and the plain learned price governs — but
 * when the meter now sits ≥ PROBE_REARM_DROP_AMPS below the committed amps the
 * failed attempt was admitted at, the physics that bounced it no longer hold.
 * One more probe is justified. The new attempt re-anchors LOWER, so a bounce
 * loop needs the meter to keep falling a full amp per retry — bounded, and
 * each retry still rides the backoff ladder.
 */
export function probeRearmed(state: PacingState, deviceId: string, committedAmps: number): boolean {
  const anchor = entry(state, deviceId, "restore").attemptMeterAmps;
  return anchor != null && committedAmps <= anchor - PROBE_REARM_DROP_AMPS;
}

/** Source change: per-source physics — the ladder resets wholesale. */
export function resetPacing(state: PacingState, source: PowerSource): PacingState {
  return { source, perAc: {} };
}
