// Shared types for the Smart AC Leveling v2 controller (server/src/leveling/).
// Pure data shapes only — no I/O, no classes. The v1 files (ac-leveler.ts /
// ac-leveling.ts) stay untouched until cutover; v2 deliberately re-declares its
// own types so deleting v1 later is a pure file removal.

export type PowerSource = "grid" | "gen" | "none";

/**
 * Effective controller mode, derived each evaluation from ModeState.
 * Priority when several conditions overlap: COLLAPSED > FLOORS > GRID_FULL > SETTLING > NORMAL.
 * - NORMAL:    free to reduce and raise (subject to pacing).
 * - SETTLING:  a recent command batch hasn't settled — reductions allowed, raises paced.
 * - FLOORS:    entering gen (changeover OR cold start): hold every ON managed AC at its
 *              floor, re-asserting until the shadow confirms and the compressor ramp passes.
 * - GRID_FULL: entering grid: drive every ON managed AC to its ceiling in one batch and
 *              restore sheds ("start all to full, then drop when needed" — user 2026-07-23);
 *              the graduated reducer trims if the meter objects. Ends on confirmation,
 *              over-limit action, manual change, or its backstop.
 * - COLLAPSED: probable breaker trip / blackout — raises and restores frozen, manual-intent
 *              minting suppressed; reductions still allowed.
 */
export type Mode = "NORMAL" | "SETTLING" | "FLOORS" | "GRID_FULL" | "COLLAPSED";

export type Severity = "mild" | "severe" | "extreme";

/**
 * What the meter says about a reducing batch we have already commanded — the
 * single trend judgment every ladder rung consults (`cutTrendOf` in sensing.ts).
 *
 * - `none`     nothing in flight.
 * - `settling` in flight, inside its landing grace: trusted, but unproven.
 * - `arriving` the fall from the cut's own anchor has reached the promised
 *              fraction of what was commanded — the amps are demonstrably
 *              leaving, so the sustained clock rebases and the rungs hold.
 * - `stalled`  past the grace with the fall still short: lateness that never
 *              shrinks is not a claim, it is a bet. The last rung runs.
 */
export type CutTrend = "none" | "settling" | "arriving" | "stalled";

/** One whole-house meter reading (the only feedback signal in the system). */
export interface MeterReading {
  /** Grid line amps (current_1 on the ESP payload). */
  gridAmps: number;
  /** Generator line amps (current_2). */
  genAmps: number;
  /** Ingest timestamp (ms). */
  at: number;
}

/** Events emitted by the sensing reducer; the controller shell fans them out. */
export type MeterEvent =
  | { kind: "source_changed"; from: PowerSource; to: PowerSource }
  | { kind: "esp_gap"; gapMs: number }
  /**
   * The generator browned out while we were riding near its limit — an ESP
   * power gap is the only evidence of it this house has. Not a trip and not a
   * freeze: the ceiling comes down and the ordinary ladder respects it.
   */
  | { kind: "strain_derate"; amps: number; source: PowerSource; gapMs: number; preGapAmps: number }
  | { kind: "collapse"; fromAmps: number; toAmps: number; source: PowerSource }
  | { kind: "collapse_recovered"; source: PowerSource }
  /** A collapse-shaped drop the controller's own cut explains — latch withheld. */
  | { kind: "collapse_suppressed"; fromAmps: number; toAmps: number; creditAmps: number; source: PowerSource }
  /**
   * A collapse-shaped fall nobody commanded, but the line is still carrying
   * enough load that it is not provably a trip. Not a latch — a stand-down: the
   * controller must not spend into a trough it cannot explain.
   */
  | { kind: "unexplained_fall"; fromAmps: number; toAmps: number; unexplainedAmps: number; source: PowerSource }
  | { kind: "bucket_empty"; severity: "mild" | "severe" }
  | { kind: "meter_frozen"; frozenForMs: number; amps: number }
  | { kind: "meter_unfrozen"; frozenForMs: number };

/** Latched probable-trip/blackout state. */
export interface CollapseLatch {
  /** Smoothed measured just before the collapse — recovery target reference. */
  preMedianAmps: number;
  /** Safety expiry (ms timestamp): the freeze can never strand the controller. */
  until: number;
}

/** Rolling meter state owned by the sensing reducer. Immutable — every ingest returns a new one. */
export interface MeterState {
  source: PowerSource;
  lastReadingAt: number;
  /** Recent measured amps on the active source, newest last (bounded ring). */
  recent: readonly number[];
  /** Leaky-bucket points remaining before an over-limit action triggers. */
  overLimitBudget: number;
  /** Over-limit readings of the current episode (sizes the meter-based cut). */
  overLimitReadings: readonly number[];
  /** Timestamp when the current uninterrupted genuine-headroom stretch began, or null. */
  calmSince: number | null;
  /**
   * Calm stand-down after an unexplained collapse-shaped fall (see the
   * `unexplained_fall` event). A trough we cannot explain is not headroom: live
   * 2026-08-02 17:40 a real break left a 5.9A residual that read as PERFECT
   * calm, and the controller raised three levels into a line that had just cut
   * out — the second break followed four minutes later.
   */
  calmHoldUntil: number;
  /**
   * The mean just before a still-developing fall, held briefly so the latch
   * survives the smoothing window. The 4-wide median flips on the THIRD
   * post-cliff reading, which collapsed the measured drop from 9.8A to 5.2A and
   * closed the latch window before the fall had finished arriving.
   */
  cliffAnchor: { medianAmps: number; at: number } | null;
  /**
   * Readings ingested since the last discontinuity (source change, ESP gap,
   * collapse latch or recovery). The flicker estimator sees only these: a trip's
   * own cliff is a huge jump, and letting it into the ring pinned the estimate
   * at its cap for the ~8 readings AFTER a breaker proved it could not hold —
   * exactly when tolerance must be at its lowest.
   */
  flickerSamples: number;
  /**
   * When the SMOOTHED mean first went over the effective limit in the current
   * unbroken stretch, or null. Magnitude alone cannot classify a slow kill: a
   * mean 0.6–1.0A over is "mild" forever, and level cuts wind down over minutes
   * while the breaker's thermal budget is ~2–4. Time is the missing dimension.
   */
  smoothedOverSince: number | null;
  collapse: CollapseLatch | null;
  /**
   * Frozen-meter tracking (device-level, survives source changes): the last
   * RAW channel pair and when it last showed a micro-change. A live CT always
   * jitters; a stream of bit-identical payloads is a hung ESP, not a flat load.
   */
  lastRaw: { gridAmps: number; genAmps: number } | null;
  lastMicroChangeAt: number;
  frozen: boolean;
  /**
   * Post-collapse limit derate: a breaker that just tripped is HOT and holds
   * less than its rating until it cools. Rides through the per-source episodic
   * reset (it is safety knowledge about a line, not episode bookkeeping), so it
   * records which source it applies to.
   */
  derate: { source: PowerSource; amps: number; until: number } | null;
  /**
   * Generator STRAIN: brownouts we rode into, rather than a breaker that
   * opened. 46 °C ambient derates a genset, and the honest evidence that the
   * real safe ceiling is below the configured one is that the line browned out
   * (an ESP power gap) while we sat within an amp of the limit. Separate from
   * `derate` because the two answer different questions and carry different
   * caps — and because a strain derate must never read as a trip: it latches
   * nothing, freezes nothing, and only shrinks the ceiling the ladder already
   * respects. Per-source, exactly like `derate`.
   */
  strainDerate: { source: PowerSource; amps: number; until: number } | null;
  /**
   * When each recent strain event happened (bounded, pruned to its window).
   * ONE brownout is a generator having a moment; two inside ten minutes is the
   * line telling us what it can actually hold. Episodic — reset per source,
   * like the over-limit readings — while the derate it produces rides through.
   */
  strainEvents: readonly number[];
  /**
   * Load this controller has COMMANDED off/down but the meter has not shown yet
   * — the mirror of `rampAbsorbedAmps` for the falling direction. A shed's
   * compressor stops somewhere between 6 s and minutes after the send, so the
   * drop lands as one cliff long after the batch; without this credit the
   * collapse detector reads our own shed as a breaker trip (live 2026-07-28
   * 07:23: gen 11.5A → 4.5A one minute after shedding the last two ACs, which
   * latched COLLAPSED, froze every restore for 5 min and derated the gen limit).
   * `absorbedAmps` ratchets on the deepest fall below `anchorAmps`, so credit is
   * spent once the meter has actually shown the cut.
   */
  pendingCut: { anchorAmps: number; amps: number; absorbedAmps: number; until: number } | null;
}

/** What the decision pipeline needs to know about the meter, per evaluation. */
export interface MeterView {
  source: PowerSource;
  /** Median-smoothed measured amps (last 4 readings). */
  smoothedAmps: number;
  /** Latest raw reading on the active source. */
  latestAmps: number;
  /** Number of readings in the smoothing window (trust gate). */
  sampleCount: number;
  /** Milliseconds of uninterrupted genuine headroom (SMOOTHED ≤ limit − margin). */
  calmMs: number;
  /**
   * Milliseconds the SMOOTHED mean has sat continuously over the effective
   * limit (0 when it is not). Severity escalates on this clock as well as on
   * magnitude — a sustained ride the reducer cannot fix with level cuts is an
   * emergency however small its overshoot.
   */
  smoothedOverMs: number;
  overLimitBudget: number;
  overLimitReadings: readonly number[];
  collapsed: boolean;
  /** Readings arrive but carry no micro-variation — hung sensor, value is a lie. */
  frozen: boolean;
  /**
   * Live supply-flicker estimate in amps (0 when unestimable or stale). A
   * generator wobbles reading-to-reading where the grid does not; a raw
   * reading within this much of the limit is supply noise, not load. Severity
   * classification discounts by it — the smoothed mean never is.
   */
  flickerAmps: number;
  /**
   * Amps to subtract from the configured limit for the active source right now
   * (0 normally). Grows with each recent power collapse — see the derate note
   * on MeterState. EVERY limit consumer must apply it, or the reducer and the
   * sensing bucket would disagree about what "over" means.
   */
  derateAmps: number;
  /**
   * Load we have already COMMANDED off that the meter has not shown yet (the
   * unabsorbed remainder of `MeterState.pendingCut`). The demand-side half of
   * "a drop we commanded is not a breaker trip": while a cut is still landing,
   * these amps are not outstanding load and must not be demanded a second time
   * from another room.
   */
  commandedCutCreditAmps: number;
  /**
   * The smoothed meter when the in-flight reducing batch was commanded (0 when
   * none). Where the meter came FROM, so a consumer can work out where it is
   * heading rather than trusting a value the cut has not finished moving.
   */
  commandedCutAnchorAmps: number;
  /**
   * Everything the current cut episode has commanded off, absorption-INCLUDED
   * (the credit above is what the meter has not shown yet; this is the whole
   * of it). The settle hold needs the total: a cut lands over minutes, and
   * while it lands the credit shrinks to nothing even though the amps really
   * are on their way out. Live 2026-08-03 00:41Z the reducer shipped three
   * batches in 13 seconds — 12.9A commanded off for a 0.4A deficit.
   */
  commandedCutTotalAmps: number;
  /**
   * How long the in-flight cut episode has been travelling (0 when none). A
   * credit is a claim that amps are LATE, and lateness that never shrinks is
   * not a claim, it is a bet — this is the clock that tests it (see
   * CREDIT_LANDING_GRACE_MS).
   */
  commandedCutAgeMs: number;
}

/** A single device command the pipeline wants executed. */
export type Command =
  | { deviceId: string; kind: "set_level"; level: number }
  | { deviceId: string; kind: "power_off"; reason: "shed" }
  | { deviceId: string; kind: "power_on"; level: number; reason: "restore"; fan?: number }
  | { deviceId: string; kind: "set_fan"; fan: number; reason: "trim" | "trim_restore" };

/**
 * A decision-trace entry. Everything the pipeline wanted to do but didn't
 * (and why), plus everything it did — the observability primitive that replaces
 * docker-log archaeology for "why is AC X at level N".
 */
export interface Decision {
  at: number;
  deviceId?: string;
  action: string;
  /** Present when the action was NOT taken this evaluation. */
  blockedBy?: string;
  detail?: string;
}

/** Output of one pipeline evaluation. */
export interface Plan {
  commands: Command[];
  /** Expected meter delta of this batch (signed amps) at learned/model cost. */
  expectedDeltaAmps: number;
  /**
   * Amps this batch COMMANDS off the meter (sheds + level cuts), priced at the
   * MODEL steady delta — always ≥ 0. The single input to `noteCommandedCut()`,
   * so every batch shape that lowers load (reducer, demote, funding swap, and
   * the peer floor-downs bundled into a restore) credits the collapse detector
   * identically. Model-priced deliberately: the learned book stores the largest
   * observed jump, and crediting that for a satisfied room — which by
   * definition draws below its cap — would over-credit enough to mask a real
   * breaker trip inside the pendingCut window.
   */
  commandedCutAmps: number;
  /** Earliest time the batch outcome may be graded (settle + slowest ramp end). */
  compareAfter: number;
  decisions: Decision[];
  /** Reason tag for the journal ("over_mild", "over_severe", "floors", "raise", …). */
  reason: string;
}

/** Pressure assessment for one evaluation. */
export type Pressure =
  | {
      kind: "over";
      requiredAmps: number;
      severity: Severity;
      /**
       * The deficit BEFORE the in-flight commanded-cut credit is subtracted —
       * what the meter says is owed, ignoring what is already on its way. The
       * settle hold compares this against the episode's total commanded cut;
       * `requiredAmps` cannot answer that question, because the credit is spent
       * as the meter absorbs it and reads 0 exactly when the cut is landing.
       */
      rawRequiredAmps: number;
    }
  | { kind: "calm"; headroomAmps: number }
  | { kind: "hold" };

/** Cost-model transition keys, per device × source. */
export type CostTransition =
  | `level:${number}>${number}`
  | `on@L${number}`
  | `off@L${number}`
  | "fan:step";

export interface LearnedCost {
  ewmaAmps: number;
  samples: number;
  updatedAt: number;
}

/** Resolved cost estimate with provenance for the decision trace. */
export interface CostEstimate {
  amps: number;
  confidence: "learned" | "calibration" | "seed";
}

/**
 * Per-AC view the pipeline decides over — built each evaluation by the
 * controller shell from the TCL shadow + automation context + pacing state.
 */
export interface AcView {
  deviceId: string;
  name: string;
  on: boolean;
  /** Master enabled AND not opted out via smart_leveling=false. */
  managed: boolean;
  shed: boolean;
  maxLevel: number;
  /** Observed shadow generator level; 0 = unrestricted (never left there). */
  currentLevel: number;
  /**
   * The highest level this AC might ACTUALLY be drawing at right now: its
   * confirmed shadow, or any level we sent and never saw confirm (whichever is
   * larger). For WORST-CASE PRICING only — the physics envelope's peer terms,
   * and the freshly-on turn-on projection (which must keep charging the level
   * the firmware came back at until our clamp-to-floor actually confirms).
   * Control decisions still key off `currentLevel`, because a command in flight
   * is not an observation (that distinction is what stops a lagging write
   * minting a false manual intent).
   *
   * Why it exists: 2026-07-28 15:55:36 admitted Abdu L2→L3 at a 13.6A envelope
   * because Najat's L3 (sent 15:39:49) had not confirmed yet; by 16:06 her
   * shadow flipped and the identical end-state was vetoed at 15.6A — after the
   * raise had already landed and produced an over_severe. The envelope is a
   * worst-case physics guard, so it must price the worst case the firmware
   * could be in, not the best case the shadow admits to.
   */
  envelopeLevel: number;
  /** Observed fan (0 = built-in auto); null when unknown. */
  fanSpeed: number | null;
  /** User touched the fan this episode — never trim it again until the episode ends. */
  fanExempt: boolean;
  /**
   * °C above this room's OWN satisfied point (≤0 = satisfied), measured with
   * whatever metric that room's automation is configured for — real temperature
   * for most, FEELS-LIKE for a room whose range rule uses it.
   *
   * Per-room ABSOLUTE decisions only: need tiers, `ceilOf`'s near-target cap,
   * `isNonCooling`, the satisfied dwell. A room's own comfort is that room's own
   * business, and feels-like is a perfectly good answer to "is this room
   * comfortable?".
   *
   * ⚠ NEVER compare it between rooms — use `rankNeedDelta`.
   */
  needDelta: number;
  /**
   * The AC's own thermometer in °C, or null when it is dead/stale (the
   * dead-sensor rule from 86f8696: absent or ≤0 is not a reading). Reported in
   * the journal beside `rankNeedDelta` so a shed decision can be audited on the
   * input it actually ranked.
   */
  roomTempC: number | null;
  /**
   * The SAME question asked of every room in the same unit: how far this room's
   * own thermometer sits past the shared comfort target (inverted in heat mode,
   * exactly as `computeAcNeed` does it). Ordering by this is ordering by REAL
   * room temperature — the user's rule, 2026-08-04: "coolest in real temp, not
   * feels like".
   *
   * Every room-vs-room comparison ranks on this: shed selection and its
   * `SHED_NEED_GAP_C`, the reduction cost weights, the sub-floor protection
   * term, restore/yield precedence (invariant 36), the rebalance donor gap, and
   * the recovery admission order. `needDelta` mixed units across rooms — a
   * feels-like delta against real-temperature deltas — so humidity alone could
   * make a milder room outrank a hotter one and take its amps.
   *
   * Falls back to `needDelta` when the thermometer is dead: the ordering is then
   * exactly what it was before this existed, which is the best available answer
   * and never worse than the old behaviour.
   */
  rankNeedDelta: number;
  /**
   * How long this room has been CONTINUOUSLY satisfied (needDelta at or below
   * the demote threshold), in ms; 0 when it is not satisfied right now. The
   * dwell input to the loaded-spring demote — a room that merely dips into the
   * band for one reading has not proven anything. Frozen (not accrued) while
   * the temperature reading behind `needDelta` is stale, so a dead sensor
   * cannot demote a live room.
   */
  satisfiedForMs: number;
  /**
   * How long this room has sat BELOW its comfort floor without getting any
   * cooler (0 when at/above the floor, or whenever the room last made progress).
   * The watch behind `isNonCooling` — inside the 2°C band a sub-floor level is
   * assumed to cool, and this is what tests that assumption against the
   * thermometer rather than trusting it (user, 2026-08-03).
   */
  subFloorStalledMs: number;
  /**
   * This room's compressor is probably not running RIGHT NOW, on evidence from
   * the METER rather than from the thermometer (R6, user 2026-08-04 — his own
   * experiment: "an off with 1 amp or less of drop means the compressor was not
   * running"). Two attributable sources, both one-off measurements rather than
   * standing residuals:
   *
   *  - a graded LONE off/shed whose measured drop was ≤ `COMPRESSOR_OFF_DROP_AMPS`
   *    while the model claimed ≥ `COMPRESSOR_OFF_MODEL_AMPS` at that level;
   *    retained per device+level until confirmed compressor evidence or a
   *    source change (dead-window.ts);
   *  - the changeover DEAD WINDOW — a power-event ramp held open past its timer
   *    because nothing has been absorbed and the whole house agrees.
   *
   * The third way a room can be non-cooling — the sub-floor thermometer watch —
   * is carried by `subFloorStalledMs` and consumed by the same `isNonCooling`,
   * so it is deliberately NOT folded in here: keeping them separate is what lets
   * the status card say "compressor off" and "stalled" as different words.
   *
   * ⚠ Never from the standing residual (`smoothed − modelled`): a room drawing
   * under its model moves that number by construction, so reading it to decide
   * whether the room is under-drawing is circular (invariant 40).
   */
  compressorOffLikely: boolean;
  /** Boost floor (≥1; >1 when an outdoor-heat boost is active). */
  minLevel: number;
  /**
   * Levels below this room's floor are not legal AUTOMATIC targets at all — see
   * `hardFloorOf`. Below the floor the compressor does not engage up here, which
   * makes "cut a level" and "switch the room off" the same physical act with
   * only one of them visible (user, 2026-08-04 at 47°C: "that should never put
   * it at l1").
   *
   * Set by EITHER of the two things that can know it, and they are independent:
   *  - the CONFIGURED band, more than `BOOST_FLOOR_FLEX_C` past this room's
   *    boost threshold (`boostZoneOf` → `hard`); or
   *  - a live LEARNED hold (level-hold.ts): this house has observed the level
   *    failing, and recorded the outdoor temperature it observed it at. That
   *    one extends the same hardness BELOW the configured threshold, which is
   *    the whole point — the threshold is an estimate.
   *
   * Narrows invariant 25's sub-floor rung; never deletes it. A room whose boost
   * condition does not currently hold, and any non-boost floor, keeps the rung.
   */
  boostFloorHard: boolean;
  manualCap: number | null;
  manualTarget: number | null;
  slotCap: number | null;
  reachableCap: number | null;
  /**
   * Remembered stable level, consumed by the RAISE phase to jump an already-ON
   * AC back to its proven level. A shed restore deliberately ignores it: a shed
   * is an over-limit event, so the room comes back gently at its floor (fan
   * pinned) and re-climbs from there.
   */
  warmStartLevel: number | null;
  /** Compressor still inside its ~4-min post-start ramp window. */
  ramping: boolean;
  /**
   * House load measured just BEFORE this AC turned on, while its start window
   * is open (null otherwise). A TCL restores the generator level it was last
   * left at, so a turn-on always arrives at a level nobody chose — and the
   * right correction is opposite per line:
   *  - GRID: lift it to its ceiling ("on grid, start all to full" — user
   *    2026-07-23) instead of creeping up a step at a time behind the ramp
   *    gate. Sizing that lift off the live meter would over-credit headroom
   *    (mid-ramp the meter has not absorbed this AC's own draw), so the
   *    pre-start baseline is the anchor.
   *  - GEN: clamp it DOWN to its floor (`invariantCorrections`). Since
   *    GRID_FULL shipped, the retained level is L3 — 6.3A onto a 15A line with
   *    nothing admitting it (live 2026-07-30 05:51).
   */
  startBaselineAmps: number | null;
  /**
   * House load measured just BEFORE this AC's compressor started, for as long
   * as its ramp window is open (null otherwise). This is the PHYSICS anchor,
   * not a policy window: unlike `startBaselineAmps` it is armed on every source
   * and every ramp re-arm (turn-on, restore, changeover, collapse recovery) and
   * is never cleared by an over-limit batch or a manual change — it exists only
   * to answer "how much of this AC's committed draw has the meter absorbed so
   * far?" (see rampDebitAmps). Null means unknown → charge the whole draw.
   */
  rampBaselineAmps: number | null;
  /**
   * The LARGEST rise above `rampBaselineAmps` the meter has shown since this
   * ramp armed (null when unknown/not ramping). Absorption is a one-way fact —
   * once the meter has proven a compressor's amps arrived, a later drop cannot
   * un-prove it. Without this ratchet, a reduction elsewhere (or any peer
   * turning off) drops the house below the baseline, `smoothed − baseline`
   * clamps to 0, and the ramping AC is re-charged its whole draw for the rest
   * of its window — which stalled a fan restore for 2 extra minutes on
   * 2026-07-27 (see rampDebitAmps).
   */
  rampAbsorbedAmps: number | null;
  /**
   * Amps a recent LEVEL RAISE of this AC committed that the meter has not shown
   * yet (0 when none). The raise-side mirror of the turn-on ramp debit.
   *
   * A level raise never arms `ramping` — that flag is only for compressor
   * starts — so nothing charged a raise's committed-but-unmetered jump, and the
   * raise gate reopens ~35s later (30s settle + calm reset) while the meter has
   * absorbed only part of it. That is the 2026-07-26 trip shape: Najat L1→L2
   * then L2→L3 35s apart, both admitted against a meter still catching up. The
   * physics envelope cannot cover it either, because it deliberately excludes
   * non-AC load — on gen that load is the difference between fitting and not.
   */
  unmeteredJumpAmps: number;
  /** A recent restore of this AC failed (backoff live) — re-shedding it is penalized. */
  reshedPenalized: boolean;
}
