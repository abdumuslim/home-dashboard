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
  comfortTargetC: number;
  /** Device ids, highest priority first. */
  priority: string[];
  /** Per-AC draw model on grid (fallback for gen when no gen model is set). */
  ampModels: Record<string, AcAmpModel>;
  /** Optional per-AC draw model on generator — lower voltage means more amps. */
  genAmpModels?: Record<string, AcAmpModel>;
  levelBoosts: Record<string, AcLevelBoost>;
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
}

export interface AcLevelingStatus {
  enabled: boolean;
  source: PowerSource;
  measuredAmps: number | null;
  limitAmps: number | null;
  budgetAmps: number | null;
  nonAcLoadAmps: number | null;
  overLimitStreak: number;
  headroomStreak: number;
  settleRemainingMs: number;
  /** Raises paused because the last raise's amps never showed up (0 = no hold). */
  raiseHoldRemainingMs: number;
  /** Predicted steady-state total amps after the last command batch (null once graded). */
  expectedAmps: number | null;
  /** Last completed amp-model accuracy check. */
  lastPrediction: { expectedAmps: number; actualAmps: number; at: number } | null;
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
