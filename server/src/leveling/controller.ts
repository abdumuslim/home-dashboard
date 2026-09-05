// Leveling v2 stateful shell. Owns I/O and episodic state; every decision is
// delegated to the pure pipeline. Implements the v1-compatible LevelingApi so
// collector/routes swap controllers via the config flag.
//
// Shadow mode: runs the full pipeline each tick and journals what it WOULD do
// (executed=false) but sends nothing. Manual-intent minting is suppressed in
// shadow (v1's commands would read as external changes — a known fidelity
// limit, documented in the plan).

import pg from "pg";
import { childLogger } from "../logger.js";
import type { LevelerDeviceContext, LevelingDeps, LevelingStatusV2 } from "./api.js";
import { DEFAULT_LEVELING_CONFIG_V2, isLevelingV2Key, LEVELING_V2_CONFIG_KEYS, mergeLevelingConfigV2, effectiveLimit, limitFor, type AcNeedOverride, type ControllerFlavor, type LevelingConfigV2 } from "./config.js";
import {
  applyBucketCapacity,
  clearCollapse,
  derateFor,
  ingestReading,
  initialMeterState,
  latchCollapse,
  meterView,
  noteCommandedCut,
  OVER_LIMIT_BUDGET_AFTER_ACT,
  PENDING_CUT_MS,
  refillBucket,
  resetCalm,
} from "./sensing.js";
import {
  applyMeterEvent,
  clearFloorsIfDone,
  clearFloorsOnManual,
  clearGridFullIfDone,
  clearSettleIfDone,
  deriveMode,
  FLOORS_MAX_MS,
  initialModeState,
  noteBatch,
  type ModeState,
} from "./modes.js";
import { plan, type PlanOutput } from "./pipeline.js";
import { GRADE_FAN_MS, GRADE_TURN_ON_MS } from "./pipeline.js";
import {
  ATTEMPT_BLAME_WINDOW_MS,
  attemptedRecently,
  attemptedWithin,
  barPersistMs,
  clearBounces,
  cooldownRemainingMs,
  initialPacingState,
  noteAttempt,
  noteFailure,
  noteSuccess,
  reshedPenalized,
  resetPacing,
  restoreBounces,
  type PacingState,
} from "./pacing.js";
import { planFanRestore, recordFanCut, releaseFanHold, type FanHolds } from "./fan-trim.js";
import {
  armDropCooldown,
  EXTERNAL_ON_VOID_MS,
  HOUSE_SAMPLE_COOLDOWN_MS,
  houseLoadAmps,
  initialHouseLoad,
  sampleHouseLoad,
  voidSamples,
  type HouseLoadState,
} from "./house-load.js";
import {
  COMPRESSOR_START_RISE_MARGIN_AMPS,
  ENTRY_COLLAPSE_DWELL_MS,
  entryCollapseEvidence,
  type RoomLiveness,
  houseIsDead,
  loneRaiseIsAttributable,
  meterIsSteady,
  modeledGapAmps,
  offDropSaysCompressorOff,
  offDropSaysCompressorOn,
  raiseRiseSaysCompressorWasOff,
  rampAbsorptionLanded,
  rampCommittedAmps,
  rampProvenDone,
  RAMP_RELEASE_MAX_AMPS,
  RAMP_SETTLED_EPSILON_AMPS,
  type ModeledAc,
} from "./dead-window.js";
import {
  baselineStale,
  clearMarksOnManual,
  clearOnPowerOff,
  clearOnSourceChange,
  confirmFan,
  fanResendDue,
  initialReconcilerState,
  markRebaseOnPowerCycle,
  noteFanSend,
  noteLevelSend,
  observeLevel,
  reachableCapOf,
  shouldSendLevel,
  sweepExpiredMarks,
  UNCONFIRMED_SEND_TTL_MS,
  unconfirmedLevels,
  unconfirmedSends,
  type ReconcilerState,
} from "./reconciler.js";
import {
  boostFloor,
  type BoostZone,
  ceilOf,
  floorOf,
  nearTargetNeedCap,
  nextSubFloorWatch,
  SUBFLOOR_WATCH_MS,
  type SubFloorWatch,
  worstCaseLevel,
} from "./needs.js";
import {
  LEVEL_HOLD_TTL_MS,
  levelHoldDetail,
  levelHoldExpiresAt,
  levelHoldFloor,
  levelHoldLive,
  recordLevelHold,
  type LevelHold,
} from "./level-hold.js";
import { DEMOTE_HYSTERESIS_C } from "./demote.js";
import { powerEventRestartsAcs } from "./power-events.js";
import { absorbedSharesAmps, EXTERNAL_ON_DONOR_SHIELD_MS, rampDebitAmps, SWAP_QUIET_AFTER_OVER_MS } from "./raise.js";
import { commandedCutAmpsOf, fanTrimSavings, modelCutAmps, raiseJumpAmps, steadyDraw, modelFor, restoreCostAmps, turnOnAmps, updateCost, type CostBook } from "./costs.js";
import { LevelingStore } from "./store.js";
import type { AcView, Command, Decision, MeterState, Mode, PowerSource } from "./types.js";

const log = childLogger("leveler2");

const AC_RAMP_MS = 240_000;
/**
 * How long a fresh turn-on is treated as a "start" (priced against the house
 * load measured just before it came on). Same window as the compressor ramp —
 * exactly the stretch where the ordinary meter-anchored raise path is blind
 * (the meter has not absorbed the new AC yet) and blocked.
 *
 * Opened on BOTH sources since 2026-07-30, but the policy inside it is opposite
 * per line: on grid the AC is LIFTED to the highest level that fits
 * ("start all to full"), on gen it is CLAMPED to its floor (the per-device form
 * of FLOORS — see `invariantCorrections`).
 */
const START_WINDOW_MS = AC_RAMP_MS;
/**
 * Hard cap on a ramp window held open by dead-window evidence (see
 * `holdPowerEventRamps` and dead-window.ts). A power event power-cycles every
 * AC, and TCL compressor restart protection then keeps the compressors off for
 * minutes the model knows nothing about — 2026-08-04 measured ~6–7 min after
 * the 11:16 changeover, against a 240 s ramp window that expired on the clock
 * and opened the raise path onto a house-only meter.
 *
 * Three ramps' worth (12 min) is ~2× the longest restart delay observed, and it
 * is a CAP, not a duration: the window closes the moment the meter shows a
 * compressor. Its job is the opposite case — a room whose wall switch is
 * genuinely off looks identical to one in restart protection forever, and
 * without a bound it would fence the raise path for the whole gen session
 * (invariant 22's spirit: evidence may re-open a gate, nothing blocks unbounded).
 */
const POWER_EVENT_RAMP_MAX_MS = 3 * AC_RAMP_MS;
/**
 * How long after a power event an observed level JUMP reads as the firmware
 * restoring its last level rather than a hand on the remote (2026-08-06).
 *
 * A TCL that power-blinks comes back AT THE LEVEL IT WAS LAST LEFT AT, and in
 * the cloud shadow that is indistinguishable from a human raise: an un-commanded
 * level appearing above the confirmed one, with no send of ours to explain it.
 * Live 07:01:52Z — 29 s after the second of two brownout ESP gaps (25 s at
 * 07:00:49 and 28 s at 07:01:23, which also armed a strain derate) — Abdu's
 * shadow rose off a confirmed L1 and armed the six-hour learned L1 hold
 * (invariant 52) with nobody in the room. That hold put his restore floor at L2
 * (6.5 A instead of 4.3 A) and stranded the hottest room off at 43 °C outdoor.
 *
 * Largest single increment that can consume it (hard rule 5c): the TCL
 * send-to-confirm lag, which runs to ~13 min live (invariant 4) — the shadow can
 * report a restored level that long after the blink that caused it, so the
 * window has to outlast the lag or it guards only the fast half of the failure.
 * That is WHY fifteen minutes, and it is deliberately the same number the
 * collector's observed-OFF classifier already uses (`AC_POWER_EVENT_GRACE_MS`)
 * for the identical judgment on the other edge: an un-commanded off near a power
 * event is a power-loss off, not the user's hand. Two windows answering one
 * question would drift.
 *
 * The failure direction is what lets it be generous: a skipped arm loses one
 * OBSERVATION — the room proves it again the next time it genuinely fails to
 * cool, and the two attributable armers (the graded off-drop, the dead window)
 * are untouched — while a false arm spends the hottest room's amps for six hours.
 */
const POWER_EVENT_LEVEL_JUMP_GRACE_MS = 15 * 60_000;
/**
 * How long a fan restore's amps stay charged as committed-but-unmetered. A fan
 * gear changes almost immediately — nothing like the 4-minute compressor ramp —
 * so this only has to outlive the ESP cadence plus a tick, and the absorption
 * ratchet retires it as soon as the meter shows the rise.
 */
const FAN_DEBIT_MS = 60_000;
/**
 * How long a fresh shed's record is protected from `reconcileObservedOn`
 * clearing it on a still-ON shadow reading — the window inside which an ON with
 * NO off ever observed is presumed the stale echo of a `power_off` still in
 * flight rather than an external hand.
 *
 * 60s, not the 15s it shipped with (#9268/#9270, 2026-08-07 04:15Z): at gen
 * entry the leveler shed Najat and 17.4s later sent a GENUINE DUPLICATE
 * power_off. TCL's send-to-confirm lag runs 5.8s to 13 MINUTES (invariant 4),
 * so a stale still-ON shadow at 17.4s straddled the old 15s grace, cleared the
 * shed mid-flight, and the recovery-admission recompute then saw the room as
 * "on, not shed" and re-decided/re-sent — with the `power_off` dedupe
 * (`SHED_RESEND_SPACING_MS`) blind, because it keys off `shedIds` membership
 * that had just been wrongly cleared. 60s outruns the common lag; the rare
 * multi-minute lag is caught by confirm-or-resend, which the intact shed keeps.
 *
 * ⚠ A wider grace ALONE would be a "manual wins" violation (invariant 42): a
 * human re-enabling a shed room BY REMOTE 20s after the shed would be presumed
 * a stale echo, and the 30s off-resend would switch the room back off against a
 * human's explicit choice — the exact class the 2026-08-06 evening fight
 * (#9224/#9228) already cost this project. So the grace only governs the case
 * where the off was NEVER observed; once a poll has seen the shed room OFF
 * (`shedOffObservedAt`), a later ON is unambiguous external evidence and clears
 * immediately, whatever this window says (see `reconcileObservedOn`).
 */
const SHED_CLEAR_GRACE_MS = 60_000;
/**
 * Send-side spacing for fan trims and sheds — mirrors the reconciler's
 * `LEVEL_RESEND_SPACING_MS`, which levels have always had and these two never
 * did. Two evaluations landing back-to-back used to send the same command
 * twice (live 2026-08-02: an identical `set_fan 5` 200ms apart, and two sheds
 * one second apart).
 */
const FAN_RESEND_SPACING_MS = 30_000;
const SHED_RESEND_SPACING_MS = 30_000;
/**
 * How long a room that gave up a level to fund a PEER's raise must wait before
 * it may take that level back.
 *
 * A funding demote deliberately ships alone — the raise it pays for waits for a
 * meter that has really fallen (invariant 9) — but a compressor takes seconds
 * to minutes to throttle down. Until it does, the receiver still reads "not
 * enough headroom" while the donor's own step, being cheaper AND higher in
 * priority, is admitted immediately. Live 2026-08-02 17:06–17:32: Najat was
 * demoted to fund Abdu, re-took the level ~40 s later, was demoted again, and
 * cycled L1↔L2 roughly every 45 s while Abdu never climbed at all.
 *
 * Long enough for the cut to reach the meter plus one calm window; short enough
 * that if the receiver still cannot afford it, the donor simply gets its level
 * back rather than being stranded.
 */
const FUNDING_COOLDOWN_MS = 120_000;
/**
 * How old the outdoor reading may be and still key a learned non-cooling hold
 * (level-hold.ts).
 *
 * Largest single increment that can consume it (hard rule 5c): the swing of a
 * Baghdad afternoon over ten minutes, which is a fraction of a degree — well
 * inside `LEVEL_HOLD_RELEASE_C`. Compared against nothing but the clock. It is
 * the same freshness contract `levelBoosts` already works to, restated here
 * because the manual-raise trigger arrives on an HTTP request with no weather
 * in hand and has to reach for the last tick's value.
 */
const OUTDOOR_FRESH_MS = 10 * 60_000;
/**
 * How long a room the reducer just cut must wait before it may climb back.
 *
 * Same physics as the funding cooldown, involuntary side: the cut is priced
 * instantly but arrives at the meter over seconds to minutes, so the next calm
 * window sees headroom that does not exist yet and hands the level straight
 * back — into the overload that caused the cut. Live 2026-08-03: Abdullah cut
 * L2→L1 at 00:41:10, raised L1→L2 at 00:42:44. Matched to FUNDING_COOLDOWN_MS
 * deliberately: it is the same wind-down being waited out.
 */
const VICTIM_COOLDOWN_MS = 120_000;
/**
 * How long a gated proactive shed (the swap) may hold its receiver's amps
 * reserved before the record is dropped.
 *
 * Deliberately `ATTEMPT_BLAME_WINDOW_MS`, not a new constant: the trade IS the
 * receiver's restore attempt, one window early. If the donor's off has not
 * bought the room back inside the window we would already be blaming that shed
 * for, the trade has failed on its own terms and the ordinary queue takes over
 * — the donor is a normal shed row and restores when budget genuinely allows.
 * Nothing may reserve amps unboundedly (invariant 22's spirit).
 */
const SWAP_RESERVATION_MS = ATTEMPT_BLAME_WINDOW_MS;
/**
 * De-dup window for `creditRoomOff`: the same physical off can be seen twice (the
 * REST tap credits immediately, then the device poll re-observes it because
 * `onUserPowerOff` never updates `prevPowerStates`). A second credit for the same
 * device inside this window is skipped unless the room was seen ON in between.
 */
const OFF_CREDIT_DEDUP_MS = 60_000;
/**
 * How long a shed room must keep reporting ON after a boot before its shed
 * record is cleared. The boot shadow can be up to 13 minutes stale, so one
 * sighting proves nothing; two sightings this far apart mean the cloud has
 * refreshed at least once with the room still on.
 */
const BOOT_SHED_CLEAR_GRACE_MS = 90_000;
const PUSH_THROTTLE_MS = 5 * 60_000;
/** Grade a batch only when this many fresh readings arrived after compareAfter. */
const GRADE_MIN_SAMPLES = 4;

/**
 * How long an earlier batch keeps the meter "out of step" for cost learning.
 * A compressor ramps IN over AC_RAMP_MS; a cut/shed/turn-off winds DOWN and
 * drains through the smoothing median for about two minutes (the same physics
 * as house-load's modeled-drop cooldown). A single-command grade window BORN
 * while an earlier batch is still settling in ITS OWN direction cannot
 * attribute its extreme to itself: 2026-08-02 11:20, Najat's shed 5s after
 * Abdu's level cut graded −4.03A (truth ≈ −2.3A) into on@L1, and that
 * inflated price then refused every restore the meter had real room for
 * (17 min stranded, user rescue). Such windows journal but never learn — the
 * mirror of the existing `contaminated` sweep, which only covers a LATER
 * batch moving into an open window.
 */
/**
 * ⚠ Matched to `GRADE_TURN_ON_MS`, not to `AC_RAMP_MS`. When the turn-on grade
 * window was lengthened to 315s (to outlive the attempt blame window) this
 * stayed at the 240s ramp, leaving a 75-second hole: a window armed 250s after
 * a turn-on evaluated as "born clean" while that turn-on's own compressor —
 * by this code's own model — was still ramping.
 */
const LEARN_SETTLE_UP_MS = GRADE_TURN_ON_MS;
const LEARN_SETTLE_DOWN_MS = 120_000;

/** Hard cap on outstanding grade windows (runaway guard — normally 1–3). */
const MAX_PENDING_GRADES = 20;
/** Drop a grade window this long past its compare point (never graded, never leaks). */
const GRADE_ABANDON_MS = 10 * 60_000;
/** One durable "blocked" journal row per (device, blockedBy) per this window. */
const BLOCKED_JOURNAL_THROTTLE_MS = 5 * 60_000;

interface PendingGrade {
  journalId: number;
  compareAfter: number;
  /**
   * When the COST sample may be taken — separate from `compareAfter`, which
   * only gates the journal row.
   *
   * A level raise was graded 45s after the command (`GRADE_LEVEL_MS`) while the
   * compressor needs `AC_RAMP_MS` (4 min) to reach its new steady draw, so every
   * sample measured roughly the first fifth of the ramp. Live 24h to 2026-07-28:
   * 32 of 33 graded gen raises came in BELOW what admission charged (median
   * −1.12A; Najat's L1→L2 graded +0.23A and the gen was shedding her 3.6 min
   * later). The EWMA then dragged each transition down with every sample — the
   * cost book's own history shows MORE samples giving LOWER costs
   * (Abdullah level:2>3 = 0.74A over 16 samples against a ~1.4A true step),
   * which is a biased estimator, not a converging one. `raiseCostAmps` takes
   * max(model, learned), so the corruption was masked rather than dangerous:
   * learned costs simply never rose above the config model, and the learning
   * loop was inert for raises.
   */
  learnAfter: number;
  preAmps: number;
  /**
   * Ratcheted extreme of (smoothed − preAmps) over the learning window, in the
   * direction this batch moves the meter: the peak RISE for a raise/turn-on,
   * the deepest DROP for a shed. One-way, like `rampAbsorbedAmps` — once the
   * meter has proven a compressor's amps arrived, a peer's later reduction
   * cannot un-prove it, so a long window no longer under-reads.
   */
  peakDeltaAmps: number;
  /** Journal row already graded — the window now lives only for the cost sample. */
  journaled: boolean;
  source: PowerSource;
  /**
   * Set when the batch had exactly one meter-affecting command (cost learning).
   * `negate` inverts the observed delta before learning: a single power_off
   * shed measures the device's ON draw as a clean instantaneous DROP — the
   * best on-cost sample there is (a turn-on's grade needs the full ramp
   * window and is often contaminated by then; the 2026-07-27 bounces never
   * produced one, which is how a wrong-low on@L1 could persist).
   */
  single: { deviceId: string; transition: string; negate?: boolean } | null;
  attempts: Array<{ deviceId: string; kind: "raise" | "restore" }>;
  /**
   * A later batch moved the meter inside this window IN THIS WINDOW'S OWN
   * DIRECTION, so the observed extreme is no longer attributable to this batch
   * alone: journal it (post_amps is still useful forensics) and resolve its
   * attempts, but never LEARN a cost from it.
   *
   * Direction-aware because the measurement is a one-way ratchet: a batch that
   * only REMOVES load cannot inflate a raise's peak rise (it just lowers the
   * readings after it, and the peak already holds), and one that only ADDS load
   * cannot deepen a shed's trough. Marking both as contamination is what made a
   * full-ramp window unaffordable — on a busy gen evening batches land every
   * 30–60s, so nothing would ever be learned.
   */
  contaminated: boolean;
  /** Which direction of later batch can corrupt this window's measurement. */
  direction: "up" | "down";
  /**
   * May this window's rise be read as COMPRESSOR evidence (2026-08-06)? Set
   * only for a lone `set_level` raise off L1 that was commanded outside every
   * state in which a compressor engages for a reason of its own:
   *
   *  - a start window (the room has just been switched on),
   *  - a power-event ramp — the dead window / TCL restart protection after a
   *    changeover. A raise right after a power cycle ALWAYS engages the
   *    compressor, because that is restart protection ENDING, not L1 failing.
   *    This is the exclusion that would otherwise mint a hold on every gen
   *    changeover of the day.
   *  - FLOORS (the recovery admission is commanding a whole house back, so no
   *    single command owns the meter).
   *
   * Contamination and settle are NOT re-checked here — `learnGrade` is already
   * reached only for an uncontaminated window past `learnAfter` (invariants
   * 23/29), which is the same certification the cost learner requires.
   */
  riseEvidence: boolean;
}

/** Whether a batch adds load, removes it, or both (contamination direction). */
export function batchLoadDirections(
  commands: readonly Command[],
  confirmedLevel: (deviceId: string) => number | null,
): { adds: boolean; removes: boolean } {
  let adds = false;
  let removes = false;
  for (const cmd of commands) {
    switch (cmd.kind) {
      case "power_on":
        adds = true;
        break;
      case "power_off":
        removes = true;
        break;
      case "set_level": {
        const from = confirmedLevel(cmd.deviceId);
        // Unknown current level: assume it could go either way (trip-safe).
        if (from == null) { adds = true; removes = true; }
        else if (cmd.level > from) adds = true;
        else if (cmd.level < from) removes = true;
        break;
      }
      case "set_fan":
        // ~0.1A/gear (mined 2026-07) — below the 0.2A learn threshold and deep
        // inside the noise of a 2.5A raise measurement. A trim is still counted
        // in its own direction rather than ignored outright.
        if (cmd.reason === "trim") removes = true;
        else adds = true;
        break;
    }
  }
  return { adds, removes };
}

export class LevelingControllerV2 {
  private loaded = false;
  private rawConfig: Record<string, unknown> = {};
  private config: LevelingConfigV2 = DEFAULT_LEVELING_CONFIG_V2;
  private store: LevelingStore;

  private meterState: MeterState = initialMeterState();
  private modeState: ModeState = initialModeState();
  private pacing: PacingState = initialPacingState();
  private recon: ReconcilerState = initialReconcilerState();
  private fanHolds: FanHolds = {};
  private book: CostBook = {};
  /**
   * Rolling per-source samples of `meter − Σ modeled AC draw` — the non-AC
   * house load the physics envelope was missing when it admitted the raise that
   * tripped the gen on 2026-07-31 (see house-load.ts). In-memory only: a peak
   * re-measures itself within a tick or two of a restart, and 0 (the fallback)
   * is exactly the AC-only envelope v2 shipped with, so a cold start is never
   * more permissive than the code it replaced.
   */
  private houseLoad: HouseLoadState = initialHouseLoad();

  private shedIds = new Set<string>();
  private shedTimes = new Map<string, number>();
  /**
   * When a device poll last saw a SHED room OFF — i.e. the shed's `power_off`
   * having actually LANDED on the shadow. `reconcileObservedOn` reads it to tell
   * two shapes of "shed room reads ON" apart (#9268/#9270, 2026-08-07): an ON
   * *after* a confirmed off is an external hand (clear now + shield), while an
   * ON with no off ever observed is the stale echo of an off still in flight
   * (keep the shed inside the grace so confirm-or-resend re-sends it). Cleared
   * with the shed record itself (recordShed/clearShed) so a stamp cannot leak
   * from one shed cycle into the next.
   */
  private shedOffObservedAt = new Map<string, number>();
  /**
   * Rooms commanded (or reported) ON whose shadow has not confirmed yet →
   * when the send happened. While any entry is live the compressor may be
   * drawing amps the model does not know about, so house sampling stands down.
   */
  private pendingOn = new Map<string, number>();
  /** Rooms that gave a level to fund a peer's raise → when (see FUNDING_COOLDOWN_MS). */
  private fundingDemotedAt = new Map<string, number>();
  /** Rooms the REDUCER took a level from → when (see VICTIM_COOLDOWN_MS). */
  private reducedAt = new Map<string, number>();
  /** Shed rooms whose shadow said ON at boot → when first seen (see BOOT_SHED_CLEAR_GRACE_MS). */
  private bootShedOnSince = new Map<string, number>();
  /**
   * Per-room meter bar left by that room's OWN shed: the smoothed meter when the
   * shedding batch went out, less what the batch was priced to save, and when.
   *
   * The global `pendingCut` answers the same question for `PENDING_CUT_MS` and
   * is spent by absorption; this one is per-room and lives a full blame window,
   * because the TROUGH a shed digs outlives its credit. Live 07:19→07:20 today
   * a restore was admitted 31 s after the shed that caused it (R9, invariant 41).
   *
   * `credited` is the peer-load release valve for a BOUNCE-extended bar
   * (2026-08-07): while the bar outlives its clock (`barPersistMs`), a peer's
   * commanded or observed load removal since it was stamped shrinks the house the
   * bar describes — a house minus a 4 A room is not the house that bounced — so
   * that saving is subtracted at query time, priced by the same credit path the
   * collapse detector uses. 0 for an ordinary (non-bounce) bar, which expires at
   * the blame window untouched.
   */
  private shedBar = new Map<string, { amps: number; at: number; credited: number }>();
  /**
   * The ONE gated proactive shed in flight house-wide: the room we switched off
   * and the shed room its amps are reserved for (2026-08-06). Cleared when the
   * receiver comes back, on a source change, or at `SWAP_RESERVATION_MS`.
   */
  private swap: { donorId: string; receiverId: string; at: number } | null = null;
  /**
   * When the ladder last shipped an over-limit batch — the memory the
   * meter-level swap gates do not have (see `SWAP_QUIET_AFTER_OVER_MS`).
   */
  private lastOverLimitActAt: number | null = null;
  /** Last fan TRIM actually sent per device — the fan half of send dedupe. */
  private lastFanSent = new Map<string, { fan: number; at: number }>();
  /** Last shed actually sent per device — the power_off half of send dedupe. */
  private lastOffSentAt = new Map<string, number>();
  private rememberedLevel = new Map<string, number>();
  /**
   * The manual level intents and the fan exemption. All three live until the
   * room POWER-CYCLES (any off, a real changeover in either direction, a
   * collapse, the AC-circuit-dead latch, the beep-reset blackout fingerprint) or
   * its governing range slot changes (2026-09-05, user: "a manual set of the AC
   * level should be reset on the next power cycle or on the next automation
   * range-slot boundary"). Released through the ONE helper,
   * `releaseManualIntent`, so every edge logs and journals the same way; a grid
   * interlude no longer has special status.
   */
  private manualCap = new Map<string, number>();
  private manualTarget = new Map<string, number>();
  private fanExempt = new Set<string>();
  /**
   * The range slot each device was last seen governed by (`slotKey` on the tick
   * context). A CHANGE between two known keys is the automation boundary that
   * ends a pin; an unknown key (null) neither compares nor stores, so a one-tick
   * metric gap cannot release anything and a pin made while the regime is
   * unknown survives until a real boundary.
   */
  private lastSlotKey = new Map<string, string>();
  private rampUntil = new Map<string, number>();
  /**
   * Ramp baselines: house amps measured just before this AC's compressor
   * started, for every ramp we arm on either source. Distinct from
   * `startBaseline` on purpose — that one is the turn-on POLICY window
   * and gets cleared by an over-limit batch, a manual level or a source change,
   * while this one is pure physics accounting (see rampDebitAmps) and must
   * survive all of those: the un-metered load is still arriving regardless of
   * what policy decided.
   */
  private rampBaseline = new Map<string, number>();
  /**
   * Peak rise above `rampBaseline` seen since each live ramp armed, refreshed on
   * every ESP reading. The instantaneous rise is a whole-house delta, so a peer
   * reduction (or an AC turning off) masks it and re-charges a ramping room its
   * whole draw for the rest of its window — the 2026-07-27 fan stall. Cleared
   * wherever `rampBaseline` is: the two are only meaningful together.
   */
  private rampAbsorbed = new Map<string, number>();
  /**
   * Per-ramp stall clock for the early-release plateau test (2026-08-08): `at` is
   * when this ramp's absorption ratchet last grew by at least
   * `RAMP_SETTLED_EPSILON_AMPS` (`lastRampGrowthAt`), and `absorbed` is the
   * ratchet value at that stamp — the anchor the next growth is measured from, so
   * a noise-sized creep across many readings still reads as PLATEAUED while a
   * genuine cumulative climb re-stamps and keeps the window open. Armed at
   * `rearmRamp`; cleared wherever `rampAbsorbed` is.
   */
  private rampGrowth = new Map<string, { at: number; absorbed: number }>();
  /**
   * Ramps opened by a POWER EVENT (changeover, collapse recovery) that are still
   * under evidence review → when they armed, and when (if ever) they were first
   * held past their nominal window.
   *
   * Only these ramps can be extended: a power event power-cycles the compressor,
   * and the restart-protection delay that follows is physics the model cannot
   * see. An ordinary raise's jump debit keeps its plain TTL (invariant 12) —
   * nothing power-cycled there, so the amps really are on their way.
   */
  private powerEventRamp = new Map<string, { armedAt: number; heldSince: number | null }>();
  /**
   * When a power event of ANY kind was last seen: the BROAD classification clock
   * (changeover, collapse, dead circuit, ESP gap, frozen meter). It is the
   * leveler's copy of the window the collector's observed-off classifier reads,
   * which is deliberately generous, because near any of these a shadow may be
   * minutes stale and an un-commanded change is more likely the firmware than a
   * hand (hard rule 2). Stamped by `notePowerEvent`, which is also what tells the
   * collector, so the two sides can never disagree about when the last one was.
   * Read by the external level-jump guard (`POWER_EVENT_LEVEL_JUMP_GRACE_MS`).
   *
   * ⚠ It says NOTHING about the units having restarted: an ESP gap or a frozen
   * meter stamps it while the house never blinked (2026-08-31). Anything that
   * depends on a real restart reads `lastAcRestartAt` (house-wide restart kinds)
   * or `devicePowerCycleAt` (one unit's own fingerprint) instead.
   */
  private lastPowerEventAt = 0;
  /**
   * When a power event that actually RESTARTED the ACs was last seen
   * (`powerEventRestartsAcs` kinds only, 2026-09-05). Deliberately a second
   * clock: `lastPowerEventAt` is stamped by every routine CT02 blip, and gating
   * the funded-spend credit on that one would switch spending off most of the
   * day. House-wide by nature, because these events cut mains to every unit.
   */
  private lastAcRestartAt = 0;
  /**
   * When each device's OWN power cycle was last observed, from evidence only
   * that unit could give (the collector's beep-reset fingerprint). One room's
   * reboot must not suppress the level-jump armer, or gate the spend side of an
   * off, for its neighbours (2026-09-05).
   */
  private devicePowerCycleAt = new Map<string, number>();
  /**
   * Rooms a graded LONE off measured as drawing about their fan (R6): the level
   * it was observed at, and the line it was observed on. Retained until
   * confirmed compressor evidence — an absorbed ramp, a graded drop of a whole
   * compressor's worth — or a source change. The evidence is about a device AT
   * A LEVEL, so it says nothing once the room climbs above it.
   */
  private compressorOff = new Map<string, { level: number; source: PowerSource }>();
  /**
   * Entry-collapse state (2026-08-04). `entryCollapseSince` is when the
   * evidence first held without a break — a dwell, so a shadow that is merely
   * late cannot latch. `entryCollapseLatched` records that the latch on
   * `MeterState` is OURS: a fall-latched collapse, or the sensing safety cap
   * retiring one, must not be released by this machine. `recoveryAdmissionUntil`
   * marks the FLOORS window in which the returning rooms are admitted on the
   * envelope rather than on a meter that has seen no compressor yet.
   */
  private entryCollapseSince: number | null = null;
  private entryCollapseLatched = false;
  private recoveryAdmissionUntil = 0;
  /**
   * When the CURRENT source session began. The entry-collapse evidence is
   * anchored to this rather than to a shadow-report cadence: TCL modules report
   * on state change, not on a keepalive, so a healthy quiet room can sit silent
   * for 5.5 minutes and longer (measured 2026-08-04). "Nothing since the
   * changeover" is a statement about a known event; "nothing for N minutes" is
   * a bet on chatter that a working house loses. 0 = no anchor, no claim.
   */
  private sourceSince = 0;
  /** When we last saw one of our sends CONFIRM on each room's shadow. */
  private lastConfirmAt = new Map<string, number>();
  /**
   * When each room's current run of UNANSWERED sends began (cleared on any
   * confirm). Deliberately not the reconciler's per-level `sentAt`: that is a
   * resend-spacing clock, refreshed every `LEVEL_RESEND_SPACING_MS` by the
   * FLOORS re-assertion, so it can never age past 30 s however dead the device
   * is. This one measures what the entry-collapse evidence actually asks —
   * how long we have been talking to something that is not answering.
   */
  private unansweredSince = new Map<string, number>();
  /**
   * Level-RAISE commitments the meter has not shown yet, per device: the priced
   * jump, the house load when it was sent, and the peak rise since. Same shape
   * and same ratchet as the turn-on ramp pair above, but armed by a set_level
   * UP on gen — see AcView.unmeteredJumpAmps for why raises need their own.
   */
  private jumpDebit = new Map<string, { amps: number; baseline: number | null; absorbed: number; until: number }>();
  /**
   * The same accounting for a fan RESTORE, which spends amps nothing used to
   * charge: it emits one `set_fan`, reports `commandedCutAmps: 0`, arms no ramp
   * (a fan is not a compressor), and is `fanOnly` — so it does not even rewind
   * the calm clock. Both raises that tripped the gen on 2026-07-31 landed
   * within 17s of a fan restore, admitted against a meter that had not yet seen
   * it (17:29:32 Abdu 1→7 then 17:29:44 Abdullah L2→L3; 17:31:44 and 17:32:01
   * the same pair again). Kept in its own map because a device can carry a fan
   * restore and a level jump at once, and they are additive draws.
   */
  private fanDebit = new Map<string, { amps: number; baseline: number | null; absorbed: number; until: number }>();
  /** Turn-on start windows: house amps measured just before this AC came on. */
  private startBaseline = new Map<string, { amps: number; until: number }>();
  /**
   * Where each boosted room sits on its outdoor gradient (needs.ts
   * `boostZoneOf`). Kept per room because every boundary is hysteretic and a
   * stale outdoor reading holds the last zone — both need the previous value.
   */
  private boostZone = new Map<string, BoostZone>();
  /**
   * The LEARNED non-cooling hold per room (level-hold.ts): what this house has
   * observed about a level, against the outdoor temperature it observed it at.
   * Write-through to `ac_leveling_level_hold` — the whole point of a 6-hour
   * hold is that it survives the deploy that happens inside those six hours.
   */
  private levelHolds = new Map<string, LevelHold>();
  /** When each room's current uninterrupted satisfied stretch began (demote dwell). */
  private satisfiedSince = new Map<string, number>();
  /** Start of the current below-floor stretch, and the need it has yet to beat. */
  private subFloorSince = new Map<string, SubFloorWatch>();
  private prevPowerStates = new Map<string, boolean>();
  /**
   * When a HUMAN last turned each room on (bare power button, dashboard, remote,
   * or automation — any ON the leveler did not command). Shields it from being
   * traded away as a proactive-shed donor for `EXTERNAL_ON_DONOR_SHIELD_MS`
   * (invariant 42/57, 2026-08-06 #9224/#9228). Deliberately NOT cleared on a
   * source change: the human's intent survives a changeover, unlike the
   * victim/funding cooldowns, which are per-LINE physics (a compressor's
   * wind-down starts over when the line power-cycles; a person's choice does
   * not). Persistence across restarts is not required — a restart already loses
   * pins, and the shield is a comfort nicety, not a safety invariant.
   */
  private externalOnAt = new Map<string, number>();
  /**
   * When each shed room first sat refused ONLY by the supply-flicker margin
   * (invariant 58 follow-up, 2026-08-08). Stamped from the plan's `flickerRefused`
   * list and read back into `RaiseInput.flickerRefusedSince`, so a restore that
   * only ever fails on the flicker charge ages into a bare-ceiling admission
   * after `FLICKER_PATIENCE_MS`. Dropped the moment the room stops being
   * flicker-refused (it restored, it now fits, or it went over-limit), on a
   * restore, and on a source change — patience accrues only while the refusal is
   * unbroken. Not persisted across restarts (a comfort nicety, like the swap).
   */
  private flickerRefusedSince = new Map<string, number>();
  /**
   * When each device's off was last CREDITED (`creditRoomOff`). One physical off
   * can arrive twice — the REST tap credits immediately in `onUserPowerOff`,
   * which never updates `prevPowerStates`, so the device poll re-observes the
   * SAME off and would credit it again (a double meter credit AND a double
   * peer-bar subtraction). A repeat within `OFF_CREDIT_DEDUP_MS` is skipped;
   * cleared whenever the room is seen ON, so a genuine later off still credits.
   */
  private lastOffCreditAt = new Map<string, number>();
  /**
   * A dashboard off the route has told us about but the cloud has not accepted
   * yet, with the level it would free (2026-08-31). The tap must record intent
   * before the send, and `clearOnPowerOff` wipes the reconciler's level in the
   * same breath, so the price of the off is snapshotted here and promoted into a
   * real credit by `onUserPowerOffSent`. A send that throws simply leaves the
   * entry to expire: nothing was credited, so there is nothing to take back.
   */
  private pendingOffCredit = new Map<string, { level: number; at: number }>();
  private deviceNames = new Map<string, string>();
  /** Devices the collector reports as leveler-managed (opt-outs excluded). */
  private managedIds = new Set<string>();
  private deviceMaxLevel = new Map<string, number>();
  private armRampOnSourceChange = false;
  private freshlyOn: string[] = [];
  /**
   * Outstanding grade windows, oldest first. Was a single slot until 2026-07-25:
   * every new batch overwrote it, so on a busy generator episode NO batch was
   * ever graded — `ac_leveling_costs` still held its 2026-07-23 seeds after ~10
   * live restores, and surviving raise/restore attempts never reached
   * `noteSuccess`, which pinned the backoff ladder at its 15-min rung.
   */
  private pendingGrades: PendingGrade[] = [];
  /**
   * When the last executed batch ADDED / REMOVED metered load (fan steps
   * excluded — a ~0.1A trim must not suppress learning). Read at grade-arming
   * time to void a single-command window born while an earlier batch is still
   * settling its way (LEARN_SETTLE_UP_MS / LEARN_SETTLE_DOWN_MS).
   */
  private lastLoadAddAt = 0;
  private lastLoadDropAt = 0;
  /** Throttle for durable blocked-decision rows, keyed `deviceId|blockedBy`. */
  private lastBlockedJournalAt = new Map<string, number>();
  private lastPushAt = 0;
  private lastStatus: LevelingStatusV2 | null = null;
  private lastPruneAt = 0;
  /** First tick timestamp — house sampling holds off until inputs are warm. */
  private firstTickAt: number | null = null;
  /**
   * The outdoor temperature the last tick was handed (the same ≤10-min-fresh
   * feed `levelBoosts` reads), and when. Kept because the learned non-cooling
   * hold can be armed from a USER action — a manual raise off L1 — which
   * arrives on its own HTTP request with no weather in hand, and a hold with no
   * `T_obs` is a six-hour ban rather than a temperature bar.
   */
  private lastOutdoorC: number | null = null;
  private lastOutdoorAt = 0;
  private lastConfigReloadAt = 0;
  /** Controller flavor at the last reload — detects a live flip to acting v2. */
  private prevFlavor: ControllerFlavor | null = null;

  constructor(
    private pool: pg.Pool,
    private deps: LevelingDeps,
  ) {
    this.store = new LevelingStore(pool);
  }

  // ---------- lifecycle & config ----------

  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    await this.reloadConfig();
    await this.loadPersistedState();
    await this.store.seedCostsIfEmpty(Date.now());
    this.book = await this.store.loadCosts();
    this.loaded = true;
  }

  /**
   * (Re)load the write-through persisted state — shed set, fan holds, remembered
   * levels — from the DB, CLEARING the in-memory copies first. Called at boot,
   * and again when this instance becomes the acting controller (v1 may have
   * written these rows while it was acting and we only snapshot them once).
   */
  private async loadPersistedState(): Promise<{ sheds: number; holds: number; remembered: number; levelHolds: number }> {
    const shedRes = await this.pool.query("SELECT device_id, shed_at FROM ac_leveling_shed");
    this.shedIds = new Set<string>();
    this.shedTimes = new Map<string, number>();
    // In-memory only, and only meaningful for a live shed record: a resync
    // rebuilds the shed set from the DB, so any stamp from the old set is stale.
    this.shedOffObservedAt = new Map<string, number>();
    for (const row of shedRes?.rows ?? []) {
      this.shedIds.add(row.device_id);
      this.shedTimes.set(row.device_id, new Date(row.shed_at).getTime());
    }
    const holdRes = await this.pool.query("SELECT device_id, original_fan, last_set_fan, held_at FROM ac_leveling_fan_hold");
    let holds: FanHolds = {};
    for (const row of holdRes?.rows ?? []) {
      holds = {
        ...holds,
        [row.device_id]: {
          deviceId: row.device_id,
          originalFan: Number(row.original_fan),
          lastSetFan: Number(row.last_set_fan),
          heldAt: new Date(row.held_at).getTime(),
        },
      };
    }
    this.fanHolds = holds;
    this.rememberedLevel = new Map<string, number>();
    const remRes = await this.pool.query("SELECT device_id, level FROM ac_leveling_remembered_level");
    for (const row of remRes?.rows ?? []) this.rememberedLevel.set(row.device_id, Number(row.level));
    // The learned non-cooling holds. A deploy is exactly the event a 6-hour TTL
    // must not care about — the heat that produced the observation outlives our
    // release cadence by hours (2026-08-04).
    this.levelHolds = new Map<string, LevelHold>(
      Object.entries(await this.store.loadLevelHolds().catch(() => ({}))),
    );
    return {
      sheds: this.shedIds.size,
      holds: Object.keys(this.fanHolds).length,
      remembered: this.rememberedLevel.size,
      levelHolds: this.levelHolds.size,
    };
  }

  /**
   * Config strategy during the migration window: row id=1 is v1's (shared
   * limits/models/priority — v1's save path would drop unknown fields, so v2
   * never writes it); row id=2 holds the v2-only fields (controller flag,
   * resting buffer, calm gates, fan trim). Merged with id=2 winning. Re-read
   * periodically so v1 config saves and live flag flips take effect without a
   * restart.
   */
  private async reloadConfig(): Promise<void> {
    const res = await this.pool.query("SELECT id, config FROM ac_leveling_config WHERE id IN (1, 2)");
    const rows = res?.rows ?? [];
    const row1 = (rows.find((r) => Number(r.id) === 1)?.config as Record<string, unknown>) ?? {};
    const row2 = (rows.find((r) => Number(r.id) === 2)?.config as Record<string, unknown>) ?? {};
    this.rawConfig = { ...row1, ...row2 };
    const prevBudgetPoints = this.config.overLimitBudgetPoints;
    this.config = mergeLevelingConfigV2(this.rawConfig);
    this.lastConfigReloadAt = Date.now();
    // The leaky bucket is LIVE state, so a capacity change has to be carried
    // into it here: `updateConfig` ends in this method, so a PUT applies the
    // transition before it answers, and the periodic reload covers a direct SQL
    // edit. Spent debt is preserved (see applyBucketCapacity) rather than reset
    // to full, or changing the knob mid-overload would be a way to forgive an
    // episode the meter has not stopped objecting to.
    if (this.config.overLimitBudgetPoints !== prevBudgetPoints) {
      this.meterState = applyBucketCapacity(
        this.meterState,
        prevBudgetPoints,
        this.config.overLimitBudgetPoints,
      );
      // `getStatus()` serves the status the LAST TICK built, and the card polls
      // GET between ticks and divides one of these figures by the other. Left
      // alone, the seconds after a save would report the old capacity against a
      // bucket that has already moved: "over-limit 6/5 points".
      if (this.lastStatus != null) {
        this.lastStatus = {
          ...this.lastStatus,
          overLimitBudget: this.meterState.overLimitBudget,
          overLimitBudgetMax: this.config.overLimitBudgetPoints,
        };
      }
    }

    // Became the ACTING controller (v1/shadow → v2) without a restart: our
    // persisted book (sheds, fan holds, remembered levels) may be stale — v1
    // wrote those rows while it was acting and we only snapshot them at boot.
    // Re-sync from the DB and reload learned costs so v2 acts on reality, not a
    // startup snapshot. Flip via the API (this reload path): a direct-SQL flip
    // isn't noticed until a restart, because in "v1"/"shadow" v2 never ticks.
    if (this.loaded && this.prevFlavor != null && this.prevFlavor !== "v2" && this.config.controller === "v2") {
      const counts = await this.loadPersistedState();
      this.book = await this.store.loadCosts();
      log.info(
        `[leveler2] Became acting controller — resynced ${counts.sheds} shed(s), ${counts.holds} fan hold(s), ` +
          `${counts.remembered} remembered level(s), ${counts.levelHolds} learned level hold(s)`,
      );
    }
    this.prevFlavor = this.config.controller;
  }

  async getConfig(): Promise<Record<string, unknown>> {
    await this.ensureLoaded();
    // Serve the raw row merged over v2 defaults so both v1 and v2 clients see
    // their fields; the row is shared with v1 during the migration window.
    return { ...this.rawConfig, ...this.config };
  }

  /** Writes only the v2-owned fields (row id=2); shared fields stay on v1's row. */
  async updateConfig(cfg: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.ensureLoaded();
    const row2Res = await this.pool.query("SELECT config FROM ac_leveling_config WHERE id = 2");
    const row2 = { ...((row2Res?.rows?.[0]?.config as Record<string, unknown>) ?? {}) };
    for (const key of LEVELING_V2_CONFIG_KEYS) if (key in cfg) row2[key] = cfg[key];
    await this.pool.query(
      `INSERT INTO ac_leveling_config (id, config, updated_at) VALUES (2, $1, NOW())
       ON CONFLICT (id) DO UPDATE SET config = $1, updated_at = NOW()`,
      [JSON.stringify(row2)],
    );
    // Everything else belongs to row 1 — amp models, limits, margins, priority,
    // level boosts, raise pacing. It is written HERE because `collector.
    // leveling()` routes every config save to whichever controller is acting,
    // and since the 2026-07-24 cutover that is this one: v1's updateConfig (the
    // only writer row 1 had) has not run since. Every save from the dashboard
    // returned 200 and changed nothing — found 2026-08-03 trying to correct
    // Abdullah's gen amp model, with row 1's updated_at still reading the
    // cutover date.
    //
    // MERGED over the stored row, not replaced: v1 replaces row 1 wholesale
    // from its own defaults, which would drop any field this build does not
    // know about. A save that silently loses a field is the bug being fixed.
    const row1Entries = Object.entries(cfg).filter(([key]) => !isLevelingV2Key(key));
    if (row1Entries.length > 0) {
      const row1Res = await this.pool.query("SELECT config FROM ac_leveling_config WHERE id = 1");
      const row1 = {
        ...((row1Res?.rows?.[0]?.config as Record<string, unknown>) ?? {}),
        ...Object.fromEntries(row1Entries),
      };
      await this.pool.query(
        `INSERT INTO ac_leveling_config (id, config, updated_at) VALUES (1, $1, NOW())
         ON CONFLICT (id) DO UPDATE SET config = $1, updated_at = NOW()`,
        [JSON.stringify(row1)],
      );
    }
    // v2 deliberately does NOT clear learned costs on config save (they live in
    // the DB now; explicit reset via resetLearnedCosts()).
    await this.reloadConfig();
    return this.getConfig();
  }

  controllerFlavor(): "v1" | "shadow" | "v2" {
    return this.config.controller;
  }

  async resetLearnedCosts(): Promise<void> {
    await this.store.resetCosts();
    this.book = {};
  }

  isEnabled(): boolean {
    return this.config.enabled && (this.config.controller === "v2" || this.config.controller === "shadow");
  }

  /** True when this instance actually sends commands (not shadow). */
  private acts(): boolean {
    return this.config.controller === "v2";
  }

  getComfortTarget(): number {
    return this.config.comfortTargetC;
  }

  /**
   * This room's need corrections (thermometer calibration, own-setpoint target),
   * or null when the room has none. Read by `collector.computeAcNeed` — the
   * need itself is computed there, not here.
   */
  getNeedOverride(deviceId: string): AcNeedOverride | null {
    return this.config.needOverrides[deviceId] ?? null;
  }

  getLimits(): { gridLimitAmps: number; genLimitAmps: number; marginAmps: number } {
    return {
      gridLimitAmps: this.config.gridLimitAmps,
      genLimitAmps: this.config.genLimitAmps,
      marginAmps: this.config.marginAmps,
    };
  }

  // ---------- shed bookkeeping (v1-compatible contracts) ----------

  isShed(deviceId: string): boolean {
    return this.shedIds.has(deviceId);
  }

  async clearShed(deviceId: string, reason: string): Promise<void> {
    if (!this.shedIds.has(deviceId)) return;
    this.shedIds.delete(deviceId);
    this.shedTimes.delete(deviceId);
    // The off-observed stamp is only meaningful for a LIVE shed record — drop it
    // so it cannot survive into the next shed cycle (#9268/#9270).
    this.shedOffObservedAt.delete(deviceId);
    await this.pool.query("DELETE FROM ac_leveling_shed WHERE device_id = $1", [deviceId]);
    log.info(`[leveler2] Cleared shed for AC ${this.deviceNames.get(deviceId) ?? deviceId} (${reason})`);
  }

  /**
   * Drop house samples that modeled this room as OFF while it was physically
   * drawing, and stop treating its ON as pending. `since` is the send time when
   * we know it (our own restore, a dashboard tap) and the whole window when we
   * do not (a room discovered already on — nothing tells us when it started).
   */
  /**
   * Is this device one the leveler manages? Unknown devices answer `true` only
   * until the first tick populates the set — the hooks that consult this are
   * user-driven and cannot fire before the collector has seen the device.
   */
  private isManaged(deviceId: string): boolean {
    return this.managedIds.size === 0 || this.managedIds.has(deviceId);
  }

  private voidPhantomHouse(deviceId: string, now: number): void {
    const sentAt = this.pendingOn.get(deviceId);
    this.pendingOn.delete(deviceId);
    const source = meterView(this.meterState, now).source;
    if (source === "none") return;
    const before = this.houseLoad[source]?.samples.length ?? 0;
    this.houseLoad = voidSamples(this.houseLoad, source, {
      excludeDeviceId: deviceId,
      since: sentAt ?? now - EXTERNAL_ON_VOID_MS,
    });
    const dropped = before - (this.houseLoad[source]?.samples.length ?? 0);
    if (dropped > 0) {
      log.info(
        `[leveler2] Voided ${dropped} ${source} house sample(s) taken while ` +
          `${this.deviceNames.get(deviceId) ?? deviceId} was already drawing`,
      );
    }
  }

  private async recordShed(deviceId: string, reason: string): Promise<void> {
    this.shedIds.add(deviceId);
    this.shedTimes.set(deviceId, Date.now());
    // A fresh shed has, by definition, not been observed OFF yet — clear any
    // stamp a prior cycle left so this shed's grace judgment starts clean.
    this.shedOffObservedAt.delete(deviceId);
    await this.pool.query(
      `INSERT INTO ac_leveling_shed (device_id, shed_at, reason) VALUES ($1, NOW(), $2)
       ON CONFLICT (device_id) DO UPDATE SET shed_at = NOW(), reason = $2`,
      [deviceId, reason],
    );
  }

  /**
   * Is one of OUR restores in flight for this device? A restore ships a
   * `power_on` and books a `noteAttempt(… "restore" …)`, and per invariant 4 the
   * shed record is kept until that ON confirms on the shadow. So between send and
   * confirm the room is still `shed`, its off may already have been observed, and
   * the ON echo of our own restore is otherwise shape-indistinguishable from a
   * hand re-enabling the room. Both the device-poll `reconcileObservedOn` and the
   * tick's `!wasShed` fallback read this so that echo is graded a restore
   * confirm, never an external hand (2026-08-08). Keyed on the SAME window
   * `projectedExtraAmps` uses to re-price a just-restored room
   * (`GRADE_TURN_ON_MS`), extracted here so the two edges cannot drift — this
   * file has paid for two-sites-one-quantity drift before.
   */
  private restoreInFlight(deviceId: string, now: number): boolean {
    return attemptedWithin(this.pacing, deviceId, "restore", GRADE_TURN_ON_MS, now);
  }

  async reconcileObservedOn(deviceId: string): Promise<void> {
    // A live poll found this room ON. Whatever we thought, it has been drawing
    // for an unknown stretch — void the house samples that modeled it off.
    // A room whose shadow lagged is exactly the case that poisons the residual,
    // and it does not have to have been shed to do it. But it DOES have to be
    // one of ours: an unmanaged AC appears in no sample's running set, so
    // voiding for it drops every sample in the window — repeatedly, on a hot
    // path — and `houseLoadAmps` collapses to 0, which is the over-permissive
    // direction house-load.ts exists to prevent.
    if (!this.isManaged(deviceId)) return;
    const now = Date.now();
    this.voidPhantomHouse(deviceId, now);
    if (!this.shedIds.has(deviceId)) return;
    // OUR OWN restore, still in flight: per invariant 4 the shed is not cleared
    // until the ON confirms, so a restore's own ON echo arrives while the room is
    // still shed — and often AFTER its off was observed, which the branch below
    // would read as an external hand. This device-poll reconcile runs BEFORE the
    // tick on the very same ON reading, so without this it stole the tick's
    // `restore_confirmed` handling: it reset the bounce count and stamped a bogus
    // swap-donor shield on every room the leveler restored (2026-08-08). Grade it
    // exactly as the tick's structural-flip branch does — clear the shed, no
    // external stamp — keyed on the SAME signal the tick uses.
    if (this.restoreInFlight(deviceId, now)) {
      await this.clearShed(deviceId, "restore_confirmed");
      return;
    }
    const shedAt = this.shedTimes.get(deviceId);
    const offObservedAt = this.shedOffObservedAt.get(deviceId);
    // Did the shed's power_off actually LAND before this ON? A poll that saw the
    // room OFF since we shed it means the off propagated and the room was THEN
    // switched back on — a remote/wall/TCL-app path that never touches our REST
    // route. That is unambiguous external-hand evidence: clear the shed with no
    // grace at all, and shield the room from being traded away as a swap donor
    // (a remote re-enable of a shed room is exactly the #9224/#9228 class the
    // shield exists for — invariant 42/57).
    if (offObservedAt != null && (shedAt == null || offObservedAt >= shedAt)) {
      this.noteExternalOn(deviceId, now);
      await this.clearShed(deviceId, "observed_on_after_off");
      return;
    }
    // The off was NEVER observed. Inside the grace this ON is presumed the stale
    // echo of a power_off still in flight (#9268/#9270 — a naive widen alone is
    // wrong: with no off-observed distinction a human re-enabling a shed room by
    // remote 20s after the shed would be presumed a stale echo, and the 30s
    // off-resend would switch it back off against his explicit choice — the
    // #9224/#9228 class): keep the shed intact so confirm-or-resend re-sends the
    // off and the `SHED_RESEND_SPACING_MS` dedupe stays armed.
    if (shedAt != null && now - shedAt < SHED_CLEAR_GRACE_MS) return;
    // Past the grace with no off ever seen: treat as external/already-cleared —
    // clear the shed, and shield too, because any reconcile-path clear is
    // external evidence and over-shielding a comfort tool costs nothing. (Our
    // OWN restore confirms through the tick OFF→ON "restore_confirmed" branch,
    // which deliberately does not shield — its test must stay green.)
    this.noteExternalOn(deviceId, now);
    await this.clearShed(deviceId, "observed_on");
  }

  hasFanHold(deviceId: string): boolean {
    return this.fanHolds[deviceId] != null;
  }

  /**
   * Introspection/test hook: is `deviceId` still inside its compressor ramp
   * WINDOW (the `rampUntil` that `AcView.ramping` folds `device.power` into)?
   * Reads the exact state the early-release path (2026-08-08) deletes, so a test
   * can watch amp evidence retire the window before its 240s clock.
   */
  rampWindowOpen(deviceId: string): boolean {
    return (this.rampUntil.get(deviceId) ?? 0) > Date.now();
  }

  async rememberStableLevel(deviceId: string): Promise<void> {
    const level = this.recon[deviceId]?.confirmedLevel ?? null;
    if (level == null || level < 2) return;
    this.rememberedLevel.set(deviceId, level);
    await this.pool.query(
      `INSERT INTO ac_leveling_remembered_level (device_id, level, remembered_at) VALUES ($1, $2, NOW())
       ON CONFLICT (device_id) DO UPDATE SET level = $2, remembered_at = NOW()`,
      [deviceId, level],
    );
    log.info(`[leveler2] Remembered stable level L${level} for ${this.deviceNames.get(deviceId) ?? deviceId}`);
  }

  // ---------- power ingest ----------

  onPowerReading(data: { current_1: number; current_2: number }): void {
    if (!this.loaded || !this.isEnabled()) return;
    const now = Date.now();
    const prevSource = this.meterState.source;
    const { state, events } = ingestReading(
      this.meterState,
      { gridAmps: data.current_1, genAmps: data.current_2 },
      this.config,
      now,
    );
    this.meterState = state;
    for (const event of events) {
      this.modeState = applyMeterEvent(this.modeState, event, now);
      switch (event.kind) {
        case "source_changed": {
          this.pacing = resetPacing(this.pacing, event.to);
          this.recon = clearOnSourceChange(this.recon);
          this.pendingGrades = [];
          // Baselines are amps on the OLD source — worthless on the new one,
          // and the entry mode (FLOORS / GRID_FULL) owns the transition now.
          // (armRampOnSourceChange re-arms every running AC a tick later, which
          // re-anchors the ramp baselines against the new line's first readings.)
          this.startBaseline.clear();
          this.rampBaseline.clear();
          this.rampAbsorbed.clear();
          this.rampGrowth.clear();
          // A shed bar is a claim about one line's meter (R9) — 15A of gen and
          // 30A of grid are not the same number, and carrying it across would
          // strand a room off on the roomy source.
          this.shedBar.clear();
          // …and so is compressor-off evidence (R6): the amp models, the
          // voltage and the compressor's willingness to start are all per-line.
          this.compressorOff.clear();
          // Dead-window holds are about ramps on the line we just left; the
          // entry re-arms them a tick later against the new line's readings.
          this.powerEventRamp.clear();
          // …and so is the entry-collapse evidence: it is a claim about one
          // line's breaker. (The DERATE deliberately survives — it carries its
          // own source tag, so a gen→grid→gen bounce cannot launder it.)
          this.entryCollapseSince = null;
          this.entryCollapseLatched = false;
          // R11b (2026-08-04 17:22, the first changeover that ran with the rest
          // of today's protections). A NORMAL changeover power-cycles every
          // compressor exactly as a collapse recovery does — same physics, same
          // surge — so the floor set has to be admitted against the ENVELOPE on
          // every gen entry, not only after a latched collapse. Live: entry at
          // 17:22:57 with floors {L2,L1,L1} = 10.4A modeled plus ~4.5–5A of
          // carried house is over a 15A generator before the first reading
          // exists, and at 17:27:18 the simultaneous restart peaked the line at
          // 16.5A severe with the hottest room's level the only rung left.
          //
          // Free when the arithmetic fits: the admission phase only sheds rooms
          // that Σ floor models + house cannot carry, so a changeover with room
          // to spare journals "floors" and commands exactly what it did before.
          // Grid is untouched — `recoveryAdmission` is gen-only by construction,
          // and grid enters FULL by directive.
          this.recoveryAdmissionUntil = event.to === "gen" ? now + FLOORS_MAX_MS : 0;
          // The anchor every "since entry" test is measured against.
          this.sourceSince = now;
          this.lastConfirmAt.clear();
          this.unansweredSince.clear();
          // Both cooldowns are per-line physics — a wind-down on the source we
          // just left says nothing about this one, and holding them across a
          // changeover strands a room through the entry window that is supposed
          // to re-establish levels. (`fundingDemotedAt` was never cleared at
          // all; found reviewing the 2026-08-02 funding-cycle fix.)
          this.fundingDemotedAt.clear();
          this.reducedAt.clear();
          // …and so is a trade in flight: it reserved amps on a budget that no
          // longer exists, and the entry mode (FLOORS / GRID_FULL) re-decides
          // who runs from scratch. The donor keeps its ordinary shed row.
          this.swap = null;
          // …and the flicker-patience anchors: they were measured against a
          // supply that no longer exists, and the entry mode re-admits every room
          // from scratch (invariant 58 follow-up).
          this.flickerRefusedSince.clear();
          if (prevSource !== "none" && event.to !== "none") this.armRampOnSourceChange = true;
          log.info(`[leveler2] Power source changed → ${event.to}`);
          // The manual pins are released INSIDE `notePowerEvent`, for every
          // restart kind and in both directions (2026-09-05, superseding the
          // grid-only clear this block used to do): a grid→gen changeover
          // power-cycles the units exactly as gen→grid does, and the firmware
          // comes back at the level it was last commanded to. The releases are
          // journalled on THIS row, which the changeover writes anyway, rather
          // than as a second row a millisecond later.
          const released = this.notePowerEvent(`source ${event.from} → ${event.to}`, now, { deferJournal: true });
          // Journal it even though no command ships here. A changeover whose
          // entry batch happens to be a no-op is otherwise INVISIBLE: the
          // 2026-08-02 22:28Z gen→grid left a 3.8-hour hole in the only durable
          // record there is, and reading that night meant guessing which side
          // of the house the meter was on.
          void this.store
            .insertJournal({
              at: now,
              source: event.to,
              mode: deriveMode(this.modeState, now),
              severity: null,
              reason: "source_change",
              requiredAmps: null,
              preAmps: meterView(this.meterState, now).smoothedAmps,
              commands: [],
              decisions: [
                {
                  at: now,
                  action: "source change",
                  detail: `${event.from} → ${event.to}, limit ${effectiveLimit(
                    this.config,
                    event.to === "none" ? "gen" : event.to,
                    derateFor(this.meterState, event.to, now),
                  ).toFixed(1)}A`,
                },
                ...released,
              ],
              expectedDelta: null,
              executed: this.acts(),
            })
            .catch(() => undefined);
          break;
        }
        case "collapse": {
          const derated =
            event.source !== "none"
              ? effectiveLimit(this.config, event.source, this.meterState.derate?.amps ?? 0)
              : null;
          log.warn(
            `[leveler2] Power collapse ${event.fromAmps.toFixed(1)}A → ${event.toAmps.toFixed(1)}A on ${event.source} — probable trip/blackout; commands frozen until recovery` +
              (derated != null ? `; ${event.source} limit derated to ${derated.toFixed(1)}A while it cools` : ""),
          );
          this.notePowerEvent(`power collapse on ${event.source}`, now);
          if (derated != null && (this.meterState.derate?.amps ?? 0) > 0) {
            void this.pushNotice(
              `${event.source === "gen" ? "Generator" : "Grid"} tripped at ${event.fromAmps.toFixed(1)}A — ` +
                `holding the AC budget at ${derated.toFixed(1)}A while the breaker cools.`,
              true,
            );
          }
          break;
        }
        case "collapse_suppressed":
          // Not a trip: the fall is the shed we sent finally reaching the meter.
          // Logged (not pushed) because nothing is wrong — but it is the one
          // trace that explains why a trip-shaped drop did NOT freeze the house.
          log.info(
            `[leveler2] ${event.fromAmps.toFixed(1)}A → ${event.toAmps.toFixed(1)}A on ${event.source} ` +
              `explained by our own cut (${event.creditAmps.toFixed(1)}A commanded off, not yet metered) — no collapse latched`,
          );
          break;
        case "collapse_recovered":
          // Compressors restarted with the line — re-arm the ramp windows. A
          // power event, so these windows close on evidence, not on the clock:
          // restart protection outlasts AC_RAMP_MS (2026-08-04).
          this.rearmRamp(
            [...this.prevPowerStates.entries()].filter(([, on]) => on).map(([id]) => id),
            { powerEvent: true },
          );
          log.info(`[leveler2] Power collapse recovered on ${event.source} — ramps re-armed`);
          break;
        case "esp_gap":
          this.notePowerEvent(`ESP gap ${Math.round(event.gapMs / 1000)}s`, now);
          break;
        case "strain_derate": {
          // Not a trip: nothing is latched, nothing is frozen, no push. The
          // generator browned out while we rode near its ceiling, so the
          // ceiling comes down and the ordinary ladder respects it. Journaled
          // because a limit that shrinks with no visible cause is the kind of
          // thing that costs a forensic session to work out afterwards.
          const derated =
            event.source !== "none"
              ? effectiveLimit(this.config, event.source, this.meterState.derate?.amps ?? 0) - event.amps
              : null;
          log.warn(
            `[leveler2] Generator strain on ${event.source}: power gap ${Math.round(event.gapMs / 1000)}s ` +
              `with the mean at ${event.preGapAmps.toFixed(1)}A — holding ${event.amps.toFixed(1)}A back` +
              (derated != null ? `, limit now ${derated.toFixed(1)}A` : ""),
          );
          void this.store
            .insertJournal({
              at: now,
              source: event.source,
              mode: deriveMode(this.modeState, now),
              severity: null,
              reason: "strain_derate",
              requiredAmps: null,
              preAmps: event.preGapAmps,
              commands: [],
              decisions: [
                {
                  at: now,
                  action: `strain derate ${event.amps.toFixed(1)}A`,
                  detail:
                    `second power gap inside the window (${Math.round(event.gapMs / 1000)}s) with the ` +
                    `pre-gap mean at ${event.preGapAmps.toFixed(1)}A — the line is browning out under this load`,
                },
              ],
              expectedDelta: null,
              executed: this.acts(),
            })
            .catch(() => undefined);
          break;
        }
        case "meter_frozen":
          // 2026-07-23: the ESP hung showing ~14.8A for 17.5 min. A frozen
          // value is not evidence — sensing already blocks calm (no raises);
          // tell the user loudly because automation is effectively suspended.
          log.warn(
            `[leveler2] Power meter FROZEN — no micro-change for ${Math.round(event.frozenForMs / 1000)}s ` +
              `(stuck at ${event.amps.toFixed(2)}A). Raises suspended until the reading moves.`,
          );
          this.notePowerEvent("meter frozen", now);
          void this.pushNotice(
            `Power meter frozen at ${event.amps.toFixed(1)}A — readings unchanged for ` +
              `${Math.round(event.frozenForMs / 60_000)} min. AC raises suspended; check the ESP monitor.`,
            true,
          );
          break;
        case "meter_unfrozen":
          log.info(
            `[leveler2] Power meter recovered after ${Math.round(event.frozenForMs / 1000)}s frozen — readings live again`,
          );
          break;
        case "bucket_empty":
          this.deps.onUrgentLevelingNeeded?.();
          break;
      }
    }
    this.noteRampAbsorption(now);
  }

  /**
   * Credit a room's whole draw against the collapse detector when it goes off
   * by a hand that is not the reducer's.
   *
   * The collapse floor is relative to the mean the line was carrying
   * (POWER_COLLAPSE_FLOOR_FRACTION), because a breaker trip leaves the HOUSE
   * drawing and the house is not under 5A. That makes "the biggest room was
   * switched off" and "the AC circuit died" the same shape on the meter — the
   * only thing that separates them is whether we know about the off. So every
   * off we can know about is priced here, model-valued and one-way, exactly
   * like a reducing batch (invariant 11).
   *
   * Our OWN sheds are excluded: `executeAndJournal` already credits them via
   * `Plan.commandedCutAmps`, and crediting twice would inflate the allowance
   * enough to launder a genuine trip.
   */
  private creditRoomOff(
    deviceId: string,
    observedLevel: number | null,
    now: number,
    /** The demand side always credits; the SPEND side is the caller's call (2026-09-05). */
    opts: { spendable?: boolean } = {},
  ): boolean {
    const source = this.meterState.source;
    if (source === "none" || this.shedIds.has(deviceId)) return false;
    // The same physical off arrives twice — the REST tap credits here, then the
    // device poll re-observes it (`onUserPowerOff` never updates
    // `prevPowerStates`). Skip a repeat within the window; the stamp is cleared
    // whenever the room is seen ON, so a genuine off→on→off still credits twice.
    const lastAt = this.lastOffCreditAt.get(deviceId);
    if (lastAt != null && now - lastAt < OFF_CREDIT_DEDUP_MS) return false;
    const from = this.recon[deviceId]?.confirmedLevel ?? observedLevel;
    if (from == null || from <= 0) return false;
    const amps = modelCutAmps(
      this.config,
      deviceId,
      source,
      from,
      null,
      this.deviceMaxLevel.get(deviceId) ?? 3,
    );
    if (amps > 0) {
      // SPENDABLE: a room switched off by a hand that is not the reducer's frees
      // budget the limit never asked for, so a waiting room may be admitted
      // against it before the meter shows the fall (2026-08-31). The one caller
      // that says otherwise is an observed off inside the restart window, where
      // the "hand" is a blackout and the room is coming back (2026-09-05).
      this.meterState = noteCommandedCut(this.meterState, amps, now, { spendable: opts.spendable !== false });
      // An OBSERVED off is also a peer removal for any bounce-extended bar (the
      // release valve, invariant 54): the house another room bounced in just
      // lost this room, priced by the same figure the meter credit used.
      this.creditPeerShedBars(amps, new Set([deviceId]), now);
      this.lastOffCreditAt.set(deviceId, now);
      return true;
    }
    return false;
  }

  /**
   * Budget just came free, so evaluate NOW rather than at the next loop tick
   * (2026-08-31, user: "when there is a budget because of another AC off or level
   * down, it should act instantly based on prediction to turn on an offed AC or
   * level it (or its fan) up").
   *
   * The same dep the drained over-limit bucket fires, and the same collector-side
   * protection applies: `runLevelingCheck` serializes concurrent passes and drops
   * a re-run queued inside `LEVELING_RERUN_MIN_MS` (2.5 s), so a burst of offs
   * costs one extra evaluation, not a storm, and the evaluation it triggers is
   * an ORDINARY one, gated by every rule the scheduled tick is gated by. Called
   * ONLY where load leaves the line: a raise, a restore or a fan restore frees
   * nothing and must never shorten its own wait.
   */
  private noteBudgetFreed(what: string): void {
    log.info(`[leveler2] Budget freed (${what}): evaluating now instead of waiting for the next tick`);
    this.deps.onUrgentLevelingNeeded?.();
  }

  /**
   * Stamp an external ON (the swap donor shield, invariant 42/57) and end this
   * room's restore bounce episode (`clearBounces`, 2026-08-07) — a human/blink
   * put it back, so a future unrelated shed must not inherit a compounded trough
   * bar. Also clears the off-credit dedup stamp: the room being ON is exactly the
   * "seen ON in between" that lets a genuine later off credit again. Called at
   * every external-ON stamp point, NEVER on our own `restore_confirmed`.
   */
  private noteExternalOn(deviceId: string, now: number): void {
    this.externalOnAt.set(deviceId, now);
    this.pacing = clearBounces(this.pacing, deviceId);
    this.lastOffCreditAt.delete(deviceId);
    // The room is ON: an off whose send we are still waiting on is moot, and
    // promoting it later would credit a fall that is not going to happen.
    this.pendingOffCredit.delete(deviceId);
  }

  // ---------- user hooks (manual always wins) ----------

  async onUserPowerOff(deviceId: string): Promise<void> {
    // Snapshot the level this off would free BEFORE `clearOnPowerOff` forgets
    // it, but do NOT credit yet: this hook runs before the cloud send (intent
    // has to be established first, or a fast shadow poll turns the unit back
    // on), and a send that then throws frees nothing. `onUserPowerOffSent`
    // promotes this snapshot into a credit once the publish is accepted.
    //
    // Strictly safer than what came before this feature: the demand-side credit
    // used to arm at the tap too, so a failed send left the reducer discounting
    // a saving that was never coming for up to `PENDING_CUT_MS`.
    const chargedLevel = this.recon[deviceId]?.confirmedLevel ?? null;
    if (chargedLevel != null && chargedLevel > 0) {
      this.pendingOffCredit.set(deviceId, { level: chargedLevel, at: Date.now() });
    }
    // An ON that never confirmed is now moot. Without this, tapping a room on
    // and straight back off left the entry live until its 25-minute TTL — and
    // the guard is GLOBAL, so one such tap stood the whole house's load
    // sampling down for that long, ageing every sample out of the window and
    // collapsing the envelope's house term to zero.
    this.pendingOn.delete(deviceId);
    this.startBaseline.delete(deviceId);
    this.rememberedLevel.delete(deviceId);
    await this.pool.query("DELETE FROM ac_leveling_remembered_level WHERE device_id = $1", [deviceId]);
    this.recon = clearOnPowerOff(this.recon, deviceId);
    this.manualCap.delete(deviceId);
    this.manualTarget.delete(deviceId);
    await this.releaseHold(deviceId, "user_power_off");
    // The collector converts shed → manual-off lock before clearing; mirror v1:
    await this.clearShed(deviceId, "user_power_off");
    // Fires immediately on the UI off (before the shadow flips) — reset calm so
    // the falling meter settles before any raise, same as the structural-off
    // branch in tick(). Lets a pending shed restore claim the freed headroom.
    this.meterState = resetCalm(this.meterState);
  }

  /**
   * The cloud ACCEPTED the off. Promote the snapshot the tap took into a real
   * credit and evaluate on the spot (2026-08-31).
   *
   * Called from the route immediately after `sendControlVerified` resolves,
   * which is the publish-acceptance point: the shadow verify loop that follows
   * is fire-and-forget, so hooking here keeps the whole latency win (a waiting
   * room is admitted against these amps on the next evaluation, not ~30-45 s
   * later) while nothing is ever credited for a send that failed.
   *
   * A send that succeeds but never reaches this hook is not lost either: the
   * device poll observes the OFF shadow and credits it through the same
   * `creditRoomOff`, deduped by `OFF_CREDIT_DEDUP_MS`.
   */
  onUserPowerOffSent(deviceId: string): void {
    const now = Date.now();
    const snapshot = this.pendingOffCredit.get(deviceId);
    this.pendingOffCredit.delete(deviceId);
    // Nothing to promote, or so old that the meter has long since shown whatever
    // fall there was (`PENDING_CUT_MS` is the credit's own life).
    if (snapshot == null || now - snapshot.at > PENDING_CUT_MS) return;
    // The snapshot IS the observed level here: `clearOnPowerOff` has already
    // wiped the reconciler's copy, and `creditRoomOff` falls back to it.
    if (!this.creditRoomOff(deviceId, snapshot.level, now)) return;
    this.noteBudgetFreed(`${this.deviceNames.get(deviceId) ?? deviceId} switched off from the dashboard`);
  }

  async onUserPowerOn(deviceId: string): Promise<void> {
    if (!this.isManaged(deviceId)) return;
    // He put the room back himself. Our own shed's bar has nothing left to
    // protect (R9) — the room is on, and the next thing to judge is the meter.
    this.shedBar.delete(deviceId);
    await this.clearShed(deviceId, "user_power_on");
    this.rearmRamp([deviceId]);
    // Fires before the shadow flips — the meter here is still the pre-start
    // house load, the exact anchor the grid full start needs.
    const now = Date.now();
    this.noteTurnOn(deviceId, now);
    // The tap IS the earliest moment this room can be drawing, so nothing
    // sampled before it is contaminated — register the pending ON (which stands
    // house sampling down until the shadow confirms) but void nothing.
    this.pendingOn.set(deviceId, now);
    // Load arriving that our own command list will never show (see tick()).
    this.lastLoadAddAt = now;
    // He put the room on himself — the comfort swap may not trade it away for
    // the shield window (invariant 42/57, 2026-08-06 #9224/#9228), and his ON
    // ends any restore bounce episode (2026-08-07).
    this.noteExternalOn(deviceId, now);
  }

  async onUserFanChange(deviceId: string): Promise<void> {
    this.fanExempt.add(deviceId);
    await this.releaseHold(deviceId, "user_fan_change");
  }

  /**
   * A hand-set level BELOW where the firmware is charged for frees budget, so it
   * is credited exactly like an off (2026-08-31, user: "when there is a budget
   * because of another AC off or level down, it should act instantly based on
   * prediction"). Same mechanism, same pricing, one credit path (invariant 11):
   * `noteCommandedCut` at the MODEL steady delta between the two levels.
   *
   * The FROM level is the LOWEST level already COMMITTED: the confirmed shadow,
   * or any lower level we sent and have not seen confirm (never `pendingLevel`,
   * invariant 7: one slot, overwritten by every send).
   *
   * ⚠ Deliberately NOT the envelope's worst case. "Charge the peer at the highest
   * level it might be at" is right for a GUARD, and wrong here in the laundering
   * direction: confirmed L3 with our own demote to L2 still in flight, then a
   * hand pin to L1, would credit the whole model(3→1) on top of the model(3→2)
   * that demote batch already credited through `Plan.commandedCutAmps`, i.e. the same
   * fall priced twice, which is exactly what invariant 31 warns inflates the
   * allowance enough to launder a real collapse (and, since 2026-08-31, over-funds
   * a spender on top). From the lowest committed level the two add up to the truth:
   * (3→2) from the batch plus (2→1) from the pin. Under-crediting when the
   * firmware might still be sitting higher is the correct direction: it only
   * makes a spender wait.
   *
   * Three guards:
   *  - Only a REDUCTION. An increase frees nothing (the caller only reaches here
   *    on `isReduction`), and a level 0 (unrestricted) shadow is priced as the top
   *    level by `steadyDraw`, so pinning down from it is a real cut.
   *  - Not while OUR OWN demote to that level or lower is still in flight: that
   *    batch already armed the whole of this fall, and a repeat tap of the same
   *    level would otherwise credit it a second time (the first tap is in
   *    `sentAt`).
   *  - No later OBSERVATION path re-credits it: the device poll credits an OFF
   *    and nothing else, and an observed LEVEL change arms no credit at all,
   *    which is what makes this the single arming point for a manual level-down.
   */
  private creditManualLevelDown(
    deviceId: string,
    confirmed: number,
    target: number,
    /** Levels we sent and have not seen confirm, read BEFORE `clearMarksOnManual`
     *  wiped them. The manual path clears its own marks, so this is the only
     *  place the in-flight picture still exists. */
    unconfirmed: number[],
    now: number,
  ): void {
    const source = this.meterState.source;
    if (source === "none" || this.shedIds.has(deviceId)) return;
    const maxLevel = this.deviceMaxLevel.get(deviceId) ?? 3;
    // Our own demote to this level (or below) is already travelling: its credit
    // armed when that batch shipped.
    if (unconfirmed.some((l) => l > 0 && l <= target)) return;
    // The lowest level already committed (see above). A level-0 shadow means
    // UNRESTRICTED, which `steadyDraw` prices as the top level, so it is the
    // highest committed figure there is, never a floor for this minimum. Our own
    // sends are always ≥ 1 (`clampGeneratorMode`), so only the shadow can be 0.
    const from = Math.min(confirmed <= 0 ? maxLevel : confirmed, ...unconfirmed.filter((l) => l > 0));
    if (from <= target) return;
    const amps = modelCutAmps(this.config, deviceId, source, from, target, maxLevel);
    if (!(amps > 0)) return;
    // SPENDABLE, exactly like an off: the user handed these amps back and the
    // limit never asked for them.
    this.meterState = noteCommandedCut(this.meterState, amps, now, { spendable: true });
    // …and the peer-removal half, exactly as an off does it (invariant 54's
    // release valve): a room drawing less shrinks the house every bounce-extended
    // bar describes, priced by the same figure the meter credit used.
    this.creditPeerShedBars(amps, new Set([deviceId]), now);
    const name = this.deviceNames.get(deviceId) ?? deviceId;
    log.info(
      `[leveler2] ${name}: manual L${from}→L${target} credits ${amps.toFixed(1)}A of freed budget`,
    );
    this.noteBudgetFreed(`${name} pinned down to L${target}`);
  }

  async onUserGenLevel(deviceId: string, level: number): Promise<{ reverted: boolean; level: number }> {
    await this.ensureLoaded();
    const now = Date.now();
    this.modeState = clearFloorsOnManual(this.modeState);
    // Read BEFORE the manual clear below wipes `sendCounts`/`sentAt`: the levels
    // the firmware might still be sitting at are what price a level-down, and
    // one of them being at or below the target is how we know our own demote is
    // already travelling (and already credited).
    const inFlightLevels = unconfirmedLevels(this.recon, deviceId, now);
    this.recon = clearMarksOnManual(this.recon, deviceId);
    this.rememberedLevel.delete(deviceId);
    // Manual wins (AGENTS rule 7) — a hand-set level ends the entry policy.
    this.startBaseline.delete(deviceId);
    // A baseline waiting to be re-based is not a baseline: between a power cycle
    // and the first shadow that follows it, the confirmed level is the one the
    // unit had BEFORE it rebooted (2026-09-05). Read as unknown, this takes the
    // conservative branch below (a cap, no level-down credit), which is exactly
    // what a dashboard change right after a changeover already gets.
    const confirmed = baselineStale(this.recon, deviceId) ? null : this.recon[deviceId]?.confirmedLevel ?? null;
    const maxLevel = 3;
    const rank = (l: number): number => (l <= 0 ? maxLevel + 1 : Math.min(l, maxLevel));
    const target = Math.max(1, Math.min(rank(level), maxLevel));
    const isReduction = confirmed != null && rank(level) < rank(confirmed);
    if (isReduction || confirmed == null) {
      if (isReduction) this.creditManualLevelDown(deviceId, confirmed as number, target, inFlightLevels, now);
      this.manualCap.set(deviceId, target);
      this.manualTarget.delete(deviceId);
      this.recon = noteLevelSend(this.recon, deviceId, target, now).state;
      log.info(`[leveler2] Manual gen reduction on ${deviceId} → cap L${target}`);
      return { reverted: false, level: target };
    }
    // R14's second trigger, and the more authoritative of the two: a hand raise
    // OFF L1 is the user telling us L1 was not working (2026-08-04, "by own
    // observation or manual raise"). No watch clock has to run out first — he
    // is in the room.
    //
    // Recorded BEFORE the breaker check on purpose. Whether we can AFFORD the
    // level he asked for has nothing to do with whether the level he is leaving
    // cools his room; a reverted raise leaves that room at L1 and not cooling,
    // which is precisely the state the hold exists to stop the ladder choosing
    // on its own. The pin itself wins for as long as it stands (invariant 42) —
    // the hold is what survives him clearing it.
    //
    // ⚠ ONLY for a room with a CONFIGURED levelBoost (FIX C, 2026-08-26). The
    // learned hold refines the outdoor threshold (below its `outdoorAtLeastC`) of
    // a low-level failure the user has DECLARED via a boost (Abdullah); it does
    // not diagnose a new disease from a comfort tap. For a boost-less room a hand
    // raise off L1 is a comfort choice, not compressor evidence: live 2026-08-26
    // 13:45Z a household member raised Najat (no boost) L1→3 with fan 7 from the
    // dashboard, and it minted a false 6h min-L2 hold that admitted her at L2 on
    // the 14:02:49Z gen entry (journal #20044). The off-drop armer stays unscoped:
    // a graded lone off measuring about a fan against a 2A model is meter
    // evidence, and applies to any room.
    if (confirmed === 1 && target > 1) {
      if (this.config.levelBoosts[deviceId] != null) {
        await this.noteLevelHold(deviceId, 1, this.freshOutdoorC(now), now, "user raised the room off L1 by hand");
      } else {
        const name = this.deviceNames.get(deviceId) ?? deviceId;
        log.info(
          `[leveler2] ${name}: raised off L1 by hand, but no level boost is configured for this room: a comfort raise, not non-cooling evidence`,
        );
      }
    }
    // Increment: hard pin unless the METER says it would breach the breaker.
    const view = meterView(this.meterState, now);
    const source = view.source;
    if (source !== "none" && view.sampleCount >= 4) {
      const jump = raiseJumpAmps(this.book, this.config, deviceId, source, confirmed, target, maxLevel, now);
      // Derated after a recent trip — a hand-set increment is checked against
      // the limit the line has actually been holding, like everything else.
      const limit = effectiveLimit(this.config, source, view.derateAmps);
      if (view.smoothedAmps + jump.amps > limit - this.config.marginAmps) {
        log.warn(
          `[leveler2] Manual gen increment on ${deviceId} to L${target} projects ` +
            `${(view.smoothedAmps + jump.amps).toFixed(1)}A > ${limit}A limit on ${source} — reverted to L${confirmed}`,
        );
        return { reverted: true, level: Math.max(1, confirmed) };
      }
    }
    this.manualTarget.set(deviceId, target);
    this.manualCap.delete(deviceId);
    this.recon = noteLevelSend(this.recon, deviceId, target, now).state;
    log.info(`[leveler2] Manual gen target on ${deviceId} → L${target}`);
    return { reverted: false, level: target };
  }

  /**
   * Forget every manual intent this room carries (level cap, level target, fan
   * exemption) and describe what was actually dropped: an empty list when it
   * carried none, so a room with no pin costs no log line and no journal row.
   * The single release point for all three, because a pin that outlives the
   * state it was made in wins over every automatic decision until a human clears
   * it (invariant 42), so every edge that ends one must end it the same way.
   *
   * The CALLER journals what comes back. A source change already writes one row
   * for the whole changeover and appends these decisions to it; every other edge
   * inserts its own commandless `manual_release` row through
   * `journalManualRelease`.
   */
  private releaseManualIntent(deviceId: string, reason: string, now: number): Decision[] {
    const cap = this.manualCap.get(deviceId) ?? null;
    const target = this.manualTarget.get(deviceId) ?? null;
    const fanExempt = this.fanExempt.has(deviceId);
    if (cap == null && target == null && !fanExempt) return [];
    this.manualCap.delete(deviceId);
    this.manualTarget.delete(deviceId);
    this.fanExempt.delete(deviceId);
    const held: string[] = [];
    if (target != null) held.push(`target L${target}`);
    if (cap != null) held.push(`cap L${cap}`);
    if (fanExempt) held.push("fan exemption");
    log.info(
      `[leveler2] ${this.deviceNames.get(deviceId) ?? deviceId}: manual intent released (${held.join(", ")}), ${reason}`,
    );
    return [{ at: now, deviceId, action: "manual intent released", detail: `${held.join(", ")}: ${reason}` }];
  }

  /** The commandless journal row every release edge except the source change writes. */
  private journalManualRelease(decisions: Decision[], now: number): void {
    if (decisions.length === 0) return;
    void this.store
      .insertJournal({
        at: now,
        source: this.meterState.source,
        mode: deriveMode(this.modeState, now),
        severity: null,
        reason: "manual_release",
        requiredAmps: null,
        preAmps: meterView(this.meterState, now).smoothedAmps,
        commands: [],
        decisions,
        expectedDelta: null,
        executed: this.acts(),
      })
      .catch(() => undefined);
  }

  /**
   * One door for every power event: stamp it here, then tell the collector.
   *
   * Both sides ask the SAME question of it ("is this un-commanded device change
   * the firmware or a human?"), the collector of an observed OFF, this
   * controller of an observed level JUMP off L1. Before this the timestamp lived
   * only in the collector and the leveler had nothing to consult, which is how
   * the 2026-08-06 07:01:52Z brownout minted a six-hour hold nobody armed.
   *
   * Order is load-bearing (2026-09-05): stamp, then release our OWN intents,
   * then call outward. The collector's fan/swing wipe runs inside that callback
   * and can re-enter this controller (its beep-reset fingerprint does), so this
   * side finishes its own state first. `now` travels with the kind for the same
   * reason: the collector's observed-off window and this controller's level-jump
   * window are one clock, and two `Date.now()` calls are two clocks.
   *
   * Returns the release decisions so the source-change caller can put them in
   * the row it already writes; every other caller lets this method journal.
   */
  private notePowerEvent(
    kind: string,
    now: number = Date.now(),
    opts: { deferJournal?: boolean } = {},
  ): Decision[] {
    this.lastPowerEventAt = now;
    const released: Decision[] = [];
    // A changeover in EITHER direction, a collapse or the dead-circuit latch
    // power-cycles every unit: the firmware comes back at the level it was last
    // commanded to, which is not the level anybody chose (user, 2026-09-05,
    // superseding the 2026-06-09 "caps kept grid→gen" decision). A boot
    // ("source none → X") and a bare telemetry gap restart nothing.
    if (powerEventRestartsAcs(kind)) {
      this.lastAcRestartAt = now;
      for (const deviceId of this.deviceNames.keys()) {
        released.push(...this.releaseManualIntent(deviceId, kind, now));
      }
      if (opts.deferJournal !== true) this.journalManualRelease(released, now);
    }
    this.deps.onPowerEvent?.(kind, now);
    return released;
  }

  /**
   * The OFF→ON flip the shadow never showed (2026-09-05). A blackout that
   * changes no source reaches this controller as, at most, an `esp_gap`, but the
   * unit itself knows: TCL firmware resets `beepSwitch` to ON only on a
   * power-loss restart, so the collector's beep-reset fingerprint is per-device
   * evidence of a real restart while the shadow still reads `power=true` and the
   * structural flip below never runs.
   *
   * Everything a physical restart implies, in one place: the pins die, the
   * reconciler re-bases off the first shadow that follows (never classifying the
   * firmware's own level restore as a hand), the structural-ON bookkeeping runs
   * with restart protection in mind (invariant 44), and the SPEND side of any
   * live credit dies while its demand side survives (invariant 72's "a
   * reduction stacking onto a live off zeroes the spendable share", same
   * reasoning: the room is coming back, so those amps are not free).
   *
   * It stamps neither `lastPowerEventAt` nor `lastAcRestartAt`: both are
   * house-wide claims, and one unit's reboot says nothing about its neighbours.
   */
  onDevicePowerCycle(deviceId: string, reason: string, now: number = Date.now()): void {
    this.journalManualRelease(this.releaseManualIntent(deviceId, reason, now), now);
    this.recon = markRebaseOnPowerCycle(this.recon, deviceId);
    const managed = this.isManaged(deviceId);
    // Nothing to await between the two halves here: no shed record changes hands
    // on a fingerprint, the room never went off as far as anyone could see.
    this.noteDevicePoweredOnPre(deviceId, managed, now, { powerEvent: true });
    this.noteDevicePoweredOnPost(deviceId, managed, now, { external: true });
    const cut = this.meterState.pendingCut;
    if (cut != null && cut.spendableAmps > 0) {
      this.meterState = { ...this.meterState, pendingCut: { ...cut, spendableAmps: 0 } };
    }
    this.devicePowerCycleAt.set(deviceId, now);
    log.info(
      `[leveler2] ${this.deviceNames.get(deviceId) ?? deviceId}: power cycle observed (${reason}), ` +
        "treated as a restart: intents released, baseline re-based, ramp re-armed",
    );
  }

  /**
   * Which clock, if any, puts `now` inside the window where a device change we
   * did not command is the firmware coming back rather than a hand on the
   * remote: the house-wide power event, or (when a device is named) that room's
   * own power cycle. The freshest of the two wins the report, because the log
   * that reads it has to name the clock that actually fired.
   */
  private powerEventWindowClock(now: number, deviceId?: string): { what: string; agoMs: number } | null {
    const houseAgo = this.lastPowerEventAt > 0 ? now - this.lastPowerEventAt : Number.POSITIVE_INFINITY;
    const deviceAt = deviceId != null ? this.devicePowerCycleAt.get(deviceId) ?? 0 : 0;
    const deviceAgo = deviceAt > 0 ? now - deviceAt : Number.POSITIVE_INFINITY;
    const best = Math.min(houseAgo, deviceAgo);
    if (!(best < POWER_EVENT_LEVEL_JUMP_GRACE_MS)) return null;
    return best === deviceAgo
      ? { what: "this room's own power cycle", agoMs: deviceAgo }
      : { what: "a house-wide power event", agoMs: houseAgo };
  }

  /**
   * Is `now` inside the window where a device change we did not command is the
   * firmware coming back rather than a hand on the remote?
   */
  private inPowerEventWindow(now: number, deviceId?: string): boolean {
    return this.powerEventWindowClock(now, deviceId) != null;
  }

  /**
   * Is this room inside the window where an off is power-loss shaped rather than
   * budget a spender may take (2026-09-05, a narrow delta to invariant 72)? True
   * for `POWER_EVENT_LEVEL_JUMP_GRACE_MS` after a RESTART-kind house event or
   * after this unit's own power-cycle fingerprint.
   *
   * Never keyed on `lastPowerEventAt`: every routine CT02 MQTT blip stamps that
   * one, and funding a raise on an off the automation is about to undo is the
   * cut → raise → cut cycle invariant 72 exists to forbid.
   */
  private restartWindowActive(now: number, deviceId: string): boolean {
    const deviceAt = this.devicePowerCycleAt.get(deviceId) ?? 0;
    return (this.lastAcRestartAt > 0 && now - this.lastAcRestartAt < POWER_EVENT_LEVEL_JUMP_GRACE_MS)
      || (deviceAt > 0 && now - deviceAt < POWER_EVENT_LEVEL_JUMP_GRACE_MS);
  }

  /**
   * Open (or re-open) a compressor ramp window. Every arming point also
   * snapshots the house load right now: that reading is taken BEFORE this
   * compressor contributes, so it is the anchor `rampDebitAmps` measures
   * absorption against. Applies on both sources and to every cause — user
   * turn-on, automation turn-on, shed restore, changeover, collapse recovery.
   *
   * `powerEvent` marks the two causes that POWER-CYCLE a running compressor
   * (changeover, collapse recovery). Those windows may be held open past their
   * timer on evidence — see `holdPowerEventRamps`.
   */
  rearmRamp(deviceIds: string[], opts: { powerEvent?: boolean } = {}): void {
    const now = Date.now();
    const until = now + AC_RAMP_MS;
    const view = meterView(this.meterState, now);
    const baseline = view.source !== "none" && view.sampleCount >= 2 ? view.smoothedAmps : null;
    for (const id of deviceIds) {
      this.rampUntil.set(id, until);
      // A fresh ramp has proven no absorption yet — the previous window's peak
      // is about a compressor start that is over.
      this.rampAbsorbed.delete(id);
      // Start the plateau stall clock at arm time, anchored at zero absorption:
      // (b) can only fire `RAMP_SETTLED_STALL_MS` from here at the earliest.
      this.rampGrowth.set(id, { at: now, absorbed: 0 });
      if (baseline == null) this.rampBaseline.delete(id);
      else this.rampBaseline.set(id, baseline);
      if (opts.powerEvent === true) this.powerEventRamp.set(id, { armedAt: now, heldSince: null });
      else this.powerEventRamp.delete(id);
    }
  }

  /**
   * Hold a POWER-EVENT ramp open on EVIDENCE instead of the clock, and report
   * whether the whole house is currently dead (2026-08-04 — see dead-window.ts
   * for the incident and the thresholds).
   *
   * A window is extended only once its ordinary `AC_RAMP_MS` has run out, and
   * only while BOTH pieces of evidence hold: this compressor has absorbed
   * essentially nothing, AND the modeled running total sits `DEAD_WINDOW_GAP_AMPS`
   * above the meter with no commanded cut of ours to explain the gap. Either one
   * failing releases the window, as does the 12-minute cap.
   *
   * Runs BEFORE `buildViews`, because `buildViews` is what turns `rampUntil`
   * into `AcView.ramping` — a tick late here is the four seconds that separated
   * the 11:20:10 expiry from the 11:20:14 raise. That ordering is why the
   * modeled total is summed from the raw device context rather than from views:
   * the views do not exist yet. The context's own shadow levels are the
   * conservative choice anyway (during SETTLING the views substitute the level
   * we just COMMANDED, which is lower after a FLOORS clamp, and a lower model
   * means a smaller gap means less holding).
   *
   * Extension is the BLOCKING direction in every consumer (raise gate, ramp
   * debit, house sampling), so a false hold costs a delayed raise and a false
   * release is merely the behaviour that shipped before this existed.
   */
  /**
   * The rooms we believe are drawing, projected straight off the device context
   * rather than from `AcView`s — both consumers run BEFORE `buildViews`, which
   * is where `rampUntil` becomes `AcView.ramping`. The context's own shadow
   * level is the conservative choice for a gap that must not under-read.
   */
  private modeledRunningOf(ctx: LevelerDeviceContext[]): ModeledAc[] {
    return ctx
      .filter((c) => c.managed && c.device.power && !this.shedIds.has(c.device.id))
      .map((c) => ({
        deviceId: c.device.id,
        on: true,
        managed: true,
        shed: false,
        currentLevel: c.device.generatorMode,
        maxLevel: c.device.maxGeneratorLevel || 3,
      }));
  }

  private holdPowerEventRamps(
    ctx: LevelerDeviceContext[],
    view: ReturnType<typeof meterView>,
    now: number,
  ): boolean {
    if (this.powerEventRamp.size === 0) return false;
    // No trustworthy meter, no evidence either way — leave the timer in charge.
    if (view.source === "none" || view.frozen || view.collapsed || view.sampleCount < 2) return false;
    const source = view.source;
    const running = this.modeledRunningOf(ctx);
    const gapAmps = modeledGapAmps({
      smoothedAmps: view.smoothedAmps,
      acs: running,
      config: this.config,
      source,
      commandedCutCreditAmps: view.commandedCutCreditAmps,
    });
    const dead = houseIsDead(gapAmps);
    for (const [deviceId, ramp] of [...this.powerEventRamp]) {
      // Inside the ordinary window there is nothing to decide: the timer is
      // still doing its job, and NEITHER piece of evidence means anything yet —
      // the smoothed meter spends the first readings after a changeover
      // draining the OTHER line's load through the median, which reads as "the
      // model is below the meter" and would retire the window before it was
      // ever needed. Judge at the boundary, which is where the question is.
      if (now < ramp.armedAt + AC_RAMP_MS) continue;
      const ac = running.find((a) => a.deviceId === deviceId);
      const absorbed = this.rampAbsorbed.get(deviceId) ?? 0;
      const capped = now >= ramp.armedAt + POWER_EVENT_RAMP_MAX_MS;
      const landed = ac != null && rampAbsorptionLanded(absorbed, ac, this.config, source);
      if (ac == null || capped || landed || !dead) {
        this.powerEventRamp.delete(deviceId);
        if (ramp.heldSince != null) {
          const why = capped
            ? `${POWER_EVENT_RAMP_MAX_MS / 60_000}-min cap`
            : landed
              ? `${absorbed.toFixed(1)}A absorbed`
              : ac == null
                ? "room off"
                : `house gap ${gapAmps.toFixed(1)}A`;
          log.info(
            `[leveler2] ${this.deviceNames.get(deviceId) ?? deviceId}: compressor dead-window hold released ` +
              `after ${Math.round((now - ramp.heldSince) / 1000)}s (${why})`,
          );
        }
        continue;
      }
      // The compressor starts whenever restart protection lets it, so the ramp
      // it then owes runs from THERE — hence a rolling window rather than one
      // fixed end, bounded by the cap.
      const until = Math.min(ramp.armedAt + POWER_EVENT_RAMP_MAX_MS, now + AC_RAMP_MS);
      if (until > (this.rampUntil.get(deviceId) ?? 0)) this.rampUntil.set(deviceId, until);
      if (ramp.heldSince == null) {
        this.powerEventRamp.set(deviceId, { ...ramp, heldSince: now });
        log.info(
          `[leveler2] ${this.deviceNames.get(deviceId) ?? deviceId}: compressor has not started ` +
            `${Math.round((now - ramp.armedAt) / 1000)}s after a power event ` +
            `(${absorbed.toFixed(1)}A absorbed, house gap ${gapAmps.toFixed(1)}A) — ramp held open`,
        );
      }
    }
    // The meter is a DIRECT house measurement only when EVERY running room is
    // inside a HELD window — one room drawing normally makes the reading a
    // residual again, and residuals go through the ordinary sampler.
    //
    // `heldSince`, not mere membership: for the first `AC_RAMP_MS` after a
    // changeover the ordinary ramp guard already stands sampling down, and the
    // smoothed meter is still draining the old line's readings through the
    // median — a "direct house measurement" taken there records the previous
    // source's whole load as house (15.9A instead of 3.8A in the acceptance
    // run). A window that has outlived its own timer is the honest signal.
    //
    // …and the meter has to be STILL, or the same median lag catches the other
    // end of the window: the tick a compressor engages, the raw reading is
    // already up and the mean is halfway there.
    return (
      dead &&
      meterIsSteady(view) &&
      running.length > 0 &&
      running.every((a) => this.powerEventRamp.get(a.deviceId)?.heldSince != null)
    );
  }

  /**
   * Ratchet each live ramp's absorbed peak against this reading. Runs on the ESP
   * cadence (~5s) rather than the tick so a rise that happens between ticks is
   * still banked — it is the only evidence that a ramping compressor's amps
   * actually landed, and a peer reduction later erases the instantaneous view.
   */
  private noteRampAbsorption(now: number): void {
    // All three debit kinds ratchet here. The guard used to test `rampBaseline`
    // alone, so a level jump with no compressor start alongside it never
    // absorbed and stayed charged for its whole window.
    if (this.rampBaseline.size === 0 && this.jumpDebit.size === 0 && this.fanDebit.size === 0) return;
    const view = meterView(this.meterState, now);
    if (view.source === "none" || view.frozen || view.collapsed || view.sampleCount < 2) return;
    for (const [id, baseline] of this.rampBaseline) {
      // A power-event ramp under review keeps ratcheting even past its nominal
      // expiry: absorption is the evidence that decides whether the window may
      // close at all (holdPowerEventRamps), and it must not stop being measured
      // in the readings that land between two ticks.
      if ((this.rampUntil.get(id) ?? 0) <= now && !this.powerEventRamp.has(id)) continue;
      const risen = view.smoothedAmps - baseline;
      if (risen > (this.rampAbsorbed.get(id) ?? 0)) {
        this.rampAbsorbed.set(id, risen);
        // Stall clock (plateau test): re-stamp only when the ratchet has climbed
        // a MEANINGFUL step since the last stamp, so a noise-sized creep does not
        // keep resetting it — that is what lets (b) recognise a settled meter.
        const mark = this.rampGrowth.get(id);
        if (mark == null || risen - mark.absorbed >= RAMP_SETTLED_EPSILON_AMPS) {
          this.rampGrowth.set(id, { at: now, absorbed: risen });
        }
      }
      // A whole amp of measured rise attributable to THIS room's ramp is a
      // compressor starting — positive evidence, so any standing "it was only
      // drawing its fan" record for it is retired (R6). Same bar the dead
      // window releases a held ramp on, so the two cannot disagree.
      if ((this.rampAbsorbed.get(id) ?? 0) >= RAMP_RELEASE_MAX_AMPS) this.compressorOff.delete(id);
      // …and once the meter has PROVEN the rise landed (fully absorbed) or landed
      // and settled (plateaued above the bar), close the window before its clock.
      this.maybeReleaseRampEarly(id, view, now);
    }
    for (const debits of [this.jumpDebit, this.fanDebit]) {
      for (const [id, debit] of debits) {
        if (debit.until <= now) {
          debits.delete(id);
          continue;
        }
        if (debit.baseline == null) continue;
        const risen = view.smoothedAmps - debit.baseline;
        if (risen > debit.absorbed) debits.set(id, { ...debit, absorbed: risen });
      }
    }
  }

  /**
   * Amp evidence retires a compressor ramp WINDOW before its `AC_RAMP_MS` clock
   * (user directive, 2026-08-08). Runs per raw reading, right after the ratchet
   * is fresh: once the meter has shown this ramp fully absorbed — or crossed the
   * "a compressor started" bar and then plateaued — its window has nothing left
   * to protect, so `ramping` (which buildViews folds out of `rampUntil`) drops
   * now instead of at four minutes. Never on flatness alone: a ratchet under the
   * bar is a compressor that has NOT started (the changeover dead window), and
   * `rampProvenDone` returns null there, so the window keeps its full clock and
   * the dead-window extension machinery above (dead-window.ts, invariant 44).
   *
   * A power-event ramp released here simply passes its own `landed` check the
   * next time `holdPowerEventRamps` consults it, which drops its `powerEventRamp`
   * entry — the two agree by construction (both are gated on the same bar).
   */
  private maybeReleaseRampEarly(id: string, view: ReturnType<typeof meterView>, now: number): void {
    if ((this.rampUntil.get(id) ?? 0) <= now) return;
    const source = view.source;
    if (source === "none") return;
    // Price the committed draw exactly as `rampDebitAmps` charges it (one helper,
    // both sites). The confirmed shadow is the level the compressor is climbing
    // to; with no confirm yet there is nothing to price against, so leave the clock.
    const level = this.recon[id]?.confirmedLevel;
    if (level == null || level < 1) return;
    const committed = rampCommittedAmps(
      { deviceId: id, currentLevel: level, maxLevel: this.deviceMaxLevel.get(id) ?? 3 },
      this.config,
      source,
    );
    const proof = rampProvenDone({
      absorbedAmps: this.rampAbsorbed.get(id) ?? 0,
      committedAmps: committed,
      lastGrowthAt: this.rampGrowth.get(id)?.at ?? now,
      now,
    });
    if (proof == null) return;
    const armedAt = this.powerEventRamp.get(id)?.armedAt ?? (this.rampUntil.get(id) ?? now) - AC_RAMP_MS;
    const absorbed = this.rampAbsorbed.get(id) ?? 0;
    this.rampUntil.delete(id);
    this.rampGrowth.delete(id);
    // A level jump on the same device whose amps the meter has also fully shown
    // owes nothing more — drop it. Bookkeeping hygiene, not behaviour: its
    // `absorbed` already zeroes the owed amps in `unmeteredJumpAmps`.
    const jd = this.jumpDebit.get(id);
    if (jd != null && jd.amps - jd.absorbed <= 0) this.jumpDebit.delete(id);
    const secs = Math.max(0, Math.round((now - armedAt) / 1000));
    const name = this.deviceNames.get(id) ?? id;
    log.info(
      proof === "absorbed"
        ? `[leveler2] ${name}: ramp released early — ${absorbed.toFixed(1)}A of ${committed.toFixed(1)}A absorbed in ${secs}s`
        : `[leveler2] ${name}: ramp released early — plateaued at ${absorbed.toFixed(1)}A of ${committed.toFixed(1)}A after ${secs}s`,
    );
  }

  /**
   * Latch — and release — a collapse the READINGS cannot see: a gen session
   * that BEGINS with the AC circuit already dead (2026-08-04, user-confirmed
   * breaker trip and manual reset). `ingestReading` judges FALLS inside a
   * session, and a session that starts dead has no cliff, so the third real
   * trip in ten days went unlatched: no derate, and the controller then rode
   * 14.3–14.8A on a generator whose breaker had just opened.
   *
   * Evidence and dwell live in dead-window.ts; this owns the state machine and
   * the fan-out, which is deliberately the SAME one a fall-latched collapse
   * gets — stacked derate (invariants 2/15), COLLAPSED mode, a critical push,
   * a journal row, and FLOORS on the way back in.
   *
   * Release is on evidence, never on a clock: the moment ANY room reports in or
   * the meter shows our load again, the circuit is alive. (`ingestReading`'s
   * own `POWER_COLLAPSE_MAX_MS` safety cap still applies underneath — a latch
   * must never be able to strand the house, and that property is not this
   * change's to relax.)
   */
  /**
   * A dead circuit is coming back: every room returns at once, with restart
   * protection already served, and the meter has seen none of it. Open the
   * window in which the FLOORS entry admits the floor set on the ENVELOPE —
   * bounded by the FLOORS window itself, so it cannot outlive the entry it
   * belongs to — and re-arm the ramps, which also keeps FLOORS from clearing
   * before anything has confirmed.
   */
  private armRecoveryAdmission(ctx: LevelerDeviceContext[], now: number): void {
    this.recoveryAdmissionUntil = now + FLOORS_MAX_MS;
    this.rearmRamp(
      ctx.filter((c) => c.device.power).map((c) => c.device.id),
      { powerEvent: true },
    );
  }

  private async assessEntryCollapse(
    ctx: LevelerDeviceContext[],
    view: ReturnType<typeof meterView>,
    now: number,
  ): Promise<void> {
    // OUR latch has gone — because the meter came back past its reference, or
    // because the sensing safety cap retired it. Both mean the same thing as
    // clearing it ourselves below: the circuit is alive and every room is about
    // to arrive at once, so the recovery window opens here too. (`ingestReading`
    // emits its own `collapse_recovered`, so FLOORS is already armed.)
    if (this.entryCollapseLatched && this.meterState.collapse == null) {
      this.entryCollapseLatched = false;
      this.armRecoveryAdmission(ctx, now);
    }
    if (view.source === "none" || view.frozen || view.sampleCount < 2) {
      this.entryCollapseSince = null;
      return;
    }
    const source = view.source;
    const running = this.modeledRunningOf(ctx);
    const gapAmps = modeledGapAmps({
      smoothedAmps: view.smoothedAmps,
      acs: running,
      config: this.config,
      source,
      commandedCutCreditAmps: view.commandedCutCreditAmps,
    });
    const rooms: RoomLiveness[] = ctx
      .filter((c) => c.managed && c.device.power && !this.shedIds.has(c.device.id))
      .map((c) => {
        const unanswered = this.unansweredSince.get(c.device.id);
        return {
          isOnline: c.device.isOnline,
          lastSeenAt: c.device.lastSeenAt,
          lastConfirmAt: this.lastConfirmAt.get(c.device.id) ?? null,
          unconfirmedSendAgeMs: unanswered == null ? 0 : now - unanswered,
        };
      });
    const evidence = entryCollapseEvidence({
      gapAmps,
      rooms,
      sinceEntry: this.sourceSince,
      now,
    });
    if (!evidence) {
      this.entryCollapseSince = null;
      if (this.entryCollapseLatched) {
        // The circuit is alive again. Hand the recovery to the same machinery a
        // metered recovery uses — which re-arms FLOORS on gen — and mark the
        // window so admission is judged on the envelope, not on a meter that
        // has not seen a single compressor yet.
        this.entryCollapseLatched = false;
        this.meterState = clearCollapse(this.meterState);
        this.modeState = applyMeterEvent(this.modeState, { kind: "collapse_recovered", source }, now);
        this.armRecoveryAdmission(ctx, now);
        log.warn(`[leveler2] AC circuit is back on ${source} — re-entering at floors, admission re-judged`);
      }
      return;
    }
    this.entryCollapseSince ??= now;
    if (this.entryCollapseLatched || now - this.entryCollapseSince < ENTRY_COLLAPSE_DWELL_MS) return;
    // The line SHOULD be carrying the house plus everything we believe is on;
    // that is the reference the metered recovery check compares against.
    const preMedianAmps = view.smoothedAmps + gapAmps;
    this.meterState = latchCollapse(this.meterState, { source, now, preMedianAmps });
    this.modeState = applyMeterEvent(
      this.modeState,
      { kind: "collapse", fromAmps: preMedianAmps, toAmps: view.smoothedAmps, source },
      now,
    );
    this.entryCollapseLatched = true;
    const derated = effectiveLimit(this.config, source, this.meterState.derate?.amps ?? 0);
    log.warn(
      `[leveler2] AC circuit appears DEAD on ${source}: ${running.length} room(s) modeled at ` +
        `${(view.smoothedAmps + gapAmps).toFixed(1)}A, meter ${view.smoothedAmps.toFixed(1)}A, every shadow dark for ` +
        `${Math.round((now - this.entryCollapseSince) / 1000)}s — probable breaker trip; commands frozen, ` +
        `${source} limit derated to ${derated.toFixed(1)}A`,
    );
    this.notePowerEvent(`AC circuit dead on ${source}`, now);
    void this.pushNotice(
      `AC circuit appears dead on the ${source === "gen" ? "generator" : "grid"} — check the breaker. ` +
        `Levelling is frozen until the rooms come back.`,
      true,
    );
    void this.store
      .insertJournal({
        at: now,
        source,
        mode: deriveMode(this.modeState, now),
        severity: null,
        reason: "collapse_on_entry",
        requiredAmps: null,
        preAmps: view.smoothedAmps,
        commands: [],
        decisions: [
          {
            at: now,
            action: "collapse latched on entry",
            detail:
              `modeled ${(view.smoothedAmps + gapAmps).toFixed(1)}A vs meter ${view.smoothedAmps.toFixed(1)}A ` +
              `with every shadow dark — no fall to see, the session began dead`,
          },
        ],
        expectedDelta: null,
        executed: this.acts(),
      })
      .catch(() => undefined);
  }

  /**
   * Charge a level RAISE we just sent on gen as committed-but-unmetered draw,
   * so the next spender cannot be admitted against a meter that has not caught
   * up with it yet (2026-07-26: two raises 35s apart on a lagging meter tripped
   * the breaker). A cut arms nothing — reductions are never gated — and grid is
   * excluded for the same reason the ramp debit excludes it: grid starts every
   * AC full by directive and leans on the reducer as its safety.
   */
  private armJumpDebit(
    deviceId: string,
    level: number,
    view: ReturnType<typeof meterView>,
    now: number,
  ): void {
    if (view.source !== "gen") return;
    const from = this.recon[deviceId]?.confirmedLevel;
    if (from == null || from < 1 || level <= from) {
      this.jumpDebit.delete(deviceId);
      return;
    }
    const maxLevel = this.deviceMaxLevel.get(deviceId) ?? 3;
    const jump = raiseJumpAmps(this.book, this.config, deviceId, "gen", from, level, maxLevel, now);
    const baseline = view.sampleCount >= 2 && !view.frozen ? view.smoothedAmps : null;
    this.jumpDebit.set(deviceId, {
      amps: jump.amps,
      baseline,
      absorbed: 0,
      until: now + AC_RAMP_MS,
    });
  }

  /**
   * Charge a fan RESTORE we just sent on gen, at exactly the price
   * `planFanRestore` admitted it for, so the next tick cannot spend the same
   * amps on a level raise before the meter has shown them.
   */
  private armFanDebit(
    deviceId: string,
    from: number | null,
    to: number,
    view: ReturnType<typeof meterView>,
    now: number,
  ): void {
    if (view.source !== "gen") return;
    // Fan 0 is built-in auto — an unknown gear, priced as a full swing (the
    // same convention planFanRestore uses).
    const steps = to === 0 || from == null ? 6 : to - from;
    if (steps <= 0) {
      this.fanDebit.delete(deviceId);
      return;
    }
    const baseline = view.sampleCount >= 2 && !view.frozen ? view.smoothedAmps : null;
    this.fanDebit.set(deviceId, {
      amps: fanTrimSavings(this.book, deviceId, "gen", steps, now),
      baseline,
      absorbed: 0,
      until: now + FAN_DEBIT_MS,
    });
  }

  /**
   * Unmetered remainder of a recent level raise AND fan restore (0 when none /
   * fully absorbed). Additive: a room can be climbing its fan and its level at
   * once, and both draws are still on their way to the meter.
   */
  private unmeteredJumpAmps(deviceId: string, now: number): number {
    let owed = 0;
    for (const debits of [this.jumpDebit, this.fanDebit]) {
      const debit = debits.get(deviceId);
      // No baseline means we could not measure absorption — charge the whole
      // amount, the same way an unknown ramp baseline charges the whole draw.
      if (debit != null && debit.until > now) owed += Math.max(0, debit.amps - debit.absorbed);
    }
    return owed;
  }

  /**
   * Open a start window for an AC that just came on: remember the house load
   * measured just BEFORE it started. On grid the raise planner uses it to lift
   * the AC straight to its ceiling ("on grid, start all to full" — user
   * 2026-07-23) instead of creeping up one step per batch behind the ramp gate
   * (2026-07-25: 4m41s to reach L3 with ~5A free).
   *
   * **Gen opens the same window since 2026-07-30**, for the opposite policy.
   * The old "gen needs no equivalent — entering gen means FLOORS" assumption
   * died when GRID_FULL shipped: a TCL restores the generator level it was last
   * left at, and after a grid session that level is L3. Live 05:51 Baghdad,
   * Najat came back on a 15A gen at L3 (6.3A modeled) 33 minutes into the gen
   * session — long after FLOORS had ended — with no admission control at all,
   * and the house rode 16.77A until the user hand-fixed it. `raise.ts` still
   * gates its LIFT on grid; `invariantCorrections` owns the gen clamp.
   *
   * First writer wins: the routes-level user hook fires a tick before the
   * observed power flip, and its reading is the cleaner baseline.
   */
  private noteTurnOn(deviceId: string, now: number): void {
    const view = meterView(this.meterState, now);
    if (view.source === "none" || view.sampleCount < 2) return;
    const open = this.startBaseline.get(deviceId);
    if (open != null && open.until > now) return;
    this.startBaseline.set(deviceId, { amps: view.smoothedAmps, until: now + START_WINDOW_MS });
  }

  /**
   * Everything that follows structurally from "this room is drawing again"
   * (2026-09-05), in two halves because the ordinary flip has an AWAIT in the
   * middle of it: the shed clear. Two callers with the same physics and
   * different evidence: the shadow's OFF→ON flip in `tick`, and the beep-reset
   * fingerprint (`onDevicePowerCycle`), which is that same flip for a unit whose
   * shadow never showed the off. The flip runs Pre → `clearShed` → Post, which
   * is the order it always had; the fingerprint runs the two back to back.
   *
   * Parametrized so the ordinary flip keeps behaving exactly as it did:
   *  - `powerEvent` marks a ramp that may be held open past `AC_RAMP_MS` on
   *    evidence, because a power-cycled compressor serves restart protection the
   *    model knows nothing about (invariant 44). A hand/automation turn-on is a
   *    plain TIMED ramp and passes false.
   *  - `external` stamps the donor shield and ends the bounce episode
   *    (invariant 65). The flip withholds it for a room WE restored, and for one
   *    whose restore is still in flight; a physical restart is external by
   *    definition.
   *
   * `clearShed` and the `freshlyOn` list stay with the caller: they are about
   * the leveler's own bookkeeping for this tick, not about the room drawing.
   *
   * Everything but the ramp is managed-only: an opted-out AC is counted, never
   * adjusted, and none of this accounting has a consumer for it.
   */
  private noteDevicePoweredOnPre(deviceId: string, managed: boolean, now: number, opts: { powerEvent: boolean }): void {
    this.rearmRamp([deviceId], { powerEvent: opts.powerEvent });
    // This room has been DRAWING since some earlier moment we never saw, the
    // shadow is only now catching up. Every house sample taken in the meantime
    // booked its compressor as house load (invariant 20's rise-side twin), so
    // drop the ones that could not have known.
    if (managed) this.voidPhantomHouse(deviceId, now);
  }

  /** The second half: see `noteDevicePoweredOnPre`. */
  private noteDevicePoweredOnPost(deviceId: string, managed: boolean, now: number, opts: { external: boolean }): void {
    if (!managed) return;
    // Automation turn-ons never pass through onUserPowerOn (invariant 13: gen
    // clamps a restored room to its floor, grid lifts it).
    this.noteTurnOn(deviceId, now);
    if (opts.external) this.noteExternalOn(deviceId, now);
    // A room coming on is load ARRIVING, and `batchLoadDirections` only ever
    // sees our OWN commands, so without this an external turn-on left the
    // add-side settle clock untouched and the next cost sample measured its ramp
    // as if the meter had been quiet.
    this.lastLoadAddAt = now;
    // …and the clock only protects windows armed AFTER this moment. A window
    // already open (a restore's 315s grade, say) is measuring a meter this
    // compressor is now climbing into, and would ratchet that ramp into ITS own
    // cost. Our own batches mark open windows this way; an external ON must too.
    this.pendingGrades = this.pendingGrades.map((g) =>
      g.contaminated || g.direction !== "up" ? g : { ...g, contaminated: true },
    );
  }

  /**
   * The other end of a manual intent's life (2026-09-05, user: "a manual set of
   * the AC level should be reset … on the next automation range-slot boundary").
   * The automation side already works this way for fan, swing and the per-field
   * profile overrides, all of which reset on a slot-id mismatch; the leveler's
   * own pins did not.
   *
   * Edge-triggered, and deliberately conservative in three places:
   *  - an UNKNOWN key (null: no matching rule, or an active slot whose metric
   *    had no value this tick) neither compares nor stores, so a one-tick sensor
   *    gap releases nothing;
   *  - a device with no stored key yet (first sight after boot, or a regime that
   *    has been unknown since boot) only stores: recovering from an initial
   *    unknown is not a boundary, and a pin made during that stretch must
   *    survive it;
   *  - a pin made AFTER the boundary lives until the NEXT one, because the key
   *    is stored the moment it is seen.
   */
  private noteSlotBoundary(deviceId: string, slotKey: string | null, now: number): void {
    if (slotKey == null) return;
    const prev = this.lastSlotKey.get(deviceId);
    this.lastSlotKey.set(deviceId, slotKey);
    if (prev == null || prev === slotKey) return;
    this.journalManualRelease(
      this.releaseManualIntent(deviceId, `range slot changed (${prev} → ${slotKey})`, now),
      now,
    );
  }

  // ---------- tick ----------

  async tick(ctx: LevelerDeviceContext[], outdoorTempC: number | null): Promise<void> {
    await this.ensureLoaded();
    if (Date.now() - this.lastConfigReloadAt > 30_000) await this.reloadConfig().catch(() => undefined);
    if (!this.isEnabled()) return;
    const tcl = this.deps.getTclCloud();
    if (tcl == null) return;
    const now = Date.now();
    if (outdoorTempC != null) {
      this.lastOutdoorC = outdoorTempC;
      this.lastOutdoorAt = now;
    }

    // Structural changes: power flips and range-slot boundaries.
    this.freshlyOn = [];
    for (const { device, managed, slotKey } of ctx) {
      this.deviceNames.set(device.id, device.name);
      this.deviceMaxLevel.set(device.id, device.maxGeneratorLevel || 3);
      if (managed) this.managedIds.add(device.id);
      else this.managedIds.delete(device.id);
      // Before `buildViews`, so the same tick that ends the pin already plans
      // against the new slot's own `slotGenCap`.
      this.noteSlotBoundary(device.id, slotKey, now);
      // A poll showing a SHED room OFF is the shed's power_off having LANDED —
      // the evidence `reconcileObservedOn` needs to tell a later ON apart
      // (#9268/#9270): an ON after a confirmed off is an external hand (clear +
      // shield), an ON with no off ever observed is the stale echo of an off
      // still in flight (keep the shed). Stamped every tick the shadow shows it
      // off; cleared with the shed record itself.
      if (managed && !device.power && this.shedIds.has(device.id)) {
        this.shedOffObservedAt.set(device.id, now);
      }
      const prev = this.prevPowerStates.get(device.id);
      // FIRST sight of this device since boot. A shed record is persisted so it
      // survives a restart (a shed room must still be restored after a deploy)
      // — but if the room is already ON there is no off→on flip left to clear
      // it, and the flip below is the only path that does. The record then
      // sticks forever: `shed` excludes the room from `onManaged`, so the
      // leveler stops levelling it AND stops counting its draw, which lands in
      // the house residual instead. Live 2026-08-02: Abdullah sat on=true
      // shed=true after the 17:40 shed and a redeploy, drawing 2.3A the
      // controller could not see, inflating "house" to 5.2A.
      //
      // ⚠ But the boot shadow is the WEAKEST evidence in the system — the TCL
      // cloud confirms 5.8s to 13min late, so a room shed seconds before a
      // redeploy can still read as ON. Clearing on that first sight destroys
      // the shed record of a room that is physically off: the restore is lost
      // and the model starts charging the meter for a compressor that is not
      // running. So this needs the room to be seen ON TWICE, a grace apart —
      // and it never runs in shadow flavour, where v1 owns the same table.
      if (prev === undefined && device.power && managed && this.shedIds.has(device.id)) {
        this.bootShedOnSince.set(device.id, now);
      }
      const bootSeen = this.bootShedOnSince.get(device.id);
      if (bootSeen != null) {
        if (!device.power || !this.shedIds.has(device.id)) {
          this.bootShedOnSince.delete(device.id);
        } else if (this.acts() && now - bootSeen >= BOOT_SHED_CLEAR_GRACE_MS) {
          this.bootShedOnSince.delete(device.id);
          await this.clearShed(device.id, "still on at boot after grace");
        }
      }
      if (prev !== undefined && prev !== device.power) {
        if (device.power) {
          // A TIMED ramp: nothing here power-cycled the compressor, so this
          // window closes on its own clock (the fingerprint's does not). Ahead
          // of the awaited `clearShed`, exactly where it has always run.
          this.noteDevicePoweredOnPre(device.id, managed, now, { powerEvent: false });
          // A shed device flips ON in the shadow: OUR restore confirmed (or an
          // external hand did it) — THIS is where the shed clears, not at
          // command send (2026-07-27 bogus-lock incident). The OFF→ON flip
          // requires the shadow to have shown the off first, so a stale-ON
          // shadow can't trip this the way it could trip reconcileObservedOn.
          //
          // Captured BEFORE the clear because `clearShed` removes the room from
          // `shedIds`, so the structural bookkeeping below (which gives every
          // fresh-on room its start window) runs for a restored room too. The
          // donor shield must tell the two apart.
          const wasShed = managed && this.shedIds.has(device.id);
          if (wasShed) {
            await this.clearShed(device.id, "restore_confirmed");
          }
          if (managed && !this.shedIds.has(device.id)) this.freshlyOn.push(device.id);
          // A room WE never command on flipped on (`!wasShed` — the leveler
          // only ever turns SHED rooms back on, which take the restore-confirm
          // branch above): a remote, an automation, a hand, or a power-blink
          // restore. The comfort swap may not trade it away for the shield
          // window (invariant 42/57, 2026-08-06 #9224/#9228) — its OBSERVED
          // half is power-event-indistinguishable from a hand (invariant 56),
          // and the shield's fifteen minutes match that grace exactly. A
          // restore-confirm is OUR command and never shields.
          //
          // …unless OUR restore is in flight: `reconcileObservedOn` may have
          // already cleared the shed as a `restore_confirmed` on this same ON
          // (it runs first, on the device poll), so `wasShed` reads false here
          // for a room the leveler itself restored. The shared predicate keeps
          // the echo from being stamped external on this edge too (2026-08-08).
          this.noteDevicePoweredOnPost(device.id, managed, now, {
            external: !wasShed && !this.restoreInFlight(device.id, now),
          });
        } else {
          // Someone else turned this room off — a remote, the automation, a
          // schedule. Price it off the meter before the reconciler forgets its
          // level: the fall that follows is collapse-SHAPED (a whole room's
          // draw vanishing, leaving only the house), and the relative collapse
          // floor cannot tell it from a breaker without this credit.
          //
          // The SPEND side is a different question (2026-09-05). Inside the
          // restart window this off is power-loss shaped: the classifier already
          // reads it as a power event rather than a hand (hard rule 2), and the
          // automation is about to turn the room back on, so funding a raise on
          // it is the cut → raise → cut cycle invariant 72 forbids. The demand
          // side still credits, because the fall it explains is real.
          const spendable = !this.restartWindowActive(now, device.id);
          const credited = this.creditRoomOff(device.id, device.generatorMode ?? null, now, { spendable });
          if (credited && !spendable) {
            log.info(
              `[leveler2] ${this.deviceNames.get(device.id) ?? device.id}: observed off inside the ` +
                `${POWER_EVENT_LEVEL_JUMP_GRACE_MS / 60_000}min restart window, credited but not spendable`,
            );
          }
          this.pendingOn.delete(device.id);
          this.startBaseline.delete(device.id);
          // No compressor, no ramp to account for.
          this.rampUntil.delete(device.id);
          this.rampBaseline.delete(device.id);
          this.rampAbsorbed.delete(device.id);
          this.rampGrowth.delete(device.id);
          this.powerEventRamp.delete(device.id);
          this.recon = clearOnPowerOff(this.recon, device.id);
          // The room went off: every intent it carried was about a session that
          // has ended. Through the ONE helper, so this edge logs and journals
          // like every other release (2026-09-05).
          this.journalManualRelease(this.releaseManualIntent(device.id, "power off (observed)", now), now);
          await this.releaseHold(device.id, "power_off");
          if (managed) {
            // A managed AC just turned off (user/automation freed budget). The
            // next readings are a DECAYING meter, not settled evidence — reset
            // calm so raises wait out a fresh settle instead of grabbing the
            // freed headroom before it is real (and before a pending shed
            // restore can claim it). Mirror of the turn-on ramp, for falling
            // draw: v2 has no freed-headroom projection on an off, so a calm
            // reset is the mechanism.
            this.meterState = resetCalm(this.meterState);
            // …and evaluate on the spot, but ONLY when the credit actually armed
            // (2026-08-31) and something is actually spendable (2026-09-05). A
            // deduped re-observation of an off we already priced has freed
            // nothing new (this very tick is the one that would see it), and
            // firing there would queue an evaluation for every device poll that
            // re-reads the same OFF shadow.
            if (credited && spendable) {
              this.noteBudgetFreed(`${this.deviceNames.get(device.id) ?? device.id} was switched off`);
            }
          }
        }
      }
      this.prevPowerStates.set(device.id, device.power);
    }
    if (this.armRampOnSourceChange) {
      this.armRampOnSourceChange = false;
      // The changeover restarted every running compressor — a power event, so
      // these windows close on evidence rather than on the clock (2026-08-04).
      this.rearmRamp(
        ctx.filter((c) => c.device.power).map((c) => c.device.id),
        { powerEvent: true },
      );
    }

    const view = meterView(this.meterState, now);
    const inSettle = deriveMode(this.modeState, now) === "SETTLING";

    // Drift reconciliation per ON managed device.
    for (const { device, managed } of ctx) {
      if (!device.power || !managed) continue;
      // A shadow that came back at a level WE sent is a device that heard us —
      // the active half of the entry-collapse liveness test (dead-window.ts).
      // Deliberately not "confirmedLevel changed": the TCL shadow is PERSISTED,
      // so a dead room still serves its last known level to the poller and
      // adopting that would read as life. Only a send we made, coming back, is
      // evidence that anything is listening.
      const answeredSend = unconfirmedLevels(this.recon, device.id, now).includes(device.generatorMode);
      const wasConfirmedAt = this.recon[device.id]?.confirmedLevel ?? null;
      const { state: recon2, result } = observeLevel(this.recon, device.id, device.generatorMode, {
        inSettle,
        collapsed: view.collapsed,
        maxLevel: device.maxGeneratorLevel || 3,
      });
      this.recon = recon2;
      // A shadow that MOVED is a device that is listening — the active half of
      // the entry-collapse liveness test (dead-window.ts). A room already at its
      // floor is never sent anything and so can only prove itself by reporting;
      // a room the entry policy clamped proves itself here.
      if (answeredSend || result.kind === "late_confirm") {
        this.lastConfirmAt.set(device.id, now);
        this.unansweredSince.delete(device.id);
      }
      if (result.kind === "manual" && this.acts()) {
        // Shadow mode never mints intents (v1's own commands would read as manual).
        if (result.intent === "cap") {
          this.manualCap.set(device.id, result.level);
          this.manualTarget.delete(device.id);
          log.info(`[leveler2] ${device.name}: external gen reduction observed → cap L${result.level}`);
        } else {
          this.manualTarget.set(device.id, result.level);
          this.manualCap.delete(device.id);
          log.info(`[leveler2] ${device.name}: external gen increment observed → target L${result.level}`);
          // Same evidence as a dashboard raise, arriving by remote or by the
          // vendor app instead (R14): somebody in the room decided L1 was not
          // doing anything. The hold outlives the pin.
          //
          // …UNLESS the house just blinked. A TCL restores the level it was last
          // left at when it power-cycles, and in the shadow that restore is the
          // SAME observation a hand raise makes — un-commanded, above the
          // confirmed level. The observed-OFF classifier has had this guard since
          // 2026-07-06 (an off near a power event is a power-loss off, never a
          // manual-off lock); the observed-RAISE armer had none, and on
          // 2026-08-06 07:01:52Z a brownout's firmware restore minted a six-hour
          // hold that cost the hottest room its restore. Hard rule 5b's spirit:
          // never infer a HUMAN event from device shape near a power event.
          //
          // ⚠ Only the ARMER is guarded. The dashboard path (`onUserGenLevel`)
          // is an authenticated REST command with a person behind it, so it is
          // attributable no matter what the line is doing.
          //
          // …and ONLY for a room with a CONFIGURED levelBoost (FIX C, 2026-08-26),
          // exactly like the dashboard path: the learned hold refines the outdoor
          // threshold (below its `outdoorAtLeastC`) of a low-level failure the user
          // has DECLARED via a boost (Abdullah); it does not diagnose a new disease
          // from a comfort tap. For a boost-less room an observed raise off L1 is a
          // comfort choice (live 2026-08-26 13:45Z Najat L1→3, journal #20044), so
          // it is logged and arms nothing. The off-drop armer stays unscoped: its
          // graded lone off is meter evidence, and applies to any room.
          if (wasConfirmedAt === 1 && result.level > 1) {
            // Per-device since 2026-09-05: one room's own power-cycle
            // fingerprint must not stand the armer down for its neighbours, and
            // the line has to name the clock that actually fired or the next
            // forensic pass cannot tell the two apart.
            const clock = this.powerEventWindowClock(now, device.id);
            if (clock != null) {
              log.info(
                `[leveler2] ${device.name}: level jump off L1 within ` +
                  `${POWER_EVENT_LEVEL_JUMP_GRACE_MS / 60_000}min of ${clock.what} ` +
                  `(${Math.round(clock.agoMs / 1000)}s): firmware restore, ` +
                  `not a human raise; no hold`,
              );
            } else if (this.config.levelBoosts[device.id] != null) {
              await this.noteLevelHold(device.id, 1, outdoorTempC, now, "raised off L1 externally");
            } else {
              log.info(
                `[leveler2] ${device.name}: raised off L1 externally, but no level boost is configured for this room: a comfort raise, not non-cooling evidence`,
              );
            }
          }
        }
      } else if (result.kind === "late_confirm") {
        log.info(`[leveler2] ${device.name}: L${result.level} confirmed late — unreachable mark cleared`);
      }
      // Fan reconciliation for live holds.
      const hold = this.fanHolds[device.id];
      if (hold != null && device.fanSpeed != null) {
        this.recon = confirmFan(this.recon, device.id, device.fanSpeed);
        const resend = fanResendDue(this.recon, device.id, device.fanSpeed, now);
        if (resend != null && this.acts()) {
          try {
            await tcl.sendControl(device.id, "set_fan_speed", resend);
            this.recon = noteFanSend(this.recon, device.id, resend, now);
            this.deps.onLevelerFanCommand(device.id, resend);
          } catch (err) {
            log.warn(`[leveler2] fan resend failed for ${device.name}: ${String(err)}`);
          }
        } else if (
          device.fanSpeed === 0 &&
          hold.lastSetFan !== 0 &&
          this.recon[device.id]?.pendingFan == null
        ) {
          // The firmware's own reset, not a hand (2026-09-05). TCL zeroes the
          // blower on every power-loss restart, and no hold ever asks for 0
          // unless it is restoring a room that was on built-in auto to begin
          // with, which is exactly what `lastSetFan === 0` means. The dashboard
          // "A" button expresses that intent through `onUserFanAuto`, never here.
          // So: release the hold, so the trim ladder starts from scratch instead
          // of sitting alive over a blower it no longer describes, and mint NO
          // exemption, or one blackout would bar this room from fan trimming for
          // the rest of the episode.
          //
          // TWO things keep this from eating a healthy hold, and both are why it
          // sits HERE rather than ahead of the resend:
          //  - the resend branch runs first, so a hold whose own `set_fan` is
          //    still in flight keeps its confirm-or-resend ladder;
          //  - `pendingFan == null` (the same guard the external branch below
          //    has) means a 0 observed while OUR send is unconfirmed is read as
          //    shadow lag, not as a restart. Only a 0 seen with nothing of ours
          //    pending is the firmware.
          await this.releaseHold(device.id, "power_cycle_reset");
        } else if (
          device.fanSpeed !== hold.lastSetFan &&
          device.fanSpeed !== hold.originalFan &&
          this.recon[device.id]?.pendingFan == null
        ) {
          // Observed move to a fan we never commanded → user/external took over.
          // Only a NON-ZERO fan reaches here (the branch above owns 0), because
          // an observed 0 is never a human's choice.
          this.fanExempt.add(device.id);
          await this.releaseHold(device.id, "external_fan_change");
        }
      }
      // Warm-restore memory clears once the level is reached (confirmed ≥ remembered).
      const remembered = this.rememberedLevel.get(device.id);
      const confirmedNow = this.recon[device.id]?.confirmedLevel;
      if (
        remembered != null &&
        confirmedNow != null &&
        confirmedNow >= 1 &&
        Math.min(confirmedNow, device.maxGeneratorLevel || 3) >= remembered
      ) {
        this.rememberedLevel.delete(device.id);
        await this.pool.query("DELETE FROM ac_leveling_remembered_level WHERE device_id = $1", [device.id]);
      }
    }

    // Unreachable-mark expiry sweep.
    const swept = sweepExpiredMarks(this.recon, now);
    this.recon = swept.state;
    for (const { deviceId, level } of swept.expired) {
      log.info(`[leveler2] ${this.deviceNames.get(deviceId) ?? deviceId}: unreachable mark L${level} expired — re-probing`);
    }

    // Manual-off-locked shed candidates: the lock wins (pre-filter, v1 parity).
    for (const id of [...this.shedIds]) {
      if (await this.deps.isManualOffLocked(id)) await this.clearShed(id, "manual_off_lock");
    }

    // Grade the pending batch (journal + cost learning + pacing success).
    await this.gradePending(view, now);

    // A ramp opened by a power event closes on evidence, not on its timer —
    // and while every room's compressor is still dead the meter IS the house
    // (2026-08-04). Must precede buildViews: that is where `rampUntil` becomes
    // `AcView.ramping`.
    const houseIsDirect = this.holdPowerEventRamps(ctx, view, now);
    // …and a circuit that is dead rather than merely slow to start is a real
    // collapse, latched here because the readings alone cannot see it.
    await this.assessEntryCollapse(ctx, view, now);

    // Retire any learned non-cooling hold the weather or the clock has released,
    // BEFORE the views read them — a hold that no longer binds must not govern
    // even one evaluation (R14, level-hold.ts).
    if (this.acts()) await this.sweepLevelHolds(outdoorTempC, now);

    // Build views. (Nothing arms a learned hold here any more — the sub-floor
    // watch stopped being evidence on 2026-08-06; the amp-side armers all live
    // in the grading shell, which runs a full compressor ramp behind this.)
    const acs = this.buildViews(ctx, outdoorTempC, now);
    const onManaged = acs.filter((a) => a.on && a.managed && !a.shed);
    this.modeState = clearFloorsIfDone(this.modeState, {
      allConfirmedAtFloor: onManaged.every((a) => a.currentLevel > 0 && a.currentLevel <= floorOf(a)),
      anyRamping: onManaged.some((a) => a.ramping),
    });
    this.modeState = clearGridFullIfDone(this.modeState, {
      allConfirmedAtCeil: onManaged.every(
        (a) => a.currentLevel > 0 && a.currentLevel >= ceilOf(a, this.config.nearTargetBandC),
      ),
      anyShedPending: acs.some((a) => a.managed && a.shed && !a.on),
    });
    // SETTLING early exit (2026-08-08): end the settle window the moment the
    // meter has digested everything the last batch commanded — no commanded fall
    // still landing, and nothing owed on the spend side either (`rampDebitAmps`
    // folds in every ramping compressor and every live level/fan debit). It can
    // only ever SHORTEN the window; a slow level-cut wind-down keeps the clock.
    if (view.source !== "none") {
      this.modeState = clearSettleIfDone(
        this.modeState,
        {
          commandedCutTotalAmps: view.commandedCutTotalAmps,
          unabsorbedSpendAmps: rampDebitAmps(acs, view.smoothedAmps, this.config, view.source),
        },
        now,
      );
    }
    this.modeState = { ...this.modeState, collapsed: this.meterState.collapse != null };
    const mode = deriveMode(this.modeState, now);

    // Proactive projection for freshly-on managed ACs (near-limit turn-on): the
    // draw a compressor has committed that the meter has not absorbed yet.
    //
    // Priced two different ways, on purpose:
    //  - a room WE restored is priced with `restoreCostAmps` at the floor WE
    //    commanded, carrying the gentle flag, so the projection re-prices
    //    exactly what admission charged. The two disagreed on 2026-07-24→25
    //    (2.3A admitted, 3.7A projected) and every gen restore then declared
    //    itself over-limit and got shed ~10s later.
    //  - a USER/AUTOMATION turn-on is priced by `turnOnAmps` at the level the
    //    firmware actually came back at (`envelopeLevel` — the worst case of the
    //    shadow and anything in flight), because nobody chose that level.
    //    Pricing it at `floorOf()` assumed a gen floor policy that did not exist
    //    until today: live 05:51 Baghdad, Najat came back at L3 and this charged
    //    her on@L1 (2.86A), sizing the cut at 1.2A when the honest figure was
    //    4.6A. A 1.2A deficit the reducer could pay out of the newcomer alone is
    //    exactly why it never touched a peer.
    //
    //    `turnOnAmps`, NOT bare `steadyDraw`: the trip-safe max(model, learned
    //    on@L) is the whole point of the cost book here. Live 12:42 the same
    //    day, Najat came on at L1 and the projection took the model 2.3A while
    //    her learned on@L1 was 2.86A and the meter delivered 2.9A. The bare
    //    model draw is the PROBE price (`restoreCostAmps` gentle) and it belongs
    //    only to a restore WE admitted at that price — never to a turn-on nobody
    //    admitted at all.
    //
    // Held for the whole RAMP and ratcheted down as the meter absorbs the draw
    // (the same accounting as `rampDebitAmps`), because a single-tick projection
    // left Najat's real L3 draw unpriced for the next 100 seconds. Our own
    // clamp-to-floor does not shrink it early: `envelopeLevel` keeps charging L3
    // until the shadow confirms L1.
    //
    // Both conditions are load-bearing. `ramping` is what makes the draw
    // UNMETERED — past the ramp the meter has it, and charging on top would
    // double-count into a permanent phantom overload. The start window is what
    // keeps this scoped to turn-ons: `ramping` alone is re-armed for every
    // running AC on a changeover and on collapse recovery, and projecting the
    // whole house there would run the reducer instead of the entry policy.
    let projectedExtraAmps: number | undefined;
    if (view.source !== "none") {
      const source = view.source as Exclude<PowerSource, "none">;
      const starting = acs.filter(
        (a) =>
          a.on &&
          a.managed &&
          !a.shed &&
          a.ramping &&
          (a.startBaselineAmps != null || this.freshlyOn.includes(a.deviceId)),
      );
      if (starting.length > 0) {
        const committed = starting.map((ac) => {
          const ours = attemptedWithin(this.pacing, ac.deviceId, "restore", GRADE_TURN_ON_MS, now);
          return ours
            ? restoreCostAmps(this.book, this.config, ac.deviceId, source, floorOf(ac), ac.maxLevel, now, {
                gentle: this.fanHolds[ac.deviceId]?.gentle === true,
              }).amps
            : turnOnAmps(this.book, this.config, ac.deviceId, source, ac.envelopeLevel, ac.maxLevel, now).amps;
        });
        // ONE shared absorption pool, the same definition the raise path spends
        // against (2026-08-05). Two rooms starting together — the ordinary
        // changeover and the ordinary collapse recovery — used to cancel their
        // projections against the SAME whole-house rise independently, which on
        // this side under-states the projected overload and lets the reducer sit
        // still. Same amps, same physics, so it must be the same arithmetic.
        const absorbed = absorbedSharesAmps(
          starting.map((ac, i) => ({
            committedAmps: committed[i],
            baselineAmps: ac.rampBaselineAmps,
            ratchetAmps: ac.rampAbsorbedAmps,
          })),
          view.smoothedAmps,
        );
        projectedExtraAmps = committed.reduce((sum, c, i) => sum + Math.max(0, c - absorbed[i]), 0);
      }
    }

    // Measure the non-AC split BEFORE planning, so the envelope guard is judged
    // against the house this tick actually sees. `houseLoadResidual` decides on
    // its own whether the reading is usable (see house-load.ts) — but the shell
    // additionally holds off for the first cooldown after BOOT: device views
    // and amp models can be half-loaded on the first ticks, and the 2026-08-01
    // deploy's very first gen sample read 11.1A of "house" (real ~4.1A), an
    // over-blocking peak that stood until honest same-set samples outranked it.
    //
    // The DEAD-WINDOW flag is the opposite case, decided just above: with every
    // room power-cycled and no compressor yet drawing, the residual is not
    // under-measured, it is meaningless — and the meter is the house itself.
    //
    // It also holds off while ANY power_on is unconfirmed — ours or a user's.
    // `AcView.ramping` is `rampUntil > now && device.power`, and `device.power`
    // is the SHADOW, so the ramping guard inside house-load.ts does not cover
    // the send→confirm window at all: for those minutes the compressor draws
    // while the model still says the room is off, and the whole draw books as
    // house. Sweeping the TTL first means a send whose confirm never arrives
    // cannot starve sampling forever.
    if (this.firstTickAt == null) this.firstTickAt = now;
    for (const [deviceId, sentAt] of this.pendingOn) {
      if (now - sentAt >= UNCONFIRMED_SEND_TTL_MS) this.pendingOn.delete(deviceId);
    }
    if (view.source !== "none") {
      // Call EVERY tick with a live source so the modeled-drop detector's memory
      // advances even when the SAMPLE is suppressed (2026-08-08). A restore→shed
      // round trip completes entirely inside the unconfirmed-ON stand-down and
      // the compressor ramp; a memory frozen at the pre-restore total never sees
      // the re-shed's drop, so the first resumed sample booked the dying
      // compressor as house. `sampleSuppressed` carries the shell's own
      // stand-downs — the same set the old `if` guarded the CALL with — while the
      // memory and the cooldown advance regardless.
      this.houseLoad = sampleHouseLoad(this.houseLoad, {
        source: view.source,
        at: now,
        smoothedAmps: view.smoothedAmps,
        acs,
        config: this.config,
        // Every room power-cycled and still dead: the meter carries the house
        // and nothing else, so record it directly instead of a residual that
        // `max(0, …)` would floor at a fictitious zero.
        deadWindow: houseIsDirect,
        sampleSuppressed:
          view.sampleCount < 2 ||
          view.frozen ||
          this.pendingOn.size > 0 ||
          now - this.firstTickAt < HOUSE_SAMPLE_COOLDOWN_MS,
      });
    }

    const out = plan({
      now,
      config: this.config,
      mode,
      meter: view,
      acs,
      book: this.book,
      pacing: this.pacing,
      fanHolds: this.fanHolds,
      projectedExtraAmps,
      nonAcAmps: houseLoadAmps(this.houseLoad, view.source, now, acs),
      inFlight: (deviceId) => unconfirmedSends(this.recon, deviceId, now),
      fundingCooldown: (deviceId) => {
        const at = this.fundingDemotedAt.get(deviceId);
        return at != null && now - at < FUNDING_COOLDOWN_MS;
      },
      victimCooldown: (deviceId) => {
        const at = this.reducedAt.get(deviceId);
        return at != null && now - at < VICTIM_COOLDOWN_MS;
      },
      // The rooms are coming back from a dead circuit all at once — admit the
      // floor set on the envelope, because the meter has seen none of it yet.
      recoveryAdmission: now < this.recoveryAdmissionUntil,
      // A room's own shed left a hole in the meter; its restore is judged
      // against the meter BEFORE that hole, for as long as the shed can still
      // be blamed for a bounce (R9).
      shedBarAmps: (deviceId) => this.shedBarFor(deviceId, now),
      // The one proactive shed in flight house-wide — its receiver's amps stay
      // reserved until the restore lands (invariant 9).
      swapInFlight: this.swapInFlightFor(acs, now),
      // …and the ladder's own recent history, which no meter field carries.
      overLimitActedRecently:
        this.lastOverLimitActAt != null && now - this.lastOverLimitActAt < SWAP_QUIET_AFTER_OVER_MS,
      // …and the per-room flicker-patience anchor (invariant 58 follow-up): a
      // restore refused only by the flicker margin ages into a bare-ceiling
      // admission. The shell owns the map; the plan reports the refusals below.
      flickerRefusedSince: (deviceId) => this.flickerRefusedSince.get(deviceId),
    });
    this.fanHolds = out.fanHolds;

    // Flicker-patience anchors (invariant 58 follow-up): stamp a room refused
    // ONLY by the flicker margin this tick, and drop the anchor for any room the
    // raise phase stopped refusing — it restored, it now fits, or a different
    // refusal class took over. `out.flickerRefused` is attached only by returns
    // that RAN the raise phase; a tick that never got there (SETTLING after any
    // batch, an over-limit episode, FLOORS) reports nothing and must NOT break
    // the streak — SETTLING follows every batch, so wiping on it would restart
    // patience forever on a busy line. Runs here rather than in
    // `executeAndJournal` because a pure flicker refusal ships no command, and
    // that path returns before its bookkeeping.
    if (out.flickerRefused != null) {
      const flickerRefused = new Set(out.flickerRefused);
      for (const id of [...this.flickerRefusedSince.keys()]) {
        if (!flickerRefused.has(id)) this.flickerRefusedSince.delete(id);
      }
      for (const id of flickerRefused) {
        if (!this.flickerRefusedSince.has(id)) this.flickerRefusedSince.set(id, now);
      }
    }

    await this.executeAndJournal(out, view, mode, now, tcl, acs);
    this.lastStatus = this.buildStatus(acs, view, mode, out, now);

    // Opportunistic journal retention prune (once a day).
    if (now - this.lastPruneAt > 24 * 3_600_000) {
      this.lastPruneAt = now;
      void this.store.pruneJournal().catch(() => undefined);
    }
  }

  // ---------- internals ----------

  private async releaseHold(deviceId: string, reason: string): Promise<void> {
    if (this.fanHolds[deviceId] == null) return;
    this.fanHolds = releaseFanHold(this.fanHolds, deviceId);
    await this.pool.query("DELETE FROM ac_leveling_fan_hold WHERE device_id = $1", [deviceId]);
    log.info(`[leveler2] Fan hold released for ${this.deviceNames.get(deviceId) ?? deviceId} (${reason})`);
  }

  /**
   * How long this room has held CONTINUOUS satisfaction, for the loaded-spring
   * demote's dwell gate. Any reading above the threshold (or the AC going
   * off/shed/unmanaged) restarts the clock from zero.
   *
   * No explicit stale-temperature guard is needed here: `needDelta` is derived
   * upstream in `computeAcNeed`, which maps a missing or zero `currentTemp` to
   * delta 1 — comfortably ABOVE the demote threshold — so a dead room sensor
   * can never present as "satisfied". A stale-but-plausible cloud reading is
   * the only residual, and it is self-correcting and low-harm: the outcome is
   * an L1 cap (never an off), and the raise path lifts the room again within a
   * calm window once the feed recovers.
   */
  private satisfiedForMs(
    deviceId: string,
    needDelta: number,
    on: boolean,
    managed: boolean,
    shed: boolean,
    now: number,
  ): number {
    const threshold = this.config.nearTargetBandC - DEMOTE_HYSTERESIS_C;
    if (!on || !managed || shed || needDelta > threshold) {
      this.satisfiedSince.delete(deviceId);
      return 0;
    }
    const since = this.satisfiedSince.get(deviceId) ?? now;
    this.satisfiedSince.set(deviceId, since);
    return now - since;
  }

  /**
   * How long this room has sat below its comfort floor WITHOUT getting cooler.
   * Thin stateful wrapper over `nextSubFloorWatch` (needs.ts) — the logic
   * lives there, shared with the scenario harness, including the load-bearing
   * dead-sensor guard.
   */
  private subFloorStalledMs(
    deviceId: string,
    belowFloor: boolean,
    needDelta: number,
    tempKnown: boolean,
    on: boolean,
    managed: boolean,
    shed: boolean,
    now: number,
  ): number {
    const r = nextSubFloorWatch(this.subFloorSince.get(deviceId) ?? null, {
      active: on && managed && !shed,
      belowFloor,
      needDelta,
      tempKnown,
      now,
    });
    if (r.watch != null) this.subFloorSince.set(deviceId, r.watch);
    else this.subFloorSince.delete(deviceId);
    return r.stalledMs;
  }

  /**
   * The meter bar this room's own shed left, or 0 once it has aged out.
   *
   * Deliberately the SAME window as `ATTEMPT_BLAME_WINDOW_MS` rather than a new
   * constant: a shed inside that window is already treated as a restore's
   * failure, and this is the identical judgment read from the other end — is
   * this restore a bounce off that shed? One number, so the two halves of the
   * bounce cannot drift apart.
   *
   * What consumes it (hard rule 5c): the shed room's own draw leaving the meter
   * (seconds to minutes) PLUS the survivors finishing the duty cycle that makes
   * the trough look affordable. `PENDING_CUT_MS` (180 s) sizes only the first,
   * which is why the credit expiring was never the same thing as the trough
   * closing — live 2026-08-03, four restores of one room in 23 minutes, every
   * one admitted at a 9.5–12.5 A meter whose settled value was ~15 A.
   */
  /**
   * The proactive-shed trade still in flight, or null — and the place it is
   * retired.
   *
   * Two ways it ends, and only one of them is a clock: the receiver is BACK
   * (the trade did what it was for), or `SWAP_RESERVATION_MS` has passed
   * without it (the trade failed, and holding amps for a room that cannot take
   * them is the strand every reservation in this file is bounded against). A
   * source change clears it separately — see `clearOnSourceChange`.
   */
  private swapInFlightFor(acs: AcView[], now: number): { donorId: string; receiverId: string } | null {
    const swap = this.swap;
    if (swap == null) return null;
    const receiver = acs.find((a) => a.deviceId === swap.receiverId);
    if (receiver != null && receiver.on && !receiver.shed) {
      log.info(
        `[leveler2] Proactive shed complete: ${this.deviceNames.get(swap.receiverId) ?? swap.receiverId} ` +
          `is back on the amps ${this.deviceNames.get(swap.donorId) ?? swap.donorId} gave up`,
      );
      this.swap = null;
      return null;
    }
    if (now - swap.at > SWAP_RESERVATION_MS) {
      log.warn(
        `[leveler2] Proactive shed expired: ${this.deviceNames.get(swap.receiverId) ?? swap.receiverId} ` +
          `never fitted in ${(SWAP_RESERVATION_MS / 1000).toFixed(0)}s — reservation released`,
      );
      this.swap = null;
      return null;
    }
    return { donorId: swap.donorId, receiverId: swap.receiverId };
  }

  private shedBarFor(deviceId: string, now: number): number {
    const bar = this.shedBar.get(deviceId);
    if (bar == null) return 0;
    // Normally the blame window; while consecutive bounces stand it outlives its
    // clock for the room's compounded backoff (invariant 54 + the 2026-08-07
    // cycle), so the trough stays disbelieved instead of expiring into the next
    // re-admission. Bounded by `bounceBackoffMs`'s cap — nothing blocks unbounded.
    if (now - bar.at > barPersistMs(this.pacing, deviceId)) {
      this.shedBar.delete(deviceId);
      return 0;
    }
    // Less any peer removal since the bar was stamped (the bounce-bar release
    // valve — a genuinely smaller house is not the house that bounced).
    return Math.max(0, bar.amps - bar.credited);
  }

  /**
   * A peer's commanded/observed load removal shrinks the house every OTHER
   * BOUNCE-extended shed bar describes (invariant 54's peer-credit valve,
   * 2026-08-07). Priced by whatever the caller already handed the collapse
   * detector — no second pricing path. Scoped to bounce-persisting bars so an
   * ordinary bar (which expires at the blame window anyway) is byte-identical to
   * before, and never credits the room whose own removal this is.
   */
  private creditPeerShedBars(amps: number, except: ReadonlySet<string>, now: number): void {
    if (!(amps > 0)) return;
    for (const [id, bar] of this.shedBar) {
      if (except.has(id)) continue;
      if (restoreBounces(this.pacing, id) < 1) continue;
      if (now - bar.at > barPersistMs(this.pacing, id)) continue;
      bar.credited += amps;
    }
  }

  /**
   * The last outdoor reading, if it is still fresh enough to key a hold on.
   * Same ≤10-min contract `levelBoosts` works to; an older one is not a
   * statement about the weather the compressor is failing in.
   */
  private freshOutdoorC(now: number): number | null {
    return this.lastOutdoorC != null && now - this.lastOutdoorAt <= OUTDOOR_FRESH_MS
      ? this.lastOutdoorC
      : null;
  }

  /**
   * Record (or renew) the learned non-cooling hold for a room — R14, the user's
   * own rule, 2026-08-04: "when the system observe that abdullah is not working
   * on l1 (by own observation or manual raise), it should state the outside
   * temp, so it will never reduce the level to l1 untill it drop below that
   * temp or after [6] h".
   *
   * `outdoorC` is the same ≤10-min-fresh feed `levelBoosts` reads. Without a
   * reading there is no `T_obs` to key the hold on, and a hold with no
   * temperature bar is just a six-hour ban — so we decline to record and say so.
   * The evidence recurs every tick the room keeps failing, so nothing is lost
   * but the ticks the station was down for.
   */
  private async noteLevelHold(
    deviceId: string,
    level: number,
    outdoorC: number | null,
    now: number,
    why: string,
  ): Promise<void> {
    const name = this.deviceNames.get(deviceId) ?? deviceId;
    if (outdoorC == null) {
      log.info(`[leveler2] ${name}: L${level} looks non-cooling (${why}) but the outdoor feed is stale — no hold recorded`);
      return;
    }
    const prev = this.levelHolds.get(deviceId) ?? null;
    const next = recordLevelHold(prev, { level, outdoorC, observedAt: now });
    const unchanged =
      prev != null && prev.level === next.level && prev.outdoorC === next.outdoorC && prev.observedAt === next.observedAt;
    if (unchanged) return;
    this.levelHolds.set(deviceId, next);
    await this.store.upsertLevelHold(deviceId, next).catch((err) => {
      log.warn(`[leveler2] level hold persist failed for ${name}: ${String(err)}`);
    });
    if (prev == null || prev.outdoorC !== next.outdoorC) {
      log.warn(`[leveler2] ${name}: ${levelHoldDetail(next)} (${why})`);
    }
  }

  /**
   * Retire holds the weather or the clock has released. Runs each tick, before
   * the views are built, so a released hold never governs the ladder for even
   * one evaluation — and the DB row goes with it, because a stale row loaded
   * after a restart would resurrect a hold the weather already answered.
   */
  private async sweepLevelHolds(outdoorTempC: number | null, now: number): Promise<void> {
    for (const [deviceId, hold] of [...this.levelHolds]) {
      if (levelHoldLive(hold, outdoorTempC, now)) continue;
      this.levelHolds.delete(deviceId);
      await this.store.deleteLevelHold(deviceId).catch(() => undefined);
      log.info(
        `[leveler2] ${this.deviceNames.get(deviceId) ?? deviceId}: learned L${hold.level} hold released ` +
          (now >= levelHoldExpiresAt(hold)
            ? `(${(LEVEL_HOLD_TTL_MS / 3_600_000).toFixed(0)}h since the observation)`
            : `(outdoor ${outdoorTempC?.toFixed(1) ?? "?"}°C is back under ${hold.outdoorC.toFixed(1)}°C)`),
      );
    }
  }

  // ⚠ REMOVED 2026-08-06: `noteLevelHoldEvidence`, which armed the learned L1
  // hold from the sub-floor WATCH (`SUBFLOOR_WATCH_MS` of no cooling progress).
  // The user's decision, verbatim: "it is so normal that we see no cooling
  // progress in all rooms for a long time, even with L3, so this should not be
  // considered. However, we have to depend on Amps — if it draws only about 1
  // amp, only the fan is working, no compressor."
  //
  // Live 2026-08-06 02:15:29, the shape that killed it: Abdullah had been
  // demoted to L1 at 02:12:20 *for being satisfied for twenty minutes*, and a
  // room at target can never show the 0.2°C of further cooling that re-bases the
  // watch — so the verdict was true by construction of the state that produced
  // it. The hold armed, re-armed at 02:35:21, and raised him L1→L2 at 02:36:42
  // during a 15 A generator episode; those 1.5–1.9 A are what made restoring the
  // hotter room (4.3 A) infeasible until 02:49.
  //
  // The remaining armers are all ATTRIBUTABLE: the graded lone off-drop
  // (`noteOffDrop`), the dead window, and a manual raise off L1 (dashboard
  // `onUserGenLevel`, or observed externally). Any NEW call site must be
  // attributable in the same sense — which is the bar the graded lone RAISE
  // (`noteLoneRaiseRise`) failed on review the day it was written: its rise is a
  // whole-house delta with no non-AC load subtracted, so a household step inside
  // the window is indistinguishable from a compressor. It reports and arms
  // nothing.

  /** Live turn-on start baseline for a device, or null once the window closed. */
  private startBaselineFor(deviceId: string, on: boolean, now: number): number | null {
    const open = this.startBaseline.get(deviceId);
    if (open == null) return null;
    if (!on || open.until <= now) {
      this.startBaseline.delete(deviceId);
      return null;
    }
    return open.amps;
  }

  private buildViews(ctx: LevelerDeviceContext[], outdoorTempC: number | null, now: number): AcView[] {
    const rank = (id: string): number => {
      const i = this.config.priority.indexOf(id);
      return i === -1 ? this.config.priority.length : i;
    };
    const sorted = [...ctx].sort((a, b) => rank(a.device.id) - rank(b.device.id));
    const comfortTargetC = this.config.comfortTargetC;
    return sorted.map(({ device, managed, needDelta, slotGenCap }) => {
      const boost = boostFloor(
        this.config.levelBoosts[device.id],
        outdoorTempC,
        this.boostZone.get(device.id) ?? "none",
      );
      this.boostZone.set(device.id, boost.zone);
      // R14 LEARNED hold. What the CONFIG says (boost) and what this house has
      // OBSERVED (hold) are independent statements about the same room, so the
      // stricter one governs — `max`, never a replacement. The hold extends the
      // configured floor's hardness BELOW its threshold on evidence: the user
      // picked 39°C for a compressor whose real failure point moves, and a room
      // that demonstrably will not cool at L1 at 36°C must not be sent there at
      // 36°C just because the configured band has not armed yet.
      //
      // ⚠ Manual still wins in BOTH directions (invariant 42): `floorOf` clamps
      // to `manualTarget`/`manualCap`, so a user who pins L1 under a live hold
      // gets L1 and the sub-floor rung back. Declining is his to do.
      const maxLevel = device.maxGeneratorLevel || 3;
      const holdFloor = levelHoldFloor(this.levelHolds.get(device.id) ?? null, outdoorTempC, now, maxLevel);
      const recon = this.recon[device.id];
      const ramping = (this.rampUntil.get(device.id) ?? 0) > now && device.power;
      // During settle the shadow reflects the pre-command state — use pending.
      const observed = deriveMode(this.modeState, now) === "SETTLING" && recon?.pendingLevel != null
        ? recon.pendingLevel
        : device.generatorMode;
      // R13 — the one figure every ROOM-vs-ROOM comparison ranks on. Asked of
      // every room in the same unit: its OWN thermometer against the shared
      // comfort target, inverted in heat mode exactly as `computeAcNeed` does
      // it, so ordering by this IS ordering by real room temperature. The
      // per-room `needDelta` keeps whatever metric that room's automation is
      // configured for — including feels-like, which is a fine answer to "is
      // this room comfortable?" and a useless one to "which room is cooler?".
      // Dead thermometer (the 86f8696 rule: absent or ≤0 is not a reading) →
      // fall back to `needDelta`, which is exactly the old ordering.
      //
      // The per-AC `tempOffsetC` IS applied here: it is a calibration of that
      // room's SENSOR, so a room whose thermometer reads 1°C high is 1°C cooler
      // in every room-vs-room comparison too, and leaving it out would rank the
      // rooms on readings taken with differently-biased instruments. The other
      // half of the override — `targetFromSetpoint` — is deliberately NOT read
      // here: which room is cooler is not that room's own business (R13/50), so
      // the rank must keep asking every room the one shared question, its own
      // thermometer against `comfortTargetC`. A per-room setpoint preference
      // belongs to that room's absolute need (`computeAcNeed`), never to the
      // ordering that decides whose amps get taken.
      const rawTempC = device.currentTemp != null && device.currentTemp > 0 ? device.currentTemp : null;
      const roomTempC =
        rawTempC == null ? null : rawTempC + (this.config.needOverrides[device.id]?.tempOffsetC ?? 0);
      const rankNeedDelta =
        roomTempC == null
          ? needDelta
          : device.mode === 4
            ? comfortTargetC - roomTempC
            : roomTempC - comfortTargetC;
      return {
        deviceId: device.id,
        name: device.name,
        on: device.power,
        managed,
        shed: this.shedIds.has(device.id),
        maxLevel: device.maxGeneratorLevel || 3,
        currentLevel: observed,
        // Envelope pricing charges for every level the firmware might be at:
        // the confirmed shadow OR any level we sent and never saw confirm.
        // `currentLevel` deliberately stays observation-only (see AcView).
        envelopeLevel: worstCaseLevel([observed, ...unconfirmedLevels(this.recon, device.id, now)]),
        fanSpeed: device.fanSpeed ?? null,
        fanExempt: this.fanExempt.has(device.id),
        needDelta,
        roomTempC,
        rankNeedDelta,
        satisfiedForMs: this.satisfiedForMs(
          device.id,
          needDelta,
          device.power,
          managed,
          this.shedIds.has(device.id),
          now,
        ),
        // Judged on the OBSERVED level against the boost floor — a level we
        // sent but the firmware has not confirmed is not yet a room that is
        // failing to cool.
        //
        // Against `watchMinLevel`, not the ACTIVE floor: the watch arms
        // `BOOST_WATCH_BELOW_C` before the floor does, so a room can be caught
        // failing at L1 while L1 is still its legitimate floor (user,
        // 2026-08-04: "starting from 3 degrees below that temp and above").
        // That is the earliest the evidence exists, and evidence is what the
        // raise path needs to lift the room before the heat arrives.
        //
        // The learned hold joins the watch minimum too: once a hold makes L1
        // sub-floor for a room with no configured boost at all, that room must
        // still be watched at L1 — otherwise the only evidence that could renew
        // (or contradict) the hold stops being gathered the moment it arms.
        subFloorStalledMs: this.subFloorStalledMs(
          device.id,
          observed >= 1 && observed < Math.max(boost.watchMinLevel, holdFloor),
          needDelta,
          // computeAcNeed's dead-sensor sentinel is delta 1 — see the guard.
          device.currentTemp != null && device.currentTemp > 0,
          device.power,
          managed,
          this.shedIds.has(device.id),
          now,
        ),
        // R6 — the METER's answer to "is this compressor running", from the two
        // attributable sources: a graded lone off that measured about a fan (at
        // or below the level it was measured at — the evidence says nothing
        // about a level the room has since climbed to), and a power-event ramp
        // held open past its timer because nothing has been absorbed.
        compressorOffLikely:
          device.power &&
          managed &&
          !this.shedIds.has(device.id) &&
          (this.powerEventRamp.get(device.id)?.heldSince != null ||
            (() => {
              const seen = this.compressorOff.get(device.id);
              return seen != null && seen.source === this.meterState.source && observed >= 1 && observed <= seen.level;
            })()),
        minLevel: Math.max(boost.minLevel, holdFloor),
        // Hard in EITHER form: the configured band past its flex (R14-hard), or
        // a live learned hold (R14-learned). Both say the same thing about the
        // same room — below this floor the compressor does not engage — and a
        // level the search can still enumerate is not a "never" (19ac1ba).
        boostFloorHard: boost.hard || holdFloor > 1,
        manualCap: this.manualCap.get(device.id) ?? null,
        manualTarget: this.manualTarget.get(device.id) ?? null,
        slotCap: slotGenCap,
        reachableCap: reachableCapOf(this.recon, device.id, device.maxGeneratorLevel || 3),
        warmStartLevel: this.rememberedLevel.get(device.id) ?? null,
        ramping,
        rampBaselineAmps: ramping ? (this.rampBaseline.get(device.id) ?? null) : null,
        rampAbsorbedAmps: ramping ? (this.rampAbsorbed.get(device.id) ?? null) : null,
        startBaselineAmps: this.startBaselineFor(device.id, device.power, now),
        unmeteredJumpAmps: this.unmeteredJumpAmps(device.id, now),
        reshedPenalized: reshedPenalized(this.pacing, device.id, now),
        // A human turned this room on within the shield window → the proactive
        // swap may not pick it as a donor (invariant 42/57).
        recentlyExternalOn: now < (this.externalOnAt.get(device.id) ?? 0) + EXTERNAL_ON_DONOR_SHIELD_MS,
      };
    });
  }

  /**
   * Durable trace for evaluations that commanded NOTHING. Without this a
   * "restore blocked by calm / backoff / no headroom" tick leaves no record at
   * all — `getStatus().decisions` keeps only the last 20 in memory, and docker
   * logs rotate in ~1.5 days, so "why was that room never restored?" became
   * unanswerable after a restart (2026-07-25). Throttled hard: at most one row
   * per (device, blockedBy) per BLOCKED_JOURNAL_THROTTLE_MS, so a room blocked
   * for an hour costs ~12 rows instead of ~720.
   */
  private async journalBlocked(
    out: PlanOutput,
    view: ReturnType<typeof meterView>,
    mode: Mode,
    now: number,
  ): Promise<void> {
    const fresh = out.decisions.filter((d) => {
      if (d.blockedBy == null) return false;
      const key = `${d.deviceId ?? "-"}|${d.blockedBy}`;
      if (now - (this.lastBlockedJournalAt.get(key) ?? 0) < BLOCKED_JOURNAL_THROTTLE_MS) return false;
      this.lastBlockedJournalAt.set(key, now);
      return true;
    });
    if (fresh.length === 0) return;
    await this.store
      .insertJournal({
        at: now,
        source: view.source,
        mode,
        severity: out.severity,
        reason: "blocked",
        requiredAmps: out.requiredAmps,
        preAmps: view.smoothedAmps,
        commands: [],
        decisions: fresh,
        expectedDelta: null,
        executed: this.acts(),
      })
      .catch(() => undefined);
  }

  private async executeAndJournal(
    out: PlanOutput,
    view: ReturnType<typeof meterView>,
    mode: Mode,
    now: number,
    tcl: NonNullable<ReturnType<LevelingDeps["getTclCloud"]>>,
    /** The views this plan was built from — the pre-command fan/level picture. */
    acs: AcView[],
  ): Promise<void> {
    if (out.commands.length === 0) {
      await this.journalBlocked(out, view, mode, now);
      return;
    }

    // Send-side dedupe: unconfirmed same-level re-sends respect the spacing.
    //
    // Levels have had this since the reconciler shipped; fans and offs had
    // nothing, and two evaluations landing back-to-back sent the same command
    // twice. Live 2026-08-02 17:51:21 sent an identical `set_fan 5` twice 200ms
    // apart, and 16:55:34/:35 shed two rooms one second apart. The scheduling
    // race is fixed upstream (collector `runLevelingCheck`); this is the
    // last-resort guard on the wire, where the level path already had one.
    //
    // Deliberate exemptions: a fan HOLD's staged resend goes through
    // `fanResendDue`, not here, and a shed of a device not already in `shedIds`
    // is a first send.
    const commands: Command[] = out.commands.filter((cmd) => {
      if (cmd.kind === "set_level") return shouldSendLevel(this.recon, cmd.deviceId, cmd.level, now);
      if (cmd.kind === "set_fan" && cmd.reason === "trim") {
        const last = this.lastFanSent.get(cmd.deviceId);
        return !(last != null && last.fan === cmd.fan && now - last.at < FAN_RESEND_SPACING_MS);
      }
      if (cmd.kind === "power_off") {
        const last = this.lastOffSentAt.get(cmd.deviceId);
        return !(this.shedIds.has(cmd.deviceId) && last != null && now - last < SHED_RESEND_SPACING_MS);
      }
      return true;
    });
    if (commands.length === 0) {
      // Everything was a duplicate of something already in flight. That is a
      // real decision and it must leave a trace: `journalBlocked` only writes
      // rows for decisions carrying `blockedBy`, and a reduce plan's own
      // decision carries none — so this path could return in complete silence,
      // leaving the leaky bucket empty, the urgent trigger re-firing on every
      // reading, and a hole in the only forensic surface there is.
      await this.journalBlocked(
        {
          ...out,
          decisions: [
            ...out.decisions,
            {
              at: now,
              action: out.reason,
              blockedBy: "duplicate send",
              detail: out.commands
                .map((c) => `${c.kind}${"level" in c ? `:${c.level}` : ""}@${c.deviceId}`)
                .join(" "),
            },
          ],
        },
        view,
        mode,
        now,
      );
      // The bucket bookkeeping is owed either way: the amps this plan wanted are
      // already commanded, so treat the pass as handled rather than letting it
      // re-fire on the next reading for the rest of the episode.
      if (out.severity != null) this.meterState = refillBucket(this.meterState, OVER_LIMIT_BUDGET_AFTER_ACT);
      return;
    }

    const journalId = await this.store
      .insertJournal({
        at: now,
        source: view.source,
        mode,
        severity: out.severity,
        reason: out.reason,
        requiredAmps: out.requiredAmps,
        preAmps: view.smoothedAmps,
        commands,
        decisions: out.decisions,
        expectedDelta: out.expectedDeltaAmps || null,
        executed: this.acts(),
      })
      .catch((err) => {
        log.warn(`[leveler2] journal insert failed: ${String(err)}`);
        return -1;
      });

    if (!this.acts()) return; // shadow: journal only

    let sentAny = false;
    let fanOnly = true;
    /** A fan-only batch that SPENT (restore) rather than freed (trim). */
    let spentOnFan = false;
    /** Commands the cloud REFUSED, priced out of the credit below, because a
     *  command that never left is a fall that never happens. */
    const failedCommands: Command[] = [];
    /** …and the ones that never got the chance (see the abort below). */
    const skippedCommands: Command[] = [];
    /**
     * Does this command ADD load? The same judgment the grading shell makes,
     * from the same reconciler figures the emission reads, so the two cannot
     * drift: `power_on` always adds, a `set_level` adds only above the confirmed
     * level, a fan restore adds, a trim and an off do not. An UNKNOWN level
     * counts as adding, which is the trip-safe answer for the abort below.
     */
    const addsLoad = (cmd: Command): boolean =>
      batchLoadDirections([cmd], (id) => {
        const confirmed = this.recon[id]?.confirmedLevel ?? null;
        // Level 0 is UNRESTRICTED draw, which `steadyDraw`/`worstCaseLevel` price
        // as the TOP level, so the never-level-0 recap (hard rule 5) is a
        // REMOVAL, not an add, and must ship even when a peer's cut was refused.
        // Read numerically it looks like 0 → L1 = adding, and the abort below
        // would leave a managed AC unrestricted on a generator, which is the one
        // state that rule forbids outright.
        //
        // Mapped HERE and not in `batchLoadDirections`: the grading shell shares
        // that function, where the numeric reading answers a different question
        // (which way did this batch move the meter, for contamination), and
        // changing it is its own piece of work.
        return confirmed === 0 ? (this.deviceMaxLevel.get(id) ?? 3) : confirmed;
      }).adds;
    for (const cmd of commands) {
      const name = this.deviceNames.get(cmd.deviceId) ?? cmd.deviceId;
      /**
       * A batch is one arithmetic, not a list of independent wishes: the funding
       * demote pays for the raise beside it, the swap donor's off pays for the
       * receiver's turn-on (invariants 9/69), and a restore's peer floor-downs
       * pay for the room coming back. If a cut is refused by the cloud, the
       * budget the ADD was admitted against does not exist, so sending it anyway
       * puts load on a line nobody freed.
       *
       * Only the ADDING half is abandoned. Skipping the remaining CUTS would be
       * the unsafe direction on an over-limit batch, where every one of them is
       * relief the breaker is waiting for.
       */
      if (failedCommands.length > 0 && addsLoad(cmd)) {
        skippedCommands.push(cmd);
        log.warn(`[leveler2] ${name}: skipped (${cmd.kind}): the cut that funded it was refused`);
        continue;
      }
      /**
       * The SEND, and only the send. Everything after it is bookkeeping about a
       * command the cloud has already accepted, and a failure there is not a
       * refusal: if `recordShed`'s INSERT throws after an accepted `power_off`,
       * treating the off as refused credits nothing, aborts the rest of the
       * batch, and leaves the real cliff unexplained, which is how a commanded
       * shed latches a phantom collapse (invariant 5, the 2026-07-28 shape).
       * Worse, `recordShed` has already put the room in `shedIds`, so the
       * observed-off path would not credit it either.
       */
      try {
        switch (cmd.kind) {
          case "set_level":
            await tcl.sendControl(cmd.deviceId, "set_generator_mode", cmd.level);
            break;
          case "power_off":
            await tcl.executeAcAction(cmd.deviceId, { power: 0 });
            break;
          case "power_on":
            await tcl.executeAcAction(cmd.deviceId, {
              power: 1,
              generator_mode: cmd.level,
              ...(cmd.fan != null ? { fan_speed: cmd.fan } : {}),
            });
            break;
          case "set_fan":
            await tcl.sendControl(cmd.deviceId, "set_fan_speed", cmd.fan);
            break;
        }
      } catch (err) {
        failedCommands.push(cmd);
        log.warn(`[leveler2] command failed for ${name}: ${String(err)}`);
        continue;
      }
      // Accepted by the cloud. From here the command COUNTS: for the credit, for
      // `sentCommands`, and for the abort above, whatever the bookkeeping below
      // manages to do.
      sentAny = true;
      if (cmd.kind !== "set_fan") fanOnly = false;
      try {
        switch (cmd.kind) {
          case "set_level": {
            const noted = noteLevelSend(this.recon, cmd.deviceId, cmd.level, now);
            this.recon = noted.state;
            // First send of a run nobody has answered yet — the clock the
            // entry-collapse evidence reads (see `unansweredSince`).
            if (!this.unansweredSince.has(cmd.deviceId)) this.unansweredSince.set(cmd.deviceId, now);
            this.armJumpDebit(cmd.deviceId, cmd.level, view, now);
            if (noted.marked) {
              log.warn(`[leveler2] ${name}: firmware never confirmed L${cmd.level} after ${4} sends — marked unreachable, falling back to L${noted.fallback}`);
            }
            log.info(`[leveler2] ${name}: gen level → L${cmd.level} (${out.reason})`);
            break;
          }
          case "power_off": {
            this.lastOffSentAt.set(cmd.deviceId, now);
            // Whatever ON we were still waiting to confirm is now overtaken.
            this.pendingOn.delete(cmd.deviceId);
            // A shed must be LOUD (hard rule 2's spirit), and a PROACTIVE shed
            // must additionally say who it was for — the user reads this push
            // and this journal, and "to protect the breaker" would be a lie
            // about a room switched off while the line was calm.
            const forReceiver = out.swap?.donorId === cmd.deviceId ? out.swap.receiverId : null;
            const receiverName =
              forReceiver == null ? null : (this.deviceNames.get(forReceiver) ?? forReceiver);
            await this.recordShed(
              cmd.deviceId,
              receiverName != null
                ? `swapped off on ${view.source} so ${receiverName} could run`
                : `over ${effectiveLimit(this.config, view.source === "none" ? "gen" : view.source, view.derateAmps)}A on ${view.source}`,
            );
            await this.releaseHold(cmd.deviceId, "shed");
            this.deps.setDevicePowerCache(cmd.deviceId, "off");
            await this.pushNotice(
              receiverName != null
                ? `AC ${name} turned off so the hotter room (${receiverName}) can run`
                : `AC ${name} turned off to protect the ${view.source} breaker`,
              true,
            );
            log.warn(`[leveler2] Shed AC ${name} (${out.reason})`);
            break;
          }
          case "power_on": {
            // Shed stays SET until the shadow confirms the ON (structural flip
            // in tick()). Clearing at send time opened a lag window where the
            // collector saw an un-shed device still OFF and minted a bogus
            // manual-off `observed_off` lock (live 2026-07-27 17:15:53 — 5.8s
            // after this very command; TCL shadows can lag minutes). While
            // shed, every observed-off recorder and auto-on path keeps
            // skipping the device, however long the shadow lags.
            this.deps.setDevicePowerCache(cmd.deviceId, "on");
            // The compressor starts now; the shadow confirms later. Until it
            // does, this room's draw is on the meter but not in the model, so
            // no house sample taken in that window is usable.
            this.pendingOn.set(cmd.deviceId, now);
            this.recon = noteLevelSend(this.recon, cmd.deviceId, cmd.level, now).state;
            if (cmd.fan != null) {
              // Gentle restore: the room came back with its fan pinned. A hold is
              // already in this.fanHolds (tick() assigned out.fanHolds before this
              // call). Register the fan send with the reconciler + collector so the
              // range automation treats it as ours, not a user change, and persist.
              this.recon = noteFanSend(this.recon, cmd.deviceId, cmd.fan, now);
              this.deps.onLevelerFanCommand(cmd.deviceId, cmd.fan);
              await this.persistFanHold(cmd.deviceId);
            }
            this.rearmRamp([cmd.deviceId]);
            await this.pushNotice(
              `AC ${name} restored at gen level ${cmd.level}${cmd.fan != null ? ` (fan ${cmd.fan})` : ""}`,
              false,
            );
            log.info(`[leveler2] Restored shed AC ${name} @L${cmd.level}${cmd.fan != null ? ` fan ${cmd.fan}` : ""}`);
            break;
          }
          case "set_fan": {
            // `acs` is the snapshot the plan was built from, so this reads the
            // same gear the admission priced (the send above cannot change it).
            const priorFan = acs.find((a) => a.deviceId === cmd.deviceId)?.fanSpeed ?? null;
            // The dedupe key is only meaningful while the fan has not moved
            // since. A restore (or any other gear) makes the old key a lie —
            // without clearing it, a trim to the same gear the restore just
            // undid was suppressed for the rest of the 30s window.
            if (cmd.reason === "trim") this.lastFanSent.set(cmd.deviceId, { fan: cmd.fan, at: now });
            else this.lastFanSent.delete(cmd.deviceId);
            this.recon = noteFanSend(this.recon, cmd.deviceId, cmd.fan, now);
            this.deps.onLevelerFanCommand(cmd.deviceId, cmd.fan);
            await this.persistFanHold(cmd.deviceId);
            if (cmd.reason === "trim_restore") {
              // A restore SPENDS. Charge it, and rewind the calm clock so the
              // next tick cannot admit a raise against a meter that has not
              // shown these amps yet (2026-07-31: two raises, 12s and 17s after
              // a fan restore, on the same headroom the fan had already taken).
              // A fan CUT deliberately does neither — it frees amps, and
              // stalling the reducer behind its own cut is how episodes drag.
              this.armFanDebit(cmd.deviceId, priorFan, cmd.fan, view, now);
              spentOnFan = true;
            }
            // Accepted: the hold releases on SEND of the original-fan restore,
            // not on shadow confirm. The reconciler keeps re-sending an
            // unconfirmed fan while the hold lives, so an ignored final send is
            // recovered by at most one resend cycle; a confirm-gated release is
            // a deferred post-cutover cleanup (not worth the extra state here).
            if (cmd.reason === "trim_restore" && this.fanHolds[cmd.deviceId]?.originalFan === cmd.fan) {
              await this.releaseHold(cmd.deviceId, "restored");
            }
            log.info(`[leveler2] ${name}: fan → ${cmd.fan} (${cmd.reason})`);
            break;
          }
        }
      } catch (err) {
        // The command IS out. Losing its bookkeeping is bad on its own terms (no
        // shed row means confirm-or-resend has nothing to resend; no jump debit
        // under-charges the next spender), so say so as loudly as this file says
        // anything, and let the command keep counting as sent.
        log.error(
          `[leveler2] ${name}: ${cmd.kind} was ACCEPTED by the cloud but its bookkeeping failed: ` +
            `${String(err)}. The command still counts as sent.`,
        );
      }
    }
    if (skippedCommands.length > 0) {
      log.warn(
        `[leveler2] skipped ${skippedCommands.length} load-adding command(s) after a failed cut: ` +
          skippedCommands.map((c) => `${this.deviceNames.get(c.deviceId) ?? c.deviceId}:${c.kind}`).join(", "),
      );
    }
    if (!sentAny) return;

    /**
     * What this batch really commanded off the line: the plan's priced saving
     * LESS anything the cloud refused. `sentAny` is a coarse gate: a two-cut
     * batch whose second send throws used to credit BOTH, so the meter was told
     * to expect a fall that half of it will never make, and (since 2026-08-31)
     * a spender could be funded out of the half that never happened.
     *
     * Priced with the same function every plan branch prices with, so a fully
     * sent batch is byte-identical to `out.commandedCutAmps` and this arithmetic
     * only ever runs on the failure path. ⚠ The FLOORS branch deliberately
     * credits its `power_off` commands ONLY (the entry clamps are excluded on
     * purpose; see the pipeline's floors comment), so a failed clamp there must
     * not be subtracted from a credit it was never part of.
     */
    /** What actually went out: neither refused by the cloud nor abandoned above. */
    const sentCommands = commands.filter(
      (c) => !failedCommands.includes(c) && !skippedCommands.includes(c),
    );
    const uncreditedFailures =
      out.reason === "floors" ? failedCommands.filter((c) => c.kind === "power_off") : failedCommands;
    const commandedCutAmps =
      uncreditedFailures.length === 0
        ? out.commandedCutAmps
        : Math.max(
            0,
            out.commandedCutAmps -
              commandedCutAmpsOf(uncreditedFailures, acs, this.config, view.source, this.book, now),
          );
    if (commandedCutAmps < out.commandedCutAmps) {
      log.warn(
        `[leveler2] ${failedCommands.length} command(s) failed, crediting ${commandedCutAmps.toFixed(1)}A ` +
          `of the ${out.commandedCutAmps.toFixed(1)}A this batch planned to command off`,
      );
    }

    this.modeState = noteBatch(this.modeState, { fanOnly }, now);
    // A non-fan batch (raise/restore/swap/correction) rewinds BOTH calm anchors;
    // a fan-only SPEND rewinds only the MAIN clock and spares the fan path's own
    // (2026-08-09, the 16:22Z gen cycle #11098-#11126). The main-clock rewind is
    // still what keeps a level raise from landing on the amps the fan just took
    // (invariant 18: two fatal raises 12s/17s after a fan restore); sparing the
    // fan clock is what stops a fan hold's first gear queueing behind another
    // hold's fan step. A fan CUT (fanOnly && !spentOnFan) frees amps and rewinds
    // neither — exactly as before.
    if (!fanOnly) this.meterState = resetCalm(this.meterState);
    else if (spentOnFan) this.meterState = resetCalm(this.meterState, { fanSpend: true });
    // Tell the meter what we just took OFF the line. A shed's compressor stops
    // anywhere from seconds to minutes after the send, so the drop arrives as
    // one cliff with nothing tying it to us — and a cliff past the collapse
    // floor is indistinguishable from a breaker trip (live 2026-07-28 07:23).
    //
    // `commandedCutAmps` is the SINGLE source for this credit: it is populated
    // by every batch shape that lowers load (reducer, demote, funding swap, and
    // the peer floor-downs bundled into a restore), priced at the model steady
    // delta. It replaced the old `expectedDeltaAmps < 0` test, which silently
    // missed every batch reporting a net delta of 0 — i.e. exactly the mixed
    // batches where cuts and a turn-on cancel out on paper.
    if (commandedCutAmps > 0) {
      // SPENDABLE only for the IDLE DEMOTE (invariant 8): a satisfied room
      // handing back dormant capacity on a calm line is the one batch shape of
      // ours whose freed amps nothing else has a claim on. Every other shape's
      // are already spoken for: an over-limit reduction's belong to the breaker
      // (spending them is a cut → raise → cut cycle), a FLOORS clamp's to the
      // entry policy, and a restore's peer floor-downs or a swap's donor off are
      // paying for the turn-on in their own batch (invariant 69).
      const spendable = out.reason === "demote";
      this.meterState = noteCommandedCut(this.meterState, commandedCutAmps, now, { spendable });
      // …and the demote is the only one worth an urgent evaluation, for the same
      // reason (2026-08-31). The next evaluation (≥ 2.5 s away, never this one,
      // since `runLevelingCheck` drops a re-run queued inside
      // `LEVELING_RERUN_MIN_MS` while this pass is still running) can fund a
      // spender out of the credit just armed instead of waiting out the whole
      // settle window plus the next scheduled tick. Live shape it answers: a
      // demote → the peer's cut fan took ~130–160 s to start climbing.
      //
      // ⚠ NOT for the other cutting shapes. Their credit is not spendable, so the
      // extra pass can buy nothing, and a "Budget freed" line seconds after an
      // emergency shed would tell the next forensic session the opposite of what
      // happened. The reduce side already has its own urgent trigger (the drained
      // over-limit bucket).
      if (spendable) {
        this.noteBudgetFreed(`${out.reason} batch commanded ${commandedCutAmps.toFixed(1)}A off`);
      }
    }
    // Belt to house-load's own modeled-drop detector (2026-08-08): a commanded
    // OFF is a room leaving — a modeled drop the meter follows over the
    // compressor wind-down — so pause house sampling here too. Should the
    // tick-by-tick detector's memory ever be starved again (a restore→shed round
    // trip once completed entirely inside a sampling stand-down and booked the
    // dying compressor as house), the residual still cannot be sampled until the
    // fall lands. Scoped to `power_off`: a fan trim also lowers load but never
    // drops the MODEL, so it is not the drop this cooldown exists to cover — and
    // arming on it would newly pause sampling the detector never paused for.
    if (view.source !== "none" && commands.some((c) => c.kind === "power_off")) {
      this.houseLoad = armDropCooldown(this.houseLoad, view.source, now);
    }
    // A turn-on changes the load picture wholesale: over-limit readings banked
    // BEFORE it are no longer evidence about the house that exists now, and
    // letting them carry over meant a restore inherited a half-drained bucket
    // and tripped on its own inrush (2026-07-25). Protection kept, carry-over
    // removed: from full, a genuine post-restore overload still empties the
    // bucket on the ceil(N/3)-th severe reading or the N-th mild one at the
    // configured capacity N (4 to 20, default 5), and the post-act refill stays
    // a fixed 4 points, which is a FULL bucket at the minimum capacity.
    if (commands.some((c) => c.kind === "power_on")) {
      this.meterState = refillBucket(this.meterState, this.config.overLimitBudgetPoints);
    }
    if (out.reason.startsWith("over")) {
      // The ladder acted: the comfort trade owes the house a quiet window that
      // outlives every meter-level signal of this episode.
      this.lastOverLimitActAt = now;
      // PARTIAL — see OVER_LIMIT_BUDGET_AFTER_ACT. A reduction that did not go
      // deep enough must be allowed to escalate in seconds, not in another
      // five readings.
      this.meterState = refillBucket(this.meterState, OVER_LIMIT_BUDGET_AFTER_ACT);
      // The meter objected: the reducer's judgment beats the entry policy, so
      // no grid start may re-assert a ceiling it just trimmed (same rule that
      // ends GRID_FULL on bucket_empty — modes.ts). GEN IS EXEMPT: its start
      // policy is a floor CLAMP, which can only ever agree with the reducer —
      // and a gen turn-on is over-limit by definition on a 15A line, so
      // clearing there would retire the clamp on the very tick it is needed.
      if (view.source === "grid") this.startBaseline.clear();
    }

    // A room we just shed leaves a hole in the meter that its own restore must
    // not read as headroom. Anchored to the PRE-batch meter less what the batch
    // was priced to save — invariant 41's landing figure, frozen per room so it
    // outlives the shared credit (R9). Only rooms actually SENT an off.
    //
    // ⚠ What a REFUSED off leaves behind (review, 2026-08-31): nothing. The shed
    // record is written after the send, so a `power_off` the cloud rejected never
    // reaches `recordShed` and the room is not in `shedIds` at all. There is
    // therefore no shed row for confirm-or-resend (invariant 4) to re-send, and
    // no bar either: the reducer simply re-plans the room on the next tick, which
    // is the honest state for a command that never left. So the loop reads
    // `sentCommands` and not the plan, or a room that is still RUNNING would
    // carry a trough bar its own restore never has to clear.
    const shedThisBatch = new Set<string>();
    for (const cmd of sentCommands) {
      if (cmd.kind !== "power_off") continue;
      this.shedBar.set(cmd.deviceId, { amps: view.smoothedAmps - commandedCutAmps, at: now, credited: 0 });
      shedThisBatch.add(cmd.deviceId);
    }
    // …and a PEER whose room this batch just lowered shrinks the house every
    // OTHER bounce-extended bar describes (the peer-credit release valve). The
    // freshly-stamped rooms already account for this cut in their own bar.
    this.creditPeerShedBars(commandedCutAmps, shedThisBatch, now);

    // Failure attribution: an over-limit cut/shed of a recently-attempted AC.
    //
    // R9 asked whether this covers the RE-SHED path and not only a failed
    // admission. It does, and always has: `attemptedRecently` spans
    // ATTEMPT_BLAME_WINDOW_MS (300 s), so a restore re-shed inside five minutes
    // grows the ladder. Nor is the `over` gate a hole — the only other branch
    // that can emit a `power_off` is the FLOORS recovery admission, and FLOORS
    // arms on a source ENTRY, which has just called `resetPacing`; a restore
    // cannot have been attempted in between, because FLOORS blocks restores.
    if (out.reason.startsWith("over")) {
      for (const cmd of commands) {
        if (cmd.kind !== "set_level" && cmd.kind !== "power_off") continue;
        for (const kind of ["raise", "restore"] as const) {
          if (attemptedRecently(this.pacing, cmd.deviceId, kind, now)) {
            // Only a genuine `power_off` re-shed books a BOUNCE (compounds the
            // trough bar); a `set_level` cut of a recently restored room is a
            // ladder failure but not a shed bounce (2026-08-07 review).
            this.pacing = noteFailure(this.pacing, cmd.deviceId, kind, now, cmd.kind === "power_off");
            // A failed attempt must never be graded a SUCCESS later — its grade
            // window is still open and `gradeOne` calls noteSuccess on whatever
            // attempts it carries, which would reset the backoff we just grew.
            // (Harmless while pendingGrade was a single slot that this batch
            // overwrote; load-bearing now that windows survive.)
            this.pendingGrades = this.pendingGrades.map((g) => ({
              ...g,
              attempts: g.attempts.filter((a) => !(a.deviceId === cmd.deviceId && a.kind === kind)),
            }));
            log.info(`[leveler2] ${this.deviceNames.get(cmd.deviceId) ?? cmd.deviceId}: ${kind} bounced — backoff grows`);
          }
        }
      }
    }
    /**
     * Pacing attempts follow the SENT commands, not the plan's list (2026-08-31).
     * An attempt is a claim that a command is in flight: it parks the room behind
     * `RESTORE_CONFIRM_WAIT_MS`, and it is later resolved by `noteSuccess`, which
     * clears the backoff ladder and invariant 22's probe anchor. Recording one
     * for a restore the abort above skipped (or the cloud refused) therefore does
     * both halves of the damage: the shed room waits out a confirm window for a
     * command nobody sent, and its real bounce history is then erased as a
     * success. A raise attempt rides a `set_level`, a restore attempt a
     * `power_on`.
     */
    const attemptShipped = (attempt: { deviceId: string; kind: "raise" | "restore" }): boolean =>
      sentCommands.some(
        (c) =>
          c.deviceId === attempt.deviceId &&
          (attempt.kind === "restore" ? c.kind === "power_on" : c.kind === "set_level"),
      );
    /**
     * ONE list, used by BOTH consumers: the pacing stamp here and the grading
     * window that resolves it below. Filtering only the stamp left the other half
     * of the damage in place: the window still carried the unsent restore, and
     * `journalGrade` calls `noteSuccess` on whatever attempts it holds, which
     * clears the room's real failures, its bounce count, and invariant 22's probe
     * anchor for a command the cloud never took. Two lists that can drift is how
     * that reappears (review, 2026-08-31).
     */
    const shippedAttempts = out.attempts.filter(attemptShipped);
    for (const attempt of shippedAttempts) {
      this.pacing = noteAttempt(this.pacing, attempt.deviceId, attempt.kind, now, attempt.meterAmps);
    }
    // A room that just paid for a peer's raise may not take the level straight
    // back — see FUNDING_COOLDOWN_MS. Stamped only for donors whose demote was
    // actually SENT: invariant 30's own ⚠ says the filtered command list, not the
    // plan's wish list, and since 2026-08-31 that means `sentCommands`: a demote
    // the cloud REFUSED donated nothing, so barring that room from its own level
    // for two minutes would be a penalty for a command that never left.
    //
    // `power_off` counts since 2026-08-06: a proactive-shed donor gave up its
    // WHOLE room, which is the same donation one rung down, and its restore is
    // the thing that would undo the trade (the "donation cooldown" branch in
    // raise.ts spends this stamp).
    for (const deviceId of out.fundingDonors ?? []) {
      if (
        sentCommands.some(
          (c) => c.deviceId === deviceId && (c.kind === "set_level" || c.kind === "power_off"),
        )
      ) {
        this.fundingDemotedAt.set(deviceId, now);
      }
    }
    // Record the trade only once its donor's off has actually SHIPPED — the
    // receiver's reservation is a claim about amps that are really leaving.
    //
    // ⚠ The failed-send case this reservation is documented for (SKILL 57/69,
    // "it now exists for the FAILED-SEND case ONLY, the old swap-landing
    // deferral is the retry path") is the RECEIVER's: the donor's off shipped,
    // and the receiver's own turn-on failed to send or never confirmed, so its
    // amps stay reserved until it returns or `SWAP_RESERVATION_MS` expires. A
    // refused DONOR off arms nothing here, and should not: the batch abort above
    // skips the receiver's turn-on in the same pass, so there is no trade in
    // flight to reserve for (review, 2026-08-31).
    if (out.swap != null && sentCommands.some((c) => c.deviceId === out.swap?.donorId && c.kind === "power_off")) {
      this.swap = { donorId: out.swap.donorId, receiverId: out.swap.receiverId, at: now };
      log.warn(
        `[leveler2] Proactive shed: ${this.deviceNames.get(out.swap.donorId) ?? out.swap.donorId} off to fund ` +
          `${this.deviceNames.get(out.swap.receiverId) ?? out.swap.receiverId}`,
      );
    }
    // …and a room the reducer took a level from may not climb back into the
    // overload before its own cut has reached the meter (VICTIM_COOLDOWN_MS).
    // Same rule as the donors above: stamped only for cuts actually SENT.
    for (const deviceId of out.reductionVictims ?? []) {
      if (sentCommands.some((c) => c.deviceId === deviceId && c.kind === "set_level")) {
        this.reducedAt.set(deviceId, now);
      }
    }

    // Arm outcome grading; single-actuator batches feed the cost model.
    // Single-actuator meter batches feed the cost model. Fan-only batches are
    // not graded online (fan:step learning isn't implemented — the 0.2A grading
    // threshold would swallow a ~0.1A fan step — so fan costs stay seed-only).
    const meterCmds = commands.filter((c) => c.kind !== "set_fan");
    let single: PendingGrade["single"] = null;
    let riseEvidence = false;
    if (meterCmds.length === 1 && view.source !== "none") {
      const cmd = meterCmds[0];
      if (cmd.kind === "set_level") {
        const from = this.recon[cmd.deviceId]?.confirmedLevel;
        if (from != null && from >= 1 && cmd.level > from) {
          single = { deviceId: cmd.deviceId, transition: `level:${from}>${cmd.level}` };
          // …and a lone raise OFF L1 is also the rise-side OBSERVATION (R6b):
          // how far the meter moves hints at whether anything but the fan was
          // running down there. Judged HERE, at the send, because every
          // exclusion is a statement about the state we commanded it from.
          // Report-only — see `noteLoneRaiseRise` for why it may not arm a hold.
          riseEvidence = loneRaiseIsAttributable({
            fromLevel: from,
            floorsMode: mode === "FLOORS",
            inStartWindow: acs.find((a) => a.deviceId === cmd.deviceId)?.startBaselineAmps != null,
            inPowerEventRamp: this.powerEventRamp.has(cmd.deviceId),
          });
        }
      } else if (cmd.kind === "power_on") {
        single = { deviceId: cmd.deviceId, transition: `on@L${cmd.level}` };
      } else if (cmd.kind === "power_off") {
        // A lone shed measures the room's true ON draw as an instant drop —
        // learn on@L{level} from it (negated) so a restore admitted on a
        // wrong-low cost corrects after ONE bounce instead of storming.
        //
        // …but ONLY from a settled compressor. "Instant drop of a known steady
        // draw" is the whole premise, and a room shed inside its own ramp has
        // no steady draw yet: `preAmps` is its inrush peak, the sample ratchets
        // to the post-shed trough, and the difference is peak-minus-trough, not
        // the room's cost. Every bounce shed on 2026-08-02 was exactly that
        // shape (shed ~3 min after its own turn-on), and `turnOnAmps` takes
        // max(model, learned) — so the inflation is one-way and sticky for 30
        // days, which is what then refused the next restore.
        const ac = acs.find((a) => a.deviceId === cmd.deviceId);
        const settled = ac != null && !ac.ramping && ac.startBaselineAmps == null;
        const level = this.recon[cmd.deviceId]?.confirmedLevel;
        if (settled && level != null && level >= 1) {
          single = { deviceId: cmd.deviceId, transition: `on@L${level}`, negate: true };
        }
      }
    }
    // This batch moves the meter, so an open window whose measurement runs the
    // SAME way can no longer attribute its extreme to one batch — mark those,
    // but KEEP them: they still deserve a journal grade and their attempts
    // still need resolving. A window running the other way is untouched (see
    // PendingGrade.contaminated).
    const moved = batchLoadDirections(commands, (id) => this.recon[id]?.confirmedLevel ?? null);
    this.pendingGrades = this.pendingGrades.map((g) =>
      g.contaminated || !(g.direction === "up" ? moved.adds : moved.removes)
        ? g
        : { ...g, contaminated: true },
    );
    // BORN contaminated: an EARLIER batch still settling in this window's own
    // direction is already moving the meter, so the extreme this window will
    // ratchet is not attributable to this batch alone (see LEARN_SETTLE_*).
    // Timestamps are read BEFORE this batch stamps its own — a lone shed with
    // a quiet meter behind it still learns.
    //
    // Both directions are checked for BOTH kinds of window (2026-08-02): a
    // down-sample is corrupted by an add still landing exactly as symmetrically
    // as by a drop. The negate branch used to read only `lastLoadDropAt`, so a
    // room's OWN restore — which stamps the ADD clock — left its bounce shed
    // "born clean" and it learned the ramp's peak-minus-trough as the room's
    // on-cost.
    const meterMoved = batchLoadDirections(meterCmds, (id) => this.recon[id]?.confirmedLevel ?? null);
    const bornContaminated =
      single != null &&
      (now < this.lastLoadDropAt + LEARN_SETTLE_DOWN_MS || now < this.lastLoadAddAt + LEARN_SETTLE_UP_MS);
    if (meterMoved.adds) this.lastLoadAddAt = now;
    if (meterMoved.removes) this.lastLoadDropAt = now;
    const compareAfter = out.compareAfter || now + GRADE_FAN_MS;
    this.pendingGrades.push({
      journalId,
      compareAfter,
      // A shed's off-drop is instantaneous — the whole point of the 2026-07-27
      // off-drop learning — so it learns on the journal's schedule. Anything
      // ramp-shaped (level raise, turn-on) must wait out the compressor.
      learnAfter: single?.negate === true ? compareAfter : Math.max(compareAfter, now + AC_RAMP_MS),
      preAmps: view.smoothedAmps,
      peakDeltaAmps: 0,
      journaled: false,
      source: view.source,
      single,
      // The SENT attempts, never the plan's (see `shippedAttempts`): this window
      // is what later resolves them into successes.
      attempts: shippedAttempts,
      contaminated: bornContaminated,
      direction: single?.negate === true ? "down" : "up",
      riseEvidence,
    });
    if (this.pendingGrades.length > MAX_PENDING_GRADES) {
      this.pendingGrades = this.pendingGrades.slice(-MAX_PENDING_GRADES);
    }
  }

  /**
   * Two-stage: the journal row is graded at `compareAfter` (fast forensics,
   * unchanged), the cost sample at `learnAfter` (the full compressor ramp).
   * Windows therefore outlive their journal row when there is a cost to learn.
   */
  private async gradePending(view: ReturnType<typeof meterView>, now: number): Promise<void> {
    if (this.pendingGrades.length === 0) return;
    const keep: PendingGrade[] = [];
    for (const prev of this.pendingGrades) {
      let g = this.ratchetGrade(prev, view, now);
      // Long past due and still never gradeable — drop it rather than leak.
      if (now > g.compareAfter + GRADE_ABANDON_MS) continue;
      // Not ripe yet: KEEP it, without judging the source. An ESP gap makes the
      // view read "none" for a few seconds, and dropping every open window on
      // that transient would throw away grades the old single slot survived
      // (it only checked the source once the window was actually due).
      if (now < g.compareAfter || view.sampleCount < GRADE_MIN_SAMPLES) {
        keep.push(g);
        continue;
      }
      // Due, but the meter is on a different line than the batch ran on — a
      // source change already empties the queue, so this is a backstop.
      if (view.source !== g.source) continue;

      if (!g.journaled) {
        await this.journalGrade(g, view, now);
        g = { ...g, journaled: true };
      }
      // Nothing left to learn from — retire the window.
      if (g.single == null || g.contaminated) continue;
      if (now < g.learnAfter) {
        keep.push(g);
        continue;
      }
      await this.learnGrade(g, now);
    }
    this.pendingGrades = keep;
  }

  /** One-way ratchet of the window's extreme, in its own measurement direction. */
  private ratchetGrade(
    g: PendingGrade,
    view: ReturnType<typeof meterView>,
    _now: number,
  ): PendingGrade {
    if (view.source !== g.source || view.frozen || view.collapsed || view.sampleCount < 2) return g;
    const delta = view.smoothedAmps - g.preAmps;
    const peak = g.direction === "up" ? Math.max(g.peakDeltaAmps, delta) : Math.min(g.peakDeltaAmps, delta);
    return peak === g.peakDeltaAmps ? g : { ...g, peakDeltaAmps: peak };
  }

  /** Journal the batch outcome and resolve its pacing attempts (fast stage). */
  private async journalGrade(
    grade: PendingGrade,
    view: ReturnType<typeof meterView>,
    now: number,
  ): Promise<void> {
    const observedDelta = view.smoothedAmps - grade.preAmps;
    if (grade.journalId > 0) {
      await this.store.gradeJournal(grade.journalId, now, view.smoothedAmps, observedDelta).catch(() => undefined);
    }
    // Attempts that survived to grading without a failure are successes.
    for (const attempt of grade.attempts) {
      this.pacing = noteSuccess(this.pacing, attempt.deviceId, attempt.kind);
    }
  }

  /**
   * Fold the window's ratcheted extreme into the cost book (slow stage).
   * Reached only for an uncontaminated single-actuator batch past `learnAfter`,
   * so the sample is the compressor's settled cost, not a slice of its ramp.
   */
  private async learnGrade(grade: PendingGrade, now: number): Promise<void> {
    if (grade.single == null || grade.source === "none") return;
    const learnSample = grade.single.negate ? -grade.peakDeltaAmps : grade.peakDeltaAmps;
    // R6 — a graded LONE off is a controlled experiment with one actuator, and
    // this is the moment its answer arrives. Read BEFORE the 0.2A learn
    // threshold below: a room that dropped almost nothing is exactly the case
    // this is about, and that is the case the threshold discards.
    if (grade.single.negate === true) this.noteOffDrop(grade, learnSample, now);
    // …and the rise-side observation (R6b), REPORT-ONLY. Same placement and the
    // same reason: read BEFORE the 0.2A learn threshold, so what gets reported
    // never depends on what the cost book happens to accept.
    else if (grade.riseEvidence) await this.noteLoneRaiseRise(grade, learnSample, now);
    if (!(learnSample > 0.2)) return;
    this.book = updateCost(
      this.book,
      grade.single.deviceId,
      grade.source,
      grade.single.transition as never,
      learnSample,
      now,
    );
    const entry = this.book[`${grade.single.deviceId}|${grade.source}|${grade.single.transition}`];
    if (entry != null) {
      await this.store.upsertCost(grade.single.deviceId, grade.source, grade.single.transition, entry).catch(() => undefined);
    }
    log.info(
      `[leveler2] Learned ${grade.single.transition} ≈ ${learnSample.toFixed(1)}A for ` +
        `${this.deviceNames.get(grade.single.deviceId) ?? grade.single.deviceId} on ${grade.source}` +
        (grade.single.negate ? " (from shed off-drop)" : " (peak over the compressor ramp)"),
    );
  }

  /**
   * What one graded lone off says about that room's compressor (R6).
   *
   * `transition` is `on@L{level}` and `dropAmps` is the negated peak — the
   * measured fall this single power_off produced, over a window the grading
   * pipeline has already certified as uncontaminated (invariant 23) and as
   * belonging to a SETTLED compressor (invariant 29). Those two guards are what
   * make this attributable rather than circular.
   */
  private noteOffDrop(grade: PendingGrade, dropAmps: number, now: number): void {
    if (grade.single == null || grade.source === "none") return;
    const level = Number(/^on@L(\d+)$/.exec(grade.single.transition)?.[1] ?? NaN);
    if (!Number.isFinite(level) || level < 1) return;
    const deviceId = grade.single.deviceId;
    const name = this.deviceNames.get(deviceId) ?? deviceId;
    const modeled = steadyDraw(
      level,
      this.deviceMaxLevel.get(deviceId) ?? 3,
      modelFor(this.config, deviceId, grade.source),
    );
    if (offDropSaysCompressorOn(dropAmps)) {
      if (this.compressorOff.delete(deviceId)) {
        log.info(`[leveler2] ${name}: off-drop ${dropAmps.toFixed(1)}A — compressor WAS running, evidence cleared`);
      }
      return;
    }
    if (!offDropSaysCompressorOff(dropAmps, modeled)) return;
    this.compressorOff.set(deviceId, { level, source: grade.source });
    log.warn(
      `[leveler2] ${name}: switching off at L${level} moved the meter ${dropAmps.toFixed(1)}A against a ` +
        `${modeled.toFixed(1)}A model — its compressor was not running at that level`,
    );
    // …and that is one of R14's triggers — and since 2026-08-06 one of only
    // three, the thermometer watch having stopped being evidence at all.
    //
    // Deliberately UNSCOPED, unlike the hand-raise armers (FIX C, 2026-08-26): a
    // graded lone off that moved the meter by about a fan against a 2A level model
    // is METER evidence the compressor was not running, and that is true of any
    // room whether or not a levelBoost is configured. The hand-raise armers gate
    // on a configured boost because a comfort tap is a preference and not
    // evidence; this measurement is evidence, so it applies everywhere.
    if (level === 1) {
      void this.noteLevelHold(deviceId, 1, this.freshOutdoorC(now), now, `off-drop of only ${dropAmps.toFixed(1)}A at L1`);
    }
  }

  /**
   * What one graded LONE RAISE off L1 SUGGESTS about that room's compressor —
   * REPORT-ONLY (2026-08-06; built as the rise-side twin of `noteOffDrop` and
   * demoted the same day, on review, before it ever ran on the house).
   *
   * The measurement still happens and is still worth reading: a raise off L1
   * that moves the meter by a whole compressor MORE than its own step price
   * looks like a compressor STARTING, i.e. one that was not running at L1.
   *
   * ⚠ But it may not ARM anything, because the quantity it measures is not the
   * room. `riseAmps` is `PendingGrade.peakDeltaAmps` — a ratcheted WHOLE-HOUSE
   * smoothed delta over the 240 s window — and nothing subtracts non-AC load.
   * This house's own water heater is a 3.4 A step; switched on inside the
   * window it turns an ordinary 1.5 A level step into a 4.9 A "rise" against a
   * 3.5 A bar, and the 6 h L1 hold that used to follow would spend the hottest
   * room's amps on a kettle. That is precisely the false-evidence class
   * invariant 56 exists to kill, arriving from the amps side instead of the
   * thermometer side. `noteOffDrop` does not share the flaw: a household step
   * DOWN coincident with our own off is both rarer and self-limiting, and the
   * off-drop bar is a ceiling on a fall rather than a floor under a rise.
   *
   * So this journals and logs, and the three armers of the learned hold stay
   * the ones that measure only what they can attribute: the graded off-drop
   * (55), the dead window (44), and the user's own hand raise. Closing it for
   * real needs the rise taken net of `houseLoadAmps` at both ends of the
   * window — its own piece of work, not a threshold tweak.
   *
   * The window has already been certified uncontaminated (23) and settled (29)
   * by `gradePending`; the commanded-state exclusions were stamped at arm time
   * (`riseEvidence`). Nothing here touches the cost book either — the same
   * sample goes on to `updateCost` exactly as before.
   */
  private async noteLoneRaiseRise(grade: PendingGrade, riseAmps: number, now: number): Promise<void> {
    if (grade.single == null || grade.source === "none") return;
    const to = Number(/^level:1>(\d+)$/.exec(grade.single.transition)?.[1] ?? NaN);
    if (!Number.isFinite(to) || to <= 1) return;
    const deviceId = grade.single.deviceId;
    const maxLevel = this.deviceMaxLevel.get(deviceId) ?? 3;
    // Priced with the SAME function admission uses (max of model and learned),
    // read before this window's own sample is folded in — so the bar is what we
    // thought the step was worth when we bought it.
    const priced = raiseJumpAmps(this.book, this.config, deviceId, grade.source, 1, to, maxLevel, now).amps;
    if (!raiseRiseSaysCompressorWasOff(riseAmps, priced)) return;
    const name = this.deviceNames.get(deviceId) ?? deviceId;
    const detail =
      `lone L1→L${to} raise rose ${riseAmps.toFixed(1)}A ` +
      `(≥ bar ${(priced + COMPRESSOR_START_RISE_MARGIN_AMPS).toFixed(1)}A) — compressor may not have been ` +
      `running at L1 (report-only)`;
    log.warn(`[leveler2] ${name}: ${detail}`);
    // Journalled so the observation is durable and greppable next to the batch
    // that produced it — docker logs rotate in ~1.5 days, the journal does not.
    await this.store
      .insertJournal({
        at: now,
        source: grade.source,
        mode: deriveMode(this.modeState, now),
        severity: null,
        reason: "compressor_report",
        requiredAmps: null,
        preAmps: grade.preAmps,
        commands: [],
        decisions: [{ at: now, deviceId, action: "compressor report", detail }],
        expectedDelta: null,
        executed: false,
      })
      .catch(() => undefined);
  }

  private async persistFanHold(deviceId: string): Promise<void> {
    const hold = this.fanHolds[deviceId];
    if (hold == null) return;
    await this.pool.query(
      `INSERT INTO ac_leveling_fan_hold (device_id, original_fan, last_set_fan, held_at) VALUES ($1, $2, $3, to_timestamp($4 / 1000.0))
       ON CONFLICT (device_id) DO UPDATE SET original_fan = $2, last_set_fan = $3`,
      [deviceId, hold.originalFan, hold.lastSetFan, hold.heldAt],
    );
  }

  private async pushNotice(body: string, critical: boolean): Promise<void> {
    const now = Date.now();
    if (!critical && now - this.lastPushAt < PUSH_THROTTLE_MS) return;
    this.lastPushAt = now;
    await this.deps
      .broadcast({ title: "Smart AC Leveling", body, tag: "ac-leveling", type: "leveling" })
      .catch(() => undefined);
  }

  /** The live learned hold for the status card, or null when nothing binds. */
  private levelHoldStatus(
    deviceId: string,
    now: number,
  ): { level: number; outdoorC: number; until: number; detail: string } | null {
    const hold = this.levelHolds.get(deviceId);
    if (hold == null || !levelHoldLive(hold, this.freshOutdoorC(now), now)) return null;
    return {
      level: hold.level,
      outdoorC: hold.outdoorC,
      until: levelHoldExpiresAt(hold),
      detail: levelHoldDetail(hold),
    };
  }

  private buildStatus(
    acs: AcView[],
    view: ReturnType<typeof meterView>,
    mode: string,
    out: PlanOutput,
    now: number,
  ): LevelingStatusV2 {
    const source = view.source;
    // Report the ENFORCED limit, derate included — otherwise the card shows
    // headroom the controller will not spend after a trip.
    const limit = source === "none" ? null : effectiveLimit(this.config, source, view.derateAmps);
    return {
      enabled: this.config.enabled,
      source,
      measuredAmps: view.sampleCount > 0 ? Number(view.smoothedAmps.toFixed(2)) : null,
      limitAmps: limit,
      budgetAmps: limit != null ? Number((limit - this.config.marginAmps - view.smoothedAmps).toFixed(2)) : null,
      // The MEASURED non-AC split (house-load.ts) — v2's own rolling peak, not
      // v1's model-derived figure. Surfaced because an inflated house is what
      // silently refuses every raise ("worst case … incl. N.NA house"), and
      // there was no way to see it without reading the journal.
      nonAcLoadAmps:
        source === "none" ? null : Number(houseLoadAmps(this.houseLoad, source, now, acs).toFixed(2)),
      flickerAmps: Number(view.flickerAmps.toFixed(2)),
      overLimitBudget: view.overLimitBudget,
      overLimitBudgetMax: this.config.overLimitBudgetPoints,
      headroomStreak: Math.floor(view.calmMs / 5000), // v1-shaped approximation for the UI hint
      settleRemainingMs: Math.max(0, this.modeState.settleUntil - now),
      raiseHoldRemainingMs: 0,
      expectedAmps: null,
      lastPrediction: null,
      lastEmergency: null,
      acs: acs.map((a) => ({
        deviceId: a.deviceId,
        name: a.name,
        on: a.on,
        managed: a.managed,
        shed: a.shed,
        level: a.currentLevel,
        maxLevel: a.maxLevel,
        minLevel: a.minLevel,
        estAmps: a.on
          ? Number(steadyDraw(a.currentLevel, a.maxLevel, modelFor(this.config, a.deviceId, source === "none" ? "grid" : source)).toFixed(1))
          : 0,
        needTier: a.needDelta <= 0 ? "satisfied" : a.needDelta <= 1.5 ? "mild" : "full",
        needCap: nearTargetNeedCap(a.needDelta, this.config.nearTargetBandC, a.maxLevel),
        needDelta: a.needDelta,
        manualCap: a.manualCap,
        manualTarget: a.manualTarget,
        idealLevel: a.on ? a.currentLevel : null,
        heldFan: this.fanHolds[a.deviceId]?.lastSetFan ?? null,
        fanOriginal: this.fanHolds[a.deviceId]?.originalFan ?? null,
        bounceCap: null,
        bounceRetryBelowAmps: null,
        restoreBlocked: a.reshedPenalized,
        slotCap: a.slotCap,
        unreachableLevels: Object.keys(this.recon[a.deviceId]?.unreachable ?? {}).map(Number).sort((x, y) => x - y),
        raiseCooldownMs: cooldownRemainingMs(this.pacing, a.deviceId, "raise", now),
        restoreCooldownMs: cooldownRemainingMs(this.pacing, a.deviceId, "restore", now),
        levelHold: this.levelHoldStatus(a.deviceId, now),
        subFloorStalledMs: a.subFloorStalledMs,
        // Precedence is deliberate: the METER's evidence outranks the
        // thermometer's, because it is the faster of the two and it is what the
        // reduction ladder is already acting on.
        coolingState: !a.on || a.shed
          ? "off"
          : a.compressorOffLikely
            ? "compressor_off"
            : a.subFloorStalledMs >= SUBFLOOR_WATCH_MS
              ? "stalled"
              : "cooling",
      })),
      mode,
      calmMs: view.calmMs,
      controller: this.config.controller,
      decisions: out.decisions.slice(-20),
      meterFrozen: view.frozen,
    };
  }

  getStatus(): LevelingStatusV2 {
    return (
      this.lastStatus ?? {
        enabled: this.config.enabled,
        source: "none",
        measuredAmps: null,
        limitAmps: null,
        budgetAmps: null,
        nonAcLoadAmps: null,
        flickerAmps: 0,
        // Nothing has ticked yet, so the bucket is still at capacity; before
        // the first config load that capacity IS the default.
        overLimitBudget: this.config.overLimitBudgetPoints,
        overLimitBudgetMax: this.config.overLimitBudgetPoints,
        headroomStreak: 0,
        settleRemainingMs: 0,
        raiseHoldRemainingMs: 0,
        expectedAmps: null,
        lastPrediction: null,
        lastEmergency: null,
        acs: [],
        mode: "NORMAL",
        controller: this.config.controller,
      }
    );
  }

  /** Journal read-through for the API. */
  async recentJournal(hours: number): Promise<Record<string, unknown>[]> {
    return this.store.recentJournal(hours);
  }
}
