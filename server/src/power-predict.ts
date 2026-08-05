// Pure "when does the power source switch next" predictor — no I/O, no Date.now(),
// fully unit-testable. It replaces the wall-clock/temperature lookback in
// power-stats.ts with a model of the thing that actually drives the schedule:
// the utility rations power on a fixed-length SLOT GRID, and each slot is taken
// by grid or by generator. Residual life is therefore
//
//     (minutes to the next slot boundary) + (one more slot if this source holds)
//
// Everything below is LEARNED from the session window that is passed in — the
// slot period, its phase, how late/early switches land, and how often each
// source keeps the following slot. No constant here encodes this household's
// current phase, its hold rates, or which source tends to hold; a different
// neighbourhood (or this one after the utility re-cuts the rota) has to be able
// to fall out of its own window. The constants are structural only: candidate
// periods, decay half-lives, jitter grace, confidence gates, prior strengths.
//
// Layers, in the order explainNextSwitch() applies them:
//   1. ration intervals — sessions merged across transient blackouts
//   2. cycle fit        — period + phase by recency-weighted circular concentration
//   3. hold model       — P(source keeps the next slot), empirical-Bayes per source
//   4. boundary grace   — a boundary that just passed without a switch is "imminent",
//                         not "one whole period later"
//   5. survival         — age-conditioned residual life, for low cycle confidence,
//                         states the slot model cannot explain, and blackouts
//
// The stateful wrapper supplies the sessions (built by power-stats.ts) and "now".

import { BAGHDAD_UTC_OFFSET_MS, DAY_MS, MINUTE_MS, weightedMedian, type Session } from "./power-stats.js";
import type { PowerSource } from "./ac-leveling.js";

// ------------------------------------------------------------- constants ---

/**
 * Slot periods the cycle fit may choose from, ascending. Sized to bracket every
 * plausible utility rota (1 h .. 4 h); the observed Baghdad grid is one of them
 * but nothing here assumes which.
 */
export const CANDIDATE_PERIOD_MINUTES: readonly number[] = [60, 90, 120, 150, 180, 240];

/**
 * Harmonics are the whole difficulty in picking a period. A P-periodic process
 * also concentrates modulo P/2 (every switch still lands on a boundary of the
 * half-grid), and concentration ALONE cannot tell the two apart — on a real
 * 15-day window the 60-min harmonic scored R=0.745 against 120's R=0.775 and
 * won, then predicted a switch every hour. So the fit scores
 *
 *     concentration x min(1, switches per boundary)
 *
 * — a period is only credible if its boundaries are actually USED. The half-grid
 * doubles the boundaries without producing more switches, so it halves its own
 * score. Among periods within this tolerance of the best score, the shortest
 * wins (a P-periodic process is 2P-periodic too, and the shorter grid is the
 * more specific claim).
 */
export const PERIOD_PREFERENCE_TOLERANCE = 0.03;

/** Recency half-life for the cycle fit. ~5 d keeps a rota change visible within a week. */
export const CYCLE_HALF_LIFE_DAYS = 5;

/**
 * Minimum circular concentration (R) of switch times modulo the period before
 * the slot model is trusted. Switch offsets scattered uniformly over +-45 min of
 * a 120-min grid score R ~= 0.30, so this sits above unstructured data and well
 * below a real grid (R ~= 0.77 in the 60-day sample).
 */
export const MIN_CYCLE_CONCENTRATION = 0.45;

/** A period/phase fitted on fewer switches than this is noise, not a cycle. */
export const MIN_CYCLE_SWITCHES = 8;

/**
 * Jitter allowance around a slot boundary when counting history, in minutes: a
 * boundary within this much of an interval's edge belongs to that edge rather
 * than counting as a crossing. Sized from the observed |switch - nearest
 * boundary| distribution (median ~6 min, p75 ~9 min); the p90 tail (~25 min) is
 * deliberately NOT covered, because a boundary that far inside an interval is
 * better read as a real crossing than as a late switch.
 */
export const HOLD_GRACE_MINUTES = 15;

/**
 * Jitter allowance applied to a boundary that has already passed live. Sized
 * from the same |switch - boundary| distribution as HOLD_GRACE_MINUTES but read
 * from its upper-middle (~p75 of the offsets that matter) — conceding a hold too
 * late costs a whole period of over-prediction, conceding too early costs the
 * same in the other direction, and the tune split put the minimum here.
 */
export const LIVE_GRACE_MINUTES = 15;

/** Recency half-life for hold statistics — short enough that yesterday dominates. */
export const HOLD_HALF_LIFE_DAYS = 4;

/**
 * How much an adjacent slot counts when reading a slot's hold rate. The rate
 * varies smoothly with position in the day, so neighbours are real but weaker
 * evidence; this triples the effective sample behind each decision.
 */
export const HOLD_SLOT_KERNEL_WEIGHT = 0.35;

/** Empirical-Bayes prior strength: the pooled per-source rate shrinking a per-slot rate. */
export const HOLD_SLOT_PRIOR_WEIGHT = 1.5;

/** Empirical-Bayes prior strength: an uninformative 0.5 shrinking the pooled rate. */
export const HOLD_POOLED_PRIOR_WEIGHT = 1;

/** A hold is predicted when its probability exceeds this — the conditional median. */
export const HOLD_DECISION_THRESHOLD = 0.5;

/** Recency half-life for the learned switch-vs-boundary offset. */
export const OFFSET_HALF_LIFE_DAYS = 5;

/** Recency half-life for the survival fallback. */
export const SURVIVAL_HALF_LIFE_DAYS = 7;

/** Never predict from fewer informative events than this — return null instead. */
export const MIN_INFORMATIVE_EVENTS = 4;

/** Floor for "the switch is due now" (a boundary inside its grace window). */
export const IMMINENT_FLOOR_MINUTES = 2;

/** Runaway guard on the hold chain; the data-driven max-holds cap normally binds first. */
export const MAX_HOLD_CHAIN = 6;

/** Same clamp the shipped predictor uses. */
export const PREDICT_MAX_MINUTES = 24 * 60;

const MINUTES_PER_DAY = 24 * 60;

/**
 * Every free parameter in one bag. Production always uses DEFAULT_TUNING; the
 * field exists so the backtest can A/B a constant and the unit tests can shrink
 * a gate without rewriting the module. It is data, not policy — nothing here is
 * household-specific.
 */
export interface PredictTuning {
  candidatePeriods: readonly number[];
  cycleHalfLifeDays: number;
  minConcentration: number;
  minSwitches: number;
  graceMinutes: number;
  holdHalfLifeDays: number;
  slotPriorWeight: number;
  pooledPriorWeight: number;
  holdThreshold: number;
  offsetHalfLifeDays: number;
  survivalHalfLifeDays: number;
  minEvents: number;
  /**
   * Weight given to the two ADJACENT slots when reading a slot's hold rate. The
   * hold rate is a smooth function of position in the day, so a neighbour is
   * evidence — just weaker evidence. 0 disables the smoothing.
   */
  slotKernelWeight: number;
  /**
   * Jitter allowance applied LIVE, i.e. how long a boundary that has already
   * passed still counts as "about to happen" before it is conceded to be a hold.
   * Separate from `graceMinutes` (which only shapes how history is counted)
   * because conceding early and mis-counting history have different costs.
   */
  liveGraceMinutes: number;
  /** Apply the learned signed switch-vs-boundary offset to the predicted end. */
  useEndOffset: boolean;
}

export const DEFAULT_TUNING: PredictTuning = {
  candidatePeriods: CANDIDATE_PERIOD_MINUTES,
  cycleHalfLifeDays: CYCLE_HALF_LIFE_DAYS,
  minConcentration: MIN_CYCLE_CONCENTRATION,
  minSwitches: MIN_CYCLE_SWITCHES,
  graceMinutes: HOLD_GRACE_MINUTES,
  holdHalfLifeDays: HOLD_HALF_LIFE_DAYS,
  slotPriorWeight: HOLD_SLOT_PRIOR_WEIGHT,
  pooledPriorWeight: HOLD_POOLED_PRIOR_WEIGHT,
  holdThreshold: HOLD_DECISION_THRESHOLD,
  offsetHalfLifeDays: OFFSET_HALF_LIFE_DAYS,
  survivalHalfLifeDays: SURVIVAL_HALF_LIFE_DAYS,
  minEvents: MIN_INFORMATIVE_EVENTS,
  slotKernelWeight: HOLD_SLOT_KERNEL_WEIGHT,
  liveGraceMinutes: LIVE_GRACE_MINUTES,
  useEndOffset: true,
};

// ----------------------------------------------------------------- types ---

/**
 * A stretch on one source with transient blackouts healed away: the unit the
 * utility actually rations. Sessions separated by a "none" run that recovers to
 * the SAME source are one interval; a "none" run between DIFFERENT sources is a
 * changeover, stamped at the gap's start. "none" runs at the window edges stay
 * as their own intervals so a live blackout has something to be measured against.
 */
export interface RationInterval {
  source: PowerSource;
  startMs: number;
  endMs: number; // exclusive
  minutes: number;
  /** Its start is the window edge, so its duration is truncated — no duration/hold stats. */
  leftCensored: boolean;
  /** Still running at the window edge — no duration/hold stats. */
  rightCensored: boolean;
}

/** A grid<->gen changeover. `atMs` is when the old source stopped supplying. */
export interface SwitchEvent {
  atMs: number;
  from: PowerSource;
  to: PowerSource;
}

/** The learned slot grid. `phaseMinutes` is Baghdad-local minutes modulo the period. */
export interface CycleFit {
  periodMinutes: number;
  phaseMinutes: number;
  /** Circular concentration at the chosen period: 0 = uniform, 1 = perfectly locked. */
  concentration: number;
  /** Observed switches per boundary of this grid, capped at 1 — how used the grid is. */
  boundaryUse: number;
  /** Switches that informed the fit. */
  switchCount: number;
}

export interface SwitchPrediction {
  remainingMinutes: number;
  sampleCount: number;
  method: "slot" | "survival";
}

/** Everything the prediction computed — for diagnostics, reports and tests. */
export interface SwitchExplanation {
  prediction: SwitchPrediction | null;
  cycle: CycleFit | null;
  source: PowerSource;
  currentStartMs: number;
  ageMinutes: number;
  /** Boundaries this interval is known to have survived (grace applied). */
  holdsConfirmed: number;
  /** P(survive the next boundary) that drove the decision, when the slot path ran. */
  holdProbability: number | null;
  /** Every hold probability evaluated, in order — [P(hold_1), P(hold_2), ...]. */
  holdChain: number[];
  /** The boundary the interval is predicted to end on (before the learned offset). */
  boundaryMs: number | null;
  /** Learned signed offset of this source's switches from the grid, minutes. */
  endOffsetMinutes: number;
  /** Most holds ever seen for this source in the window — the slot model's reach. */
  maxHolds: number | null;
  /** Why the chosen path was chosen. */
  reason: string;
}

// ------------------------------------------------------------- primitives ---

/** Always-positive modulo (JS `%` keeps the sign of the dividend). */
function mod(value: number, m: number): number {
  return ((value % m) + m) % m;
}

/** Baghdad-local minutes since the epoch — the frame the slot grid lives in. */
export function localMinutes(ms: number): number {
  return (ms + BAGHDAD_UTC_OFFSET_MS) / MINUTE_MS;
}

/** Exponential recency weight: 1 at `nowMs`, 0.5 one half-life earlier. */
export function recencyWeight(ms: number, nowMs: number, halfLifeDays: number): number {
  const ageDays = (nowMs - ms) / DAY_MS;
  if (!(ageDays > 0)) return 1;
  return Math.pow(0.5, ageDays / halfLifeDays);
}

/** The first slot boundary strictly after `ms`. */
export function nextBoundaryMs(ms: number, periodMinutes: number, phaseMinutes: number): number {
  const ahead = mod(phaseMinutes - localMinutes(ms), periodMinutes);
  return ms + (ahead === 0 ? periodMinutes : ahead) * MINUTE_MS;
}

/** Minutes from `ms` to the next slot boundary (always > 0, <= period). */
export function minutesToNextBoundary(ms: number, periodMinutes: number, phaseMinutes: number): number {
  return (nextBoundaryMs(ms, periodMinutes, phaseMinutes) - ms) / MINUTE_MS;
}

/**
 * Signed distance from `ms` to its NEAREST boundary, in (-period/2, period/2]:
 * negative when `ms` sits before the boundary (an early switch), positive after.
 */
export function offsetFromBoundary(ms: number, periodMinutes: number, phaseMinutes: number): number {
  const ahead = mod(phaseMinutes - localMinutes(ms), periodMinutes);
  return ahead > periodMinutes / 2 ? periodMinutes - ahead : -ahead;
}

/**
 * Which slot of the Baghdad day `ms` falls in, counting from the fitted phase.
 * This is the key the hold model conditions on: because the ration cycle
 * precesses through the day, one key carries both the hour-of-day effect and the
 * day-to-day repeat of the same slot.
 */
export function slotOfDay(ms: number, periodMinutes: number, phaseMinutes: number): number {
  return Math.floor(mod(localMinutes(ms) - phaseMinutes, MINUTES_PER_DAY) / periodMinutes);
}

// ------------------------------------------------------- event extraction ---

/**
 * Collapse sessions into ration intervals (see RationInterval). The first and
 * last intervals are flagged censored — their durations are cut by the window,
 * not by the utility, so no duration or hold statistic may use them.
 *
 * `sessions` must alternate sources (no two adjacent sessions share one), the
 * invariant buildSessions() upholds — hand-built lists that violate it get
 * silently misattributed, not repaired.
 */
export function buildRationIntervals(sessions: Session[]): RationInterval[] {
  const out: RationInterval[] = [];
  let pendingStartMs: number | null = null; // a changeover gap credited to the incoming source

  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    const prev = out.length > 0 ? out[out.length - 1] : null;

    if (s.source === "none") {
      const next = i + 1 < sessions.length ? sessions[i + 1] : null;
      if (prev && next && prev.source !== "none" && prev.source === next.source) {
        prev.endMs = s.endMs; // transient outage inside one ration interval
        continue;
      }
      if (prev && next && prev.source !== "none") {
        pendingStartMs = s.startMs; // changeover through a gap: the switch is here
        continue;
      }
      out.push({ source: "none", startMs: s.startMs, endMs: s.endMs, minutes: 0, leftCensored: false, rightCensored: false });
      continue;
    }

    if (prev && prev.source === s.source) {
      prev.endMs = s.endMs;
      pendingStartMs = null;
      continue;
    }
    out.push({
      source: s.source,
      startMs: pendingStartMs ?? s.startMs,
      endMs: s.endMs,
      minutes: 0,
      leftCensored: false,
      rightCensored: false,
    });
    pendingStartMs = null;
  }

  for (const iv of out) iv.minutes = (iv.endMs - iv.startMs) / MINUTE_MS;
  if (out.length > 0) {
    out[0].leftCensored = true;
    out[out.length - 1].rightCensored = true;
  }
  return out;
}

/** Completed (uncensored) intervals — the only ones that may teach the model. */
export function completedIntervals(intervals: RationInterval[]): RationInterval[] {
  return intervals.filter((iv) => !iv.leftCensored && !iv.rightCensored);
}

/** Grid<->gen changeovers. Transitions in or out of a window-edge blackout are skipped. */
export function switchEvents(intervals: RationInterval[]): SwitchEvent[] {
  const out: SwitchEvent[] = [];
  for (let i = 1; i < intervals.length; i++) {
    const from = intervals[i - 1].source;
    const to = intervals[i].source;
    if (from === "none" || to === "none") continue;
    out.push({ atMs: intervals[i].startMs, from, to });
  }
  return out;
}

/** Completed "none" runs, used only to estimate how long a live blackout still has. */
export function outageIntervals(sessions: Session[]): RationInterval[] {
  const out: RationInterval[] = [];
  for (let i = 1; i < sessions.length - 1; i++) {
    const s = sessions[i];
    if (s.source !== "none") continue;
    out.push({ source: "none", startMs: s.startMs, endMs: s.endMs, minutes: s.minutes, leftCensored: false, rightCensored: false });
  }
  return out;
}

// ---------------------------------------------------------- cycle learning ---

/**
 * Learn the slot grid. For every candidate period: how tightly do recent switch
 * times cluster modulo that period (recency-weighted circular concentration),
 * and are that period's boundaries actually used (switches per boundary)? The
 * product of the two is the score — see PERIOD_PREFERENCE_TOLERANCE for why
 * concentration alone cannot separate a period from its own harmonic. The phase
 * is the weighted circular mean at the chosen period.
 *
 * Returns null when there is nothing to fit. The CALLER decides whether the fit
 * is trustworthy (see minConcentration / minSwitches).
 */
export function fitCycle(
  switches: SwitchEvent[],
  nowMs: number,
  tuning: PredictTuning = DEFAULT_TUNING,
): CycleFit | null {
  if (switches.length === 0 || tuning.candidatePeriods.length === 0) return null;
  const spanMinutes = (switches[switches.length - 1].atMs - switches[0].atMs) / MINUTE_MS;

  const scored = tuning.candidatePeriods.map((period) => {
    let sx = 0;
    let sy = 0;
    let sw = 0;
    for (const ev of switches) {
      const w = recencyWeight(ev.atMs, nowMs, tuning.cycleHalfLifeDays);
      const angle = (2 * Math.PI * mod(localMinutes(ev.atMs), period)) / period;
      sx += w * Math.cos(angle);
      sy += w * Math.sin(angle);
      sw += w;
    }
    const concentration = sw > 0 ? Math.hypot(sx, sy) / sw : 0;
    const boundaries = spanMinutes / period;
    const boundaryUse = boundaries > 0 ? Math.min(1, switches.length / boundaries) : 1;
    return {
      period,
      concentration,
      boundaryUse,
      score: concentration * boundaryUse,
      phase: mod((Math.atan2(sy, sx) / (2 * Math.PI)) * period, period),
    };
  });

  const best = Math.max(...scored.map((s) => s.score));
  const chosen = scored
    .filter((s) => s.score >= best - PERIOD_PREFERENCE_TOLERANCE)
    .sort((a, b) => a.period - b.period)[0];

  return {
    periodMinutes: chosen.period,
    phaseMinutes: chosen.phase,
    concentration: chosen.concentration,
    boundaryUse: chosen.boundaryUse,
    switchCount: switches.length,
  };
}

// ------------------------------------------------------------- hold model ---

interface WeightedRate {
  weight: number;
  held: number;
}

/** What the model learned about one source — all of it from decayed counts. */
export interface SourceHoldModel {
  /** Completed intervals of this source that informed it. */
  sampleCount: number;
  /** Most boundaries any one interval was seen to survive — the model's reach. */
  maxHolds: number;
  /** Learned signed offset of this source's switches from the grid, minutes. */
  endOffsetMinutes: number;
  /** P(survive boundary #level | survived #level-1); `slot` = the interval's start slot. */
  holdProbability(level: number, slot: number): number;
}

export type HoldModel = Map<PowerSource, SourceHoldModel>;

/** Boundaries an interval demonstrably survived: strictly inside it, grace applied at both edges. */
export function holdsWithin(
  interval: { startMs: number; endMs: number },
  periodMinutes: number,
  phaseMinutes: number,
  graceMinutes = HOLD_GRACE_MINUTES,
): number {
  const graceMs = graceMinutes * MINUTE_MS;
  const limit = interval.endMs - graceMs;
  let b = nextBoundaryMs(interval.startMs + graceMs, periodMinutes, phaseMinutes);
  let holds = 0;
  while (b < limit && holds < MAX_HOLD_CHAIN + 2) {
    holds++;
    b = nextBoundaryMs(b, periodMinutes, phaseMinutes);
  }
  return holds;
}

/**
 * Learn, per source and from decayed counts only: how often an interval keeps
 * the slot after each boundary, and how far its switches sit from the grid.
 * Nothing here is hardcoded per source — the asymmetry between a source that
 * always hands over and one that often keeps the next slot is whatever the
 * window says it is.
 */
export function learnHoldModel(
  intervals: RationInterval[],
  cycle: CycleFit,
  nowMs: number,
  tuning: PredictTuning = DEFAULT_TUNING,
): HoldModel {
  const perSlot = new Map<string, WeightedRate>(); // `${source}|${level}|${slot}`
  const pooled = new Map<string, WeightedRate>(); // `${source}|${level}`
  const offsets = new Map<PowerSource, { value: number; weight: number }[]>();
  const counts = new Map<PowerSource, { n: number; maxHolds: number }>();

  for (const iv of completedIntervals(intervals)) {
    if (iv.source === "none") continue;
    const w = recencyWeight(iv.startMs, nowMs, tuning.holdHalfLifeDays);
    const holds = holdsWithin(iv, cycle.periodMinutes, cycle.phaseMinutes, tuning.graceMinutes);
    const slot = slotOfDay(iv.startMs, cycle.periodMinutes, cycle.phaseMinutes);

    // One Bernoulli trial per boundary the interval reached: it survived levels
    // 1..holds and failed at level holds+1.
    for (let level = 1; level <= holds + 1; level++) {
      const survived = holds >= level ? 1 : 0;
      const cell = perSlot.get(`${iv.source}|${level}|${slot}`) ?? { weight: 0, held: 0 };
      cell.weight += w;
      cell.held += w * survived;
      perSlot.set(`${iv.source}|${level}|${slot}`, cell);
      const pool = pooled.get(`${iv.source}|${level}`) ?? { weight: 0, held: 0 };
      pool.weight += w;
      pool.held += w * survived;
      pooled.set(`${iv.source}|${level}`, pool);
    }

    const list = offsets.get(iv.source) ?? [];
    list.push({
      value: offsetFromBoundary(iv.endMs, cycle.periodMinutes, cycle.phaseMinutes),
      weight: recencyWeight(iv.startMs, nowMs, tuning.offsetHalfLifeDays),
    });
    offsets.set(iv.source, list);

    const c = counts.get(iv.source) ?? { n: 0, maxHolds: 0 };
    c.n++;
    c.maxHolds = Math.max(c.maxHolds, holds);
    counts.set(iv.source, c);
  }

  const slotsPerDay = Math.max(1, Math.round(MINUTES_PER_DAY / cycle.periodMinutes));
  const model: HoldModel = new Map();
  for (const [source, c] of counts) {
    const devs = offsets.get(source) ?? [];
    model.set(source, {
      sampleCount: c.n,
      maxHolds: c.maxHolds,
      endOffsetMinutes: tuning.useEndOffset && devs.length > 0 ? weightedMedian(devs) : 0,
      holdProbability(level: number, slot: number): number {
        const pool = pooled.get(`${source}|${level}`) ?? { weight: 0, held: 0 };
        const pPooled = (pool.held + tuning.pooledPriorWeight * 0.5) / (pool.weight + tuning.pooledPriorWeight);
        // The slot's own history, plus its neighbours at a discount (the hold
        // rate moves smoothly through the day), shrunk toward the pooled rate.
        let weight = 0;
        let held = 0;
        for (const [d, kw] of [
          [0, 1],
          [-1, tuning.slotKernelWeight],
          [1, tuning.slotKernelWeight],
        ] as const) {
          if (kw <= 0) continue;
          const cell = perSlot.get(`${source}|${level}|${mod(slot + d, slotsPerDay)}`);
          if (!cell) continue;
          weight += kw * cell.weight;
          held += kw * cell.held;
        }
        return (held + tuning.slotPriorWeight * pPooled) / (weight + tuning.slotPriorWeight);
      },
    });
  }
  return model;
}

// --------------------------------------------------------------- survival ---

/**
 * Age-conditioned residual life: among completed intervals of this source that
 * lasted longer than the current age, the recency-weighted median of what was
 * left. Assumption-free — it is what carries "none" (blackout recovery) and any
 * state the slot model cannot explain. Null when too few intervals qualify.
 */
export function survivalRemaining(
  intervals: RationInterval[],
  ageMinutes: number,
  nowMs: number,
  tuning: PredictTuning = DEFAULT_TUNING,
): { remainingMinutes: number; sampleCount: number } | null {
  const samples = intervals
    .filter((iv) => iv.minutes > ageMinutes)
    .map((iv) => ({
      value: iv.minutes - ageMinutes,
      weight: recencyWeight(iv.startMs, nowMs, tuning.survivalHalfLifeDays),
    }));
  if (samples.length < Math.max(1, tuning.minEvents)) return null;
  return { remainingMinutes: weightedMedian(samples), sampleCount: samples.length };
}

// ------------------------------------------------------------- prediction ---

/**
 * Where the currently-running interval began. Mirrors resolveCurrentSession():
 * the window tail normally agrees with the live source; when it does not, either
 * a changeover has not reached the minute data yet (it starts now) or the rows
 * have stopped and a blackout began at the data edge.
 */
function currentIntervalStart(intervals: RationInterval[], liveSource: PowerSource, nowMs: number): number {
  if (intervals.length === 0) return nowMs;
  const tail = intervals[intervals.length - 1];
  if (tail.source === liveSource) return tail.startMs;
  if (liveSource === "none") return tail.endMs;
  return nowMs;
}

function clamp(minutes: number): number {
  return Math.min(PREDICT_MAX_MINUTES, Math.max(0, Math.round(minutes)));
}

/**
 * Full trace of a prediction: the number predictNextSwitch() returns plus
 * everything decided on the way. Public so the backtest and the unit tests can
 * assert on the mechanism, not only on the output.
 */
export function explainNextSwitch(args: {
  sessions: Session[];
  nowMs: number;
  liveSource: PowerSource;
  tuning?: PredictTuning;
}): SwitchExplanation {
  const { sessions, nowMs, liveSource } = args;
  const tuning = args.tuning ?? DEFAULT_TUNING;
  const intervals = buildRationIntervals(sessions);
  const startMs = currentIntervalStart(intervals, liveSource, nowMs);
  const ageMinutes = Math.max(0, (nowMs - startMs) / MINUTE_MS);

  const base: SwitchExplanation = {
    prediction: null,
    cycle: null,
    source: liveSource,
    currentStartMs: startMs,
    ageMinutes,
    holdsConfirmed: 0,
    holdProbability: null,
    holdChain: [],
    boundaryMs: null,
    endOffsetMinutes: 0,
    maxHolds: null,
    reason: "",
  };

  // A blackout is not part of the ration cycle: how long it lasts is its own
  // distribution, so it goes straight to survival over past outages.
  if (liveSource === "none") {
    const s = survivalRemaining(outageIntervals(sessions), ageMinutes, nowMs, tuning);
    return {
      ...base,
      reason: s ? "blackout: survival over past outages" : "blackout: too few past outages",
      prediction: s
        ? { remainingMinutes: clamp(s.remainingMinutes), sampleCount: s.sampleCount, method: "survival" }
        : null,
    };
  }

  const sameSource = completedIntervals(intervals).filter((iv) => iv.source === liveSource);
  const fallback = (reason: string, extra: Partial<SwitchExplanation> = {}): SwitchExplanation => {
    const s = survivalRemaining(sameSource, ageMinutes, nowMs, tuning);
    return {
      ...base,
      ...extra,
      reason: s ? reason : `${reason}; survival also short of samples`,
      prediction: s
        ? { remainingMinutes: clamp(s.remainingMinutes), sampleCount: s.sampleCount, method: "survival" }
        : null,
    };
  };

  const cycle = fitCycle(switchEvents(intervals), nowMs, tuning);
  if (!cycle) return fallback("no switches in window");
  base.cycle = cycle;
  if (cycle.switchCount < tuning.minSwitches) return fallback("too few switches to fit a cycle");
  if (cycle.concentration < tuning.minConcentration) {
    return fallback(`cycle concentration ${cycle.concentration.toFixed(2)} below the gate`);
  }

  const sourceModel = learnHoldModel(intervals, cycle, nowMs, tuning).get(liveSource);
  if (!sourceModel || sourceModel.sampleCount < tuning.minEvents) {
    return fallback("too few completed intervals for this source");
  }
  base.maxHolds = sourceModel.maxHolds;
  base.endOffsetMinutes = sourceModel.endOffsetMinutes;

  const { periodMinutes, phaseMinutes } = cycle;
  const offsetMs = sourceModel.endOffsetMinutes * MINUTE_MS;
  const graceMs = tuning.graceMinutes * MINUTE_MS;
  const liveGraceMs = tuning.liveGraceMinutes * MINUTE_MS;
  const startSlot = slotOfDay(startMs, periodMinutes, phaseMinutes);

  // The earliest boundary this interval could still be ending on. Anything
  // earlier has passed by more than the jitter grace, so it was held — and a
  // boundary still INSIDE its grace stays the candidate, which is what keeps a
  // late switch from being read as a whole extra period.
  let level = 1;
  let boundaryMs = nextBoundaryMs(startMs + graceMs, periodMinutes, phaseMinutes);
  while (boundaryMs + offsetMs <= nowMs - liveGraceMs && level <= MAX_HOLD_CHAIN + 1) {
    boundaryMs = nextBoundaryMs(boundaryMs, periodMinutes, phaseMinutes);
    level++;
  }
  base.holdsConfirmed = level - 1;

  // More holds than this source has ever managed in the window: the slot model
  // has nothing to say about where we are, so hand over rather than invent.
  if (base.holdsConfirmed > sourceModel.maxHolds) {
    return fallback(`${base.holdsConfirmed} holds exceeds the observed maximum ${sourceModel.maxHolds}`);
  }

  // Walk forward while another hold is more likely than not — the conditional
  // median, which is the MAE-optimal point estimate for a two-outcome split.
  let holdProbability = sourceModel.holdProbability(level, startSlot);
  const holdChain = [holdProbability];
  while (level <= sourceModel.maxHolds && level <= MAX_HOLD_CHAIN && holdProbability > tuning.holdThreshold) {
    boundaryMs = nextBoundaryMs(boundaryMs, periodMinutes, phaseMinutes);
    level++;
    holdProbability = sourceModel.holdProbability(level, startSlot);
    holdChain.push(holdProbability);
  }

  const remaining = Math.max(IMMINENT_FLOOR_MINUTES, (boundaryMs + offsetMs - nowMs) / MINUTE_MS);
  return {
    ...base,
    holdProbability,
    holdChain,
    boundaryMs,
    reason: "slot",
    prediction: { remainingMinutes: clamp(remaining), sampleCount: cycle.switchCount, method: "slot" },
  };
}

/**
 * Predict how many more minutes the live source will last.
 *
 * `sessions` is the reconstructed minute-stream session list (power-stats.ts),
 * oldest first; `nowMs` is the caller's clock; `liveSource` is the source the
 * device is on right now (which may lead the session data by a minute or two).
 *
 * Returns null when the window cannot support a prediction — the card hides the
 * estimate rather than showing a guess.
 */
export function predictNextSwitch(args: {
  sessions: Session[];
  nowMs: number;
  liveSource: PowerSource;
  tuning?: PredictTuning;
}): SwitchPrediction | null {
  return explainNextSwitch(args).prediction;
}
