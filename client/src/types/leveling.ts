export interface AcAmpModel {
  baseAmps: number;
  stepAmps: number;
}

/** Conditional minimum level — e.g. Abdullah's AC can't cool at L1 when it's 37°C+ outside. */
export interface AcLevelBoost {
  minLevel: number;
  outdoorAtLeastC: number;
}

export interface AcLevelingConfig {
  enabled: boolean;
  gridLimitAmps: number;
  genLimitAmps: number;
  marginAmps: number;
  /** Extra headroom kept below the breaker when raising (asymmetric hysteresis). */
  raiseBufferAmps: number;
  comfortTargetC: number;
  /** Near-target band °C: within this band of the target the AC is hard-capped at L1. */
  nearTargetBandC?: number;
  /** Device ids, highest priority first. */
  priority: string[];
  /** Per-AC draw model on grid (fallback for gen when no gen model is set). */
  ampModels: Record<string, AcAmpModel>;
  /** Optional per-AC draw model on generator — lower voltage means more amps. */
  genAmpModels?: Record<string, AcAmpModel>;
  levelBoosts: Record<string, AcLevelBoost>;
  /** Levels an AC may be raised per batch on grid/gen (1 = one-step pacing). */
  maxRaiseStepGrid?: number;
  maxRaiseStepGen?: number;
  /**
   * Over-limit leaky-bucket capacity in points (4–20, server default 5). Optional:
   * configs saved before the field existed omit it.
   */
  overLimitBudgetPoints?: number;
}

export type NeedTier = "satisfied" | "mild" | "full";
export type PowerSource = "grid" | "gen" | "none";

export interface AcLevelingAcStatus {
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
  /** Fan the leveler is currently holding the AC at (null = no hold). */
  heldFan: number | null;
  /** Original fan the hold will restore to (0 = built-in auto). */
  fanOriginal: number | null;
  /** A recent raise bounced over the limit — raises capped here until the load drops (null = no bounce). */
  bounceCap: number | null;
  /** Measured total below which the bounced raise/restore is retried. */
  bounceRetryBelowAmps: number | null;
  /** A recent restore bounced (re-shed) — restore attempts paused until the load drops. */
  restoreBlocked: boolean;
  /** Active range slot's generator-level hard cap (null = Auto). */
  slotCap: number | null;
  /** Levels the firmware never confirmed after repeated sends (empty = all reachable). */
  unreachableLevels: number[];
  /**
   * What the room is actually DOING, as opposed to what its level says:
   * `compressor_off` = the meter says its compressor is not running (a graded
   * lone off that moved about a fan, or a changeover dead window);
   * `stalled` = the thermometer says so (below its comfort floor with no cooling
   * progress for three minutes). A diagnostic, not an alarm.
   */
  coolingState?: "cooling" | "stalled" | "compressor_off" | "off";
  /** How long it has sat below its comfort floor without getting cooler (ms). */
  subFloorStalledMs?: number;
  /**
   * The LEARNED non-cooling hold, when one is live: why this room's floor sits
   * above L1 even though nothing in the config says so.
   */
  levelHold?: { level: number; outdoorC: number; until: number; detail: string } | null;
}

export interface AcLevelingStatus {
  enabled: boolean;
  source: PowerSource;
  measuredAmps: number | null;
  limitAmps: number | null;
  budgetAmps: number | null;
  nonAcLoadAmps: number | null;
  /** Over-limit leaky-bucket points remaining (acts at 0); `overLimitBudgetMax` is the capacity. */
  overLimitBudget: number;
  overLimitBudgetMax: number;
  headroomStreak: number;
  settleRemainingMs: number;
  /** Raises paused because the last raise's amps never showed up (0 = no hold). */
  raiseHoldRemainingMs: number;
  /** Predicted steady-state total amps after the last command batch (null once graded). */
  expectedAmps: number | null;
  /** Last completed amp-model accuracy check. */
  lastPrediction: { expectedAmps: number; actualAmps: number; at: number } | null;
  /** Last meter-sized emergency cut batch (severe over-limit fast path). */
  lastEmergency: { at: number; requiredAmps: number; savedAmps: number } | null;
  acs: AcLevelingAcStatus[];
}

export interface AcLevelingResponse {
  config: AcLevelingConfig;
  status: AcLevelingStatus;
}

// ---------- Calibration ----------

export type CalibrationPhase = "idle" | "prep" | "baseline" | "ramp" | "sample" | "restore";

export interface CalibrationStep {
  kind: "level" | "fan";
  value: number;
}

export interface AcCalibrationStatus {
  active: boolean;
  source: "grid" | "gen" | null;
  queue: string[];
  currentDevice: string | null;
  currentDeviceName: string | null;
  phase: CalibrationPhase;
  step: CalibrationStep | null;
  stepsDone: number;
  totalSteps: number;
  samplesCollected: number;
  samplesNeeded: number;
  startedAt: number | null;
  finishedAt: number | null;
  abortReason: string | null;
  /** Seconds since the last ESP reading while the run is paused on a feed gap; null when healthy. */
  powerGapSeconds: number | null;
}

export interface CalibrationResultRow {
  deviceId: string;
  source: "grid" | "gen";
  kind: "level" | "fan";
  step: number;
  amps: number;
  voltage: number | null;
  stddev: number | null;
  samples: number;
  measuredAt: string;
}

export interface CalibrationFit {
  baseAmps: number;
  stepAmps: number;
}

export interface AcCalibrationResponse {
  status: AcCalibrationStatus;
  results: CalibrationResultRow[];
  suggestedFit: Record<string, { grid?: CalibrationFit; gen?: CalibrationFit }>;
}
