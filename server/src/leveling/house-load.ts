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
// taken. Same-set samples are the peak of record; when the current set has no
// samples of its own yet, the peak among samples whose set MODELED every room
// now running (a superset) stands in — such a sample cannot double-count
// anyone, and it is what carries the honest house across a set change. A
// sample missing a room that is running now is never reused: any draw of that
// room at sample time was booked as house, and the envelope would charge it
// again as a cap. Same reasoning as the bucket refill on `power_on`: a turn-on
// changes the load picture wholesale.
//
// Sampling PAUSES for a cooldown whenever the modeled total DROPS (turn-off,
// shed, level cut — one detector for all three, because they share the
// physics: the model falls instantly, the meter follows over the compressor
// wind-down plus the smoothing window, and every tick in between reads the
// dying draw as house). 2026-08-01, 17:27 Baghdad: Abdullah's off left the
// smoothed meter at 13.7A against a 6.6A model — 7.1A of "house" (real:
// ~4.1A), the only sample tagged with the new set, and therefore the
// 15-minute peak. Every raise was refused at "worst case 16.2A > 14.9A"
// while the meter sat at 11–12A, until the user raised Abdu to L2 by hand.
// Raises need no cooldown: the modeled side RISES ahead of the meter, the
// residual dips, and a dip never wins a max.

import type { AcView, PowerSource } from "./types.js";
import type { LevelingConfigV2 } from "./config.js";
import { modelFor, steadyDraw } from "./costs.js";

/** How far back the peak looks. Long enough to span a compressor duty cycle. */
export const HOUSE_LOAD_WINDOW_MS = 15 * 60_000;
/** Ring bound — the tick is ~3–5s, so the window holds ~200–300 samples. */
const MAX_SAMPLES = 400;
/**
 * Sampling pause after the modeled total drops: covers the compressor
 * wind-down (~1 min observed) plus the meter's smoothing window, with margin.
 */
export const HOUSE_SAMPLE_COOLDOWN_MS = 2 * 60_000;
/** Modeled totals move by whole steps; anything under this is float noise. */
const MODELED_DROP_EPSILON_AMPS = 0.05;

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

interface SourceHouseLoad {
  readonly samples: readonly HouseLoadSample[];
  /** Modeled running total at the last usable tick — the drop detector. */
  readonly lastModeledAmps: number;
  /** Sampling resumes here after a modeled drop. */
  readonly cooldownUntil: number;
}

/** Per-source records. Sources never share: a gen residual says nothing about grid. */
export type HouseLoadState = Readonly<Record<string, SourceHouseLoad>>;

export function initialHouseLoad(): HouseLoadState {
  return {};
}

function modeledRunningAmps(
  acs: readonly AcView[],
  config: LevelingConfigV2,
  source: Exclude<PowerSource, "none">,
): number {
  return acs
    .filter((a) => a.on && a.managed && !a.shed)
    .reduce(
      (sum, a) =>
        sum + steadyDraw(a.currentLevel, a.maxLevel, modelFor(config, a.deviceId, source)),
      0,
    );
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
  return Math.max(0, smoothedAmps - modeledRunningAmps(acs, config, source));
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
  const running = opts.acs.filter((a) => a.on && a.managed && !a.shed);
  // A ramping tick is unusable AND must not advance the drop detector — the
  // modeled side already carries draw the meter has not seen.
  if (running.some((a) => a.ramping)) return state;
  const modeled = modeledRunningAmps(opts.acs, opts.config, opts.source);
  const rec = state[opts.source];
  const dropped = rec != null && modeled < rec.lastModeledAmps - MODELED_DROP_EPSILON_AMPS;
  const cooldownUntil = dropped ? opts.at + HOUSE_SAMPLE_COOLDOWN_MS : (rec?.cooldownUntil ?? 0);
  const kept = (rec?.samples ?? [])
    .filter((s) => opts.at - s.at < HOUSE_LOAD_WINDOW_MS)
    .slice(-(MAX_SAMPLES - 1));
  const samples =
    opts.at < cooldownUntil
      ? kept
      : [
          ...kept,
          {
            at: opts.at,
            amps: Math.max(0, opts.smoothedAmps - modeled),
            runningSet: runningSetOf(opts.acs),
          },
        ];
  return { ...state, [opts.source]: { samples, lastModeledAmps: modeled, cooldownUntil } };
}

/**
 * Worst-case non-AC load on `source`. The peak residual still inside the
 * window and taken with the SAME set of ACs running is the answer of record;
 * when that set has no samples yet (its first minutes after a set change fall
 * inside the cooldown), the peak among samples whose set modeled every room
 * now running stands in — a superset sample cannot double-count anyone, and
 * it is what keeps the envelope honest across a turn-off (and across the
 * shed-and-restore trough of the 2026-07-31 trip). 0 when nothing comparable
 * has been sampled: the honest answer for an unmeasured house, reproducing
 * the old AC-only envelope rather than inventing a reserve, so a fresh boot
 * is never MORE permissive than the code this replaced.
 */
export function houseLoadAmps(
  state: HouseLoadState,
  source: PowerSource,
  now: number,
  acs: readonly AcView[],
): number {
  const rec = state[source];
  if (rec == null) return 0;
  const runningSet = runningSetOf(acs);
  const members = runningSet === "" ? [] : runningSet.split(",");
  let exactPeak = -1;
  let carriedPeak = 0;
  for (const s of rec.samples) {
    if (now - s.at >= HOUSE_LOAD_WINDOW_MS) continue;
    if (s.runningSet === runningSet) {
      if (s.amps > exactPeak) exactPeak = s.amps;
    } else {
      const sampled = s.runningSet.split(",");
      if (members.every((id) => sampled.includes(id)) && s.amps > carriedPeak) carriedPeak = s.amps;
    }
  }
  return exactPeak >= 0 ? exactPeak : carriedPeak;
}
