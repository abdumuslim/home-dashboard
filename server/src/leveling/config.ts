// v2 leveling config — additive fields over the v1 JSONB row (ac_leveling_config).
// The same stored row feeds both controllers during the migration window, so v2
// fields are optional-with-defaults and v1 fields keep their exact names.

export interface AcAmpModel {
  baseAmps: number;
  stepAmps: number;
}

export interface AcLevelBoost {
  minLevel: number;
  outdoorAtLeastC: number;
}

export type ControllerFlavor = "v1" | "shadow" | "v2";

export interface LevelingConfigV2 {
  enabled: boolean;
  /** Which controller acts: v1 (legacy), shadow (v1 acts, v2 journals), v2 (v2 acts). */
  controller: ControllerFlavor;
  gridLimitAmps: number;
  genLimitAmps: number;
  marginAmps: number;
  /**
   * Raises drive toward `limit − margin − restingBuffer` and stop — the resting
   * point. The band between the resting point and the limit is where source
   * noise lives without triggering anything. Reductions ignore this (they act
   * on the raw limit — "if it's even 0.1A below, no reduction").
   * Same semantic as v1 `raiseBufferAmps`; that field seeds this one.
   */
  restingBufferAmps: number;
  /** Sustained genuine-headroom time required before a level raise. */
  raiseCalmSeconds: number;
  /** Shorter calm requirement for restoring a shed (off) AC — high comfort value. */
  restoreCalmSeconds: number;
  /** Last-resort fan trim enabled (fans otherwise stay out of the leveling loop). */
  fanTrimEnabled: boolean;
  comfortTargetC: number;
  nearTargetBandC: number;
  /** Device ids, highest priority first (raise ordering + tiebreaks only). */
  priority: string[];
  /** Per-AC steady draw model on grid (fallback for gen when genAmpModels absent). */
  ampModels: Record<string, AcAmpModel>;
  genAmpModels: Record<string, AcAmpModel>;
  levelBoosts: Record<string, AcLevelBoost>;
}

export const DEFAULT_LEVELING_CONFIG_V2: LevelingConfigV2 = {
  enabled: false,
  controller: "v1",
  gridLimitAmps: 30,
  genLimitAmps: 15,
  marginAmps: 1,
  restingBufferAmps: 0.2,
  raiseCalmSeconds: 30,
  restoreCalmSeconds: 15,
  fanTrimEnabled: true,
  comfortTargetC: 26,
  nearTargetBandC: 0.5,
  priority: [],
  ampModels: {},
  genAmpModels: {},
  levelBoosts: {},
};

/**
 * Merge a stored JSONB row (v1-era or v2-era, possibly partial) over the v2
 * defaults. v1's `raiseBufferAmps` seeds `restingBufferAmps` when the v2 field
 * is absent — same semantic, renamed for what it actually does now.
 */
export function mergeLevelingConfigV2(stored: Record<string, unknown> | null | undefined): LevelingConfigV2 {
  const s = (stored ?? {}) as Partial<LevelingConfigV2> & { raiseBufferAmps?: number };
  const num = (v: unknown, fallback: number): number =>
    typeof v === "number" && Number.isFinite(v) ? v : fallback;
  const d = DEFAULT_LEVELING_CONFIG_V2;
  return {
    enabled: typeof s.enabled === "boolean" ? s.enabled : d.enabled,
    controller: s.controller === "v2" || s.controller === "shadow" ? s.controller : "v1",
    gridLimitAmps: num(s.gridLimitAmps, d.gridLimitAmps),
    genLimitAmps: num(s.genLimitAmps, d.genLimitAmps),
    marginAmps: num(s.marginAmps, d.marginAmps),
    restingBufferAmps: Math.max(0, num(s.restingBufferAmps, num(s.raiseBufferAmps, d.restingBufferAmps))),
    raiseCalmSeconds: Math.max(5, num(s.raiseCalmSeconds, d.raiseCalmSeconds)),
    restoreCalmSeconds: Math.max(5, num(s.restoreCalmSeconds, d.restoreCalmSeconds)),
    fanTrimEnabled: typeof s.fanTrimEnabled === "boolean" ? s.fanTrimEnabled : d.fanTrimEnabled,
    comfortTargetC: num(s.comfortTargetC, d.comfortTargetC),
    nearTargetBandC: Math.min(5, Math.max(0, num(s.nearTargetBandC, d.nearTargetBandC))),
    priority: Array.isArray(s.priority) ? s.priority.filter((p): p is string => typeof p === "string") : [],
    ampModels: sanitizeModels(s.ampModels),
    genAmpModels: sanitizeModels(s.genAmpModels),
    levelBoosts: sanitizeBoosts(s.levelBoosts),
  };
}

function sanitizeModels(raw: unknown): Record<string, AcAmpModel> {
  if (raw == null || typeof raw !== "object") return {};
  const out: Record<string, AcAmpModel> = {};
  for (const [id, m] of Object.entries(raw as Record<string, unknown>)) {
    if (m == null || typeof m !== "object") continue;
    const base = (m as AcAmpModel).baseAmps;
    const step = (m as AcAmpModel).stepAmps;
    if (typeof base === "number" && Number.isFinite(base) && typeof step === "number" && Number.isFinite(step)) {
      out[id] = { baseAmps: base, stepAmps: step };
    }
  }
  return out;
}

function sanitizeBoosts(raw: unknown): Record<string, AcLevelBoost> {
  if (raw == null || typeof raw !== "object") return {};
  const out: Record<string, AcLevelBoost> = {};
  for (const [id, b] of Object.entries(raw as Record<string, unknown>)) {
    if (b == null || typeof b !== "object") continue;
    const min = (b as AcLevelBoost).minLevel;
    const at = (b as AcLevelBoost).outdoorAtLeastC;
    if (typeof min === "number" && min >= 1 && typeof at === "number" && Number.isFinite(at)) {
      out[id] = { minLevel: Math.round(min), outdoorAtLeastC: at };
    }
  }
  return out;
}

/** Limit for the active source; "none" has no limit (no source, no budget). */
export function limitFor(config: LevelingConfigV2, source: "grid" | "gen"): number {
  return source === "grid" ? config.gridLimitAmps : config.genLimitAmps;
}
