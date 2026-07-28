// Reconciler for leveling v2 — ported from v1's confirmation-gated drift
// detection and unreachable-level machinery (the firmware-reality layer that
// took a month of live incidents to get right; port, don't reinvent):
//
//  - confirmedLevel: what the shadow has actually been OBSERVED at (the drift
//    baseline — never the command; a command in flight doesn't change the
//    observation, so a lagging/ignored write can't mint a false manual intent).
//  - pendingLevel + per-level send counts: unconfirmed sends of the SAME level
//    accumulate; at UNREACHABLE_LEVEL_SENDS the level is marked unreachable and
//    the caller falls back one level. L1 is never marked. Any confirm clears
//    the device's counts. Marks expire after 60 min (re-probe) and survive
//    power cycles and source changes (firmware property, not budget artifact).
//  - Observed level 0 is NEVER a manual intent (firmware reset signature).
//  - While a power collapse is latched, observations re-adopt silently (a dead
//    device's stuck shadow is not user intent) but pending is KEPT so our own
//    late-landing command still confirms without minting an intent.
//  - Fan confirm-or-resend (bounded) for the fan-trim holds.

import type { PowerSource } from "./types.js";

export const UNREACHABLE_LEVEL_SENDS = 4;
export const UNREACHABLE_SAFETY_EXPIRY_MS = 60 * 60_000;
/** Minimum spacing between re-sends of the same unconfirmed level. */
export const LEVEL_RESEND_SPACING_MS = 30_000;
/**
 * How long an unconfirmed send keeps counting as "the firmware might be here"
 * for envelope pricing. Must comfortably exceed the worst observed confirm lag:
 * Najat's documented range is 5.8s–13min, and 2026-07-28 measured ≥15.8min (an
 * L3 sent 15:39:49 was still unconfirmed at 15:55:36). Below that, the TTL
 * would expire the very pending the envelope exists to charge for; above it,
 * a permanently-unconfirmed send would inflate the envelope forever.
 */
export const UNCONFIRMED_SEND_TTL_MS = 25 * 60_000;
export const FAN_RESEND_MAX = 2;
export const FAN_RESEND_SPACING_MS = 15_000;

export interface ReconDevice {
  confirmedLevel: number | null;
  pendingLevel: number | null;
  /** Unconfirmed sends per level (flutter between two targets can't evade). */
  sendCounts: Readonly<Record<number, number>>;
  /**
   * When each unconfirmed level was last sent (parallel to `sendCounts`, same
   * lifetime). Envelope pricing needs per-level timestamps: `lastLevelSentAt`
   * only remembers the most recent send, and a demote sent after a raise must
   * not make the raise's level look fresh — or expire it early.
   */
  sentAt: Readonly<Record<number, number>>;
  /** Firmware-unreachable marks: level → markedAt. */
  unreachable: Readonly<Record<number, number>>;
  lastLevelSentAt: number;
  lastLevelSent: number | null;
  /** Fan confirm-or-resend bookkeeping (fan-trim holds only). */
  pendingFan: number | null;
  fanResends: number;
  lastFanSentAt: number;
}

export type ReconcilerState = Readonly<Record<string, ReconDevice>>;

const EMPTY: ReconDevice = {
  confirmedLevel: null,
  pendingLevel: null,
  sendCounts: {},
  sentAt: {},
  unreachable: {},
  lastLevelSentAt: 0,
  lastLevelSent: null,
  pendingFan: null,
  fanResends: 0,
  lastFanSentAt: 0,
};

function dev(state: ReconcilerState, id: string): ReconDevice {
  return state[id] ?? EMPTY;
}

function put(state: ReconcilerState, id: string, next: ReconDevice): ReconcilerState {
  return { ...state, [id]: next };
}

export type LevelObservation =
  | { kind: "none" }
  | { kind: "adopted" }
  | { kind: "landed"; level: number; unmarked: boolean }
  | { kind: "late_confirm"; level: number }
  | { kind: "manual"; intent: "cap" | "target"; level: number };

/**
 * Fold one shadow observation of an ON managed AC's generator level.
 * Ported decision order: first-adopt → unchanged → landed → obs-0 →
 * late-confirm-of-marked → collapse-suppressed → genuine manual.
 */
export function observeLevel(
  state: ReconcilerState,
  deviceId: string,
  obs: number,
  opts: { inSettle: boolean; collapsed: boolean; maxLevel: number },
): { state: ReconcilerState; result: LevelObservation } {
  const d = dev(state, deviceId);
  if (d.confirmedLevel == null) {
    if (opts.inSettle) return { state, result: { kind: "none" } };
    return { state: put(state, deviceId, { ...d, confirmedLevel: obs }), result: { kind: "adopted" } };
  }
  if (opts.inSettle || obs === d.confirmedLevel) return { state, result: { kind: "none" } };

  if (d.pendingLevel != null && obs === d.pendingLevel) {
    const unmarked = d.unreachable[obs] != null;
    const unreachable = { ...d.unreachable };
    delete unreachable[obs];
    return {
      state: put(state, deviceId, {
        ...d,
        confirmedLevel: obs,
        pendingLevel: null,
        sendCounts: {},
        sentAt: {},
        unreachable,
      }),
      result: { kind: "landed", level: obs, unmarked },
    };
  }

  if (obs <= 0) {
    // Firmware reset — adopt silently; never-level-0 re-caps; pending kept.
    return { state: put(state, deviceId, { ...d, confirmedLevel: obs }), result: { kind: "adopted" } };
  }

  if (d.unreachable[obs] != null) {
    // Confirm lag outlasted the send budget — the observation proves reachability.
    const unreachable = { ...d.unreachable };
    delete unreachable[obs];
    return {
      state: put(state, deviceId, {
        ...d,
        confirmedLevel: obs,
        pendingLevel: null,
        sendCounts: {},
        sentAt: {},
        unreachable,
      }),
      result: { kind: "late_confirm", level: obs },
    };
  }

  if (opts.collapsed) {
    // Dead device's last word, not user intent; pending KEPT deliberately.
    return { state: put(state, deviceId, { ...d, confirmedLevel: obs }), result: { kind: "adopted" } };
  }

  const rank = (l: number): number => (l <= 0 ? opts.maxLevel + 1 : Math.min(l, opts.maxLevel));
  const intent = rank(obs) < rank(d.confirmedLevel) ? "cap" : "target";
  return {
    state: put(state, deviceId, { ...d, confirmedLevel: obs, pendingLevel: null }),
    result: { kind: "manual", intent, level: rank(obs) },
  };
}

/**
 * Should this level command actually be sent now? Dedupes re-sends of the same
 * unconfirmed level within the spacing window (the pipeline re-emits targets
 * every evaluation by design — FLOORS re-asserts, never-level-0 re-caps).
 */
export function shouldSendLevel(state: ReconcilerState, deviceId: string, level: number, now: number): boolean {
  const d = dev(state, deviceId);
  if (d.lastLevelSent === level && now - d.lastLevelSentAt < LEVEL_RESEND_SPACING_MS) return false;
  return true;
}

/** Record a level send; may mark the level unreachable and demand a fallback. */
export function noteLevelSend(
  state: ReconcilerState,
  deviceId: string,
  level: number,
  now: number,
): { state: ReconcilerState; marked: boolean; fallback: number | null } {
  const d = dev(state, deviceId);
  const count = (d.sendCounts[level] ?? 0) + 1;
  let unreachable = d.unreachable;
  let marked = false;
  let fallback: number | null = null;
  if (count >= UNREACHABLE_LEVEL_SENDS && level >= 2 && unreachable[level] == null) {
    unreachable = { ...unreachable, [level]: now };
    marked = true;
    fallback = level - 1;
    while (fallback > 1 && unreachable[fallback] != null) fallback--;
  }
  return {
    state: put(state, deviceId, {
      ...d,
      pendingLevel: level,
      sendCounts: { ...d.sendCounts, [level]: count },
      sentAt: { ...d.sentAt, [level]: now },
      unreachable,
      lastLevelSentAt: now,
      lastLevelSent: level,
    }),
    marked,
    fallback,
  };
}

/** Highest level not marked unreachable, walking down from maxLevel; null = all reachable. */
export function reachableCapOf(state: ReconcilerState, deviceId: string, maxLevel: number): number | null {
  const marks = dev(state, deviceId).unreachable;
  if (Object.keys(marks).length === 0) return null;
  let cap = maxLevel;
  while (cap > 1 && marks[cap] != null) cap--;
  return cap;
}

/** Expire old unreachable marks (re-probe); returns the expired levels. */
export function sweepExpiredMarks(
  state: ReconcilerState,
  now: number,
): { state: ReconcilerState; expired: Array<{ deviceId: string; level: number }> } {
  const expired: Array<{ deviceId: string; level: number }> = [];
  let next: ReconcilerState = state;
  for (const [deviceId, d] of Object.entries(state)) {
    const keep: Record<number, number> = {};
    let changed = false;
    for (const [levelStr, markedAt] of Object.entries(d.unreachable)) {
      if (now - markedAt >= UNREACHABLE_SAFETY_EXPIRY_MS) {
        expired.push({ deviceId, level: Number(levelStr) });
        changed = true;
      } else {
        keep[Number(levelStr)] = markedAt;
      }
    }
    if (changed) next = put(next, deviceId, { ...d, unreachable: keep });
  }
  return { state: next, expired };
}

/** Power-off: drift baselines die with the session; unreachable marks survive. */
export function clearOnPowerOff(state: ReconcilerState, deviceId: string): ReconcilerState {
  const d = dev(state, deviceId);
  return put(state, deviceId, {
    ...d,
    confirmedLevel: null,
    pendingLevel: null,
    sendCounts: {},
    sentAt: {},
    pendingFan: null,
    fanResends: 0,
  });
}

/** Source change: compressors restart, firmware may come back anywhere — all baselines die; marks survive. */
export function clearOnSourceChange(state: ReconcilerState): ReconcilerState {
  const next: Record<string, ReconDevice> = {};
  for (const [id, d] of Object.entries(state)) {
    next[id] = {
      ...d,
      confirmedLevel: null,
      pendingLevel: null,
      sendCounts: {},
      sentAt: {},
      pendingFan: null,
      fanResends: 0,
    };
  }
  return next;
}

/** A manual gen change is a user probe — unreachable marks reset (mirrors v1). */
export function clearMarksOnManual(state: ReconcilerState, deviceId: string): ReconcilerState {
  const d = dev(state, deviceId);
  return put(state, deviceId, { ...d, unreachable: {}, sendCounts: {}, sentAt: {} });
}

// ---- fan confirm-or-resend (fan-trim holds) ----

export function noteFanSend(state: ReconcilerState, deviceId: string, fan: number, now: number): ReconcilerState {
  const d = dev(state, deviceId);
  const sameTarget = d.pendingFan === fan;
  return put(state, deviceId, {
    ...d,
    pendingFan: fan,
    fanResends: sameTarget ? d.fanResends + 1 : 0,
    lastFanSentAt: now,
  });
}

/** A fan re-send is due when unconfirmed, spaced, and under the resend budget. */
export function fanResendDue(
  state: ReconcilerState,
  deviceId: string,
  observedFan: number | null,
  now: number,
): number | null {
  const d = dev(state, deviceId);
  if (d.pendingFan == null || observedFan === d.pendingFan) return null;
  if (d.fanResends >= FAN_RESEND_MAX) return null;
  if (now - d.lastFanSentAt < FAN_RESEND_SPACING_MS) return null;
  return d.pendingFan;
}

export function confirmFan(state: ReconcilerState, deviceId: string, observedFan: number): ReconcilerState {
  const d = dev(state, deviceId);
  if (d.pendingFan == null || observedFan !== d.pendingFan) return state;
  return put(state, deviceId, { ...d, pendingFan: null, fanResends: 0 });
}

export function initialReconcilerState(): ReconcilerState {
  return {};
}

/**
 * Every level the firmware might currently be sitting at because we sent it and
 * never saw it confirm — for PHYSICS-ENVELOPE pricing, not for control.
 *
 * Deliberately NOT `pendingLevel`: that is a single slot overwritten by every
 * send, so a demote sent to a satisfied room erases the memory of the raise
 * that may still be in flight (2026-07-28: an L3 sent 15:39:49 was unconfirmed
 * for ≥15.8 min; a demote landing in that window would have made the envelope
 * price her a whole ton light and admitted a peer raise into a breach — the
 * exact hole this pricing exists to close). `sendCounts` keeps ALL of them and
 * is cleared wholesale on any confirm / power-off / source change / manual.
 *
 * Levels already marked firmware-unreachable are excluded: 4 unconfirmed sends
 * is hard evidence the device is NOT taking that level, so charging for it
 * would veto legitimate peer raises forever.
 */
export function unconfirmedLevels(state: ReconcilerState, deviceId: string, now: number): number[] {
  return unconfirmedSends(state, deviceId, now).map((s) => s.level);
}

/** As `unconfirmedLevels`, keeping each send's timestamp (demote resend spacing). */
export function unconfirmedSends(
  state: ReconcilerState,
  deviceId: string,
  now: number,
): Array<{ level: number; sentAt: number }> {
  const d = dev(state, deviceId);
  const sends: Array<{ level: number; sentAt: number }> = [];
  for (const [levelStr, sentAt] of Object.entries(d.sentAt)) {
    const level = Number(levelStr);
    if (d.unreachable[level] != null) continue;
    if (now - sentAt >= UNCONFIRMED_SEND_TTL_MS) continue;
    sends.push({ level, sentAt });
  }
  return sends;
}

/** For status/AcView building. */
export function pendingOrConfirmedLevel(
  state: ReconcilerState,
  deviceId: string,
): { confirmed: number | null; pending: number | null } {
  const d = dev(state, deviceId);
  return { confirmed: d.confirmedLevel, pending: d.pendingLevel };
}

export type { PowerSource };
