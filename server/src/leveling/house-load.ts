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
//
// …and the OTHER half of that guard, missing until 2026-08-04: the residual can
// be wrong-LOW too. `max(0, …)` books a confident 0.0A whenever the model sits
// above the meter, which is exactly what a dead compressor looks like. On the
// morning of 08-04 a changeover left all three compressors in restart
// protection for six minutes; the sampler booked 0.0A of house for the current
// running set, the envelope admitted two raises "incl. 0.0A house" against a
// real ~6A, and the line went to 16.6A when the compressors finally engaged
// together. So a reading whose model sits more than `RESIDUAL_TRUST_GAP_AMPS`
// above the meter yields NO sample at all — and when the whole house is
// provably dead (dead-window.ts), the meter itself IS the house and is recorded
// as such, which is the measurement that would have refused those raises.
//
// Finally, the records are per source but the HOUSE is not. When the active
// source has no sample it can use, the other source's peak stands in (same
// set/superset rules, same 15-minute window). A changeover ages the new
// source's record out by definition — that is how the 08-04 envelope came to
// price a 6A house at 0.0A — and of the two possible answers, "the house we
// measured four minutes ago on the other line" is right far more often than
// "no house at all". Sole consumer is the raise envelope, so a stale carry
// over-blocks; a missing one admits a raise that does not fit.

import type { AcView, PowerSource } from "./types.js";
import type { LevelingConfigV2 } from "./config.js";
import { modeledRunningAmps, RESIDUAL_TRUST_GAP_AMPS } from "./dead-window.js";

/** How far back the peak looks. Long enough to span a compressor duty cycle. */
export const HOUSE_LOAD_WINDOW_MS = 15 * 60_000;
/**
 * How long the LAST grid session's house is remembered across a generator
 * interlude (2026-09-27, Stream G). Nearly every grid entry follows ~2 h of
 * generator, by which time the 15-minute window has aged the grid record out
 * and the carry would stand in the GENERATOR's house, which excludes every
 * grid-only load (the unmanaged guest AC among it). A day covers every
 * outage the household sees; past that, the memory is too old to describe the
 * house and the ordinary carry answers alone.
 */
export const GRID_SESSION_MEMORY_MS = 24 * 60 * 60_000;
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
  /**
   * The rolling peak as of this record's LAST usable sample, across running
   * sets, frozen there (2026-09-27, Stream G). The ring itself cannot carry it
   * across a generator interlude: the first tick back on this line prunes every
   * sample older than the window before any new sample is usable, so the
   * memory has to live beside the ring. See `rememberedSessionPeak`.
   */
  readonly session?: SessionMemory;
}

/** One frozen session peak, with the sample that set it (so a void can judge it). */
interface SessionPeak {
  readonly peakAmps: number;
  readonly lastAt: number;
  /** When the peak sample was taken, and the running set it was tagged with. */
  readonly peakAt: number;
  readonly peakSet: string;
}

/**
 * The memory beside the ring: the current session peak, plus the last VALID
 * peak whose samples the ring no longer holds (`prior`). `prior` is never read
 * on the ordinary path, where a newer valid sample legitimately replaces the
 * memory; it exists for `voidSamples`, so a retroactive void of the newer
 * evidence falls back to it instead of to an empty ring (review, 2026-09-27).
 */
interface SessionMemory extends SessionPeak {
  readonly prior?: SessionPeak;
}

/** Peak of `samples` inside the window that ends at the newest of them, across sets. */
function sessionOf(samples: readonly HouseLoadSample[]): SessionPeak | undefined {
  if (samples.length === 0) return undefined;
  const lastAt = samples.reduce((max, s) => Math.max(max, s.at), -Infinity);
  let peak: HouseLoadSample | null = null;
  for (const s of samples) {
    if (lastAt - s.at >= HOUSE_LOAD_WINDOW_MS) continue;
    if (peak == null || s.amps > peak.amps) peak = s;
  }
  if (peak == null) return undefined;
  return { peakAmps: peak.amps, lastAt, peakAt: peak.at, peakSet: peak.runningSet };
}

/** Strip a memory down to its own peak (a prior never nests a prior). */
function peakOnly(m: SessionPeak): SessionPeak {
  return { peakAmps: m.peakAmps, lastAt: m.lastAt, peakAt: m.peakAt, peakSet: m.peakSet };
}

/**
 * The memory that outlives `ring`: the current session when none of its samples
 * are still in the ring (it was frozen across a prune), else its own `prior`.
 */
function memoryBeyond(session: SessionMemory | undefined, ring: readonly HouseLoadSample[]): SessionPeak | undefined {
  if (session == null) return undefined;
  const inRing = ring.some((s) => s.at === session.lastAt);
  return inRing ? session.prior : peakOnly(session);
}

/** Per-source records; the cross-source carry in `houseLoadAmps` is the one bridge. */
export type HouseLoadState = Readonly<Record<string, SourceHouseLoad>>;

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
  const modeled = modeledRunningAmps(acs, config, source);
  // The model above the meter is not a small house — it is a compressor that is
  // not running, and `max(0, …)` would book that as a confident zero.
  if (modeled - smoothedAmps > RESIDUAL_TRUST_GAP_AMPS) return null;
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
    /**
     * Every running managed AC is inside a power-event dead window and the
     * whole-house evidence agrees (dead-window.ts) — so nothing of OURS is on
     * the line and the meter is a DIRECT measurement of the house.
     *
     * The caller owns this decision because it needs shell state the pure layer
     * has no business knowing (which ramps a power event opened, and how long
     * they have been held). Three of the ordinary guards are deliberately
     * bypassed here, and each for the same reason: they exist to keep a residual
     * honest, and this is not a residual.
     *  - the ramping skip — during a dead window every AC is ramping by
     *    construction, so honouring it would refuse the only usable reading;
     *  - the trust gap — the gap IS the evidence;
     *  - the modeled-drop cooldown — it exists because the meter still carries a
     *    dying compressor, i.e. sits ABOVE the model, which is the exact
     *    opposite of the condition that arms a dead window. The two cannot both
     *    be true, so honouring it here would only blind us to the reading that
     *    matters (an entry FLOORS clamp drops the model at exactly the wrong
     *    moment).
     * Tagged with the current running set as usual: those rooms' contribution at
     * sample time is genuinely ~0, so the superset reuse rules stay honest.
     */
    deadWindow?: boolean;
    /**
     * The SHELL's own reasons this reading may not be recorded as a sample — an
     * unconfirmed ON drawing amps the model cannot see yet, the boot quiet
     * window, a frozen meter. Gates the SAMPLE only; the drop detector's memory
     * and cooldown below advance regardless (2026-08-08). A restore→shed round
     * trip completes entirely inside the unconfirmed-ON stand-down and the
     * compressor ramp, so a memory frozen at the pre-restore total never sees the
     * re-shed's modeled drop — and the first tick that resumed sampling booked
     * the dying compressor as house (7.2 A phantom, live). This was a shell-side
     * `if` that skipped the CALL, which is exactly what froze the memory.
     */
    sampleSuppressed?: boolean;
  },
): HouseLoadState {
  const direct = opts.deadWindow === true;
  const running = opts.acs.filter((a) => a.on && a.managed && !a.shed);
  // A ramping tick yields no usable residual — the modeled side already carries
  // draw the meter has not seen — but it MUST still advance the drop detector
  // below: a restore→shed round trip that completes inside the ramp otherwise
  // freezes the memory at the pre-restore total and the re-shed's drop goes
  // unseen (2026-08-08). Gates the SAMPLE, never the memory.
  const ramping = !direct && running.some((a) => a.ramping);
  const modeled = modeledRunningAmps(opts.acs, opts.config, opts.source);
  const rec = state[opts.source];
  const dropped = rec != null && modeled < rec.lastModeledAmps - MODELED_DROP_EPSILON_AMPS;
  const cooldownUntil = dropped ? opts.at + HOUSE_SAMPLE_COOLDOWN_MS : (rec?.cooldownUntil ?? 0);
  const kept = (rec?.samples ?? [])
    .filter((s) => opts.at - s.at < HOUSE_LOAD_WINDOW_MS)
    .slice(-(MAX_SAMPLES - 1));
  const usable =
    !ramping &&
    opts.sampleSuppressed !== true &&
    (direct ||
      (opts.at >= cooldownUntil && modeled - opts.smoothedAmps <= RESIDUAL_TRUST_GAP_AMPS));
  const samples = usable
    ? [
        ...kept,
        {
          at: opts.at,
          amps: direct ? opts.smoothedAmps : Math.max(0, opts.smoothedAmps - modeled),
          runningSet: runningSetOf(opts.acs),
        },
      ]
    : kept;
  const fresh = usable ? sessionOf(samples) : undefined;
  const session: SessionMemory | undefined =
    fresh != null ? { ...fresh, prior: memoryBeyond(rec?.session, samples) } : rec?.session;
  return { ...state, [opts.source]: { samples, lastModeledAmps: modeled, cooldownUntil, session } };
}

/**
 * Arm the modeled-drop cooldown directly — the belt to `sampleHouseLoad`'s own
 * tick-by-tick drop detector (2026-08-08). The shell knows every load-lowering
 * batch it sends (`noteCommandedCut`), and a commanded cut IS a modeled drop
 * whose meter follows over the compressor wind-down: pausing sampling here means
 * a commanded off can never be booked as house even if the detector's memory is
 * ever starved again (a restore→shed round trip that completed entirely inside a
 * sampling stand-down booked 7.2 A of dying compressor as house). Touches ONLY
 * the cooldown — `lastModeledAmps` is the detector's alone, so the belt can
 * never fabricate a phantom drop or rise of its own.
 */
export function armDropCooldown(
  state: HouseLoadState,
  source: Exclude<PowerSource, "none">,
  at: number,
): HouseLoadState {
  const cooldownUntil = at + HOUSE_SAMPLE_COOLDOWN_MS;
  const rec = state[source];
  if (rec == null) {
    return { ...state, [source]: { samples: [], lastModeledAmps: 0, cooldownUntil } };
  }
  return { ...state, [source]: { ...rec, cooldownUntil: Math.max(rec.cooldownUntil, cooldownUntil) } };
}

/**
 * Peak usable residual in one source's record, or null when it holds nothing
 * comparable. The peak still inside the window and taken with the SAME set of
 * ACs running is the answer of record; when that set has no samples yet (its
 * first minutes after a set change fall inside the cooldown), the peak among
 * samples whose set modeled every room now running stands in — a superset
 * sample cannot double-count anyone, and it is what keeps the envelope honest
 * across a turn-off (and across the shed-and-restore trough of the 2026-07-31
 * trip).
 *
 * null and 0 are different answers on purpose: an exact-set sample of 0.0 A is
 * a real measurement of a house that owes nothing, and it must outrank both a
 * superset carry and the cross-source carry below.
 */
function peakUsableAmps(
  rec: SourceHouseLoad | undefined,
  now: number,
  acs: readonly AcView[],
): number | null {
  if (rec == null) return null;
  const runningSet = runningSetOf(acs);
  const members = runningSet === "" ? [] : runningSet.split(",");
  let exactPeak: number | null = null;
  let carriedPeak: number | null = null;
  for (const s of rec.samples) {
    if (now - s.at >= HOUSE_LOAD_WINDOW_MS) continue;
    if (s.runningSet === runningSet) {
      if (exactPeak == null || s.amps > exactPeak) exactPeak = s.amps;
    } else {
      const sampled = s.runningSet.split(",");
      if (members.every((id) => sampled.includes(id)) && (carriedPeak == null || s.amps > carriedPeak)) {
        carriedPeak = s.amps;
      }
    }
  }
  return exactPeak ?? carriedPeak;
}

/**
 * Worst-case non-AC load on `source`. Fresh same-source evidence always wins;
 * failing that, the OTHER source's record stands in under the same set/superset
 * and 15-minute rules (2026-08-04).
 *
 * The non-AC house does not care which line feeds it, and a changeover ages the
 * new source's record out by definition — which is precisely when the envelope
 * most needs a number, because entry re-levels the whole house. On 08-04 that
 * hole read as `0.0A house` and admitted two raises onto a 6A house. Of the two
 * available answers, "measured on the other line minutes ago" beats "no house at
 * all" — 0 is the one value known to be wrong.
 *
 * Direction of the failure: the sole consumer is the RAISE envelope on gen
 * (`RaiseInput.nonAcAmps`), and the generator feeds at most what the grid does,
 * so a grid figure carried onto gen over-states the house and over-blocks. That
 * is the safe direction, and it self-corrects the moment gen samples exist.
 *
 * 0 when neither record holds anything comparable: the honest answer for an
 * unmeasured house, reproducing the old AC-only envelope rather than inventing a
 * reserve, so a fresh boot is never MORE permissive than the code this replaced.
 */
export function houseLoadAmps(
  state: HouseLoadState,
  source: PowerSource,
  now: number,
  acs: readonly AcView[],
): number {
  if (source === "none") return 0;
  const own = peakUsableAmps(state[source], now, acs);
  if (own != null) return own;
  const other: PowerSource = source === "gen" ? "grid" : "gen";
  const carried = peakUsableAmps(state[other], now, acs);
  if (source !== "grid") return carried ?? 0;
  // GRID ONLY (2026-09-27, Stream G): with no fresh grid evidence, the grid
  // house is at least what the last grid session measured. The generator's
  // record cannot see grid-only load, so on its own it under-states the grid
  // house on almost every grid entry (4A carried vs a real 12A).
  const remembered = rememberedSessionPeak(state.grid, now);
  if (carried == null && remembered == null) return 0;
  return Math.max(carried ?? 0, remembered ?? 0);
}

/**
 * The house the LAST session on this record measured: the peak of the samples
 * inside `HOUSE_LOAD_WINDOW_MS` before that session's final usable sample, i.e.
 * the rolling peak the record itself was reporting when the session ended,
 * frozen in `SourceHouseLoad.session` (the ring is pruned on the first tick
 * back, before any new sample is usable). null when there is none, or when its
 * last sample is older than `GRID_SESSION_MEMORY_MS`.
 *
 * Every sample in the ring was already VALID when it was taken (the ramping
 * skip, the trust gap, the modeled-drop cooldown, the shell's suppressions and
 * the phantom-ON void all gate what gets in: invariants 16, 20, 23, 28, 44), so
 * this adds no new way for a residual taken while model and meter were out of
 * step to be believed.
 *
 * Deliberately across running SETS, unlike `peakUsableAmps`. The set rules
 * exist to stop a room's draw being charged twice, as house and as a cap, and
 * this figure's only consumers (the grid entry budget and the grid roomy lane's
 * model test) can only get MORE conservative from a higher house: a room
 * double-counted here holds a level lower for the minutes until fresh grid
 * samples exist, which is the direction that cannot overload the line.
 */
function rememberedSessionPeak(rec: SourceHouseLoad | undefined, now: number): number | null {
  const session = rec?.session;
  if (session == null || now - session.lastAt > GRID_SESSION_MEMORY_MS) return null;
  return session.peakAmps;
}

/**
 * How far back a discovered turn-on invalidates samples. A cloud shadow can lag
 * the physical compressor by anything from 5.8 s to 13 minutes (Najat's
 * firmware), and nothing in a discovered ON says when the room actually
 * started — so the honest window is the whole ring.
 */
export const EXTERNAL_ON_VOID_MS = HOUSE_LOAD_WINDOW_MS;

/**
 * Retroactively drop samples that could not have known `excludeDeviceId` was
 * running — the RISE-side twin of the modeled-drop cooldown (invariant 20).
 *
 * `runningSetOf` keys off the cloud shadow, so a room that is physically
 * drawing while its shadow still says off is missing from both the model and
 * the tag: its entire draw lands in the residual as "house", tagged with the
 * set that EXCLUDES it — which is exactly the set that recurs every time it is
 * shed again, so the phantom becomes the peak of record for a full 15 minutes.
 * Live 2026-08-02: 6.0A of "house" against a real ~2.7A, and every raise
 * refused at "worst case 17.6A > 14.9A" on an 11–12A meter.
 *
 * Called the moment the shell learns the room was on — its own restore
 * confirming, an external ON observed on the live poll, or the tick's
 * structural flip. Samples taken with that room already in their set are kept:
 * those were honest.
 */
export function voidSamples(
  state: HouseLoadState,
  source: Exclude<PowerSource, "none">,
  opts: { excludeDeviceId: string; since: number },
): HouseLoadState {
  const rec = state[source];
  if (rec == null) return state;
  const samples = rec.samples.filter(
    (s) => s.at < opts.since || s.runningSet.split(",").includes(opts.excludeDeviceId),
  );
  if (samples.length === rec.samples.length) return state;
  // A voided sample must not survive in the session memory either, but the void
  // may never make the memory SMALLER than the last valid peak that preceded the
  // voided evidence (review, 2026-09-27: back on grid, the entry tick prunes the
  // ring, a later sample replaces the 12A memory, the shell then voids that
  // sample, and recomputing from the now-empty ring dropped the grid figure to
  // the 4A generator carry). The older memory is only dropped when IT is the
  // voided evidence: its peak sample taken inside the void window without the
  // room in its set.
  const voided = (m: SessionPeak | undefined): boolean =>
    m != null && m.peakAt >= opts.since && !m.peakSet.split(",").includes(opts.excludeDeviceId);
  const beyond = memoryBeyond(rec.session, rec.samples);
  const kept = voided(beyond) ? undefined : beyond;
  const base = sessionOf(samples);
  const best = base == null ? kept : kept == null || base.peakAmps >= kept.peakAmps ? base : kept;
  const session: SessionMemory | undefined = best == null ? undefined : { ...peakOnly(best), prior: kept };
  return { ...state, [source]: { ...rec, samples, session } };
}
