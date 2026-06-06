export interface AcAmpModel {
  baseAmps: number;
  stepAmps: number;
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
  estAmps: number;
  needTier: NeedTier;
  needCap: number;
  manualCap: number | null;
  manualTarget: number | null;
  idealLevel: number | null;
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
