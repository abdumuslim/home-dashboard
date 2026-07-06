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
   * Default 0.2 since 2026-06-25: the meter-anchored overhaul + the trip guards
   * (leaky bucket, emergency fast-path, gen one-step pacing) replaced the static
   * deadband, so the buffer is now just a thin cushion that keeps the resting
   * draw a sliver off the breaker (0 rode right at it — live ~14.7A on 15A gen)
   * while still using nearly all the headroom; raise it further to restore a
   * wider hysteresis margin if a source ever limit-cycles near its breaker.
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
  /**
   * Max levels an AC may be raised in ONE allocation batch, per source. A gen/
   * grid level is a CAP, not a setpoint: releasing it surges a hot/pinned
   * compressor by more than the static model predicts, so a batch that jumps
   * several levels (or all ACs at once) overshoots the breaker. One step (1)
   * paces a raise so its real surge confirms on the meter — and the learned
   * surge gate can block the next step — before climbing again. Production ACs
   * are 3-level, so any value ≥ 2 is effectively NO pacing (L1→L3 fits in one
   * batch). Optional/back-compat: absent → defaults to 1. Grid got these in
   * 2026-06-19 after a 32A grid overshoot the gen-only pacing didn't cover.
   */
  maxRaiseStepGrid?: number;
  maxRaiseStepGen?: number;
}

export const DEFAULT_LEVELING_CONFIG: AcLevelingConfig = {
  enabled: false,
  gridLimitAmps: 30,
  genLimitAmps: 15,
  marginAmps: 1,
  raiseBufferAmps: 0.2,
  comfortTargetC: 26,
  nearTargetBandC: 0.5,
  priority: [],
  ampModels: {},
  genAmpModels: {},
  levelBoosts: {},
  maxRaiseStepGrid: 1,
  maxRaiseStepGen: 1,
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
  /**
   * Real smoothed measured household current (the meter). When provided AND
   * `meterTrusted`, the raise fill is anchored to the METER instead of the
   * model: re-filling an AC back up to its CURRENT level is free (its draw is
   * already in `measured`) and a genuine raise ABOVE current must fit
   * `measured + Σ surge ≤ raise budget`. This is the fix for the chronically
   * wrong static model (grid over-predicts settled draw by +8…12A): the model
   * sum refused to seat ACs the meter fits fine, and reduced ACs the meter would
   * keep (the live "fight loop"). Absent → legacy model-space fill (tests).
   */
  measuredAmps?: number;
  /**
   * The meter currently reflects the true managed-AC load — NOT mid-ramp after a
   * turn-on/changeover and not during a power-collapse latch, with ≥4 readings.
   * Gates the meter-anchored fill: while an AC is ramping the meter under-reads
   * its eventual draw, so proactive turn-on reductions must still use the model.
   */
  meterTrusted?: boolean;
  /**
   * The meter is untrusted ONLY because a managed AC is mid-ramp, and the
   * ramp-projected total (measured + each ramping AC's remaining growth up to
   * its current level) still fits `limit − margin`. While true, PURE
   * budget-driven reductions below current are skipped — the model fill runs
   * during ramps and its chronic error otherwise "reduces" ACs the meter has
   * room for, bouncing a peer's level on EVERY automation on/off cycle (live
   * 2026-07-05: Abdullah L3↔L2 on each of Najat's temperature cycles).
   * Cap-driven reductions (slot/manual/reachable), floors, restores-with-
   * reduction, startAtFloors, and every over-limit path are unaffected.
   */
  rampMeterFits?: boolean;
  /**
   * First allocation after a source changeover: hold every ON managed AC at its
   * FLOOR (skip the raise fill AND warm restore) so a grid→gen flip drops to L1
   * and the meter-confirmed gate climbs back, instead of landing on the model-
   * fitted gen ideal (L2) and surging a hot compressor into a trip.
   */
  startAtFloors?: boolean;
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
  /**
   * Per-AC amps to charge when raising ABOVE the current level — the REAL
   * compressor surge of releasing a cap, used for raise admission instead of
   * the model step. A gen level is a cap, not a setpoint: the static model
   * understates the surge on a hot/pinned compressor (live: observed 3.5A vs a
   * 2.0A model step), so model-based raises overshoot the breaker. The leveler
   * learns this per AC/source from observed raise effects + bounce costs.
   * Absent (or below the model step) → the model step is used. Grid started
   * passing this in 2026-06-19 (the model under-predicted by ~17A and three
   * uncapped ACs reached 32A), so a wrong static model no longer admits an
   * over-budget grid raise.
   */
  raiseSurge?: Record<string, number>;
  /**
   * Max levels an AC may be raised ABOVE its current level in ONE allocation.
   * Set to 1 on BOTH sources (one step, confirm the surge on the meter, then the
   * next) so a single batch can never commit more than one step's surge —
   * bounding overshoot. Grid joined gen in 2026-06-19. Re-filling up to the
   * current level and reductions are unaffected.
   */
  maxRaiseStep?: number;
  /**
   * Per-AC learned amps per FAN-level step (gen) — the real cost of raising the
   * fan one speed. Fans aren't in the amp model, so a held fan used to restore
   * straight to its original on a flat 0.5A guess; the real swing is bigger, so
   * the full jump re-pushed the meter over → drop to 1 → bounce (no sweet spot).
   * With the learned cost a restore climbs only to the highest level that fits
   * the buffered budget and settles there. Absent → falls back to the 0.5A
   * heuristic (FAN_REDUCE_SAVINGS_AMPS).
   */
  fanStepCost?: Record<string, number>;
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
/**
 * Over-limit leaky-bucket capacity, in "points" (2026-06-17). The leveler drains
 * points on over-limit readings and acts when the bucket empties — an integral /
 * I²t-style trip that tolerates brief fluctuation around the limit but accumulates
 * a sustained or oscillating overload (replacing the consecutive streaks that
 * reset on any single dip). User's rule: a reading > limit + OVER_LIMIT_SEVERE_AMPS
 * costs 3 points, within that costs 1; 5 points = act. No instant-act tier — a
 * single turn-on inrush spike drains ≤3 of 5 and refills on sustained calm, so it
 * can't false-trigger. Severe drain (3) is sized so 2 severe readings (6 ≥ 5)
 * still trip the fast path while mild overloads tolerate 5 readings.
 */
export const OVER_LIMIT_BUDGET = 5;
/** Points drained by a reading more than OVER_LIMIT_SEVERE_AMPS over the limit. */
export const OVER_LIMIT_DRAIN_SEVERE = 3;
/** Points drained by a reading within OVER_LIMIT_SEVERE_AMPS over the limit. */
export const OVER_LIMIT_DRAIN_MILD = 1;
/** Readings with headroom required before raising a level. */
export const RAISE_STREAK = 6;
/**
 * Shorter streak for RESTORING a fully-OFF shed AC (~15s vs the 30s a level raise
 * waits). Turning a room the leveler shed back on is high-value the moment budget
 * is there — the user's complaint was the restore lagging while budget was free.
 * The raise buffer (a restored floor must fit under `limit − margin − raiseBuffer`)
 * and bounce detection (a restore that re-breaches is blocked) remain the
 * oscillation guards, so a shorter confirmation is safe.
 */
export const RESTORE_SHED_STREAK = 3;
/**
 * A measured-current drop at least this large (median of the recent readings vs
 * the new reading), when we did NOT command it (outside the settle window),
 * signals a probable breaker trip / blackout — the ACs are commanded ON but no
 * longer drawing. The biggest single leveler cut is ~one AC and lands inside the
 * settle window, so a drop this large OUTSIDE settle is a power event, not our
 * own action. While latched, raises/restores are frozen: the low post-trip
 * readings would otherwise build the headroom streak and raise an AC into a dead
 * line (live 2026-06-13: the leveler raised Najat reading 3.7A as ~11A of free
 * budget, worsening the recovery surge).
 */
export const POWER_COLLAPSE_DROP_AMPS = 6;
/**
 * …AND the reading must land at or below this absolute floor. A trip leaves only
 * the small non-AC base load on the meter (live: ~3.7A), whereas a legitimate
 * demand drop or a single-AC reduction still leaves the other ACs drawing (well
 * above this). The floor is what separates "the AC load vanished (trip)" from
 * "the load merely dropped" — without it, the bounce retry-clear path (which
 * deliberately drops the load to re-allow a raise) reads as a false trip.
 */
export const POWER_COLLAPSE_FLOOR_AMPS = 5;
/**
 * A latched power collapse clears (raises resume, ramp re-arms for ON ACs) once
 * measured climbs back to within this of the pre-collapse median — the AC load
 * returned, so a fresh headroom streak can safely re-time raises.
 */
export const POWER_COLLAPSE_RECOVER_GAP = 3;
/**
 * Safety cap: a collapse that never "recovers" to near its pre-collapse median
 * (e.g. the household load legitimately dropped) stops freezing raises after
 * this long, so the freeze can never strand the leveler.
 */
export const POWER_COLLAPSE_MAX_MS = 300_000;
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
/**
 * Max time the leveler keeps re-asserting floors after a gen changeover before
 * giving up (the firmware-never-applies backstop). A gen changeover restarts the
 * compressors and the TCL firmware often comes back ABOVE the commanded floor; a
 * single forceEvaluate tick fired once and went quiet, so the unit drifted over
 * the breaker. We re-send the floor-down until the real shadow confirms it (and
 * the ramp passes), bounded by this cap so a truly stuck device doesn't enforce
 * forever — normal over-limit handling resumes after.
 */
export const ENFORCE_GEN_FLOORS_MAX_MS = 300_000;
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
/**
 * A raise is only CAPPED as a bounce when the measured cost overshot the amp
 * model by more than this. An accurate model that still tipped over the limit
 * was raised into a thin budget (a transient nonAcLoad misread), not a wrong
 * model — capping it at L1 until the load drops by its full cost stranded rooms
 * for up to an hour (live: Najat/Abdu at L1 7–61 min with `observed ≈ model`).
 * Below this tolerance the reduction still ships (safety), but no sticky cap is
 * set: the normal raise gate (buffer + headroom streak) re-times the raise.
 */
export const BOUNCE_MODEL_TOLERANCE_AMPS = 1;
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
export function floorOf(ac: LevelerAcSnapshot): number {
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
  // Marginal amps for raising `ac` from `fromLevel` to `fromLevel + 1` during
  // the fill. A step that lands ABOVE the current level is a genuine new raise
  // and is charged the learned surge (≥ the model step) so the admission can't
  // commit a raise the real compressor surge would push over the breaker.
  // A step at/below the current level merely re-fills the baseline back up to
  // where the AC already is (a no-op command, no surge) — it uses the model.
  const raiseStepCost = (ac: LevelerAcSnapshot, fromLevel: number): number => {
    const step = model(ac.deviceId).stepAmps;
    if (fromLevel < ac.currentLevel) return step;
    return Math.max(step, input.raiseSurge?.[ac.deviceId] ?? step);
  };

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
  // The real-meter raise ceiling: the measured TOTAL already includes non-AC
  // load, so a meter-anchored raise compares `measured + surge` against the
  // buffered LIMIT (not `raiseBudgetAmps`, which has non-AC load subtracted out
  // — that would double-count it).
  const bufferedLimitAmps = limitAmps - marginAmps - Math.max(0, input.raiseBufferAmps);
  const currentOnCost = onManaged.reduce((sum, a) => sum + draw(a, a.currentLevel), 0);
  const projectedAmps = nonAcLoadAmps + unmanagedDraw + currentOnCost;

  // Meter-anchored fill is engaged only when the meter is trustworthy AND the
  // real total is below the limit band. When measured is over `limit − margin`
  // (genuine over-limit) we fall back to the model fill so a reduction still
  // SIZES correctly (drops toward the fitted ideal) instead of all the way to
  // floors. `measuredAmps` undefined (tests) → legacy model fill everywhere.
  const meterRoom =
    input.meterTrusted === true &&
    input.measuredAmps != null &&
    input.measuredAmps <= limitAmps - marginAmps;

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
    // Restoring a shed AC (a fully-OFF room) uses the shorter RESTORE_SHED_STREAK
    // — it's the single highest-value raise and the user wants it back the moment
    // it genuinely fits under the limit (UN-buffered — see the feasibility note
    // below). Level raises still wait the full RAISE_STREAK and keep the buffer.
    const canRestore = !input.inSettle && input.headroomStreak >= RESTORE_SHED_STREAK;
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
      // A whole-room restore fits the UN-buffered budget (`limit − margin`), not
      // a full raise-buffer below it (2026-06-18, user): the leveler sheds at the
      // limit but used to only restore `limit − margin − raiseBuffer`, leaving a
      // room shed in a ~1.2A deadband even though it ran fine — live, Abdu shed at
      // 15A would not auto-restore though he was stable at 14.5A, so the user had
      // to turn him on by hand. A room being OFF is worse than riding near the
      // limit; the restore-bounce guard (restoreBlocked after a restore →
      // over-limit → re-shed) is the oscillation safety net, not a static
      // deadband. Level raises keep the buffer — their limit cycle is what it
      // was built for. The hold-feasibility check below stays buffer-conservative
      // (a pending raise's effect is still uncertain).
      if (cost + floorDraw > budgetAmps) continue;
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
    // Even at floors the ON ACs don't fit — power some OFF. The cost-aware
    // optimizer picks the least-disruptive shed set covering the floor-budget
    // shortfall (everyone is already pinned to floors here, so only sheds are
    // available): a satisfied/cool room before a hot one, fewer rooms over a
    // single big shed when over-cut is comparable, the top-priority AC last.
    const shedPlan = selectReduction(onManaged, cost - budgetAmps, {
      ampModels: input.ampModels,
      fromFloor: true,
    });
    for (const id of shedPlan.toShed) {
      cost -= draw(onManaged.find((a) => a.deviceId === id)!, ideal.get(id)!);
      ideal.delete(id);
      shedWanted.push(id);
    }
  } else if (!overBudget && !(restorePick != null && input.raiseHold) && !input.startAtFloors) {
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
    // resumes next tick. Also skipped right after a changeover (`startAtFloors`)
    // so a grid→gen flip lands on floors, not the model-fitted gen ideal.
    //
    // `meterProjected` tracks the REAL meter as raises commit: re-filling an AC
    // back up to its current level adds nothing (already in `measured`); only a
    // step ABOVE current charges its surge. Used by the meter-anchored admission
    // (meterRoom) so the over-predicting model can't refuse a raise the meter
    // fits, nor a re-fill the meter would keep.
    const nearBand = input.nearTargetBandC;
    // During a restore the model fill is used (its feasibility was judged at
    // FLOORS so the restored room fits — re-filling the others back up on the
    // meter would take back the room the restore needs). Meter-anchoring resumes
    // next tick once the restored AC is ON and reflected in `measured`.
    const useMeterFill = meterRoom && restorePick == null;
    let meterProjected = input.measuredAmps ?? 0;
    for (const ceiling of [
      (a: LevelerAcSnapshot): number => ceilOf(a, nearBand),
      (a: LevelerAcSnapshot): number => softCeilOf(a, nearBand),
    ]) {
      for (;;) {
        let pick: LevelerAcSnapshot | null = null;
        let pickCost = 0;
        for (const a of onManaged) {
          const level = ideal.get(a.deviceId)!;
          if (level >= ceiling(a)) continue;
          // Raise admission uses the buffered budget AND the real step cost (the
          // learned surge for an above-current step) — never fill into the
          // deadband, and never commit a raise the surge would push over.
          const stepCost = raiseStepCost(a, level);
          const aboveCurrent = level >= a.currentLevel;
          if (useMeterFill) {
            // Anchored to the meter: re-fill to current is free; a real raise
            // above current must fit measured + its surge under the buffered LIMIT
            // (measured already includes non-AC load).
            if (aboveCurrent && meterProjected + stepCost > bufferedLimitAmps) continue;
          } else if (cost + stepCost > raiseBudgetAmps) {
            continue;
          }
          if (!pick) {
            pick = a;
            pickCost = stepCost;
            continue;
          }
          const pickLevel = ideal.get(pick.deviceId)!;
          if (level < pickLevel || (level === pickLevel && a.needDelta > pick.needDelta)) {
            pick = a;
            pickCost = stepCost;
          }
        }
        if (!pick) break;
        const pickFrom = ideal.get(pick.deviceId)!;
        ideal.set(pick.deviceId, pickFrom + 1);
        cost += pickCost;
        if (useMeterFill && pickFrom >= pick.currentLevel) meterProjected += pickCost;
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
  // Sweet-spot fan restore (2026-06-18 — "it keeps bouncing 1↔full, can't find
  // the sweet spot"): a held fan climbs only to the HIGHEST level that fits the
  // buffered budget, not straight to its original. Fans aren't modeled, so the
  // restore is sized by the LEARNED per-step cost (fanStepCost; falls back to the
  // 0.5A heuristic). The headroom available for the fan is the buffered budget
  // minus the gen-level cost; the chosen level lands a buffer below the limit so
  // it settles instead of re-pushing the meter over → drop to 1 → bounce. A
  // numeric target climbs step-wise to its sweet spot; an `auto` target can't be
  // subdivided, so it restores only when the full auto cost fits (else it holds).
  if (canRaise && !overBudget && toRestore.length === 0) {
    const pick = acs.find(holdPending);
    if (pick) {
      const stepCost = Math.max(0.1, input.fanStepCost?.[pick.deviceId] ?? FAN_REDUCE_SAVINGS_AMPS);
      const headroom = raiseBudgetAmps - currentOnCost; // amps free for the fan to climb into
      const target = pick.fanRestoreTarget!;
      const curFan = pick.fanSpeed!;
      if (target === 0) {
        // Auto: one indivisible cost — restore to auto only if it fully fits.
        if (headroom >= stepCost) toFanRaise = { deviceId: pick.deviceId, fan: 0 };
      } else {
        const maxSteps = Math.max(0, Math.floor(headroom / stepCost));
        const k = Math.min(target, curFan + maxSteps);
        if (k > curFan) toFanRaise = { deviceId: pick.deviceId, fan: k };
      }
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
    if (target < a.currentLevel && (canReduce || toRestore.length > 0 || input.startAtFloors)) {
      // Reductions accompanying a restore ride the raise gate — they only
      // make room (lower load), so the over-limit streak isn't required.
      // `startAtFloors` (a gen changeover) ungates the floor-down the same way:
      // the fill is skipped so `target` IS the floor, and the firmware can come
      // back above it after a changeover, so the floor must be RE-ASSERTED every
      // tick the shadow still reads high — not fired once and dropped when the
      // over-limit streak (canReduce) is quiet.
      //
      // Ramp clamp (2026-07-06): a peer's power flip forces evaluation mid-ramp,
      // where the model fill (not the meter) computes targets — its chronic
      // error then "reduces" ACs the real meter has room for. With zero
      // over-limit evidence and the ramp-projected meter total fitting the
      // band, hold the current level; the leaky bucket / emergency path remain
      // the safety net if the projection is wrong. Explicit-intent caps
      // (slot/manual/reachable/max) still reduce immediately.
      const hardCeil = Math.min(
        a.maxLevel,
        a.manualCap ?? a.maxLevel,
        a.slotCap ?? a.maxLevel,
        a.reachableCap ?? a.maxLevel,
      );
      const capDriven = a.currentLevel > hardCeil;
      if (
        input.rampMeterFits === true &&
        !capDriven &&
        input.overLimitStreak === 0 &&
        input.severeOverLimitStreak === 0 &&
        toRestore.length === 0 &&
        !input.startAtFloors
      ) {
        continue;
      }
      desiredLevels[a.deviceId] = target;
      continue;
    }
    if (target > a.currentLevel && toRestore.length === 0 && !anyHoldPending && !restoreWaiting) {
      if (canRaise) {
        // Raise toward the budget-fitted ideal, but only ONE level per batch on
        // the generator (maxRaiseStep): a gen level is a cap, and releasing it
        // surges a hot compressor unpredictably, so confirm each step's surge on
        // the meter before the next. Grid (maxRaiseStep undefined) jumps straight
        // to the ideal — the model is the guess, the meter is the adjustment.
        desiredLevels[a.deviceId] = input.maxRaiseStep != null
          ? Math.min(target, a.currentLevel + input.maxRaiseStep)
          : target;
      } else if (a.warmStartLevel != null && !input.inSettle && !input.raiseHold && !input.startAtFloors) {
        // Warm restore: the AC just came back from a temperature cycle and we
        // remember the level it was stable at. Skip the slow headroom-streak
        // rediscovery and jump straight there — but only up to the remembered
        // level (going higher still needs a confirmed raise), still capped by
        // the budget-fitted target. Suppressed right after a changeover
        // (`startAtFloors`) so a warm AC doesn't jump back above floor before the
        // meter confirms gen headroom.
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

// ---------------------------------------------------------------------------
// Emergency reduction — the severe over-limit fast path (2026-06-12).
//
// computeAllocation sizes reductions from the MODEL (budget = limit − margin −
// nonAcLoad, where nonAcLoad itself is measured − Σ estimates): when an amp
// model under-credits an AC, the allocator can conclude ideal == current and
// ship NOTHING while the meter reads 1A+ over (live: the 31A grid incident —
// the breaker tripped). This path sizes the cut from the METER instead: the
// caller derives requiredSavingsAmps from the actual severe readings and the
// greedy below builds the SMALLEST cut set whose estimated savings cover it —
// calculated, not extreme (user: no over-reduction that lands far under the
// limit and then re-raises until stable).

/**
 * Heuristic amps saved by one fan-to-1 drop. Fans are small consumers (live
 * observations ≈ 0.5A); used for emergency batch accounting only — level cuts
 * use the calibrated amp models.
 */
export const FAN_REDUCE_SAVINGS_AMPS = 0.5;
/**
 * Window after an emergency batch during which a NEW severe streak is
 * discounted by that batch's in-flight estimated savings — compressors take
 * seconds to respond, and cutting again before the meter reflects the first
 * batch would stack cuts (the over-reduction the user explicitly rejected).
 * Same physics as the post-command nonAcLoad freeze.
 */
export const EMERGENCY_PENDING_MS = NON_AC_FREEZE_MS;

// ---------------------------------------------------------------------------
// Cost-aware reduction optimizer (2026-06-13) — replaces the greedy shed/cut
// ordering in BOTH the normal over-budget path and the emergency fast-path.
//
// Given a meter- or model-derived savings target, it enumerates every feasible
// end-state for the (few) managed ACs — keep / level-down to any floor-
// respecting level / power OFF, optionally a fan-to-1 drop — and returns the
// LEXICOGRAPHICALLY least-disruptive plan that covers the target:
//   0. feasible (covers the target) beats infeasible;
//   1. minimize the NEED of the rooms turned off — shed the most satisfied rooms
//      and keep the hot ones running. This is need-based, NOT priority-based: a
//      cool high-priority room is shed before a hot low-priority one (the live
//      complaint — abdu, hot, was shed to protect a cool higher-priority room);
//   2. need-weighted disruption (shed ≫ level ≫ fan; cutting a HOT room costs
//      more than a satisfied one; changing the top-priority AC's level carries a
//      small surcharge so it is cut last among levels; re-shedding a bounced AC
//      is penalized) — leveling a hot room, or shedding cool rooms (even two),
//      always beats shedding the hot room;
//   3. over-cut (land just under the limit, never deep below — the user's
//      explicit anti-over-reduction rule), bucketed so noise can't outweigh (2);
//   4. fewer device commands; then fewer ACs disturbed.
// Over-cut is deliberately NOT primary: a minimal-over-cut end-state sits on the
// knife edge at limit−margin and re-triggers every tick (the limit cycle the
// raise buffer exists to kill). The search is REDUCE-ONLY — raises/restores stay
// in computeAllocation's fill so the raise-buffer hysteresis is never bypassed.
// The never-level-0 invariant is folded in: an observed level-0 AC has no "keep"
// candidate (its only states are a cap to [floor..ceilCap] or a shed), so every
// enumerated plan re-caps it, and the smallest cap (top commandable level) wins
// unless more savings are owed.

export interface ReductionWeights {
  /** Per-AC penalty for powering a room OFF (× its need weight). */
  shed: number;
  /** Per level-step dropped (× its need weight). */
  levelStep: number;
  /** Per fan-to-1 drop (× its need weight). */
  fan: number;
  /**
   * needWeight = 1 + needK·max(0, needDelta): cutting a hotter room costs more.
   * This alone keeps a HOT room running: shedding it (shed × ~4) dwarfs leveling
   * it (level ≪ shed) or shedding a satisfied room (shed × 1) — so the optimizer
   * levels the hot room or sheds cool rooms (even two) before ever shedding it.
   */
  needK: number;
  /**
   * Surcharge for changing the top-priority AC's level — keeps it untouched
   * while a non-top plan covers, and cut LAST among levels. Kept SMALL (≈ one
   * level step, well below a shed) so nudging the priority room down a level
   * stays cheaper than shedding a peer — leveling never pushes the optimizer
   * into turning a room off. Shed protection is need-based (see `shedNeed`),
   * not priority-based: a cool high-priority room is shed before a hot one.
   */
  topPriority: number;
  /** Surcharge for re-shedding an AC whose restore recently bounced — anti-thrash. */
  bounceShed: number;
}

export const DEFAULT_REDUCTION_WEIGHTS: ReductionWeights = {
  shed: 100,
  levelStep: 10,
  fan: 1,
  needK: 1.5,
  topPriority: 25,
  bounceShed: 400,
};

export interface ReductionPlan {
  /** Level-change commands: deviceId → new level (changed, non-shed ACs only). */
  desiredLevels: Record<string, number>;
  /** Power OFF — emitted least-needy first, top-priority last. */
  toShed: string[];
  /** Drop to fan 1 — same ordering. */
  toFanReduce: string[];
  /** End-state level of every non-shed AC (for status / projected-amps parity). */
  idealLevels: Record<string, number>;
  estimatedSavingsAmps: number;
  overCutAmps: number;
  /** Whether the plan covers requiredSavingsAmps. */
  satisfied: boolean;
}

export interface SelectReductionOptions {
  ampModels: Record<string, AcAmpModel>;
  weights?: ReductionWeights;
  /** Reduce from each AC's floor (normal over-budget path): only shed is available. */
  fromFloor?: boolean;
  /**
   * Learned per-AC real per-level cost (gen). When it exceeds the static model
   * step, the reduction sizing uses it so a level-down is credited at its REAL
   * savings — otherwise an under-stating model makes a level-down look too small
   * to cover the overshoot and the optimizer sheds (turns the AC OFF) instead.
   */
  raiseSurge?: Record<string, number>;
}

/** Never-level-0 re-entry ceiling: top commandable level, clamped by physics /
 *  user caps, never below the floor. */
function ceilCapOf(ac: LevelerAcSnapshot): number {
  return Math.max(
    floorOf(ac),
    Math.min(
      ac.maxLevel,
      ac.reachableCap ?? ac.maxLevel,
      ac.slotCap ?? ac.maxLevel,
      ac.manualCap ?? ac.maxLevel,
    ),
  );
}

interface AcMove {
  level: number | null; // end level, or null = shed/off
  fanDrop: boolean;
  savings: number;
  cost: number;
  commands: number;
  disturbed: boolean;
  /** max(0, needDelta) when this move sheds the AC, else 0 — summed to protect hot rooms. */
  shedNeed: number;
}

interface ComboScore {
  combo: AcMove[];
  savings: number;
  cost: number;
  commands: number;
  disturbed: number;
  /** Σ need of the rooms this plan powers OFF — minimized so a HOT room is shed last. */
  shedNeed: number;
  feasible: boolean;
}

/** Output order for shed/fan arrays: least-needy first, top-priority last —
 *  matches the historical shed-order semantics. acs are pre-sorted by priority. */
function reductionOutputOrder(acs: LevelerAcSnapshot[]): LevelerAcSnapshot[] {
  const [top, ...rest] = acs;
  const sorted = rest.slice().sort((a, b) =>
    a.needDelta - b.needDelta || acs.indexOf(b) - acs.indexOf(a));
  return top ? [...sorted, top] : sorted;
}

/** True when candidate `a` is strictly preferred over the incumbent `b`. */
function reductionBetter(a: ComboScore, b: ComboScore, required: number): boolean {
  if (a.feasible !== b.feasible) return a.feasible;
  if (a.feasible) {
    // Protect HOT rooms first: shed the rooms that need cooling LEAST (priority
    // is a tiebreak baked into `cost`, not a hard shield — a cool high-priority
    // room is shed before a hot low-priority one). Bucketed so trivial need
    // differences don't override the disruption cost below.
    const an = Math.round(a.shedNeed * 10);
    const bn = Math.round(b.shedNeed * 10);
    if (an !== bn) return an < bn;
    // EPS-guarded so float-rounding noise in need-weighted sums can't flip the
    // choice tick-to-tick (deterministic plan = no thrash).
    if (Math.abs(a.cost - b.cost) > 1e-9) return a.cost < b.cost;
    const ao = Math.round(Math.max(0, a.savings - required) * 2);
    const bo = Math.round(Math.max(0, b.savings - required) * 2);
    if (ao !== bo) return ao < bo; // less over-cut (bucketed to 0.5A)
    if (a.commands !== b.commands) return a.commands < b.commands;
    return a.disturbed < b.disturbed;
  }
  // Both infeasible (no plan covers the target): take the most savings we can.
  if (a.savings !== b.savings) return a.savings > b.savings;
  return a.cost < b.cost;
}

/**
 * Pure reduction planner. `acs` are the ON, managed, non-shed candidates,
 * pre-sorted by priority (highest first). Returns the least-disruptive plan
 * (levels/fans/sheds) whose estimated savings cover `requiredSavingsAmps`, or —
 * if even cutting everything falls short — the maximum-savings plan with
 * `satisfied=false`. Honors floors, boost minimums, near-target/reachable/slot/
 * manual caps (via floorOf/ceilCapOf), and the never-level-0 invariant.
 */
export function selectReduction(
  acs: LevelerAcSnapshot[],
  requiredSavingsAmps: number,
  opts: SelectReductionOptions,
): ReductionPlan {
  const w = opts.weights ?? DEFAULT_REDUCTION_WEIGHTS;
  // Use the learned per-level cost when it exceeds the static model step, so a
  // level-down's estimated savings reflect reality (prefer level-down over shed).
  const model = (id: string): AcAmpModel => {
    const base = opts.ampModels[id] ?? DEFAULT_AMP_MODEL;
    const surge = opts.raiseSurge?.[id];
    return surge != null && surge > base.stepAmps ? { ...base, stepAmps: surge } : base;
  };
  const draw = (ac: LevelerAcSnapshot, level: number): number =>
    estimateAcDraw(level, ac.maxLevel, model(ac.deviceId));
  const needWeight = (ac: LevelerAcSnapshot): number => 1 + w.needK * Math.max(0, ac.needDelta);
  const topId = acs[0]?.deviceId ?? null;

  const perAc = acs.map((ac, index) => {
    const floor = floorOf(ac);
    const fromLevel = opts.fromFloor ? floor : ac.currentLevel;
    const baselineDraw = draw(ac, fromLevel);
    const reducibleFan =
      !ac.fanExempt && ac.fanSpeed != null && (ac.fanSpeed === 0 || ac.fanSpeed > 1);
    // Upper candidate level: the observed level, except an unrestricted (0) AC
    // re-enters at its top commandable level (never-level-0), and the floor
    // path only ever sheds.
    const upper = opts.fromFloor
      ? floor
      : ac.currentLevel > 0
        ? ac.currentLevel
        : ceilCapOf(ac);
    const isTop = ac.deviceId === topId;
    // Step count uses an effective "level 0 = one above max" so a re-cap of an
    // unrestricted AC counts as a single step (smallest-cut re-entry).
    const effFrom = fromLevel > 0 ? fromLevel : ac.maxLevel + 1;
    const moves: AcMove[] = [];
    for (let level = floor; level <= upper; level++) {
      const steps = Math.max(0, effFrom - level);
      const levelChanged = level !== ac.currentLevel;
      const levelSavings = baselineDraw - draw(ac, level);
      for (const fanDrop of reducibleFan ? [false, true] : [false]) {
        const disturbed = levelChanged || fanDrop;
        let cost = steps * w.levelStep * needWeight(ac);
        if (fanDrop) cost += w.fan * needWeight(ac);
        if (levelChanged && isTop) cost += w.topPriority; // fan drops of top stay cheap
        moves.push({
          level,
          fanDrop,
          savings: levelSavings + (fanDrop ? FAN_REDUCE_SAVINGS_AMPS : 0),
          cost,
          commands: (levelChanged ? 1 : 0) + (fanDrop ? 1 : 0),
          disturbed,
          shedNeed: 0,
        });
      }
    }
    // Power-off state. A higher-priority room costs an epsilon more to shed
    // (priority breaks equal-need ties — lowest priority off first); need is the
    // real driver via the shedNeed comparison term.
    let shedCost = w.shed * needWeight(ac) + (acs.length - 1 - index) * 1e-3;
    if (ac.restoreBlocked) shedCost += w.bounceShed;
    moves.push({
      level: null, fanDrop: false, savings: baselineDraw, cost: shedCost,
      commands: 1, disturbed: true, shedNeed: Math.max(0, ac.needDelta),
    });
    return { ac, moves };
  });

  // Exhaustive cartesian search — ≤3 ACs × ~7 moves ≈ a few hundred leaves.
  const EPS = 1e-9;
  let best: ComboScore | null = null;
  const combo: AcMove[] = new Array(perAc.length);
  const recurse = (
    i: number, savings: number, cost: number, commands: number, disturbed: number, shedNeed: number,
  ): void => {
    if (i === perAc.length) {
      const candidate: ComboScore = {
        combo: combo.slice(),
        savings, cost, commands, disturbed, shedNeed,
        feasible: savings >= requiredSavingsAmps - EPS,
      };
      if (best == null || reductionBetter(candidate, best, requiredSavingsAmps)) best = candidate;
      return;
    }
    for (const mv of perAc[i].moves) {
      combo[i] = mv;
      recurse(
        i + 1, savings + mv.savings, cost + mv.cost, commands + mv.commands,
        disturbed + (mv.disturbed ? 1 : 0), shedNeed + mv.shedNeed,
      );
    }
  };
  recurse(0, 0, 0, 0, 0, 0);

  const chosen = best ?? { combo: [], savings: 0, cost: 0, commands: 0, disturbed: 0, shedNeed: 0, feasible: requiredSavingsAmps <= EPS };
  const moveOf = new Map<string, AcMove>();
  perAc.forEach((p, i) => moveOf.set(p.ac.deviceId, chosen.combo[i]));
  const desiredLevels: Record<string, number> = {};
  const idealLevels: Record<string, number> = {};
  const toShed: string[] = [];
  const toFanReduce: string[] = [];
  for (const ac of reductionOutputOrder(acs)) {
    const mv = moveOf.get(ac.deviceId);
    if (!mv) continue;
    if (mv.level == null) { toShed.push(ac.deviceId); continue; }
    idealLevels[ac.deviceId] = mv.level;
    // Reduce-only contract: in fromFloor mode (normal over-budget shed) never
    // emit a RAISE — if a boost floor sits above the observed level the keep-
    // move is `floor` > currentLevel; the caller only consumes `toShed`, but
    // suppress it so a future caller can't ship a raise mid-over-budget.
    if (mv.level !== ac.currentLevel && !(opts.fromFloor && mv.level > ac.currentLevel)) {
      desiredLevels[ac.deviceId] = mv.level;
    }
    if (mv.fanDrop) toFanReduce.push(ac.deviceId);
  }
  return {
    desiredLevels,
    toShed,
    toFanReduce,
    idealLevels,
    estimatedSavingsAmps: chosen.savings,
    overCutAmps: Math.max(0, chosen.savings - requiredSavingsAmps),
    satisfied: chosen.feasible,
  };
}

export interface EmergencyInput {
  limitAmps: number;
  marginAmps: number;
  /** For status parity only — the cut is sized by requiredSavingsAmps, not the budget. */
  nonAcLoadAmps: number;
  /** Meter-derived savings target: overshoot of the severe readings + margin. */
  requiredSavingsAmps: number;
  /** Pre-sorted by priority, highest first (same as AllocatorInput). */
  acs: LevelerAcSnapshot[];
  ampModels: Record<string, AcAmpModel>;
  /** Learned per-AC real per-level cost (gen) — see SelectReductionOptions.raiseSurge. */
  raiseSurge?: Record<string, number>;
}

export interface EmergencyReductionResult extends AllocationResult {
  requiredSavingsAmps: number;
  /** Σ estimated savings of the planned cuts (amp-model steps + fan heuristic). */
  estimatedSavingsAmps: number;
  /** False when everything reducible was cut and the target still isn't covered. */
  satisfied: boolean;
}

/**
 * One decisive, meter-sized cut batch: level drops toward floors (least-needy
 * room fully first, top-priority AC last — the allocator's shed-order
 * semantics), then fan drops in the SAME batch. When the total cut capacity
 * (every level to its floor + every reducible fan) knowably cannot cover the
 * target, power-off sheds ride in the SAME batch — least-needy SUFFICIENT AC
 * first (an AC whose savings can't cover the deficit is skipped: cycling its
 * compressor fixes nothing), the top-priority AC strictly last resort (user
 * decision 2026-06-12 PM, revising the morning's shed-separate staging after
 * the live 18A gen incident burned 3 batches where 1 sufficed). Floors stay
 * hard; never level 0; reachable/slot/manual caps honored; never raises.
 */
export function computeEmergencyReduction(input: EmergencyInput): EmergencyReductionResult {
  const { limitAmps, marginAmps, nonAcLoadAmps, requiredSavingsAmps, acs, ampModels } = input;
  const model = (id: string): AcAmpModel => ampModels[id] ?? DEFAULT_AMP_MODEL;
  const draw = (ac: LevelerAcSnapshot, level: number): number =>
    estimateAcDraw(level, ac.maxLevel, model(ac.deviceId));

  const onUnmanaged = acs.filter((a) => a.on && !a.managed);
  const candidates = acs.filter((a) => a.on && a.managed && !a.shed);

  const plan = selectReduction(candidates, requiredSavingsAmps, { ampModels, raiseSurge: input.raiseSurge });

  const unmanagedDraw = onUnmanaged.reduce((sum, a) => sum + draw(a, a.currentLevel), 0);
  const budgetAmps = limitAmps - marginAmps - nonAcLoadAmps - unmanagedDraw;
  const shedSet = new Set(plan.toShed);
  const plannedDraw = candidates.reduce((sum, a) => {
    if (shedSet.has(a.deviceId)) return sum;
    return sum + draw(a, plan.idealLevels[a.deviceId] ?? a.currentLevel);
  }, 0);

  return {
    desiredLevels: plan.desiredLevels,
    toShed: plan.toShed,
    toRestore: [],
    toFanReduce: plan.toFanReduce,
    toFanRaise: null,
    idealLevels: plan.idealLevels,
    nonAcLoadAmps,
    budgetAmps,
    projectedAmps: nonAcLoadAmps + unmanagedDraw + plannedDraw,
    requiredSavingsAmps,
    estimatedSavingsAmps: plan.estimatedSavingsAmps,
    satisfied: plan.satisfied,
  };
}
