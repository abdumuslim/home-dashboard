// The changeover dead window: the minutes after a power event when our ACs are
// ON, modeled at their full steady draw, and physically drawing nothing.
//
// 2026-08-04, 11:16:10 Baghdad. A grid→gen changeover power-cycled all three
// ACs, and TCL compressor restart protection then held every compressor off for
// roughly six minutes while the rooms drew about their fans. Two mechanisms
// failed inside those six minutes, and both are the same mistake — a TIMER
// standing in for physics:
//
//   * `rearmRamp` armed a 240 s window per AC and the windows EXPIRED ON THE
//     CLOCK at ~11:20:10 with no compressor yet running. FLOORS cleared four
//     seconds later (`clearFloorsIfDone` needs "nothing ramping"), and the raise
//     path opened onto a 6.1 A meter that was pure house load: Abdullah L2→L3
//     admitted at 11:20:14, Abdu L1→L2 at 11:20:49.
//   * the house sampler, freed by the same expiry, recorded
//     `max(0, 6.1 − 10.4) = 0` — fictitious ZERO-amp house samples tagged with
//     the current running set, which is what let the envelope admit those raises
//     "incl. 0.0A house" against a house that was really ~6 A.
//
// At 11:22:10–49 all three compressors engaged together: 6.4 → 15.7 → 16.6 A
// smoothed on a 15 A generator, two severe cuts, and the user switching a room
// off by hand to rescue the line. Generator brownouts followed for fifteen
// minutes while the controller rode 14.3–14.8 A calling itself healthy.
//
// Class: invariants 5b and 5c again — a guard sized against only half of what it
// guards. `max(0, …)` assumed the residual could only be wrong-HIGH (a dying
// compressor booked as house, invariant 20). With the compressors dead it is
// wrong-LOW, and wrong-low is the permissive direction.
//
// So the dead window is now DETECTED, from two independent pieces of evidence
// that must both agree:
//
//   (a) per AC — its ramp has absorbed almost nothing (`rampAbsorbedAmps`
//       against the bar below), and
//   (b) whole-house — the modeled running total sits well ABOVE the smoothed
//       meter, with no reducing cut of ours in flight to explain the gap.
//
// (a) alone is not enough: a room whose compressor is genuinely off at the wall
// looks identical. (b) alone is not enough either: it is a statement about the
// house, and one dead room among two running ones can produce it. Only the pair
// says "this specific compressor has not started, and the meter agrees".

import type { AcView, PowerSource } from "./types.js";
import type { LevelingConfigV2 } from "./config.js";
import { modelFor, steadyDraw } from "./costs.js";

/**
 * The AC fields the modeled-draw sum needs. `AcView` satisfies it structurally,
 * and so does the thin projection the controller shell builds straight off its
 * device context before views exist (the hold has to be decided BEFORE
 * `buildViews`, because `buildViews` is what turns `rampUntil` into `ramping`).
 */
export type ModeledAc = Pick<
  AcView,
  "deviceId" | "on" | "managed" | "shed" | "currentLevel" | "maxLevel"
>;

/** Σ modeled steady draw of the ACs we believe are running on `source`. */
export function modeledRunningAmps(
  acs: readonly ModeledAc[],
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
 * How far the MODEL may sit above the meter before the residual is fiction
 * rather than measurement.
 *
 * Compared against `Σ modeled steady draw of the running managed ACs − smoothed
 * meter`; on this house that sum runs from 2.2 A (one 1-ton at L1) to ~19 A
 * (three rooms at L3). The largest single increment that can consume this
 * threshold is one modeled-ON compressor not running, and the SMALLEST of those
 * here is a 1-ton at L1 (~2.2–2.3 A) — more than twice the bar, so no single
 * dead compressor can hide beneath it. What is left below 1.0 A is ordinary
 * under-draw (a satisfied compressor cycling below its cap) and the smoothing
 * window's own lag: readings whose residual is still honest.
 */
export const RESIDUAL_TRUST_GAP_AMPS = 1.0;

/**
 * The gap that says our compressors are not drawing AT ALL.
 *
 * Same quantity as `RESIDUAL_TRUST_GAP_AMPS`, less any commanded cut still in
 * flight — a cut we sent drops the model instantly and reaches the meter over
 * minutes, so that gap is explained, not evidence (invariant 5).
 *
 * Sized above `FLICKER_MAX_AMPS` (1.5 A, sensing.ts) so generator supply wobble
 * alone can never arm it, and at or below the smallest whole compressor on this
 * house (~2.2 A) so ONE dead room still registers. The full set it is compared
 * against: the modeled running total (2.2–19 A), the smoothed meter, and
 * `MeterView.commandedCutCreditAmps` (0–13 A during a reduction train).
 */
export const DEAD_WINDOW_GAP_AMPS = 2.0;

/**
 * Fraction of an AC's modeled steady draw the meter must have absorbed before
 * its power-event ramp is allowed to expire on the clock.
 *
 * Deliberately NOT 100%: a compressor legitimately running under its model must
 * release normally, or every healthy house freezes its own raise path. Abdullah
 * measured 1.8 A at an L1 modeled 2.3 A on 2026-08-03 (78%) and must not extend.
 */
export const RAMP_RELEASE_FRACTION = 0.4;

/**
 * …capped in absolute amps, so the bar stays reachable for a big compressor:
 * 40% of Abdu's 9.0 A L3 model is 3.6 A, more than the entire draw of either
 * 1-ton room. The question this bar answers is "did a compressor START", not
 * "did it finish".
 *
 * What it is compared against: `AcView.rampAbsorbedAmps`, the ratcheted peak
 * rise of the SMOOTHED meter since the ramp armed. Largest single increment
 * that can consume 1.0 A of it without a compressor starting: supply flicker,
 * which `flickerAmps()` caps at 1.5 A on RAW readings — but the 8-wide median
 * this is measured on removes single-reading spikes, so the smoothed excursion
 * is a fraction of that. And the failure direction is benign either way: a
 * premature release restores exactly the pre-2026-08-04 behaviour (expire on
 * the timer), it cannot make anything more permissive than that.
 */
export const RAMP_RELEASE_MAX_AMPS = 1.0;

/** Absorption an AC must show before its power-event ramp may close. */
export function rampReleaseBarAmps(modeledSteadyAmps: number): number {
  return Math.min(RAMP_RELEASE_MAX_AMPS, RAMP_RELEASE_FRACTION * modeledSteadyAmps);
}

/**
 * The committed steady draw a ramp was armed against — the exact figure
 * `rampDebitAmps` charges a ramping AC (`raise.ts`), factored out so admission
 * and the early-release path below price a compressor's arrival from ONE
 * arithmetic. A committed draw computed two ways is a committed draw that
 * eventually disagrees (the 2026-08-05 pooling bug was two sites reading the
 * same rise differently).
 */
export function rampCommittedAmps(
  ac: Pick<ModeledAc, "deviceId" | "currentLevel" | "maxLevel">,
  config: LevelingConfigV2,
  source: Exclude<PowerSource, "none">,
): number {
  return steadyDraw(ac.currentLevel, ac.maxLevel, modelFor(config, ac.deviceId, source));
}

/** Has this AC's compressor demonstrably started? (evidence (a)) */
export function rampAbsorptionLanded(
  absorbedAmps: number,
  ac: ModeledAc,
  config: LevelingConfigV2,
  source: Exclude<PowerSource, "none">,
): boolean {
  return absorbedAmps >= rampReleaseBarAmps(rampCommittedAmps(ac, config, source));
}

// ---------------------------------------------------------------------------
// Amp evidence releases the ramp WINDOW before its clock (user directive,
// 2026-08-08: "we can watch the amps to know if it worked and stable without
// the need to wait the end of time").
//
// `AcView.ramping` is armed for 240 s (`AC_RAMP_MS`) and, before this, only ever
// expired on that clock — so the raise gate, house sampling, swap-donor
// eligibility, the fan-restore self-skip and the FLOORS "nothing ramping" clear
// all waited out the full four minutes even when the meter had already shown the
// compressor land and settle. A rise the meter has already digested is not a
// rise still in transit; the window has nothing left to protect once the
// evidence is in.
//
// "PROVEN done" has TWO halves, and both are required — a rise is done only when
// it has (i) risen enough to prove a compressor started, and (ii) STOPPED
// rising:
//   (i)  the ratchet crossed the "a compressor genuinely started" bar
//        (`rampReleaseBarAmps`), so it is not the changeover dead window (a room
//        drawing its fan while restart protection holds the compressor off); and
//   (ii) the ratchet has PLATEAUED — no growth of `RAMP_SETTLED_EPSILON_AMPS`
//        for `RAMP_SETTLED_STALL_MS`.
//
// The plateau reports which kind of landing it was, for the log:
//   * "absorbed"  — it settled AT OR ABOVE its committed model draw. The ordinary
//     healthy compressor that reached what the ramp was priced for.
//   * "plateaued" — it settled ABOVE the bar but BELOW its model. The compressor
//     that runs under its cap: a satisfied 1-ton, a room the weather does not
//     push to its ceiling. Without recognising it, such a room would pin its
//     window for the full 240 s again.
//
// ⚠ The plateau is required even after full absorption, and it is load-bearing.
// The committed figure is the MODEL draw (what `rampDebitAmps` charges), and an
// UNDER-MODELLED room crosses it while STILL CLIMBING toward a higher real draw.
// Releasing there is not "stable" — it is mid-ramp — and it defeats the reducer's
// turn-on attribution: 2026-07-27, Najat's real 3.7 A L1 draw against a 2.7 A
// model crossed the model ~15 s before her own transient tipped the meter over
// the breaker, so `ramping` dropped, `preferShed` lost her, and the reducer shed
// the innocent hotter bystander (Abdu) — the 2026-07-25 incident, reopened. The
// stall clock is what makes the release match the user's own words ("worked AND
// stable"): a compressor that is still climbing has a live growth stamp and is
// never called done, whatever value it has passed through.
//
// NEVER on flatness alone: a ratchet UNDER the bar is a compressor that has not
// started (the changeover dead window above), and it keeps its full window and
// invariant 44's extension machinery.
// ---------------------------------------------------------------------------

/**
 * How little the absorption ratchet may grow and still count as PLATEAUED
 * (mechanism (b)). Sized above the 8-wide median's residual wobble so ordinary
 * smoothing noise does not read as a compressor still climbing — a room that
 * genuinely creeps up 0.05 A a reading is settled, and holding its window open
 * for that noise would defeat the whole point of (b).
 */
export const RAMP_SETTLED_EPSILON_AMPS = 0.15;

/**
 * How long the ratchet must sit within `RAMP_SETTLED_EPSILON_AMPS` before the
 * plateau is believed.
 *
 * ≳2× the 8-wide median's ~12–20 s settle lag, deliberately: a smoothed step
 * still in transit keeps growing for the length of that lag, so a stall shorter
 * than it could call a compressor "plateaued" while its own rise has not yet
 * finished reaching the meter. 45 s clears the lag with margin, and the failure
 * direction is benign — releasing late costs a raise that arms a few readings
 * later, exactly the pre-2026-08-08 behaviour.
 */
export const RAMP_SETTLED_STALL_MS = 45_000;

/**
 * Is this ramp's rise PROVEN done, so its window may close before the clock?
 * `absorbedAmps` is the ratcheted peak rise of the smoothed meter since the ramp
 * armed; `committedAmps` is `rampCommittedAmps` (the same figure the debit
 * charges); `lastGrowthAt` is when the ratchet last grew by at least the epsilon.
 *
 * Both halves are required. A ratchet still CLIMBING has a fresh growth stamp and
 * is never called done — that is what stops an under-modelled compressor being
 * released mid-ramp the instant it passes its model (2026-07-27, see the header).
 * A ratchet UNDER the bar has not proven a compressor at all and keeps its window
 * (the changeover dead window). Returns "absorbed" when it settled at/above its
 * model draw, "plateaued" when it settled above the bar but below it, else null.
 */
export function rampProvenDone(opts: {
  absorbedAmps: number;
  committedAmps: number;
  lastGrowthAt: number;
  now: number;
}): "absorbed" | "plateaued" | null {
  // Still climbing → not settled → not done, whatever value it has passed.
  if (opts.now - opts.lastGrowthAt < RAMP_SETTLED_STALL_MS) return null;
  // Under the started bar → the compressor never started (dead window).
  if (opts.absorbedAmps < rampReleaseBarAmps(opts.committedAmps)) return null;
  return opts.absorbedAmps >= opts.committedAmps ? "absorbed" : "plateaued";
}

/**
 * How far the model sits ABOVE the meter, net of a reducing cut we commanded
 * and the meter has not shown yet. Positive means "we believe we are drawing
 * more than the line is carrying"; negative is the ordinary case (the meter
 * carries the house on top of the ACs).
 */
export function modeledGapAmps(opts: {
  smoothedAmps: number;
  acs: readonly ModeledAc[];
  config: LevelingConfigV2;
  source: Exclude<PowerSource, "none">;
  /** `MeterView.commandedCutCreditAmps` — amps already commanded off, still landing. */
  commandedCutCreditAmps?: number;
}): number {
  return (
    modeledRunningAmps(opts.acs, opts.config, opts.source) -
    opts.smoothedAmps -
    (opts.commandedCutCreditAmps ?? 0)
  );
}

/** Whole-house evidence that nothing of ours is drawing (evidence (b)). */
export function houseIsDead(gapAmps: number): boolean {
  return gapAmps >= DEAD_WINDOW_GAP_AMPS;
}

/**
 * How far the newest RAW reading may sit above the smoothed mean while a DIRECT
 * house sample is taken.
 *
 * "The meter is the house" is only true while the meter is not moving. When a
 * compressor finally engages, the raw reading jumps at once and the 8-wide
 * median follows over the next readings — so for four or five ticks (it was two
 * or three before the 2026-08-05 widening, which makes this guard MORE
 * load-bearing, not less) the smoothed value is a BLEND of house and compressor
 * while the whole-house gap has not yet fallen under `DEAD_WINDOW_GAP_AMPS`. The acceptance run booked a
 * 6.5A "house" on the tick the median was halfway up from a real 2.0A, and that
 * peak then refused every raise for the next fifteen minutes.
 *
 * Compared against `latestAmps − smoothedAmps`. The largest single increment
 * that can consume it while the house really is alone on the line is supply
 * flicker, which `flickerAmps()` caps at 1.5A on raw readings — so it sits
 * above that, and below the smallest compressor that can start (a 1-ton at L1,
 * ~2.2A modeled, and its inrush is larger still). Only the rising direction is
 * checked: a raw reading BELOW the mean means the house shrank, and recording
 * the higher smoothed value merely over-states it, which over-blocks.
 */
export const DIRECT_SAMPLE_DRIFT_AMPS = 1.6;

/** Is the meter still enough for its reading to BE the house? */
export function meterIsSteady(view: { latestAmps: number; smoothedAmps: number }): boolean {
  return view.latestAmps - view.smoothedAmps <= DIRECT_SAMPLE_DRIFT_AMPS;
}

// ---------------------------------------------------------------------------
// Per-AC compressor evidence from a GRADED off-drop (R6, and the user's own
// experiment: "an off with 1 amp or less of drop means the compressor was not
// running").
//
// The sub-floor watch (needs.ts) answers the same question from the
// thermometer, and it is the honest signal — but it needs three minutes of a
// room failing to get cooler. A lone shed's off-drop answers it in one grading
// window, and the shed is going to happen anyway.
//
// ⚠ ATTRIBUTABLE evidence only. The standing residual (`smoothed − modelled`)
// moves when a room under-draws its model, so reading it to decide whether a
// room is under-drawing is circular — that reasoning produced one wrong
// diagnosis on 2026-08-03 and the user corrected it. A graded LONE off is not
// circular: it is a controlled experiment with one actuator, and the grading
// pipeline already refuses windows born beside another batch (invariant 23).
// ---------------------------------------------------------------------------

/**
 * The largest measured off-drop that still says "nothing but the fan was
 * running" (user, 2026-08-04, from switching a room off and watching the meter:
 * "1 amp or less").
 *
 * Largest single increment that can consume it (hard rule 5c): the room's FAN,
 * which does leave the meter with the compressor. A TCL at fan 7 draws ~0.3 A
 * of fan over its blower's floor, and the smoothing window adds its own wobble
 * — an amp of headroom over the user's bar covers both. Compared against the
 * graded drop of a single power_off, nothing else; it is never compared to a
 * residual, which is the circular quantity above.
 */
export const COMPRESSOR_OFF_DROP_AMPS = 1.2;

/**
 * …and the drop only MEANS anything when the model claimed real load. A room
 * modelled under this draws so little that "it dropped less than 1.2 A" is
 * consistent with a perfectly healthy compressor.
 *
 * Sized at the smallest whole compressor on this house (a 1-ton at L1, ~2.2–2.3
 * A modelled) minus a margin: above it, a ≤1.2 A drop means at least half the
 * modelled draw never existed. Compared against `steadyDraw` at the confirmed
 * level — the same figure the envelope and the dead window price with.
 */
export const COMPRESSOR_OFF_MODEL_AMPS = 2.0;

/**
 * A graded drop this large is POSITIVE proof the compressor was running, and
 * retires any standing off-evidence for that room.
 *
 * Same quantity and same reasoning as `DEAD_WINDOW_GAP_AMPS` — it is the
 * smallest whole compressor this house has — so the two cannot disagree about
 * what "a compressor's worth of amps" means.
 */
export const COMPRESSOR_ON_DROP_AMPS = DEAD_WINDOW_GAP_AMPS;

/** Did this lone off measure a room that was drawing about its fan? */
export function offDropSaysCompressorOff(dropAmps: number, modeledSteadyAmps: number): boolean {
  return modeledSteadyAmps >= COMPRESSOR_OFF_MODEL_AMPS && dropAmps <= COMPRESSOR_OFF_DROP_AMPS;
}

/** …or one that was demonstrably running? */
export function offDropSaysCompressorOn(dropAmps: number): boolean {
  return dropAmps >= COMPRESSOR_ON_DROP_AMPS;
}

/**
 * How far ABOVE its priced step a lone raise OFF L1 must rise before the only
 * physical explanation left is a compressor that was not running at L1
 * (2026-08-06).
 *
 * This is the RISE-side twin of the off-drop above, and it exists because the
 * off-drop only speaks when a room is going off anyway. A raise off L1 happens
 * on the way UP, minutes earlier, and it measures the same thing from the other
 * end: if the compressor was already running, the meter moves by the level step
 * (a duty/cap change); if it was not, the meter moves by the whole compressor
 * starting — the step PLUS everything L1 was supposed to be drawing and wasn't.
 *
 * Largest single increment that can consume it (hard rule 5c): the error in the
 * priced step it is added to. `pricedStepAmps` is `raiseJumpAmps`, i.e.
 * max(model, learned), so an over-priced step only makes this test HARDER — the
 * dangerous direction is a step priced too LOW, and the worst such error this
 * house has produced is ~1.0 A (Abdullah's gen step model sat at 2.5 A against a
 * measured ~1.5 A until 2026-08-03). On top of that the sample is a ratcheted
 * peak off the smoothed meter, which a supply excursion can inflate by the live
 * flicker. Two amps covers both — and it is deliberately the SAME quantity as
 * `COMPRESSOR_ON_DROP_AMPS`/`DEAD_WINDOW_GAP_AMPS`, "the smallest whole
 * compressor this house has", so all three compressor-evidence bars agree about
 * what a compressor is worth.
 *
 * ⚠ Accepted, and deliberate: this is a HIGH bar and it will miss genuine
 * cases. A 1-ton starting from fan-only into L2 rises about `steadyDraw(2)`
 * minus its fan ≈ 3.4 A against a bar of 1.5 + 2.0 = 3.5 A. The failure
 * direction is chosen: under-arming costs a hold that arms later (the off-drop
 * and the user's own hand raise still catch it), while over-arming spends a
 * hotter room's amps for six hours on fiction — which is exactly what the
 * temperature watch this replaced did on 2026-08-06.
 *
 * ⚠ REPORT-ONLY since 2026-08-06 (review, same day it shipped). The bar above
 * is honest about the *step price*, and dishonest about everything else on the
 * line: the rise it is compared to is `PendingGrade.peakDeltaAmps`, a ratcheted
 * WHOLE-HOUSE smoothed delta over the 240 s grading window, and nothing
 * subtracts non-AC load. This house's own water heater is a 3.4 A step. Switch
 * it on ninety seconds into the window and a perfectly ordinary 1.5 A level
 * step measures 4.9 A against a 3.5 A bar — a false hold, six hours, spending
 * the hottest room's amps, which is the exact failure class invariant 56 was
 * written to kill. The off-drop (55) does not have this problem: it is a FALL,
 * and a coincident household fall is both rarer and self-limiting.
 *
 * So the verdict is emitted and never acted on: `compressorOffLikely` is not
 * set and no level hold is armed. The armers stay the three that measure only
 * what they can attribute — the graded off-drop, the dead window, and the
 * user's own hand raise. Closing this properly needs the rise measured net of
 * `houseLoadAmps` at both ends of the window, which is its own investigation.
 */
export const COMPRESSOR_START_RISE_MARGIN_AMPS = COMPRESSOR_ON_DROP_AMPS;

/**
 * Did this lone raise measure a compressor STARTING rather than a level step?
 * `riseAmps` is the graded window's ratcheted peak rise; `pricedStepAmps` is
 * what admission charged for the same move.
 *
 * ⚠ REPORT-ONLY — see the margin's own note. A `true` here is journalled and
 * logged; it arms nothing.
 */
export function raiseRiseSaysCompressorWasOff(riseAmps: number, pricedStepAmps: number): boolean {
  return riseAmps >= Math.max(0, pricedStepAmps) + COMPRESSOR_START_RISE_MARGIN_AMPS;
}

/**
 * May this raise's rise be read as compressor evidence at all? Decided at the
 * moment the command is SENT, because every exclusion is a statement about the
 * state we commanded it from.
 *
 * The question the measurement answers is "did this level step start a
 * compressor that L1 was not running?", and it only has that answer when the
 * compressor had no OTHER reason to start:
 *
 *  - `fromLevel === 1` — the evidence is about L1 and nothing else. A big rise
 *    off L2 says the room was working harder, not that L2 was dead.
 *  - not in FLOORS — the recovery admission commands a whole house back to its
 *    floors at once, so no single command owns the meter, and it does so exactly
 *    when every compressor is restarting anyway.
 *  - not in a start window — the room has just been switched on; its compressor
 *    is starting because it was OFF, which is not news about L1.
 *  - not inside a power-event ramp — the dead window after a changeover, where
 *    TCL restart protection holds the compressors off for minutes. A raise there
 *    ALWAYS engages the compressor, because that is restart protection ending.
 *    Without this exclusion every gen changeover of the day would mint a hold.
 *
 * Contamination and settle are deliberately NOT here: the grading pipeline
 * already refuses a window born beside another batch (invariant 23) and one
 * whose compressor has not settled (invariant 29), and the evidence is read at
 * `learnAfter` — behind exactly that certification.
 */
export function loneRaiseIsAttributable(input: {
  fromLevel: number;
  floorsMode: boolean;
  inStartWindow: boolean;
  inPowerEventRamp: boolean;
}): boolean {
  return (
    input.fromLevel === 1 && !input.floorsMode && !input.inStartWindow && !input.inPowerEventRamp
  );
}

// ---------------------------------------------------------------------------
// Trip on ENTRY (2026-08-04, user-confirmed: the breaker physically tripped
// this morning and he reset it by hand).
//
// The refined timeline is worse than the one above. The gen session did not
// merely start with the compressors in restart protection — it started with the
// AC CIRCUIT ALREADY DEAD. The quiet ~6A window from 11:16 to ~11:21 was a
// tripped breaker, the four FLOORS resends went to devices that could not hear
// them, and the reset at ~11:21–11:22 brought all three ACs back at once with
// restart protection already served: 6.4 → 16.6A in ninety seconds.
//
// The collapse latch missed a real trip for the THIRD time, and this is a new
// hole class. Invariant 31 fixed the floor (a trip leaves the house drawing);
// invariant 5 fixed the credit (our own cut is not a trip). Both still describe
// a FALL inside one source session — and a session that BEGINS dead has no
// cliff to see. No latch, so no derate: the controller then rode 14.3–14.8A on
// a generator whose breaker had just opened.
//
// Two signals, and the pair is what makes it safe:
//   (a) the dead-window gap above — our model says we are drawing and the meter
//       says nothing is;
//   (b) every managed running room's cloud shadow has gone dark.
// Restart protection keeps the Wi-Fi modules powered, so (b) is what separates
// "the compressors have not started" from "the circuit is dead". And a house
// Wi-Fi outage cannot fake it in the other direction: the ACs keep drawing, so
// (a) never holds.
// ---------------------------------------------------------------------------

/** What the entry-collapse evidence needs to know about one room. */
export interface RoomLiveness {
  /** The folded online decision (`deviceOnline()` — TCL's flag, else shadow freshness). */
  isOnline?: boolean;
  /** Epoch ms of this room's last shadow report, null/undefined when unknown. */
  lastSeenAt?: number | null;
  /** Epoch ms we last saw one of our sends CONFIRM on this room's shadow. */
  lastConfirmAt?: number | null;
  /** Age of this room's oldest still-unconfirmed send (0 = nothing in flight). */
  unconfirmedSendAgeMs?: number;
}

/**
 * A shadow this stale is dark on its own, whatever else is going on.
 *
 * ⚠ MEASURED, 2026-08-04, twice about a minute apart: last-seen ages of
 * 248/157/269 s and then 305/214/326 s — none of the three advanced, and two of
 * the rooms were actively cooling with their compressors running. TCL shadows
 * report on STATE CHANGE, not on a keepalive, so healthy silence routinely
 * passes 5.5 minutes. Any passive bar under that calls a working house dead.
 *
 * Eight minutes therefore sits above the measured healthy silence with margin,
 * and it is NOT what the latch normally runs on — the entry-anchored evidence
 * below is. This exists only so a house that went dark long after a changeover
 * (where the entry anchor has nothing to say) can still be recognised.
 */
export const ENTRY_COLLAPSE_STALE_MS = 8 * 60_000;

/**
 * How long a send may sit unconfirmed before it counts as ACTIVE evidence that
 * nothing is listening.
 *
 * This is the fingerprint of this morning's trip: gen entry FLOORS-sends every
 * room above its floor at entry+2 s, and not one of those four sends was ever
 * confirmed — because the devices could not hear them. A live module confirms
 * in about a minute or two even while its compressor is held off by restart
 * protection (the Wi-Fi side never lost power), so two minutes of silence on a
 * send we actually made is a claim about the DEVICES, not about a cadence.
 *
 * ⚠ Najat's firmware confirms anywhere from 5.8 s to 13 min, which is exactly
 * why this is "at least ONE room has an old unconfirmed send" and not "every
 * room confirms promptly". One slow room is normal; nothing at all is not.
 */
export const ENTRY_COLLAPSE_UNCONFIRMED_MS = 120_000;

/**
 * How long the whole evidence set must hold CONTINUOUSLY before the latch arms.
 *
 * On top of the two minutes an unconfirmed send already has to age, so the
 * earliest possible latch is about entry + 3 min — inside the six-minute window
 * this morning's breaker actually gave us, and far too late to be tripped by a
 * single unlucky tick.
 */
export const ENTRY_COLLAPSE_DWELL_MS = 60_000;

/**
 * Has this room shown any sign of life since the current source session began?
 *
 * Deliberately anchored to the CHANGEOVER rather than to a cadence: "nothing
 * since entry" is a statement about a known event, where "nothing for N
 * minutes" is a bet on how often a healthy module talks — and the measurement
 * above says that bet loses. Either signal counts, because they cover different
 * rooms: a room the entry policy clamped proves itself by confirming, and a
 * room already at its floor (nothing was sent to it) can only prove itself by
 * reporting.
 *
 * Positive evidence only. Unknown liveness is not evidence of death.
 */
export function roomIsDark(room: RoomLiveness, opts: { sinceEntry: number; now: number }): boolean {
  if (room.isOnline === false) return true;
  if (room.lastSeenAt != null && room.lastSeenAt > opts.sinceEntry) return false;
  if (room.lastConfirmAt != null && room.lastConfirmAt > opts.sinceEntry) return false;
  // Nothing since entry — or nothing ever. The passive bar is the long stop for
  // a session whose entry is far behind us.
  if (room.lastSeenAt != null && opts.now - room.lastSeenAt <= ENTRY_COLLAPSE_STALE_MS) {
    return opts.sinceEntry > 0 && room.lastSeenAt <= opts.sinceEntry;
  }
  return true;
}

/**
 * Entry-collapse evidence for one tick. Four things must agree:
 *   - the model says we are drawing and the meter says nothing is;
 *   - EVERY managed running room is dark (one flapping module is a cloud
 *     problem, not a breaker);
 *   - at least one room has a send we made sitting unconfirmed — the ACTIVE
 *     anchor, without which "dark" is only an absence of chatter;
 *   - and there is an entry to anchor "since" to at all.
 *
 * A house Wi-Fi or cloud outage cannot fake this: the ACs keep drawing, so the
 * gap never holds. Restart protection cannot either: the modules keep their
 * power, confirm the entry clamp, and light up the first condition.
 */
export function entryCollapseEvidence(opts: {
  gapAmps: number;
  rooms: readonly RoomLiveness[];
  sinceEntry: number;
  now: number;
}): boolean {
  if (opts.rooms.length === 0 || opts.sinceEntry <= 0) return false;
  if (!houseIsDead(opts.gapAmps)) return false;
  if (!opts.rooms.every((r) => roomIsDark(r, { sinceEntry: opts.sinceEntry, now: opts.now }))) {
    return false;
  }
  return opts.rooms.some((r) => (r.unconfirmedSendAgeMs ?? 0) >= ENTRY_COLLAPSE_UNCONFIRMED_MS);
}
