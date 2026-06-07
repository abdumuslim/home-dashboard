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
  /** Per-AC draw model on grid (and the fallback for gen when no gen model is set). */
  ampModels: Record<string, AcAmpModel>;
  /** Optional per-AC draw model on generator — lower, fluctuating voltage means more amps. */
  genAmpModels?: Record<string, AcAmpModel>;
  levelBoosts: Record<string, AcLevelBoost>;
}

export const DEFAULT_LEVELING_CONFIG: AcLevelingConfig = {
  enabled: false,
  gridLimitAmps: 30,
  genLimitAmps: 15,
  marginAmps: 1,
  comfortTargetC: 26,
  priority: [],
  ampModels: {},
  genAmpModels: {},
  levelBoosts: {},
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
  /** Hard floor (≥1). Above 1 when an outdoor-temp boost is active (e.g. Abdullah L2 at 37°C+). */
  minLevel: number;
  needTier: NeedTier;
  /** °C above the target/satisfied point (≤0 = satisfied). Orders raises (desc) and sheds (asc). */
  needDelta: number;
  /** User manually reduced the level — never raise above this. */
  manualCap: number | null;
  /** User manually raised the level — overrides the need cap as the target. */
  manualTarget: number | null;
  /** Observed fan (0 = built-in auto); lastSetFan during settle. Null when unknown. */
  fanSpeed: number | null;
  /** Original fan to restore while a leveler fan hold is active, else null (0 = auto). */
  fanRestoreTarget: number | null;
  /** User changed the fan this over-limit episode — never fan-reduce again until it ends. */
  fanExempt: boolean;
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
  /** Power OFF + mark shed — least-needy room first, top-priority AC last. */
  toShed: string[];
  /** Power ON at the floor level + clear shed (at most one per call, most-needy first). */
  toRestore: string[];
  /** Last try before shedding: set ALL these ACs' fans to 1 instead of powering one off. */
  toFanReduce: string[];
  /** One staged fan-restore step (highest-priority pending hold first). */
  toFanRaise: { deviceId: string; fan: number } | null;
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
/**
 * Compressor ramp-up window after an AC turns ON. While ramping, the AC's
 * estimated draw is NOT subtracted from measured current when deriving the
 * non-AC load — otherwise the load briefly looks smaller than it is and a
 * near-limit turn-on wouldn't trigger the instant proactive reduction.
 *
 * Deliberately conservative double-count: as the compressor ramps, its real
 * draw bleeds into the measured-derived non-AC load WHILE its full estimate is
 * also budgeted — understating the budget during the ramp. That delays raises
 * instead of letting a not-yet-ramped compressor masquerade as headroom
 * (raise → over-limit → reduce flap). 90s covers the observed TCL ramp.
 */
export const AC_RAMP_MS = 90_000;
/** Grace before an observed-ON clears a shed flag (shadow lags the off command). */
export const SHED_CLEAR_GRACE_MS = 15_000;
/**
 * After a command batch, fresh measured readings are contaminated: compressors
 * haven't responded yet while the snapshot levels are already the new ones, so
 * `measured − establishedDraw` OVERSTATES the non-AC load and would trigger an
 * over-reduction spiral. The leveler freezes the non-AC load at its
 * pre-command value for this window. Shorter than SETTLE_MS because reductions
 * physically settle within seconds — and unlike raises, the reduce path
 * ignores the settle window, so this freeze is its only protection. A real
 * non-AC rise during the window is still caught by the raw over-limit streak
 * with at most this much extra latency.
 */
export const NON_AC_FREEZE_MS = 15_000;
/** Warn when the post-command measured total misses the prediction by more than this. */
export const PREDICTION_WARN_AMPS = 2;

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

/** Hard floor: the boost minimum, unless the user manually reduced below it. */
function floorOf(ac: LevelerAcSnapshot): number {
  let floor = Math.max(1, Math.min(ac.minLevel, ac.maxLevel));
  if (ac.manualCap != null) floor = Math.min(floor, Math.max(1, ac.manualCap));
  return floor;
}

/** Ceiling from need tier / manual intents, never below the floor. */
function ceilOf(ac: LevelerAcSnapshot): number {
  const cap = ac.manualTarget != null
    ? ac.manualTarget
    : Math.min(needCap(ac.needTier, ac.maxLevel), ac.manualCap ?? ac.maxLevel);
  return Math.max(floorOf(ac), Math.min(cap, ac.maxLevel));
}

/**
 * Soft ceiling: once everyone reaches their need cap, surplus budget keeps
 * raising toward max — need caps only bite when amps are tight. Satisfied
 * rooms stay at their cap (the range automation is about to turn them off /
 * the compressor idles at the setpoint), and manual intents remain hard.
 */
function softCeilOf(ac: LevelerAcSnapshot): number {
  if (ac.needTier === "satisfied") return ceilOf(ac);
  const cap = Math.min(ac.maxLevel, ac.manualCap ?? ac.maxLevel, ac.manualTarget ?? ac.maxLevel);
  return Math.max(floorOf(ac), cap);
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

  // Baseline: every ON managed AC at its floor (L1, or the boost minimum).
  const ideal = new Map<string, number>();
  const shedWanted: string[] = [];
  let cost = 0;
  for (const a of onManaged) {
    ideal.set(a.deviceId, floorOf(a));
    cost += draw(a, floorOf(a));
  }

  const overBudget = cost > budgetAmps;

  // Last try before shedding: ACs whose fan can still come down to level 1
  // (built-in auto counts — it may be running the fan high). A fan step saves
  // fewer amps than a gen level, but it's free comfort-wise compared to a shed.
  const fanReducible = overBudget
    ? onManaged.filter((a) =>
        !a.shed && !a.fanExempt && a.fanSpeed != null && (a.fanSpeed === 0 || a.fanSpeed > 1))
    : [];

  // Restore selection happens BEFORE the fill so the candidate's floor cost
  // shapes the fitted ideal: feasibility is judged at FLOORS, not current
  // levels — all ACs on at lower levels beats one AC raised high. Raised ACs
  // are pulled down to the new ideal in the same batch as the power-on (see
  // desiredLevels below). At most one restore per call, most-needy room first.
  // Boost floors stay hard: if the ON floors alone exceed the budget
  // (overBudget), no restore is attempted.
  let restorePick: string | null = null;
  if (canRaise && !overBudget) {
    const restoreOrder = restoreCandidates.slice().sort((a, b) => b.needDelta - a.needDelta);
    for (const a of restoreOrder) {
      const floorDraw = draw(a, floorOf(a));
      if (cost + floorDraw <= budgetAmps) {
        restorePick = a.deviceId;
        // Not in onManaged (it's off), so the fill below fits the ON ACs
        // around its floor draw without ever raising it above the floor.
        ideal.set(a.deviceId, floorOf(a));
        cost += floorDraw;
        break;
      }
    }
  }

  if (overBudget && fanReducible.length === 0) {
    // Shed the least-needy room first (smallest delta above target); the
    // top-priority AC is protected and only sheds as the last resort.
    const [top, ...rest] = onManaged;
    const shedOrder = [
      ...rest.slice().sort((a, b) =>
        a.needDelta - b.needDelta || onManaged.indexOf(b) - onManaged.indexOf(a)),
      ...(top ? [top] : []),
    ];
    for (const a of shedOrder) {
      if (cost <= budgetAmps) break;
      cost -= draw(a, ideal.get(a.deviceId)!);
      ideal.delete(a.deviceId);
      shedWanted.push(a.deviceId);
    }
  } else if (!overBudget) {
    // Raise fill: spread level-by-level (everyone reaches L2 before anyone
    // gets L3); within a level the hottest-above-target room goes first;
    // priority order breaks delta ties. Two passes: need caps first, then
    // surplus budget soft-fills toward max (need caps only bite when tight).
    for (const ceiling of [ceilOf, softCeilOf]) {
      for (;;) {
        let pick: LevelerAcSnapshot | null = null;
        for (const a of onManaged) {
          const level = ideal.get(a.deviceId)!;
          if (level >= ceiling(a)) continue;
          if (cost + model(a.deviceId).stepAmps > budgetAmps) continue;
          if (!pick) {
            pick = a;
            continue;
          }
          const pickLevel = ideal.get(pick.deviceId)!;
          if (level < pickLevel || (level === pickLevel && a.needDelta > pick.needDelta)) {
            pick = a;
          }
        }
        if (!pick) break;
        ideal.set(pick.deviceId, ideal.get(pick.deviceId)! + 1);
        cost += model(pick.deviceId).stepAmps;
      }
    }
  }
  // else: over budget with reducible fans — everyone stays in `ideal` at floor,
  // so the desiredLevels loop floors all gen levels in the same batch as the
  // fan reductions below. The shed is deferred to the next over-limit streak.

  const toShed = canReduce ? shedWanted : [];
  const toFanReduce = canReduce ? fanReducible.map((a) => a.deviceId) : [];
  const toRestore: string[] = restorePick ? [restorePick] : [];

  // Staged fan restore: one step toward the hold's original fan per call,
  // highest-priority pending hold first. Restoring a shed AC takes precedence;
  // gen raises wait until every held fan is back (a fan step costs fewer amps).
  const holdPending = (a: LevelerAcSnapshot): boolean =>
    a.on && a.managed && a.fanRestoreTarget != null && a.fanSpeed != null &&
    (a.fanRestoreTarget === 0 ? a.fanSpeed !== 0 : a.fanSpeed < a.fanRestoreTarget);
  const anyHoldPending = acs.some(holdPending);
  let toFanRaise: AllocationResult["toFanRaise"] = null;
  if (canRaise && !overBudget && toRestore.length === 0) {
    const pick = acs.find(holdPending);
    if (pick) {
      toFanRaise = {
        deviceId: pick.deviceId,
        // Original fan 0 = built-in auto — restore in one gated step (stepping
        // up through 7 first would briefly engage turbo on non-Najat units).
        fan: pick.fanRestoreTarget === 0 ? 0 : Math.min(pick.fanSpeed! + 1, pick.fanRestoreTarget!),
      };
    }
  }

  const desiredLevels: Record<string, number> = {};
  for (const a of onManaged) {
    if (toShed.includes(a.deviceId)) continue;
    const target = ideal.get(a.deviceId);
    if (target == null) continue; // shed wanted but gated — leave untouched
    if (a.currentLevel === 0) {
      // A managed AC must never run unrestricted — cap immediately, no gating.
      desiredLevels[a.deviceId] = target;
      continue;
    }
    if (a.currentLevel < floorOf(a)) {
      // Below the hard floor (e.g. boost just activated) — fix immediately;
      // jump to the full ideal only when raise gating allows.
      desiredLevels[a.deviceId] = canRaise ? target : floorOf(a);
      continue;
    }
    if (target < a.currentLevel && (canReduce || toRestore.length > 0)) {
      // Reductions accompanying a restore ride the raise gate — they only
      // make room (lower load), so the over-limit streak isn't required.
      desiredLevels[a.deviceId] = target;
      continue;
    }
    if (target > a.currentLevel && canRaise && toRestore.length === 0 && !anyHoldPending) {
      // Jump straight to the budget-fitted ideal — the amp model is the guess,
      // the measurement feedback loop is the adjustment.
      desiredLevels[a.deviceId] = target;
    }
  }

  return {
    desiredLevels,
    toShed,
    toRestore,
    toFanReduce,
    toFanRaise,
    idealLevels: Object.fromEntries(ideal),
    nonAcLoadAmps,
    budgetAmps,
    projectedAmps,
  };
}
