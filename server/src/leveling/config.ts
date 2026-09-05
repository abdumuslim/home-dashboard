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

/**
 * Per-AC correction to how this room's NEED is computed. Both fields describe
 * one room's own comfort question, never the house's — see the rank comment in
 * `controller.buildViews`.
 */
export interface AcNeedOverride {
  /** Calibration added to the AC's internal thermometer (e.g. -1). */
  tempOffsetC?: number;
  /** Use the device's live setpoint as this room's need target instead of comfortTargetC. */
  targetFromSetpoint?: boolean;
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
  /**
   * Spenders may act on budget a cut has freed but the meter has not shown yet
   * (`MeterView.spendableCreditAmps`): the shed restore, the level raise and the
   * fan restore each admit at `cost ≤ credit − REBALANCE_FUND_MARGIN_AMPS` and
   * waive their calm gate for that one admission (2026-08-31). The kill-switch:
   * OFF reverts every one of those paths to the meter-only admission they had
   * before, leaving only the urgent evaluation (which merely shortens the wait to
   * an ordinary tick).
   */
  fundedSpend: boolean;
  /**
   * Capacity of the over-limit leaky bucket, in points. A mild over-limit
   * reading drains 1, a moderate one (more than OVER_LIMIT_MODERATE_AMPS over)
   * 2, a severe one (strictly MORE than OVER_LIMIT_SEVERE_AMPS over) 3, so the
   * bucket empties (and the reducer acts) on the N-th mild reading or the
   * ceil(N/3)-th severe one. Bigger = more tolerance for a near-limit ride,
   * slower to act; smaller = the reverse.
   *
   * The post-act refill is `OVER_LIMIT_BUDGET_AFTER_ACT` (4) regardless of this
   * value, which at the minimum capacity of 4 is a full refill. That is what
   * keeps invariant 19 true at every setting: no single severe reading can empty
   * the post-act bucket by itself.
   */
  overLimitBudgetPoints: number;
  comfortTargetC: number;
  nearTargetBandC: number;
  /** Device ids, highest priority first (raise ordering + tiebreaks only). */
  priority: string[];
  /** Per-AC steady draw model on grid (fallback for gen when genAmpModels absent). */
  ampModels: Record<string, AcAmpModel>;
  genAmpModels: Record<string, AcAmpModel>;
  levelBoosts: Record<string, AcLevelBoost>;
  /**
   * Per-AC need corrections, keyed by device id. An AC whose internal
   * thermometer reads high, or whose occupant's comfort target is his own
   * setpoint rather than the shared one, is described HERE — never hardcoded
   * against a device id (user request, 2026-08-05: Abdullah's AC reads ~1°C
   * high and his target is the AC's own setpoint).
   */
  needOverrides: Record<string, AcNeedOverride>;
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
  fundedSpend: true,
  overLimitBudgetPoints: 5,
  comfortTargetC: 26,
  nearTargetBandC: 0.5,
  priority: [],
  ampModels: {},
  genAmpModels: {},
  levelBoosts: {},
  needOverrides: {},
};

/**
 * Floor for `overLimitBudgetPoints`. Four, never less: `OVER_LIMIT_BUDGET_AFTER_ACT`
 * is a fixed 4 points, so at this capacity the post-act refill is FULL and still
 * outranks `OVER_LIMIT_DRAIN_SEVERE` (3), so invariant 19 holds by construction
 * at every admissible setting instead of depending on the operator's arithmetic.
 * (Shipped below that relationship once, on 2026-07-31, and it double-shed a
 * room within twenty minutes.)
 */
export const OVER_LIMIT_BUDGET_MIN = 4;
/**
 * Ceiling. Twenty mild readings is ~1–1.5 minutes of near-limit ride before the
 * first act, already far past what a hot breaker survives, so anything larger
 * would be a setting that only looks like protection.
 */
export const OVER_LIMIT_BUDGET_MAX = 20;

/**
 * The keys row 2 owns. ONE list, shared by the controller's row-1/row-2 split
 * and the API's forwarding filter: a key present in one copy and missing from
 * the other is dropped silently behind a 200, which is invariant 37's shape
 * (a dashboard save that changed nothing for weeks).
 */
export const LEVELING_V2_CONFIG_KEYS = [
  "controller",
  "restingBufferAmps",
  "raiseCalmSeconds",
  "restoreCalmSeconds",
  "fanTrimEnabled",
  "fundedSpend",
  "overLimitBudgetPoints",
] as const;

export type LevelingV2ConfigKey = (typeof LEVELING_V2_CONFIG_KEYS)[number];

/** Fields shared with v1 on row 1; v1's own save path replaces that row wholesale. */
type LevelingV1SharedKey =
  | "enabled"
  | "gridLimitAmps"
  | "genLimitAmps"
  | "marginAmps"
  | "comfortTargetC"
  | "nearTargetBandC"
  | "priority"
  | "ampModels"
  | "genAmpModels"
  | "levelBoosts"
  | "needOverrides";

type AssertNever<T extends never> = T;

/**
 * Compile-time completeness, not a second runtime list (which would only move
 * the drift): a new field on `LevelingConfigV2` must be classified as v1-shared
 * or listed above, or this alias stops being `never` and the constraint fails
 * right here.
 */
export type LevelingV2KeysAreComplete = AssertNever<
  Exclude<Exclude<keyof LevelingConfigV2, LevelingV1SharedKey>, LevelingV2ConfigKey>
>;

export const LEVELING_V2_CONFIG_KEY_SET: ReadonlySet<string> = new Set<string>(LEVELING_V2_CONFIG_KEYS);

/** Type guard for filtering a raw `Object.entries` body by row ownership. */
export function isLevelingV2Key(key: string): key is LevelingV2ConfigKey {
  return LEVELING_V2_CONFIG_KEY_SET.has(key);
}

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
  const raiseCalmSeconds = Math.max(5, num(s.raiseCalmSeconds, d.raiseCalmSeconds));
  return {
    enabled: typeof s.enabled === "boolean" ? s.enabled : d.enabled,
    controller: s.controller === "v2" || s.controller === "shadow" ? s.controller : "v1",
    gridLimitAmps: num(s.gridLimitAmps, d.gridLimitAmps),
    genLimitAmps: num(s.genLimitAmps, d.genLimitAmps),
    marginAmps: num(s.marginAmps, d.marginAmps),
    restingBufferAmps: Math.max(0, num(s.restingBufferAmps, num(s.raiseBufferAmps, d.restingBufferAmps))),
    raiseCalmSeconds,
    // A restore must never wait LONGER for calm than an ordinary raise: if it
    // did, a running AC's raise could become calm-eligible first and consume
    // the headroom a pending restore needs, breaking "restore outranks raises".
    // Clamp restore ≤ raise so restore's gate always opens no later.
    restoreCalmSeconds: Math.min(raiseCalmSeconds, Math.max(5, num(s.restoreCalmSeconds, d.restoreCalmSeconds))),
    fanTrimEnabled: typeof s.fanTrimEnabled === "boolean" ? s.fanTrimEnabled : d.fanTrimEnabled,
    fundedSpend: typeof s.fundedSpend === "boolean" ? s.fundedSpend : d.fundedSpend,
    // Whole points only, and clamped: the bucket is compared against integer
    // drains, and a stored 0 (or a hand-edited 40) would be an operator-set
    // capacity the safety argument in OVER_LIMIT_BUDGET_MIN no longer covers.
    overLimitBudgetPoints: Math.min(
      OVER_LIMIT_BUDGET_MAX,
      Math.max(OVER_LIMIT_BUDGET_MIN, Math.round(num(s.overLimitBudgetPoints, d.overLimitBudgetPoints))),
    ),
    comfortTargetC: num(s.comfortTargetC, d.comfortTargetC),
    nearTargetBandC: Math.min(5, Math.max(0, num(s.nearTargetBandC, d.nearTargetBandC))),
    priority: Array.isArray(s.priority) ? s.priority.filter((p): p is string => typeof p === "string") : [],
    ampModels: sanitizeModels(s.ampModels),
    genAmpModels: sanitizeModels(s.genAmpModels),
    levelBoosts: sanitizeBoosts(s.levelBoosts),
    needOverrides: sanitizeNeedOverrides(s.needOverrides),
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

/**
 * Keep only the fields that are actually usable, and drop an entry that carries
 * none of them — an override present but empty would read as "this room is
 * special" everywhere it is consulted while changing nothing. The offset is
 * clamped to ±5°C: a thermometer calibration, not a way to fake a room's
 * temperature into a different house.
 */
function sanitizeNeedOverrides(raw: unknown): Record<string, AcNeedOverride> {
  if (raw == null || typeof raw !== "object") return {};
  const out: Record<string, AcNeedOverride> = {};
  for (const [id, o] of Object.entries(raw as Record<string, unknown>)) {
    if (o == null || typeof o !== "object") continue;
    const offset = (o as AcNeedOverride).tempOffsetC;
    const fromSetpoint = (o as AcNeedOverride).targetFromSetpoint;
    const entry: AcNeedOverride = {};
    if (typeof offset === "number" && Number.isFinite(offset)) {
      entry.tempOffsetC = Math.min(5, Math.max(-5, offset));
    }
    if (typeof fromSetpoint === "boolean") entry.targetFromSetpoint = fromSetpoint;
    if (entry.tempOffsetC != null || entry.targetFromSetpoint != null) out[id] = entry;
  }
  return out;
}

/** Limit for the active source; "none" has no limit (no source, no budget). */
export function limitFor(config: LevelingConfigV2, source: "grid" | "gen"): number {
  return source === "grid" ? config.gridLimitAmps : config.genLimitAmps;
}

/**
 * The limit the controller must actually respect: the configured limit minus
 * the live post-collapse derate (see MeterView.derateAmps). A breaker that
 * just tripped is hot and holds LESS than its rating until it cools — live
 * 2026-07-26 the same gen tripped at 15.65A, then 14.48A, then 13.99A within
 * 25 minutes on a 15A configured limit. Every limit consumer (sensing's leaky
 * bucket, pressure, the pipeline's ceilings) must go through here or they
 * disagree about what "over" means.
 */
export function effectiveLimit(
  config: LevelingConfigV2,
  source: "grid" | "gen",
  derateAmps: number,
): number {
  return Math.max(1, limitFor(config, source) - Math.max(0, derateAmps));
}
