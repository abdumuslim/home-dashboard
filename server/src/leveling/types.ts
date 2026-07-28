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
  | { kind: "collapse"; fromAmps: number; toAmps: number; source: PowerSource }
  | { kind: "collapse_recovered"; source: PowerSource }
  /** A collapse-shaped drop the controller's own cut explains — latch withheld. */
  | { kind: "collapse_suppressed"; fromAmps: number; toAmps: number; creditAmps: number; source: PowerSource }
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
  /** Milliseconds of uninterrupted genuine headroom (≤ limit − margin). */
  calmMs: number;
  overLimitBudget: number;
  overLimitReadings: readonly number[];
  collapsed: boolean;
  /** Readings arrive but carry no micro-variation — hung sensor, value is a lie. */
  frozen: boolean;
  /**
   * Amps to subtract from the configured limit for the active source right now
   * (0 normally). Grows with each recent power collapse — see the derate note
   * on MeterState. EVERY limit consumer must apply it, or the reducer and the
   * sensing bucket would disagree about what "over" means.
   */
  derateAmps: number;
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
  /** Earliest time the batch outcome may be graded (settle + slowest ramp end). */
  compareAfter: number;
  decisions: Decision[];
  /** Reason tag for the journal ("over_mild", "over_severe", "floors", "raise", …). */
  reason: string;
}

/** Pressure assessment for one evaluation. */
export type Pressure =
  | { kind: "over"; requiredAmps: number; severity: Severity }
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
  /** Observed fan (0 = built-in auto); null when unknown. */
  fanSpeed: number | null;
  /** User touched the fan this episode — never trim it again until the episode ends. */
  fanExempt: boolean;
  /** °C above the target/satisfied point (≤0 = satisfied). Orders raises (desc) and sheds (asc). */
  needDelta: number;
  /** Boost floor (≥1; >1 when an outdoor-heat boost is active). */
  minLevel: number;
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
   * House load measured just BEFORE this AC turned on, while its grid
   * full-start window is open (null otherwise). A TCL restores the generator
   * level it was last left at — typically L1 from the previous gen episode —
   * so a turn-on on grid must be lifted to its ceiling ("on grid, start all to
   * full" — user 2026-07-23) instead of creeping up one step at a time behind
   * the ramp gate. Sizing that lift off the live meter would over-credit
   * headroom (during the ramp the meter has not absorbed this AC's own draw
   * yet), so the pre-start baseline is the anchor.
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
  /** A recent restore of this AC failed (backoff live) — re-shedding it is penalized. */
  reshedPenalized: boolean;
}
