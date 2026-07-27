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

/** Record that an attempt shipped (opens the blame window). */
export function noteAttempt(state: PacingState, deviceId: string, kind: AttemptKind, now: number): PacingState {
  return withEntry(state, deviceId, kind, { ...entry(state, deviceId, kind), lastAttemptAt: now });
}

/**
 * The attempt failed: the meter went over and the reducer cut/shed this AC
 * within the blame window. Grows the capped backoff.
 */
export function noteFailure(state: PacingState, deviceId: string, kind: AttemptKind, now: number): PacingState {
  const prev = entry(state, deviceId, kind);
  const failures = prev.failures + 1;
  return withEntry(state, deviceId, kind, {
    failures,
    cooldownUntil: now + backoffDelayMs(failures),
    lastAttemptAt: prev.lastAttemptAt,
  });
}

/** The attempt survived (graded stable) — reset the ladder. */
export function noteSuccess(state: PacingState, deviceId: string, kind: AttemptKind): PacingState {
  const prev = entry(state, deviceId, kind);
  if (prev.failures === 0 && prev.cooldownUntil === 0) return state;
  return withEntry(state, deviceId, kind, { ...prev, failures: 0, cooldownUntil: 0 });
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

/** Source change: per-source physics — the ladder resets wholesale. */
export function resetPacing(state: PacingState, source: PowerSource): PacingState {
  return { source, perAc: {} };
}
