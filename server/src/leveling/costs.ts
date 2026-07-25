// Persistent learned cost model for leveling v2.
//
// The week-long investigation established that no static number is right in
// both demand regimes: a cap step is worth ~1–1.7A on a cool room and 3.6A+ on
// a hot one, and the raise JUMP the meter sees (compressor duty change + cap
// release) exceeds the steady per-level increment. So the model keeps TWO
// kinds of numbers, per device × source:
//   - steady per-level draw (config ampModels/genAmpModels — capacity-corrected
//     seeds) used for budget fitting and reduction savings, and
//   - learned per-TRANSITION costs (EWMA from graded single-actuator batches)
//     used for raise admission / restore sizing, always taken as
//     max(model, learned) in the trip-safe direction.
//
// Pure module: the CostBook is a plain immutable record; store.ts persists it
// (table ac_leveling_costs) so learning survives deploys and config saves.

import type { CostEstimate, CostTransition, LearnedCost, PowerSource } from "./types.js";
import type { AcAmpModel, LevelingConfigV2 } from "./config.js";

/** EWMA weight of a new observation. */
export const EWMA_ALPHA = 0.35;
/** A learned cost older than this is ignored (seasonal drift, hardware changes). */
export const LEARNED_STALE_MS = 30 * 24 * 3_600_000;
/** Default fan step cost when nothing was learned (~0.1A/gear, mined 2026-07). */
export const FAN_STEP_DEFAULT_AMPS = 0.1;
/** Conservative full-fan-drop savings fallback (v1 FAN_REDUCE_SAVINGS_AMPS). */
export const FAN_FULL_DROP_DEFAULT_AMPS = 0.5;

export type CostBook = Readonly<Record<string, LearnedCost>>;

export function costKey(deviceId: string, source: PowerSource, transition: CostTransition): string {
  return `${deviceId}|${source}|${transition}`;
}

/** Fold one graded observation into the book (immutable). */
export function updateCost(
  book: CostBook,
  deviceId: string,
  source: PowerSource,
  transition: CostTransition,
  observedAmps: number,
  now: number,
): CostBook {
  const key = costKey(deviceId, source, transition);
  const prev = book[key];
  const fresh = prev != null && now - prev.updatedAt < LEARNED_STALE_MS;
  const ewmaAmps = fresh ? prev.ewmaAmps + EWMA_ALPHA * (observedAmps - prev.ewmaAmps) : observedAmps;
  const samples = fresh ? prev.samples + 1 : 1;
  return { ...book, [key]: { ewmaAmps, samples, updatedAt: now } };
}

/** Fresh learned value or null. */
export function learnedFor(
  book: CostBook,
  deviceId: string,
  source: PowerSource,
  transition: CostTransition,
  now: number,
): number | null {
  const entry = book[costKey(deviceId, source, transition)];
  if (entry == null || now - entry.updatedAt >= LEARNED_STALE_MS) return null;
  return entry.ewmaAmps;
}

/** Steady draw at a level (port of v1 estimateAcDraw — level 0 budgets one step above max). */
export function steadyDraw(level: number, maxLevel: number, model: AcAmpModel): number {
  if (level <= 0) return model.baseAmps + model.stepAmps * maxLevel;
  return model.baseAmps + model.stepAmps * (Math.min(level, maxLevel) - 1);
}

/** The per-AC steady model for the active source (gen overrides, grid fallback). */
export function modelFor(config: LevelingConfigV2, deviceId: string, source: PowerSource): AcAmpModel {
  const gen = source === "gen" ? config.genAmpModels[deviceId] : undefined;
  return gen ?? config.ampModels[deviceId] ?? { baseAmps: 2, stepAmps: 1 };
}

/**
 * Amps to charge for raising `from → to` (raise admission). Trip-safe blend:
 * max of the model's steady delta and the learned jump — a wrong static model
 * cannot admit an over-budget raise, and a learned low cost cannot fully erase
 * the model's floor.
 */
export function raiseJumpAmps(
  book: CostBook,
  config: LevelingConfigV2,
  deviceId: string,
  source: PowerSource,
  from: number,
  to: number,
  maxLevel: number,
  now: number,
): CostEstimate {
  const model = modelFor(config, deviceId, source);
  const modelDelta = Math.max(0, steadyDraw(to, maxLevel, model) - steadyDraw(Math.max(1, from), maxLevel, model));
  const learned = learnedFor(book, deviceId, source, `level:${from}>${to}`, now);
  // A learned single-step jump also gates multi-step targets: charge per step.
  const perStep = learnedFor(book, deviceId, source, `level:${from}>${from + 1}`, now);
  const steps = Math.max(1, to - from);
  const learnedTotal = learned ?? (perStep != null ? perStep * steps : null);
  if (learnedTotal != null && learnedTotal > modelDelta) {
    return { amps: learnedTotal, confidence: "learned" };
  }
  return { amps: modelDelta, confidence: learnedTotal != null ? "learned" : "seed" };
}

/** Amps to charge for turning an OFF AC on at `level` (restore admission). */
export function turnOnAmps(
  book: CostBook,
  config: LevelingConfigV2,
  deviceId: string,
  source: PowerSource,
  level: number,
  maxLevel: number,
  now: number,
): CostEstimate {
  const model = modelFor(config, deviceId, source);
  const modelDraw = steadyDraw(level, maxLevel, model);
  const learned = learnedFor(book, deviceId, source, `on@L${level}`, now);
  if (learned != null && learned > modelDraw) return { amps: learned, confidence: "learned" };
  return { amps: modelDraw, confidence: learned != null ? "learned" : "seed" };
}

/**
 * Amps to charge for bringing a SHED room back — the ONE definition, used by
 * BOTH the restore admission (raise.ts) and the freshly-on projection that
 * re-prices it on the next tick (controller.ts).
 *
 * They disagreed 2026-07-24→25 and that was the whole restore-bounce storm:
 * admission used the gentle steady draw (Najat L1 ≈ 2.3A, correct — a gentle
 * restore pins the fan to 1, so the fan-slam that inflated the learned on-cost
 * is gone) while the projection still charged the fan-slam-sized `on@L1` (3.7A).
 * Every gen restore therefore declared itself over-limit ~10s later and the
 * reducer shed a room — six times in 41 minutes, the last one a bystander.
 *
 * `gentle` must mean "this turn-on pinned the fan": true for a gen shed restore,
 * false for an automation/user turn-on (which slams the fan to a hot-room 3–7).
 */
export function restoreCostAmps(
  book: CostBook,
  config: LevelingConfigV2,
  deviceId: string,
  source: PowerSource,
  level: number,
  maxLevel: number,
  now: number,
  opts: { gentle: boolean },
): CostEstimate {
  if (!opts.gentle) return turnOnAmps(book, config, deviceId, source, level, maxLevel, now);
  // The physics-envelope veto still guards the end-state and the compressor
  // inrush is transient (inrush blanking in pipeline.ts covers the decay), so
  // the calibrated steady floor draw is the honest price of a gentle return.
  return {
    amps: steadyDraw(level, maxLevel, modelFor(config, deviceId, source)),
    confidence: "seed",
  };
}

/**
 * Savings credited to a level cut `from → to`. Sized like the raise jump in
 * reverse (max of model delta and learned up-jump): the static model
 * under-crediting a cut is what shed an AC to cover a 0.3A overshoot.
 */
export function levelCutSavings(
  book: CostBook,
  config: LevelingConfigV2,
  deviceId: string,
  source: PowerSource,
  from: number,
  to: number,
  maxLevel: number,
  now: number,
): number {
  return raiseJumpAmps(book, config, deviceId, source, to, from, maxLevel, now).amps;
}

/** Savings credited to a fan trim of `steps` gears (small — fans are trim, not levers). */
export function fanTrimSavings(
  book: CostBook,
  deviceId: string,
  source: PowerSource,
  steps: number,
  now: number,
): number {
  const perStep = learnedFor(book, deviceId, source, "fan:step", now);
  if (perStep != null) return Math.max(0, perStep) * steps;
  return steps >= 6 ? FAN_FULL_DROP_DEFAULT_AMPS : FAN_STEP_DEFAULT_AMPS * steps;
}

/**
 * Seed rows from the 2026-07 investigation (n=1–4 meter measurements, so they
 * carry samples=2 — real graded batches overtake them within hours). Only the
 * measured cells are seeded; everything else falls back to the config model.
 */
export interface CostSeedRow {
  deviceId: string;
  source: PowerSource;
  transition: CostTransition;
  amps: number;
}

export const COST_SEEDS: CostSeedRow[] = [
  // Abdu (CA5IMhFAAAE, 2-ton): observed hot-case jump L1→L2 3.8A; restore ~4.3A (7.3 inrush seen once).
  { deviceId: "CA5IMhFAAAE", source: "gen", transition: "level:1>2", amps: 3.8 },
  { deviceId: "CA5IMhFAAAE", source: "gen", transition: "on@L1", amps: 4.3 },
  // Najat (DHihohFAAAE, 1-ton): jump L1→L2 3.6A (partly contaminated, safe direction); restores median 3.7A.
  { deviceId: "DHihohFAAAE", source: "gen", transition: "level:1>2", amps: 3.6 },
  { deviceId: "DHihohFAAAE", source: "gen", transition: "on@L1", amps: 3.7 },
  // Fan steps ≈ 0.1A/gear on all units (mined; calibration corroborates).
  { deviceId: "CA5IMhFAAAE", source: "gen", transition: "fan:step", amps: 0.15 },
  { deviceId: "Cy3aihFAAAE", source: "gen", transition: "fan:step", amps: 0.1 },
  { deviceId: "DHihohFAAAE", source: "gen", transition: "fan:step", amps: 0.1 },
];
