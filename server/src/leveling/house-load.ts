// Non-AC house load — the term the physics envelope was missing.
//
// `envelopeTotalAmps` sums the per-AC cap models and nothing else, and that
// omission was deliberate ("v2 has no trustworthy non-AC split; the meter-side
// admission stays the primary gate"). It cost a generator on 2026-07-31: at
// 17:29:44 the envelope priced the end-state {Abdullah L3, Najat L1, Abdu L1}
// at 13.9A against a 14.9A ceiling and admitted the raise. The journal shows
// the SAME end-state measuring 15.93–15.99A minutes later — the backstop
// under-predicted this house by 2.0A and passed a state that sat 1A over the
// breaker. The meter-side gate did not save it either: the raise was admitted
// at 9.91A, a trough three minutes into a shed-and-restore, while the steady
// state of that configuration had been 12.4–13.3A for the previous ten minutes.
//
// So v2 now measures the split instead of assuming it away. Per source, per
// tick: `smoothed − Σ modeled draw of the ON managed ACs`. Two properties make
// this safe to feed a worst-case guard:
//
//   * It is a PEAK over a rolling window, not an average. The residual is
//     largest exactly when the compressors are drawing closest to the caps the
//     envelope charges them for — which is the moment the envelope is trying to
//     predict. A satisfied house cycling well under its caps yields a small (or
//     zero) residual and simply never wins the max.
//   * It is floored at 0 and only ever ADDS to the envelope, so a bad sample can
//     make the guard stricter but never more permissive. Today's failure was
//     over-permissiveness; that is the direction that must not be reachable.
//
// Ramping ACs are skipped: their modeled draw is on the books before the meter
// has seen it, so the residual dips and would just be noise under the max.
//
// Samples are tagged with the SET of ACs that were running when they were
// taken, and only same-set samples count toward the peak. An AC that is off
// contributes nothing to the modeled side, so its absence lands silently in the
// residual — and the moment it comes back that sample describes a house that no
// longer exists (it would double-count the room, once as "house" and once as a
// cap). Same reasoning as the bucket refill on `power_on`: a turn-on changes the
// load picture wholesale. Level changes do NOT invalidate a sample; the model
// already tracks those.

import type { AcView, PowerSource } from "./types.js";
import type { LevelingConfigV2 } from "./config.js";
import { modelFor, steadyDraw } from "./costs.js";

/** How far back the peak looks. Long enough to span a compressor duty cycle. */
export const HOUSE_LOAD_WINDOW_MS = 15 * 60_000;
/** Ring bound — the tick is ~3–5s, so the window holds ~200–300 samples. */
const MAX_SAMPLES = 400;

export interface HouseLoadSample {
  at: number;
  amps: number;
  /** Which ACs were running — a residual is only comparable within one set. */
  runningSet: string;
}

/** Stable signature of the ACs contributing to the modeled side of a sample. */
export function runningSetOf(acs: readonly AcView[]): string {
  return acs
    .filter((a) => a.on && a.managed && !a.shed)
    .map((a) => a.deviceId)
    .sort()
    .join(",");
}

/** Per-source sample rings. Sources never share: a gen residual says nothing about grid. */
export type HouseLoadState = Readonly<Record<string, readonly HouseLoadSample[]>>;

export function initialHouseLoad(): HouseLoadState {
  return {};
}

/**
 * Residual of one reading: the meter minus what the cap models say the running
 * managed ACs are drawing. Returns null when no sample should be taken.
 */
export function houseLoadResidual(
  smoothedAmps: number,
  acs: readonly AcView[],
  config: LevelingConfigV2,
  source: Exclude<PowerSource, "none">,
): number | null {
  const running = acs.filter((a) => a.on && a.managed && !a.shed);
  if (running.some((a) => a.ramping)) return null;
  const modeled = running.reduce(
    (sum, a) =>
      sum + steadyDraw(a.currentLevel, a.maxLevel, modelFor(config, a.deviceId, source)),
    0,
  );
  return Math.max(0, smoothedAmps - modeled);
}

export function sampleHouseLoad(
  state: HouseLoadState,
  opts: {
    source: Exclude<PowerSource, "none">;
    at: number;
    smoothedAmps: number;
    acs: readonly AcView[];
    config: LevelingConfigV2;
  },
): HouseLoadState {
  const amps = houseLoadResidual(opts.smoothedAmps, opts.acs, opts.config, opts.source);
  if (amps == null) return state;
  const runningSet = runningSetOf(opts.acs);
  const kept = (state[opts.source] ?? [])
    .filter((s) => opts.at - s.at < HOUSE_LOAD_WINDOW_MS)
    .slice(-(MAX_SAMPLES - 1));
  return { ...state, [opts.source]: [...kept, { at: opts.at, amps, runningSet }] };
}

/**
 * Worst-case non-AC load on `source` — the peak residual still inside the
 * window and taken with the SAME set of ACs running, or 0 when nothing
 * comparable has been sampled. Zero is the honest answer for an unmeasured
 * house: it reproduces the old AC-only envelope rather than inventing a
 * reserve, so a fresh boot (or the tick after a turn-on) is never MORE
 * permissive than the code this replaced.
 */
export function houseLoadAmps(
  state: HouseLoadState,
  source: PowerSource,
  now: number,
  acs: readonly AcView[],
): number {
  const runningSet = runningSetOf(acs);
  let peak = 0;
  for (const s of state[source] ?? []) {
    if (now - s.at >= HOUSE_LOAD_WINDOW_MS) continue;
    if (s.runningSet !== runningSet) continue;
    if (s.amps > peak) peak = s.amps;
  }
  return peak;
}
