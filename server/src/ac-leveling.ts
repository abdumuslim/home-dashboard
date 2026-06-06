// Pure allocation logic for Smart AC Leveling — no I/O, fully unit-testable.
// The stateful AcLeveler (ac-leveler.ts) builds AllocatorInput each tick and
// executes the resulting commands against the TCL cloud.

export type PowerSource = "grid" | "gen" | "none";
export type NeedTier = "satisfied" | "mild" | "full";

/** Estimated current draw model for one AC: L1 = baseAmps, each level adds stepAmps. */
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

export const DEFAULT_LEVELING_CONFIG: AcLevelingConfig = {
  enabled: false,
  gridLimitAmps: 30,
  genLimitAmps: 15,
  marginAmps: 1,
  comfortTargetC: 26,
  priority: [],
  ampModels: {},
};

export interface LevelerAcSnapshot {
  deviceId: string;
  on: boolean;
  /** Master enabled AND not opted out via an automation's smart_leveling=false. */
  managed: boolean;
  shed: boolean;
  maxLevel: number;
  /** generatorMode from the device shadow; 0 = unrestricted. */
  currentLevel: number;
  needTier: NeedTier;
  /** User manually reduced the level — never raise above this. */
  manualCap: number | null;
  /** User manually raised the level — overrides the need cap as the target. */
  manualTarget: number | null;
}

export interface AllocatorInput {
  limitAmps: number;
  marginAmps: number;
  /** Estimated non-AC household draw (caller derives from measured − estimated AC draws). */
  nonAcLoadAmps: number;
  /** Consecutive power readings with measured > limit. */
  overLimitStreak: number;
  /** Consecutive power readings with measured ≤ limit − margin. */
  headroomStreak: number;
  /** Within the settle window after the last command batch. */
  inSettle: boolean;
  /** Structural change (AC on/off, source change, manual change, config change) — allow immediate reductions. */
  forceEvaluate: boolean;
  /** Pre-sorted by priority, highest first. */
  acs: LevelerAcSnapshot[];
  ampModels: Record<string, AcAmpModel>;
}

export interface AllocationResult {
  /** Level-change commands: deviceId → new generator level (differs from current). */
  desiredLevels: Record<string, number>;
  /** Power OFF + mark shed, lowest priority first. */
  toShed: string[];
  /** Power ON at L1 + clear shed (at most one per call). */
  toRestore: string[];
  /** Full budget-constrained ideal allocation for status display. */
  idealLevels: Record<string, number>;
  nonAcLoadAmps: number;
  budgetAmps: number;
  projectedAmps: number;
}

/** Readings over the limit required before a reactive reduction (gen current fluctuates). */
export const REDUCE_STREAK = 4;
/** Readings with headroom required before raising a level or restoring a shed AC. */
export const RAISE_STREAK = 6;
/** Power reading older than this means no electricity (matches /api/current/power). */
export const STALE_POWER_MS = 15_000;
/** Same noise floor the power card uses to consider a line active. */
export const NOISE_THRESHOLD = 0.1;
/** Pause after sending commands so compressors and measurements settle. */
export const SETTLE_MS = 30_000;
/** Grace before an observed-ON clears a shed flag (shadow lags the off command). */
export const SHED_CLEAR_GRACE_MS = 15_000;

const DEFAULT_AMP_MODEL: AcAmpModel = { baseAmps: 2, stepAmps: 1 };

export function estimateAcDraw(level: number, maxLevel: number, model: AcAmpModel): number {
  if (level <= 0) {
    // Unrestricted — assume one step above the top level for budgeting.
    return model.baseAmps + model.stepAmps * maxLevel;
  }
  return model.baseAmps + model.stepAmps * (Math.min(level, maxLevel) - 1);
}

/** Mirrors the power card's active-source logic (power-card.tsx). */
export function determineSource(
  reading: { current_1: number; current_2: number } | null,
  staleMs: number,
): PowerSource {
  if (!reading || staleMs > STALE_POWER_MS) return "none";
  const gridActive = reading.current_1 > NOISE_THRESHOLD;
  const genActive = reading.current_2 > NOISE_THRESHOLD;
  if (gridActive && genActive) return reading.current_1 >= reading.current_2 ? "grid" : "gen";
  if (gridActive) return "grid";
  if (genActive) return "gen";
  return "none";
}

export type NeedInput =
  | { kind: "range"; value: number; slotLow: number; slotHigh: number }
  | { kind: "comfort"; currentTemp: number; target: number };

export function computeNeedTier(input: NeedInput): NeedTier {
  if (input.kind === "range") {
    if (input.value <= input.slotLow) return "satisfied";
    if (input.value >= input.slotHigh) return "full";
    return "mild";
  }
  const deviation = input.currentTemp - input.target;
  if (deviation <= 0) return "satisfied";
  if (deviation <= 1.5) return "mild";
  return "full";
}

export function needCap(tier: NeedTier, maxLevel: number): number {
  if (tier === "satisfied") return 1;
  if (tier === "mild") return Math.ceil(maxLevel / 2);
  return maxLevel;
}

function targetCap(ac: LevelerAcSnapshot): number {
  const cap = ac.manualTarget != null
    ? ac.manualTarget
    : Math.min(needCap(ac.needTier, ac.maxLevel), ac.manualCap ?? ac.maxLevel);
  return Math.max(1, Math.min(cap, ac.maxLevel));
}

export function computeAllocation(input: AllocatorInput): AllocationResult {
  const { limitAmps, marginAmps, nonAcLoadAmps, acs, ampModels } = input;
  const model = (id: string): AcAmpModel => ampModels[id] ?? DEFAULT_AMP_MODEL;
  const draw = (ac: LevelerAcSnapshot, level: number): number =>
    estimateAcDraw(level, ac.maxLevel, model(ac.deviceId));

  const onManaged = acs.filter((a) => a.on && a.managed);
  const onUnmanaged = acs.filter((a) => a.on && !a.managed);
  const restoreCandidates = acs.filter((a) => !a.on && a.shed && a.managed);

  const unmanagedDraw = onUnmanaged.reduce((sum, a) => sum + draw(a, a.currentLevel), 0);
  const budgetAmps = limitAmps - marginAmps - nonAcLoadAmps - unmanagedDraw;
  const currentOnCost = onManaged.reduce((sum, a) => sum + draw(a, a.currentLevel), 0);
  const projectedAmps = nonAcLoadAmps + unmanagedDraw + currentOnCost;

  // Reductions/sheds need either a sustained over-limit streak (reactive) or a
  // structural change (proactive). They deliberately ignore the settle window —
  // safety first; the caller resets streaks after executing reductions.
  const canReduce = input.forceEvaluate || input.overLimitStreak >= REDUCE_STREAK;
  const canRaise = !input.inSettle && input.headroomStreak >= RAISE_STREAK;

  // Greedy ideal allocation: L1 each by priority; shed lowest priority if even
  // the base does not fit; otherwise raise-fill saturating highest priority first.
  const ideal = new Map<string, number>();
  const shedWanted: string[] = [];
  let cost = 0;
  for (const a of onManaged) {
    ideal.set(a.deviceId, 1);
    cost += draw(a, 1);
  }
  if (cost > budgetAmps) {
    for (let i = onManaged.length - 1; i >= 0 && cost > budgetAmps; i--) {
      const a = onManaged[i];
      cost -= draw(a, 1);
      ideal.delete(a.deviceId);
      shedWanted.push(a.deviceId);
    }
  } else {
    for (const a of onManaged) {
      const cap = targetCap(a);
      const step = model(a.deviceId).stepAmps;
      let level = 1;
      while (level < cap && cost + step <= budgetAmps) {
        level++;
        cost += step;
      }
      ideal.set(a.deviceId, level);
    }
  }

  const toShed = canReduce ? shedWanted : [];

  // Restore at most one shed AC (highest priority first) — only when nothing
  // wants shedding and headroom is sustained.
  const toRestore: string[] = [];
  if (canRaise && shedWanted.length === 0) {
    for (const a of restoreCandidates) {
      if (currentOnCost + draw(a, 1) <= budgetAmps) {
        toRestore.push(a.deviceId);
        break;
      }
    }
  }

  const desiredLevels: Record<string, number> = {};
  let raised = false;
  for (const a of onManaged) {
    if (toShed.includes(a.deviceId)) continue;
    const target = ideal.get(a.deviceId);
    if (target == null) continue; // shed wanted but gated — leave untouched
    if (a.currentLevel === 0) {
      // A managed AC must never run unrestricted — cap immediately, no gating.
      desiredLevels[a.deviceId] = target;
      continue;
    }
    if (target < a.currentLevel && canReduce) {
      desiredLevels[a.deviceId] = target;
      continue;
    }
    if (target > a.currentLevel && canRaise && !raised && toRestore.length === 0) {
      // One raise step on one AC per call — smooth, measurable ramp-up.
      desiredLevels[a.deviceId] = a.currentLevel + 1;
      raised = true;
    }
  }

  return {
    desiredLevels,
    toShed,
    toRestore,
    idealLevels: Object.fromEntries(ideal),
    nonAcLoadAmps,
    budgetAmps,
    projectedAmps,
  };
}
