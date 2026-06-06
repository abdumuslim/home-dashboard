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
  ampModels: Record<string, AcAmpModel>;
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
  acs: AcLevelingAcStatus[];
}

export interface AcLevelingResponse {
  config: AcLevelingConfig;
  status: AcLevelingStatus;
}
