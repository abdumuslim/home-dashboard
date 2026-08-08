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
 * A BOUNCE is a restore that is re-shed inside `ATTEMPT_BLAME_WINDOW_MS` — the
 * failure `noteFailure("restore")` books (the caller only reaches it for a
 * recently-attempted AC, so every restore failure IS a bounce by construction).
 * These two numbers govern how the shed-trough BAR's persistence (`barPersistMs`,
 * invariant 54) compounds with each consecutive bounce. Deliberately NOT the
 * admission ladder (`canAttempt`): the bar is the gate that actually holds a
 * bouncing room while its meter sits in the survivors-mid-cycle trough, and
 * leaving `canAttempt` on the ordinary ladder is what keeps invariant 22's probe
 * re-arm working for a GENUINE (bar-released) drop and keeps the reducer's
 * re-shed penalty unmoved (this fix is restore-admission-side only).
 *
 * 2026-08-07 14:08–14:31Z: the strain derate pulled the gen ceiling to 14.0–14.5A
 * under a settled three-room ~14.8–15.6A house; Najat was shed FIVE times in
 * 23 minutes. The journal splits the cycle in two. Each restore→re-shed gap was
 * 52–69 s (14:13:53→14:14:52, 14:17:50→14:18:46, 14:24:12→14:25:04,
 * 14:30:05→14:31:14) — well inside `ATTEMPT_BLAME_WINDOW_MS` and BEFORE the 315 s
 * grade window — so `noteFailure` DID fire each round (the attempt was resolved a
 * failure, never a premature `noteSuccess`) and `failures` climbed 1→4. Each
 * shed→restore gap was ~3–5.5 min, paced by the own-shed-trough bar's 300 s expiry
 * ("own shed trough … 12.4–12.6A, needs 2.3A vs 13.9–14.4A") plus the admission
 * cadence; the bar EXPIRED on the clock and the next admission spent the trough.
 * The ladder still failed to slow the cycle, for a plain reason: its early rungs
 * (`BACKOFF_LADDER_MS` 30/120/300 s for failures 1–3) are all ≤ the 300 s bar, so
 * `canAttempt` was already satisfied when the bar expired and the BAR — not the
 * ladder — was the binding shed→restore clock; `backoffDelayMs` only exceeds the
 * bar at failures=4 (900 s), i.e. after the FOURTH re-shed, the tail of the cycle
 * the user was already reacting to. And each round the trough sat ≥
 * `PROBE_REARM_DROP_AMPS` below the failed attempt's anchor, so `probeRearmed`
 * (invariant 22) re-enabled the gentle probe PRICE — which is what let the restore
 * fit and re-admit at the trough, and governs which price admits, not when.
 * Invariants 39 and 54 both named the missing piece: "a restore re-shed within N
 * minutes must slow the ladder".
 *
 * So the fix compounds the BINDING clock — the bar's persistence, not the ladder —
 * past its 300 s plateau, keyed on a consecutive-bounce COUNT (`AcPacing.bounces`)
 * cleared only by a restore that STICKS (`noteSuccess` after the whole blame
 * window) or a source change: 1→600 s, 2→1200 s, hard-capped at 1800 s (30 min).
 * The cap bounds the strand (invariant 22's spirit — nothing may block unbounded);
 * the two bar release valves (a rising ceiling, a peer leaving — `shedBarFor`) let
 * it out sooner.
 */
export const BOUNCE_BACKOFF_BASE_MS = 300_000;
export const BOUNCE_BACKOFF_MAX_MS = 1_800_000;
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
  /**
   * Consecutive shed BOUNCES of this room's restore (a restore re-shed inside the
   * blame window), kept only on the "restore" entry. Cleared by a restore that
   * STICKS (`noteSuccess`), a source change, or an external ON (`clearBounces` —
   * a human/blink put the room back, so the leveler's restore episode is over and
   * a future unrelated shed must not inherit a compounded trough bar). Booked only
   * for a genuine `power_off` re-shed (the `isShed` gate in `noteFailure`), not a
   * bare level cut of a recently restored room — so it can diverge from the
   * restore entry's `failures`, which counts both. Named separately to keep the
   * bar-persistence coupling (`barPersistMs`) and the restore-scoping explicit: a
   * raise failure never books a bounce.
   */
  bounces: number;
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

/**
 * The shed-trough bar's persistence after `bounces` consecutive bounces — the
 * ~5-min plateau doubled per bounce, hard-capped: 1→600 s, 2→1200 s, 3+→1800 s.
 * Only meaningful for `bounces >= 1` (the count is incremented before this is read).
 */
export function bounceBackoffMs(bounces: number): number {
  return Math.min(BOUNCE_BACKOFF_BASE_MS * 2 ** Math.max(0, bounces), BOUNCE_BACKOFF_MAX_MS);
}

function entry(state: PacingState, deviceId: string, kind: AttemptKind): AcPacing {
  return state.perAc[deviceId]?.[kind] ?? { failures: 0, bounces: 0, cooldownUntil: 0, lastAttemptAt: 0 };
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
 *
 * For a RESTORE this failure IS a bounce (the caller only reaches here for a
 * recently-attempted AC): count it and let the wait COMPOUND past the ladder's
 * ~5-min plateau (`bounceBackoffMs`), because the plateau is exactly the
 * 2026-08-07 cycle period. The compounded wait outranks the ordinary ladder by
 * `max`, so a raise's ladder is untouched and a restore never waits LESS than it
 * would have.
 */
export function noteFailure(
  state: PacingState,
  deviceId: string,
  kind: AttemptKind,
  now: number,
  /** Whether this failure is a genuine `power_off` re-shed (vs a mere level cut
   *  of a recently restored room). Only a real shed books a BOUNCE. */
  isShed = true,
): PacingState {
  const prev = entry(state, deviceId, kind);
  const failures = prev.failures + 1;
  // A restore failure counts as a BOUNCE only when the reducer actually switched
  // the room OFF — a mere `set_level` cut of a recently restored room is a
  // failure for the ladder but not a shed bounce, and must not compound the
  // trough bar (its count would decouple from real re-sheds). The bounce count
  // does NOT touch the admission cooldown (`canAttempt` stays on the ordinary
  // ladder, so invariant 22's re-arm and the reducer's re-shed penalty are
  // unmoved); it COMPOUNDS the shed-trough bar's persistence instead
  // (`barPersistMs`), which is the gate that actually holds a bouncing room
  // during its own trough (invariant 54). A genuine drop — a peer left, the
  // ceiling rose — releases the bar and the ordinary ladder lets the room back;
  // only the survivors-mid-cycle trough is held for the compounded window.
  const bounces = kind === "restore" && isShed ? prev.bounces + 1 : prev.bounces;
  return withEntry(state, deviceId, kind, {
    ...prev, // keeps attemptMeterAmps — the failed attempt's anchor is what probeRearmed reads
    failures,
    bounces,
    cooldownUntil: now + backoffDelayMs(failures),
  });
}

/**
 * An external ON of this room ends the leveler's restore episode for it — a
 * human/automation/blink put it back — so the consecutive-bounce count must not
 * outlive the episode and hand a future unrelated shed a compounded (up to
 * 30-min) trough bar (2026-08-07). Clears ONLY the restore bounce count; the
 * ladder cooldown/anchor expire on their own.
 *
 * ⚠ Called at the external-ON stamp points, NEVER on our own `restore_confirmed`:
 * our restore confirms on the shadow within seconds, but the bounce books ~60 s
 * LATER at the re-shed — clearing on our own confirm would cap the count at 1 and
 * kill the compounding.
 */
export function clearBounces(state: PacingState, deviceId: string): PacingState {
  const prev = entry(state, deviceId, "restore");
  if (prev.bounces === 0) return state;
  return withEntry(state, deviceId, "restore", { ...prev, bounces: 0 });
}

/** The attempt survived (graded stable) — reset the ladder, the bounce count
 *  (a restore that STICKS is the reset condition) and the probe's evidence
 *  anchor (a success means the next episode starts fresh). */
export function noteSuccess(state: PacingState, deviceId: string, kind: AttemptKind): PacingState {
  const prev = entry(state, deviceId, kind);
  if (prev.failures === 0 && prev.bounces === 0 && prev.cooldownUntil === 0) return state;
  return withEntry(state, deviceId, kind, {
    ...prev,
    failures: 0,
    bounces: 0,
    cooldownUntil: 0,
    attemptMeterAmps: undefined,
  });
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
 * Consecutive RESTORE bounces for this AC (see `AcPacing.bounces`). 0 = no
 * bounce evidence this source-session; feeds the LOUD "bounce backoff" journal
 * and the shed-trough bar's compounded persistence.
 */
export function restoreBounces(state: PacingState, deviceId: string): number {
  return entry(state, deviceId, "restore").bounces;
}

/**
 * How long this AC's own-shed-trough bar (invariant 54) may persist. Normally the
 * blame window; while consecutive bounces stand it outlives its clock for the
 * room's current compounded backoff, so the informative "own shed trough" refusal
 * keeps holding the trough instead of expiring into a re-admission. Bounded by
 * `bounceBackoffMs`'s own cap — nothing blocks unbounded (invariant 22's spirit),
 * and the two bar release valves let a genuinely-shrunk house out sooner.
 */
export function barPersistMs(state: PacingState, deviceId: string): number {
  const bounces = entry(state, deviceId, "restore").bounces;
  return bounces >= 1 ? Math.max(ATTEMPT_BLAME_WINDOW_MS, bounceBackoffMs(bounces)) : ATTEMPT_BLAME_WINDOW_MS;
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
