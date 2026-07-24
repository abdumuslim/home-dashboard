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
/** Backstop on GRID_FULL enforcement after entering grid (mirror of FLOORS). */
export const GRID_FULL_MAX_MS = 300_000;

export interface ModeState {
  /** FLOORS enforcement window (armed on ANY transition into gen, incl. cold start). */
  floors: { since: number; until: number } | null;
  /**
   * GRID_FULL enforcement window (armed on ANY transition into grid): drive
   * every ON managed AC to its ceiling and restore sheds — "on grid, start all
   * to full, then drop when needed" (user 2026-07-23). Mutually exclusive with
   * floors by construction (source_changed sets one and nulls the other).
   */
  gridFull: { since: number; until: number } | null;
  /** Probable trip/blackout — behavioral mirror of the sensing collapse latch. */
  collapsed: boolean;
  /** End of the settle window after the last command batch. */
  settleUntil: number;
}

export function initialModeState(): ModeState {
  return { floors: null, gridFull: null, collapsed: false, settleUntil: 0 };
}

export function deriveMode(state: ModeState, now: number): Mode {
  if (state.collapsed) return "COLLAPSED";
  if (state.floors != null && now < state.floors.until) return "FLOORS";
  if (state.gridFull != null && now < state.gridFull.until) return "GRID_FULL";
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
      // Entering grid arms the symmetric full-start.
      const floors = event.to === "gen" ? { since: now, until: now + FLOORS_MAX_MS } : null;
      const gridFull = event.to === "grid" ? { since: now, until: now + GRID_FULL_MAX_MS } : null;
      return { floors, gridFull, collapsed: false, settleUntil: 0 };
    }
    case "collapse":
      return { ...state, collapsed: true };
    case "collapse_recovered":
      return { ...state, collapsed: false };
    case "bucket_empty":
      // The meter objected during the grid full-start: the reducer's judgment
      // beats the entry policy — stop re-asserting ceilings it is cutting.
      // (FLOORS deliberately stays: floors ARE the safe direction under load.)
      return state.gridFull != null ? { ...state, gridFull: null } : state;
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

/**
 * GRID_FULL exit check — call each evaluation while in GRID_FULL. Clears when
 * every ON managed AC's real shadow confirmed its ceiling and no shed AC still
 * awaits its restore. The `until` backstop covers stuck devices/cloud.
 */
export function clearGridFullIfDone(
  state: ModeState,
  status: { allConfirmedAtCeil: boolean; anyShedPending: boolean },
): ModeState {
  if (state.gridFull == null) return state;
  if (status.allConfirmedAtCeil && !status.anyShedPending) return { ...state, gridFull: null };
  return state;
}

/** Manual wins (AGENTS rule 7): a user gen-level change ends entry-window enforcement. */
export function clearFloorsOnManual(state: ModeState): ModeState {
  if (state.floors == null && state.gridFull == null) return state;
  return { ...state, floors: null, gridFull: null };
}
