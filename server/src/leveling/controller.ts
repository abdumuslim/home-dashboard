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
import { DEFAULT_LEVELING_CONFIG_V2, mergeLevelingConfigV2, effectiveLimit, limitFor, type ControllerFlavor, type LevelingConfigV2 } from "./config.js";
import {
  clearCollapse,
  derateFor,
  ingestReading,
  initialMeterState,
  latchCollapse,
  meterView,
  noteCommandedCut,
  OVER_LIMIT_BUDGET_AFTER_ACT,
  refillBucket,
  resetCalm,
} from "./sensing.js";
import {
  applyMeterEvent,
  clearFloorsIfDone,
  clearFloorsOnManual,
  clearGridFullIfDone,
  deriveMode,
  FLOORS_MAX_MS,
  initialModeState,
  noteBatch,
  type ModeState,
} from "./modes.js";
import { plan, type PlanOutput } from "./pipeline.js";
import { GRADE_FAN_MS, GRADE_TURN_ON_MS } from "./pipeline.js";
import {
  attemptedRecently,
  attemptedWithin,
  cooldownRemainingMs,
  initialPacingState,
  noteAttempt,
  noteFailure,
  noteSuccess,
  reshedPenalized,
  resetPacing,
  type PacingState,
} from "./pacing.js";
import { planFanRestore, recordFanCut, releaseFanHold, type FanHolds } from "./fan-trim.js";
import {
  EXTERNAL_ON_VOID_MS,
  HOUSE_SAMPLE_COOLDOWN_MS,
  houseLoadAmps,
  initialHouseLoad,
  sampleHouseLoad,
  voidSamples,
  type HouseLoadState,
} from "./house-load.js";
import {
  ENTRY_COLLAPSE_DWELL_MS,
  entryCollapseEvidence,
  type RoomLiveness,
  houseIsDead,
  meterIsSteady,
  modeledGapAmps,
  rampAbsorptionLanded,
  type ModeledAc,
} from "./dead-window.js";
import {
  clearMarksOnManual,
  clearOnPowerOff,
  clearOnSourceChange,
  confirmFan,
  fanResendDue,
  initialReconcilerState,
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
  ceilOf,
  floorOf,
  nearTargetNeedCap,
  nextSubFloorWatch,
  type SubFloorWatch,
  worstCaseLevel,
} from "./needs.js";
import { DEMOTE_HYSTERESIS_C } from "./demote.js";
import { fanTrimSavings, modelCutAmps, raiseJumpAmps, steadyDraw, modelFor, restoreCostAmps, turnOnAmps, updateCost, type CostBook } from "./costs.js";
import { LevelingStore } from "./store.js";
import type { AcView, Command, MeterState, Mode, PowerSource } from "./types.js";

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
 * How long a fan restore's amps stay charged as committed-but-unmetered. A fan
 * gear changes almost immediately — nothing like the 4-minute compressor ramp —
 * so this only has to outlive the ESP cadence plus a tick, and the absorption
 * ratchet retires it as soon as the meter shows the rise.
 */
const FAN_DEBIT_MS = 60_000;
const SHED_CLEAR_GRACE_MS = 15_000;
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
  /** Last fan TRIM actually sent per device — the fan half of send dedupe. */
  private lastFanSent = new Map<string, { fan: number; at: number }>();
  /** Last shed actually sent per device — the power_off half of send dedupe. */
  private lastOffSentAt = new Map<string, number>();
  private rememberedLevel = new Map<string, number>();
  private manualCap = new Map<string, number>();
  private manualTarget = new Map<string, number>();
  private fanExempt = new Set<string>();
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
  private boostActive = new Map<string, boolean>();
  /** When each room's current uninterrupted satisfied stretch began (demote dwell). */
  private satisfiedSince = new Map<string, number>();
  /** Start of the current below-floor stretch, and the need it has yet to beat. */
  private subFloorSince = new Map<string, SubFloorWatch>();
  private prevPowerStates = new Map<string, boolean>();
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
  private async loadPersistedState(): Promise<{ sheds: number; holds: number; remembered: number }> {
    const shedRes = await this.pool.query("SELECT device_id, shed_at FROM ac_leveling_shed");
    this.shedIds = new Set<string>();
    this.shedTimes = new Map<string, number>();
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
    return { sheds: this.shedIds.size, holds: Object.keys(this.fanHolds).length, remembered: this.rememberedLevel.size };
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
    this.config = mergeLevelingConfigV2(this.rawConfig);
    this.lastConfigReloadAt = Date.now();

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
        `[leveler2] Became acting controller — resynced ${counts.sheds} shed(s), ${counts.holds} fan hold(s), ${counts.remembered} remembered level(s)`,
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
    const v2Keys = ["controller", "restingBufferAmps", "raiseCalmSeconds", "restoreCalmSeconds", "fanTrimEnabled"];
    const row2Res = await this.pool.query("SELECT config FROM ac_leveling_config WHERE id = 2");
    const row2 = { ...((row2Res?.rows?.[0]?.config as Record<string, unknown>) ?? {}) };
    for (const key of v2Keys) if (key in cfg) row2[key] = cfg[key];
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
    const row1Entries = Object.entries(cfg).filter(([key]) => !v2Keys.includes(key));
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
    await this.pool.query(
      `INSERT INTO ac_leveling_shed (device_id, shed_at, reason) VALUES ($1, NOW(), $2)
       ON CONFLICT (device_id) DO UPDATE SET shed_at = NOW(), reason = $2`,
      [deviceId, reason],
    );
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
    this.voidPhantomHouse(deviceId, Date.now());
    if (!this.shedIds.has(deviceId)) return;
    const shedAt = this.shedTimes.get(deviceId);
    if (shedAt != null && Date.now() - shedAt < SHED_CLEAR_GRACE_MS) return;
    await this.clearShed(deviceId, "observed_on");
  }

  hasFanHold(deviceId: string): boolean {
    return this.fanHolds[deviceId] != null;
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
          // Dead-window holds are about ramps on the line we just left; the
          // entry re-arms them a tick later against the new line's readings.
          this.powerEventRamp.clear();
          // …and so is the entry-collapse evidence: it is a claim about one
          // line's breaker. (The DERATE deliberately survives — it carries its
          // own source tag, so a gen→grid→gen bounce cannot launder it.)
          this.entryCollapseSince = null;
          this.entryCollapseLatched = false;
          this.recoveryAdmissionUntil = 0;
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
          if (event.to === "grid") {
            this.manualCap.clear();
            this.manualTarget.clear();
          }
          if (prevSource !== "none" && event.to !== "none") this.armRampOnSourceChange = true;
          log.info(`[leveler2] Power source changed → ${event.to}`);
          this.deps.onPowerEvent?.(`source ${event.from} → ${event.to}`);
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
          this.deps.onPowerEvent?.(`power collapse on ${event.source}`);
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
          this.deps.onPowerEvent?.(`ESP gap ${Math.round(event.gapMs / 1000)}s`);
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
          this.deps.onPowerEvent?.("meter frozen");
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
  private creditRoomOff(deviceId: string, observedLevel: number | null, now: number): void {
    const source = this.meterState.source;
    if (source === "none" || this.shedIds.has(deviceId)) return;
    const from = this.recon[deviceId]?.confirmedLevel ?? observedLevel;
    if (from == null || from <= 0) return;
    const amps = modelCutAmps(
      this.config,
      deviceId,
      source,
      from,
      null,
      this.deviceMaxLevel.get(deviceId) ?? 3,
    );
    if (amps > 0) this.meterState = noteCommandedCut(this.meterState, amps, now);
  }

  // ---------- user hooks (manual always wins) ----------

  async onUserPowerOff(deviceId: string): Promise<void> {
    // Price this room off the meter BEFORE `clearOnPowerOff` forgets what level
    // it was at. The tap is the earliest moment the draw can start falling, so
    // the credit is armed ahead of the cliff it explains.
    this.creditRoomOff(deviceId, null, Date.now());
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

  async onUserPowerOn(deviceId: string): Promise<void> {
    if (!this.isManaged(deviceId)) return;
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
  }

  async onUserFanChange(deviceId: string): Promise<void> {
    this.fanExempt.add(deviceId);
    await this.releaseHold(deviceId, "user_fan_change");
  }

  async onUserGenLevel(deviceId: string, level: number): Promise<{ reverted: boolean; level: number }> {
    await this.ensureLoaded();
    const now = Date.now();
    this.modeState = clearFloorsOnManual(this.modeState);
    this.recon = clearMarksOnManual(this.recon, deviceId);
    this.rememberedLevel.delete(deviceId);
    // Manual wins (AGENTS rule 7) — a hand-set level ends the entry policy.
    this.startBaseline.delete(deviceId);
    const confirmed = this.recon[deviceId]?.confirmedLevel ?? null;
    const maxLevel = 3;
    const rank = (l: number): number => (l <= 0 ? maxLevel + 1 : Math.min(l, maxLevel));
    const target = Math.max(1, Math.min(rank(level), maxLevel));
    const isReduction = confirmed != null && rank(level) < rank(confirmed);
    if (isReduction || confirmed == null) {
      this.manualCap.set(deviceId, target);
      this.manualTarget.delete(deviceId);
      this.recon = noteLevelSend(this.recon, deviceId, target, now).state;
      log.info(`[leveler2] Manual gen reduction on ${deviceId} → cap L${target}`);
      return { reverted: false, level: target };
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
      if (risen > (this.rampAbsorbed.get(id) ?? 0)) this.rampAbsorbed.set(id, risen);
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
    this.deps.onPowerEvent?.(`AC circuit dead on ${source}`);
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

  // ---------- tick ----------

  async tick(ctx: LevelerDeviceContext[], outdoorTempC: number | null): Promise<void> {
    await this.ensureLoaded();
    if (Date.now() - this.lastConfigReloadAt > 30_000) await this.reloadConfig().catch(() => undefined);
    if (!this.isEnabled()) return;
    const tcl = this.deps.getTclCloud();
    if (tcl == null) return;
    const now = Date.now();

    // Structural changes: power flips.
    this.freshlyOn = [];
    for (const { device, managed } of ctx) {
      this.deviceNames.set(device.id, device.name);
      this.deviceMaxLevel.set(device.id, device.maxGeneratorLevel || 3);
      if (managed) this.managedIds.add(device.id);
      else this.managedIds.delete(device.id);
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
          this.rearmRamp([device.id]);
          // This room has been DRAWING since some earlier moment we never saw —
          // the shadow is only now catching up. Every house sample taken in the
          // meantime booked its compressor as house load (invariant 20's
          // rise-side twin), so drop the ones that could not have known.
          if (managed) this.voidPhantomHouse(device.id, now);
          // A shed device flips ON in the shadow: OUR restore confirmed (or an
          // external hand did it) — THIS is where the shed clears, not at
          // command send (2026-07-27 bogus-lock incident). The OFF→ON flip
          // requires the shadow to have shown the off first, so a stale-ON
          // shadow can't trip this the way it could trip reconcileObservedOn.
          if (managed && this.shedIds.has(device.id)) {
            await this.clearShed(device.id, "restore_confirmed");
          }
          if (managed && !this.shedIds.has(device.id)) {
            this.freshlyOn.push(device.id);
            // Automation turn-ons never pass through onUserPowerOn.
            this.noteTurnOn(device.id, now);
          }
          // A room coming on is load ARRIVING, and `batchLoadDirections` only
          // ever sees our OWN commands — so without this an external turn-on
          // left the add-side settle clock untouched and the next cost sample
          // measured its ramp as if the meter had been quiet.
          if (managed) {
            this.lastLoadAddAt = now;
            // …and the clock only protects windows armed AFTER this moment. A
            // window already open — a restore's 315s grade, say — is measuring
            // a meter this compressor is now climbing into, and would ratchet
            // that ramp into ITS own cost. Our own batches mark open windows
            // this way; an external ON must too.
            this.pendingGrades = this.pendingGrades.map((g) =>
              g.contaminated || g.direction !== "up" ? g : { ...g, contaminated: true },
            );
          }
        } else {
          // Someone else turned this room off — a remote, the automation, a
          // schedule. Price it off the meter before the reconciler forgets its
          // level: the fall that follows is collapse-SHAPED (a whole room's
          // draw vanishing, leaving only the house), and the relative collapse
          // floor cannot tell it from a breaker without this credit.
          this.creditRoomOff(device.id, device.generatorMode ?? null, now);
          this.pendingOn.delete(device.id);
          this.startBaseline.delete(device.id);
          // No compressor, no ramp to account for.
          this.rampUntil.delete(device.id);
          this.rampBaseline.delete(device.id);
          this.rampAbsorbed.delete(device.id);
          this.powerEventRamp.delete(device.id);
          this.recon = clearOnPowerOff(this.recon, device.id);
          this.manualCap.delete(device.id);
          this.manualTarget.delete(device.id);
          this.fanExempt.delete(device.id);
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
          device.fanSpeed !== hold.lastSetFan &&
          device.fanSpeed !== hold.originalFan &&
          this.recon[device.id]?.pendingFan == null
        ) {
          // Observed move to a fan we never commanded → user/external took over.
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

    // Build views.
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
        projectedExtraAmps = starting.reduce((sum, ac) => {
          const ours = attemptedWithin(this.pacing, ac.deviceId, "restore", GRADE_TURN_ON_MS, now);
          const committed = ours
            ? restoreCostAmps(this.book, this.config, ac.deviceId, source, floorOf(ac), ac.maxLevel, now, {
                gentle: this.fanHolds[ac.deviceId]?.gentle === true,
              }).amps
            : turnOnAmps(this.book, this.config, ac.deviceId, source, ac.envelopeLevel, ac.maxLevel, now).amps;
          const absorbed =
            ac.rampBaselineAmps == null
              ? 0
              : Math.max(0, view.smoothedAmps - ac.rampBaselineAmps, ac.rampAbsorbedAmps ?? 0);
          return sum + Math.max(0, committed - absorbed);
        }, 0);
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
    if (
      view.source !== "none" &&
      view.sampleCount >= 2 &&
      !view.frozen &&
      this.pendingOn.size === 0 &&
      now - this.firstTickAt >= HOUSE_SAMPLE_COOLDOWN_MS
    ) {
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
    });
    this.fanHolds = out.fanHolds;

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
    return sorted.map(({ device, managed, needDelta, slotGenCap }) => {
      const boost = boostFloor(this.config.levelBoosts[device.id], outdoorTempC, this.boostActive.get(device.id) ?? false);
      this.boostActive.set(device.id, boost.active);
      const recon = this.recon[device.id];
      const ramping = (this.rampUntil.get(device.id) ?? 0) > now && device.power;
      // During settle the shadow reflects the pre-command state — use pending.
      const observed = deriveMode(this.modeState, now) === "SETTLING" && recon?.pendingLevel != null
        ? recon.pendingLevel
        : device.generatorMode;
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
        subFloorStalledMs: this.subFloorStalledMs(
          device.id,
          observed >= 1 && observed < boost.minLevel,
          needDelta,
          // computeAcNeed's dead-sensor sentinel is delta 1 — see the guard.
          device.currentTemp != null && device.currentTemp > 0,
          device.power,
          managed,
          this.shedIds.has(device.id),
          now,
        ),
        minLevel: boost.minLevel,
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
    for (const cmd of commands) {
      const name = this.deviceNames.get(cmd.deviceId) ?? cmd.deviceId;
      try {
        switch (cmd.kind) {
          case "set_level": {
            await tcl.sendControl(cmd.deviceId, "set_generator_mode", cmd.level);
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
            fanOnly = false;
            break;
          }
          case "power_off": {
            await tcl.executeAcAction(cmd.deviceId, { power: 0 });
            this.lastOffSentAt.set(cmd.deviceId, now);
            // Whatever ON we were still waiting to confirm is now overtaken.
            this.pendingOn.delete(cmd.deviceId);
            await this.recordShed(
              cmd.deviceId,
              `over ${effectiveLimit(this.config, view.source === "none" ? "gen" : view.source, view.derateAmps)}A on ${view.source}`,
            );
            await this.releaseHold(cmd.deviceId, "shed");
            this.deps.setDevicePowerCache(cmd.deviceId, "off");
            await this.pushNotice(`AC ${name} turned off to protect the ${view.source} breaker`, true);
            log.warn(`[leveler2] Shed AC ${name} (${out.reason})`);
            fanOnly = false;
            break;
          }
          case "power_on": {
            await tcl.executeAcAction(cmd.deviceId, {
              power: 1,
              generator_mode: cmd.level,
              ...(cmd.fan != null ? { fan_speed: cmd.fan } : {}),
            });
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
            fanOnly = false;
            break;
          }
          case "set_fan": {
            const priorFan = acs.find((a) => a.deviceId === cmd.deviceId)?.fanSpeed ?? null;
            await tcl.sendControl(cmd.deviceId, "set_fan_speed", cmd.fan);
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
        sentAny = true;
      } catch (err) {
        log.warn(`[leveler2] command failed for ${name}: ${String(err)}`);
      }
    }
    if (!sentAny) return;

    this.modeState = noteBatch(this.modeState, { fanOnly }, now);
    if (!fanOnly || spentOnFan) this.meterState = resetCalm(this.meterState);
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
    if (out.commandedCutAmps > 0) {
      this.meterState = noteCommandedCut(this.meterState, out.commandedCutAmps, now);
    }
    // A turn-on changes the load picture wholesale: over-limit readings banked
    // BEFORE it are no longer evidence about the house that exists now, and
    // letting them carry over meant a restore inherited a half-drained bucket
    // and tripped on its own inrush (2026-07-25). A genuine post-restore
    // overload still empties the bucket from full in ~10s (2 severe readings)
    // or ~25s (5 mild) — protection kept, carry-over removed.
    if (commands.some((c) => c.kind === "power_on")) {
      this.meterState = refillBucket(this.meterState);
    }
    if (out.reason.startsWith("over")) {
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

    // Failure attribution: an over-limit cut/shed of a recently-attempted AC.
    if (out.reason.startsWith("over")) {
      for (const cmd of commands) {
        if (cmd.kind !== "set_level" && cmd.kind !== "power_off") continue;
        for (const kind of ["raise", "restore"] as const) {
          if (attemptedRecently(this.pacing, cmd.deviceId, kind, now)) {
            this.pacing = noteFailure(this.pacing, cmd.deviceId, kind, now);
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
    for (const attempt of out.attempts) {
      this.pacing = noteAttempt(this.pacing, attempt.deviceId, attempt.kind, now, attempt.meterAmps);
    }
    // A room that just paid for a peer's raise may not take the level straight
    // back — see FUNDING_COOLDOWN_MS. Stamped only for donors whose demote was
    // actually SENT (the filtered `commands`, not the plan's wish list).
    for (const deviceId of out.fundingDonors ?? []) {
      if (commands.some((c) => c.deviceId === deviceId && c.kind === "set_level")) {
        this.fundingDemotedAt.set(deviceId, now);
      }
    }
    // …and a room the reducer took a level from may not climb back into the
    // overload before its own cut has reached the meter (VICTIM_COOLDOWN_MS).
    // Same rule as the donors above: stamped only for cuts actually SENT.
    for (const deviceId of out.reductionVictims ?? []) {
      if (commands.some((c) => c.deviceId === deviceId && c.kind === "set_level")) {
        this.reducedAt.set(deviceId, now);
      }
    }

    // Arm outcome grading; single-actuator batches feed the cost model.
    // Single-actuator meter batches feed the cost model. Fan-only batches are
    // not graded online (fan:step learning isn't implemented — the 0.2A grading
    // threshold would swallow a ~0.1A fan step — so fan costs stay seed-only).
    const meterCmds = commands.filter((c) => c.kind !== "set_fan");
    let single: PendingGrade["single"] = null;
    if (meterCmds.length === 1 && view.source !== "none") {
      const cmd = meterCmds[0];
      if (cmd.kind === "set_level") {
        const from = this.recon[cmd.deviceId]?.confirmedLevel;
        if (from != null && from >= 1 && cmd.level > from) {
          single = { deviceId: cmd.deviceId, transition: `level:${from}>${cmd.level}` };
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
      attempts: out.attempts,
      contaminated: bornContaminated,
      direction: single?.negate === true ? "down" : "up",
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
      overLimitBudgetMax: 5,
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
        overLimitBudget: 5,
        overLimitBudgetMax: 5,
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
