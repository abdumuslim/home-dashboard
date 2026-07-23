// Mode machine for leveling v2 — replaces v1's ~15 interacting latches and
// one-shot flags (enforceGenFloors/armGenFloorsOnSourceChange/armRamp*/
// powerCollapse-as-gate/settle bookkeeping/forceEvaluate) with three explicit
// conditions and one derivation. Pure: callers pass `now`.
//
// The conditions are semi-independent in reality (a collapse can hit while
// floors are being enforced), so ModeState stores them separately and
// deriveMode() resolves the priority: COLLAPSED > FLOORS > SETTLING > NORMAL.

import type { MeterEvent, Mode } from "./types.js";

/** Pause after a level/power command batch so compressors and the meter settle. */
export const SETTLE_MS = 30_000;
/** Shorter settle for fan-only batches (fans stabilize in seconds). */
export const FAN_SETTLE_MS = 10_000;
/**
 * Backstop on FLOORS enforcement after entering gen: a truly stuck device must
 * not enforce forever — normal over-limit handling resumes after this.
 */
export const FLOORS_MAX_MS = 300_000;

export interface ModeState {
  /** FLOORS enforcement window (armed on ANY transition into gen, incl. cold start). */
  floors: { since: number; until: number } | null;
  /** Probable trip/blackout — behavioral mirror of the sensing collapse latch. */
  collapsed: boolean;
  /** End of the settle window after the last command batch. */
  settleUntil: number;
}

export function initialModeState(): ModeState {
  return { floors: null, collapsed: false, settleUntil: 0 };
}

export function deriveMode(state: ModeState, now: number): Mode {
  if (state.collapsed) return "COLLAPSED";
  if (state.floors != null && now < state.floors.until) return "FLOORS";
  if (now < state.settleUntil) return "SETTLING";
  return "NORMAL";
}

/** Fold a sensing event into the mode state. */
export function applyMeterEvent(state: ModeState, event: MeterEvent, now: number): ModeState {
  switch (event.kind) {
    case "source_changed": {
      // Per-source episodic reset. Entering gen (from ANYWHERE, including a
      // "none" cold start — the 2026-07-10 fix) arms floors-first: land every
      // ON managed AC on its floor and climb back meter-confirmed, instead of
      // adopting stale high caps that surge past the tiny gen budget.
      const floors = event.to === "gen" ? { since: now, until: now + FLOORS_MAX_MS } : null;
      return { floors, collapsed: false, settleUntil: 0 };
    }
    case "collapse":
      return { ...state, collapsed: true };
    case "collapse_recovered":
      return { ...state, collapsed: false };
    default:
      return state;
  }
}

/** A command batch shipped — open the matching settle window. */
export function noteBatch(state: ModeState, opts: { fanOnly: boolean }, now: number): ModeState {
  const settleUntil = now + (opts.fanOnly ? FAN_SETTLE_MS : SETTLE_MS);
  return { ...state, settleUntil: Math.max(state.settleUntil, settleUntil) };
}

/**
 * FLOORS exit check — call each evaluation while in FLOORS. Clears when every
 * ON managed AC's real shadow is at/below its floor AND no compressor is still
 * ramping (the ~4-min restart window). The `until` backstop in deriveMode
 * covers the truly-stuck-device case.
 */
export function clearFloorsIfDone(
  state: ModeState,
  status: { allConfirmedAtFloor: boolean; anyRamping: boolean },
): ModeState {
  if (state.floors == null) return state;
  if (status.allConfirmedAtFloor && !status.anyRamping) return { ...state, floors: null };
  return state;
}

/** Manual wins (AGENTS rule 7): a user gen-level change ends floor enforcement. */
export function clearFloorsOnManual(state: ModeState): ModeState {
  return state.floors == null ? state : { ...state, floors: null };
}
