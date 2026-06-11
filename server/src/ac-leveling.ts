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
  /**
   * Extra headroom kept below the breaker when RAISING (asymmetric hysteresis).
   * Raises stop this far below `limit − margin`, so a freshly-raised AC rests
   * below the limit and ordinary source-current fluctuation can't trip the
   * over-limit reduce — killing the raise→over-limit→reduce→raise limit cycle.
   * Reductions/sheds ignore this and stay on `limit − margin` (safety side).
   */
  raiseBufferAmps: number;
  comfortTargetC: number;
  /**
   * Near-target band (°C): an AC whose metric is within this band of its
   * target (active range slot's low limit, else comfortTargetC) is hard-capped
   * at L1 — the room is about to be satisfied, so spending amps there buys
   * nothing. Beyond the band the budget decides (no intermediate need caps).
   */
  nearTargetBandC: number;
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
  raiseBufferAmps: 1,
  comfortTargetC: 26,
  nearTargetBandC: 0.5,
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
  /** A recent raise bounced (raise → over-limit → forced back) — never raise above this until it clears. */
  bounceCap: number | null;
  /** A recent restore bounced (restore → over-limit → re-shed) — skip in restore selection until it clears. */
  restoreBlocked: boolean;
  /**
   * Active range slot's generator-level hard cap (explicit user intent for this
   * time window): never raise above it — including past boost floors, mirroring
   * the manual-reduction rule — but reductions/sheds below it stay allowed.
   * A live manualTarget still wins (manual beats automation). Null = Auto.
   */
  slotCap: number | null;
  /**
   * Highest generator level the firmware has actually been observed to apply.
   * Some units silently ignore their top level(s) (Najat never confirms L6) —
   * targeting one re-sends the command forever. Physics beats every intent:
   * this clamps need caps, manualTarget, bounce caps AND floors. Null = all
   * levels assumed reachable.
   */
  reachableCap: number | null;
  /**
   * Remembered stable level from before a temperature-cycling off. When set and
   * the AC just came back on below it, a raise up to this level may skip the
   * headroom-streak gate (still budget-clamped, still deferred during
   * settle/raise-hold) — we already know it was stable. Null = no warm start.
   */
  warmStartLevel: number | null;
}

export interface AllocatorInput {
  limitAmps: number;
  marginAmps: number;
  /** Raise-side hysteresis buffer — raises stop this far below `limit − margin`. */
  raiseBufferAmps: number;
  /** Near-target band (°C): needDelta ≤ band → hard L1 cap; above → budget decides. */
  nearTargetBandC: number;
  /** Estimated non-AC household draw (caller derives from measured − estimated AC draws). */
  nonAcLoadAmps: number;
  /** Consecutive power readings with measured > limit. */
  overLimitStreak: number;
  /** Consecutive power readings with measured > limit + OVER_LIMIT_SEVERE_AMPS (badly over → act faster). */
  severeOverLimitStreak: number;
  /** Consecutive power readings with measured ≤ limit − margin. */
  headroomStreak: number;
  /** Within the settle window after the last command batch. */
  inSettle: boolean;
  /** Last raise under-delivered (expected amps missing) — raises wait out the hold. */
  raiseHold?: boolean;
  /**
   * The active raise hold's expected total measured amps. While the hold
   * blocks ordinary raises, a RESTORE may still fire when this expectation
   * plus the restored floor draw fits under the buffered limit — the hold's
   * own prediction is the conservative budget (waiting out a slow compressor
   * ramp cost Abdu ~20 min off, live 2026-06-11).
   */
  raiseHoldExpectedAmps?: number | null;
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
  /**
   * Raise-budget-constrained ideal allocation for status display — the level
   * the controller will actually drive toward (stops a raise buffer below the
   * breaker), not a higher level it would never raise to.
   */
  idealLevels: Record<string, number>;
  nonAcLoadAmps: number;
  budgetAmps: number;
  projectedAmps: number;
}

/**
 * Reactive-reduction gate. When measured is only just over the limit (gen
 * current fluctuates, a single blip is noise) we wait for a longer streak; a
 * dip back below the limit resets it. When measured is clearly over (> limit +
 * OVER_LIMIT_SEVERE_AMPS) a short streak acts fast — the overload is real.
 */
export const REDUCE_STREAK = 5;
/** Readings over limit + OVER_LIMIT_SEVERE_AMPS required for a fast reactive reduction. */
export const REDUCE_STREAK_SEVERE = 2;
/** Amps above the raw limit that classify a reading as "severely" over (fast path). */
export const OVER_LIMIT_SEVERE_AMPS = 1;
/** Readings with headroom required before raising a level or restoring a shed AC. */
export const RAISE_STREAK = 6;
/** Power reading older than this means no electricity (matches /api/current/power). */
export const STALE_POWER_MS = 15_000;
/** Same noise floor the power card uses to consider a line active. */
export const NOISE_THRESHOLD = 0.1;
/** Pause after sending commands so compressors and measurements settle. */
export const SETTLE_MS = 30_000;
/**
 * Settle window for FAN-ONLY command batches. Fans draw little and stabilize
 * in seconds — pausing the whole loop 30s per fan command made restoring a
 * held fan crawl (~35s/step staged, minutes total) and blocked level raises
 * the entire time. Level/power batches keep the full SETTLE_MS.
 */
export const FAN_SETTLE_MS = 10_000;
/**
 * Consecutive unconfirmed re-sends of the SAME generator level before the
 * level is marked firmware-unreachable for that device and the allocator
 * falls back to the next lower level. Some units accept the command (cloud
 * returns OK) but never apply/report it, and without this the never-level-0
 * correction re-sends it forever. Doubles as the command retry Najat's flaky
 * firmware needs anyway. L1 is never marked (a managed AC must always get
 * SOME cap).
 *
 * History: built for "Najat never confirms L6" — which turned out to be TCL
 * REMOVING levels 4–6 from her model via firmware/app update (2026-06,
 * maxGeneratorLevel is 3 for all models now; her slow L4 confirm ~111s after
 * the first send drove the 3→4 send-budget raise on 2026-06-11). Kept as
 * general defense: it catches slow-applying or future-removed levels at any
 * max. One extra send per genuinely dead level is noise; a false mark costs
 * the room its cooling headroom.
 */
export const UNREACHABLE_LEVEL_SENDS = 4;
/**
 * Safety expiry per unreachable mark. A transient shadow-stuck-at-0 episode
 * (firmware reset) mints marks for levels that normally apply — live
 * 2026-06-11 a morning grid episode marked Najat L4–L6 and capped her at L3
 * all day despite ~19A of free budget. Expired marks are re-probed; genuinely
 * dead levels just re-mark after UNREACHABLE_LEVEL_SENDS. Mirrors
 * BOUNCE_SAFETY_EXPIRY_MS.
 */
export const UNREACHABLE_SAFETY_EXPIRY_MS = 60 * 60_000;
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
 * (raise → over-limit → reduce flap). 240s covers the measured ~4-min ramp —
 * the compressor's full steady-state draw is not real until then. Armed on a
 * turn-on AND on a power-source change (a Gen↔Grid flip restarts the compressors).
 */
export const AC_RAMP_MS = 240_000;
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
/**
 * Effect-confirmation holds: after a raise action the next raise must either
 * SEE the expected effect on the whole amp draw (early release) or wait the
 * hold out. A gen level is a CAP, not a draw command — a nearly-satisfied
 * room's compressor won't draw more when the cap rises, leaving phantom
 * headroom that would stack raises which overshoot the moment the
 * compressors do kick in. Turn-ons hold longer (compressor ramp is slow —
 * the measured ~4-min start/restart settle). A gen-level cap raise on an
 * already-running compressor settles faster, so it keeps the shorter hold;
 * early release covers needy rooms regardless.
 */
export const RAISE_HOLD_MS = 120_000;
export const RESTORE_HOLD_MS = 270_000;
/** Fresh readings needed before the effect check can release a hold (~4 × 5s ESP). */
export const RAISE_HOLD_CHECK_AFTER_MS = 20_000;
/**
 * Bounce caps: a raise whose amps arrive but push the total OVER the limit gets
 * reactively reduced right back — without memory the allocator would pick the
 * same AC again two minutes later (raise → over-limit → reduce loop). The
 * bounce records the raise's OBSERVED cost (peak measured − pre-raise measured)
 * and the device only retries once the total load drops enough to absorb that
 * observed cost under the limit. The observed cost is clamped to at most the
 * model step + this slack so a coincident background spike can't lock the cap
 * at an impossible threshold.
 */
export const BOUNCE_MAX_EXTRA_AMPS = 3;
/** Safety net: a bounce record older than this is dropped regardless (corrupted baseline insurance). */
export const BOUNCE_SAFETY_EXPIRY_MS = 3_600_000;
/**
 * How long after a raise a reactive over-limit reduction still counts as that
 * raise's BOUNCE. Decoupled from (and longer than) the effect-confirmation hold:
 * a slow limit cycle can over-limit and reduce several minutes after the raise,
 * well past RAISE_HOLD_MS — that reduce is still the raise's fault and must be
 * recorded so the allocator stops re-picking the same AC.
 */
export const BOUNCE_WINDOW_MS = 300_000;

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

/**
 * Hard floor: the boost minimum, unless the user manually reduced below it,
 * a range slot caps below it (explicit per-window intent beats the boost), or
 * the firmware can't reach it (reachableCap — physics beats every floor).
 */
function floorOf(ac: LevelerAcSnapshot): number {
  let floor = Math.max(1, Math.min(ac.minLevel, ac.maxLevel));
  if (ac.manualCap != null) floor = Math.min(floor, Math.max(1, ac.manualCap));
  if (ac.slotCap != null) floor = Math.min(floor, Math.max(1, ac.slotCap));
  if (ac.reachableCap != null) floor = Math.min(floor, Math.max(1, ac.reachableCap));
  return floor;
}

/**
 * Need cap from the near-target band: within the band of the target (the
 * active slot's low limit, else comfortTargetC — both arrive as needDelta)
 * the AC is hard-capped at L1 — the room is about to be satisfied, so amps
 * spent there buy nothing. Beyond the band the budget decides; the old mild
 * tier's ceil(max/2) intermediate cap is gone (2026-06-11 user decision).
 */
export function nearTargetNeedCap(needDelta: number, nearTargetBandC: number, maxLevel: number): number {
  return needDelta <= nearTargetBandC ? 1 : maxLevel;
}

/** Ceiling from the near-target cap / manual intents / slot caps / bounce caps, never below the floor. */
function ceilOf(ac: LevelerAcSnapshot, nearBand: number): number {
  // A manualTarget bypasses the need cap AND the slot cap (manual beats
  // automation); manualCap/slotCap intersect otherwise.
  const cap = ac.manualTarget != null
    ? ac.manualTarget
    : Math.min(nearTargetNeedCap(ac.needDelta, nearBand, ac.maxLevel), ac.manualCap ?? ac.maxLevel, ac.slotCap ?? ac.maxLevel);
  // A bounce cap also defers manualTarget-driven raises — the target stays,
  // the retry waits for the load to drop. reachableCap clamps everything:
  // a level the firmware never applies cannot be a target of any kind.
  // Hard boost floors still win (max) — except where floorOf itself clamped.
  return Math.max(
    floorOf(ac),
    Math.min(cap, ac.bounceCap ?? ac.maxLevel, ac.reachableCap ?? ac.maxLevel, ac.maxLevel),
  );
}

/**
 * Soft ceiling: surplus budget keeps raising toward max. Near-target rooms
 * stay hard at their cap (the range automation is about to turn them off /
 * the compressor idles at the setpoint), and manual intents remain hard.
 * The slot cap stays hard here too (the user picked it for this window)
 * unless a live manualTarget overrides it.
 */
function softCeilOf(ac: LevelerAcSnapshot, nearBand: number): number {
  if (ac.needDelta <= nearBand) return ceilOf(ac, nearBand);
  const slotLimit = ac.manualTarget != null ? ac.maxLevel : (ac.slotCap ?? ac.maxLevel);
  const cap = Math.min(
    ac.maxLevel,
    ac.manualCap ?? ac.maxLevel,
    ac.manualTarget ?? ac.maxLevel,
    ac.bounceCap ?? ac.maxLevel,
    ac.reachableCap ?? ac.maxLevel,
    slotLimit,
  );
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
  // Raise-side budget (asymmetric hysteresis): the fill and restore-feasibility
  // passes stop a buffer short of the real budget so a freshly-raised AC rests
  // below the limit. Reductions/sheds/over-budget keep the FULL budget — they're
  // the safety side and must trigger only when genuinely over `limit − margin`.
  // Clamp the buffer ≥0 so a bad value can never raise ABOVE `limit − margin`.
  const raiseBudgetAmps = budgetAmps - Math.max(0, input.raiseBufferAmps);
  const currentOnCost = onManaged.reduce((sum, a) => sum + draw(a, a.currentLevel), 0);
  const projectedAmps = nonAcLoadAmps + unmanagedDraw + currentOnCost;

  // Reductions/sheds need either a sustained over-limit streak (reactive) or a
  // structural change (proactive). They deliberately ignore the settle window —
  // safety first; the caller resets streaks after executing reductions.
  const canReduce =
    input.forceEvaluate ||
    input.overLimitStreak >= REDUCE_STREAK ||
    input.severeOverLimitStreak >= REDUCE_STREAK_SEVERE;
  const canRaise = !input.inSettle && !input.raiseHold && input.headroomStreak >= RAISE_STREAK;

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
  //
  // Restores are gated by settle + headroom streak but NOT blindly by the
  // raise hold: during a hold the hold's own expectation is the conservative
  // budget — a restore fits when expected + the floor draw stays under the
  // buffered limit (waiting out a slow compressor ramp cost Abdu ~20 min off,
  // live 2026-06-11).
  let restorePick: string | null = null;
  // A floor-feasible restore that is merely gated this tick parks the raises:
  // they would consume the headroom it needs and arm fresh holds that push it
  // out further ("all ACs on beats higher levels"). An INFEASIBLE restore
  // does not park anything — raises don't change floors-based feasibility,
  // so the other ACs must not starve at their floors waiting for it.
  let restoreWaiting = false;
  if (!overBudget) {
    const canRestore = !input.inSettle && input.headroomStreak >= RAISE_STREAK;
    const bufferedLimit = limitAmps - marginAmps - Math.max(0, input.raiseBufferAmps);
    // The restore batch pulls every raised AC down to the fitted ideal
    // (floors here) in the same batch — those savings count against the
    // hold's expectation (live: Abdullah's L3 hold expectation blocked Abdu's
    // restore even though the batch would have reduced Abdullah right back).
    const holdReductionSavings = onManaged.reduce(
      (sum, a) => sum + Math.max(0, draw(a, a.currentLevel) - draw(a, floorOf(a))),
      0,
    );
    // A restore that bounced (over-limit → re-shed) waits for the load to drop
    // before another attempt — the next-most-needy unblocked room goes first.
    const restoreOrder = restoreCandidates
      .filter((a) => !a.restoreBlocked)
      .sort((a, b) => b.needDelta - a.needDelta);
    for (const a of restoreOrder) {
      const floorDraw = draw(a, floorOf(a));
      // Restore is the single largest raise (a whole floor + slow compressor
      // ramp), so it honors the raise buffer too — a restored AC must settle
      // below the limit, not in the deadband where it would be re-shed.
      if (cost + floorDraw > raiseBudgetAmps) continue;
      const fitsHold =
        !input.raiseHold ||
        (input.raiseHoldExpectedAmps != null &&
          input.raiseHoldExpectedAmps - holdReductionSavings + floorDraw <= bufferedLimit);
      if (canRestore && fitsHold) {
        restorePick = a.deviceId;
        // Not in onManaged (it's off), so the fill below fits the ON ACs
        // around its floor draw without ever raising it above the floor.
        ideal.set(a.deviceId, floorOf(a));
        cost += floorDraw;
      } else {
        restoreWaiting = true;
      }
      break; // most-needy feasible room only — no queue jumping while it's gated
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
  } else if (!overBudget && !(restorePick != null && input.raiseHold)) {
    // Raise fill: spread level-by-level (everyone reaches L2 before anyone
    // gets L3); within a level the hottest-above-target room goes first;
    // priority order breaks delta ties. Two passes: need caps first, then
    // surplus budget soft-fills toward max (need caps only bite when tight).
    //
    // Skipped for a restore DURING a raise hold: its feasibility was judged
    // in expectation space with every ON AC pulled to its floor — letting
    // the fill (whose nonAcLoad-based budget is optimistic while measured
    // lags the hold) raise them back would take back the very savings the
    // restore counted on. Everyone rides at floors for this batch; the fill
    // resumes next tick.
    const nearBand = input.nearTargetBandC;
    for (const ceiling of [
      (a: LevelerAcSnapshot): number => ceilOf(a, nearBand),
      (a: LevelerAcSnapshot): number => softCeilOf(a, nearBand),
    ]) {
      for (;;) {
        let pick: LevelerAcSnapshot | null = null;
        for (const a of onManaged) {
          const level = ideal.get(a.deviceId)!;
          if (level >= ceiling(a)) continue;
          // Raise admission uses the buffered budget — never fill into the
          // deadband below the breaker (asymmetric hysteresis).
          if (cost + model(a.deviceId).stepAmps > raiseBudgetAmps) continue;
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

  // Fan restore: ONE JUMP straight back to the hold's original fan (fans cost
  // ~0.5A and stabilize in seconds — the old one-step-per-~35s staging kept
  // ACs at silent fan 1 for minutes; user re-decided 2026-06-10), highest-
  // priority pending hold first. Restoring a shed AC takes precedence; gen
  // raises wait until every held fan is back (a fan step costs fewer amps).
  const holdPending = (a: LevelerAcSnapshot): boolean =>
    a.on && a.managed && a.fanRestoreTarget != null && a.fanSpeed != null &&
    (a.fanRestoreTarget === 0 ? a.fanSpeed !== 0 : a.fanSpeed < a.fanRestoreTarget);
  const anyHoldPending = acs.some(holdPending);
  let toFanRaise: AllocationResult["toFanRaise"] = null;
  if (canRaise && !overBudget && toRestore.length === 0) {
    const pick = acs.find(holdPending);
    if (pick) {
      toFanRaise = { deviceId: pick.deviceId, fan: pick.fanRestoreTarget! };
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
    if (target > a.currentLevel && toRestore.length === 0 && !anyHoldPending && !restoreWaiting) {
      if (canRaise) {
        // Jump straight to the budget-fitted ideal — the amp model is the guess,
        // the measurement feedback loop is the adjustment.
        desiredLevels[a.deviceId] = target;
      } else if (a.warmStartLevel != null && !input.inSettle && !input.raiseHold) {
        // Warm restore: the AC just came back from a temperature cycle and we
        // remember the level it was stable at. Skip the slow headroom-streak
        // rediscovery and jump straight there — but only up to the remembered
        // level (going higher still needs a confirmed raise), still capped by
        // the budget-fitted target, and still deferred during settle/raise-hold.
        const warm = Math.min(target, a.warmStartLevel);
        if (warm > a.currentLevel) desiredLevels[a.deviceId] = warm;
      }
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
