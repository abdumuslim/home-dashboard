// Shared types for the Smart AC Leveling v2 controller (server/src/leveling/).
// Pure data shapes only — no I/O, no classes. The v1 files (ac-leveler.ts /
// ac-leveling.ts) stay untouched until cutover; v2 deliberately re-declares its
// own types so deleting v1 later is a pure file removal.

export type PowerSource = "grid" | "gen" | "none";

/**
 * Effective controller mode, derived each evaluation from ModeState.
 * Priority when several conditions overlap: COLLAPSED > FLOORS > SETTLING > NORMAL.
 * - NORMAL:    free to reduce and raise (subject to pacing).
 * - SETTLING:  a recent command batch hasn't settled — reductions allowed, raises paced.
 * - FLOORS:    entering gen (changeover OR cold start): hold every ON managed AC at its
 *              floor, re-asserting until the shadow confirms and the compressor ramp passes.
 * - COLLAPSED: probable breaker trip / blackout — raises and restores frozen, manual-intent
 *              minting suppressed; reductions still allowed.
 */
export type Mode = "NORMAL" | "SETTLING" | "FLOORS" | "COLLAPSED";

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
  | { kind: "bucket_empty"; severity: "mild" | "severe" };

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
}

/** A single device command the pipeline wants executed. */
export type Command =
  | { deviceId: string; kind: "set_level"; level: number }
  | { deviceId: string; kind: "power_off"; reason: "shed" }
  | { deviceId: string; kind: "power_on"; level: number; reason: "restore" }
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
  /** Remembered stable level for a warm restore, else null. */
  warmStartLevel: number | null;
  /** Compressor still inside its ~4-min post-start ramp window. */
  ramping: boolean;
  /** A recent restore of this AC failed (backoff live) — re-shedding it is penalized. */
  reshedPenalized: boolean;
}
