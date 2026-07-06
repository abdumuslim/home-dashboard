import pg from "pg";
import webpush from "web-push";
import mqtt from "mqtt";
import { getBaghdadPrayerTimes, baghdadMinuteOfDay, baghdadDateKey, prayerInstant } from "./prayer.js";
import type { PrayerTimesResult } from "./prayer-engine/index.js";
import type { Config } from "./config.js";
import { getMetricValue, powerConditionSustained, ALERT_METRICS, VALID_PRAYER_NAMES, PRAYER_LABELS, type PowerReadingEntry } from "./alert-metrics.js";
import { XiaomiCloud, type PurifierAction } from "./xiaomi-cloud.js";
import { TclCloud, type AcAction, type AcDevice } from "./tcl-cloud.js";
import { acTimers } from "./routes.js";
import { AcLeveler, type LevelerDeviceContext } from "./ac-leveler.js";
import { AcCalibrator } from "./ac-calibration.js";
import { computeNeedTier, type NeedTier } from "./ac-leveling.js";
import { computeAutoFanLevel } from "./ac-auto-fan.js";
import { childLogger } from "./logger.js";
import {
  findActiveRangeSlot,
  getBaghdadMinutes,
  getLegacyRangeSlots,
  type AutomationRangeSlot,
} from "./automation-slots.js";

const log = childLogger("collector");

interface WeatherRow {
  ts: Date;
  temp_c: number | null;
  humidity: number | null;
  wind_speed_kmh: number | null;
  wind_gust_kmh: number | null;
  max_daily_gust_kmh: number | null;
  wind_dir: number | null;
  wind_dir_avg10m: number | null;
  pressure_rel_hpa: number | null;
  pressure_abs_hpa: number | null;
  rain_hourly_mm: number | null;
  rain_event_mm: number | null;
  rain_daily_mm: number | null;
  rain_weekly_mm: number | null;
  rain_monthly_mm: number | null;
  rain_yearly_mm: number | null;
  solar_radiation: number | null;
  uv_index: number | null;
  temp_indoor_c: number | null;
  humidity_indoor: number | null;
  feels_like_c: number | null;
  dew_point_c: number | null;
  temp_ch8_c: number | null;
  humidity_ch8: number | null;
  feels_like_indoor_c: number | null;
  dew_point_indoor_c: number | null;
  feels_like_ch8_c: number | null;
  dew_point_ch8_c: number | null;
  batt_outdoor: number | null;
  batt_indoor: number | null;
  batt_ch8: number | null;
  last_rain: Date | null;
}

interface AirRow {
  ts: Date;
  temperature: number | null;
  humidity: number | null;
  co2: number | null;
  pm25: number | null;
  pm10: number | null;
  tvoc: number | null;
  noise: number | null;
  battery: number | null;
}

interface QpSensorFields {
  temperature?: { value: number };
  humidity?: { value: number };
  co2?: { value: number };
  pm25?: { value: number };
  pm10?: { value: number };
  tvoc_index?: { value: number };
  noise?: { value: number };
  battery?: { value: number; status?: number };
}

const QP_MSG_SETTINGS_ACK = "28";
const QP_MSG_INTERVAL_CONFIG = "17";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AWData = Record<string, any>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const PRAYER_NAMES = VALID_PRAYER_NAMES;

interface AlertRule {
  id: number;
  endpoint: string;
  alert_type: "sensor" | "prayer";
  metric: string | null;
  condition: "above" | "below" | null;
  threshold: number | null;
  prayer_timing: "at_time" | "before" | null;
  prayer_minutes: number | null;
  prayer_names: string[] | null;
  subscription: unknown; // JSONB, already parsed by pg driver
}

interface AutomationRule {
  id: number;
  name: string;
  enabled: boolean;
  automation_type: "metric" | "schedule";
  device_type: "purifier" | "ac";
  metric: string | null;
  condition: "above" | "below" | null;
  threshold: number | null;
  threshold_low: number | null;
  time_start: string | null;
  time_end: string | null;
  device_id: string;
  device_name: string;
  device_ids: string[] | null;
  device_names: string[] | null;
  turn_off_at_end: boolean;
  sustained_minutes: number;
  start_mode: "exact" | "prayer";
  start_prayer: string | null;
  start_prayer_offset: number | null;
  end_mode: "exact" | "prayer";
  end_prayer: string | null;
  end_prayer_offset: number | null;
  action_on: PurifierAction | AcAction;
  action_off: PurifierAction | AcAction | null;
  cooldown_secs: number;
  range_slots: AutomationRangeSlot[] | null;
  smart_leveling: boolean;
}

function parseTimeToMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

interface AutomationState {
  status: "idle" | "triggered";
  lastToggle: number;
  conditionSince: number | null;
  conditionLostAt: number | null;
  canAutoTurnOn: boolean;
}

/** Per rule+device fan enforcement bookkeeping for AC range automations. */
interface AcFanEnforcement {
  slotId: string;                 // range slot under which the baseline was set
  lastCommandedFan: number | null; // fan level we last sent (smart-auto hysteresis basis)
  lastFanCommandAt: number;       // ts of our last fan send / baseline adoption
  manual: boolean;                // user changed fan — stop enforcing until slot change or power cycle
}

interface AcSwingOverride {
  slotId: string;                 // range slot active when the user took manual swing control
}

export class Collector {
  private pool: pg.Pool;
  private config: Config;
  private qpToken: string | null = null;
  private qpTokenExpires = 0;
  private stopped = false;
  private sentNotifications = new Set<string>();
  private sentDateKey = "";
  private mqttClient: mqtt.MqttClient | null = null;
  private lastMqttMessage = 0;
  // Alert system
  private alertRules: AlertRule[] = [];
  private alertRulesLastFetch = 0;
  private sensorAlertState = new Map<number, { state: "idle" | "triggered"; resolvedAt?: number }>();
  private latestWeatherRow: Record<string, unknown> | null = null;
  private latestWeatherTs: Date | null = null;
  private latestAirRow: Record<string, unknown> | null = null;
  private latestAirTs: Date | null = null;
  private latestPowerRow: Record<string, unknown> | null = null;
  private latestPowerTs: Date | null = null;
  private recentPowerReadings: PowerReadingEntry[] = []; // last few ESP readings for sustained power alerts
  private airBuffer: AirRow[] = [];
  private lastAirSave = 0;
  private readonly AIR_SAVE_INTERVAL = 60_000;
  private cachedPrayerTimes: PrayerTimesResult | null = null;
  private cachedPrayerDateKey = "";
  // Automation system
  xiaomiCloud: XiaomiCloud | null = null;
  tclCloud: TclCloud | null = null;
  acLeveler: AcLeveler;
  acCalibrator: AcCalibrator;
  private lastLevelerDevicesFetch = 0;
  private tclRetryAt = 0;
  private xiaomiRetryAt = 0;
  private automationRules: AutomationRule[] = [];
  private automationRulesLastFetch = 0;
  private automationState = new Map<number, AutomationState>();
  private devicePowerCache = new Map<string, { power: "on" | "off" | undefined; ts: number }>();
  private acManualOffLocks = new Set<string>();
  private acManualOffLockTimes = new Map<string, number>();
  /** Locked AC ids whose OFF we have actually observed live since the lock — only
   * then may an observed ON clear the lock. A stale/flappy TCL shadow that never
   * reflected the off must not auto-undo a sacred manual-off lock (2026-06-19). */
  private acManualOffSeenOff = new Set<string>();
  private acManualOffLocksLoaded = false;
  private readonly POWER_CACHE_TTL = 5_000;
  private readonly AC_MANUAL_OFF_CLEAR_GRACE_MS = 15_000;
  private acFanEnforcement = new Map<string, AcFanEnforcement>(); // key `${rule.id}:${deviceId}`
  private readonly AC_FAN_SETTLE_MS = 15_000;
  // A manual UI gen-level change wins over range generator_mode re-enforcement
  // when the AC is NOT leveler-managed (leveling off / opted out) — without this
  // the active slot's gen_level (or preset generator_mode) is re-sent every ~5s
  // and slams the user's manual level back within seconds (live 2026-06-21:
  // "leveling off but Abdu still drops to L1"). Bounded grace so the automation
  // eventually reclaims if the override is forgotten; resets on each manual change.
  private lastUserGenChangeAt = new Map<string, number>();
  private readonly AC_USER_GEN_OVERRIDE_MS = 30 * 60_000;
  // A manual UI vertical-swing change suspends swing enforcement until the active
  // slot changes or the AC power-cycles (no shadow-drift detection — UI-driven only).
  private acSwingOverrides = new Map<string, AcSwingOverride>(); // key `${rule.id}:${deviceId}`
  // Last automation-sent power-off per device — the shadow can lag past the 5s power
  // cache TTL, so off branches re-firing inside this grace are duplicates, not state.
  private acRangeOffAt = new Map<string, number>();
  private readonly AC_OFF_REFIRE_GRACE_MS = 15_000;
  // Persistent per-AC beep-off preference (firmware resets beepSwitch on power-loss restarts)
  private acBeepOffPrefs = new Set<string>();
  private acBeepPrefsLoaded = false;
  private acBeepLastSent = new Map<string, number>();
  private lastBeepDevicesFetch = 0;
  private readonly AC_BEEP_RESEND_COOLDOWN_MS = 30_000;
  private readonly AC_BEEP_FETCH_INTERVAL_MS = 30_000;
  /**
   * Power-event context for observed-off classification (2026-07-06): blackouts,
   * changeovers, collapses and gen brownouts turn ACs off, and their shadows can
   * lag the event by MINUTES (13 min observed live) — an un-commanded OFF near a
   * power event is a power-loss off, NOT the user's hand, and must never record
   * a sacred manual-off lock (two bogus locks stranded a hot room overnight,
   * live 2026-07-05/06). Stamped via the leveler's onPowerEvent dep.
   */
  private lastPowerEventAt = 0;
  private readonly AC_POWER_EVENT_GRACE_MS = 15 * 60_000;
  // Loop-liveness watchdog (2026-07-06 ~3h silent stall): heartbeat + per-step
  // deadlines so one hung external call can never freeze every automation.
  private lastLoopTickAt = Date.now();
  private currentStep: string | null = null;
  private loopWatchdog: NodeJS.Timeout | null = null;
  private readonly STEP_TIMEOUT_MS = 90_000;
  private readonly LOOP_STALL_WARN_MS = 60_000;
  private readonly LOOP_STALL_FATAL_MS = 3 * 60_000;

  getLatestAir(): Record<string, unknown> | null {
    return this.latestAirRow;
  }

  setLatestPower(data: { ts: string; voltage: number; current_1: number; current_2: number; power_1: number; power_2: number }): void {
    this.latestPowerRow = data as unknown as Record<string, unknown>;
    this.latestPowerTs = new Date(data.ts);
    this.recentPowerReadings = [
      ...this.recentPowerReadings.slice(-7),
      { tsMs: this.latestPowerTs.getTime(), row: this.latestPowerRow },
    ];
    // Streaks are counted per ESP reading, not per collector tick
    this.acLeveler.onPowerReading(data);
    this.acCalibrator.onPowerReading(data);
  }

  invalidateAutomationRules(): void {
    this.automationRulesLastFetch = 0;
  }

  private async ensureAcManualOffLocksLoaded(): Promise<void> {
    if (this.acManualOffLocksLoaded) return;
    const result = await this.pool.query("SELECT device_id, locked_at FROM ac_manual_off_locks");
    this.acManualOffLocks = new Set();
    this.acManualOffLockTimes = new Map();
    this.acManualOffSeenOff = new Set();
    for (const row of result.rows) {
      const deviceId = String(row.device_id);
      const lockedAt = row.locked_at instanceof Date ? row.locked_at.getTime() : Date.now();
      this.acManualOffLocks.add(deviceId);
      this.acManualOffLockTimes.set(deviceId, lockedAt);
      // Locks loaded from a previous session: the off long since settled, so a
      // current ON reading is genuine (no fresh-off shadow race to defend).
      this.acManualOffSeenOff.add(deviceId);
    }
    this.acManualOffLocksLoaded = true;
  }

  async recordAcManualOff(deviceId: string, reason: string): Promise<void> {
    await this.ensureAcManualOffLocksLoaded();
    const wasLocked = this.acManualOffLocks.has(deviceId);
    this.acManualOffLocks.add(deviceId);
    this.acManualOffLockTimes.set(deviceId, Date.now());
    // Fresh lock: the off command was just issued, so the live shadow may still
    // read ON for a while. Require a real observed-off before trusting an ON to
    // clear it (a stale shadow must not auto-undo this lock).
    this.acManualOffSeenOff.delete(deviceId);
    await this.pool.query(
      `INSERT INTO ac_manual_off_locks (device_id, locked_at, reason)
       VALUES ($1, NOW(), $2)
       ON CONFLICT (device_id) DO UPDATE SET locked_at = NOW(), reason = EXCLUDED.reason`,
      [deviceId, reason],
    );
    this.devicePowerCache.set(deviceId, { power: "off", ts: Date.now() });
    if (!wasLocked) log.info(`[collector] AC ${deviceId}: manual-off lock recorded (${reason})`);
  }

  async clearAcManualOff(deviceId: string): Promise<void> {
    await this.ensureAcManualOffLocksLoaded();
    const wasLocked = this.acManualOffLocks.delete(deviceId);
    this.acManualOffLockTimes.delete(deviceId);
    this.acManualOffSeenOff.delete(deviceId);
    if (wasLocked) {
      await this.pool.query("DELETE FROM ac_manual_off_locks WHERE device_id = $1", [deviceId]);
    }
    this.devicePowerCache.set(deviceId, { power: "on", ts: Date.now() });
    if (wasLocked) log.info(`[collector] AC ${deviceId}: manual-off lock cleared`);
  }

  async isAcManualOffLocked(deviceId: string): Promise<boolean> {
    await this.ensureAcManualOffLocksLoaded();
    return this.acManualOffLocks.has(deviceId);
  }

  async getAcManualOffLockedIds(deviceIds?: string[]): Promise<Set<string>> {
    await this.ensureAcManualOffLocksLoaded();
    if (!deviceIds) return new Set(this.acManualOffLocks);
    return new Set(deviceIds.filter((deviceId) => this.acManualOffLocks.has(deviceId)));
  }

  private canClearAcManualOff(deviceId: string): boolean {
    const lockedAt = this.acManualOffLockTimes.get(deviceId);
    if (lockedAt != null && Date.now() - lockedAt < this.AC_MANUAL_OFF_CLEAR_GRACE_MS) return false;
    // Only an ON observed AFTER the off actually propagated to the shadow is a
    // genuine manual-on. A stale/flappy shadow that reports ON without ever
    // reflecting the off must NOT clear the sacred lock (2026-06-19: a 59s-stale
    // ON cleared the lock and the range turned the user's AC back on).
    return this.acManualOffSeenOff.has(deviceId);
  }

  /** Note a LIVE-observed power state for a locked AC: observing the OFF proves
   * the lock took effect, which is the precondition for a later ON to clear it. */
  private noteAcObservedPower(deviceId: string, power: "on" | "off" | undefined): void {
    if (power === "off" && this.acManualOffLocks.has(deviceId)) {
      this.acManualOffSeenOff.add(deviceId);
    }
  }

  /** Stamped by the leveler on source changes, collapses, and ESP dropouts. */
  notePowerEvent(kind: string): void {
    this.lastPowerEventAt = Date.now();
    // Shadows go stale across power events (ACs restart, firmware republishes
    // late) — force the next leveling tick to fetch live device state.
    this.lastLevelerDevicesFetch = 0;
    log.info(`[collector] Power event (${kind}) — observed AC offs read as power-loss for the next 15 min`);
  }

  /**
   * Classify an OBSERVED (un-commanded) AC off: power event or genuine manual?
   * Power-event evidence: a recent source change / blackout / collapse / ESP
   * dropout (shadow lag means "recent" spans minutes), or a power-loss
   * fingerprint in the shadow itself — TCL firmware resets beepSwitch to ON on
   * every power-loss restart, so beep=true on a beep-off-enforced AC (or fan
   * reset to 0 while we had commanded a fan) says the unit lost power. A remote
   * off resets neither.
   */
  private classifyObservedAcOff(deviceId: string): "power_event" | "manual" {
    if (!this.config.observedOffLocks) return "power_event";
    if (Date.now() - this.lastPowerEventAt < this.AC_POWER_EVENT_GRACE_MS) return "power_event";
    const dev = this.tclCloud?.getDevices().find((d) => d.id === deviceId);
    if (dev && !dev.power) {
      if (this.acBeepOffPrefs.has(deviceId) && dev.beep) return "power_event";
      const commandedFan = [...this.acFanEnforcement.entries()].some(
        ([key, e]) => key.endsWith(`:${deviceId}`) && (e.lastCommandedFan ?? 0) > 0,
      );
      if (commandedFan && dev.fanSpeed === 0) return "power_event";
    }
    return "manual";
  }

  /**
   * Shared handler for the three observed-off automation sites. Returns true
   * when the off was a power event — no lock, the caller resumes its auto-on.
   * A genuine manual off locks as before, now with a critical push so a wrong
   * guess is a 10-second fix from the phone instead of a hot room at dawn.
   */
  private async handleObservedAcOff(context: string, deviceId: string, deviceName: string): Promise<boolean> {
    await this.ensureAcBeepPrefsLoaded();
    if (this.classifyObservedAcOff(deviceId) === "power_event") {
      log.info(`[collector] ${context}: device ${deviceId} observed OFF near a power event — not a manual off, automation resumes`);
      return true;
    }
    log.info(`[collector] ${context}: device ${deviceId} manually turned OFF, recording manual-off lock`);
    await this.recordAcManualOff(deviceId, "observed_off");
    void this.broadcastPush({
      title: "AC automation paused",
      body: `${deviceName} was turned off by hand — automations stay off until it's turned back on from the dashboard.`,
      type: "leveling",
    });
    return false;
  }

  async reconcileAcManualOffLocks(devices: Pick<AcDevice, "id" | "power">[]): Promise<Set<string>> {
    await this.ensureAcManualOffLocksLoaded();
    for (const dev of devices) {
      if (!this.acManualOffLocks.has(dev.id)) continue;
      this.noteAcObservedPower(dev.id, dev.power ? "on" : "off");
      if (dev.power && this.canClearAcManualOff(dev.id)) {
        await this.clearAcManualOff(dev.id);
      }
    }
    return this.getAcManualOffLockedIds(devices.map((dev) => dev.id));
  }

  private async ensureAcBeepPrefsLoaded(): Promise<void> {
    if (this.acBeepPrefsLoaded) return;
    const result = await this.pool.query("SELECT device_id FROM ac_beep_off");
    this.acBeepOffPrefs = new Set(result.rows.map((row) => String(row.device_id)));
    this.acBeepPrefsLoaded = true;
  }

  /** UI beep toggle — beep off becomes a persistent enforced preference, beep on releases it. */
  noteUserAcBeep(deviceId: string, beepOn: boolean): void {
    void (beepOn ? this.clearAcBeepOff(deviceId) : this.recordAcBeepOff(deviceId)).catch((err) => {
      log.error(`[collector] AC ${deviceId}: beep pref update failed:`, err);
    });
  }

  private async recordAcBeepOff(deviceId: string): Promise<void> {
    await this.ensureAcBeepPrefsLoaded();
    const wasSet = this.acBeepOffPrefs.has(deviceId);
    this.acBeepOffPrefs.add(deviceId);
    // The UI just sent set_beep 0 itself — give the shadow time to reflect it
    this.acBeepLastSent.set(deviceId, Date.now());
    await this.pool.query(
      "INSERT INTO ac_beep_off (device_id) VALUES ($1) ON CONFLICT (device_id) DO NOTHING",
      [deviceId],
    );
    if (!wasSet) log.info(`[collector] AC ${deviceId}: beep-off preference recorded`);
  }

  private async clearAcBeepOff(deviceId: string): Promise<void> {
    await this.ensureAcBeepPrefsLoaded();
    const wasSet = this.acBeepOffPrefs.delete(deviceId);
    this.acBeepLastSent.delete(deviceId);
    if (wasSet) {
      await this.pool.query("DELETE FROM ac_beep_off WHERE device_id = $1", [deviceId]);
      log.info(`[collector] AC ${deviceId}: beep-off preference cleared`);
    }
  }

  /** Re-send set_beep 0 to any beep-off AC observed on with the beep back on. */
  private async checkAcBeepEnforcement(): Promise<void> {
    if (!this.tclCloud || !this.tclCloud.isReady()) return;
    if (this.acCalibrator.isActive()) return; // calibration owns the ACs
    await this.ensureAcBeepPrefsLoaded();
    if (this.acBeepOffPrefs.size === 0) return;

    // Shared cache is refreshed most ticks by automations/leveler/frontend;
    // our own gated fetch keeps enforcement alive when nothing else polls.
    let devices = this.tclCloud.getDevices();
    if (devices.length === 0 || Date.now() - this.lastBeepDevicesFetch > this.AC_BEEP_FETCH_INTERVAL_MS) {
      try {
        devices = await this.tclCloud.fetchDevicesLive();
      } catch (err) {
        log.warn(`[collector] Beep enforcement device refresh failed, using cache: ${(err as Error).message}`);
      }
      this.lastBeepDevicesFetch = Date.now();
    }

    for (const dev of devices) {
      if (!this.acBeepOffPrefs.has(dev.id) || !dev.power || !dev.beep) continue;
      const lastSent = this.acBeepLastSent.get(dev.id) ?? 0;
      if (Date.now() - lastSent < this.AC_BEEP_RESEND_COOLDOWN_MS) continue;
      try {
        await this.tclCloud.sendControl(dev.id, "set_beep", 0);
        this.acBeepLastSent.set(dev.id, Date.now());
        log.info(`[collector] AC ${dev.id}: beep came back on — re-sent beep off`);
      } catch (err) {
        log.warn(`[collector] AC ${dev.id}: beep-off re-send failed: ${(err as Error).message}`);
      }
    }
  }

  constructor(pool: pg.Pool, config: Config) {
    this.pool = pool;
    this.config = config;
    this.acLeveler = new AcLeveler(pool, {
      getTclCloud: () => this.tclCloud,
      broadcast: (payload) => this.broadcastPush(payload),
      setDevicePowerCache: (deviceId, power) => {
        this.devicePowerCache.set(deviceId, { power, ts: Date.now() });
      },
      isManualOffLocked: (deviceId) => this.isAcManualOffLocked(deviceId),
      onLevelerFanCommand: (deviceId, fan) => this.refreshAcFanBaseline(deviceId, fan),
      // Emergency trigger confirmed (severe streak / grid oscillation): run a
      // leveling check NOW — waiting up to 5s for the loop tick costs seconds
      // we don't have before the breaker trips. Errors are logged, never thrown
      // into the ESP ingest path that fired this.
      onUrgentLevelingNeeded: () => {
        void this.runLevelingCheck().catch((err) =>
          log.error("[collector] Urgent AC leveling check failed:", err));
      },
      // Source change / collapse / ESP dropout — arm the observed-off
      // power-event window so a lagging shadow's OFF isn't read as user intent.
      onPowerEvent: (kind) => this.notePowerEvent(kind),
    });
    this.acCalibrator = new AcCalibrator(pool, {
      getTclCloud: () => this.tclCloud,
      getLimits: () => this.acLeveler.getLimits(),
      broadcast: (payload) => this.broadcastPush(payload),
      // Calibration power-cycled these ACs while leveling was suspended —
      // re-arm their compressor ramps so the first post-run tick doesn't
      // misread the restart as established draw (phantom headroom).
      onDevicesRestored: (deviceIds) => this.acLeveler.rearmRamp(deviceIds),
    });

    if (config.vapidPublicKey && config.vapidPrivateKey) {
      webpush.setVapidDetails(config.vapidSubject, config.vapidPublicKey, config.vapidPrivateKey);
      log.info("[collector] Web Push configured");
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.loopWatchdog) {
      clearInterval(this.loopWatchdog);
      this.loopWatchdog = null;
    }
    if (this.mqttClient) {
      this.mqttClient.end(true);
      log.info("[collector] MQTT client closed");
    }
  }

  async runForever(): Promise<void> {
    this.startMqtt();
    this.initXiaomiCloud().catch((err) => log.error("[collector] Xiaomi Cloud init failed:", (err as Error).message));
    await this.initTclCloud();

    // Run backfills in background — don't block the main collection/automation loop
    this.runBackfills();

    this.startLoopWatchdog();
    while (!this.stopped) {
      const gap = Date.now() - this.lastLoopTickAt;
      if (gap > this.LOOP_STALL_WARN_MS) {
        log.warn(`[collector] Loop resumed after a ${Math.round(gap / 1000)}s gap`);
      }
      this.lastLoopTickAt = Date.now();
      try {
        await this.collectAll();
      } catch (err) {
        log.error("[collector] Collection cycle failed:", err);
      }
      await sleep(5000);
    }
  }

  /** Age of the loop heartbeat — exposed on /api/health for observability. */
  getLoopAgeMs(): number {
    return Date.now() - this.lastLoopTickAt;
  }

  /**
   * Loop-liveness watchdog, independent of the loop itself: a blocked
   * collectAll await leaves the event loop idle, so this interval still fires.
   * The heartbeat advances at the top of each cycle AND when each step
   * finishes (or is abandoned at its deadline), so it only ever goes stale
   * when the loop machinery itself is wedged — twice now a single hung
   * external call silently killed every automation and all leveling
   * trip-protection for hours (2026-07-02 Xiaomi 2FA, 2026-07-06 ~3h stall).
   * Warn names the in-flight step (the 07-06 stall left no clue what hung);
   * a hard stall self-heals via process exit + Docker `restart: unless-stopped`
   * (locks/sheds/fan-holds/config are all DB-persisted by design).
   */
  private startLoopWatchdog(): void {
    this.loopWatchdog = setInterval(() => {
      if (this.stopped) return;
      const age = Date.now() - this.lastLoopTickAt;
      if (age > this.LOOP_STALL_FATAL_MS) {
        log.error(`[collector] Loop stalled for ${Math.round(age / 1000)}s (step: ${this.currentStep ?? "between steps"}) — exiting for a container restart`);
        process.exit(1);
      }
      if (age > this.LOOP_STALL_WARN_MS) {
        log.warn(`[collector] Loop slow: ${Math.round(age / 1000)}s since the last heartbeat (step: ${this.currentStep ?? "between steps"})`);
      }
    }, 30_000);
    this.loopWatchdog.unref?.();
  }

  /**
   * Run one collectAll step under a hard deadline. A step that exceeds it is
   * ABANDONED — its promise may still settle later; steps are per-tick
   * idempotent so the next cycle simply retries — because one hung external
   * call must never freeze the whole loop (the loop-never-blocks principle,
   * architecture.md). The abandoned promise gets a no-op catch so a late
   * rejection can't become an unhandled rejection.
   */
  private async runStep(name: string, fn: () => Promise<void>): Promise<void> {
    this.currentStep = name;
    let timer: NodeJS.Timeout | undefined;
    const work = fn();
    work.catch(() => { /* late failure of an abandoned step — already surfaced */ });
    try {
      await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`step "${name}" exceeded ${this.STEP_TIMEOUT_MS / 1000}s — abandoned until the next cycle`)), this.STEP_TIMEOUT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      this.currentStep = null;
      this.lastLoopTickAt = Date.now();
    }
  }

  private runBackfills(): void {
    (async () => {
      try {
        await this.backfillAmbientHistory();
        await sleep(2000);
        await this.backfillQingpingHistory();
      } catch (err) {
        log.error("[collector] Backfill failed:", err);
      }
    })();
  }

  private async initXiaomiCloud(): Promise<void> {
    if (!this.config.miEmail || !this.config.miPassword) {
      log.info("[collector] Xiaomi Cloud not configured (MI_EMAIL empty), automations disabled");
      return;
    }
    try {
      this.xiaomiCloud = new XiaomiCloud(
        this.config.miEmail,
        this.config.miPassword,
        this.config.miRegion,
      );
      await this.xiaomiCloud.init();
    } catch (err) {
      log.error("[collector] Xiaomi Cloud init failed:", (err as Error).message);
      this.xiaomiCloud = null;
    }
  }

  private async initTclCloud(): Promise<void> {
    if (!this.config.tclUsername || !this.config.tclPassword) {
      log.info("[collector] TCL Cloud not configured (TCL_USERNAME empty), AC controls disabled");
      return;
    }
    try {
      this.tclCloud = new TclCloud(this.config.tclUsername, this.config.tclPassword);
      await this.tclCloud.init();
    } catch (err) {
      log.error("[collector] TCL Cloud init failed:", (err as Error).message);
      this.tclCloud = null;
    }
  }

  private async collectAll(): Promise<void> {
    try {
      await this.runStep("sensors", async () => {
        const mqttActive = this.mqttClient?.connected &&
          (Date.now() - this.lastMqttMessage < 120_000);

        const tasks: Promise<void>[] = [this.collectAmbientWeather()];
        if (!mqttActive) {
          tasks.push(this.collectQingping());
        }

        const results = await Promise.allSettled(tasks);
        for (const r of results) {
          if (r.status === "rejected") {
            log.error("[collector] Collection error:", r.reason);
          }
        }
      });
    } catch (err) {
      log.error("[collector] Sensor collection failed:", err);
    }

    try {
      await this.runStep("alerts", () => this.checkAlerts());
    } catch (err) {
      log.error("[collector] Alert check failed:", err);
    }

    try {
      // Calibration owns the ACs while active — the AC automation/timer/
      // leveler checks below all stand down until it finishes.
      await this.runStep("calibration", () => this.acCalibrator.tick());
    } catch (err) {
      log.error("[collector] AC calibration tick failed:", err);
    }

    try {
      await this.runStep("automations", () => this.checkAutomations());
    } catch (err) {
      log.error("[collector] Automation check failed:", err);
    }

    try {
      await this.runStep("ac-timers", () => this.checkAcTimers());
    } catch (err) {
      log.error("[collector] AC timer check failed:", err);
    }

    try {
      await this.runStep("leveling", () => this.runLevelingCheck());
    } catch (err) {
      log.error("[collector] AC leveling check failed:", err);
    }

    try {
      await this.runStep("beep", () => this.checkAcBeepEnforcement());
    } catch (err) {
      log.error("[collector] AC beep enforcement failed:", err);
    }

    // Retry TCL Cloud init if it failed previously (every 5 minutes)
    if (!this.tclCloud && this.config.tclUsername && this.config.tclPassword && Date.now() >= this.tclRetryAt) {
      this.tclRetryAt = Date.now() + 5 * 60_000;
      log.info("[collector] Retrying TCL Cloud init...");
      try {
        await this.runStep("tcl-init", () => this.initTclCloud());
      } catch (err) {
        log.error("[collector] TCL Cloud init retry failed:", err);
      }
    }

    // Retry Xiaomi Cloud init if it failed previously (every 5 minutes).
    // Deadline-wrapped: a pending 2FA prompt inside init() must never freeze
    // the loop (the 2026-07-02 stall — same principle as the in-loop re-auth).
    if (!this.xiaomiCloud && this.config.miEmail && this.config.miPassword && Date.now() >= this.xiaomiRetryAt) {
      this.xiaomiRetryAt = Date.now() + 5 * 60_000;
      log.info("[collector] Retrying Xiaomi Cloud init...");
      try {
        await this.runStep("xiaomi-init", () => this.initXiaomiCloud());
      } catch (err) {
        log.error("[collector] Xiaomi Cloud init retry failed:", err);
      }
    }
  }

  private async refreshAlertRules(): Promise<void> {
    if (Date.now() - this.alertRulesLastFetch < 30_000) return;
    const result = await this.pool.query(
      `SELECT ar.*, ps.subscription
       FROM alert_rules ar
       JOIN push_subscriptions ps ON ar.endpoint = ps.endpoint`
    );
    this.alertRules = result.rows as AlertRule[];
    this.alertRulesLastFetch = Date.now();

    // Prune stale sensor alert state for deleted rules
    const activeIds = new Set(this.alertRules.map((r) => r.id));
    for (const id of this.sensorAlertState.keys()) {
      if (!activeIds.has(id)) this.sensorAlertState.delete(id);
    }
  }

  private async checkAlerts(): Promise<void> {
    if (!this.config.vapidPublicKey) return;

    await this.refreshAlertRules();
    if (this.alertRules.length === 0) return;

    const now = new Date();
    const dateKey = now.toLocaleDateString("en-CA", { timeZone: "Asia/Baghdad" });

    // Reset prayer sent set on new day
    if (dateKey !== this.sentDateKey) {
      this.sentNotifications.clear();
      this.sentDateKey = dateKey;
    }

    // Check sensor alerts
    const weatherStale = !this.latestWeatherTs || (now.getTime() - this.latestWeatherTs.getTime() > 300_000);
    const airStale = !this.latestAirTs || (now.getTime() - this.latestAirTs.getTime() > 300_000);
    const powerStale = !this.latestPowerTs || (now.getTime() - this.latestPowerTs.getTime() > 60_000);

    for (const rule of this.alertRules) {
      if (rule.alert_type === "sensor") {
        const def = rule.metric ? ALERT_METRICS[rule.metric] : null;
        if (!def || !rule.condition || rule.threshold == null) continue;

        // Skip if source data is stale
        if (def.source === "weather" && weatherStale) continue;
        if (def.source === "air" && airStale) continue;
        if (def.source === "power" && powerStale) continue;

        const value = getMetricValue(
          rule.metric!,
          this.latestWeatherRow,
          this.latestAirRow,
          this.latestPowerRow,
        );
        if (value == null) continue;

        // Power fluctuates (motor/compressor spikes) — require 4 consecutive ESP
        // readings (~20s) meeting the condition before a power alert fires.
        const conditionMet = def.source === "power"
          ? powerConditionSustained(rule.metric!, rule.condition, rule.threshold, this.recentPowerReadings)
          : rule.condition === "above"
            ? value > rule.threshold
            : value < rule.threshold;

        const QUIET_PERIOD_MS = 10 * 60 * 1000; // 10 minutes
        const entry = this.sensorAlertState.get(rule.id) ?? { state: "idle" };

        if (conditionMet && entry.state === "idle") {
          // Only fire if quiet period has elapsed (or no prior resolution)
          if (!entry.resolvedAt || (Date.now() - entry.resolvedAt) >= QUIET_PERIOD_MS) {
            this.sensorAlertState.set(rule.id, { state: "triggered" });
            await this.sendAlertPush(rule, value);
          }
        } else if (!conditionMet && entry.state === "triggered") {
          // Value returned to normal — start quiet period
          this.sensorAlertState.set(rule.id, { state: "idle", resolvedAt: Date.now() });
        }
      }
    }

    // Check prayer alerts (cache PrayerTimes per day — changes only at midnight)
    const pt = this.ensurePrayerTimesForToday();
    const nowMs = now.getTime();

    for (const rule of this.alertRules) {
      if (rule.alert_type !== "prayer") continue;
      if (!rule.prayer_names?.length) continue;

      const bp = rule.prayer_timing === "at_time" ? 0 : (rule.prayer_minutes ?? 0);

      for (const name of rule.prayer_names) {
        const prayerTime = prayerInstant(pt, name);
        if (!prayerTime) continue;

        const minutesLeft = (prayerTime.getTime() - nowMs) / 60000;
        const key = `alert-${rule.id}-${name}`;

        if (minutesLeft <= bp && minutesLeft > bp - 2 && !this.sentNotifications.has(key)) {
          this.sentNotifications.add(key);

          const label = PRAYER_LABELS[name] ?? name;
          const timeStr = prayerTime.toLocaleTimeString("en-US", {
            timeZone: "Asia/Baghdad",
            hour: "numeric",
            minute: "2-digit",
            hour12: true,
          });

          const title = bp === 0
            ? `It's time for ${label}`
            : `${label} in ${bp} minutes`;

          await this.sendPush(rule.subscription, {
            title,
            body: timeStr,
            type: "prayer",
            prayer: name,
            minutesLeft: bp,
          });
        }
      }
    }
  }

  private async sendAlertPush(rule: AlertRule, currentValue: number): Promise<void> {
    const def = ALERT_METRICS[rule.metric!];
    const unit = def.unit ? ` ${def.unit}` : "";
    const title = `${def.label} ${rule.condition} ${rule.threshold}${unit}`;
    const body = `Current: ${Math.round(currentValue * 10) / 10}${unit}`;

    await this.sendPush(rule.subscription, {
      title,
      body,
      type: "sensor",
      metric: rule.metric,
    });
  }

  /**
   * Send a leveling push (shed/restore/calibration) to devices that opted in.
   * Off by default for everyone — each device enables it via /api/push/leveling.
   */
  private async broadcastPush(payload: Record<string, unknown>): Promise<void> {
    try {
      const result = await this.pool.query(
        "SELECT subscription FROM push_subscriptions WHERE leveling_notifications = true",
      );
      for (const row of result.rows) {
        await this.sendPush(row.subscription, payload);
      }
    } catch (err) {
      log.error("[collector] Broadcast push failed:", (err as Error).message);
    }
  }

  private async sendPush(subscription: unknown, payload: Record<string, unknown>): Promise<void> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await webpush.sendNotification(subscription as any, JSON.stringify(payload));
      log.info(`[collector] Sent push: ${payload.title}`);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        const endpoint = (subscription as { endpoint?: string }).endpoint;
        if (endpoint) {
          await this.pool.query("DELETE FROM push_subscriptions WHERE endpoint = $1", [endpoint]);
          log.info("[collector] Removed stale push subscription");
          this.alertRulesLastFetch = 0; // Force refresh on next cycle
        }
      } else {
        log.error(`[collector] Push failed (${status}):`, (err as Error).message);
      }
    }
  }

  // ---------- Prayer Time Helpers ----------

  private ensurePrayerTimesForToday(): PrayerTimesResult {
    const dateKey = baghdadDateKey();
    if (dateKey !== this.cachedPrayerDateKey) {
      this.cachedPrayerTimes = getBaghdadPrayerTimes();
      this.cachedPrayerDateKey = dateKey;
      log.debug(`[prayer-cache] Refreshed for ${dateKey}`);
    }
    return this.cachedPrayerTimes!;
  }

  private resolvePrayerMinutes(prayer: string, offset: number): number | null {
    const t = prayerInstant(this.ensurePrayerTimesForToday(), prayer);
    if (!t) return null;
    return ((baghdadMinuteOfDay(t) + offset) % 1440 + 1440) % 1440;
  }

  // ---------- Automations ----------

  private async refreshAutomationRules(): Promise<void> {
    if (Date.now() - this.automationRulesLastFetch < 30_000) return;
    const result = await this.pool.query(
      "SELECT * FROM automations WHERE enabled = true",
    );
    this.automationRules = result.rows as AutomationRule[];
    this.automationRulesLastFetch = Date.now();

    // Prune stale state for deleted rules
    const activeIds = new Set(this.automationRules.map((r) => r.id));
    for (const id of this.automationState.keys()) {
      if (!activeIds.has(id)) this.automationState.delete(id);
    }
  }

  private async checkAutomations(): Promise<void> {
    await this.refreshAutomationRules();
    // Load leveler state early so shed guards and gen-strip checks see DB state
    await this.acLeveler.ensureLoaded();
    if (this.automationRules.length === 0) return;

    if (this.tclCloud && !this.tclCloud.isReady() && Date.now() >= this.tclRetryAt) {
      // Fire-and-forget for the same reason as the Xiaomi re-auth below: nothing
      // awaited inside the collection loop may block on an unbounded wait. TCL
      // auto-refreshes (no human 2FA today), but a hung auth request must not
      // freeze weather/alerts/automations. AC rules that need TCL just skip the
      // tick until isReady() (see the device-loop guard below). Throttle set
      // before launch so an in-flight init isn't relaunched next tick.
      this.tclRetryAt = Date.now() + 60_000;
      log.warn("[collector] TCL Cloud not ready, attempting re-auth");
      void this.tclCloud.init().catch((err) =>
        log.error("[collector] TCL Cloud re-auth failed:", (err as Error).message));
    }

    if (this.xiaomiCloud && !this.xiaomiCloud.isReady()) {
      const authInfo = this.xiaomiCloud.getAuthStatus();
      if (authInfo.status !== "needs_2fa" && authInfo.status !== "needs_captcha") {
        if (Date.now() >= this.xiaomiRetryAt) {
          // Fire-and-forget: init() blocks until 2FA/captcha is answered — its
          // on2fa/onCaptcha callbacks return promises that only resolve via
          // POST /api/xiaomi/verify. Awaiting here would freeze the ENTIRE
          // collection loop (weather, alerts, automations, timers, beep) until
          // a human submits a code. Mirror the non-blocking startup path
          // (see initXiaomiCloud call in runForever). Throttle set BEFORE the
          // launch so a pending 2FA prompt (status not yet flipped) can't be
          // relaunched on the next tick.
          this.xiaomiRetryAt = Date.now() + 60_000;
          log.warn("[collector] Xiaomi Cloud not ready, attempting re-auth");
          void this.xiaomiCloud.init().catch((err) =>
            log.error("[collector] Xiaomi Cloud re-auth failed:", (err as Error).message));
        }
      }
    }

    for (const rule of this.automationRules) {
      // Calibration deliberately powers ACs off/on — AC rules must not fight
      // it (or record manual-off locks for calibration-initiated offs).
      if (rule.device_type === "ac" && this.acCalibrator.isActive()) continue;
      if (rule.device_type === "ac" && (!this.tclCloud || !this.tclCloud.isReady())) continue;
      if (rule.device_type !== "ac" && (!this.xiaomiCloud || !this.xiaomiCloud.isReady())) continue;

      if (rule.automation_type === "schedule") {
        await this.checkScheduleAutomation(rule);
      } else {
        await this.checkMetricAutomation(rule);
      }
    }
  }

  private async executeAutomationAction(rule: AutomationRule, action: PurifierAction | AcAction, deviceIds: string[]): Promise<void> {
    if (rule.device_type === "ac") {
      await this.tclCloud!.ensureDeviceCachePopulated();
    }
    for (const did of deviceIds) {
      const effectiveAction = this.stripLeveledControls(rule, action, did);
      if (rule.device_type === "ac") {
        await this.tclCloud!.executeAcAction(did, effectiveAction as AcAction);
      } else {
        await this.xiaomiCloud!.executeAction(did, effectiveAction as PurifierAction);
      }
    }
  }

  private async checkMetricAutomation(rule: AutomationRule): Promise<void> {
    if (!rule.metric || rule.threshold == null) return;

    if (rule.device_type === "ac" && rule.threshold_low != null) {
      return this.checkAcRangeAutomation(rule);
    }

    if (!rule.condition) return;

    const now = Date.now();
    const weatherStale = !this.latestWeatherTs || (now - this.latestWeatherTs.getTime() > 300_000);
    const airStale = !this.latestAirTs || (now - this.latestAirTs.getTime() > 300_000);
    const powerStale = !this.latestPowerTs || (now - this.latestPowerTs.getTime() > 60_000);

    const def = ALERT_METRICS[rule.metric];
    if (!def) return;

    if (def.source === "weather" && weatherStale) return;
    if (def.source === "air" && airStale) return;
    if (def.source === "power" && powerStale) return;

    const value = getMetricValue(rule.metric, this.latestWeatherRow, this.latestAirRow, this.latestPowerRow);
    if (value == null) return;

    const conditionMet = rule.condition === "above"
      ? value >= rule.threshold
      : value <= rule.threshold;

    const state = this.automationState.get(rule.id) ?? { status: "idle", lastToggle: 0, conditionSince: null, conditionLostAt: null, canAutoTurnOn: true };
    const cooldownMs = (rule.cooldown_secs ?? 5) * 1000;

    const deviceIds = rule.device_ids ?? [rule.device_id];
    const deviceNames = (rule.device_names ?? [rule.device_name]).join(", ");

    // Sustained duration: track how long condition has been continuously met
    // Grace period: tolerate brief sensor dips (60s) before resetting the timer
    const GRACE_MS = 60_000;
    if (conditionMet) {
      if (state.conditionSince == null) state.conditionSince = now;
      state.conditionLostAt = null;
    } else {
      if (state.conditionLostAt == null) state.conditionLostAt = now;
      if (now - state.conditionLostAt >= GRACE_MS) {
        state.conditionSince = null;
      }
    }
    this.automationState.set(rule.id, state);

    // Check if sustained long enough
    const sustainedMs = (rule.sustained_minutes ?? 0) * 60_000;
    const sustainedEnough = sustainedMs === 0 || (state.conditionSince != null && (now - state.conditionSince >= sustainedMs));

    if (conditionMet && sustainedEnough && (now - state.lastToggle >= cooldownMs)) {
      if (state.status === "idle") {
        let targetDeviceIds = deviceIds;
        if (rule.device_type === "ac") {
          const lockedIds = await this.getAcManualOffLockedIds(deviceIds);
          if (lockedIds.size > 0) {
            for (const did of lockedIds) {
              const power = await this.getDevicePowerCached(did, "ac", true);
              if (power !== "on" && await this.isAcManualOffLocked(did)) {
                log.info(`[collector] Automation "${rule.name}": device ${did} is manual-off locked, skipping auto-on`);
              }
            }
            targetDeviceIds = deviceIds.filter((did) => !this.acManualOffLocks.has(did));
          }
          // Shed devices are leveler-owned — only the leveler restores them
          targetDeviceIds = targetDeviceIds.filter((did) => !this.acLeveler.isShed(did));
          if (targetDeviceIds.length === 0) return;
        }
        // First trigger — turn on all devices
        log.info(
          `[collector] Automation "${rule.name}": ${rule.metric}=${value} ${rule.condition} ${rule.threshold}` +
          (sustainedMs > 0 ? ` for ${rule.sustained_minutes}min` : "") +
          `, turning ON [${deviceNames}]`,
        );
        try {
          await this.executeAutomationAction(rule, rule.action_on, targetDeviceIds);
          this.automationState.set(rule.id, { status: "triggered", lastToggle: now, conditionSince: state.conditionSince, conditionLostAt: null, canAutoTurnOn: true });
        } catch (err) {
          log.error(`[collector] Automation "${rule.name}" action_on failed:`, (err as Error).message);
        }
      } else {
        // Already triggered — re-check device power and re-send turn-on if off
        for (const did of deviceIds) {
          try {
            const power = await this.getDevicePowerCached(did, rule.device_type);
            if (power === "off" || power === undefined) {
              if (rule.device_type === "ac") {
                if (this.acLeveler.isShed(did)) continue; // leveler shed it — not a manual off
                // A fetch gap is not an observation — never lock on undefined.
                if (power === undefined) continue;
                if (!(await this.handleObservedAcOff(`Automation "${rule.name}"`, did, deviceNames))) {
                  this.automationState.set(rule.id, { status: "idle", lastToggle: now, conditionSince: null, conditionLostAt: null, canAutoTurnOn: false });
                  continue;
                }
                // Power-event off → fall through to the re-turn-on below.
              }
              log.info(
                `[collector] Automation "${rule.name}": device ${did} is OFF while ${rule.metric}=${value} still ${rule.condition} ${rule.threshold}, re-turning ON [${deviceNames}]`,
              );
              await this.executeAutomationAction(rule, rule.action_on, [did]);
              this.devicePowerCache.set(did, { power: "on", ts: Date.now() });
            }
          } catch (err) {
            log.error(`[collector] Automation "${rule.name}" re-check failed for ${did}:`, (err as Error).message);
          }
        }
        this.automationState.set(rule.id, { status: "triggered", lastToggle: now, conditionSince: state.conditionSince, conditionLostAt: null, canAutoTurnOn: true });
      }
    } else if (!conditionMet && state.status === "triggered") {
      if (rule.turn_off_at_end) {
        const defaultOff = rule.device_type === "ac" ? { power: 0 as const } : { power: "off" as const };
        const offAction = rule.action_off ?? defaultOff;
        for (const did of deviceIds) {
          try {
            await this.executeAutomationAction(rule, offAction, [did]);
            this.devicePowerCache.set(did, { power: "off", ts: Date.now() });
            if (rule.device_type === "ac") await this.acLeveler.clearShed(did, "metric_turn_off");
          } catch (err) {
            log.error(`Automation "${rule.name}" turn-off failed for ${did}:`, (err as Error).message);
          }
        }
        log.info(`Automation "${rule.name}" condition cleared → turning OFF devices`);
      }
      this.automationState.set(rule.id, { status: "idle", lastToggle: state.lastToggle, conditionSince: null, conditionLostAt: null, canAutoTurnOn: true });
    }
  }

  private async getDevicePowerCached(deviceId: string, deviceType: "purifier" | "ac" = "purifier", forceRefresh = false): Promise<"on" | "off" | undefined> {
    const cached = this.devicePowerCache.get(deviceId);
    if (!forceRefresh && cached && Date.now() - cached.ts < this.POWER_CACHE_TTL) return cached.power;
    let power: "on" | "off" | undefined;
    if (deviceType === "ac") {
      const devs = await this.tclCloud!.fetchDevicesLive();
      const dev = devs.find(d => d.id === deviceId);
      power = dev ? (dev.power ? "on" : "off") : undefined;
      this.noteAcObservedPower(deviceId, power);
      if (power === "on") {
        if (this.canClearAcManualOff(deviceId)) {
          await this.clearAcManualOff(deviceId);
        }
        await this.acLeveler.reconcileObservedOn(deviceId);
      }
    } else {
      power = await this.xiaomiCloud!.getDevicePower(deviceId);
    }
    this.devicePowerCache.set(deviceId, { power, ts: Date.now() });
    return power;
  }

  private acFanKey(ruleId: number, deviceId: string): string {
    return `${ruleId}:${deviceId}`;
  }

  /** Drops fan bookkeeping (incl. a manual override) — call on any AC power cycle the rule owns. */
  private clearAcFanEnforcement(ruleId: number, deviceId: string): void {
    this.acFanEnforcement.delete(this.acFanKey(ruleId, deviceId));
  }

  private acSwingKey(ruleId: number, deviceId: string): string {
    return `${ruleId}:${deviceId}`;
  }

  /** Drops a manual swing override — call on any AC power cycle the rule owns. */
  private clearAcSwingOverride(ruleId: number, deviceId: string): void {
    this.acSwingOverrides.delete(this.acSwingKey(ruleId, deviceId));
  }

  /**
   * The range fan is ALWAYS the delta-based smart level unless the active slot
   * explicitly fixes 1–7 (slot 0 or absent → smart auto). The preset's
   * fan_speed never drives range enforcement — presets still apply their fan
   * on a manual tap, which then counts as a manual override. The AC's
   * built-in auto (0) is never enforced by range automations.
   */
  private resolveRangeFan(rule: AutomationRule, slot: AutomationRangeSlot, deviceId: string, value: number): number {
    if (slot.fan_speed != null && slot.fan_speed >= 1) return slot.fan_speed;
    const isCool = (rule.action_on as Record<string, unknown>).mode === 1;
    const delta = isCool ? value - slot.threshold_low : slot.threshold - value;
    const entry = this.acFanEnforcement.get(this.acFanKey(rule.id, deviceId));
    return computeAutoFanLevel(delta, entry?.lastCommandedFan);
  }

  /**
   * rule.action_on with the resolved per-slot fan and per-slot generator
   * level; fan + turbo dropped while a manual fan override is active. The
   * slot's gen_level overrides the preset's generator_mode (clamped to the
   * device max) — stripLeveledControls removes it again when the leveler
   * manages the device, so the direct send only lands when unmanaged.
   */
  /**
   * Slot gen level clamped to the device's real max. Null when the device
   * cache is cold — better to skip the override for one tick (diff
   * re-enforcement retries within 5s) than to guess a max and send an
   * out-of-range level to a max-3 unit.
   */
  private clampSlotGenLevel(deviceId: string, genLevel: number): number | null {
    const deviceMax = this.tclCloud?.getDevices().find((d) => d.id === deviceId)?.maxGeneratorLevel;
    return deviceMax ? Math.min(genLevel, deviceMax) : null;
  }

  private effectiveAcRangeProfile(rule: AutomationRule, slot: AutomationRangeSlot, deviceId: string, value: number): AcAction {
    const profile = { ...(rule.action_on as AcAction) };
    if (slot.gen_level != null) {
      const clamped = this.clampSlotGenLevel(deviceId, slot.gen_level);
      if (clamped != null) profile.generator_mode = clamped;
    }
    // Vertical swing: a manual UI change (noteUserAcSwingChange) suspends
    // enforcement until the active slot changes or the AC power-cycles — same
    // intent model as fan. The override is keyed to the slot it was made under,
    // so a slot change naturally resumes enforcement.
    const swingKey = this.acSwingKey(rule.id, deviceId);
    const swingOverride = this.acSwingOverrides.get(swingKey);
    if (swingOverride && swingOverride.slotId !== slot.id) {
      this.acSwingOverrides.delete(swingKey); // active slot changed — resume swing enforcement
    }
    if (this.acSwingOverrides.has(swingKey)) {
      delete profile.vertical_swing; // user took manual swing control — leave it untouched
    } else if (slot.vertical_swing != null) {
      // 0 (Off) is a real value — overrides the preset's swing; absent falls through.
      profile.vertical_swing = slot.vertical_swing;
    }
    const entry = this.acFanEnforcement.get(this.acFanKey(rule.id, deviceId));
    if (entry?.manual) {
      // Non-Najat fan 7 == turbo — enforcing turbo would clobber a manual fan choice
      delete profile.fan_speed;
      delete profile.turbo;
      return profile;
    }
    profile.fan_speed = this.resolveRangeFan(rule, slot, deviceId, value);
    return profile;
  }

  /**
   * Detects manual fan changes (shadow drift vs the fan we last commanded) and
   * resets the bookkeeping when the active range slot changes. Call before
   * computing the enforcement diff.
   */
  private updateAcFanTracking(rule: AutomationRule, slot: AutomationRangeSlot, deviceId: string, value: number, now: number): void {
    // While the leveler holds the fan down (last try before a shed), the drift
    // is ours — don't misread it as a manual change.
    if (this.acLeveler.hasFanHold(deviceId)) return;
    const key = this.acFanKey(rule.id, deviceId);
    let entry = this.acFanEnforcement.get(key);
    if (entry && entry.slotId !== slot.id) {
      // New active range = new fan intent — drop any manual override and baseline
      this.acFanEnforcement.delete(key);
      entry = undefined;
    }
    if (entry?.manual) return;
    const desiredFan = this.resolveRangeFan(rule, slot, deviceId, value);
    const observed = this.tclCloud?.getDeviceState(deviceId)?.fan_speed;
    if (observed == null) return; // device not in cache yet — skip this tick
    if (!entry) {
      if (observed === desiredFan) {
        // Device already matches — adopt a baseline so a later user change is detected
        this.acFanEnforcement.set(key, { slotId: slot.id, lastCommandedFan: desiredFan, lastFanCommandAt: now, manual: false });
      }
      // else: this tick's diff will command the fan and noteAcFanCommanded creates the baseline
      return;
    }
    if (observed === entry.lastCommandedFan) return;
    // Our own just-sent command may not be reflected in the shadow yet
    if (now - entry.lastFanCommandAt < this.AC_FAN_SETTLE_MS) return;
    // Observed fan 0 (built-in auto) is NEVER a manual intent: the firmware
    // resets to auto after a power-loss restart (changeovers) and automations
    // never command 0 — the next tick's diff re-enforces the resolved fan.
    // The dashboard A button is the explicit way back to auto (noteUserAcFanAuto).
    if (observed === 0) return;
    this.acFanEnforcement.set(key, { ...entry, manual: true });
    log.info(`[collector] AC range "${rule.name}": manual fan change on ${deviceId} (fan=${observed}), suspending fan enforcement until slot change or power cycle`);
  }

  /** Records the fan we just sent so drift detection has a baseline. */
  private noteAcFanCommanded(rule: AutomationRule, slot: AutomationRangeSlot, deviceId: string, sent: AcAction): void {
    if (sent.fan_speed == null) return;
    this.acFanEnforcement.set(this.acFanKey(rule.id, deviceId), {
      slotId: slot.id,
      lastCommandedFan: sent.fan_speed,
      lastFanCommandAt: Date.now(),
      manual: false,
    });
  }

  /**
   * Leveler fan command — re-baseline enforcement entries so the hold (and its
   * release) is never misdetected as a manual change. Preserves manual/slotId.
   */
  private refreshAcFanBaseline(deviceId: string, fan: number): void {
    for (const rule of this.automationRules) {
      if (rule.device_type !== "ac" || rule.automation_type !== "metric" || rule.threshold_low == null) continue;
      if (!(rule.device_ids ?? [rule.device_id]).includes(deviceId)) continue;
      const key = this.acFanKey(rule.id, deviceId);
      const entry = this.acFanEnforcement.get(key);
      if (!entry) continue;
      this.acFanEnforcement.set(key, { ...entry, lastCommandedFan: fan, lastFanCommandAt: Date.now() });
    }
  }

  /**
   * UI fan set to Auto (0) — hand fan control back to the range automations:
   * any manual override is cleared and the resolved fan (smart auto for Auto
   * slots/presets) re-enforces on the next tick. The AC's built-in auto stays
   * in effect only for devices no automation owns.
   */
  noteUserAcFanAuto(deviceId: string): void {
    // The physical fan changed — release any leveler fan hold, same as a manual change
    void this.acLeveler.onUserFanChange(deviceId);
    let resumed = false;
    for (const key of this.acFanEnforcement.keys()) {
      if (key.endsWith(`:${deviceId}`)) {
        this.acFanEnforcement.delete(key);
        resumed = true;
      }
    }
    if (resumed) log.info(`[collector] AC ${deviceId}: user fan Auto — resuming automation fan enforcement (smart auto)`);
  }

  /**
   * UI gen-level change → record + delegate to the leveler. For a leveler-managed
   * AC the leveler owns the intent (manualCap/manualTarget); for an UNMANAGED AC
   * (leveling off / opted out) the recorded timestamp suppresses range
   * generator_mode re-enforcement so the manual level isn't slammed back.
   */
  onUserAcGenLevel(deviceId: string, level: number): Promise<{ reverted: boolean; level: number }> {
    this.lastUserGenChangeAt.set(deviceId, Date.now());
    return this.acLeveler.onUserGenLevel(deviceId, level);
  }

  /** A manual gen-level change is still "active" (suppresses range re-enforcement). */
  private hasRecentUserGenChange(deviceId: string): boolean {
    const at = this.lastUserGenChangeAt.get(deviceId);
    return at != null && Date.now() - at < this.AC_USER_GEN_OVERRIDE_MS;
  }

  /** UI fan/turbo change — suspend fan enforcement immediately (no settle-window race). */
  noteUserAcFanChange(deviceId: string): void {
    void this.acLeveler.onUserFanChange(deviceId);
    for (const rule of this.automationRules) {
      if (rule.device_type !== "ac" || rule.automation_type !== "metric" || rule.threshold_low == null) continue;
      if (!(rule.device_ids ?? [rule.device_id]).includes(deviceId)) continue;
      const slot = findActiveRangeSlot(
        rule.range_slots ?? getLegacyRangeSlots(rule.threshold_low, rule.threshold),
        getBaghdadMinutes(),
        (prayer, offset) => this.resolvePrayerMinutes(prayer, offset),
      );
      if (!slot) continue;
      const entry = this.acFanEnforcement.get(this.acFanKey(rule.id, deviceId));
      this.acFanEnforcement.set(this.acFanKey(rule.id, deviceId), {
        slotId: slot.id,
        lastCommandedFan: entry?.lastCommandedFan ?? null,
        lastFanCommandAt: entry?.lastFanCommandAt ?? 0,
        manual: true,
      });
      log.info(`[collector] AC ${deviceId}: user fan change — suspending fan enforcement for rule "${rule.name}"`);
    }
  }

  /**
   * UI vertical-swing change — suspend swing enforcement for every range rule
   * owning this device until the active slot changes or the AC power-cycles.
   * Mirrors the fan manual-override intent model (UI-driven; no shadow drift).
   */
  noteUserAcSwingChange(deviceId: string): void {
    for (const rule of this.automationRules) {
      if (rule.device_type !== "ac" || rule.automation_type !== "metric" || rule.threshold_low == null) continue;
      if (!(rule.device_ids ?? [rule.device_id]).includes(deviceId)) continue;
      const slot = findActiveRangeSlot(
        rule.range_slots ?? getLegacyRangeSlots(rule.threshold_low, rule.threshold),
        getBaghdadMinutes(),
        (prayer, offset) => this.resolvePrayerMinutes(prayer, offset),
      );
      if (!slot) continue;
      this.acSwingOverrides.set(this.acSwingKey(rule.id, deviceId), { slotId: slot.id });
      log.info(`[collector] AC ${deviceId}: user vertical-swing change — suspending swing enforcement for rule "${rule.name}" until slot change or power cycle`);
    }
  }

  private async checkAcRangeAutomation(rule: AutomationRule): Promise<void> {
    const now = Date.now();
    const def = ALERT_METRICS[rule.metric!];
    if (!def) { log.warn(`[collector] AC range "${rule.name}": unknown metric "${rule.metric}"`); return; }

    const state = this.automationState.get(rule.id) ?? { status: "idle", lastToggle: 0, conditionSince: null, conditionLostAt: null, canAutoTurnOn: true };
    const cooldownMs = (rule.cooldown_secs ?? 5) * 1000;
    const deviceIds = rule.device_ids ?? [rule.device_id];
    const deviceNames = (rule.device_names ?? [rule.device_name]).join(", ");
    const activeSlot = findActiveRangeSlot(
      rule.range_slots ?? getLegacyRangeSlots(rule.threshold_low, rule.threshold),
      getBaghdadMinutes(),
      (prayer, offset) => this.resolvePrayerMinutes(prayer, offset),
    );

    if (!activeSlot) {
      await this.turnOffAcOutsideRange(rule, state, now, cooldownMs, deviceIds, deviceNames);
      return;
    }

    const weatherStale = !this.latestWeatherTs || (now - this.latestWeatherTs.getTime() > 300_000);
    const airStale = !this.latestAirTs || (now - this.latestAirTs.getTime() > 300_000);
    const powerStale = !this.latestPowerTs || (now - this.latestPowerTs.getTime() > 60_000);
    if (def.source === "weather" && weatherStale) return;
    if (def.source === "air" && airStale) return;
    if (def.source === "power" && powerStale) return;

    const value = getMetricValue(rule.metric!, this.latestWeatherRow, this.latestAirRow, this.latestPowerRow);
    if (value == null) { log.warn(`[collector] AC range "${rule.name}": metric "${rule.metric}" value is null`); return; }

    const acAction = rule.action_on as Record<string, unknown>;
    const isCool = acAction.mode === 1;

    const shouldTurnOn = isCool ? value >= activeSlot.threshold : value <= activeSlot.threshold_low;
    const shouldTurnOff = isCool ? value <= activeSlot.threshold_low : value >= activeSlot.threshold;

    if (state.status === "idle") {
      if (shouldTurnOn) {
        const lockedIds = await this.getAcManualOffLockedIds(deviceIds);
        let unlockedDeviceIds = deviceIds.filter((did) => !lockedIds.has(did) && !this.acLeveler.isShed(did));
        if (lockedIds.size > 0 && now - state.lastToggle >= cooldownMs) {
          for (const did of deviceIds) {
            if (!lockedIds.has(did)) continue;
            try {
              const power = await this.getDevicePowerCached(did, "ac", true);
              if (power === "on" && !(await this.isAcManualOffLocked(did))) {
                await this.tclCloud!.ensureDeviceCachePopulated();
                this.clearAcFanEnforcement(rule.id, did); // user power-cycled — fan intent resets
                this.clearAcSwingOverride(rule.id, did);  // and swing intent resets
                const { power: _p, ...profileOnly } = this.effectiveAcRangeProfile(rule, activeSlot, did, value);
                const diff = this.tclCloud!.computeAcDiff(did, this.stripLeveledControls(rule, profileOnly, did));
                if (diff) {
                  log.info(`[collector] AC range "${rule.name}": device ${did} is ON while locked, adopting with diff: ${JSON.stringify(diff)}`);
                  await this.tclCloud!.executeAcAction(did, diff);
                  this.noteAcFanCommanded(rule, activeSlot, did, diff);
                }
                this.automationState.set(rule.id, { status: "triggered", lastToggle: now, conditionSince: null, conditionLostAt: null, canAutoTurnOn: false });
                return;
              }
              log.info(`[collector] AC range "${rule.name}": device ${did} is manual-off locked, skipping auto-on`);
            } catch (err) {
              log.error(`[collector] AC range "${rule.name}" lock-check failed for ${did}:`, (err as Error).message);
            }
          }
          unlockedDeviceIds = deviceIds.filter((did) => !this.acManualOffLocks.has(did) && !this.acLeveler.isShed(did));
        }
        if (unlockedDeviceIds.length === 0) {
          this.automationState.set(rule.id, { ...state, conditionSince: null });
          return;
        }
        if (state.conditionSince == null) state.conditionSince = now;
        const sustainedMs = (rule.sustained_minutes ?? 0) * 60_000;
        const sustained = sustainedMs === 0 || (now - state.conditionSince >= sustainedMs);
        if (sustained && (now - state.lastToggle >= cooldownMs)) {
          log.info(
            `[collector] AC range "${rule.name}": ${rule.metric}=${value}, turning ON [${deviceNames}]`,
          );
          try {
            await this.tclCloud!.ensureDeviceCachePopulated();
            // Automation power-on = power cycle: drop manual fan + swing overrides, apply the slot fan/swing
            for (const did of unlockedDeviceIds) {
              this.clearAcFanEnforcement(rule.id, did);
              this.clearAcSwingOverride(rule.id, did);
            }
            const fan = this.resolveRangeFan(rule, activeSlot, unlockedDeviceIds[0], value);
            // Slot gen level overrides the preset's (clamped to the device max;
            // stripped again downstream when the leveler manages the device).
            const slotGen = activeSlot.gen_level != null
              ? this.clampSlotGenLevel(unlockedDeviceIds[0], activeSlot.gen_level)
              : null;
            // Slot vertical swing overrides the preset's (0 = Off is a real value).
            const slotSwing = activeSlot.vertical_swing != null ? activeSlot.vertical_swing : null;
            const onAction = {
              ...(rule.action_on as AcAction),
              ...(fan != null ? { fan_speed: fan } : {}),
              ...(slotGen != null ? { generator_mode: slotGen } : {}),
              ...(slotSwing != null ? { vertical_swing: slotSwing } : {}),
            };
            await this.executeAutomationAction(rule, onAction, unlockedDeviceIds);
            for (const did of unlockedDeviceIds) this.noteAcFanCommanded(rule, activeSlot, did, onAction as AcAction);
            this.automationState.set(rule.id, { status: "triggered", lastToggle: now, conditionSince: null, conditionLostAt: null, canAutoTurnOn: false });
          } catch (err) {
            log.error(`[collector] AC range "${rule.name}" turn-on failed:`, (err as Error).message);
          }
        } else {
          this.automationState.set(rule.id, state);
        }
      } else if (now - state.lastToggle >= cooldownMs) {
        let adopted = false;
        for (const did of deviceIds) {
          try {
            const power = await this.getDevicePowerCached(did, "ac");
            if (power === "on") {
              if (shouldTurnOff) {
                if (now - (this.acRangeOffAt.get(did) ?? 0) < this.AC_OFF_REFIRE_GRACE_MS) continue; // off already sent — shadow lagging
                log.info(`[collector] AC range "${rule.name}": device ${did} is ON past turn-off limit (${rule.metric}=${value}), turning OFF`);
                // Temperature-cycling off — remember the stable level for warm restore.
                await this.acLeveler.rememberStableLevel(did);
                await this.executeAutomationAction(rule, { power: 0 } as AcAction, [did]);
                this.acRangeOffAt.set(did, now);
                this.devicePowerCache.set(did, { power: "off", ts: Date.now() });
              } else {
                this.updateAcFanTracking(rule, activeSlot, did, value, now);
                const { power: _p, ...profileOnly } = this.effectiveAcRangeProfile(rule, activeSlot, did, value);
                const diff = this.tclCloud!.computeAcDiff(did, this.stripLeveledControls(rule, profileOnly, did));
                if (diff) {
                  log.info(`[collector] AC range "${rule.name}": device ${did} is ON in dead zone (${rule.metric}=${value}), adopting with diff: ${JSON.stringify(diff)}`);
                  await this.tclCloud!.executeAcAction(did, diff);
                  this.noteAcFanCommanded(rule, activeSlot, did, diff);
                }
                this.automationState.set(rule.id, { status: "triggered", lastToggle: now, conditionSince: null, conditionLostAt: null, canAutoTurnOn: false });
                adopted = true;
              }
            }
          } catch (err) {
            log.error(`[collector] AC range "${rule.name}" adopt-check failed for ${did}:`, (err as Error).message);
          }
        }
        // The adoption above already persisted "triggered" — writing the stale local
        // state here would clobber it back to idle (the dead-zone clobber bug).
        if (!adopted) this.automationState.set(rule.id, { ...state, conditionSince: null });
      } else {
        state.conditionSince = null;
        this.automationState.set(rule.id, state);
      }
    } else {
      if (shouldTurnOff) {
        log.info(`[collector] AC range "${rule.name}": ${rule.metric}=${value}, turning OFF [${deviceNames}]`);
        try {
          // Temperature-cycling off: remember each AC's stable level so the next
          // turn-on warm-restores straight to it instead of slow re-climbing.
          for (const did of deviceIds) await this.acLeveler.rememberStableLevel(did);
          await this.executeAutomationAction(rule, { power: 0 } as AcAction, deviceIds);
          // The automation owns the OFF now — a leveler shed must not restore it
          for (const did of deviceIds) {
            await this.acLeveler.clearShed(did, "range_turn_off");
            this.clearAcFanEnforcement(rule.id, did);
            this.clearAcSwingOverride(rule.id, did);
            this.acRangeOffAt.set(did, now);
            this.devicePowerCache.set(did, { power: "off", ts: Date.now() });
          }
        } catch (err) {
          log.error(`[collector] AC range "${rule.name}" turn-off failed:`, (err as Error).message);
        }
        this.automationState.set(rule.id, { status: "idle", lastToggle: now, conditionSince: null, conditionLostAt: null, canAutoTurnOn: true });
      } else if (now - state.lastToggle >= cooldownMs) {
        for (const did of deviceIds) {
          try {
            const power = await this.getDevicePowerCached(did, "ac");
            if (power === "off" || power === undefined) {
              if (this.acLeveler.isShed(did)) continue; // leveler shed it — not a manual off
              // A fetch gap is not an observation — never lock on undefined.
              if (power === undefined) continue;
              // Our own recent off still propagating is not an external off.
              if (now - (this.acRangeOffAt.get(did) ?? 0) < this.AC_OFF_REFIRE_GRACE_MS) continue;
              this.clearAcFanEnforcement(rule.id, did); // power cycle — fan intent resets
              this.clearAcSwingOverride(rule.id, did);  // and swing intent resets
              if (await this.handleObservedAcOff(`AC range "${rule.name}"`, did, deviceNames)) {
                // Power-event off (blackout/changeover/brownout): bring it back
                // with the full active profile — the restart reset the device.
                const fan = this.resolveRangeFan(rule, activeSlot, did, value);
                const slotGen = activeSlot.gen_level != null ? this.clampSlotGenLevel(did, activeSlot.gen_level) : null;
                const slotSwing = activeSlot.vertical_swing != null ? activeSlot.vertical_swing : null;
                const onAction = {
                  ...(rule.action_on as AcAction),
                  ...(fan != null ? { fan_speed: fan } : {}),
                  ...(slotGen != null ? { generator_mode: slotGen } : {}),
                  ...(slotSwing != null ? { vertical_swing: slotSwing } : {}),
                };
                log.info(`[collector] AC range "${rule.name}": re-turning ON ${did} after power-event off`);
                await this.executeAutomationAction(rule, onAction, [did]);
                this.noteAcFanCommanded(rule, activeSlot, did, onAction as AcAction);
                this.automationState.set(rule.id, { status: "triggered", lastToggle: now, conditionSince: null, conditionLostAt: null, canAutoTurnOn: false });
                return;
              }
              this.automationState.set(rule.id, { status: "idle", lastToggle: now, conditionSince: null, conditionLostAt: null, canAutoTurnOn: false });
              return;
            }
            this.updateAcFanTracking(rule, activeSlot, did, value, now);
            const { power: _p, ...profileOnly } = this.effectiveAcRangeProfile(rule, activeSlot, did, value);
            const diff = this.tclCloud!.computeAcDiff(did, this.stripLeveledControls(rule, profileOnly, did));
            if (diff) {
              log.info(`[collector] AC range "${rule.name}": re-enforcing diff for ${did}: ${JSON.stringify(diff)}`);
              await this.tclCloud!.executeAcAction(did, diff);
              this.noteAcFanCommanded(rule, activeSlot, did, diff);
            }
          } catch (err) {
            log.error(`[collector] AC range "${rule.name}" re-enforce failed for ${did}:`, (err as Error).message);
          }
        }
        this.automationState.set(rule.id, { ...state, lastToggle: now });
      }
    }
  }

  private async turnOffAcOutsideRange(
    rule: AutomationRule,
    state: AutomationState,
    now: number,
    cooldownMs: number,
    deviceIds: string[],
    deviceNames: string,
  ): Promise<void> {
    if (now - state.lastToggle < cooldownMs) return;

    let sentOff = false;
    for (const did of deviceIds) {
      try {
        const power = await this.getDevicePowerCached(did, "ac");
        if (power !== "off" && now - (this.acRangeOffAt.get(did) ?? 0) >= this.AC_OFF_REFIRE_GRACE_MS) {
          log.info(`[collector] AC range "${rule.name}": no active range slot, turning OFF ${did} [${deviceNames}]`);
          await this.executeAutomationAction(rule, { power: 0 } as AcAction, [did]);
          this.acRangeOffAt.set(did, now);
          this.devicePowerCache.set(did, { power: "off", ts: Date.now() });
          sentOff = true;
        }
        // Outside the window the automation owns the OFF — drop any leveler shed
        await this.acLeveler.clearShed(did, "outside_range_off");
        this.clearAcFanEnforcement(rule.id, did);
        this.clearAcSwingOverride(rule.id, did);
      } catch (err) {
        log.error(`[collector] AC range "${rule.name}" outside-range off failed for ${did}:`, (err as Error).message);
      }
    }

    this.automationState.set(rule.id, {
      status: "idle",
      lastToggle: sentOff ? now : state.lastToggle,
      conditionSince: null,
      conditionLostAt: null,
      canAutoTurnOn: state.canAutoTurnOn,
    });
  }

  private async checkScheduleAutomation(rule: AutomationRule): Promise<void> {
    const startMinutes = rule.start_mode === "prayer" && rule.start_prayer
      ? this.resolvePrayerMinutes(rule.start_prayer, rule.start_prayer_offset ?? 0)
      : rule.time_start ? parseTimeToMinutes(rule.time_start) : null;

    const endMinutes = rule.end_mode === "prayer" && rule.end_prayer
      ? this.resolvePrayerMinutes(rule.end_prayer, rule.end_prayer_offset ?? 0)
      : rule.time_end ? parseTimeToMinutes(rule.time_end) : null;

    if (startMinutes == null || endMinutes == null) return;

    const baghdadNow = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Baghdad" }));
    const nowMinutes = baghdadNow.getHours() * 60 + baghdadNow.getMinutes();

    // Handle overnight ranges (e.g., 22:00 → 07:00)
    const inWindow = startMinutes <= endMinutes
      ? (nowMinutes >= startMinutes && nowMinutes < endMinutes)
      : (nowMinutes >= startMinutes || nowMinutes < endMinutes);

    const state = this.automationState.get(rule.id) ?? { status: "idle", lastToggle: 0, conditionSince: null, conditionLostAt: null, canAutoTurnOn: true };
    const now = Date.now();
    const cooldownMs = (rule.cooldown_secs ?? 60) * 1000;

    if (inWindow) {
      if (now - state.lastToggle < cooldownMs) return;

      const deviceIds = rule.device_ids ?? [rule.device_id];
      const deviceNames = (rule.device_names ?? [rule.device_name]).join(", ");

      for (const did of deviceIds) {
        try {
          const locked = rule.device_type === "ac" && await this.isAcManualOffLocked(did);
          const power = await this.getDevicePowerCached(did, rule.device_type, locked);
          if (power === "off" || power === undefined) {
            if (rule.device_type === "ac" && this.acLeveler.isShed(did)) continue; // leveler shed it
            if (rule.device_type === "ac" && state.status === "triggered") {
              // A fetch gap is not an observation — never lock on undefined.
              if (power === undefined) continue;
              if (!(await this.handleObservedAcOff(`Schedule "${rule.name}"`, did, deviceNames))) {
                this.automationState.set(rule.id, { status: "idle", lastToggle: now, conditionSince: null, conditionLostAt: null, canAutoTurnOn: false });
                continue;
              }
              // Power-event off → fall through to the turn-on below.
            }
            if (locked && await this.isAcManualOffLocked(did)) {
              log.info(`[collector] Schedule "${rule.name}": device ${did} is manual-off locked, skipping auto-on`);
              continue;
            }
            log.info(
              `[collector] Schedule "${rule.name}": device ${did} is OFF during active window, turning ON [${deviceNames}]`,
            );
            await this.executeAutomationAction(rule, rule.action_on, [did]);
            this.devicePowerCache.set(did, { power: "on", ts: Date.now() });
            this.automationState.set(rule.id, { status: "triggered", lastToggle: now, conditionSince: null, conditionLostAt: null, canAutoTurnOn: true });
          }
        } catch (err) {
          log.error(`[collector] Schedule "${rule.name}" check failed for ${did}:`, (err as Error).message);
        }
      }
    } else {
      // Outside window: optionally turn off, then reset state to idle
      if (state.status === "triggered") {
        if (rule.turn_off_at_end) {
          const deviceIds = rule.device_ids ?? [rule.device_id];
          const deviceNames = (rule.device_names ?? [rule.device_name]).join(", ");
          log.info(`[collector] Schedule "${rule.name}": window ended, turning OFF [${deviceNames}]`);
          const offAction = rule.device_type === "ac" ? { power: 0 as const } : { power: "off" as const };
          for (const did of deviceIds) {
            try {
              await this.executeAutomationAction(rule, rule.action_off ?? offAction, [did]);
              if (rule.device_type === "ac") await this.acLeveler.clearShed(did, "schedule_turn_off");
            } catch (err) {
              log.error(`[collector] Schedule "${rule.name}" turn-off failed for ${did}:`, (err as Error).message);
            }
          }
        }
        this.automationState.set(rule.id, { status: "idle", lastToggle: now, conditionSince: null, conditionLostAt: null, canAutoTurnOn: true });
      }
    }
  }

  private async checkAcTimers(): Promise<void> {
    if (!this.tclCloud || !this.tclCloud.isReady()) return;
    // Timers stay pending during a calibration run and fire (late) after it.
    if (this.acCalibrator.isActive()) return;
    const now = Date.now();
    for (const [deviceId, timer] of acTimers) {
      if (now < timer.fireAt) continue;
      acTimers.delete(deviceId);
      try {
        if (timer.action === "off") {
          await this.tclCloud.executeAcAction(deviceId, { power: 0 });
          await this.recordAcManualOff(deviceId, "timer_off");
          await this.acLeveler.clearShed(deviceId, "timer_off");
          log.info(`[collector] AC timer: turned OFF device ${deviceId}`);
        } else {
          if (this.acLeveler.isShed(deviceId)) {
            log.info(`[collector] AC timer: device ${deviceId} is shed by the leveler, skipping turn-on timer`);
            continue;
          }
          if (await this.isAcManualOffLocked(deviceId)) {
            await this.getDevicePowerCached(deviceId, "ac", true);
            if (await this.isAcManualOffLocked(deviceId)) {
              log.info(`[collector] AC timer: device ${deviceId} is manual-off locked, skipping turn-on timer`);
              continue;
            }
          }
          const preset = timer.preset ?? {};
          const action: AcAction = {
            power: 1,
            ...(preset.mode != null ? { mode: preset.mode as number } : {}),
            ...(preset.temperature != null ? { temperature: preset.temperature as number } : {}),
            ...(preset.fan_speed != null ? { fan_speed: preset.fan_speed as number } : {}),
            ...(preset.eco != null ? { eco: preset.eco as number } : {}),
            ...(preset.turbo != null ? { turbo: preset.turbo as number } : {}),
            ...(preset.screen != null ? { screen: preset.screen as number } : {}),
            ...(preset.vertical_swing != null ? { vertical_swing: preset.vertical_swing as number } : {}),
            ...(preset.horizontal_swing != null ? { horizontal_swing: preset.horizontal_swing as number } : {}),
            ...(preset.fresh_air != null ? { fresh_air: preset.fresh_air as number } : {}),
            // The leveler owns the generator level for managed devices
            ...(preset.generator_mode != null && !this.isAcLevelingManaged(deviceId)
              ? { generator_mode: preset.generator_mode as number }
              : {}),
          };
          await this.tclCloud.executeAcAction(deviceId, action);
          log.info(`[collector] AC timer: turned ON device ${deviceId} with preset`);
        }
      } catch (err) {
        log.error(`[collector] AC timer failed for ${deviceId}:`, (err as Error).message);
      }
    }
  }

  // ---------- Smart AC Leveling ----------

  /** True when the leveler controls this device's generator level. */
  private isAcLevelingManaged(deviceId: string): boolean {
    return this.acLeveler.isEnabled() && !this.acRuleOptsOutOfLeveling(deviceId);
  }

  /** An enabled AC automation with smart_leveling=false opts its devices out. */
  private acRuleOptsOutOfLeveling(deviceId: string): boolean {
    return this.automationRules.some(
      (r) =>
        r.device_type === "ac" &&
        r.smart_leveling === false &&
        (r.device_ids ?? [r.device_id]).includes(deviceId),
    );
  }

  /** Removes generator_mode from rule actions when the leveler owns the level. */
  private stripGenIfLeveled<T extends PurifierAction | AcAction>(rule: AutomationRule, action: T): T {
    if (rule.device_type !== "ac" || rule.smart_leveling === false || !this.acLeveler.isEnabled()) {
      return action;
    }
    const acAction = action as AcAction;
    if (acAction.generator_mode == null) return action;
    const { generator_mode: _g, ...rest } = acAction;
    return rest as T;
  }

  /**
   * Per-device strip of leveler-owned controls: generator_mode when leveled,
   * plus fan_speed AND turbo while a leveler fan hold is active (non-Najat
   * fan 7 == turbo — re-arming turbo would clobber the held fan).
   */
  private stripLeveledControls<T extends PurifierAction | AcAction>(rule: AutomationRule, action: T, deviceId: string): T {
    let stripped = this.stripGenIfLeveled(rule, action);
    // Manual gen change wins over range re-enforcement. If generator_mode SURVIVED
    // stripGenIfLeveled, the leveler isn't managing this device's level (leveling
    // off or the rule opted out) — so a recent manual change must drop it, or the
    // active slot's cap re-sends every ~5s and slams the user's manual level back
    // (live 2026-06-21: "leveling off but Abdu still drops to L1").
    if (
      rule.device_type === "ac" &&
      (stripped as AcAction).generator_mode != null &&
      this.hasRecentUserGenChange(deviceId)
    ) {
      const { generator_mode: _g, ...rest } = stripped as AcAction;
      stripped = rest as T;
    }
    if (rule.device_type !== "ac" || !this.acLeveler.hasFanHold(deviceId)) return stripped;
    const { fan_speed: _f, turbo: _t, ...rest } = stripped as AcAction;
    return rest as T;
  }

  /**
   * Need for the leveler: ACs with an active range automation use the same
   * room metric vs the active slot; others use the AC's internal sensor vs the
   * comfort target (heat mode inverts the comparison). The delta (°C past the
   * satisfied point) orders raises and shed selection. The active slot's
   * gen_level rides along as the leveler's hard cap for this device.
   */
  private computeAcNeed(deviceId: string, device: AcDevice): { tier: NeedTier; delta: number; slotGenCap: number | null } {
    for (const rule of this.automationRules) {
      if (rule.device_type !== "ac" || rule.automation_type !== "metric" || rule.threshold_low == null) continue;
      if (!(rule.device_ids ?? [rule.device_id]).includes(deviceId)) continue;
      if (!rule.metric) continue;
      const slot = findActiveRangeSlot(
        rule.range_slots ?? getLegacyRangeSlots(rule.threshold_low, rule.threshold),
        getBaghdadMinutes(),
        (prayer, offset) => this.resolvePrayerMinutes(prayer, offset),
      );
      if (!slot) continue;
      const value = getMetricValue(rule.metric, this.latestWeatherRow, this.latestAirRow, this.latestPowerRow);
      if (value == null) continue;
      const isCool = (rule.action_on as Record<string, unknown>).mode === 1;
      const slotGenCap = slot.gen_level ?? null;
      if (isCool) {
        return {
          tier: computeNeedTier({ kind: "range", value, slotLow: slot.threshold_low, slotHigh: slot.threshold }),
          delta: value - slot.threshold_low,
          slotGenCap,
        };
      }
      // Heat: need grows as the value drops below the low limit — negate to reuse the cool mapping
      return {
        tier: computeNeedTier({ kind: "range", value: -value, slotLow: -slot.threshold, slotHigh: -slot.threshold_low }),
        delta: slot.threshold - value,
        slotGenCap,
      };
    }
    if (!device.currentTemp || device.currentTemp <= 0) return { tier: "mild", delta: 1, slotGenCap: null };
    const target = this.acLeveler.getComfortTarget();
    if (device.mode === 4) {
      // Heat mode: deviation is how far the room is below the comfort target
      return {
        tier: computeNeedTier({ kind: "comfort", currentTemp: 2 * target - device.currentTemp, target }),
        delta: target - device.currentTemp,
        slotGenCap: null,
      };
    }
    return {
      tier: computeNeedTier({ kind: "comfort", currentTemp: device.currentTemp, target }),
      delta: device.currentTemp - target,
      slotGenCap: null,
    };
  }

  /** In-flight leveling check — urgent and loop ticks share one mutual-exclusion point. */
  private levelingCheckPromise: Promise<void> | null = null;
  /** A request arrived mid-check — run one more pass when the current one finishes. */
  private levelingCheckQueued = false;

  /**
   * Serialized wrapper around checkAcLeveling(): the loop tick and the
   * urgent-trigger path (AcLeveler.onUrgentLevelingNeeded, fired per ESP
   * reading during an emergency) both land here, so two passes can never
   * interleave their awaits and double-send commands. A request that arrives
   * mid-pass coalesces into exactly one follow-up pass, and every caller's
   * await resolves only once that follow-up has run too.
   */
  private runLevelingCheck(): Promise<void> {
    if (this.levelingCheckPromise) {
      this.levelingCheckQueued = true;
      return this.levelingCheckPromise;
    }
    this.levelingCheckPromise = (async () => {
      try {
        do {
          this.levelingCheckQueued = false;
          // Deadline: a hung TCL call in a pass must not wedge the in-flight
          // promise — every later urgent (emergency) tick coalesces into it,
          // so a wedged pass means NO trip protection at all (the 2026-07-06
          // stall ran the gen unprotected for hours). An abandoned pass that
          // un-sticks later can at worst send one stale, settle-guarded batch.
          const pass = this.checkAcLeveling();
          pass.catch(() => { /* late failure of an abandoned pass — logged by the thrower */ });
          let timer: NodeJS.Timeout | undefined;
          try {
            await Promise.race([
              pass,
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error("leveling pass exceeded 60s — abandoned")), 60_000);
              }),
            ]);
          } finally {
            clearTimeout(timer);
          }
        } while (this.levelingCheckQueued);
      } finally {
        this.levelingCheckPromise = null;
      }
    })();
    return this.levelingCheckPromise;
  }

  private async checkAcLeveling(): Promise<void> {
    await this.acLeveler.ensureLoaded();
    if (!this.acLeveler.isEnabled()) return;
    if (!this.tclCloud || !this.tclCloud.isReady()) return;
    // Calibration drives the ACs single-handedly — don't fight its sweeps.
    if (this.acCalibrator.isActive()) return;

    // Keep device state reasonably fresh without hammering TCL: at most one
    // live fetch per 10s (automations refresh the shared cache most ticks too).
    let devices = this.tclCloud.getDevices();
    if (devices.length === 0 || Date.now() - this.lastLevelerDevicesFetch > 10_000) {
      try {
        devices = await this.tclCloud.fetchDevicesLive();
        this.lastLevelerDevicesFetch = Date.now();
      } catch (err) {
        log.warn(`[collector] Leveler device refresh failed, using cache: ${(err as Error).message}`);
      }
    }
    if (devices.length === 0) return;

    // Outdoor temp for the conditional min-level boosts (≤10 min old)
    const weatherFresh = this.latestWeatherTs != null && Date.now() - this.latestWeatherTs.getTime() < 600_000;
    const outdoorRaw = this.latestWeatherRow?.temp_c;
    const outdoorTempC = weatherFresh && typeof outdoorRaw === "number" ? outdoorRaw : null;

    const ctx: LevelerDeviceContext[] = devices.map((device) => {
      const need = this.computeAcNeed(device.id, device);
      return {
        device,
        managed: !this.acRuleOptsOutOfLeveling(device.id),
        needTier: need.tier,
        needDelta: need.delta,
        slotGenCap: need.slotGenCap,
      };
    });
    await this.acLeveler.tick(ctx, outdoorTempC);
  }

  // ---------- Ambient Weather ----------

  private async collectAmbientWeather(): Promise<void> {
    const url = new URL("https://rt.ambientweather.net/v1/devices");
    url.searchParams.set("apiKey", this.config.awApiKey);
    url.searchParams.set("applicationKey", this.config.awAppKey);

    const resp = await fetch(url.toString(), {
      signal: AbortSignal.timeout(30_000),
    });
    if (!resp.ok) {
      throw new Error(`AW API ${resp.status}: ${await resp.text()}`);
    }
    const devices: AWData[] = await resp.json() as AWData[];
    if (!devices.length) {
      log.warn("[collector] No devices from Ambient Weather");
      return;
    }
    const data = devices[0].lastData as AWData;
    const row = this.convertAW(data);
    await this.storeWeather(row);
    this.latestWeatherRow = row as unknown as Record<string, unknown>;
    this.latestWeatherTs = row.ts;
    log.info(`[collector] Stored weather reading at ${row.ts.toISOString()}`);
  }

  private convertAW(d: AWData): WeatherRow {
    const f2c = (f: number | undefined | null): number | null =>
      f != null ? Math.round(((f - 32) * 5) / 9 * 10) / 10 : null;
    const mph2kmh = (v: number | undefined | null): number | null =>
      v != null ? Math.round(v * 1.60934 * 10) / 10 : null;
    const in2mm = (v: number | undefined | null): number | null =>
      v != null ? Math.round(v * 25.4 * 100) / 100 : null;
    const inhg2hpa = (v: number | undefined | null): number | null =>
      v != null ? Math.round(v * 33.8639 * 10) / 10 : null;

    const ts = new Date(d.dateutc as number);

    let lastRain: Date | null = null;
    if (d.lastRain) {
      try {
        const parsed = new Date(String(d.lastRain));
        if (!isNaN(parsed.getTime())) {
          lastRain = parsed;
        }
      } catch {
        // ignore parse errors
      }
    }

    return {
      ts,
      temp_c: f2c(d.tempf),
      humidity: d.humidity ?? null,
      wind_speed_kmh: mph2kmh(d.windspeedmph),
      wind_gust_kmh: mph2kmh(d.windgustmph),
      max_daily_gust_kmh: null,
      wind_dir: d.winddir ?? null,
      wind_dir_avg10m: d.winddir_avg10m ?? null,
      pressure_rel_hpa: inhg2hpa(d.baromrelin),
      pressure_abs_hpa: inhg2hpa(d.baromabsin),
      rain_hourly_mm: in2mm(d.hourlyrainin),
      rain_event_mm: in2mm(d.eventrainin),
      rain_daily_mm: in2mm(d.dailyrainin),
      rain_weekly_mm: in2mm(d.weeklyrainin),
      rain_monthly_mm: in2mm(d.monthlyrainin),
      rain_yearly_mm: in2mm(d.yearlyrainin),
      solar_radiation: d.solarradiation ?? null,
      uv_index: d.uv ?? null,
      temp_indoor_c: f2c(d.tempinf),
      humidity_indoor: d.humidityin ?? null,
      feels_like_c: f2c(d.feelsLike),
      dew_point_c: f2c(d.dewPoint),
      temp_ch8_c: f2c(d.temp8f),
      humidity_ch8: d.humidity8 ?? null,
      feels_like_indoor_c: f2c(d.feelsLikein),
      dew_point_indoor_c: f2c(d.dewPointin),
      feels_like_ch8_c: f2c(d.feelsLike8),
      dew_point_ch8_c: f2c(d.dewPoint8),
      batt_outdoor: d.battout ?? null,
      batt_indoor: d.battin ?? null,
      batt_ch8: d.batt8 ?? null,
      last_rain: lastRain,
    };
  }

  private async storeWeather(row: WeatherRow): Promise<void> {
    await this.pool.query(
      `INSERT INTO weather_readings (
        ts, temp_c, humidity, wind_speed_kmh, wind_gust_kmh,
        max_daily_gust_kmh, wind_dir, wind_dir_avg10m,
        pressure_rel_hpa, pressure_abs_hpa,
        rain_hourly_mm, rain_event_mm, rain_daily_mm,
        rain_weekly_mm, rain_monthly_mm, rain_yearly_mm,
        solar_radiation, uv_index, temp_indoor_c, humidity_indoor,
        feels_like_c, dew_point_c, temp_ch8_c, humidity_ch8,
        feels_like_indoor_c, dew_point_indoor_c,
        feels_like_ch8_c, dew_point_ch8_c,
        batt_outdoor, batt_indoor, batt_ch8, last_rain
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
        $14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,
        $25,$26,$27,$28,$29,$30,$31,$32
      ) ON CONFLICT (ts) DO NOTHING`,
      [
        row.ts, row.temp_c, row.humidity, row.wind_speed_kmh, row.wind_gust_kmh,
        row.max_daily_gust_kmh, row.wind_dir, row.wind_dir_avg10m,
        row.pressure_rel_hpa, row.pressure_abs_hpa,
        row.rain_hourly_mm, row.rain_event_mm, row.rain_daily_mm,
        row.rain_weekly_mm, row.rain_monthly_mm, row.rain_yearly_mm,
        row.solar_radiation, row.uv_index, row.temp_indoor_c, row.humidity_indoor,
        row.feels_like_c, row.dew_point_c, row.temp_ch8_c, row.humidity_ch8,
        row.feels_like_indoor_c, row.dew_point_indoor_c,
        row.feels_like_ch8_c, row.dew_point_ch8_c,
        row.batt_outdoor, row.batt_indoor, row.batt_ch8, row.last_rain,
      ]
    );
  }

  private async backfillAmbientHistory(): Promise<void> {
    const mac = "C8:C9:A3:0E:CB:CB";
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

    // Check how far back we already have data
    const oldest = await this.pool.query(
      "SELECT ts FROM weather_readings ORDER BY ts ASC LIMIT 1"
    );
    const oldestTs = oldest.rows[0]?.ts as Date | undefined;
    if (oldestTs && oldestTs.getTime() <= thirtyDaysAgo) {
      // Already have 30+ days — just fetch the latest batch to fill gap since last shutdown
      log.info("[collector] Weather data already spans 30+ days, fetching latest batch only");
      await this.fetchAWBatch(mac);
      return;
    }

    // Paginate backwards to fill 30 days
    let endDate: number | undefined;
    let totalCount = 0;
    const maxIterations = 35;

    try {
      for (let i = 0; i < maxIterations; i++) {
        const count = await this.fetchAWBatch(mac, endDate);
        totalCount += count;

        if (count < 288) {
          log.info(`[collector] AW backfill: got ${count} < 288 records, no more data`);
          break;
        }

        // Find the oldest record we just fetched to use as endDate for next page
        const oldestFetched = await this.pool.query(
          `SELECT ts FROM weather_readings ORDER BY ts ASC LIMIT 1`
        );
        const ts = oldestFetched.rows[0]?.ts as Date | undefined;
        if (!ts || ts.getTime() <= thirtyDaysAgo) {
          break;
        }
        endDate = ts.getTime();

        // Respect rate limit: 1 req/sec
        await sleep(1100);
      }
      log.info(`[collector] Backfilled ${totalCount} weather records total`);
    } catch (err) {
      log.error(`[collector] AW backfill stopped after ${totalCount} records:`, err);
    }
  }

  private async fetchAWBatch(mac: string, endDate?: number): Promise<number> {
    const url = new URL(`https://rt.ambientweather.net/v1/devices/${mac}`);
    url.searchParams.set("apiKey", this.config.awApiKey);
    url.searchParams.set("applicationKey", this.config.awAppKey);
    url.searchParams.set("limit", "288");
    if (endDate !== undefined) {
      url.searchParams.set("endDate", String(endDate));
    }

    const resp = await fetch(url.toString(), {
      signal: AbortSignal.timeout(60_000),
    });
    if (!resp.ok) {
      throw new Error(`AW backfill API ${resp.status}: ${await resp.text()}`);
    }
    const records: AWData[] = await resp.json() as AWData[];
    if (records.length > 0) {
      await this.storeWeatherBatch(records.map(r => this.convertAW(r)));
    }
    if (records.length > 0) {
      log.info(`[collector] AW backfill page: ${records.length} records`);
    }
    return records.length;
  }

  private toAirRow(ts: Date, d: QpSensorFields): AirRow {
    return {
      ts,
      temperature: d.temperature?.value ?? null,
      humidity: d.humidity?.value ?? null,
      co2: d.co2?.value ?? null,
      pm25: d.pm25?.value ?? null,
      pm10: d.pm10?.value ?? null,
      tvoc: d.tvoc_index?.value ?? null,
      noise: d.noise?.value ?? null,
      battery: d.battery?.value ?? null,
    };
  }

  private async backfillQingpingHistory(): Promise<void> {
    const mac = this.config.mqttQingpingMac;
    const thirtyDaysAgo = Math.floor((Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000);

    // Check how far back we already have data
    const oldest = await this.pool.query(
      "SELECT ts FROM air_readings ORDER BY ts ASC LIMIT 1"
    );
    const oldestTs = oldest.rows[0]?.ts as Date | undefined;
    if (oldestTs && oldestTs.getTime() / 1000 <= thirtyDaysAgo) {
      log.info("[collector] Air data already spans 30+ days, skipping backfill");
      return;
    }

    try {
      await this.ensureQpToken();
      const endTime = oldestTs
        ? Math.floor(oldestTs.getTime() / 1000)
        : Math.floor(Date.now() / 1000);

      let totalCount = 0;
      let offset = 0;
      const limit = 200;

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const tsNow = Math.floor(Date.now() * 1000); // milliseconds for timestamp param
        const url = `https://apis.cleargrass.com/v1/apis/devices/data?mac=${mac}&start_time=${thirtyDaysAgo}&end_time=${endTime}&timestamp=${tsNow}&limit=${limit}&offset=${offset}`;

        const resp = await fetch(url, {
          headers: { Authorization: `Bearer ${this.qpToken}` },
          signal: AbortSignal.timeout(60_000),
        });
        if (!resp.ok) {
          throw new Error(`QP history API ${resp.status}: ${await resp.text()}`);
        }

        interface QpHistoryItem extends QpSensorFields {
          timestamp: { value: number };
        }
        interface QpHistoryResponse {
          total?: number;
          data?: QpHistoryItem[];
        }

        const body = (await resp.json()) as QpHistoryResponse;
        const items = body.data ?? [];
        if (items.length === 0) break;

        await this.storeAirBatch(items.map(d => this.toAirRow(new Date(d.timestamp.value * 1000), d)));

        totalCount += items.length;
        offset += items.length;
        log.info(`[collector] QP backfill page: ${items.length} records (total: ${totalCount})`);

        const total = body.total ?? 0;
        if (offset >= total) break;

        await sleep(500);
      }
      log.info(`[collector] Backfilled ${totalCount} air records total`);
    } catch (err) {
      log.error("[collector] QP backfill failed:", err);
    }
  }

  // ---------- MQTT (Qingping direct) ----------

  private startMqtt(): void {
    if (!this.config.mqttUsername) {
      log.info("[collector] MQTT not configured, skipping");
      return;
    }

    const mac = this.config.mqttQingpingMac;
    const topic = `qingping/${mac}/up`;

    this.mqttClient = mqtt.connect(this.config.mqttBrokerUrl, {
      username: this.config.mqttUsername,
      password: this.config.mqttPassword,
      clientId: `home-dashboard-${Date.now()}`,
      clean: true,
      reconnectPeriod: 5000,
      connectTimeout: 30000,
    });

    this.mqttClient.on("connect", () => {
      log.info("[collector] MQTT connected to broker");
      this.mqttClient!.subscribe(topic, { qos: 1 }, (err) => {
        if (err) {
          log.error("[collector] MQTT subscribe error:", err);
        } else {
          log.info(`[collector] MQTT subscribed to ${topic}`);
          this.sendIntervalConfig();
        }
      });
    });

    this.mqttClient.on("message", (_topic: string, payload: Buffer) => {
      this.handleMqttMessage(payload).catch((err) => {
        log.error("[collector] MQTT message handling error:", err);
      });
    });

    this.mqttClient.on("error", (err) => {
      log.error("[collector] MQTT error:", err);
    });

    this.mqttClient.on("reconnect", () => {
      log.info("[collector] MQTT reconnecting...");
    });
  }

  private async handleMqttMessage(payload: Buffer): Promise<void> {
    const raw = payload.toString("utf-8");

    interface QpMqttPayload {
      type?: string;
      sensorData?: QpSensorFields[];
    }

    let msg: QpMqttPayload;
    try {
      msg = JSON.parse(raw) as QpMqttPayload;
    } catch {
      log.warn("[collector] MQTT: non-JSON message, ignoring");
      return;
    }

    if (msg.type === QP_MSG_SETTINGS_ACK) {
      log.info("[collector] MQTT: received settings ack");
      return;
    }

    const sensors = msg.sensorData?.[0];
    if (!sensors) {
      log.warn("[collector] MQTT: no sensorData in message");
      return;
    }

    const row = this.toAirRow(new Date(), sensors);
    const live = row as unknown as Record<string, unknown>;
    // battery.status: 1 = charging (USB plugged), 0 = discharging
    live.batteryCharging = sensors.battery?.status === 1;
    this.latestAirRow = live;
    this.latestAirTs = row.ts;
    this.lastMqttMessage = Date.now();
    this.airBuffer.push(row);

    // Persist median of buffered readings to DB every 60 seconds
    const now = Date.now();
    if (now - this.lastAirSave >= this.AIR_SAVE_INTERVAL && this.airBuffer.length > 0) {
      this.lastAirSave = now;
      await this.storeAirMedian();
    }
  }

  private sendIntervalConfig(): void {
    if (!this.mqttClient) return;

    const mac = this.config.mqttQingpingMac;
    const topic = `qingping/${mac}/down`;

    const cfg = {
      id: Date.now(),
      need_ack: 1,
      type: QP_MSG_INTERVAL_CONFIG,
      setting: {
        report_interval: 15,
        collect_interval: 15,
        co2_sampling_interval: 15,
        pm_sampling_interval: 15,
      },
    };

    this.mqttClient.publish(topic, JSON.stringify(cfg), { qos: 1 }, (err) => {
      if (err) {
        log.error("[collector] MQTT interval config publish failed:", err);
      } else {
        log.info("[collector] MQTT interval config sent (15s intervals)");
      }
    });
  }

  // ---------- Qingping (cloud fallback) ----------

  private async ensureQpToken(): Promise<void> {
    if (this.qpToken && Date.now() / 1000 < this.qpTokenExpires - 300) {
      return;
    }
    const auth = Buffer.from(
      `${this.config.qpAppKey}:${this.config.qpAppSecret}`
    ).toString("base64");

    const resp = await fetch("https://oauth.cleargrass.com/oauth2/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials&scope=device_full_access",
      signal: AbortSignal.timeout(30_000),
    });
    if (!resp.ok) {
      throw new Error(`QP token ${resp.status}: ${await resp.text()}`);
    }
    const body = (await resp.json()) as {
      access_token: string;
      expires_in?: number;
    };
    this.qpToken = body.access_token;
    const expiresIn = body.expires_in ?? 7200;
    this.qpTokenExpires = Date.now() / 1000 + expiresIn;
    log.info(`[collector] Qingping token refreshed, expires in ${expiresIn}s`);
  }

  private async collectQingping(): Promise<void> {
    await this.ensureQpToken();
    const tsNow = Math.floor(Date.now() / 1000);
    const resp = await fetch(
      `https://apis.cleargrass.com/v1/apis/devices?timestamp=${tsNow}`,
      {
        headers: { Authorization: `Bearer ${this.qpToken}` },
        signal: AbortSignal.timeout(30_000),
      }
    );
    if (!resp.ok) {
      throw new Error(`QP API ${resp.status}: ${await resp.text()}`);
    }

    interface QpDevice {
      data: QpSensorFields & { timestamp: { value: number } };
    }
    interface QpResponse {
      devices?: QpDevice[];
    }

    const body = (await resp.json()) as QpResponse;
    if (!body.devices?.length) {
      log.warn("[collector] No devices from Qingping");
      return;
    }
    const data = body.devices[0].data;
    const row = this.toAirRow(new Date(data.timestamp.value * 1000), data);
    await this.storeAir(row);
    const live = row as unknown as Record<string, unknown>;
    live.batteryCharging = data.battery?.status === 1;
    this.latestAirRow = live;
    this.latestAirTs = row.ts;
    log.info(`[collector] Stored air reading at ${row.ts.toISOString()}`);
  }

  private async storeAirMedian(): Promise<void> {
    const buf = this.airBuffer;
    this.airBuffer = [];

    const med = (fn: (r: AirRow) => number | null, round = false): number | null => {
      const vals = buf.map(fn).filter((v): v is number => v != null);
      if (vals.length === 0) return null;
      vals.sort((a, b) => a - b);
      const mid = Math.floor(vals.length / 2);
      const result = vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
      return round ? Math.round(result) : result;
    };

    const row: AirRow = {
      ts: new Date(),
      temperature: med(r => r.temperature),
      humidity: med(r => r.humidity, true),
      co2: med(r => r.co2, true),
      pm25: med(r => r.pm25, true),
      pm10: med(r => r.pm10, true),
      tvoc: med(r => r.tvoc, true),
      noise: med(r => r.noise, true),
      battery: med(r => r.battery, true),
    };

    await this.storeAir(row);
    log.info(`[collector] Air median saved (from ${buf.length} samples)`);
  }

  private async storeAir(row: AirRow): Promise<void> {
    await this.pool.query(
      `INSERT INTO air_readings (
        ts, temperature, humidity, co2, pm25, pm10,
        tvoc, noise, battery
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (ts) DO NOTHING`,
      [
        row.ts, row.temperature, row.humidity, row.co2, row.pm25, row.pm10,
        row.tvoc, row.noise, row.battery,
      ]
    );
  }

  private async storeAirBatch(rows: AirRow[]): Promise<void> {
    if (rows.length === 0) return;
    const COLS = 9;
    const placeholders: string[] = [];
    const values: unknown[] = [];
    for (let i = 0; i < rows.length; i++) {
      const off = i * COLS;
      placeholders.push(`($${off+1},$${off+2},$${off+3},$${off+4},$${off+5},$${off+6},$${off+7},$${off+8},$${off+9})`);
      const r = rows[i];
      values.push(r.ts, r.temperature, r.humidity, r.co2, r.pm25, r.pm10, r.tvoc, r.noise, r.battery);
    }
    await this.pool.query(
      `INSERT INTO air_readings (ts, temperature, humidity, co2, pm25, pm10, tvoc, noise, battery)
       VALUES ${placeholders.join(",")} ON CONFLICT (ts) DO NOTHING`,
      values
    );
  }

  private async storeWeatherBatch(rows: WeatherRow[]): Promise<void> {
    if (rows.length === 0) return;
    const COLS = 32;
    const placeholders: string[] = [];
    const values: unknown[] = [];
    for (let i = 0; i < rows.length; i++) {
      const off = i * COLS;
      const nums = Array.from({ length: COLS }, (_, j) => `$${off + j + 1}`).join(",");
      placeholders.push(`(${nums})`);
      const r = rows[i];
      values.push(
        r.ts, r.temp_c, r.humidity, r.wind_speed_kmh, r.wind_gust_kmh,
        r.max_daily_gust_kmh, r.wind_dir, r.wind_dir_avg10m,
        r.pressure_rel_hpa, r.pressure_abs_hpa,
        r.rain_hourly_mm, r.rain_event_mm, r.rain_daily_mm,
        r.rain_weekly_mm, r.rain_monthly_mm, r.rain_yearly_mm,
        r.solar_radiation, r.uv_index, r.temp_indoor_c, r.humidity_indoor,
        r.feels_like_c, r.dew_point_c, r.temp_ch8_c, r.humidity_ch8,
        r.feels_like_indoor_c, r.dew_point_indoor_c,
        r.feels_like_ch8_c, r.dew_point_ch8_c,
        r.batt_outdoor, r.batt_indoor, r.batt_ch8, r.last_rain,
      );
    }
    await this.pool.query(
      `INSERT INTO weather_readings (
        ts, temp_c, humidity, wind_speed_kmh, wind_gust_kmh,
        max_daily_gust_kmh, wind_dir, wind_dir_avg10m,
        pressure_rel_hpa, pressure_abs_hpa,
        rain_hourly_mm, rain_event_mm, rain_daily_mm,
        rain_weekly_mm, rain_monthly_mm, rain_yearly_mm,
        solar_radiation, uv_index, temp_indoor_c, humidity_indoor,
        feels_like_c, dew_point_c, temp_ch8_c, humidity_ch8,
        feels_like_indoor_c, dew_point_indoor_c,
        feels_like_ch8_c, dew_point_ch8_c,
        batt_outdoor, batt_indoor, batt_ch8, last_rain
      ) VALUES ${placeholders.join(",")} ON CONFLICT (ts) DO NOTHING`,
      values
    );
  }
}
