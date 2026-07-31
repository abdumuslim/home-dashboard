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
  ingestReading,
  initialMeterState,
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
import { houseLoadAmps, initialHouseLoad, sampleHouseLoad, type HouseLoadState } from "./house-load.js";
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
  unconfirmedLevels,
  unconfirmedSends,
  type ReconcilerState,
} from "./reconciler.js";
import { boostFloor, ceilOf, floorOf, nearTargetNeedCap, worstCaseLevel } from "./needs.js";
import { DEMOTE_HYSTERESIS_C } from "./demote.js";
import { fanTrimSavings, raiseJumpAmps, steadyDraw, modelFor, restoreCostAmps, turnOnAmps, updateCost, type CostBook } from "./costs.js";
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
 * How long a fan restore's amps stay charged as committed-but-unmetered. A fan
 * gear changes almost immediately — nothing like the 4-minute compressor ramp —
 * so this only has to outlive the ESP cadence plus a tick, and the absorption
 * ratchet retires it as soon as the meter shows the rise.
 */
const FAN_DEBIT_MS = 60_000;
const SHED_CLEAR_GRACE_MS = 15_000;
const PUSH_THROTTLE_MS = 5 * 60_000;
/** Grade a batch only when this many fresh readings arrived after compareAfter. */
const GRADE_MIN_SAMPLES = 4;

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
  private prevPowerStates = new Map<string, boolean>();
  private deviceNames = new Map<string, string>();
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
  /** Throttle for durable blocked-decision rows, keyed `deviceId|blockedBy`. */
  private lastBlockedJournalAt = new Map<string, number>();
  private lastPushAt = 0;
  private lastStatus: LevelingStatusV2 | null = null;
  private lastPruneAt = 0;
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
          if (event.to === "grid") {
            this.manualCap.clear();
            this.manualTarget.clear();
          }
          if (prevSource !== "none" && event.to !== "none") this.armRampOnSourceChange = true;
          log.info(`[leveler2] Power source changed → ${event.to}`);
          this.deps.onPowerEvent?.(`source ${event.from} → ${event.to}`);
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
          // Compressors restarted with the line — re-arm the ramp windows.
          this.rearmRamp([...this.prevPowerStates.entries()].filter(([, on]) => on).map(([id]) => id));
          log.info(`[leveler2] Power collapse recovered on ${event.source} — ramps re-armed`);
          break;
        case "esp_gap":
          this.deps.onPowerEvent?.(`ESP gap ${Math.round(event.gapMs / 1000)}s`);
          break;
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

  // ---------- user hooks (manual always wins) ----------

  async onUserPowerOff(deviceId: string): Promise<void> {
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
    await this.clearShed(deviceId, "user_power_on");
    this.rearmRamp([deviceId]);
    // Fires before the shadow flips — the meter here is still the pre-start
    // house load, the exact anchor the grid full start needs.
    this.noteTurnOn(deviceId, Date.now());
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
   */
  rearmRamp(deviceIds: string[]): void {
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
    }
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
      if ((this.rampUntil.get(id) ?? 0) <= now) continue;
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
      const prev = this.prevPowerStates.get(device.id);
      if (prev !== undefined && prev !== device.power) {
        if (device.power) {
          this.rearmRamp([device.id]);
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
        } else {
          this.startBaseline.delete(device.id);
          // No compressor, no ramp to account for.
          this.rampUntil.delete(device.id);
          this.rampBaseline.delete(device.id);
          this.rampAbsorbed.delete(device.id);
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
      this.rearmRamp(ctx.filter((c) => c.device.power).map((c) => c.device.id));
    }

    const view = meterView(this.meterState, now);
    const inSettle = deriveMode(this.modeState, now) === "SETTLING";

    // Drift reconciliation per ON managed device.
    for (const { device, managed } of ctx) {
      if (!device.power || !managed) continue;
      const { state: recon2, result } = observeLevel(this.recon, device.id, device.generatorMode, {
        inSettle,
        collapsed: view.collapsed,
        maxLevel: device.maxGeneratorLevel || 3,
      });
      this.recon = recon2;
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
    // against the house this tick actually sees. Sampling is free of any gate:
    // it is an observation, and `houseLoadResidual` decides on its own whether
    // the reading is usable (see house-load.ts).
    if (view.source !== "none" && view.sampleCount >= 2 && !view.frozen) {
      this.houseLoad = sampleHouseLoad(this.houseLoad, {
        source: view.source,
        at: now,
        smoothedAmps: view.smoothedAmps,
        acs,
        config: this.config,
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
    const commands: Command[] = out.commands.filter((cmd) =>
      cmd.kind === "set_level" ? shouldSendLevel(this.recon, cmd.deviceId, cmd.level, now) : true,
    );
    if (commands.length === 0) {
      await this.journalBlocked(out, view, mode, now);
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
    for (const attempt of out.attempts) this.pacing = noteAttempt(this.pacing, attempt.deviceId, attempt.kind, now);

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
        const level = this.recon[cmd.deviceId]?.confirmedLevel;
        if (level != null && level >= 1) {
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
      contaminated: false,
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
      nonAcLoadAmps: null, // v2 is meter-anchored; the model-derived split is gone
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
