// Stateful Smart AC Leveling controller. Owns config/shed persistence, power
// reading streaks, manual gen-level intents, and command execution. The pure
// allocation math lives in ac-leveling.ts; the Collector builds the per-tick
// device context (need tiers, opt-outs) and drives tick().
import pg from "pg";
import {
  computeAllocation,
  computeEmergencyReduction,
  determineSource,
  estimateAcDraw,
  nearTargetNeedCap,
  AC_RAMP_MS,
  EMERGENCY_PENDING_MS,
  BOUNCE_MAX_EXTRA_AMPS,
  BOUNCE_MODEL_TOLERANCE_AMPS,
  BOUNCE_SAFETY_EXPIRY_MS,
  BOUNCE_WINDOW_MS,
  NON_AC_FREEZE_MS,
  OVER_LIMIT_SEVERE_AMPS,
  OVER_LIMIT_BUDGET,
  OVER_LIMIT_DRAIN_SEVERE,
  OVER_LIMIT_DRAIN_MILD,
  PREDICTION_WARN_AMPS,
  RAISE_HOLD_MS,
  RAISE_HOLD_CHECK_AFTER_MS,
  RESTORE_HOLD_MS,
  RAISE_STREAK,
  REDUCE_STREAK,
  SETTLE_MS,
  FAN_SETTLE_MS,
  UNREACHABLE_LEVEL_SENDS,
  UNREACHABLE_SAFETY_EXPIRY_MS,
  SHED_CLEAR_GRACE_MS,
  STALE_POWER_MS,
  POWER_COLLAPSE_DROP_AMPS,
  POWER_COLLAPSE_FLOOR_AMPS,
  POWER_COLLAPSE_RECOVER_GAP,
  POWER_COLLAPSE_MAX_MS,
  DEFAULT_LEVELING_CONFIG,
  type AcAmpModel,
  type AcLevelingConfig,
  type AllocationResult,
  type AllocatorInput,
  type LevelerAcSnapshot,
  type NeedTier,
  type PowerSource,
} from "./ac-leveling.js";
import type { TclCloud, AcDevice } from "./tcl-cloud.js";
import { childLogger } from "./logger.js";

const log = childLogger("ac-leveler");

/** Bounded re-sends of an unconfirmed fan command (Najat needs commands re-done). */
const FAN_RESEND_MAX = 2;
/** Minimum spacing between fan command re-sends. */
const FAN_RESEND_SPACING_MS = 15_000;
/**
 * Minimum spacing between non-critical Smart AC Leveling push notifications
 * (fan reductions, restores). A shed (an AC turned OFF) is actionable and always
 * notifies; the rest are rate-limited so an over-limit episode can't spam the
 * user (live: ~40 pushes/day trained the user to ignore them). 2026-06-17.
 */
const LEVELING_PUSH_THROTTLE_MS = 5 * 60_000;

export interface AcLevelerDeps {
  getTclCloud: () => TclCloud | null;
  broadcast: (payload: Record<string, unknown>) => Promise<void>;
  setDevicePowerCache: (deviceId: string, power: "on" | "off") => void;
  isManualOffLocked: (deviceId: string) => Promise<boolean>;
  /** Fired on every leveler fan command so range-automation fan enforcement re-baselines. */
  onLevelerFanCommand: (deviceId: string, fan: number) => void;
  /**
   * Fired from onPowerReading when an emergency trigger confirms (severe
   * streak / grid oscillation) so the collector runs a leveling check NOW
   * instead of waiting up to 5s for the next loop tick — the breaker trips
   * in seconds. Fired per qualifying reading; the collector coalesces.
   */
  onUrgentLevelingNeeded?: () => void;
}

export interface LevelerDeviceContext {
  device: AcDevice;
  /** False when an enabled AC automation covering this device has smart_leveling=false. */
  managed: boolean;
  needTier: NeedTier;
  /** °C above the target/satisfied point (≤0 = satisfied). */
  needDelta: number;
  /** Active range slot's generator-level hard cap (null = Auto / no slot). */
  slotGenCap: number | null;
}

export interface AcLevelingAcStatus {
  deviceId: string;
  name: string;
  on: boolean;
  managed: boolean;
  shed: boolean;
  level: number;
  maxLevel: number;
  minLevel: number;
  estAmps: number;
  needTier: NeedTier;
  needCap: number;
  needDelta: number;
  manualCap: number | null;
  manualTarget: number | null;
  idealLevel: number | null;
  /** Fan the leveler is currently holding the AC at (null = no hold). */
  heldFan: number | null;
  /** Original fan the hold will restore to (0 = built-in auto). */
  fanOriginal: number | null;
  /** A recent raise bounced over the limit — raises capped here until the load drops (null = no bounce). */
  bounceCap: number | null;
  /** Measured total below which the bounced raise/restore is retried. */
  bounceRetryBelowAmps: number | null;
  /** A recent restore bounced (re-shed) — restore attempts paused until the load drops. */
  restoreBlocked: boolean;
  /** Active range slot's generator-level hard cap (null = Auto). */
  slotCap: number | null;
  /** Levels the firmware never confirmed after repeated sends (empty = all reachable). */
  unreachableLevels: number[];
}

export interface AcLevelingStatus {
  enabled: boolean;
  source: PowerSource;
  measuredAmps: number | null;
  limitAmps: number | null;
  budgetAmps: number | null;
  nonAcLoadAmps: number | null;
  /** Over-limit leaky-bucket points remaining (acts at 0); `overLimitBudgetMax` is the capacity. */
  overLimitBudget: number;
  overLimitBudgetMax: number;
  headroomStreak: number;
  settleRemainingMs: number;
  /** Raises paused because the last raise's amps never showed up (0 = no hold). */
  raiseHoldRemainingMs: number;
  /** Predicted steady-state total amps after the last command batch (null once graded/none pending). */
  expectedAmps: number | null;
  /** Last completed amp-model accuracy check (expected vs measured after effects settled). */
  lastPrediction: { expectedAmps: number; actualAmps: number; at: number } | null;
  /** Last meter-sized emergency cut batch (severe over-limit fast path). */
  lastEmergency: { at: number; requiredAmps: number; savedAmps: number } | null;
  acs: AcLevelingAcStatus[];
}

interface PowerReading {
  current_1: number;
  current_2: number;
}

export class AcLeveler {
  private pool: pg.Pool;
  private deps: AcLevelerDeps;
  // Persistent state
  private config: AcLevelingConfig = { ...DEFAULT_LEVELING_CONFIG };
  private shedIds = new Set<string>();
  private shedTimes = new Map<string, number>();
  private loaded = false;
  // Power reading state (updated per ESP reading, not per tick)
  private lastReading: PowerReading | null = null;
  private lastReadingAt = 0;
  private lastSource: PowerSource = "none";
  private recentMeasured: number[] = [];
  /**
   * Over-limit leaky bucket (replaces the old consecutive mild/severe streaks +
   * the grid-only oscillation gate, 2026-06-17). Each over-limit reading drains
   * points (a reading > limit + OVER_LIMIT_SEVERE_AMPS drains 3, within that
   * drains 1); the controller acts when the bucket empties (≤ 0). Sustained
   * genuine headroom (a full RAISE_STREAK of readings ≤ limit − margin) refills
   * it to full and ends the episode. Refill is deliberately EPISODE-based, NOT
   * per-reading: a per-reading refill would let a balanced oscillation around
   * the limit (the 31A pattern) refill as fast as it drains and never act, and
   * the consecutive-streak reset-on-any-dip was exactly the gap that missed it.
   * This tolerates fluctuation above/below the limit until it genuinely
   * accumulates — and works on BOTH sources (the old gate was grid-only).
   */
  private overLimitBudget = OVER_LIMIT_BUDGET;
  /** Recent over-limit readings (window) — sizes the cut + classifies severe vs mild. */
  private overLimitReadings: number[] = [];
  private headroomStreak = 0;
  /**
   * Last emergency batch: discounts a new severe streak's savings target for
   * EMERGENCY_PENDING_MS (compressors take seconds to respond — cutting again
   * before the meter reflects the batch would stack cuts), and feeds the
   * status/UI. savedAmps = the batch's estimated savings.
   */
  private lastEmergency: { at: number; requiredAmps: number; savedAmps: number } | null = null;
  // Runtime control state
  private lastSetLevel = new Map<string, number>();
  /**
   * The gen level the shadow has actually been observed at — the baseline the
   * drift detector compares against. A divergence only counts as a manual
   * change once the shadow has confirmed our last command at least once;
   * otherwise it is an un-applied/lagging command, not a user action.
   */
  private confirmedLevel = new Map<string, number>();
  /** The level last commanded but not yet confirmed by the shadow. */
  private pendingLevel = new Map<string, number>();
  /**
   * Unconfirmed sends PER LEVEL (per device). Counted per level — not "same
   * level as the last send" — so a budget flutter that alternates the target
   * between two levels (L3, L2, L3, …) cannot reset the count and evade the
   * unreachable detection forever. Any shadow confirm clears the device's
   * whole map (the firmware proved responsive — stale counts would mis-mark).
   */
  private pendingSendCounts = new Map<string, Map<number, number>>();
  /**
   * Generator levels the firmware never applied after UNREACHABLE_LEVEL_SENDS
   * attempts (per device), mapped to WHEN they were marked — Najat accepts
   * set_generator_mode=6 (cloud OK) but her shadow never leaves 0, so the
   * never-level-0 correction re-sent L6 forever (live 2026-06-09). The
   * allocator's reachableCap falls back to the next lower level. In-memory;
   * survives power cycles and source changes (firmware property), un-marked if
   * the shadow ever confirms the level, cleared by an explicit manual gen
   * change (user probe), on restart, and by the per-mark
   * UNREACHABLE_SAFETY_EXPIRY_MS re-probe (a shadow-stuck-at-0 episode mints
   * junk marks — live 2026-06-11 Najat sat capped at L3 on grid all day).
   */
  private unreachableLevels = new Map<string, Map<number, number>>();
  /** Set on a source change so tick() re-arms the compressor ramp for ON ACs. */
  private armRampOnSourceChange = false;
  /**
   * Latched when measured current collapses (probable breaker trip / blackout):
   * raises/restores are frozen until measured recovers near `preMedian` or the
   * safety cap (`POWER_COLLAPSE_MAX_MS`) elapses. Without this, the low post-trip
   * readings build the headroom streak and raise an AC into a dead line (live
   * 2026-06-13). `preMedian` = the smoothed measured just before the collapse.
   */
  private powerCollapse: { preMedian: number; until: number } | null = null;
  /** Set when a collapse RECOVERS so tick() re-arms the compressor ramp for ON ACs. */
  private armRampOnCollapseRecovery = false;
  private manualCap = new Map<string, number>();
  private manualTarget = new Map<string, number>();
  // Fan holds: fans reduced to minimum as the last try before a shed.
  // originalFan/lastSetFan are persisted; confirmedFan (the fan the shadow has
  // actually been OBSERVED at — the drift baseline, like confirmedLevel for gen
  // levels) and the resend bookkeeping are in-memory: after a restart the first
  // observation re-adopts the baseline.
  private fanHold = new Map<string, {
    originalFan: number;
    lastSetFan: number;
    confirmedFan: number | null;
    resends: number;
    lastSendAt: number;
  }>();
  private fanExempt = new Set<string>();
  private prevPowerStates = new Map<string, boolean>();
  /** Last tick's per-device slot cap — a slot flip re-evaluates immediately. */
  private lastSlotCap = new Map<string, number | null>();
  private rampUntil = new Map<string, number>();
  private boostActive = new Map<string, boolean>();
  // Stable gen level remembered when an AC is auto-turned-off because its
  // temperature left the comfort range — warm-restored on the next turn-on
  // (persisted so a deploy mid-cycle doesn't force a slow re-climb).
  private rememberedLevel = new Map<string, number>();
  private deviceNames = new Map<string, string>();
  private settleUntil = 0;
  private forceEvaluate = false;
  private lastNonAcLoad = 0;
  private lastStatus: AcLevelingStatus | null = null;
  // Predictive bookkeeping: the non-AC load is frozen at its pre-command value
  // while compressors respond (see NON_AC_FREEZE_MS), and every command batch
  // records the steady-state total it expects so the model can be graded.
  private frozenNonAcLoad: number | null = null;
  private freezeUntil = 0;
  private expected: {
    amps: number;
    raisedAmps: number;
    at: number;
    compareAfter: number;
    /** Set when this batch was a SINGLE-AC level raise — enables two-way surge
     *  learning at grading (the meter delta IS that AC's real raise cost). */
    raiseDeviceId?: string | null;
    /** Smoothed measured at command time (pre-effect baseline for the delta). */
    preMeasured?: number;
  } | null = null;
  private lastPrediction: { expectedAmps: number; actualAmps: number; at: number } | null = null;
  /**
   * Armed by every raise batch: the next raise must either see the expected
   * effect on the total draw (released once measured ≥ expectedAmps − threshold)
   * or wait until `until` (2 min for fan/level raises, 3 min for turn-ons).
   */
  private raiseHold: { until: number; expectedAmps: number; threshold: number; checkAfter: number } | null = null;
  /**
   * Last raise batch — the bounce attribution window. A reactive over-limit
   * reduction that undoes one of these raises (or re-sheds one of these
   * restores) before `windowUntil` is a BOUNCE: the raise delivered amps but
   * pushed the total over the limit. `preMeasured` (smoothed measured at
   * command time) lets the bounce record the raise's OBSERVED cost.
   */
  private lastRaiseBatch: {
    windowUntil: number;
    preMeasured: number;
    raised: Map<string, number>;
    restored: Set<string>;
  } | null = null;
  /**
   * Bounce records (in-memory — lost on restart, accepted like manual gen
   * intents). The device retries only once the measured total drops below
   * `limit − margin − requiredAmps` (its observed cost now fits), on a
   * structural change (power cycle, source change, manual gen change, config
   * save), or after the safety expiry.
   */
  private bounce = new Map<string, { kind: "level" | "restore"; cap: number | null; requiredAmps: number; until: number }>();
  /**
   * Learned per-AC real raise cost on the CURRENT source (the compressor surge
   * of releasing a cap), updated from observed bounce costs and fed back into
   * the allocator's raise gate as `raiseSurge`. A gen level is a cap, not a
   * setpoint, so the static model understates this on a hot compressor (live:
   * 3.5A vs a 2A step) — learning it makes raises self-correct instead of
   * trusting a model the user keeps having to retune. Per-source: cleared on a
   * source change (different voltage + amp models) and on a config save.
   */
  private observedRaiseCost = new Map<string, number>();
  /**
   * Learned per-AC amps per FAN-level step on the current source. Fans aren't in
   * the amp model, so a held fan restored straight to its original on a flat
   * guess overshot and bounced (1↔full). Learned from clean fan-only restore
   * batches (meter delta ÷ steps) and fed to the allocator as `fanStepCost` so a
   * restore climbs only to the highest level that fits. Per-source; cleared on
   * source change (different voltage).
   */
  private observedFanStepCost = new Map<string, number>();
  /** In-flight fan restore awaiting its effect, for per-step cost learning. */
  private lastFanRaise: { deviceId: string; fromFan: number; toFan: number; preMeasured: number; at: number } | null = null;
  /** Last leveling push timestamp — throttles non-critical notices (see LEVELING_PUSH_THROTTLE_MS). */
  private lastLevelingPushAt = 0;

  constructor(pool: pg.Pool, deps: AcLevelerDeps) {
    this.pool = pool;
    this.deps = deps;
  }

  // ---------- Persistence ----------

  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    const cfgRes = await this.pool.query("SELECT config FROM ac_leveling_config WHERE id = 1");
    if (cfgRes.rows[0]?.config) {
      this.config = { ...DEFAULT_LEVELING_CONFIG, ...(cfgRes.rows[0].config as Partial<AcLevelingConfig>) };
    }
    const shedRes = await this.pool.query("SELECT device_id, shed_at FROM ac_leveling_shed");
    for (const row of shedRes.rows) {
      const deviceId = String(row.device_id);
      this.shedIds.add(deviceId);
      this.shedTimes.set(deviceId, row.shed_at instanceof Date ? row.shed_at.getTime() : Date.now());
    }
    const holdRes = await this.pool.query(
      "SELECT device_id, original_fan, last_set_fan FROM ac_leveling_fan_hold",
    );
    for (const row of holdRes.rows) {
      this.fanHold.set(String(row.device_id), {
        originalFan: Number(row.original_fan),
        lastSetFan: Number(row.last_set_fan),
        confirmedFan: null, // restart — re-adopt the baseline on first observation
        resends: 0,
        lastSendAt: 0,
      });
    }
    const remRes = await this.pool.query("SELECT device_id, level FROM ac_leveling_remembered_level");
    for (const row of remRes.rows) {
      this.rememberedLevel.set(String(row.device_id), Number(row.level));
    }
    this.loaded = true;
    if (this.shedIds.size > 0) {
      log.info(`[leveler] Loaded ${this.shedIds.size} shed device(s) from DB`);
    }
    if (this.fanHold.size > 0) {
      log.info(`[leveler] Loaded ${this.fanHold.size} fan hold(s) from DB`);
    }
  }

  async getConfig(): Promise<AcLevelingConfig> {
    await this.ensureLoaded();
    return this.config;
  }

  async updateConfig(cfg: AcLevelingConfig): Promise<AcLevelingConfig> {
    await this.ensureLoaded();
    // Merge over defaults so an old/partial client payload can't drop a field
    // (e.g. raiseBufferAmps) and leave the budget math reading undefined → NaN.
    cfg = { ...DEFAULT_LEVELING_CONFIG, ...cfg };
    await this.pool.query(
      `INSERT INTO ac_leveling_config (id, config, updated_at) VALUES (1, $1, NOW())
       ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config, updated_at = NOW()`,
      [JSON.stringify(cfg)],
    );
    this.config = cfg;
    this.forceEvaluate = true;
    // Limits/amp models may have changed (e.g. calibration applied) — old
    // bounce evidence and learned raise surge no longer describe the world.
    this.bounce.clear();
    this.observedRaiseCost.clear();
    this.observedFanStepCost.clear();
    this.lastFanRaise = null;
    this.lastRaiseBatch = null;
    if (!cfg.enabled) {
      this.frozenNonAcLoad = null;
      this.freezeUntil = 0;
      this.expected = null;
      this.raiseHold = null;
      this.lastEmergency = null;
    }
    if (!cfg.enabled && this.fanHold.size > 0) {
      // Leveler switched off mid-hold — leave the house physically right.
      const tcl = this.deps.getTclCloud();
      for (const [deviceId, hold] of [...this.fanHold]) {
        try {
          await tcl?.sendControl(deviceId, "set_fan_speed", hold.originalFan);
          this.deps.onLevelerFanCommand(deviceId, hold.originalFan);
        } catch (err) {
          log.error(`[leveler] Fan restore on disable failed for ${deviceId}:`, (err as Error).message);
        }
        await this.clearFanHold(deviceId, "leveler_disabled");
      }
      this.fanExempt.clear();
    }
    log.info(`[leveler] Config updated (enabled=${cfg.enabled}, grid=${cfg.gridLimitAmps}A, gen=${cfg.genLimitAmps}A)`);
    return cfg;
  }

  isEnabled(): boolean {
    return this.loaded && this.config.enabled;
  }

  getComfortTarget(): number {
    return this.config.comfortTargetC;
  }

  /** Source limits for other components (e.g. the calibration safety check). */
  getLimits(): { gridLimitAmps: number; genLimitAmps: number; marginAmps: number } {
    return {
      gridLimitAmps: this.config.gridLimitAmps,
      genLimitAmps: this.config.genLimitAmps,
      marginAmps: this.config.marginAmps,
    };
  }

  isShed(deviceId: string): boolean {
    return this.shedIds.has(deviceId);
  }

  private async recordShed(deviceId: string, reason: string): Promise<void> {
    this.shedIds.add(deviceId);
    this.shedTimes.set(deviceId, Date.now());
    // A shed/restore is governed by the floor-based restore path, not warm start.
    await this.clearRememberedLevel(deviceId, "shed");
    await this.pool.query(
      `INSERT INTO ac_leveling_shed (device_id, shed_at, reason) VALUES ($1, NOW(), $2)
       ON CONFLICT (device_id) DO UPDATE SET shed_at = NOW(), reason = EXCLUDED.reason`,
      [deviceId, reason],
    );
    this.deps.setDevicePowerCache(deviceId, "off");
    log.info(`[leveler] Shed AC ${deviceId} (${reason})`);
  }

  async clearShed(deviceId: string, reason: string): Promise<void> {
    if (!this.shedIds.delete(deviceId)) return;
    this.shedTimes.delete(deviceId);
    await this.pool.query("DELETE FROM ac_leveling_shed WHERE device_id = $1", [deviceId]);
    log.info(`[leveler] Cleared shed for AC ${deviceId} (${reason})`);
  }

  hasFanHold(deviceId: string): boolean {
    return this.fanHold.has(deviceId);
  }

  private async recordFanHold(deviceId: string, originalFan: number): Promise<void> {
    // The original fan was just OBSERVED on the device, so it doubles as the
    // confirmed drift baseline for the command about to be sent.
    this.fanHold.set(deviceId, {
      originalFan,
      lastSetFan: originalFan,
      confirmedFan: originalFan,
      resends: 0,
      lastSendAt: Date.now(),
    });
    await this.pool.query(
      `INSERT INTO ac_leveling_fan_hold (device_id, original_fan, last_set_fan, held_at)
       VALUES ($1, $2, $2, NOW())
       ON CONFLICT (device_id) DO NOTHING`,
      [deviceId, originalFan],
    );
  }

  private async setFanHoldLastSet(deviceId: string, fan: number): Promise<void> {
    const hold = this.fanHold.get(deviceId);
    if (!hold) return;
    // A fresh command starts a fresh confirm/resend cycle.
    this.fanHold.set(deviceId, { ...hold, lastSetFan: fan, resends: 0, lastSendAt: Date.now() });
    await this.pool.query(
      "UPDATE ac_leveling_fan_hold SET last_set_fan = $2 WHERE device_id = $1",
      [deviceId, fan],
    );
  }

  private async clearFanHold(deviceId: string, reason: string): Promise<void> {
    if (!this.fanHold.delete(deviceId)) return;
    await this.pool.query("DELETE FROM ac_leveling_fan_hold WHERE device_id = $1", [deviceId]);
    log.info(`[leveler] Released fan hold for AC ${deviceId} (${reason})`);
  }

  /**
   * Remember the level this AC was stable at, captured by the collector right
   * before a temperature-cycling auto-off. On the next turn-on the allocator
   * warm-restores straight to it (budget permitting) instead of re-climbing.
   * Only stores levels above the base floor — L1 is the default restore anyway.
   */
  async rememberStableLevel(deviceId: string): Promise<void> {
    await this.ensureLoaded();
    if (!this.config.enabled) return;
    const level = this.lastSetLevel.get(deviceId);
    if (level == null || level < 2) return;
    this.rememberedLevel.set(deviceId, level);
    await this.pool.query(
      `INSERT INTO ac_leveling_remembered_level (device_id, level, remembered_at) VALUES ($1, $2, NOW())
       ON CONFLICT (device_id) DO UPDATE SET level = EXCLUDED.level, remembered_at = NOW()`,
      [deviceId, level],
    );
    log.info(`[leveler] Remembered stable level L${level} for AC ${this.deviceNames.get(deviceId) ?? deviceId} (temperature cycle)`);
  }

  private async clearRememberedLevel(deviceId: string, reason: string): Promise<void> {
    if (!this.rememberedLevel.delete(deviceId)) return;
    await this.pool.query("DELETE FROM ac_leveling_remembered_level WHERE device_id = $1", [deviceId]);
    log.info(`[leveler] Cleared remembered level for AC ${this.deviceNames.get(deviceId) ?? deviceId} (${reason})`);
  }

  /** Observed ON out-of-band — clear shed after the shadow-lag grace period. */
  async reconcileObservedOn(deviceId: string): Promise<void> {
    if (!this.shedIds.has(deviceId)) return;
    const shedAt = this.shedTimes.get(deviceId);
    if (shedAt != null && Date.now() - shedAt < SHED_CLEAR_GRACE_MS) return;
    await this.clearShed(deviceId, "observed_on");
    this.forceEvaluate = true;
  }

  // ---------- Power readings (called per ESP ingest) ----------

  onPowerReading(data: { current_1: number; current_2: number }): void {
    this.lastReading = { current_1: data.current_1, current_2: data.current_2 };
    this.lastReadingAt = Date.now();
    const source = determineSource(this.lastReading, 0);
    if (source !== this.lastSource) {
      const prevSource = this.lastSource;
      this.lastSource = source;
      this.overLimitBudget = OVER_LIMIT_BUDGET;
      this.overLimitReadings = [];
      this.headroomStreak = 0;
      this.recentMeasured = [];
      // A collapse latch is per-source (different baseline + the new source's
      // readings re-establish the trend); a changeover restarts compressors anyway.
      this.powerCollapse = null;
      this.armRampOnCollapseRecovery = false;
      this.forceEvaluate = true;
      // A frozen load / pending expectation / raise hold from the other source is meaningless.
      this.frozenNonAcLoad = null;
      this.freezeUntil = 0;
      this.expected = null;
      this.raiseHold = null;
      // An emergency discount sized on the other source's readings is meaningless too.
      this.lastEmergency = null;
      // Bounce evidence is per-source (different limit + amp models).
      this.bounce.clear();
      // Learned raise surge + fan-step cost are per-source too (different voltage).
      this.observedRaiseCost.clear();
      this.observedFanStepCost.clear();
      this.lastFanRaise = null;
      this.lastRaiseBatch = null;
      // Drift baselines are per-source too: a changeover restarts the
      // compressors and the firmware can come back at a different level — a
      // stale cross-source baseline (or a command left in flight) would let
      // the drift detector stamp a false manualCap/manualTarget. The first
      // post-change observation simply re-adopts the baseline.
      this.confirmedLevel.clear();
      this.pendingLevel.clear();
      this.pendingSendCounts.clear();
      // A true Gen↔Grid changeover restarts every running compressor — treat it
      // like a turn-on so tick() re-arms the ~4-min ramp window for ON ACs.
      // Coming back from "none" (ESP/power resuming) is NOT a restart: the ACs
      // were already running steadily, so their draw stays in the load math.
      if (prevSource !== "none" && source !== "none") this.armRampOnSourceChange = true;
      // Moving onto Grid (15A→30A budget): a cap fitted to the generator budget
      // no longer applies — release manual caps so ACs can run up again. Caps
      // are kept on Grid→Gen (the tight budget may still need them).
      if (source === "grid") {
        this.manualCap.clear();
        this.manualTarget.clear();
      }
      log.info(`[leveler] Power source changed → ${source}`);
    }
    if (source === "none") return;

    const limit = source === "grid" ? this.config.gridLimitAmps : this.config.genLimitAmps;
    const measured = source === "grid" ? data.current_1 : data.current_2;

    // Probable trip/blackout handling (judged on the trend BEFORE this reading
    // joins the window). A large measured drop that lands at/below the absolute
    // floor means the AC load vanished — the breaker tripped; the latch freezes
    // raises so the low post-trip readings can't build the headroom streak and
    // raise an AC into a dead line. First resolve an active latch: recovery (the
    // load came back near the pre-collapse level) clears it and re-arms the
    // compressor ramp; the safety cap clears it so the freeze can't strand.
    //
    // 2026-06-17: detection is NO LONGER gated on `outside settle` — the leveler
    // commands almost every tick during an over-limit episode, which kept the
    // settle window fresh and made guard B miss a trip that happened mid-episode
    // (live 03:14 trip, missed). The ≤ POWER_COLLAPSE_FLOOR_AMPS floor is the
    // real discriminator: a normal reduction/shed leaves the remaining ACs
    // drawing well above the floor, so only an actual trip latches. A deliberate
    // big shed that DOES land ≤ floor latching is benign — raises should be
    // frozen right after a big shed anyway, and the latch clears on recovery.
    const now = this.lastReadingAt;
    const priorMedian = this.recentMeasured.length >= 4 ? this.smoothedMeasured() : null;
    if (this.powerCollapse != null) {
      if (measured >= this.powerCollapse.preMedian - POWER_COLLAPSE_RECOVER_GAP) {
        this.powerCollapse = null;
        this.armRampOnCollapseRecovery = true;
        this.headroomStreak = 0; // rebuild a fresh streak before any raise
      } else if (now >= this.powerCollapse.until) {
        this.powerCollapse = null;
      }
    }
    if (
      this.powerCollapse == null &&
      priorMedian != null &&
      priorMedian - measured >= POWER_COLLAPSE_DROP_AMPS &&
      measured <= POWER_COLLAPSE_FLOOR_AMPS
    ) {
      this.powerCollapse = { preMedian: priorMedian, until: now + POWER_COLLAPSE_MAX_MS };
      this.headroomStreak = 0;
      log.warn(
        `[leveler] Power collapse ${priorMedian.toFixed(1)}A → ${measured.toFixed(1)}A on ` +
        `${source} — probable trip/blackout; freezing raises until recovery`,
      );
    }

    this.recentMeasured.push(measured);
    if (this.recentMeasured.length > 8) this.recentMeasured.shift();

    if (measured > limit) {
      // Over the limit → drain the bucket. Magnitude-weighted (user's rule):
      // more than OVER_LIMIT_SEVERE_AMPS over costs 3 points, within it costs 1.
      this.headroomStreak = 0;
      const drain = measured - limit > OVER_LIMIT_SEVERE_AMPS ? OVER_LIMIT_DRAIN_SEVERE : OVER_LIMIT_DRAIN_MILD;
      this.overLimitBudget = Math.max(0, this.overLimitBudget - drain);
      this.overLimitReadings.push(measured);
      if (this.overLimitReadings.length > 8) this.overLimitReadings.shift();
      // Bucket empty → act now instead of waiting up to 5s for the loop tick
      // (the breaker trips in seconds). Fires while ≤0 so a tick that failed
      // (TCL error) re-fires on the next reading; the collector guard coalesces.
      if (this.overLimitBudget <= 0) this.deps.onUrgentLevelingNeeded?.();
    } else if (measured <= limit - this.config.marginAmps) {
      // Genuine headroom builds at the un-buffered threshold so cheap, comfort-
      // positive fan restores (gated by canRaise) recover on real headroom —
      // gen-level raises stay buffer-bound via the allocator's raiseBudgetAmps.
      if (this.powerCollapse != null) {
        // Probable trip in progress — this low reading is lost AC load, not real
        // headroom; don't let it unlock a raise/restore into a dead line.
        this.headroomStreak = 0;
      } else {
        this.headroomStreak++;
        // Sustained calm = the over-limit episode is over → refill the bucket to
        // full and forget the episode. Episode-based, NOT per-reading, refill:
        // a per-dip refill would let a balanced oscillation around the limit
        // refill as fast as it drains and never act (the 31A failure mode).
        if (this.headroomStreak >= RAISE_STREAK) {
          this.overLimitBudget = OVER_LIMIT_BUDGET;
          this.overLimitReadings = [];
        }
      }
    } else {
      // Margin band (limit−margin, limit]: riding just under the breaker —
      // neither genuine headroom (no raise) nor over (no drain). Hold the bucket.
      this.headroomStreak = 0;
    }
  }

  /** Median of a list (sized cuts / overshoot from the over-limit window). */
  private static median(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  /** Median of the last 4 readings — smooths generator fluctuation for budget math. */
  private smoothedMeasured(): number {
    const window = this.recentMeasured.slice(-4);
    if (window.length === 0) return 0;
    const sorted = [...window].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  /** Source-specific draw model: gen model when on generator (more amps at lower voltage), else grid. */
  private ampModelFor(deviceId: string, source: PowerSource): AcAmpModel {
    if (source === "gen") {
      const gen = this.config.genAmpModels?.[deviceId];
      if (gen) return gen;
    }
    return this.config.ampModels[deviceId] ?? { baseAmps: 2, stepAmps: 1 };
  }

  // ---------- User intents (called from routes via collector handlers) ----------

  async onUserPowerOff(deviceId: string): Promise<void> {
    await this.ensureLoaded();
    // User confirmed OFF — the shed no longer drives this device (manual-off lock takes over).
    await this.clearShed(deviceId, "user_power_off");
    await this.clearRememberedLevel(deviceId, "user_power_off");
    this.manualCap.delete(deviceId);
    this.manualTarget.delete(deviceId);
    this.lastSetLevel.delete(deviceId);
    this.confirmedLevel.delete(deviceId);
    this.pendingLevel.delete(deviceId);
    this.pendingSendCounts.delete(deviceId);
    await this.clearFanHold(deviceId, "user_power_off");
    this.fanExempt.delete(deviceId);
    this.bounce.delete(deviceId);
    this.forceEvaluate = true;
  }

  /** User changed the fan (UI or detected) — their fan is the new truth; never re-reduce this episode. */
  async onUserFanChange(deviceId: string): Promise<void> {
    await this.ensureLoaded();
    await this.clearFanHold(deviceId, "user_fan_change");
    this.fanExempt.add(deviceId);
  }

  async onUserPowerOn(deviceId: string): Promise<void> {
    await this.ensureLoaded();
    await this.clearShed(deviceId, "user_power_on");
    // Compressor ramp window — see the nonAcLoad derivation in tick()
    this.rampUntil.set(deviceId, Date.now() + AC_RAMP_MS);
    this.bounce.delete(deviceId);
    this.forceEvaluate = true;
  }

  /**
   * Re-arm compressor ramp windows for devices an external flow just power-
   * cycled (the calibration end-of-run restore). Narrow on purpose: unlike
   * onUserPowerOn it must NOT clear sheds or bounce evidence.
   */
  rearmRamp(deviceIds: string[]): void {
    const until = Date.now() + AC_RAMP_MS;
    for (const id of deviceIds) this.rampUntil.set(id, until);
    this.forceEvaluate = true;
  }

  /**
   * User changed the generator level (UI route or agent). Reduction → manual cap.
   * Increment within budget → manual target. Increment over budget → instant revert.
   */
  async onUserGenLevel(deviceId: string, level: number): Promise<{ reverted: boolean; level: number }> {
    await this.ensureLoaded();
    if (!this.config.enabled) return { reverted: false, level };
    const tcl = this.deps.getTclCloud();
    const device = tcl?.getDevices().find((d) => d.id === deviceId);
    if (!device || !this.lastStatus?.acs.find((a) => a.deviceId === deviceId)?.managed) {
      return { reverted: false, level };
    }
    const maxLevel = device.maxGeneratorLevel || 3;
    // A stale client/agent can post a level above the device max (e.g. Najat
    // 4–6 after TCL removed them in 2026-06). The cloud layer clamps the
    // publish; clamp the intent too so pendingLevel is a level the shadow can
    // actually confirm (an unconfirmable pending wedges drift bookkeeping and
    // mints a pointless unreachable mark). 0 (auto) passes through.
    if (level > maxLevel) level = maxLevel;
    const previous = this.lastSetLevel.get(deviceId) ?? device.generatorMode;
    const rank = (l: number): number => (l <= 0 ? maxLevel + 1 : Math.min(l, maxLevel));
    // Manual intent replaces bounce evidence (manualCap/manualTarget take over)
    // and any warm-restore target — the user owns the level now. An explicit
    // gen change is also a fresh probe of what the firmware accepts, so
    // unreachable-level marks reset (mirrors bounce clearing).
    this.bounce.delete(deviceId);
    this.unreachableLevels.delete(deviceId);
    this.pendingSendCounts.delete(deviceId);
    await this.clearRememberedLevel(deviceId, "manual_gen_change");

    if (rank(level) < rank(previous)) {
      // Manual reduction — user override; never raise above it again.
      this.manualCap.set(deviceId, Math.max(1, rank(level)));
      this.manualTarget.delete(deviceId);
      this.lastSetLevel.set(deviceId, level);
      // The route already drove the device to `level`; mark it pending so the
      // drift loop waits for the shadow to confirm rather than re-deriving an
      // intent from a still-lagging shadow.
      this.pendingLevel.set(deviceId, level);
      this.forceEvaluate = true;
      log.info(`[leveler] Manual gen reduction on ${deviceId} → cap L${rank(level)}`);
      return { reverted: false, level };
    }

    // Manual increment — validate projection against the active source limit.
    const source = determineSource(this.lastReading, Date.now() - this.lastReadingAt);
    if (source !== "none" && tcl) {
      const limit = source === "grid" ? this.config.gridLimitAmps : this.config.genLimitAmps;
      let projected = this.lastNonAcLoad;
      for (const d of tcl.getDevices()) {
        if (!d.power && d.id !== deviceId) continue;
        const lvl = d.id === deviceId ? level : (this.lastSetLevel.get(d.id) ?? d.generatorMode);
        projected += estimateAcDraw(lvl, d.maxGeneratorLevel || 3, this.ampModelFor(d.id, source));
      }
      if (projected > limit - this.config.marginAmps) {
        const revertTo = Math.max(1, rank(previous) > maxLevel ? maxLevel : Math.max(1, previous));
        try {
          await tcl.sendControl(deviceId, "set_generator_mode", revertTo);
          this.lastSetLevel.set(deviceId, revertTo);
          this.pendingLevel.set(deviceId, revertTo);
          log.warn(
            `[leveler] Manual gen increment on ${deviceId} to L${level} projects ${projected.toFixed(1)}A > ` +
            `${limit}A limit on ${source} — reverted to L${revertTo}`,
          );
          return { reverted: true, level: revertTo };
        } catch (err) {
          log.error(`[leveler] Revert of manual gen increment failed for ${deviceId}:`, (err as Error).message);
          return { reverted: false, level };
        }
      }
    }

    this.manualTarget.set(deviceId, rank(level));
    this.manualCap.delete(deviceId);
    this.lastSetLevel.set(deviceId, level);
    this.pendingLevel.set(deviceId, level);
    log.info(`[leveler] Manual gen target on ${deviceId} → L${rank(level)}`);
    return { reverted: false, level };
  }

  // ---------- Main tick (called from the collector loop) ----------

  /**
   * Conditional minimum level (e.g. Abdullah L2 when outdoor ≥ 37°C) with 1°C
   * hysteresis so it doesn't flap at the boundary; holds state when outdoor
   * temp is unknown.
   */
  private minLevelFor(deviceId: string, maxLevel: number, outdoorTempC: number | null): number {
    const boost = this.config.levelBoosts[deviceId];
    if (!boost || boost.minLevel <= 1) return 1;
    let active = this.boostActive.get(deviceId) ?? false;
    if (outdoorTempC != null) {
      if (outdoorTempC >= boost.outdoorAtLeastC) active = true;
      // Releases AT threshold−1 (e.g. 37° boost releases at exactly 36.0°).
      else if (outdoorTempC <= boost.outdoorAtLeastC - 1) active = false;
    }
    if (active !== (this.boostActive.get(deviceId) ?? false)) {
      log.info(`[leveler] ${this.deviceNames.get(deviceId) ?? deviceId}: outdoor ${outdoorTempC}°C → min level boost ${active ? "ON" : "OFF"} (min L${boost.minLevel})`);
    }
    this.boostActive.set(deviceId, active);
    return active ? Math.min(boost.minLevel, maxLevel) : 1;
  }

  async tick(ctx: LevelerDeviceContext[], outdoorTempC: number | null): Promise<void> {
    await this.ensureLoaded();
    if (!this.config.enabled) {
      this.lastStatus = null;
      return;
    }
    const tcl = this.deps.getTclCloud();
    if (!tcl || !tcl.isReady()) return;

    for (const { device } of ctx) {
      this.deviceNames.set(device.id, device.name);
    }

    // A range-slot flip that changes a device's gen-level cap is a structural
    // change: an over-cap AC reduces immediately (reductions are never
    // hold-blocked), a freed AC re-fills on the next gated raise.
    for (const { device, slotGenCap } of ctx) {
      const prev = this.lastSlotCap.get(device.id);
      if (prev !== undefined && prev !== (slotGenCap ?? null)) this.forceEvaluate = true;
      this.lastSlotCap.set(device.id, slotGenCap ?? null);
    }

    // Structural change detection: AC power flips since the last tick.
    for (const { device } of ctx) {
      const prev = this.prevPowerStates.get(device.id);
      if (prev != null && prev !== device.power) {
        this.forceEvaluate = true;
        if (device.power) {
          // Fresh turn-on: compressor hasn't ramped — keep its estimated draw
          // out of the non-AC load math so a near-limit turn-on reduces instantly.
          this.rampUntil.set(device.id, Date.now() + AC_RAMP_MS);
        }
        log.info(`[leveler] ${device.name}: power ${prev ? "ON" : "OFF"} → ${device.power ? "ON" : "OFF"} (re-evaluating)`);
      }
      this.prevPowerStates.set(device.id, device.power);
      if (device.power && this.shedIds.has(device.id)) {
        await this.reconcileObservedOn(device.id);
      }
      if (!device.power) {
        // Power-off clears manual gen intents, drift tracking, and fan holds.
        // Unreachable-level marks deliberately SURVIVE (firmware property).
        this.manualCap.delete(device.id);
        this.manualTarget.delete(device.id);
        this.lastSetLevel.delete(device.id);
        this.confirmedLevel.delete(device.id);
        this.pendingLevel.delete(device.id);
        this.pendingSendCounts.delete(device.id);
        this.rampUntil.delete(device.id);
        await this.clearFanHold(device.id, "power_off");
        this.fanExempt.delete(device.id);
        // Level-bounce caps reset on a power cycle. Restore-kind records must
        // survive here — a restore-bounced shed AC is off every tick.
        if (this.bounce.get(device.id)?.kind === "level") this.bounce.delete(device.id);
      }
    }

    // A power-source change OR recovery from a collapse (trip/blackout) restarts
    // / re-disturbs every running compressor, so re-arm the ramp window for ON
    // managed ACs — their estimated draw stays double-counted (out of the non-AC
    // load derivation) through the ~4-min transition, preventing phantom-headroom
    // raises and nonAcLoad miscalc as the compressors spin back up.
    if (this.armRampOnSourceChange || this.armRampOnCollapseRecovery) {
      const now = Date.now();
      for (const { device, managed } of ctx) {
        if (device.power && managed) this.rampUntil.set(device.id, now + AC_RAMP_MS);
      }
      this.armRampOnSourceChange = false;
      this.armRampOnCollapseRecovery = false;
    }

    const inSettle = Date.now() < this.settleUntil;

    // Confirmation-gated fan-drift detection (mirrors the gen-level design):
    // the drift baseline is the fan the shadow has actually been OBSERVED at,
    // not the fan we last commanded. A shadow that still shows the PRE-command
    // fan is a lagging or firmware-ignored command — Najat routinely needs
    // commands re-done — so it gets re-sent (bounded), never misread as a
    // manual change. Only an observed move to a fan we never commanded
    // releases the hold (the user's fan wins; never re-reduce this episode).
    for (const { device } of ctx) {
      const hold = this.fanHold.get(device.id);
      if (!hold || !device.power || inSettle || typeof device.fanSpeed !== "number") continue;
      const obs = device.fanSpeed;
      if (obs === hold.lastSetFan) {
        // Our command landed — promote it to the confirmed baseline.
        if (hold.confirmedFan !== obs) {
          this.fanHold.set(device.id, { ...hold, confirmedFan: obs, resends: 0 });
        }
        continue;
      }
      if (hold.confirmedFan == null) {
        // Restart mid-hold — adopt the first observation as the baseline.
        this.fanHold.set(device.id, { ...hold, confirmedFan: obs });
        continue;
      }
      if (obs === hold.confirmedFan) {
        // Command in flight not applied yet — confirm-or-resend, then leave the
        // hold in place (it is NOT a manual change; releasing here exempted
        // Najat from fan reduction every episode, live 2026-06-09).
        if (hold.resends < FAN_RESEND_MAX && Date.now() - hold.lastSendAt >= FAN_RESEND_SPACING_MS) {
          try {
            await tcl.sendControl(device.id, "set_fan_speed", hold.lastSetFan);
            this.deps.onLevelerFanCommand(device.id, hold.lastSetFan);
            this.fanHold.set(device.id, { ...hold, resends: hold.resends + 1, lastSendAt: Date.now() });
            log.info(
              `[leveler] ${device.name}: fan ${hold.lastSetFan} not applied (shadow still ${obs}) — ` +
              `re-sent (${hold.resends + 1}/${FAN_RESEND_MAX})`,
            );
          } catch (err) {
            log.error(`[leveler] Fan re-send failed for ${device.name}:`, (err as Error).message);
          }
        }
        continue;
      }
      log.info(`[leveler] ${device.name}: external fan change observed (fan=${obs}) — releasing hold`);
      await this.clearFanHold(device.id, "external_fan_change");
      this.fanExempt.add(device.id);
    }

    // Sustained headroom ends the over-limit episode — user fan exemptions reset.
    if (this.headroomStreak >= RAISE_STREAK && this.fanExempt.size > 0) {
      this.fanExempt.clear();
    }

    // Confirmation-gated shadow-drift detection. The drift reference is the
    // CONFIRMED baseline — the level the shadow has actually been OBSERVED at,
    // not the level we last commanded. A command in flight does not change the
    // observed level until it lands, so a lagging or firmware-ignored gen-level
    // write leaves obs === confirmed (no false cap). When the observed level
    // finally CHANGES: if it changed to the level we commanded (pendingLevel),
    // our command landed (no manual intent); otherwise it is a manual/remote
    // change. Comparing against the observation — not the command — means a
    // command that never lands can never strand drift detection.
    for (const { device, managed } of ctx) {
      if (!device.power || !managed) continue;
      const obs = device.generatorMode;
      const confirmed = this.confirmedLevel.get(device.id);
      if (confirmed == null) {
        // First observation — adopt the shadow as the baseline (but not a
        // mid-command shadow inside the settle window).
        if (!inSettle) {
          this.confirmedLevel.set(device.id, obs);
          this.lastSetLevel.set(device.id, obs);
        }
        continue;
      }
      if (inSettle) continue;
      if (obs === confirmed) continue; // observed level unchanged since last confirm
      const pending = this.pendingLevel.get(device.id);
      if (pending != null && obs === pending) {
        // Our command landed — promote it to the confirmed baseline, no intent.
        this.confirmedLevel.set(device.id, obs);
        this.pendingLevel.delete(device.id);
        this.pendingSendCounts.delete(device.id);
        // The firmware applied it after all — drop any unreachable mark.
        if (this.unreachableLevels.get(device.id)?.delete(obs)) {
          log.info(`[leveler] ${device.name}: L${obs} confirmed after all — unreachable mark cleared`);
        }
        continue;
      }
      if (obs <= 0) {
        // A shadow snapping to 0 (unrestricted) is a firmware reset/non-apply,
        // never a user intent — live 2026-06-10 it was stamped as a manual
        // "target L7" while Najat ran unrestricted at 31A on grid. Re-adopt the
        // baseline silently; the never-level-0 correction re-caps it (ungated)
        // and the kept pendingLevel lets the unreachable counting continue.
        this.confirmedLevel.set(device.id, obs);
        continue;
      }
      const unreach = this.unreachableLevels.get(device.id);
      if (unreach?.has(obs)) {
        // The firmware applied a level we had already marked unreachable — its
        // confirm lag outlasted the send window (live 2026-06-11: Najat's L4
        // landed 6s AFTER the 3rd send marked it, and the fallback had already
        // moved pending to L3, so this read as a manual "target L4"). The
        // observation is proof of reachability: un-mark, re-adopt as the
        // baseline with no manual intent, and re-evaluate to climb back.
        unreach.delete(obs);
        this.confirmedLevel.set(device.id, obs);
        this.lastSetLevel.set(device.id, obs);
        this.pendingLevel.delete(device.id);
        this.pendingSendCounts.delete(device.id);
        this.forceEvaluate = true;
        log.info(`[leveler] ${device.name}: L${obs} confirmed late — unreachable mark cleared, re-adopting`);
        continue;
      }
      // The observed level moved off the confirmed baseline to something we did
      // not command: a genuine manual/remote change.
      const maxLevel = device.maxGeneratorLevel || 3;
      const rank = (l: number): number => (l <= 0 ? maxLevel + 1 : Math.min(l, maxLevel));
      if (rank(obs) < rank(confirmed)) {
        this.manualCap.set(device.id, rank(obs));
        this.manualTarget.delete(device.id);
        log.info(`[leveler] ${device.name}: external gen reduction observed → cap L${rank(obs)}`);
      } else {
        this.manualTarget.set(device.id, rank(obs));
        this.manualCap.delete(device.id);
        log.info(`[leveler] ${device.name}: external gen increment observed → target L${rank(obs)}`);
      }
      this.confirmedLevel.set(device.id, obs);
      this.lastSetLevel.set(device.id, obs);
      this.pendingLevel.delete(device.id);
      this.forceEvaluate = true;
    }

    const source = determineSource(this.lastReading, Date.now() - this.lastReadingAt);
    if (source === "none") {
      // No electricity / no ESP signal — pause decisions, reset gating.
      this.overLimitBudget = OVER_LIMIT_BUDGET;
      this.overLimitReadings = [];
      this.headroomStreak = 0;
      this.frozenNonAcLoad = null;
      this.freezeUntil = 0;
      this.expected = null;
      this.raiseHold = null;
      this.lastEmergency = null;
      this.lastStatus = this.buildStatus(ctx, source, null, null, null);
      return;
    }
    const limit = source === "grid" ? this.config.gridLimitAmps : this.config.genLimitAmps;

    // Unreachable-mark safety expiry: a transient shadow-stuck-at-0 episode
    // (firmware reset) can mint marks for levels that normally apply — live
    // 2026-06-11 a morning grid episode marked Najat L4–L6 and capped her at
    // L3 all day despite ~19A of free budget. Expired marks get re-probed;
    // genuinely dead levels just re-mark after UNREACHABLE_LEVEL_SENDS.
    if (this.unreachableLevels.size > 0) {
      const nowMs = Date.now();
      for (const [deviceId, marks] of [...this.unreachableLevels]) {
        for (const [level, markedAt] of [...marks]) {
          if (nowMs - markedAt >= UNREACHABLE_SAFETY_EXPIRY_MS) {
            marks.delete(level);
            this.forceEvaluate = true;
            log.info(`[leveler] ${this.deviceNames.get(deviceId) ?? deviceId}: unreachable mark L${level} expired (safety net) — re-probing`);
          }
        }
        if (marks.size === 0) this.unreachableLevels.delete(deviceId);
      }
    }

    // Bounce retry check: a bounced raise/restore unlocks once the measured
    // total drops enough to absorb its OBSERVED cost under the limit, or the
    // safety expiry passes. Settle-window readings are skipped — they still
    // show the pre-command draw.
    if (this.bounce.size > 0) {
      const nowMs = Date.now();
      const smoothed = this.smoothedMeasured();
      for (const [deviceId, entry] of [...this.bounce]) {
        if (nowMs >= entry.until) {
          this.bounce.delete(deviceId);
          log.info(`[leveler] ${this.deviceNames.get(deviceId) ?? deviceId}: bounce record expired (safety net)`);
        } else if (
          !inSettle &&
          this.recentMeasured.length >= 4 &&
          // SUSTAINED genuine headroom, not just a momentary drop (2026-06-17):
          // the old check cleared the cap the instant ANY cut dropped the total —
          // including shedding a DIFFERENT AC, whose restore then re-loaded the
          // line and re-bounced this one (live: Najat shed → Abdu bounce cleared
          // → Abdu re-raised → re-bounce). Requiring a full RAISE_STREAK of
          // headroom (longer than RESTORE_SHED_STREAK) lets a shed AC come back
          // first, so a bounced AC only retries on real, lasting headroom. Still
          // evidence-based (the load genuinely dropped and held), not a timer.
          this.headroomStreak >= RAISE_STREAK &&
          smoothed + entry.requiredAmps <= limit - this.config.marginAmps - this.config.raiseBufferAmps
        ) {
          this.bounce.delete(deviceId);
          log.info(
            `[leveler] ${this.deviceNames.get(deviceId) ?? deviceId}: load dropped ` +
            `(${smoothed.toFixed(1)}A + ${entry.requiredAmps.toFixed(1)}A observed cost fits under ${(limit - this.config.marginAmps - this.config.raiseBufferAmps).toFixed(1)}A, sustained) — bounce ${entry.kind === "level" ? `cap L${entry.cap}` : "restore block"} cleared`,
          );
        }
      }
    }

    // Snapshots sorted by configured priority (unknown devices go last).
    const order = new Map(this.config.priority.map((id, i) => [id, i]));
    const sorted = [...ctx].sort(
      (a, b) => (order.get(a.device.id) ?? 999) - (order.get(b.device.id) ?? 999),
    );
    const snapshots: LevelerAcSnapshot[] = sorted.map(({ device, managed, needTier, needDelta, slotGenCap }) => {
      const maxLevel = device.maxGeneratorLevel || 3;
      const currentLevel = inSettle ? (this.lastSetLevel.get(device.id) ?? device.generatorMode) : device.generatorMode;
      // Warm restore: a remembered level still above where the AC came back on.
      // rank() treats 0 (unrestricted) as above the top — that case is capped by
      // the level-0 rule, not warm start.
      const rank = (l: number): number => (l <= 0 ? maxLevel + 1 : Math.min(l, maxLevel));
      const remembered = this.rememberedLevel.get(device.id);
      const warmStartLevel = managed && device.power && remembered != null && rank(currentLevel) < remembered
        ? remembered
        : null;
      // Highest level not marked firmware-unreachable, walking down from the
      // top (marks accumulate top-down via the fallback; L1 is never marked).
      const unreachable = this.unreachableLevels.get(device.id);
      let reachableCap: number | null = null;
      if (unreachable && unreachable.size > 0) {
        let cap = maxLevel;
        while (cap > 1 && unreachable.has(cap)) cap--;
        reachableCap = cap;
      }
      return {
        deviceId: device.id,
        on: device.power,
        managed,
        shed: this.shedIds.has(device.id),
        maxLevel,
        currentLevel,
        minLevel: this.minLevelFor(device.id, maxLevel, outdoorTempC),
        needTier,
        needDelta,
        manualCap: this.manualCap.get(device.id) ?? null,
        manualTarget: this.manualTarget.get(device.id) ?? null,
        fanSpeed: (inSettle
          ? this.fanHold.get(device.id)?.lastSetFan ?? device.fanSpeed
          : device.fanSpeed) ?? null,
        fanRestoreTarget: this.fanHold.get(device.id)?.originalFan ?? null,
        fanExempt: this.fanExempt.has(device.id),
        bounceCap: (() => {
          const entry = this.bounce.get(device.id);
          return entry?.kind === "level" ? entry.cap : null;
        })(),
        restoreBlocked: this.bounce.get(device.id)?.kind === "restore",
        slotCap: slotGenCap != null ? Math.max(1, Math.min(slotGenCap, maxLevel)) : null,
        reachableCap,
        warmStartLevel,
      };
    });

    // Clear remembered levels that have been reached (AC on at/above the
    // remembered level) — the warm restore is done. Off devices keep their
    // memory for the next turn-on. "Reached" requires a CONFIRMED level ≥ 1:
    // an observed generatorMode 0 ranks as maxLevel+1 in the warm-start math,
    // which silently erased the memory ~300ms after it was written whenever
    // the shadow lagged or never applied the level (Najat, live 2026-06-09).
    for (const s of snapshots) {
      const remembered = this.rememberedLevel.get(s.deviceId);
      if (remembered == null || !s.on || !s.managed) continue;
      if (s.currentLevel >= 1 && Math.min(s.currentLevel, s.maxLevel) >= remembered) {
        await this.clearRememberedLevel(s.deviceId, "reached");
      }
    }

    // A manual-off-locked shed AC can never be restored — clear the shed now
    // so the allocator doesn't reduce running ACs to make room for a restore
    // that execute() would abort anyway.
    for (const s of snapshots) {
      if (!s.on && s.shed && s.managed && (await this.deps.isManualOffLocked(s.deviceId))) {
        await this.clearShed(s.deviceId, "manual_off_lock");
        s.shed = false;
      }
    }

    // A managed AC stuck below its boost floor "can't work" — allow same-tick
    // reductions elsewhere to make room for the correction.
    for (const s of snapshots) {
      if (s.on && s.managed && s.currentLevel >= 1 && s.currentLevel < s.minLevel && s.manualCap == null) {
        this.forceEvaluate = true;
      }
    }

    const now = Date.now();
    const measured = this.smoothedMeasured();

    // Grade the last command batch's prediction once its effects had time to
    // materialize (settle for level changes, compressor ramp for turn-ons).
    if (this.expected && now >= this.expected.compareAfter && this.recentMeasured.length >= 4) {
      const err = measured - this.expected.amps;
      this.lastPrediction = { expectedAmps: this.expected.amps, actualAmps: measured, at: now };
      if (Math.abs(err) > PREDICTION_WARN_AMPS) {
        log.warn(
          `[leveler] Amp model off by ${err >= 0 ? "+" : ""}${err.toFixed(1)}A ` +
          `(expected ${this.expected.amps.toFixed(1)}A, measured ${measured.toFixed(1)}A on ${source}) — ` +
          `consider tuning ampModels or running calibration`,
        );
      }
      // Two-way surge self-correction (gen): a CLEAN single-AC raise that has now
      // landed teaches the REAL cost of releasing that AC's cap — both up (the
      // bounce path already learns overshoots) and crucially DOWN (it drew less
      // than the static model feared, so the raise gate stops over-charging it
      // into conservatism). Skipped if the raise already bounced — `lastRaiseBatch`
      // is nulled on bounce, so a post-reduction meter can't undo the safety
      // learning the bounce recorded.
      if (
        source === "gen" &&
        this.expected.raiseDeviceId != null &&
        this.expected.preMeasured != null &&
        this.lastRaiseBatch != null
      ) {
        const observed = measured - this.expected.preMeasured;
        if (observed > 0) {
          const id = this.expected.raiseDeviceId;
          const prev = this.observedRaiseCost.get(id);
          this.observedRaiseCost.set(id, prev == null ? observed : prev * 0.5 + observed * 0.5);
        }
      }
      this.expected = null;
    }

    // Learn the real per-fan-step cost from a clean fan-only restore once its
    // effect has settled (fans aren't modeled — this is what lets the restore
    // climb to the highest fan that fits instead of jumping to full and
    // bouncing). meter delta ÷ steps, light EWMA, gen only.
    if (
      source === "gen" &&
      this.lastFanRaise &&
      now >= this.lastFanRaise.at + FAN_SETTLE_MS &&
      this.recentMeasured.length >= 4
    ) {
      const fr = this.lastFanRaise;
      const steps = fr.toFan - fr.fromFan;
      const observed = measured - fr.preMeasured;
      if (steps > 0 && observed > 0) {
        const perStep = observed / steps;
        const prev = this.observedFanStepCost.get(fr.deviceId);
        this.observedFanStepCost.set(fr.deviceId, prev == null ? perStep : prev * 0.5 + perStep * 0.5);
      }
      this.lastFanRaise = null;
    }

    // Effect-confirmation hold: armed by every raise batch in execute(). The
    // next raise needs the last raise's amps to actually show up on the meter
    // (early release) — or the hold to time out (2 min level/fan, 3 min
    // turn-on). Reductions are never gated by this.
    if (this.raiseHold) {
      if (now >= this.raiseHold.until) {
        this.raiseHold = null;
      } else if (now >= this.raiseHold.checkAfter && this.recentMeasured.length >= 4) {
        // (1) Meter caught up to the predicted draw — the raise's amps arrived.
        const arrived = measured >= this.raiseHold.expectedAmps - this.raiseHold.threshold;
        // (2) Provable-headroom early release (fixes the under-delivery trap):
        // even if the pending raise FULLY delivers its expected draw, one more
        // one-step surge still fits under the buffered limit → the next step is
        // safe to commit NOW. This is trip-safe regardless of ramp timing (the
        // worst case is bounded), and stops an over-predicted raise from sitting
        // the whole 2–3 min hold while the meter shows ample room. Requires a
        // sustained genuine-headroom streak so a transient over-limit blip can't
        // trigger it. `nextStepSurge` = the largest learned/model step among ON
        // managed ACs (conservative — never under-states the next surge).
        const bufferedLimit = limit - this.config.marginAmps - Math.max(0, this.config.raiseBufferAmps);
        const nextStepSurge = Math.max(0, ...snapshots
          .filter((s) => s.on && s.managed)
          .map((s) => {
            const m = this.ampModelFor(s.deviceId, source);
            return Math.max(m.stepAmps, this.observedRaiseCost.get(s.deviceId) ?? 0);
          }));
        const provableHeadroom =
          this.headroomStreak >= RAISE_STREAK &&
          this.raiseHold.expectedAmps + nextStepSurge <= bufferedLimit;
        if (arrived || provableHeadroom) {
          log.info(arrived
            ? `[leveler] Raise effect confirmed (${measured.toFixed(1)}A ≈ ` +
              `${this.raiseHold.expectedAmps.toFixed(1)}A expected) — raises unlocked`
            : `[leveler] Provable headroom (expected ${this.raiseHold.expectedAmps.toFixed(1)}A ` +
              `+ next step ${nextStepSurge.toFixed(1)}A ≤ ${bufferedLimit.toFixed(1)}A buffered limit) — raises unlocked`);
          this.raiseHold = null;
        }
      }
    }

    const ampModels = Object.fromEntries(
      snapshots.map((s) => [s.deviceId, this.ampModelFor(s.deviceId, source)]),
    );
    // Non-AC load = measured minus estimated AC draw. An ESTABLISHED AC counts
    // at its current level; a still-RAMPING AC counts at its FLOOR draw only —
    // a freshly started compressor isn't pulling its full estimate yet, but it
    // IS pulling roughly its floor draw within seconds. Crediting zero (the
    // pre-2026-06-11 behavior) inflated nonAcLoad by each ramping AC's whole
    // real draw for 240s after every turn-on/changeover — phantom 4A budgets
    // froze shed restores and triggered spurious fan drops.
    const establishedDraw = snapshots
      .filter((s) => s.on)
      .reduce((sum, s) => {
        const ramping = (this.rampUntil.get(s.deviceId) ?? 0) > now;
        const floor = Math.max(1, Math.min(s.minLevel, s.maxLevel));
        // Ramping credit never exceeds the AC's actual cap (a ramping AC held
        // below its boost floor can't draw the floor's amps).
        const level = ramping
          ? (s.currentLevel >= 1 ? Math.min(floor, s.currentLevel) : floor)
          : s.currentLevel;
        return sum + estimateAcDraw(level, s.maxLevel, this.ampModelFor(s.deviceId, source));
      }, 0);
    // While the post-command freeze is active, fresh derivations are
    // contaminated (measured still shows pre-command draw against post-command
    // snapshot levels) — use the value the command batch was computed with.
    const freshNonAcLoad = Math.max(0, measured - establishedDraw);
    const nonAcLoad = now < this.freezeUntil && this.frozenNonAcLoad != null
      ? this.frozenNonAcLoad
      : freshNonAcLoad;
    this.lastNonAcLoad = nonAcLoad;

    // Reduce trigger = the over-limit leaky bucket (drained per reading in
    // onPowerReading; replaces the consecutive mild/severe streaks + the
    // grid-only oscillation gate). When it empties, the overshoot MAGNITUDE in
    // the window picks the action: a SEVERE reading (> limit + 1A) → one
    // meter-sized decisive cut (computeEmergencyReduction, bypassing the
    // model-derived budget that can under-credit an AC and ship nothing while
    // the meter reads over — the 31A trip); an ALL-MILD empty → the gentler
    // allocator fitted reduce + fan-before-shed (driven via REDUCE_STREAK).
    const bucketEmpty = this.overLimitBudget <= 0;
    const overReadings = this.overLimitReadings.filter((m) => m > limit);
    const recentSevere = overReadings.some((m) => m - limit > OVER_LIMIT_SEVERE_AMPS);
    let emergencyDeferred = false;
    if (bucketEmpty && recentSevere) {
      // Median of the over-limit readings — a single spike can't inflate it.
      const overshoot = overReadings.length > 0
        ? AcLeveler.median(overReadings) - limit
        : Math.max(OVER_LIMIT_SEVERE_AMPS, measured - limit);
      let required = overshoot + this.config.marginAmps;
      // A batch still landing (compressors take seconds to respond) discounts
      // the target — never stack cuts before the meter reflects the previous
      // batch (the over-reduction → bounce cycle the user explicitly rejected).
      if (this.lastEmergency && now - this.lastEmergency.at < EMERGENCY_PENDING_MS) {
        required -= this.lastEmergency.savedAmps;
      }
      if (required > 0) {
        const eres = computeEmergencyReduction({
          limitAmps: limit,
          marginAmps: this.config.marginAmps,
          nonAcLoadAmps: nonAcLoad,
          requiredSavingsAmps: required,
          acs: snapshots,
          ampModels,
          // Size level-downs with the REAL per-level cost (same learned signal
          // the raise gate uses) so a single correctly-credited level-down beats
          // a shed when it covers — the static gen model under-states the step,
          // making the optimizer shed (turn OFF) instead of level down.
          raiseSurge: source === "gen" ? Object.fromEntries(this.observedRaiseCost) : undefined,
        });
        log.warn(
          `[leveler] EMERGENCY: ~${overshoot.toFixed(1)}A over the ${limit}A ${source} limit ` +
          `(over-limit bucket empty) — ` +
          `cutting ~${eres.estimatedSavingsAmps.toFixed(1)}A of ${required.toFixed(1)}A needed ` +
          `(${Object.keys(eres.desiredLevels).length} level, ${eres.toFanReduce.length} fan, ` +
          `${eres.toShed.length} shed)${eres.satisfied ? "" : " — not fully covered, escalating on the next reading"}`,
        );
        this.lastEmergency = { at: now, requiredAmps: required, savedAmps: eres.estimatedSavingsAmps };
        this.forceEvaluate = false;
        // Acted — refill the bucket so stale points don't re-fire before the cut
        // lands (the anti-stacking discount covers the meter lag).
        this.overLimitBudget = OVER_LIMIT_BUDGET;
        this.overLimitReadings = [];
        // reactive=true: an emergency cut that undoes a recent raise is still
        // that raise's bounce. execute() handles shed persistence, fan holds,
        // unreachable counting, settle/freeze/expectation, and bucket refill.
        await this.execute(tcl, snapshots, eres, source, limit, true);
        this.lastStatus = this.buildStatus(ctx, source, measured, limit, eres);
        return;
      }
      // Discounted to ≤ 0: the previous batch's savings should cover the current
      // overshoot once they land — defer, and don't double-reduce via the mild
      // allocator path on the same readings.
      emergencyDeferred = true;
    }

    const input: AllocatorInput = {
      limitAmps: limit,
      marginAmps: this.config.marginAmps,
      raiseBufferAmps: this.config.raiseBufferAmps,
      nonAcLoadAmps: nonAcLoad,
      // An all-mild bucket-empty drives the allocator's gentler reduce (fitted
      // levels + fan-before-shed) via its REDUCE_STREAK gate. A severe empty is
      // handled by the meter-sized emergency path above (deferred → stay quiet).
      overLimitStreak: bucketEmpty && !recentSevere && !emergencyDeferred ? REDUCE_STREAK : 0,
      severeOverLimitStreak: 0,
      headroomStreak: this.headroomStreak,
      inSettle,
      raiseHold: this.raiseHold != null,
      raiseHoldExpectedAmps: this.raiseHold?.expectedAmps ?? null,
      nearTargetBandC: this.config.nearTargetBandC,
      forceEvaluate: this.forceEvaluate,
      acs: snapshots,
      ampModels,
      // One step per raise on the generator: a gen level is a CAP and releasing
      // it surges a hot compressor unpredictably (live: 3.5A vs a 2A model step),
      // so climb one level, confirm the surge on the meter, then the next. Grid
      // (28A budget, caps don't bind) keeps straight-to-ideal batch raises.
      maxRaiseStep: source === "gen" ? 1 : undefined,
      // Learned per-AC raise surge (real cost of releasing a cap), so the raise
      // gate self-corrects from observed overshoots instead of trusting the
      // static model that the user has already had to retune. Empty on grid.
      raiseSurge: source === "gen" ? Object.fromEntries(this.observedRaiseCost) : undefined,
      // Learned per-fan-step cost so a held fan climbs only to the level that
      // fits (the sweet spot) instead of jumping to full and bouncing. Gen only.
      fanStepCost: source === "gen" ? Object.fromEntries(this.observedFanStepCost) : undefined,
    };
    const result = computeAllocation(input);
    this.forceEvaluate = false;
    // A bucket-empty (mild) reduce in this batch is a bounce candidate — the
    // severe emergency path above already passed reactive=true for its cuts.
    const reactive = bucketEmpty && !emergencyDeferred;
    // Execute BEFORE building status so the same tick reports the settle
    // window it just opened, fresh sheds, reset streaks, and the expectation.
    await this.execute(tcl, snapshots, result, source, limit, reactive);
    this.lastStatus = this.buildStatus(ctx, source, measured, limit, result);
  }

  /**
   * Send a Smart AC Leveling push, rate-limited so an over-limit episode can't
   * spam the user. `critical` (an AC turned OFF) always sends — it's actionable;
   * fan reductions and restores are suppressed within LEVELING_PUSH_THROTTLE_MS
   * of the last leveling push. Fire-and-forget (must not block the loop).
   */
  private pushLevelingNotice(body: string, critical = false): void {
    const now = Date.now();
    if (!critical && now - this.lastLevelingPushAt < LEVELING_PUSH_THROTTLE_MS) return;
    this.lastLevelingPushAt = now;
    void this.deps.broadcast({ title: "Smart AC Leveling", body, type: "leveling" });
  }

  private async execute(
    tcl: TclCloud,
    snapshots: LevelerAcSnapshot[],
    result: AllocationResult,
    source: PowerSource,
    limit: number,
    reactive: boolean,
  ): Promise<void> {
    let sentAny = false;
    // Level/power commands need the full settle (compressor response); a
    // fan-only batch settles in seconds and gets the short FAN_SETTLE_MS.
    let levelOrPowerSent = false;
    let didReduce = false;
    let raisedAmps = 0;
    const raisedNow = new Map<string, number>();
    const restoredNow = new Set<string>();
    const name = (id: string): string => this.deviceNames.get(id) ?? id;
    const startedAt = Date.now();
    // Reactive reductions that undo the last raise batch are bounces: the
    // raise's amps arrived but pushed the total over the limit. Record the
    // observed cost so the retry waits for the load to actually drop.
    const batch = reactive && this.lastRaiseBatch && startedAt <= this.lastRaiseBatch.windowUntil
      ? this.lastRaiseBatch
      : null;
    const peakMeasured = batch ? this.smoothedMeasured() : 0;
    const recordBounce = (deviceId: string, kind: "level" | "restore", cap: number | null, anchorAmps: number): void => {
      const observed = peakMeasured - batch!.preMeasured;
      const requiredAmps = Math.min(Math.max(observed, anchorAmps), anchorAmps + BOUNCE_MAX_EXTRA_AMPS);
      // Learn the real raise cost for a single-AC level bounce (the meter delta
      // IS this AC's surge — a multi-AC batch's delta sums several raises and
      // can't be attributed). Light EWMA so one noisy reading can't dominate;
      // feeds the allocator's raise gate so it stops over-raising this AC.
      if (kind === "level" && batch!.raised.size === 1 && observed > 0) {
        const prev = this.observedRaiseCost.get(deviceId);
        this.observedRaiseCost.set(deviceId, prev == null ? observed : prev * 0.5 + observed * 0.5);
      }
      this.bounce.set(deviceId, { kind, cap, requiredAmps, until: startedAt + BOUNCE_SAFETY_EXPIRY_MS });
      this.lastRaiseBatch = null; // consumed — one bounce attribution per batch
      log.warn(
        `[leveler] ${name(deviceId)}: ${kind === "level" ? `raise bounced — capped at L${cap}` : "restore bounced — re-shed"} ` +
        `(observed cost ${requiredAmps.toFixed(1)}A, retry below ` +
        `${(limit - this.config.marginAmps - this.config.raiseBufferAmps - requiredAmps).toFixed(1)}A measured) — consider calibrating the amp model`,
      );
    };

    for (const [deviceId, level] of Object.entries(result.desiredLevels)) {
      const snap = snapshots.find((s) => s.deviceId === deviceId);
      try {
        await tcl.sendControl(deviceId, "set_generator_mode", level);
        // Unconfirmed sends count PER LEVEL toward the unreachable mark (a
        // fluttering target alternating two levels can't reset them); the
        // re-sends double as Najat's needed command retry.
        const counts = this.pendingSendCounts.get(deviceId) ?? new Map<number, number>();
        const sends = (counts.get(level) ?? 0) + 1;
        counts.set(level, sends);
        this.pendingSendCounts.set(deviceId, counts);
        this.lastSetLevel.set(deviceId, level);
        this.pendingLevel.set(deviceId, level);
        if (sends >= UNREACHABLE_LEVEL_SENDS && level >= 2) {
          const set = this.unreachableLevels.get(deviceId) ?? new Map<number, number>();
          if (!set.has(level)) {
            set.set(level, Date.now());
            this.unreachableLevels.set(deviceId, set);
            this.forceEvaluate = true; // ship the fallback next tick
            let fallback = level - 1;
            while (fallback > 1 && set.has(fallback)) fallback--;
            log.warn(
              `[leveler] ${name(deviceId)}: firmware never confirmed L${level} after ${sends} sends — ` +
              `marking unreachable, falling back to L${fallback}`,
            );
          }
        }
        sentAny = true;
        levelOrPowerSent = true;
        if (snap && (snap.currentLevel === 0 || level < snap.currentLevel)) didReduce = true;
        const raisedTo = batch?.raised.get(deviceId);
        if (raisedTo != null && level < raisedTo) {
          // This reduction undoes a raise from the still-open batch — bounce.
          const model = this.ampModelFor(deviceId, source);
          const anchor = estimateAcDraw(raisedTo, snap?.maxLevel ?? 1, model)
            - estimateAcDraw(level, snap?.maxLevel ?? 1, model);
          // Only CAP when the raise cost materially MORE than the model said —
          // an accurate model that still bounced was raised into a thin budget
          // (transient misread), and the normal raise gate will re-time it; a
          // sticky cap would strand the room at L1 for up to an hour. The
          // tolerance only applies to a SINGLE-AC raise batch, where the meter
          // delta IS this AC's cost; a multi-AC batch's delta sums several
          // raises, so fall back to the original unconditional cap there.
          const observedCost = peakMeasured - batch!.preMeasured;
          const singleRaise = batch!.raised.size === 1;
          if (!singleRaise || observedCost > anchor + BOUNCE_MODEL_TOLERANCE_AMPS) {
            recordBounce(deviceId, "level", level, anchor);
          }
        }
        if (snap && snap.currentLevel >= 1 && level > snap.currentLevel) {
          // Predicted extra draw from this raise — graded against measured later
          const model = this.ampModelFor(deviceId, source);
          raisedAmps += estimateAcDraw(level, snap.maxLevel, model)
            - estimateAcDraw(snap.currentLevel, snap.maxLevel, model);
          raisedNow.set(deviceId, level);
        }
        log.info(
          `[leveler] ${name(deviceId)}: gen level ${snap?.currentLevel ?? "?"} → L${level} ` +
          `(${source} budget ${result.budgetAmps.toFixed(1)}A)`,
        );
      } catch (err) {
        log.error(`[leveler] Failed to set gen level for ${name(deviceId)}:`, (err as Error).message);
      }
    }

    // Last try before shedding: drop every reducible fan to minimum in one
    // batch. didReduce resets the streaks, so the shed only fires if a fresh
    // 4-reading over-limit window builds with fans already at minimum.
    if (result.toFanReduce.length > 0) {
      let fanReduced = false;
      for (const deviceId of result.toFanReduce) {
        const snap = snapshots.find((s) => s.deviceId === deviceId);
        if (snap?.fanSpeed == null) continue;
        try {
          if (!this.fanHold.has(deviceId)) {
            await this.recordFanHold(deviceId, snap.fanSpeed);
          }
          await tcl.sendControl(deviceId, "set_fan_speed", 1);
          await this.setFanHoldLastSet(deviceId, 1);
          this.deps.onLevelerFanCommand(deviceId, 1);
          sentAny = true;
          didReduce = true;
          fanReduced = true;
          log.info(`[leveler] ${name(deviceId)}: fan ${snap.fanSpeed === 0 ? "auto" : snap.fanSpeed} → 1 (last try before shed)`);
        } catch (err) {
          log.error(`[leveler] Fan reduce failed for ${name(deviceId)}:`, (err as Error).message);
        }
      }
      if (fanReduced) {
        this.pushLevelingNotice(
          `Fan speeds reduced to minimum to stay under the ${limit}A ${source === "grid" ? "Grid" : "Generator"} limit — they'll be restored when there is room.`,
        );
      }
    }

    for (const deviceId of result.toShed) {
      try {
        await tcl.executeAcAction(deviceId, { power: 0 });
        await this.recordShed(deviceId, `over ${limit}A on ${source}`);
        await this.clearFanHold(deviceId, "shed");
        this.fanExempt.delete(deviceId);
        if (batch?.restored.has(deviceId)) {
          // Re-shed of an AC the batch just restored — restore bounce. Anchor
          // on its floor draw (what the next restore attempt would add).
          const snap = snapshots.find((s) => s.deviceId === deviceId);
          const anchor = estimateAcDraw(
            Math.max(1, Math.min(snap?.minLevel ?? 1, snap?.maxLevel ?? 1)),
            snap?.maxLevel ?? 1,
            this.ampModelFor(deviceId, source),
          );
          recordBounce(deviceId, "restore", null, anchor);
        }
        sentAny = true;
        levelOrPowerSent = true;
        didReduce = true;
        // An AC turned OFF is actionable → always notify (critical).
        this.pushLevelingNotice(
          `${name(deviceId)} turned off — total current over the ${limit}A ${source === "grid" ? "Grid" : "Generator"} limit. It will be restored when there is room.`,
          true,
        );
      } catch (err) {
        log.error(`[leveler] Shed failed for ${name(deviceId)}:`, (err as Error).message);
      }
    }

    // Accompanying level reductions above have already gone out — room is
    // made before the power-on (restore-with-reduction).
    for (const deviceId of result.toRestore) {
      try {
        if (await this.deps.isManualOffLocked(deviceId)) {
          // The user turned it off while shed — their intent wins over the restore
          await this.clearShed(deviceId, "manual_off_lock");
          continue;
        }
        // Restore at the floor level (boost minimum when active, else L1) —
        // clamped by what the firmware can actually hold and any active slot cap.
        const snap = snapshots.find((s) => s.deviceId === deviceId);
        const restoreLevel = Math.max(1, Math.min(
          snap?.minLevel ?? 1,
          snap?.maxLevel ?? 1,
          snap?.reachableCap ?? Number.MAX_SAFE_INTEGER,
          snap?.slotCap ?? Number.MAX_SAFE_INTEGER,
        ));
        await tcl.executeAcAction(deviceId, { power: 1, generator_mode: restoreLevel });
        await this.clearShed(deviceId, "restored");
        restoredNow.add(deviceId);
        levelOrPowerSent = true;
        // A restore adds its whole floor draw to the expectation
        raisedAmps += estimateAcDraw(restoreLevel, snap?.maxLevel ?? 1, this.ampModelFor(deviceId, source));
        this.lastSetLevel.set(deviceId, restoreLevel);
        this.pendingLevel.set(deviceId, restoreLevel);
        this.prevPowerStates.set(deviceId, true);
        this.rampUntil.set(deviceId, Date.now() + AC_RAMP_MS);
        this.deps.setDevicePowerCache(deviceId, "on");
        sentAny = true;
        this.pushLevelingNotice(
          `${name(deviceId)} restored at L${restoreLevel} — current headroom is available again.`,
        );
      } catch (err) {
        log.error(`[leveler] Restore failed for ${name(deviceId)}:`, (err as Error).message);
      }
    }

    if (result.toFanRaise) {
      const { deviceId, fan } = result.toFanRaise;
      const hold = this.fanHold.get(deviceId);
      if (hold) {
        const fromFan = hold.lastSetFan;
        try {
          await tcl.sendControl(deviceId, "set_fan_speed", fan);
          this.deps.onLevelerFanCommand(deviceId, fan);
          if (fan === hold.originalFan) {
            await this.clearFanHold(deviceId, "restored");
          } else {
            await this.setFanHoldLastSet(deviceId, fan);
          }
          // Learn the real per-fan-step cost from this CLEAN fan-only restore
          // (numeric upward step only — `auto` can't be attributed per step).
          // Graded after the fan settle window in tick(); preMeasured is the
          // pre-effect baseline (compressors/blower haven't responded yet).
          if (!levelOrPowerSent && fan > 0 && fromFan > 0 && fan > fromFan) {
            this.lastFanRaise = { deviceId, fromFan, toFan: fan, preMeasured: this.smoothedMeasured(), at: Date.now() };
          }
          // Raises must not reset streaks — the settle window paces the steps.
          sentAny = true;
          log.info(`[leveler] ${name(deviceId)}: fan restore step → ${fan === 0 ? "auto" : fan}` +
            (this.fanHold.has(deviceId) ? ` (target ${hold.originalFan === 0 ? "auto" : hold.originalFan})` : " (hold released)"));
        } catch (err) {
          log.error(`[leveler] Fan raise failed for ${name(deviceId)}:`, (err as Error).message);
        }
      }
    }

    if (sentAny) {
      const now = Date.now();
      // Fan-only batches settle fast — a 30s pause per fan command crawled
      // through restores and blocked level raises the whole time.
      this.settleUntil = now + (levelOrPowerSent ? SETTLE_MS : FAN_SETTLE_MS);
      // A level/power command this batch contaminates a pending fan-cost sample
      // (its meter delta would mix in the level change) — drop it.
      if (levelOrPowerSent) this.lastFanRaise = null;
      // Freeze the non-AC load the allocation was computed with — fresh
      // derivations are contaminated until compressors respond to the
      // commands just sent (see NON_AC_FREEZE_MS).
      this.frozenNonAcLoad = result.nonAcLoadAmps;
      this.freezeUntil = now + NON_AC_FREEZE_MS;
      // Predict the steady-state total: non-AC load + every AC that will be
      // ON at its commanded level. Grading waits until the slowest effect has
      // materialized (settle for level/fan changes, compressor ramp for
      // turn-ons). Fan-only batches barely move amps — a slightly noisy but
      // harmless data point for the model check.
      let expectedDraw = 0;
      let compareAfter = this.settleUntil;
      for (const s of snapshots) {
        const willBeOn = restoredNow.has(s.deviceId) || (s.on && !this.shedIds.has(s.deviceId));
        if (!willBeOn) continue;
        const level = s.managed
          ? (this.lastSetLevel.get(s.deviceId) ?? s.currentLevel)
          : s.currentLevel;
        expectedDraw += estimateAcDraw(level, s.maxLevel, this.ampModelFor(s.deviceId, source));
        compareAfter = Math.max(compareAfter, this.rampUntil.get(s.deviceId) ?? 0);
      }
      const expectedAmps = result.nonAcLoadAmps + expectedDraw;
      // A SINGLE-AC level raise (no restore/turn-on in the batch) lets grading
      // attribute the whole meter delta to that AC → two-way surge learning.
      const singleRaiseId =
        raisedNow.size === 1 && restoredNow.size === 0 ? [...raisedNow.keys()][0] : null;
      this.expected = {
        amps: expectedAmps,
        raisedAmps,
        at: now,
        compareAfter,
        raiseDeviceId: singleRaiseId,
        preMeasured: this.smoothedMeasured(),
      };
      // Every LEVEL raise batch arms the effect-confirmation hold: the next
      // raise must either see this batch's amps arrive (early release in tick)
      // or wait the hold out. Turn-ons hold longest — compressor ramps are
      // slow. Fan-only raises no longer arm it (fans are ~0.5A and settle in
      // seconds — user re-decided 2026-06-10, superseding the 2026-06-07
      // "2 min for fan" spec). Pure-reduction batches leave any hold untouched.
      const hasRaise = raisedAmps > 0 || restoredNow.size > 0;
      if (hasRaise) {
        // A warm-restore raise targets a still-ramping just-turned-on AC, so it
        // gets the longer turn-on hold — the compressor ramp is what we wait on.
        const isTurnOn = restoredNow.size > 0 ||
          [...raisedNow.keys()].some((id) => (this.rampUntil.get(id) ?? 0) > now);
        const holdMs = isTurnOn ? RESTORE_HOLD_MS : RAISE_HOLD_MS;
        this.raiseHold = {
          until: now + holdMs,
          expectedAmps,
          threshold: Math.max(1, raisedAmps / 2),
          checkAfter: now + RAISE_HOLD_CHECK_AFTER_MS,
        };
        if (raisedNow.size > 0 || restoredNow.size > 0) {
          // Bounce attribution window: a reactive reduction that undoes one of
          // these raises/restores within the window is a bounce. Decoupled from
          // (and at least as long as) the effect-confirmation hold — a slow
          // limit cycle can over-limit and reduce minutes after the raise, past
          // RAISE_HOLD_MS, and that reduce is still this raise's fault.
          // preMeasured = the smoothed total these raises were stacked onto.
          this.lastRaiseBatch = {
            windowUntil: now + Math.max(holdMs, BOUNCE_WINDOW_MS),
            preMeasured: this.smoothedMeasured(),
            raised: raisedNow,
            restored: new Set(restoredNow),
          };
        }
        log.info(
          `[leveler] Raise hold armed for ${holdMs / 1000}s — next raise once ` +
          `~${expectedAmps.toFixed(1)}A is seen on ${source} or the hold expires`,
        );
      }
    }
    if (didReduce) {
      // Fresh readings required before the next decision in either direction.
      // Refill the bucket so the just-acted-on over-limit points don't re-fire
      // before the cut lands. Note: restore-with-reduction batches land here too
      // — the next restore needs a fresh 6-reading headroom streak.
      this.overLimitBudget = OVER_LIMIT_BUDGET;
      this.overLimitReadings = [];
      this.headroomStreak = 0;
    }
  }

  // ---------- Status (for GET /api/ac/leveling) ----------

  private buildStatus(
    ctx: LevelerDeviceContext[],
    source: PowerSource,
    measured: number | null,
    limit: number | null,
    result: AllocationResult | null,
  ): AcLevelingStatus {
    return {
      enabled: this.config.enabled,
      source,
      measuredAmps: measured,
      limitAmps: limit,
      budgetAmps: result?.budgetAmps ?? null,
      nonAcLoadAmps: result?.nonAcLoadAmps ?? null,
      overLimitBudget: this.overLimitBudget,
      overLimitBudgetMax: OVER_LIMIT_BUDGET,
      headroomStreak: this.headroomStreak,
      settleRemainingMs: Math.max(0, this.settleUntil - Date.now()),
      raiseHoldRemainingMs: Math.max(0, (this.raiseHold?.until ?? 0) - Date.now()),
      expectedAmps: this.expected?.amps ?? null,
      lastPrediction: this.lastPrediction,
      lastEmergency: this.lastEmergency,
      acs: ctx.map(({ device, managed, needTier, needDelta, slotGenCap }) => {
        const maxLevel = device.maxGeneratorLevel || 3;
        const boost = this.config.levelBoosts[device.id];
        const minLevel = boost && (this.boostActive.get(device.id) ?? false)
          ? Math.min(boost.minLevel, maxLevel)
          : 1;
        return {
          deviceId: device.id,
          name: device.name,
          on: device.power,
          managed,
          shed: this.shedIds.has(device.id),
          level: device.generatorMode,
          maxLevel,
          minLevel,
          estAmps: device.power
            ? estimateAcDraw(device.generatorMode, maxLevel, this.ampModelFor(device.id, source))
            : 0,
          needTier,
          // Delta-based since 2026-06-11: within the near-target band → L1,
          // beyond it the budget decides (the tier dot stays for display).
          needCap: nearTargetNeedCap(needDelta, this.config.nearTargetBandC, maxLevel),
          needDelta,
          manualCap: this.manualCap.get(device.id) ?? null,
          manualTarget: this.manualTarget.get(device.id) ?? null,
          idealLevel: result?.idealLevels[device.id] ?? null,
          heldFan: this.fanHold.get(device.id)?.lastSetFan ?? null,
          fanOriginal: this.fanHold.get(device.id)?.originalFan ?? null,
          bounceCap: (() => {
            const entry = this.bounce.get(device.id);
            return entry?.kind === "level" ? entry.cap : null;
          })(),
          bounceRetryBelowAmps: (() => {
            const entry = this.bounce.get(device.id);
            return entry && limit != null
              ? limit - this.config.marginAmps - this.config.raiseBufferAmps - entry.requiredAmps
              : null;
          })(),
          restoreBlocked: this.bounce.get(device.id)?.kind === "restore",
          slotCap: slotGenCap != null ? Math.max(1, Math.min(slotGenCap, maxLevel)) : null,
          unreachableLevels: [...(this.unreachableLevels.get(device.id)?.keys() ?? [])].sort((a, b) => a - b),
        };
      }),
    };
  }

  getStatus(): AcLevelingStatus {
    if (this.lastStatus) return this.lastStatus;
    const staleMs = this.lastReadingAt > 0 ? Date.now() - this.lastReadingAt : STALE_POWER_MS + 1;
    return {
      enabled: this.loaded && this.config.enabled,
      source: determineSource(this.lastReading, staleMs),
      measuredAmps: null,
      limitAmps: null,
      budgetAmps: null,
      nonAcLoadAmps: null,
      overLimitBudget: this.overLimitBudget,
      overLimitBudgetMax: OVER_LIMIT_BUDGET,
      headroomStreak: this.headroomStreak,
      settleRemainingMs: Math.max(0, this.settleUntil - Date.now()),
      raiseHoldRemainingMs: Math.max(0, (this.raiseHold?.until ?? 0) - Date.now()),
      expectedAmps: this.expected?.amps ?? null,
      lastPrediction: this.lastPrediction,
      lastEmergency: this.lastEmergency,
      acs: [],
    };
  }
}
