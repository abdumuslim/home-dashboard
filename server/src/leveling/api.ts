// The public leveling surface the collector/routes program against. Both the
// v1 AcLeveler and the v2 controller satisfy this structurally, so the
// controller flag can swap them without touching call sites. Field shapes are
// v1-compatible (the client reads this payload); v2 adds optional extras.

import type { TclCloud, AcDevice } from "../tcl-cloud.js";
import type { PowerSource } from "./types.js";

export type NeedTier = "satisfied" | "mild" | "full";

export interface LevelingDeps {
  getTclCloud: () => TclCloud | null;
  broadcast: (payload: Record<string, unknown>) => Promise<void>;
  setDevicePowerCache: (deviceId: string, power: "on" | "off") => void;
  isManualOffLocked: (deviceId: string) => Promise<boolean>;
  onLevelerFanCommand: (deviceId: string, fan: number) => void;
  onUrgentLevelingNeeded?: () => void;
  onPowerEvent?: (kind: string) => void;
}

export interface LevelerDeviceContext {
  device: AcDevice;
  managed: boolean;
  needTier: NeedTier;
  needDelta: number;
  slotGenCap: number | null;
}

export interface LevelingAcStatusV2 {
  deviceId: string;
  name: string;
  on: boolean;
  managed: boolean;
  shed: boolean;
  level: number;
  maxLevel: number;
  minLevel: number;
  estAmps: number;
  needTier: NeedTier;
  needCap: number;
  needDelta: number;
  manualCap: number | null;
  manualTarget: number | null;
  idealLevel: number | null;
  heldFan: number | null;
  fanOriginal: number | null;
  bounceCap: number | null;
  bounceRetryBelowAmps: number | null;
  restoreBlocked: boolean;
  slotCap: number | null;
  unreachableLevels: number[];
  /** v2 extras */
  raiseCooldownMs?: number;
  restoreCooldownMs?: number;
  /**
   * How long this room has sat below its comfort floor WITHOUT getting cooler
   * (0 when at/above it, or whenever it last made progress). The raw clock
   * behind `coolingState: "stalled"` — surfaced so the report can be checked
   * rather than taken on faith.
   *
   * ⚠ REPORT-ONLY since 2026-08-06. Nothing in the ladder reads it: a stalled
   * thermometer stopped being evidence of a dead compressor (user: "it is so
   * normal that we see no cooling progress in all rooms for a long time, even
   * with L3"). It is also what the "pinned below the comfort floor and not
   * cooling" report is built from, which was always its report-only half.
   */
  subFloorStalledMs?: number;
  /**
   * What this room is actually DOING, as opposed to what its level says (R7):
   *
   *  - `off`             not on, or shed by the leveler.
   *  - `compressor_off`  the METER says its compressor is not running — a graded
   *                      lone off that moved about a fan, or a dead window
   *                      nothing has absorbed (R6). This is the only one the
   *                      ladder ACTS on. (A lone RAISE's rise is journalled as
   *                      `compressor_report` and never reaches this field: it
   *                      measures the whole house, not the room.)
   *  - `stalled`         the THERMOMETER has not moved: below its comfort floor
   *                      with no cooling progress for `SUBFLOOR_WATCH_MS`.
   *                      Report-only since 2026-08-06 — informative, not a
   *                      diagnosis (see `subFloorStalledMs`).
   *  - `cooling`         nothing to report.
   *
   * A diagnostic, not an alarm: a room can sit at a perfectly healthy-looking
   * L1 and be out of service, which is the failure this whole family of bugs
   * has in common — the system reports healthy while acting on fiction.
   */
  coolingState?: "cooling" | "stalled" | "compressor_off" | "off";
  /**
   * The LEARNED non-cooling hold, when one is live (level-hold.ts): why this
   * room's floor sits above L1 even though nothing in the config says so. The
   * user asked for this in as many words — the status must say "L1 non-cooling
   * observed at 44.1° outdoor, holds until below that or <time>" — because a
   * floor nobody can explain is a floor nobody trusts.
   */
  levelHold?: { level: number; outdoorC: number; until: number; detail: string } | null;
}

export interface LevelingStatusV2 {
  enabled: boolean;
  source: PowerSource;
  measuredAmps: number | null;
  limitAmps: number | null;
  budgetAmps: number | null;
  /** Measured worst-case non-AC house load on this source (house-load.ts peak). */
  nonAcLoadAmps: number | null;
  /**
   * Live supply-flicker estimate in amps. ~0 on the grid, typically 0.5–1.2 on
   * the generator. Raw readings within this much of the limit are classified as
   * supply noise rather than load (sensing.ts).
   */
  flickerAmps: number;
  overLimitBudget: number;
  overLimitBudgetMax: number;
  headroomStreak: number;
  settleRemainingMs: number;
  raiseHoldRemainingMs: number;
  expectedAmps: number | null;
  lastPrediction: { expectedAmps: number; actualAmps: number; at: number } | null;
  lastEmergency: { at: number; requiredAmps: number; savedAmps: number } | null;
  acs: LevelingAcStatusV2[];
  /** v2 extras */
  mode?: string;
  calmMs?: number;
  controller?: string;
  decisions?: Array<{ at: number; deviceId?: string; action: string; blockedBy?: string; detail?: string }>;
  /** ESP readings arrive but carry no micro-variation — value untrusted, raises suspended. */
  meterFrozen?: boolean;
}

/** The call surface collector.ts and routes.ts use (structural — v1 satisfies it). */
export interface LevelingApi {
  ensureLoaded(): Promise<void>;
  getConfig(): Promise<unknown>;
  updateConfig(cfg: never): Promise<unknown>;
  isEnabled(): boolean;
  getComfortTarget(): number;
  getLimits(): { gridLimitAmps: number; genLimitAmps: number; marginAmps: number };
  isShed(deviceId: string): boolean;
  clearShed(deviceId: string, reason: string): Promise<void>;
  hasFanHold(deviceId: string): boolean;
  rememberStableLevel(deviceId: string): Promise<void>;
  reconcileObservedOn(deviceId: string): Promise<void>;
  onPowerReading(data: { current_1: number; current_2: number }): void;
  onUserPowerOff(deviceId: string): Promise<void>;
  onUserPowerOn(deviceId: string): Promise<void>;
  onUserFanChange(deviceId: string): Promise<void>;
  onUserGenLevel(deviceId: string, level: number): Promise<{ reverted: boolean; level: number }>;
  rearmRamp(deviceIds: string[]): void;
  tick(ctx: LevelerDeviceContext[], outdoorTempC: number | null): Promise<void>;
  getStatus(): LevelingStatusV2;
}
