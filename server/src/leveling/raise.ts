// Headroom spending for leveling v2: shed restores, warm restores, one-step
// level raises, and the hard-invariant corrections (never level 0, boost
// floors, gen start clamp). Pure — pacing gates are consulted here but mutated
// by the caller.
//
// Ordering (ported user decisions): a feasible shed RESTORE outranks every
// raise ("all ACs on beats higher levels"); a restore gated only by pacing
// RESERVES its amps so raises can't steal them (v2 change — v1 parked every
// raise globally, stranding rooms for 49m+); raises are meter-anchored and
// one-step, most-needy room first; on gen only ONE raise command per batch
// (the 07-23 double-raise landed 16.6A on a 14.9A limit).

import type { AcView, Command, CostEstimate, Decision, PowerSource } from "./types.js";
import type { CostBook } from "./costs.js";
import { levelCutSavings, modelCutAmps, modelFor, raiseJumpAmps, restoreCostAmps, steadyDraw } from "./costs.js";
import type { LevelingConfigV2 } from "./config.js";
import { rampCommittedAmps } from "./dead-window.js";
import { ceilCapOf, ceilOf, floorOf, isNonCooling } from "./needs.js";
import { SHED_NEED_GAP_C } from "./reduce.js";
import { PENDING_CUT_MS } from "./sensing.js";
import {
  attemptedWithin,
  bounceBackoffMs,
  canAttempt,
  probeRearmed,
  RESTORE_CONFIRM_WAIT_MS,
  restoreBounces,
  restoreFailures,
  type PacingState,
} from "./pacing.js";

/**
 * Physics-envelope total: worst-case steady draw of a commanded end-state,
 * summed from the per-AC cap models. A gen level is a firmware CAP — under
 * binding (hot) demand the compressor is entitled to the whole cap, and the
 * meter only shows that minutes later (or never, when the ESP hangs frozen).
 * This is the number that already knew "expected 16.9A > 15A" when the
 * 2026-07-23 double-L3 batch shipped and tripped the gen breaker.
 *
 * AC-ONLY by construction. The non-AC term is supplied separately by the
 * caller (see `RaiseInput.nonAcAmps` and house-load.ts) because the two
 * consumers want different answers: a RAISE must be priced against the whole
 * house, while a shed RESTORE is deliberately left on the AC-only figure —
 * refusing a restore strands a room off entirely, which the user has ranked
 * worse than riding near the limit, and the restore path already has a
 * meter-anchored gate that includes the house load by definition.
 */
export function envelopeTotalAmps(
  entries: Array<{ deviceId: string; level: number; maxLevel: number }>,
  config: LevelingConfigV2,
  source: Exclude<PowerSource, "none">,
): number {
  return entries.reduce(
    (sum, e) => sum + steadyDraw(e.level, e.maxLevel, modelFor(config, e.deviceId, source)),
    0,
  );
}

/** One ramping commitment, as the absorption pool needs to see it. */
export interface AbsorptionEntry {
  /** Modeled amps this ramp has committed and is still owed. */
  committedAmps: number;
  /** The smoothed meter when this ramp armed, or null (unmeasurable). */
  baselineAmps: number | null;
  /** The largest rise above that baseline the meter has ever shown for it. */
  ratchetAmps: number | null;
}

/**
 * How much of each ramping commitment the meter has demonstrably absorbed, out
 * of ONE shared pool (2026-08-05).
 *
 * The rise a compressor's arrival puts on the meter is a WHOLE-HOUSE delta.
 * Every consumer of it used to read it per AC — `max(0, smoothed − its own
 * baseline)` — and then SUM the leftovers, so with two rooms ramping the same
 * amps were spent against both debits at once. Live 2026-08-04 recovery, and
 * uncovered when the smoothing window widened on 2026-08-05: both rooms armed
 * at a 5.05A baseline, the meter reached 10.87A, and the 5.82A rise cancelled
 * Abdullah's 4.1A and Abdu's 4.5A independently — 8.6A of committed compressor
 * reported as fully absorbed by 5.8A of measured rise. A restore was admitted
 * into that hole and a peer's level had to be cut 40s later to pay for it.
 *
 * Two bounds, both load-bearing:
 *
 *  - **Per AC**, absorption cannot exceed what the meter has risen since THAT
 *    ramp armed (ratcheted — see `rampDebitAmps`; a peer's departure must not
 *    un-prove amps that arrived). A room whose baseline postdates part of the
 *    rise did not cause that part and may not claim it.
 *  - **In total**, absorption cannot exceed the rise the house has actually
 *    shown. That figure is `max` over the per-AC ratcheted rises: the largest
 *    is measured from the earliest-armed (lowest) baseline, which is exactly
 *    the whole episode's rise, and taking it from the per-AC ratchets keeps the
 *    pool monotone for free — a smoothed dip can never un-absorb.
 *
 * Apportioned **proportionally to each ramp's own priced commitment**, rather
 * than oldest-baseline-first: `AcView` carries baselines but not arm times, so
 * "oldest" would have to be inferred from the baseline VALUE, which is only
 * true while the meter is rising monotonically — and it is a falling meter
 * (invariant 27's landing cut, invariant 20's wind-down) that this code is most
 * often asked about. Proportional needs no ordering, is stable under a
 * reordered array, and splits a shared rise the way the physics does: the
 * bigger compressor is most of the rise it caused.
 *
 * Leftover pool is deliberately NOT redistributed to ramps that are still under
 * their cap. That under-credits (a spender waits a little longer), which is the
 * safe direction; over-crediting is the direction that trips breakers.
 */
export function absorbedSharesAmps(
  entries: readonly AbsorptionEntry[],
  smoothedAmps: number,
): number[] {
  // No baseline, no credit — ratchet or not (see `rampDebitAmps`).
  const caps = entries.map((e) =>
    e.baselineAmps == null ? 0 : Math.max(0, smoothedAmps - e.baselineAmps, e.ratchetAmps ?? 0),
  );
  const poolAmps = caps.reduce((max, cap) => Math.max(max, cap), 0);
  const totalCommitted = entries.reduce((sum, e) => sum + Math.max(0, e.committedAmps), 0);
  if (!(poolAmps > 0) || !(totalCommitted > 0)) return entries.map(() => 0);
  return entries.map((e, i) =>
    Math.min(caps[i], (poolAmps * Math.max(0, e.committedAmps)) / totalCommitted),
  );
}

/**
 * Amps that ramping ACs have already COMMITTED but the meter has not absorbed
 * yet — the budget the house owes but cannot see.
 *
 * A compressor reaches its cap over ~4 minutes, so for those minutes the meter
 * under-reports the load that is already on its way. `planRaise` has always
 * refused to raise an AC while IT is ramping — but nothing stopped it raising a
 * PEER on the same phantom headroom, and that is exactly what tripped the gen
 * on 2026-07-26: Abdu was restored at 10:25:45, and 37s later the journal shows
 * `Abdu: raise blockedBy "ramping"` in the SAME batch that raised Najat L1→L2,
 * then L2→L3 35s after that. Both were admitted against a meter that had seen
 * almost none of Abdu's 4.3A. The controller's freshly-on projection could not
 * cover it either: it lives for exactly ONE tick (`freshlyOn` is cleared at the
 * top of every tick), and both raises landed after it.
 *
 * Per AC: what the cap model says it will pull at its current level, minus what
 * the meter has actually risen since its compressor started. Deliberately
 * conservative in two ways — a null baseline charges the WHOLE draw (unknown
 * absorption is not evidence of absorption), and level 0 charges the
 * unrestricted draw. Both err toward not spending.
 *
 * Absorption RATCHETS (2026-07-27). The live rise is only half the story: it is
 * a whole-house delta, so any load that leaves after the ramp armed masks it.
 * On 2026-07-27 the reducer cut ~2.5A off two peers two minutes into Najat's
 * ramp, dropping the house 1.5A below her baseline — `smoothed − baseline`
 * clamped to 0 and she was re-charged her entire 2.3A for the remaining half of
 * her window, fencing a fan restore (and every raise) on a meter that had been
 * calm and 1.5A under the ceiling the whole time. So the credit is the LARGER
 * of the live rise and the peak rise this ramp has already shown: absorption is
 * a one-way fact, and a peer's departure cannot un-prove amps the meter saw
 * arrive. Still bounded by the baseline — no baseline, no credit, ratchet or not.
 *
 * Absorption is also POOLED (2026-08-05, `absorbedSharesAmps`). It used to be
 * per-AC, and this comment used to call the shared rise "counted twice … errs
 * toward not spending" — which had the sign backwards and stood for months.
 * Crediting the same amps to every ramping AC does not raise the debit, it
 * SINKS it: with two rooms ramping from one baseline, a 5.8A rise cancelled
 * 4.1A of Abdullah AND 4.5A of Abdu, and the whole 8.6A of committed load
 * reported as fully absorbed. That is the trip direction, and it is invariant
 * 12's own premise inverted — the house rose once, so it can only pay once.
 *
 * SPENDING SIDE ONLY. This must never inflate the reducer's savings target: a
 * ramping AC's inrush is transient and the 2026-07-25 storm proved that acting
 * on it sheds rooms for load that decays on its own (see pipeline.ts inrush
 * blanking). It gates what we ADD, never what we cut.
 */
export function rampDebitAmps(
  acs: AcView[],
  smoothedAmps: number,
  config: LevelingConfigV2,
  source: Exclude<PowerSource, "none">,
): number {
  const live = acs.filter((ac) => ac.on && ac.managed && !ac.shed);
  const ramping = live.filter((ac) => ac.ramping);
  // The committed draw the ramp was armed against — the SAME figure the
  // early-release path checks the ratchet against (`rampCommittedAmps`), so a
  // ramp can never be charged as owed here while it is released as absorbed there.
  const committed = ramping.map((ac) => rampCommittedAmps(ac, config, source));
  const absorbed = absorbedSharesAmps(
    ramping.map((ac, i) => ({
      committedAmps: committed[i],
      baselineAmps: ac.rampBaselineAmps,
      ratchetAmps: ac.rampAbsorbedAmps,
    })),
    smoothedAmps,
  );
  const rampOwed = committed.reduce((sum, c, i) => sum + Math.max(0, c - absorbed[i]), 0);
  // Not starting, but a recent level raise (or fan restore) may still be
  // arriving. Charged only for a settled AC: a RAMPING one is already charged
  // its whole steady draw at its current (raised) level above, which subsumes
  // the jump.
  //
  // ⚠ These arrive PRE-NETTED (`controller.unmeteredJumpAmps` subtracts each
  // debit's own absorbed peak before the view is built), so the pool cannot
  // reach them and two rooms with live jump debits still credit the same rise
  // twice. Same bug class as the one fixed above, same invariants (12 and 18) —
  // closing it needs the GROSS debit and its baseline on `AcView` so the
  // netting happens here, in the pure layer, alongside the ramps.
  const jumpOwed = live.reduce(
    (sum, ac) => (ac.ramping ? sum : sum + Math.max(0, ac.unmeteredJumpAmps)),
    0,
  );
  return rampOwed + jumpOwed;
}

/**
 * Highest level a freshly-turned-on AC may be driven to on GRID, priced as
 * `pre-start house load + its own modeled steady draw at that level` against
 * the resting ceiling. Returns null when not even one step above its current
 * level fits.
 *
 * Why not the meter (2026-07-25): a TCL restores the gen level it was last
 * left at, so an AC turned on while on grid comes back at its previous gen
 * floor (L1) — and for `AC_RAMP_MS` the compressor is still ramping, which
 * blocks the ordinary raise path entirely (live: Abdu came on at L1 at 08:00:45
 * with ~5A of headroom and only reached L3 at 08:05:26). Lifting it during the
 * ramp means the meter has NOT yet absorbed this AC's own draw, so
 * meter-anchored admission would spend phantom headroom. The pre-start baseline
 * is the honest anchor: it is the rest of the house, and the AC's whole steady
 * draw at the target level is charged on top of it.
 */
export function gridStartLevel(
  ac: AcView,
  ceil: number,
  config: LevelingConfigV2,
  ceilingAmps: number,
): number | null {
  if (ac.startBaselineAmps == null) return null;
  const model = modelFor(config, ac.deviceId, "grid");
  let target = Math.min(ceil, ac.maxLevel);
  while (
    target > ac.currentLevel &&
    ac.startBaselineAmps + steadyDraw(target, ac.maxLevel, model) > ceilingAmps
  ) {
    target--;
  }
  return target > ac.currentLevel ? target : null;
}

/**
 * How much HOTTER (°C above its own target) a blocked raiser must run than a
 * peer before the peer's standing level is traded over (user, 2026-08-01:
 * "the extra level should switch to the hotter room"). At the 0.1°C sensor
 * granularity this is seven whole LSBs — reading noise cannot arm a trade, and
 * a reverse trade needs the rooms to genuinely cross by the same margin.
 */
export const REBALANCE_NEED_GAP_C = 0.7;

/**
 * A comparative-need trade must leave the receiver's raise fitting with this
 * much to SPARE once the donor's cut lands. The deficit is read off a noisy
 * meter — the acceptance suite's ±0.5A resting-point noise armed a trade on
 * every dip, and because the freed amps then fit the DONOR's cheaper re-raise
 * but not the receiver's step, the level bounced donor↔receiver on a 35s
 * period. Sized to the observed noise band so a trade can only arm when it
 * fits across the whole band.
 */
export const REBALANCE_FUND_MARGIN_AMPS = 0.5;

/**
 * How much HOTTER a shed room must be than a RUNNING peer before that peer's
 * WHOLE ROOM is traded for it — the gated proactive shed (user, 2026-08-06,
 * after the 02:21–02:49 heater episode: *"after Najat on and be stable, there
 * was enough budget to turn off Najat and bring Abdu back on"*).
 *
 * Deliberately `SHED_NEED_GAP_C` and NOT `REBALANCE_NEED_GAP_C` (0.7). The
 * rebalance trades ONE LEVEL between two running rooms; this trades a whole
 * room's cooling, which is the shed-side question — "who may be switched off so
 * another room keeps running?" — and the user calibrated that constant himself
 * on 2026-08-04 ("1 c is enough to switch between acs"). One gap rule for every
 * decision about who loses their room, not a second constant to drift from it.
 *
 * It is also the anti-oscillation hysteresis, and the asymmetry is the whole of
 * it: the donor leaves the trade `SWAP_NEED_GAP_C` cooler than the receiver, so
 * for the donor to win the room back the two rooms must genuinely CROSS by the
 * same margin — ~2 × gap of real thermometer movement. Sensor noise (0.1 °C
 * LSB) cannot ping-pong a swap, and the reverse swap is structurally impossible
 * until the rooms have actually swapped places.
 */
export const SWAP_NEED_GAP_C = SHED_NEED_GAP_C;

/**
 * Quiet the gated proactive shed owes the LADDER after any over-limit batch.
 *
 * The meter-level gates (`swapAllowed`) all read the CURRENT tick: bucket full,
 * mean under the limit, no credit outstanding. None of them remembers that the
 * reducer was working a minute ago — and 50 s after a level cut the acceptance
 * replay showed exactly that: meter settled, calm re-established, credit
 * absorbed, arithmetic closing, and a room switched off inside an episode the
 * house had not finished digesting. A comfort optimisation has nothing to lose
 * by waiting and a room to lose by not.
 *
 * `PENDING_CUT_MS` by DERIVATION, not by value: it is this controller's own
 * standing answer to "how long may a cut we commanded still be landing?"
 * (invariants 5 and 48). One number, so the two cannot drift apart.
 */
export const SWAP_QUIET_AFTER_OVER_MS = PENDING_CUT_MS;

/**
 * How long after a human turns a room ON that room is shielded from being picked
 * as a proactive-shed DONOR (`AcView.recentlyExternalOn`). "Manual wins"
 * (invariant 42) must cover the power button for the COMFORT tool: the swap is
 * documented as "a comfort optimisation, never an emergency tool", so it may
 * never un-do a human's explicit ON. Live 2026-08-06 18:35–19:14Z — the leveler
 * shed the priority-#1 room, a household member turned it back on three times,
 * and the swap re-selected it as donor and shed it again TWICE (#9224/#9228, the
 * second 1.6 s after the first's reservation expired). The occupant then killed
 * the whole controller for seven hours.
 *
 * Fifteen minutes because it is the SAME number the collector's power-event
 * guard uses (`AC_POWER_EVENT_GRACE_MS` / the shell's
 * `POWER_EVENT_LEVEL_JUMP_GRACE_MS`): a TCL power-blink RESTORES its last level,
 * which in the shadow is character-for-character an external ON (invariant 56),
 * so the two edges must judge on one clock or they drift. Shielding a blinked
 * room from DONATING for fifteen minutes costs a comfort tool nothing — an
 * ordinary overload shed of the same room stays allowed (invariant 43).
 */
export const EXTERNAL_ON_DONOR_SHIELD_MS = 15 * 60_000;

/**
 * How long a restore may sit refused ONLY by the supply-flicker margin before it
 * is admitted at the bare (un-charged) ceiling anyway (invariant 58 follow-up,
 * 2026-08-08, user directive: rooms that ultimately ran fine sat refused behind
 * the flicker margin).
 *
 * The flicker charge (`chargedRestoreCeiling`, invariant 58) is a MARGIN, not a
 * price — a room refused by it fits the bare ceiling and is only waiting for a
 * steadier line. A wobble that never settles must not strand the room forever, so
 * after this much continuous flicker-only refusal the room admits at the bare
 * ceiling.
 *
 * 120 s sits far outside the shape invariant 58 was written against: the
 * 2026-08-06 double shed re-admitted the room 34 s after its shed, so a patience
 * window this long can never re-create it. And a patience admission that is wrong
 * is not silent — it re-sheds and winds invariant 67's bounce backoff, which is
 * the net under it.
 */
export const FLICKER_PATIENCE_MS = 120_000;

/** A proactive-shed trade: switch `donorId` off so `receiverId` can come back. */
export interface SwapDecision {
  donorId: string;
  receiverId: string;
}

export interface SwapDonorInput {
  /** The shed room we want back — the hottest shed candidate, and only it. */
  receiver: AcView;
  /** Every ON, managed, un-shed AC (the pool donors are drawn from). */
  running: readonly AcView[];
  /**
   * What the receiver's return costs at the PLAIN learned price. NEVER the
   * gentle probe price: the fan pin does not shrink a compressor (invariant 3),
   * and a swap spends a whole room's comfort — it may not be armed on the one
   * price the house has already proved optimistic.
   */
  receiverCostAmps: number;
  /**
   * The committed meter the receiver's restore is judged against — bar-aware
   * (invariant 54) and ramp-debited, exactly the figure the ordinary admission
   * used to refuse it.
   */
  committedAmps: number;
  /** The restore ceiling (limit − margin). */
  ceilingAmps: number;
  /**
   * Model-priced steady draw a donor's `power_off` frees. Model, not
   * max(model, learned): this is the SAME number `commandedCutAmpsOf` will
   * credit the collapse detector with (invariant 11), and a swap must never
   * admit more amps than the credit it arms.
   */
  donorSavingsAmps: (donor: AcView) => number;
  /**
   * Worst-case cap-model envelope of the end-state after `donor` goes off and
   * the receiver returns at its floor; null when the source is not
   * envelope-guarded. The meter is not the only judge of a commanded end-state
   * (invariant 16 / hard rule 5c).
   */
  envelopeAfter: ((donor: AcView) => number) | null;
  /** Donor is serving a funding/victim cooldown and may not be touched. */
  blocked: (deviceId: string) => boolean;
}

/**
 * Pick the one room to switch OFF so a hotter shed room can come back — the
 * gated proactive shed, un-parked 2026-08-06 (reduce.ts's invariant-39 note
 * named it as the missing piece; the 02:21 incident is its confirming case).
 *
 * The whole shape of this morning: a heater put the non-AC house at 7.4 A on a
 * 15 A generator, the reducer shed Najat (26.5 °C) and Abdu (28 °C), Najat's
 * cheaper 3.35 A restore fitted first and took the headroom, and Abdu's 4.3 A
 * then did not fit for SEVENTEEN MINUTES — until the heater cycled off on its
 * own. The house had the amps for the hotter room the entire time; what it did
 * not have was a way to spend a cool room's amps on a hot one.
 *
 * Every gate below is load-bearing, and each fails CLOSED (no swap):
 *
 *  - **Need gap** (`SWAP_NEED_GAP_C`) — the donor must be meaningfully cooler.
 *    Ranked on `rankNeedDelta`, the one question asked of every room in the
 *    same unit (invariant 50): a feels-like metric must never decide which room
 *    loses its compressor.
 *  - **Unpinned** — a `manualTarget`/`manualCap` is user intent, and manual
 *    always wins. Configured PRIORITY is deliberately NOT a shield: the user's
 *    2026-08-04 policy is that the thermometer decides and the coolest room
 *    goes off, top-priority included.
 *  - **Not just switched on by a human** (`recentlyExternalOn`) — "manual wins"
 *    covers the power button too, not only a level pin (invariant 42). A bare
 *    ON mints no pin, so before this the swap traded away the very room a
 *    household member had switched back on, three times over (2026-08-06
 *    #9224/#9228). An ordinary overload shed of that room stays allowed — only
 *    the comfort trade is barred.
 *  - **Not ramping** — a compressor mid-start has not shown its amps yet, so
 *    neither its saving nor the meter it would leave behind is knowable.
 *  - **Not cooling down** — a room inside a funding or victim cooldown is
 *    already paying for something (invariants 30 and 35).
 *  - **Not the last room running** — a swap re-arranges cooling; it may not
 *    empty the house on the way through.
 *  - **It must actually CLOSE the gap** — the receiver has to fit AFTER the
 *    donor's off lands, with `REBALANCE_FUND_MARGIN_AMPS` to spare, on BOTH the
 *    meter and the physics envelope. A trade that leaves the receiver still
 *    refused has spent a room's comfort for nothing.
 *
 * Coolest eligible donor first, and the FIRST one whose off makes the receiver
 * fit wins — never the biggest saving, which would trade a warm room's whole
 * compressor when a cooler one covered the gap.
 */
export function swapDonorFor(input: SwapDonorInput): { donor: AcView; freedAmps: number } | null {
  const { receiver, running } = input;
  // A swap re-arranges cooling between rooms; with one room running there is
  // nothing to re-arrange, only a house to empty.
  if (running.length < 2) return null;
  const eligible = running
    .filter(
      (a) =>
        a.deviceId !== receiver.deviceId &&
        a.on &&
        a.managed &&
        !a.shed &&
        !a.ramping &&
        a.manualTarget == null &&
        a.manualCap == null &&
        // A human just switched this room ON — the comfort trade may not un-do
        // it (invariant 42/57, 2026-08-06 #9224/#9228). An overload shed still can.
        !a.recentlyExternalOn &&
        !input.blocked(a.deviceId) &&
        a.rankNeedDelta + SWAP_NEED_GAP_C <= receiver.rankNeedDelta,
    )
    .sort((x, y) => x.rankNeedDelta - y.rankNeedDelta);
  for (const donor of eligible) {
    const freedAmps = input.donorSavingsAmps(donor);
    if (!(freedAmps > 0)) continue;
    const after = input.committedAmps - freedAmps + input.receiverCostAmps;
    if (after + REBALANCE_FUND_MARGIN_AMPS > input.ceilingAmps) continue;
    if (input.envelopeAfter != null && input.envelopeAfter(donor) > input.ceilingAmps) continue;
    return { donor, freedAmps };
  }
  return null;
}

export interface RaiseInput {
  /** ALL managed AC views (on and off/shed), pre-sorted by priority. */
  acs: AcView[];
  /** Room under the resting ceiling (limit − margin − restingBuffer − smoothed). */
  headroomAmps: number;
  smoothedAmps: number;
  /**
   * Committed-but-unmetered draw of ramping ACs (see rampDebitAmps). Charged
   * against BOTH the restore admission and the raise budget: the meter is not
   * a valid anchor while load it has not seen is still arriving.
   */
  rampDebitAmps: number;
  /**
   * Measured worst-case non-AC house load on this source (house-load.ts). Added
   * to the physics envelope for RAISES only — the 2026-07-31 gen trip was an
   * envelope of 13.9A admitting an end-state that measured 15.95A, and the
   * whole 2.0A gap was the house the guard never counted.
   */
  nonAcAmps: number;
  /**
   * The supply-flicker MARGIN a spender must survive (`MeterView.flickerMarginAmps`,
   * the LARGEST reverting excursion) — 0 on a quiet, stale or unestimable line.
   * Charged as MARGIN against the RESTORE ceiling only; see `restoreCeiling` below
   * for why, and why raises are deliberately left out. NOT the accurate
   * `flickerAmps` classification figure (the second-largest): a restore admitted
   * with only the runner-up of margin re-crosses on the biggest spike and bounces
   * (2026-08-06, invariant 58 / hard rule 5c).
   */
  flickerMarginAmps: number;
  /**
   * The smoothed meter as it stood when the reducing batch still in flight was
   * commanded, or 0 when no cut is live. With `commandedCutAmps` this says
   * where the meter is HEADING, which is what a restore must be judged against
   * while a shed's own fall is still in progress (see `landingAmps`).
   */
  cutAnchorAmps?: number;
  /** What that in-flight cut was priced to save (0/absent when none). */
  commandedCutAmps?: number;
  limitAmps: number;
  calmMs: number;
  config: LevelingConfigV2;
  book: CostBook;
  source: Exclude<PowerSource, "none">;
  now: number;
  pacing: PacingState;
  /**
   * Devices that recently gave up a level to fund a PEER's raise, and may not
   * take it back yet. A funding demote deliberately ships alone — the raise it
   * pays for waits for a meter that has really fallen — but a compressor takes
   * seconds to minutes to throttle down, and until it does the donor's own step
   * is the cheapest thing on the board. Live 2026-08-02: Najat was demoted to
   * fund Abdu, re-took the level 40s later before the meter had moved, was
   * demoted again, and cycled L1↔L2 indefinitely while Abdu never got his
   * level. Defaults to "nothing cooling" when the caller does not supply it.
   */
  fundingCooldown?: (deviceId: string) => boolean;
  /**
   * Devices the REDUCER just took a level from, which may not climb back yet.
   * The mirror of `fundingCooldown` for the involuntary case: an over-limit
   * batch cuts a room, the compressor takes seconds to minutes to throttle
   * down, and in the meantime the meter still shows the old draw — so the very
   * next calm window admits the raise that undoes the cut. Live 2026-08-03
   * 00:41:10Z Abdullah was cut L2→L1 and raised back at 00:42:44, 94s later,
   * into the same overload. Defaults to "nothing cooling".
   */
  victimCooldown?: (deviceId: string) => boolean;
  /**
   * The meter bar a room's OWN restore must clear while its shed is still
   * recent: the smoothed meter as it stood when that room was shed, less what
   * the shedding batch was priced to save. 0 when there is nothing to say.
   *
   * `cutAnchorAmps`/`commandedCutAmps` answer the same question globally and
   * for `PENDING_CUT_MS` only; this one is per-room and outlives the credit,
   * because the trough a shed digs outlives it too (R9 — see `barFor`).
   * Defaults to "no bar", i.e. exactly the pre-R9 admission.
   */
  shedBarAmps?: (deviceId: string) => number;
  /**
   * The gated proactive shed may arm this tick — the SITUATIONAL half of its
   * gate, owned by the caller (pipeline.ts): NORMAL mode, gen, no derate, no
   * collapse, no over-limit episode in flight and nothing landing. It is a
   * comfort optimisation, not an emergency tool, so it stands down whenever the
   * house is busy. Defaults to OFF — a caller that has not thought about it
   * never trades a room away.
   */
  swapAllowed?: boolean;
  /**
   * The proactive shed already in flight house-wide (donor → receiver), or null.
   * ONE at a time: while it is set no new swap may arm, and the receiver's amps
   * stay RESERVED across ticks until its restore lands (invariant 9 — the
   * saving is spent only once the meter has shown it).
   */
  swapInFlight?: SwapDecision | null;
  /**
   * When each shed room first sat refused ONLY by the supply-flicker margin, or
   * undefined for a room that is not (or not yet) flicker-refused. The shell owns
   * the anchor and stamps it from the plan's `flickerRefused` list; the pure
   * layer reads it to age a flicker-only refusal into a bare-ceiling admission
   * (see FLICKER_PATIENCE_MS). Mirrors the `fundingCooldown`/`shedBarAmps`
   * per-device-lookup pattern. Defaults to "nothing refused".
   */
  flickerRefusedSince?: (deviceId: string) => number | undefined;
}

export interface RaisePlan {
  commands: Command[];
  decisions: Decision[];
  /** Attempts to record in pacing (blame windows) — deviceId × kind. Restore
   *  attempts carry the committed meter admission saw (probe re-arm anchor). */
  attempts: Array<{ deviceId: string; kind: "raise" | "restore"; meterAmps?: number }>;
  /** True when the batch turns an AC on (longer settle/ramp downstream). */
  isTurnOn: boolean;
  /**
   * Amps held back for a feasible-but-gated shed restore. > 0 means the raise
   * phase was parked (see the parking guard) — the caller must also keep a fan
   * restore from spending these amps.
   */
  reservedAmps: number;
  /**
   * Restores in `commands` that were admitted at the gentle PROBE price
   * instead of the learned plain price — the recorded fan hold must carry
   * gentle=true so the freshly-on projection re-prices them identically.
   */
  probeRestoreIds: string[];
  /**
   * Model-priced total of any down-moves this plan emitted (funding demotes and
   * restore peer floor-downs) — the collapse detector's credit.
   */
  cutAmps: number;
  /**
   * Devices demoted in THIS plan to fund a peer's raise. The shell stamps them
   * so they cannot take the level straight back before the saving reaches the
   * meter (see `RaiseInput.fundingCooldown`).
   */
  fundingDonors: string[];
  /**
   * The proactive shed this plan ARMED (donor → receiver), or null. The shell
   * records it once the donor's `power_off` has actually shipped, so the
   * receiver's amps stay reserved across ticks until its restore lands.
   */
  swap: SwapDecision | null;
  /**
   * Shed rooms refused THIS tick ONLY by the supply-flicker margin (they fit the
   * bare ceiling). The shell stamps `flickerRefusedSince` for any without an
   * anchor and drops the anchor for any shed room that is NOT here, so patience
   * accrues only while the flicker-only refusal is unbroken (see
   * FLICKER_PATIENCE_MS).
   */
  flickerRefused: string[];
}

/**
 * Hard-invariant corrections that ship regardless of calm/pacing (but not in
 * COLLAPSED — no commands into a dead line): an ON managed AC observed at
 * level 0 is re-capped at its top commandable level; an AC below its boost
 * floor is lifted to it; and on GEN an AC still inside its turn-on window is
 * clamped down to its floor.
 *
 * **Gen start clamp (2026-07-30).** A TCL restores the generator level it was
 * last left at, and since GRID_FULL shipped that level is L3 — so a room turned
 * on mid-gen-session arrives at 6.3A on a 15A line with nothing admitting it.
 * FLOORS only arms on ENTRY into gen and ends within 5 minutes, so it does not
 * cover this (live 05:51 Baghdad: Najat came on at L3 33 minutes in, the house
 * rode 16.77A, and the user hand-set both rooms to L1 two minutes later).
 *
 * This is the per-device form of FLOORS, and it lives here rather than in the
 * raise planner for three reasons: it must ship in EVERY non-COLLAPSED mode
 * (a gen turn-on is over-limit by definition, so the raise phase never runs);
 * it is a reduction, so it can never fight the reducer; and `dedupeCommands`
 * gives the reducer the last word if it wants to cut deeper. Re-emitting while
 * unconfirmed is deliberate — same contract as FLOORS, and it doubles as the
 * confirm-or-resend Najat's firmware needs. It self-cancels once the shadow
 * confirms at or below the floor, and `floorOf` honours manual/slot/boost caps.
 */
export function invariantCorrections(
  acs: AcView[],
  now: number,
  source: PowerSource,
): { commands: Command[]; decisions: Decision[] } {
  const commands: Command[] = [];
  const decisions: Decision[] = [];
  for (const ac of acs) {
    if (!ac.on || !ac.managed || ac.shed) continue;
    if (ac.currentLevel === 0) {
      const cap = ceilCapOf(ac);
      commands.push({ deviceId: ac.deviceId, kind: "set_level", level: cap });
      decisions.push({ at: now, deviceId: ac.deviceId, action: `re-cap L${cap}`, detail: "never level 0" });
      continue;
    }
    const floor = floorOf(ac);
    // A room BELOW its comfort floor is deliberate since 2026-08-02: the
    // reducer's last rung before switching it off. Restoring that floor is
    // SPENDING, and this function is for invariants that hold regardless of
    // budget — so it is handled by the ordinary raise path instead, which
    // checks calm, headroom, the physics envelope and one-step pacing before it
    // buys the level back. `ceilOf` is never below `floorOf`, so the raiser
    // always targets at least the floor once it is affordable.
    //
    // Re-asserting it here — even gated on calm — is a limit cycle: the cut
    // frees amps, calm returns, the floor jumps straight back, the meter goes
    // over, and the reducer cuts again. The acceptance run did exactly that six
    // times in thirty minutes, at a ~100s period.
    if (ac.currentLevel < floor) continue;
    if (source === "gen" && ac.startBaselineAmps != null && ac.currentLevel > floor) {
      commands.push({ deviceId: ac.deviceId, kind: "set_level", level: floor });
      decisions.push({
        at: now,
        deviceId: ac.deviceId,
        action: `gen start L${floor}`,
        detail: `came on at L${ac.currentLevel} — gen turn-ons enter at their floor`,
      });
    }
  }
  return { commands, decisions };
}

/** "1st"/"2nd"/"3rd"/… for the LOUD bounce-backoff journal (2026-08-07). */
function ordinalBounce(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

export function planRaise(input: RaiseInput): RaisePlan {
  const { acs, config, book, source, now, pacing } = input;
  const decisions: Decision[] = [];
  const attempts: Array<{ deviceId: string; kind: "raise" | "restore"; meterAmps?: number }> = [];
  const commands: Command[] = [];
  /** Model-priced down-moves this plan emits (funding demotes, peer floor-downs). */
  let cutAmps = 0;
  const fundingDonors: string[] = [];
  /** Shed rooms refused this tick ONLY by the flicker margin (see RaisePlan). */
  const flickerRefused: string[] = [];

  const onManaged = acs.filter((a) => a.on && a.managed && !a.shed);

  // Physics-envelope veto (gen only — grid deliberately starts FULL and lets
  // the reducer trim): never command an end-state whose worst-case modeled
  // draw exceeds limit − margin, no matter how much room the meter shows.
  const envelopeCeiling = input.limitAmps - config.marginAmps;
  const envelopeGuard = source === "gen";
  const envelopeWith = (
    overrides: Record<string, number>,
    extra?: { deviceId: string; level: number; maxLevel: number },
    /** A room this batch is switching OFF — it draws nothing in the end-state. */
    excludeId?: string,
  ): number =>
    envelopeTotalAmps(
      [
        ...onManaged
          .filter((a) => a.deviceId !== excludeId)
          .map((a) => ({
            deviceId: a.deviceId,
            // `envelopeLevel`, not `currentLevel`: the shadow confirms minutes
            // late on some firmware, and a worst-case guard that prices a peer
            // at a level we already commanded it away from is not a guard at all
            // (2026-07-28 15:55:36 — Abdu L2→L3 admitted at a 13.6A envelope
            // because Najat's L3, sent 16 min earlier, had not confirmed; the
            // same end-state was vetoed at 15.6A once it did). An explicit
            // override always wins — those are commanded end-states this batch.
            level: overrides[a.deviceId] ?? a.envelopeLevel,
            maxLevel: a.maxLevel,
          })),
        ...(extra != null ? [extra] : []),
      ],
      config,
      source,
    );
  /**
   * The envelope a RAISE is judged against: the AC caps plus the measured
   * house. Restores keep using `envelopeWith` bare — see envelopeTotalAmps.
   */
  const raiseEnvelope = (
    overrides: Record<string, number>,
    extra?: { deviceId: string; level: number; maxLevel: number },
  ): number => envelopeWith(overrides, extra) + input.nonAcAmps;

  /**
   * The level a peer is being CHARGED for right now: its confirmed shadow, or
   * any higher level we sent and have not seen confirm (invariant 7's worst
   * case). Level 0 is UNRESTRICTED draw, which `steadyDraw` prices as the top
   * level, so a numeric max would read it as "below the floor" and silently
   * drop the biggest recoverable level of all.
   *
   * One definition, used by BOTH the at-floors credit and the floor-down
   * commands it promises — a plan that counts a level as recoverable and then
   * does not send the command to recover it is a plan that over-admits.
   */
  const chargedLevelOf = (a: AcView): number =>
    a.envelopeLevel === 0 ? a.maxLevel : Math.max(a.currentLevel, a.envelopeLevel);

  // ---- Restore phase: most-needy shed AC first, no queue jumping ----
  // Restores are exempt from the resting buffer (a whole room off is worse
  // than riding near the limit): fits under limit − margin.
  const restoreCeiling = input.limitAmps - config.marginAmps;
  /**
   * …and the same ceiling less the wobble the supply is going to show anyway
   * (2026-08-06 14:00–14:04Z, user: "why did it turn off both Najat and
   * Abdullah, when Najat-only-off was fine?").
   *
   * A saturated gen house shed Najat at 14:00:32 and settled at 11.6A — a state
   * the rest of the afternoon proved sufficient. Thirty-four seconds later this
   * phase bought her back: committed 12.12A + a 2.3A probe = 14.42A against a
   * 14.9A ceiling, admitted with 0.48A to spare on a line whose measured
   * flicker was ±0.4–0.8A. Her compressor and two held fans crossed 15.3A, she
   * was re-shed at 14:04:10 — and because her own cut had not yet crossed the
   * 8-wide median, Abdullah was shed 14s after that. His off/on cycle was pure
   * loss, and one off/on cycle costs a room several degrees.
   *
   * The buffer exemption above is a deliberate trade about a STEADY line: a
   * whole room off is worse than riding near the limit. Riding near the limit
   * on a MEASURED-wobbly line is not a tight ride — it is a bounce with a
   * delay, and a bounce costs the room its cycle plus the backoff ladder. So
   * the fixed buffer is replaced by a measured one: quiet line ⇒ zero charge
   * and this is byte-identical to the old behaviour (including grid, where the
   * flicker is ~0 and the headroom is huge anyway).
   *
   * MARGIN, never a price. `restoreCostAmps` and the probe pricing are
   * untouched, because admission and the controller's freshly-on projection
   * must re-price each other exactly (invariant 3, the 2026-07-25 storm). The
   * gated proactive shed is left out END TO END — it may neither be armed nor
   * refused by this charge, and it carries `REBALANCE_FUND_MARGIN_AMPS` as its
   * own margin (see `ceilingFor` in the loop below for both halves and the
   * evidence). Level RAISES are also left uncharged: they answer to the physics
   * envelope plus the measured house (invariant 16), and the failure being
   * fixed here is restore-shaped.
   *
   * Written as a `> 0` test rather than `Math.max`, deliberately: an absent or
   * NaN estimate then degrades to "quiet line", i.e. to the behaviour this
   * replaces. A NaN reaching the ceiling would make every comparison false and
   * strand every shed room off in silence — the worse failure by the user's own
   * ranking, and the one this margin exists to avoid in the first place.
   */
  const flickerCharge = input.flickerMarginAmps > 0 ? input.flickerMarginAmps : 0;
  const chargedRestoreCeiling = restoreCeiling - flickerCharge;
  const flickerNote = flickerCharge > 0 ? ` (−${flickerCharge.toFixed(1)}A flicker)` : "";
  const restoreCalmOk = input.calmMs >= config.restoreCalmSeconds * 1000;
  let reservedAmps = 0;
  /**
   * Where the meter is HEADING while a cut we commanded is still landing: the
   * meter as it stood before that cut, less what the cut was priced to save.
   *
   * A shed's own fall is not evidence that the house has shrunk. The room's
   * draw leaves at once while the survivors are mid-cycle, so for a minute or
   * two the meter reads far below what this configuration actually costs. Live
   * 2026-08-03: Najat was shed and restored FOUR times in 23 minutes, every
   * restore admitted at a 9.5–12.5A meter while the settled three-room draw was
   * ~15A. Always affordable at admission, never affordable a minute later.
   *
   * Deliberately the meter's OWN history, not `Σ modelled draw + house`. That
   * sum looks like the same number and is not: a meter below it also describes
   * rooms genuinely drawing under their models (satisfied compressors cycling),
   * and treating that as lag invents load and strands a room off — the failure
   * invariant 16 exists to prevent, and it broke that invariant's own test.
   * The anchor is only a claim about amps WE removed, and it expires with the
   * pending cut (`PENDING_CUT_MS`), by which time the meter is the truth again.
   */
  const cutAnchor = input.cutAnchorAmps ?? 0;
  const landingAmps = cutAnchor > 0 ? cutAnchor - (input.commandedCutAmps ?? 0) : 0;
  // The meter plus the load already on its way to it — the honest picture of
  // what this house is committed to right now — and never below where a cut in
  // flight is taking it.
  const committedAmps = Math.max(input.smoothedAmps + input.rampDebitAmps, landingAmps);
  const rampNote = input.rampDebitAmps > 0 ? ` (+${input.rampDebitAmps.toFixed(1)}A ramping in)` : "";
  /**
   * The same claim as `landingAmps`, but about ONE room and for longer: where
   * the meter stood when THIS room was shed, less what that batch was priced to
   * save (R9).
   *
   * `landingAmps` expires with `PENDING_CUT_MS` (180 s), and it is shared — any
   * later cut re-anchors it, and any absorption spends it. Both are correct for
   * the question it answers ("is the house still falling"), and both are wrong
   * for this one: 30 seconds after a shed the credit can already be gone, the
   * meter is sitting in the trough its own shed dug, and the room that shed
   * looks affordable again. Live 07:19→07:20 today a restore was admitted 31
   * seconds after the shed that caused it; on 2026-08-02 the same shape ran
   * four times. Invariant 41 named the trough; this is the part of it that
   * outlives the credit.
   */
  const barFor = (deviceId: string): number => input.shedBarAmps?.(deviceId) ?? 0;

  const shedCandidates = acs
    .filter((a) => a.shed && a.managed && !a.on)
    .sort((a, b) => b.rankNeedDelta - a.rankNeedDelta || acs.indexOf(a) - acs.indexOf(b));

  /**
   * Rooms parked BELOW an active comfort floor while they still want cooling.
   * A comfort floor means "under this level this room does not cool in this
   * weather", so such a room is out of service in all but name (invariant 36) —
   * it just has no shed record, no restore queue and no push to say so.
   *
   * The restore phase treats them as what they are: peers, ranked by need.
   * Live 2026-08-03 11:25–11:45, Abdullah sat at L1 under an active L2 floor
   * with his room 8°C above setpoint while Najat — shed in the same batch,
   * 1.4°C less needy — took the 2.3A that appeared three minutes later, and the
   * envelope then refused his floor by 0.1A for the next seventeen minutes.
   * Restoring a room that is off ahead of a room that is off in all but name is
   * only right when it is the needier of the two.
   */
  const strandedBelowFloor = onManaged
    .filter((a) => a.currentLevel >= 1 && isNonCooling(a, a.currentLevel))
    .sort((a, b) => b.rankNeedDelta - a.rankNeedDelta);

  /**
   * Yield only to a floor recovery that is PHYSICALLY affordable — the same
   * envelope and meter tests the raise phase applies. Without that the yield
   * is a livelock: a room whose floor nobody can afford would park every
   * restore behind it forever.
   *
   * Deliberately NOT the raise phase's time-gates (victim cooldown, calm,
   * pacing): when the floor step is affordable but merely time-gated, the
   * yield still stands the restore down, because restoring the shed room now
   * would spend the very amps the hotter room is waiting out its cooldown to
   * take — the yield IS the reservation. Those gates all expire (≤120 s), the
   * user ranked the non-cooling room "the higher priority", and both rooms'
   * needs keep rising while they wait, so the ordering self-corrects.
   */
  const floorRecoveryFits = (ac: AcView): boolean => {
    const target = Math.min(ac.currentLevel + 1, floorOf(ac));
    if (envelopeGuard && raiseEnvelope({ [ac.deviceId]: target }) > envelopeCeiling) return false;
    const step = raiseJumpAmps(book, config, ac.deviceId, source, ac.currentLevel, target, ac.maxLevel, now);
    return step.amps <= input.headroomAmps - input.rampDebitAmps;
  };

  const swapInFlight = input.swapInFlight ?? null;
  for (const [candidateIndex, candidate] of shedCandidates.entries()) {
    // Candidates are most-needy-first, so a stranded room that outranks this
    // one outranks every candidate behind it: stand the whole phase down (no
    // reservation) and let the raise phase buy the floor back.
    const needier = strandedBelowFloor.find((a) => a.rankNeedDelta > candidate.rankNeedDelta && floorRecoveryFits(a));
    if (needier != null) {
      decisions.push({
        at: now,
        deviceId: candidate.deviceId,
        action: "restore",
        blockedBy: "floor recovery",
        // Both figures, because the ranking input is the thing to audit (R13):
        // these rooms are ordered on REAL temperature, not on each room's own
        // comfort metric — one of which is feels-like.
        detail:
          `${needier.name} is below its comfort floor and needier ` +
          `(${needier.rankNeedDelta.toFixed(1)}°C vs ${candidate.rankNeedDelta.toFixed(1)}°C real` +
          `${needier.roomTempC != null ? `, room ${needier.roomTempC.toFixed(1)}°C` : ""})`,
      });
      break;
    }
    // A room that funded a peer may not take the donation straight back —
    // invariant 30's rule, reaching the restore queue. Without it the donor is
    // the cheapest thing on the board and simply undoes the trade before the
    // receiver's compressor has even started.
    //
    // ⚠ Two tiers, and the split is the point (review, 2026-08-06). RESERVING
    // amps is a claim that these specific amps are spoken for, and only the
    // live trade can make it: `fundingCooldown` is ALSO stamped by an ordinary
    // level-funding demote (invariant 30 proper), so keying the reservation on
    // it alone let a room that gave up one LEVEL and was then shed for an
    // unrelated overload park the raise phase AND the fan restore house-wide
    // for two minutes. The BAR is right for both; the RESERVATION is right only
    // for the swap donor, whose amps a named receiver is waiting on.
    if (input.fundingCooldown?.(candidate.deviceId) === true) {
      const isSwapDonor = swapInFlight != null && swapInFlight.donorId === candidate.deviceId;
      const donated = restoreCostAmps(
        book,
        config,
        candidate.deviceId,
        source,
        floorOf(candidate),
        candidate.maxLevel,
        now,
        { gentle: false },
      );
      if (isSwapDonor) reservedAmps = Math.max(reservedAmps, donated.amps);
      decisions.push({
        at: now,
        deviceId: candidate.deviceId,
        action: "restore",
        blockedBy: "donation cooldown",
        detail: isSwapDonor
          ? `it was switched off to fund ${swapInFlight?.receiverId} — reserved ${donated.amps.toFixed(1)}A ` +
            `until that room is back`
          : `it just funded a peer's raise — barred for the funding cooldown, but its ` +
            `${donated.amps.toFixed(1)}A are not reserved (no trade is waiting on them)`,
      });
      continue;
    }
    const floor = floorOf(candidate);
    // What THIS room's return is judged against: the committed meter, never
    // below the bar its own shed left (R9). Everything downstream — the fit
    // tests, the probe re-arm anchor, and the anchor stamped on the attempt —
    // reads this figure, so a trough the room dug itself cannot readmit it from
    // any direction.
    const candidateCommitted = Math.max(committedAmps, barFor(candidate.deviceId));
    // On gen every restore ships GENTLE (fan pinned to 1), but gentleness is
    // NOT a discount: 2026-07-27 proved the pin doesn't shrink the compressor
    // draw — three fan-pinned restores of Najat admitted at her steady 2.3A
    // each ramped the meter +3.5–3.8A and bounced back to shed within ~3 min.
    // Admission prices at the PLAIN learned cost; the steady price survives
    // only as a bounded PROBE below, for stale-HIGH learned costs (2026-07-24:
    // a phantom 3.7A stranded a room that really fit). `restoreCostAmps` is
    // shared with the controller's freshly-on projection so admission and
    // re-pricing can never disagree (the 2026-07-25 storm) — probeRestoreIds
    // tells the caller which price this restore carried.
    const gentleRestore = source === "gen";
    const plainCost: CostEstimate = restoreCostAmps(
      book,
      config,
      candidate.deviceId,
      source,
      floor,
      candidate.maxLevel,
      now,
      { gentle: false },
    );
    const probeCost: CostEstimate = restoreCostAmps(
      book,
      config,
      candidate.deviceId,
      source,
      floor,
      candidate.maxLevel,
      now,
      { gentle: true },
    );
    const candidateEntry = { deviceId: candidate.deviceId, level: floor, maxLevel: candidate.maxLevel };

    /**
     * The gated proactive shed (invariant 57) is deliberately flicker-free END
     * TO END, and both halves of that are load-bearing:
     *
     *  - a trade may not be ARMED by a flicker refusal. The swap's whole cost is
     *    a cool room's compressor; spending it to buy a restore the bare ceiling
     *    would have admitted anyway turns this margin into a room-off machine.
     *  - and once armed it may not be REFUSED by one. The amps a live trade is
     *    waiting on are not ambient headroom — they are a named room's whole
     *    draw, already switched off for this receiver and RESERVED across ticks.
     *    Charging the wobble there strands the trade instead: the ±0.5A-noise
     *    acceptance replay (whose alternating readings the estimator reads as a
     *    full amp of flicker) switched Najat off, refused Abdu for the whole
     *    reservation, and brought NAJAT back — a room cycled for nothing, the
     *    one outcome `swapDonorFor`'s own contract rules out.
     *
     * `REBALANCE_FUND_MARGIN_AMPS` is the margin that answers for this path, and
     * it was sized against exactly this noise band.
     */
    const isSwapReceiver = swapInFlight != null && swapInFlight.receiverId === candidate.deviceId;
    const ceilingFor = isSwapReceiver ? restoreCeiling : chargedRestoreCeiling;

    // Both feasibilities up front, BEFORE any gate — the reservation decision
    // needs to know whether this room could return at all (plain, or by pulling
    // every raised peer down to its floor in the same batch).
    const envelopePlainOk = !envelopeGuard || envelopeWith({}, candidateEntry) <= envelopeCeiling;
    // What pulling every raised peer down to its floor would free — priced at
    // the level the METER IS BEING CHARGED FOR, not the confirmed shadow.
    //
    // The two sides of this comparison have to describe the same house.
    // `committedAmps` includes `rampDebitAmps`, which charges a raise's
    // committed-but-unmetered jump the instant it is sent (invariant 12); this
    // sum read `currentLevel`, which does not move until the firmware confirms
    // — anywhere from seconds to fifteen minutes later (invariant 7). For that
    // whole window a peer's raise counted AGAINST the shed room's return while
    // the level it could hand back counted for nothing, so a room that fitted
    // at floors was refused for amps that were recoverable by definition.
    //
    // Live 2026-08-03 17:13:36 / 17:19:03 / 17:25:31 — the same shape three
    // times inside twelve minutes: Abdu shed, his restore refused at "floors
    // 16.5A vs 14.9A" with `savingsAtFloors` reading ZERO, and in the very same
    // batch Najat raised L1→L2. A minute later the funding swap pulled that
    // level straight back for Abdullah, the meter went over, and Abdu stayed
    // off. `envelopeLevel` is the worst case the firmware might be at — the
    // same figure the physics envelope already prices peers at — so the credit
    // and the charge now move together.
    const savingsAtFloors = onManaged.reduce((sum, a) => {
      const f = floorOf(a);
      const charged = chargedLevelOf(a);
      return charged > f
        ? sum + levelCutSavings(book, config, a.deviceId, source, charged, f, a.maxLevel, now)
        : sum;
    }, 0);
    const floorOverrides = Object.fromEntries(onManaged.map((a) => [a.deviceId, floorOf(a)]));
    const envelopeFloorsOk = !envelopeGuard || envelopeWith(floorOverrides, candidateEntry) <= envelopeCeiling;
    const fitsUnder = (amps: number, ceiling: number): { plain: boolean; atFloors: boolean } => ({
      plain: envelopePlainOk && candidateCommitted + amps <= ceiling,
      atFloors: envelopeFloorsOk && candidateCommitted - savingsAtFloors + amps <= ceiling,
    });
    // PROBE eligibility: the learned price blocks, but it may be stale-high —
    // while there is ZERO bounce evidence this source-session, try once at the
    // steady floor price. A bounce feeds the pacing ladder (failures > 0
    // disables further probes) and re-learns the on-cost from the shed's
    // off-drop; a probe that sticks re-grades the learned cost cheap. Both wrong
    // beliefs self-correct from the meter instead of stranding or storming.
    //
    // EVIDENCE RE-ARM (2026-08-02): a bounce is evidence about the house the
    // probe bounced IN, not the house forever. Najat's probe failed at a
    // committed 11.9A; the meter then sat at 10.8–11.2A for 17 minutes — room
    // for her real ~3.5A cost — while the once-per-session rule left the
    // learned 4.1A price to refuse every restore until the user acted by hand.
    // A committed meter ≥ PROBE_REARM_DROP_AMPS below the failed attempt's own
    // committed amps re-arms one probe (see probeRearmed — re-anchoring keeps
    // retries bounded).
    const probeEligible =
      gentleRestore &&
      plainCost.amps > probeCost.amps + 1e-9 &&
      (restoreFailures(pacing, candidate.deviceId) === 0 ||
        probeRearmed(pacing, candidate.deviceId, candidateCommitted));
    /**
     * The whole admission — price AND fit — resolved against ONE ceiling.
     * Ordinary admission passes `ceilingFor` (charged the live flicker); the
     * classification below re-runs it bare, and a live trade's receiver is never
     * charged at all (see `ceilingFor`). The probe re-runs the same fit test, so
     * it inherits whichever ceiling applies for free — which is the point: a
     * stale-high learned cost is a reason to try a cheaper price, not a reason
     * to spend the supply's own wobble.
     */
    const resolveAt = (
      ceiling: number,
    ): { cost: CostEstimate; probe: boolean; fits: { plain: boolean; atFloors: boolean } } => {
      const plainFits = fitsUnder(plainCost.amps, ceiling);
      if (plainFits.plain || plainFits.atFloors || !probeEligible) {
        return { cost: plainCost, probe: false, fits: plainFits };
      }
      const probeFits = fitsUnder(probeCost.amps, ceiling);
      return probeFits.plain || probeFits.atFloors
        ? { cost: probeCost, probe: true, fits: probeFits }
        : { cost: plainCost, probe: false, fits: plainFits };
    };
    const chargedAdmission = resolveAt(ceilingFor);
    /**
     * The SAME question with the charge taken off (review, 2026-08-06): the
     * flicker may only ever turn an ADMISSION into a skip, never change WHICH
     * refusal a room gets. Every branch below that spends something — the bar's
     * reservation, and the trade that costs a cool room its whole compressor —
     * is classified on this, so a wobbly line reaches exactly the branch a quiet
     * one would.
     *
     * Both halves were live bugs the moment the charge shipped, and both ran the
     * wrong way — the charge made the controller MORE aggressive in the corner
     * it exists to make more conservative:
     *
     *  - a room blocked by its own shed bar has `fitsIgnoringBar` judged at the
     *    HOUSE figure while the fit tests use the bar-inflated one. Charge the
     *    house figure and the bar stops looking like the blocker: the R9
     *    reservation is silently dropped AND the room falls through to the
     *    trade, which switches a clearly-cooler running room off to fund a
     *    restore the bare ceiling had already admitted. A quiet line just waits
     *    the bar out (≤ one blame window) and restores for free.
     *  - and a room whose PROBE fits the bare ceiling is a room a quiet line
     *    RESTORES. Refusing it for the wobble and then buying it a donor spends
     *    a room's comfort on a margin.
     */
    const bare = flickerCharge > 0 && !isSwapReceiver ? resolveAt(restoreCeiling) : chargedAdmission;
    /**
     * FLICKER PATIENCE (invariant 58 follow-up, 2026-08-08). A refusal that fails
     * ONLY on the flicker charge — the charged ceiling refuses it, the bare one
     * would admit it — is not a strand: the room fits the line, it is waiting for
     * the wobble to settle. It is reserved while it waits (below) and, once it has
     * been refused this way for FLICKER_PATIENCE_MS unbroken, admitted at the bare
     * ceiling. Swap receivers never qualify (they are already judged at the bare
     * ceiling — see `ceilingFor`).
     */
    const flickerOnlyRefusal =
      flickerCharge > 0 &&
      !isSwapReceiver &&
      !chargedAdmission.fits.plain &&
      !chargedAdmission.fits.atFloors &&
      (bare.fits.plain || bare.fits.atFloors) &&
      // A restore we already SENT is awaiting its confirm, not flicker-refused —
      // let the confirm gate below own it, or a patience admission would keep
      // re-refusing (and re-anchoring) its own in-flight restore while the shadow
      // lags. The shed clears on confirm and this candidate leaves the queue.
      !attemptedWithin(pacing, candidate.deviceId, "restore", RESTORE_CONFIRM_WAIT_MS, now);
    const flickerAnchorAt = flickerOnlyRefusal ? input.flickerRefusedSince?.(candidate.deviceId) : undefined;
    const flickerPatienceExpired = flickerAnchorAt != null && now - flickerAnchorAt >= FLICKER_PATIENCE_MS;
    // Patience is up → `bare` IS the admission this candidate flows through: same
    // cost/fits/probe, same emission path, with a note appended below so the
    // journal says the wobble was waited out rather than admitted into.
    const admitted = flickerPatienceExpired ? bare : chargedAdmission;
    const cost = admitted.cost;
    const probe = admitted.probe;
    const fits = admitted.fits;
    const fitsPlain = fits.plain;
    const fitsAtFloors = fits.atFloors;
    const bar = barFor(candidate.deviceId);
    /**
     * Would it fit if we judged it on the trough its own shed dug? The BARE
     * ceiling on both sides of the comparison, per `bare` above: the bar
     * reserves because it is a claim about the HOUSE (if the shed room cannot be
     * afforded at that figure, nobody can), and that claim is about load, not
     * about how steady the supply is. A room the flicker alone refuses still
     * reserves nothing — it fits bare, so `bare.fits` is true and this branch is
     * never reached; parking the whole raise phase on a supply wobble remains a
     * different bug.
     */
    const fitsIgnoringBar =
      (envelopePlainOk && committedAmps + bare.cost.amps <= restoreCeiling) ||
      (envelopeFloorsOk && committedAmps - savingsAtFloors + bare.cost.amps <= restoreCeiling);
    const barIsTheBlocker =
      !bare.fits.plain && !bare.fits.atFloors && bar > committedAmps && fitsIgnoringBar;

    // Blocked ONLY by its own shed bar (R9): the room fits the meter in front of
    // us and does not fit the meter this house really has. RESERVE, don't skip.
    //
    // The skip below exists for rooms physics cannot carry — parking raises on
    // those would strand a running room forever. This case is the opposite: the
    // bar is a claim about the HOUSE, so if the shed room cannot be afforded at
    // that figure then nobody can, and letting a raise take the amps would be
    // spending the very trough the bar exists to disbelieve. Bounded by the bar
    // itself (a blame window from the shed, or the compounded backoff while it
    // bounces), and a bar can only be renewed by another shed — which is itself
    // a bounce that grows the backoff.
    if (barIsTheBlocker) {
      // `bare.cost`, with the bare ceiling in the note: this branch is the
      // flicker-free classification, so the amps it reserves and the arithmetic
      // it prints are the ones a quiet line would have used.
      reservedAmps = Math.max(reservedAmps, bare.cost.amps);
      // LOUD when this is a bounce cycle (2026-08-07): the bar outlives its clock
      // and the room stays reserved for the compounded wait — say so, or the next
      // forensic reader sees only a bar that "should have" expired.
      const bounces = restoreBounces(pacing, candidate.deviceId);
      const waitS = (bounceBackoffMs(bounces) / 1000).toFixed(0);
      decisions.push({
        at: now,
        deviceId: candidate.deviceId,
        action: "restore",
        blockedBy: "own shed trough",
        detail:
          bounces >= 1
            ? `bounce backoff (${ordinalBounce(bounces)} bounce — ${waitS}s wait, ` +
              `needs ${bare.cost.amps.toFixed(1)}A settled vs ${restoreCeiling.toFixed(1)}A; ` +
              `meter ${committedAmps.toFixed(1)}A is this room's own shed trough, judged at ${bar.toFixed(1)}A)`
            : `meter ${committedAmps.toFixed(1)}A is the hole this room's own shed dug — ` +
              `judged at ${bar.toFixed(1)}A, needs ${bare.cost.amps.toFixed(1)}A vs ` +
              `${restoreCeiling.toFixed(1)}A`,
      });
      continue;
    }

    // ---- GATED PROACTIVE SHED (the swap), 2026-08-06 ----
    // The room does not fit plain and does not fit at floors. Before writing it
    // off for another tick, ask the question this morning's journal asked for:
    // is there a room RUNNING that is clearly cooler, whose off would buy this
    // one back? (User: "after Najat on and be stable, there was enough budget to
    // turn off Najat and bring Abdu back on.")
    //
    // ONE BATCH (user, 2026-08-08: "switching acs ... make that instantly, no
    // need to wait — the AC won't run full at the first moment"). The donor's
    // off-cliff reaches the meter in ~10–40 s while the receiver's compressor
    // engages minutes later (TCL restart protection + soft-start ramp), so the
    // two never actually overlap on the line — and the committed-meter machinery
    // already prices exactly that gap: the off is credited via `commandedCutAmps`
    // (so its cliff cannot latch a phantom collapse — invariants 11/31), the on
    // arms `pendingOn` + a ramp debit, and the receiver's `candidateCommitted`
    // already reflects the saving (invariant 41's bar arithmetic). So the donor's
    // `power_off` and the receiver's restore ship TOGETHER, sparing the receiver
    // the 36 s-plus wait it used to sit out for a LATER tick's committed meter.
    //
    // The `swapInFlight` branch below is now the failed-send/re-try path only: a
    // trade armed by a previous tick whose receiver never confirmed ON.
    if (!fitsPlain && !fitsAtFloors && swapInFlight != null && swapInFlight.receiverId === candidate.deviceId) {
      // Our own trade is still landing. These amps are SPOKEN FOR — reserve
      // them (which parks the raise phase and the fan restore) so the swap
      // cannot be robbed by a peer's cheaper step between the donor's off and
      // this restore. This is the reservation surviving across ticks.
      reservedAmps = Math.max(reservedAmps, plainCost.amps);
      decisions.push({
        at: now,
        deviceId: candidate.deviceId,
        action: "restore",
        blockedBy: "swap landing",
        detail:
          `${swapInFlight.donorId} was switched off for this room — ` +
          `reserved ${plainCost.amps.toFixed(1)}A until the saving reaches the meter ` +
          `(committed ${candidateCommitted.toFixed(1)}A of ${restoreCeiling.toFixed(1)}A)`,
      });
      continue;
    }
    /**
     * Infeasible on the BARE ceiling — the only refusal a trade may answer.
     * A room refused only by the flicker charge is waiting for a steadier line,
     * not for someone else's compressor, and buying it a room would spend a
     * cool room's whole comfort on a margin (see `ceilingFor`).
     *
     * The whole `bare` resolution, price included: a room whose PROBE fits the
     * bare ceiling is a room a quiet line RESTORES, so refusing it for the
     * wobble may not then buy it a donor (review, 2026-08-06 — testing only the
     * plain price here armed exactly that trade). The bar's own case never
     * reaches this line: `barIsTheBlocker` is classified on the same `bare` and
     * has already reserved and continued.
     */
    if (
      !bare.fits.plain &&
      !bare.fits.atFloors &&
      !fitsPlain &&
      !fitsAtFloors &&
      input.swapAllowed === true &&
      swapInFlight == null &&
      // Only the HOTTEST shed room may be bought back this way. A cooler
      // candidate reaching for a donor would be trading rooms sideways, and the
      // gap that makes the trade honest is measured from the top of the queue.
      candidateIndex === 0 &&
      // Same calm the restore it funds must clear. A swap is a comfort
      // optimisation; it waits for a quiet line like every other spend.
      restoreCalmOk &&
      canAttempt(pacing, candidate.deviceId, "restore", now) &&
      !attemptedWithin(pacing, candidate.deviceId, "restore", RESTORE_CONFIRM_WAIT_MS, now)
    ) {
      const picked = swapDonorFor({
        receiver: candidate,
        running: onManaged,
        // PLAIN price only (invariant 3) — the probe discount may not arm a
        // trade that costs another room its compressor.
        receiverCostAmps: plainCost.amps,
        committedAmps: candidateCommitted,
        // The BARE ceiling, and the receiver's own admission uses the same one
        // while the trade is live (`ceilingFor`) — a prediction and the
        // admission it predicts must ask the same question, or the trade arms on
        // a fit the receiver is then refused and the donor loses its compressor
        // for nothing (invariant 3's principle, one rung out). Charging BOTH
        // would be the other consistent answer and is the wrong one: it stands
        // the trade down on any wobbly line, which on a generator is most of
        // them, leaving the hotter room shed — the failure this feature exists
        // to fix. `REBALANCE_FUND_MARGIN_AMPS` is this path's margin.
        ceilingAmps: restoreCeiling,
        // `currentLevel`, deliberately — the SAME level `commandedCutAmpsOf`
        // will price this `power_off` at when it credits the collapse detector.
        // The worst-case `chargedLevelOf` would credit admission MORE than the
        // batch is credited, i.e. admit a trade on a saving nothing else in the
        // system believes in (and it is the permissive direction, which is the
        // one that trips breakers).
        donorSavingsAmps: (donor) =>
          modelCutAmps(config, donor.deviceId, source, donor.currentLevel, null, donor.maxLevel),
        envelopeAfter: envelopeGuard
          ? (donor) => envelopeWith({}, candidateEntry, donor.deviceId)
          : null,
        blocked: (deviceId) =>
          input.fundingCooldown?.(deviceId) === true || input.victimCooldown?.(deviceId) === true,
      });
      if (picked != null) {
        const { donor, freedAmps } = picked;
        commands.push({ deviceId: donor.deviceId, kind: "power_off", reason: "shed" });
        cutAmps += freedAmps;
        // The donor funded a peer with its whole room — invariant 30's cooldown
        // applies to it exactly as it does to a level donor, which is what the
        // "donation cooldown" branch above spends.
        fundingDonors.push(donor.deviceId);
        // …and the receiver ships in the SAME batch (see the header). Ordinary
        // gentle-restore shape (`restoreCmd()` is declared later in this loop —
        // TDZ — so it is constructed identically here). PLAIN price throughout:
        // the swap admits at the learned price (invariant 3/57), never the
        // probe, so the receiver is NOT in `probeRestoreIds` and its recorded fan
        // hold stays gentle=false.
        const receiverCmd: Command = gentleRestore
          ? { deviceId: candidate.deviceId, kind: "power_on", level: floor, reason: "restore", fan: 1 }
          : { deviceId: candidate.deviceId, kind: "power_on", level: floor, reason: "restore" };
        commands.push(receiverCmd);
        // Pacing must see this as a restore attempt exactly like an ordinary one;
        // its probe re-arm anchor (invariant 22) is the committed meter the trade
        // was ADMITTED at — the committed figure less the donor's freed draw.
        const admittedAt = candidateCommitted - freedAmps;
        attempts.push({ deviceId: candidate.deviceId, kind: "restore", meterAmps: admittedAt });
        // Belt: keep the receiver's cost reserved while the send is in flight
        // (harmless — nothing else spends this tick, we return below), and keep
        // returning `swap` so the shell arms `controller.swap`. Its release on the
        // receiver's confirmed ON / SWAP_RESERVATION_MS / source change is
        // unchanged and still covers a failed receiver send.
        reservedAmps = Math.max(reservedAmps, plainCost.amps);
        // GRADING (accepted trade-off): this batch carries TWO meter commands, so
        // the grading shell (controller.ts, `meterCmds.length === 1`) journals but
        // never LEARNS it — the donor's off-drop evidence (invariant 55) and the
        // receiver's free on@L sample are deliberately forfeited for instant
        // sequencing (user, 2026-08-08). A window born beside another command
        // would be born contaminated anyway (invariant 23).
        decisions.push({
          at: now,
          deviceId: donor.deviceId,
          action: "proactive shed",
          detail:
            `${donor.name} → ${candidate.name}: switching ${donor.name} off ` +
            `(${donor.rankNeedDelta.toFixed(1)}°C real` +
            `${donor.roomTempC != null ? `, room ${donor.roomTempC.toFixed(1)}°C` : ""}) ` +
            `to bring ${candidate.name} back ` +
            `(${candidate.rankNeedDelta.toFixed(1)}°C real` +
            `${candidate.roomTempC != null ? `, room ${candidate.roomTempC.toFixed(1)}°C` : ""}) — ` +
            `frees ~${freedAmps.toFixed(1)}A, restore needs ${plainCost.amps.toFixed(1)}A ` +
            `at ${candidateCommitted.toFixed(1)}A committed vs ${restoreCeiling.toFixed(1)}A`,
        });
        decisions.push({
          at: now,
          deviceId: candidate.deviceId,
          action: `restore @L${floor}`,
          detail:
            `funded by ${donor.name} off — same batch: frees ~${freedAmps.toFixed(1)}A, ` +
            `needs ${plainCost.amps.toFixed(1)}A at ${admittedAt.toFixed(1)}A committed ` +
            `vs ${restoreCeiling.toFixed(1)}A`,
        });
        return {
          commands,
          decisions,
          attempts,
          // Ships a power_on now — the batch wants the turn-on grade window; the
          // pipeline still prints reason "proactive_shed" (it reads `swap`).
          isTurnOn: true,
          reservedAmps,
          probeRestoreIds: [],
          cutAmps,
          fundingDonors,
          swap: { donorId: donor.deviceId, receiverId: candidate.deviceId },
          flickerRefused,
        };
      }
    }

    // FLICKER-ONLY refusal (invariant 58 follow-up): it fits the bare ceiling
    // and fails only on the flicker charge. Patience has NOT run out yet (the
    // expired case has `admitted = bare` above, so it fell through as an
    // admission), so hold it: report it so the shell anchors it, and — once the
    // anchor stands — RESERVE the bare cost so a peer raise cannot spend the amps
    // this room is waiting to take (closes 58's open item). On the very first
    // refusal tick there is no anchor yet, so nothing is reserved; the shell
    // stamps `now`, and the next tick reserves.
    if (flickerOnlyRefusal && !flickerPatienceExpired) {
      flickerRefused.push(candidate.deviceId);
      const waitedS = ((flickerAnchorAt != null ? now - flickerAnchorAt : 0) / 1000).toFixed(0);
      const patienceS = (FLICKER_PATIENCE_MS / 1000).toFixed(0);
      if (flickerAnchorAt != null) reservedAmps = Math.max(reservedAmps, bare.cost.amps);
      decisions.push({
        at: now,
        deviceId: candidate.deviceId,
        action: "restore",
        blockedBy: "flicker margin",
        detail:
          `flicker-only — floors ${(candidateCommitted - savingsAtFloors + bare.cost.amps).toFixed(1)}A ` +
          `fits ${restoreCeiling.toFixed(1)}A bare, waiting ${waitedS}s of ${patienceS}s${flickerNote}${rampNote}`,
      });
      continue;
    }

    // Can't return this tick even with peer floor-downs → reserve NOTHING
    // (raises don't change floors math, so parking here would be a permanent
    // strand); the next-most-needy candidate may still fit.
    if (!fitsPlain && !fitsAtFloors) {
      decisions.push({
        at: now,
        deviceId: candidate.deviceId,
        action: "restore",
        // envelopeFloorsOk is the most permissive envelope case (everyone at
        // floors); if even that is over the breaker model, physics is the
        // blocker, not the meter — label it so the journal is diagnosable.
        blockedBy: !envelopeFloorsOk ? "physics envelope" : "no headroom",
        detail: `floors ${(candidateCommitted - savingsAtFloors + cost.amps).toFixed(1)}A vs ${ceilingFor.toFixed(1)}A${isSwapReceiver ? "" : flickerNote}${rampNote}`,
      });
      continue;
    }

    // Feasible but its restore backoff is cooling (a recent restore bounced):
    // reserve its amps AND park raises (below) so a running AC can't grab the
    // headroom the moment the backoff clears. Bounded by the backoff ladder
    // (≤15 min) or the compounded bounce wait (≤30 min) — never permanent. Keep
    // scanning: a less-needy room may ship.
    if (!canAttempt(pacing, candidate.deviceId, "restore", now)) {
      reservedAmps = Math.max(reservedAmps, cost.amps);
      // LOUD when a bounce stands: the ordinary ladder rung is cooling but the
      // room we TRIED and failed carries bounce evidence (2026-08-07). Same class
      // as the shed-trough refusal, told from the ladder side.
      const bounces = restoreBounces(pacing, candidate.deviceId);
      decisions.push({
        at: now,
        deviceId: candidate.deviceId,
        action: "restore",
        blockedBy: "backoff",
        detail:
          bounces >= 1
            ? `bounce backoff (${ordinalBounce(bounces)} bounce) — reserved ${cost.amps.toFixed(1)}A`
            : `reserved ${cost.amps.toFixed(1)}A`,
      });
      continue;
    }

    // A restore was SENT within the confirm window and the shadow still shows
    // OFF (shed clears only on confirmed ON since 2026-07-27): the turn-on is
    // in flight, its draw is neither metered nor ramp-debited yet. Reserve its
    // amps and STOP — nothing else may spend into a meter picture that is
    // about to change wholesale. Past the window the loop re-sends (Najat's
    // firmware drops commands; confirm-or-resend is the cure).
    if (attemptedWithin(pacing, candidate.deviceId, "restore", RESTORE_CONFIRM_WAIT_MS, now)) {
      reservedAmps = Math.max(reservedAmps, cost.amps);
      decisions.push({
        at: now,
        deviceId: candidate.deviceId,
        action: "restore",
        blockedBy: "awaiting confirm",
        detail: `reserved ${cost.amps.toFixed(1)}A`,
      });
      break;
    }

    // Feasible but waiting out its calm gate: reserve its amps and STOP — no
    // queue-jumping past a needier room that is merely time-gated.
    if (!restoreCalmOk) {
      reservedAmps = Math.max(reservedAmps, cost.amps);
      decisions.push({
        at: now,
        deviceId: candidate.deviceId,
        action: "restore",
        blockedBy: "calm",
        detail: `reserved ${cost.amps.toFixed(1)}A`,
      });
      break;
    }

    // Calm-clear and feasible → ship it now. Plain if it fits alone; otherwise
    // pull every raised peer down to its floor in the same batch. On gen the
    // room comes back GENTLE — fan pinned to 1 — so the range automation's
    // hot-room fan-slam (3–7, un-modeled) can't re-push the meter over; grid is
    // roomy enough to restore plain. Over-estimating a restore errs trip-safe,
    // and graded restores drift the on-cost EWMA down over time.
    const restoreCmd = (): Command =>
      gentleRestore
        ? { deviceId: candidate.deviceId, kind: "power_on", level: floor, reason: "restore", fan: 1 }
        : { deviceId: candidate.deviceId, kind: "power_on", level: floor, reason: "restore" };
    const probeIds = probe ? [candidate.deviceId] : [];
    const probeDetail = probe
      ? `probe at ${cost.amps.toFixed(1)}A (learned ${plainCost.amps.toFixed(1)}A unproven)`
      : undefined;
    // A flicker-only refusal whose patience ran out is admitted at the bare
    // ceiling (invariant 58 follow-up) — mark it so the journal is not read as an
    // ordinary admission into the flicker band.
    const patienceDetail = flickerPatienceExpired
      ? `flicker patience: admitted at bare ceiling after ${((now - (flickerAnchorAt ?? now)) / 1000).toFixed(0)}s`
      : undefined;
    const admitDetail = [probeDetail, patienceDetail].filter(Boolean).join(" · ") || undefined;
    if (fitsPlain) {
      commands.push(restoreCmd());
      attempts.push({ deviceId: candidate.deviceId, kind: "restore", meterAmps: candidateCommitted });
      decisions.push({ at: now, deviceId: candidate.deviceId, action: `restore @L${floor}`, detail: admitDetail });
      return { commands, decisions, attempts, isTurnOn: true, reservedAmps, probeRestoreIds: probeIds, cutAmps, fundingDonors, swap: null, flickerRefused };
    }
    for (const a of onManaged) {
      const f = floorOf(a);
      const charged = chargedLevelOf(a);
      if (charged > f) {
        // `charged`, not `currentLevel`: a room whose L2 is still in flight is
        // brought down by SENDING L1, which cancels that raise. Send-dedupe
        // compares against the last level SENT (the L2), so this is a genuine
        // correction and ships.
        commands.push({ deviceId: a.deviceId, kind: "set_level", level: f });
        cutAmps += modelCutAmps(config, a.deviceId, source, charged, f, a.maxLevel);
        // These peers are funding a restore, which is the slowest-landing
        // receiver there is: it waits out a calm window AND a whole compressor
        // start. Without the cooldown they take their levels straight back on
        // the next tick — the 2026-08-02 donor↔receiver cycle, with a shed room
        // stranded off instead of a peer stuck a level low.
        fundingDonors.push(a.deviceId);
      }
    }
    commands.push(restoreCmd());
    attempts.push({ deviceId: candidate.deviceId, kind: "restore", meterAmps: candidateCommitted });
    decisions.push({
      at: now,
      deviceId: candidate.deviceId,
      action: `restore @L${floor} with peer floor-downs`,
      detail: admitDetail,
    });
    return { commands, decisions, attempts, isTurnOn: true, reservedAmps, probeRestoreIds: probeIds, cutAmps, fundingDonors, swap: null, flickerRefused };
  }

  // A feasible restore is reserved but gated (backoff/calm) — park the ENTIRE
  // raise phase, warm raises included. Per-amp reservation alone can't stop a
  // warm raise (it's calm-exempt) from rewinding the shared calm clock the
  // pending restore depends on (the shell resetCalm()s after every non-fan
  // batch), so the whole phase stands down. Never a permanent strand: an
  // infeasible-at-floors candidate reserves nothing, and a reserved one is
  // bounded by restoreCalmSeconds (~15s) or one backoff rung.
  if (reservedAmps > 0) {
    decisions.push({
      at: now,
      action: "raises",
      blockedBy: "restore reservation",
      detail: `${reservedAmps.toFixed(1)}A reserved`,
    });
    return { commands, decisions, attempts, isTurnOn: false, reservedAmps, probeRestoreIds: [], cutAmps, fundingDonors, swap: null, flickerRefused };
  }

  // ---- Raise phase: one-step, meter-anchored, most-needy first ----
  // `available` is the meter-anchored budget; every command debits what the
  // meter has NOT yet seen — a level raise its delta, a grid start the whole
  // steady draw of the AC that just came on (see gridStartLevel).
  // …minus what ramping compressors have committed but not yet spent on the
  // meter, or a peer raise buys amps a neighbour is already on its way to using.
  let available = input.headroomAmps - input.rampDebitAmps;
  const raiseCalmOk = input.calmMs >= config.raiseCalmSeconds * 1000;
  const restingCeiling = input.limitAmps - config.marginAmps - config.restingBufferAmps;

  const candidates = onManaged
    .filter((a) => a.currentLevel >= 1)
    .map((a) => ({ ac: a, ceil: ceilOf(a, config.nearTargetBandC) }))
    .filter(({ ac, ceil }) => ac.currentLevel < ceil)
    .sort((x, y) => y.ac.rankNeedDelta - x.ac.rankNeedDelta || acs.indexOf(x.ac) - acs.indexOf(y.ac));

  /**
   * Rooms parked above the level their own need justifies — dormant capacity a
   * hot peer may reclaim. No dwell requirement here (unlike the idle demote): a
   * room that is actually waiting on these amps is evidence enough. `ceilOf`
   * honours manualTarget, so a user-pinned room is never harvested.
   */
  const harvestableFor = (raiser: AcView): Array<{ ac: AcView; target: number }> =>
    onManaged
      .filter((a) => a.deviceId !== raiser.deviceId && !a.ramping && a.currentLevel >= 1)
      .map((a) => ({ ac: a, target: ceilOf(a, config.nearTargetBandC) }))
      .filter(({ ac: peer, target }) => peer.currentLevel > target);

  /**
   * Comparative-need donors (user, 2026-08-01): peers holding a level above
   * their FLOOR whose room is at least `REBALANCE_NEED_GAP_C` cooler than the
   * blocked raiser — ONE step each, coolest room first. Unlike the satisfied
   * harvest, a donor is still paying for cooling it wants, so the gap is the
   * whole justification: the hotter room's need outranks it. The gap doubles
   * as the anti-bounce hysteresis — after the trade the receiver runs at least
   * gap-hotter than the donor, so the reverse trade cannot arm until the rooms
   * genuinely cross by the same margin. Never past the floor, never a manual
   * pin (a pinned level is user intent, not spare capacity), never a ramping
   * compressor. An unconfirmed donor demote does not ratchet: `currentLevel`
   * moves only on confirm, so a re-plan re-emits the SAME target (a resend).
   *
   * Only a receiver sitting AT ITS FLOOR may take a trade — that is the user's
   * literal ask ("the other on the base level"), and it is load-bearing: a
   * receiver already holding an extra level competes through the ordinary
   * budget, and letting it trade re-broke the resting-point quiet acceptance
   * (a warm L2 room endlessly milked a milder L2 peer for an L3 it could
   * never actually fund).
   */
  const rebalanceDonorsFor = (raiser: AcView): Array<{ ac: AcView; target: number }> => {
    if (raiser.currentLevel > floorOf(raiser)) return [];
    return onManaged
      .filter(
        (a) =>
          a.deviceId !== raiser.deviceId &&
          !a.ramping &&
          a.manualTarget == null &&
          a.currentLevel > floorOf(a) &&
          a.rankNeedDelta + REBALANCE_NEED_GAP_C <= raiser.rankNeedDelta,
      )
      .sort((x, y) => x.rankNeedDelta - y.rankNeedDelta)
      .map((a) => ({ ac: a, target: Math.max(floorOf(a), a.currentLevel - 1) }));
  };

  const cutOfFunding = (f: { ac: AcView; target: number }): number =>
    modelCutAmps(config, f.ac.deviceId, source, f.ac.currentLevel, f.target, f.ac.maxLevel);

  const emitDemotes = (peers: Array<{ ac: AcView; target: number }>): number => {
    let cut = 0;
    for (const { ac: peer, target } of peers) {
      commands.push({ deviceId: peer.deviceId, kind: "set_level", level: target });
      fundingDonors.push(peer.deviceId);
      cut += modelCutAmps(config, peer.deviceId, source, peer.currentLevel, target, peer.maxLevel);
    }
    return cut;
  };

  /**
   * R8b — raises admit in NEED order, and the order has to MEAN something
   * (orchestrator ruling, 2026-08-04, from the stage-2 reading of the 08-03
   * journal: at 17:13:36 the mildest room, need 1.9, took 2.0A while the
   * hottest, need 8.0, was refused its step by 0.2A — and the funding swap then
   * spent three commands undoing it).
   *
   * The list was already sorted hottest-first; what it lacked was any
   * consequence for a refusal. Once a room has been refused for AMPS, a milder
   * one may take those amps only if it is at least `SHED_NEED_GAP_C` milder —
   * the SAME constant and the same question the recovery admission asks in the
   * other direction ("once a room has been refused, may a cooler one take the
   * amps it could not use?"), and the user calibrated it this afternoon. One
   * gap rule everywhere, not a second constant.
   *
   * Inside the gap the milder room waits: near-equals resolve toward the hotter
   * room, and the amps stay free for it to fit as a derate recovers or a peer's
   * cut lands. Only AMPS refusals arm this — a room waiting out its own calm,
   * backoff, victim or funding cooldown is not competing for anything, and
   * those gates all expire on their own.
   */
  let refusedNeed: number | null = null;
  const refuseForAmps = (ac: AcView): void => {
    refusedNeed = Math.max(refusedNeed ?? ac.rankNeedDelta, ac.rankNeedDelta);
  };

  for (const { ac, ceil } of candidates) {
    if (refusedNeed != null && ac.rankNeedDelta + SHED_NEED_GAP_C > refusedNeed) {
      decisions.push({
        at: now,
        deviceId: ac.deviceId,
        action: "raise",
        blockedBy: "needier room waiting",
        detail:
          `${ac.rankNeedDelta.toFixed(1)}°C real vs ${(refusedNeed as number).toFixed(1)}°C refused — ` +
          `not ${SHED_NEED_GAP_C.toFixed(1)}°C milder, so the amps stay with the hotter room`,
      });
      continue;
    }
    // A gen start window is an ENTRY POLICY, and entry policy outranks the
    // raise phase for that device — the same rule FLOORS gets. Without this the
    // clamp and the raise phase fight inside one batch: `invariantCorrections`
    // emits L1, the raise emits L2/L3, and dedupe (last writer wins) hands the
    // room straight back to the level nobody admitted. A warm restore would win
    // it even mid-ramp, since `warmStartLevel` is exempt from the ramping gate.
    // The room climbs normally once the window closes and the meter agrees.
    if (source === "gen" && ac.startBaselineAmps != null) {
      decisions.push({ at: now, deviceId: ac.deviceId, action: "raise", blockedBy: "gen start floor" });
      continue;
    }
    // This room just gave a level to a hotter peer. Until that saving reaches
    // the meter the peer still cannot afford the raise it paid for — while this
    // room's own step, being the cheapest thing on the board and higher in
    // priority, would be admitted immediately. That is not a raise, it is the
    // donor taking its donation back, and it cycles: live 2026-08-02 Najat went
    // L1↔L2 every ~45s while Abdu, the room the demote was for, never climbed.
    if (input.fundingCooldown?.(ac.deviceId) === true) {
      decisions.push({ at: now, deviceId: ac.deviceId, action: "raise", blockedBy: "funding cooldown" });
      continue;
    }
    // …and the same for a level the reducer TOOK. Climbing back before the cut
    // has even reached the meter re-creates the overload that caused it, and
    // the pair repeats: cut, raise, cut. A shed room is deliberately exempt —
    // a restore is not a raise, and stranding a room off is the worse failure.
    if (input.victimCooldown?.(ac.deviceId) === true) {
      decisions.push({ at: now, deviceId: ac.deviceId, action: "raise", blockedBy: "victim cooldown" });
      continue;
    }
    // Grid turn-on full start (user directive "on grid start all to full"):
    // an AC that just came on restores its last gen level (usually L1 from the
    // previous gen episode) — lift it to the affordable ceiling in ONE command
    // instead of making it wait out the 4-min ramp gate and creep up a step at
    // a time. Priced against its pre-start baseline, minus whatever this batch
    // already committed, so two simultaneous starts can't spend the same amps.
    const startBaseline = source === "grid" ? ac.startBaselineAmps : null;
    const startTarget =
      startBaseline == null
        ? null
        : gridStartLevel(ac, ceil, config, restingCeiling - (input.headroomAmps - available));
    const warmTarget =
      ac.warmStartLevel != null && ac.warmStartLevel > ac.currentLevel
        ? Math.min(ac.warmStartLevel, ceil)
        : null;
    // A grid start and a warm restore are both exempt from the calm gate (one
    // is the entry policy, the other a recently-proven level) and from the ramp
    // gate; ordinary raises need sustained calm and a settled meter.
    if (startBaseline != null) {
      if (startTarget == null) {
        decisions.push({
          at: now,
          deviceId: ac.deviceId,
          action: `grid start L${ceil}`,
          blockedBy: "no headroom",
          detail: `${startBaseline.toFixed(1)}A before start + L${ac.currentLevel + 1} draw > ${restingCeiling.toFixed(1)}A`,
        });
        refuseForAmps(ac);
        continue;
      }
    } else if (warmTarget == null) {
      if (!raiseCalmOk) {
        decisions.push({ at: now, deviceId: ac.deviceId, action: "raise", blockedBy: "calm" });
        continue;
      }
      if (ac.ramping) {
        decisions.push({ at: now, deviceId: ac.deviceId, action: "raise", blockedBy: "ramping" });
        continue;
      }
    }
    if (!canAttempt(pacing, ac.deviceId, "raise", now)) {
      decisions.push({ at: now, deviceId: ac.deviceId, action: "raise", blockedBy: "backoff" });
      continue;
    }
    let target = startTarget ?? warmTarget ?? ac.currentLevel + 1;
    // Physics envelope BEFORE the meter gate: a frozen or ramp-lagging meter
    // can show room for an end-state the cap models know exceeds the breaker
    // (2026-07-23: two ACs at L3 on the 15A gen = 15.6A worst case → trip).
    // Envelope is monotonic in level, so a too-high warm target degrades to
    // the highest safe level instead of stranding the AC.
    if (envelopeGuard) {
      const desired = target;
      while (target > ac.currentLevel && raiseEnvelope({ [ac.deviceId]: target }) > envelopeCeiling) target--;
      if (target === ac.currentLevel) {
        // FUNDING SWAP, envelope-blocked case. The cap models object, but the
        // METER may already hold the amps — and the peers standing in the way
        // are satisfied, i.e. drawing well under the caps the envelope charges
        // them for. Pull them to their own ceilings in the SAME batch and
        // re-check the end-state. When the satisfied harvest alone cannot fix
        // the end-state, comparative-need donors join one at a time (coolest
        // room first) — never more comfort spent than the envelope needs.
        //
        // Same-batch is only sound here. When the meter itself is short (the
        // branch below) the raise would be riding savings that have not landed,
        // and a satisfied compressor can take minutes to throttle down — on a
        // breaker that tripped at 15.65A on 2026-07-26 that is a real breach,
        // not a modelling nicety.
        const funding = harvestableFor(ac);
        const satCount = funding.length;
        const donors = rebalanceDonorsFor(ac).filter(
          (d) => !funding.some((f) => f.ac.deviceId === d.ac.deviceId),
        );
        const overridesOf = (list: Array<{ ac: AcView; target: number }>): Record<string, number> => {
          const o: Record<string, number> = { [ac.deviceId]: desired };
          for (const f of list) o[f.ac.deviceId] = f.target;
          return o;
        };
        while (donors.length > 0 && raiseEnvelope(overridesOf(funding)) > envelopeCeiling) {
          funding.push(donors.shift()!);
        }
        const swapJump = raiseJumpAmps(book, config, ac.deviceId, source, ac.currentLevel, desired, ac.maxLevel, now);
        // A donor-funded await must also clear the conservative fund check —
        // a satisfied-only harvest is comfort-free and keeps its old
        // unconditional behavior.
        const freedByFunding = funding.reduce((sum, f) => sum + cutOfFunding(f), 0);
        const donorFundOk =
          funding.length === satCount ||
          swapJump.amps <= Math.max(0, available) + freedByFunding - REBALANCE_FUND_MARGIN_AMPS;
        if (funding.length > 0 && raiseEnvelope(overridesOf(funding)) <= envelopeCeiling && donorFundOk) {
          if (swapJump.amps <= available) {
            // The meter already holds the amps — only the cap models objected.
            // Ship it as one batch.
            cutAmps += emitDemotes(funding);
            commands.push({ deviceId: ac.deviceId, kind: "set_level", level: desired });
            attempts.push({ deviceId: ac.deviceId, kind: "raise" });
            decisions.push({
              at: now,
              deviceId: ac.deviceId,
              action: `raise L${ac.currentLevel}→L${desired} funded by peer demote`,
              detail: `${funding.map((f) => `${f.ac.deviceId}→L${f.target}`).join(", ")}; ${swapJump.amps.toFixed(1)}A ${swapJump.confidence}`,
            });
            available -= swapJump.amps;
            if (source === "gen") break;
            continue;
          }
          // The swap fixes the envelope but the METER is short. Free the amps —
          // and, since the user asked for instant sequencing (2026-08-08), ship
          // the raise in the SAME batch when the freed amps close the gap with
          // margin. The end-state envelope has already passed (the outer `if`),
          // and the demote's model-priced fall is credited via `commandedCutAmps`
          // so the meter cannot read it as a trip. A raise the demote does NOT
          // cover still ships the demote alone and follows in a later calm window
          // against a meter that has really fallen (the satisfied-only harvest,
          // whose `donorFundOk` is unconditional, is the case that reaches here).
          const freed = emitDemotes(funding);
          cutAmps += freed;
          if (swapJump.amps <= Math.max(0, available) + freed - REBALANCE_FUND_MARGIN_AMPS) {
            commands.push({ deviceId: ac.deviceId, kind: "set_level", level: desired });
            attempts.push({ deviceId: ac.deviceId, kind: "raise" });
            decisions.push({
              at: now,
              deviceId: ac.deviceId,
              action: `raise L${ac.currentLevel}→L${desired} funded by peer demote`,
              detail:
                `${funding.map((f) => `${f.ac.deviceId}→L${f.target}`).join(", ")}; ` +
                `${swapJump.amps.toFixed(1)}A ${swapJump.confidence} ≤ ${Math.max(0, available).toFixed(1)}A avail ` +
                `+ ${freed.toFixed(1)}A freed − ${REBALANCE_FUND_MARGIN_AMPS.toFixed(1)}A margin — same batch`,
            });
            available -= swapJump.amps;
            if (source === "gen") break;
            continue;
          }
          decisions.push({
            at: now,
            deviceId: ac.deviceId,
            action: `raise L${desired}`,
            blockedBy: "awaiting demote",
            detail: `freeing ~${freed.toFixed(1)}A from ${funding.map((f) => `${f.ac.deviceId}→L${f.target}`).join(", ")}`,
          });
          break;
        }
        decisions.push({
          at: now,
          deviceId: ac.deviceId,
          action: `raise L${desired}`,
          blockedBy: "physics envelope",
          detail:
            `worst case ${raiseEnvelope({ [ac.deviceId]: desired }).toFixed(1)}A ` +
            `(incl. ${input.nonAcAmps.toFixed(1)}A house) > ${envelopeCeiling.toFixed(1)}A on ${source}`,
        });
        refuseForAmps(ac);
        continue;
      }
    }
    const jump = raiseJumpAmps(book, config, ac.deviceId, source, ac.currentLevel, target, ac.maxLevel, now);
    // A grid start was already admitted against its pre-start baseline — the
    // meter cannot price it while the compressor is still ramping.
    if (startTarget == null && jump.amps > available) {
      // FUNDING SWAP, meter-blocked case: free the amps and — since the user
      // asked for instant sequencing (2026-08-08) — ship the raise in the SAME
      // batch when the freed amps close the gap with margin. The demote's
      // model-priced fall is credited via `commandedCutAmps` so the meter cannot
      // read it as a trip, and the receiver's compressor engages minutes after
      // the donor's throttle-down begins, so they do not actually overlap on the
      // line. A raise the demote does NOT cover still ships the demote alone and
      // follows in a later calm window against a meter that has really fallen.
      //
      // Satisfied rooms are demoted regardless of coverage (dormant levels are
      // not comfort); a comparative-need donor pays real comfort, so donors
      // join only while the deficit is still uncovered — and when even every
      // donor cannot cover it, none of them pay.
      const satisfied = harvestableFor(ac);
      const donors = rebalanceDonorsFor(ac).filter(
        (d) => !satisfied.some((f) => f.ac.deviceId === d.ac.deviceId),
      );
      // Conservative funding target: the raise must fit AFTER the cuts land
      // with REBALANCE_FUND_MARGIN_AMPS to spare — the deficit is read off a
      // noisy meter, and a trade armed on a noise dip is the donor↔receiver
      // limit cycle the acceptance suite caught.
      const needed = jump.amps - Math.max(0, available) + REBALANCE_FUND_MARGIN_AMPS;
      let covered = satisfied.reduce((sum, f) => sum + cutOfFunding(f), 0);
      const picked: Array<{ ac: AcView; target: number }> = [];
      for (const d of donors) {
        if (covered >= needed) break;
        picked.push(d);
        covered += cutOfFunding(d);
      }
      const funding = picked.length === 0 || covered >= needed ? [...satisfied, ...picked] : satisfied;
      if (funding.length > 0) {
        const freed = emitDemotes(funding);
        cutAmps += freed;
        // Same-batch when the freed amps close the gap with margin. The envelope
        // was never the blocker here — the raise already cleared it against peers
        // at their worst-case levels — but demoting those peers only LOWERS the
        // end-state, so re-assert it (belt) with the demote overrides.
        const closesGap = jump.amps <= Math.max(0, available) + freed - REBALANCE_FUND_MARGIN_AMPS;
        const endStateOverrides: Record<string, number> = { [ac.deviceId]: target };
        for (const f of funding) endStateOverrides[f.ac.deviceId] = f.target;
        const envelopeOk = !envelopeGuard || raiseEnvelope(endStateOverrides) <= envelopeCeiling;
        if (closesGap && envelopeOk) {
          commands.push({ deviceId: ac.deviceId, kind: "set_level", level: target });
          attempts.push({ deviceId: ac.deviceId, kind: "raise" });
          decisions.push({
            at: now,
            deviceId: ac.deviceId,
            action: `raise L${ac.currentLevel}→L${target} funded by peer demote`,
            detail:
              `${funding.map((f) => `${f.ac.deviceId}→L${f.target}`).join(", ")}; ` +
              `${jump.amps.toFixed(1)}A ${jump.confidence} ≤ ${Math.max(0, available).toFixed(1)}A avail ` +
              `+ ${freed.toFixed(1)}A freed − ${REBALANCE_FUND_MARGIN_AMPS.toFixed(1)}A margin — same batch`,
          });
          available -= jump.amps;
          if (source === "gen") break;
          continue;
        }
        decisions.push({
          at: now,
          deviceId: ac.deviceId,
          action: `raise L${target}`,
          blockedBy: "awaiting demote",
          detail: `freeing ~${freed.toFixed(1)}A from ${funding.map((f) => `${f.ac.deviceId}→L${f.target}`).join(", ")}`,
        });
        break;
      }
      decisions.push({
        at: now,
        deviceId: ac.deviceId,
        action: `raise L${target}`,
        blockedBy: "no headroom",
        detail: `needs ${jump.amps.toFixed(1)}A (${jump.confidence}), ${Math.max(0, available).toFixed(1)}A available${rampNote}`,
      });
      refuseForAmps(ac);
      continue;
    }
    commands.push({ deviceId: ac.deviceId, kind: "set_level", level: target });
    attempts.push({ deviceId: ac.deviceId, kind: "raise" });
    if (startTarget != null) {
      // The meter has seen ~none of this AC yet → debit its WHOLE steady draw.
      const wholeDraw = steadyDraw(target, ac.maxLevel, modelFor(config, ac.deviceId, source));
      decisions.push({
        at: now,
        deviceId: ac.deviceId,
        action: `grid start L${ac.currentLevel}→L${target}`,
        detail: `${(startBaseline ?? 0).toFixed(1)}A before start + ${wholeDraw.toFixed(1)}A modeled`,
      });
      available -= wholeDraw;
    } else {
      decisions.push({
        at: now,
        deviceId: ac.deviceId,
        action: `raise L${ac.currentLevel}→L${target}`,
        detail: `${jump.amps.toFixed(1)}A ${jump.confidence}`,
      });
      available -= jump.amps;
    }
    // Gen: ONE raise command per batch — confirm on the meter, then the next.
    if (source === "gen") break;
  }

  return { commands, decisions, attempts, isTurnOn: false, reservedAmps, probeRestoreIds: [], cutAmps, fundingDonors, swap: null, flickerRefused };
}
