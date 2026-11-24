import pg from "pg";
import webpush from "web-push";
import mqtt from "mqtt";
import { getBaghdadPrayerTimes, baghdadMinuteOfDay, baghdadDateKey, prayerInstant } from "./prayer.js";
import type { PrayerTimesResult } from "./prayer-engine/index.js";
import type { Config } from "./config.js";
import { getMetricValue, powerConditionSustained, ALERT_METRICS, VALID_PRAYER_NAMES, PRAYER_LABELS, type PowerReadingEntry } from "./alert-metrics.js";
import { XiaomiCloud, type PurifierAction } from "./xiaomi-cloud.js";
import {
  TclCloud,
  isolatedPowerOffAfter,
  isPowerAcceptedError,
  OFF_WHEN_ONLINE_MAX_ATTEMPTS,
  OFF_WHEN_ONLINE_RESEND_MS,
  type AcAction,
  type AcDevice,
  type OffWhenOnlineArm,
} from "./tcl-cloud.js";
import { acTimers } from "./routes.js";
import { AcLeveler } from "./ac-leveler.js";
import { LevelingControllerV2 } from "./leveling/controller.js";
// The v2 context is a SUPERSET of v1's (it carries `slotKey` too) and v1 accepts
// it structurally, so the one array the collector builds satisfies both.
import type { LevelerDeviceContext } from "./leveling/api.js";
import { powerEventRestartsAcs } from "./leveling/power-events.js";
import { AcCalibrator } from "./ac-calibration.js";
import { computeNeedTier, STALE_POWER_MS, type NeedTier } from "./ac-leveling.js";
import { computeAutoFanLevel } from "./ac-auto-fan.js";
import { childLogger } from "./logger.js";
import { RateGate } from "./rate-gate.js";
import { actorName, type AuthKind } from "./auth.js";
import { isAcLevelingEligible, isPowerCycleRestoreEligible } from "./ac-capabilities.js";
import {
  findActiveRangeSlot,
  getBaghdadMinutes,
  getLegacyRangeSlots,
  type AutomationRangeSlot,
} from "./automation-slots.js";

const log = childLogger("collector");
const WATCH_REFRESH_MS = 15_000;

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
/** Uplink "12": ONE real-time reading, sent the moment it is taken. Uplink "17" (same code as the
 *  downlink config) is a rolling HISTORY window, 50 samples newest first, re-sent every report
 *  (captured live 2026-11-23). Only "12" may drive the live reading: a history window is by
 *  definition late, and ordering it by the device clock is a trap (a clock jump after a deep
 *  reboot would freeze or rewind the live value). */
const QP_MSG_REALTIME = "12";
/** The CGS2 is configured to report every 15 s. A gap longer than this between two MQTT
 *  readings means it is not following that setting: it rebooted (a flat battery, 2026-11-23)
 *  or lost the setting and fell back to its factory 15-minute default. */
export const QP_SLOW_REPORT_GAP_MS = 60_000;
/** At most one interval re-send per this window, so a unit that ignores it is not spammed. */
export const QP_INTERVAL_RESEND_MIN_MS = 5 * 60_000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AWData = Record<string, any>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Minimum spacing between a leveling pass and a QUEUED follow-up. Below the ESP
 * cadence (~2.7–5s), so the follow-up always sees at least one fresh reading
 * but protection is never delayed by a whole cycle. See `runLevelingCheck`.
 */
const LEVELING_RERUN_MIN_MS = 2_500;

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
  /** A source/power cycle invalidated the old manual state; ignore the reboot
   * shadow until the active system fan has been observed or re-commanded. */
  initializationPending?: boolean;
}

interface AcSwingOverride {
  slotId: string;                 // range slot active when the user took manual swing control
}

const AC_PROFILE_TRACKED_FIELDS = [
  "mode",
  "temperature",
  "eco",
  "screen",
  "vertical_swing",
  "horizontal_swing",
  "fresh_air",
] as const;
type AcProfileTrackedField = typeof AC_PROFILE_TRACKED_FIELDS[number];
const AC_COMMAND_PROFILE_FIELD: Partial<Record<string, AcProfileTrackedField>> = {
  set_mode: "mode",
  set_temperature: "temperature",
  set_eco: "eco",
  set_screen: "screen",
  set_vertical_swing: "vertical_swing",
  set_horizontal_swing: "horizontal_swing",
  set_fresh_air: "fresh_air",
};

/** Per-field ownership for an active AC range profile. */
interface AcProfileEnforcement {
  slotId: string;
  desired: Partial<Record<AcProfileTrackedField, number>>;
  baseline: Partial<Record<AcProfileTrackedField, number>>;
  lastCommandAt: Partial<Record<AcProfileTrackedField, number>>;
  manual: Set<AcProfileTrackedField>;
}

/**
 * One off-when-online OFF publish (`Collector.noteOffWhenOnlineOffPublished`).
 * Per publish and append-only: no path replaces, rewrites or deletes another
 * publish's record (pruning drops records that can never count again, and past
 * `OFF_WHEN_ONLINE_RECORD_CAP` the oldest).
 * Two fields change, each with a single writer: `voided` (false to true), only
 * by the operation whose publish appended the record, when the cloud did not
 * accept that publish; and `reportAt` (null to the OFF's report), once, by the
 * classifier when an OFF first matches the record.
 */
interface OffWhenOnlineOffRecord {
  readonly id: number;
  readonly publishedAt: number;
  voided: boolean;
  /** The power report of the OFF matched to this publish (pinned), once seen. */
  reportAt: number | null;
}

/**
 * The most off-when-online publish records a device keeps. A pinned record
 * stays until a newer server ON, however many newer pins follow (an older OFF
 * can still be presented again by a fetch that answers late), so only this cap
 * bounds the list. An arm sends at most OFF_WHEN_ONLINE_MAX_ATTEMPTS (4)
 * accepted OFFs, so 64 holds sixteen full arms with no server ON between them,
 * far past real use (the owner arms by hand), while each observed OFF still
 * scans a short list. The oldest go first: they cover the oldest reports, the
 * least likely to be presented again.
 */
const OFF_WHEN_ONLINE_RECORD_CAP = 64;

/** A record that can still make an OFF ours: its own publish did not void it, and no server ON came after it. */
function offWhenOnlineOffCounts(record: OffWhenOnlineOffRecord, serverOnAt: number): boolean {
  return !record.voided && record.publishedAt >= serverOnAt;
}

/** The newest OFF report a counted record was matched to, or null. */
function newestOffWhenOnlinePin(records: readonly OffWhenOnlineOffRecord[]): number | null {
  let pinnedAt: number | null = null;
  for (const record of records) {
    if (record.reportAt != null && (pinnedAt == null || record.reportAt > pinnedAt)) pinnedAt = record.reportAt;
  }
  return pinnedAt;
}

/**
 * Is an observed OFF whose powerSwitch report is `reportAt` (null when the
 * snapshot cannot date it) one of our off-when-online OFFs? A pure function of
 * the device's publish records, the last server ON and the clock. A report is
 * pinned to, and classified by, only a record that counts
 * (`offWhenOnlineOffCounts`) and was published at or before it (AWS stamps
 * whole seconds): a record published after the report never matches it. An OFF
 * is ours when such a record is matched to it or to a later report, or is
 * unmatched and younger than `expiryMs`: an unmatched record expires first,
 * so an OFF first presented after that is not ours. `firstMatch` names the
 * unmatched records such an OFF matches for the first time; the caller pins
 * them to it. An OFF the snapshot cannot date is ours while a counted record
 * is matched or unexpired.
 */
function classifyOffWhenOnlineOff(
  records: readonly OffWhenOnlineOffRecord[],
  reportAt: number | null,
  serverOnAt: number,
  now: number,
  expiryMs: number,
): { ours: boolean; firstMatch: OffWhenOnlineOffRecord[] } {
  const counted = records.filter((record) => offWhenOnlineOffCounts(record, serverOnAt));
  const pinnedAt = newestOffWhenOnlinePin(counted);
  const open = counted.filter((record) => record.reportAt == null && now - record.publishedAt < expiryMs);
  if (reportAt == null) return { ours: pinnedAt != null || open.length > 0, firstMatch: [] };
  const publishedBy = (record: OffWhenOnlineOffRecord) => Math.floor(record.publishedAt / 1000) * 1000 <= reportAt;
  if (counted.some((record) => record.reportAt != null && publishedBy(record) && reportAt <= record.reportAt)) {
    return { ours: true, firstMatch: [] };
  }
  const firstMatch = open.filter(publishedBy);
  return { ours: firstMatch.length > 0, firstMatch };
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
  private lastQpIntervalConfigAt = 0;
  /** Arrival of the last sensor message of ANY type: the report cadence the re-send check reads. */
  private lastQpReportAt = 0;
  /** Count of real-time (type 12) readings: a clock-free way for a cloud poll to see one landed. */
  private qpRealtimeSeq = 0;
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
  private watchActiveUntil = 0;
  private watchTimer?: NodeJS.Timeout;
  private watchAcs = new Map<string, AcDevice>();
  private watchMeter: {
    controller: AcLeveler | LevelingControllerV2;
    source: "grid" | "gen" | "none";
    amps: number | null;
    limit: number | null;
    ts: number;
  } | null = null;
  acLeveler: AcLeveler;
  acLeveler2: LevelingControllerV2;

  /**
   * The controller that ACTS right now. v1 unless the v2 flag (config row
   * id=2) says "v2". In "shadow", v1 acts here while checkAcLeveling also
   * shadow-ticks v2 (journal-only). Both satisfy the same call surface.
   */
  leveling(): AcLeveler | LevelingControllerV2 {
    return this.acLeveler2.controllerFlavor() === "v2" ? this.acLeveler2 : this.acLeveler;
  }
  /** Per-device leveler reads fail closed at the same physical-line policy boundary as commands. */
  private isLevelerShed(deviceId: string): boolean {
    return isAcLevelingEligible(deviceId) && this.leveling().isShed(deviceId);
  }
  private hasLevelerFanHold(deviceId: string): boolean {
    return isAcLevelingEligible(deviceId) && this.leveling().hasFanHold(deviceId);
  }
  acCalibrator: AcCalibrator;
  private lastLevelerDevicesFetch = 0;
  private tclRetryAt = 0;
  private xiaomiRetryAt = 0;
  /** Consecutive failed Xiaomi re-auths, walking XIAOMI_REAUTH_BACKOFF_MS. A
   * login that keeps failing must not retry every 60s forever: 60 logins/hour
   * is exactly what Xiaomi's abuse heuristics answer with a captcha, which then
   * needs a human. Reset to zero the moment one succeeds. */
  private xiaomiReauthFailures = 0;
  private readonly XIAOMI_REAUTH_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000];
  /** Start of the outstanding Xiaomi init(), 0 when none is in flight. The
   * ladder above only escalates when init() SETTLES, so an init() that never
   * settles never escalates and the bottom rung relaunches a full login every
   * 60s forever. One login attempt at a time closes that, and keeps two of them
   * from sharing authStatus, the 2FA resolver and the credentials file. */
  private xiaomiReauthInFlightSince = 0;
  /** After this long an outstanding init() is written off so a new attempt may
   * start: the guard must never be able to wedge recovery itself. Worst case
   * against a permanently hung init() is therefore 6 logins/hour, against 60/hour
   * unguarded; a login that settles and fails stays on the ladder at 4/hour. */
  private readonly XIAOMI_REAUTH_INFLIGHT_MAX_MS = 10 * 60_000;
  /** Id of the newest login attempt. A written-off attempt that settles late must
   * not stamp its stale verdict over a session a newer login has since fixed. */
  private xiaomiReauthAttempt = 0;
  private automationRules: AutomationRule[] = [];
  private automationRulesLastFetch = 0;
  /** Bumped by every invalidation; a fetch that straddles one must not re-arm the 30 s cache. */
  private automationRulesGeneration = 0;
  /** Start-order id of each rule fetch, and of the newest one whose rows are installed. */
  private automationRulesFetchSeq = 0;
  private automationRulesInstalledSeq = 0;
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
  /** The off-when-online step acts on a device snapshot at most this old (else it fetches). */
  private readonly OFF_WHEN_ONLINE_SNAPSHOT_MAX_AGE_MS = 10_000;
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
  // Mode/temperature/etc. use the same "system initializes, then manual wins"
  // contract as fan, but ownership is per field so changing temperature on the
  // remote does not also surrender mode or swing.
  private acProfileEnforcement = new Map<string, AcProfileEnforcement>(); // key `${rule.id}:${deviceId}`
  /**
   * Last AC power cycle this process can ATTRIBUTE to something other than the
   * rule that owns the device — a leveler shed/restore or a mains power event.
   * Two jobs: it is the edge on which pre-cycle fan/swing intent is forgotten,
   * and it is the window inside which a swing difference reads as a firmware
   * reset rather than as somebody's remote (see `driftedRangeSwing`).
   */
  private acPowerCycleAt = new Map<string, number>();
  private readonly AC_POWER_CYCLE_RESET_MS = 15 * 60_000;
  /**
   * Subset of `acPowerCycleAt`: only the cycles caused by a REAL source
   * transition (a grid↔gen changeover), which physically reboots the AC. A boot
   * ("source none → X" = only the server restarted) and an ESP gap do NOT
   * power-cycle the units, so they are excluded. This is the edge the
   * post-changeover boot hold-off gates on — `acPowerCycleAt` keeps its broader
   * semantics for its many other consumers (see `holdRangeEnforcementForBoot`,
   * 2026-08-18).
   */
  private acSourceCycleAt = new Map<string, number>();
  /** Last source-cycle stamp a boot hold-off was logged for, per device — so the hold logs once per episode, not once per tick. */
  private acBootHoldLoggedAt = new Map<string, number>();
  // A changeover-rebooted TCL unit takes ~30–90s to reboot + rejoin WiFi +
  // re-shadow; hold background range enforcement at most this long (still well
  // under the 5-min automation cooldowns) before letting sends resume anyway.
  private readonly BOOT_HOLDOFF_MAX_MS = 4 * 60_000;
  /** Devices seen shed on the previous sweep — for leveler shed EDGE detection. */
  private acShedSeen = new Set<string>();
  // Fan/swing enforcement sweep (beep-style): per-device resend cooldown so a
  // lagging shadow can never turn "re-assert once" into a command every tick.
  private acEnforceLastSent = new Map<string, number>();
  private readonly AC_ENFORCE_RESEND_COOLDOWN_MS = 30_000;
  // Last automation-sent power-off per device — the shadow can lag past the 5s power
  // cache TTL, so off branches re-firing inside this grace are duplicates, not state.
  private acRangeOffAt = new Map<string, number>();
  private readonly AC_OFF_REFIRE_GRACE_MS = 15_000;
  // Persistent per-AC beep-off preference (firmware resets beepSwitch on power-loss restarts)
  private acBeepOffPrefs = new Set<string>();
  private acBeepPrefsLoaded = false;
  private acBeepLastSent = new Map<string, number>();
  /** When each beep-off pref was recorded (the UI toggle, or the row's `set_at`
   * at load). The user's own fresh Beep OFF still reads `beep: true` from the
   * lagging shadow for a few seconds, and the beep-reset power-cycle
   * fingerprint must not read his hand as a restart. */
  private acBeepOffRecordedAt = new Map<string, number>();
  private lastBeepDevicesFetch = 0;
  private readonly AC_BEEP_RESEND_COOLDOWN_MS = 30_000;
  private readonly AC_BEEP_FETCH_INTERVAL_MS = 30_000;
  private readonly AC_BEEP_PREF_SETTLE_MS = 2 * 60_000;
  /**
   * Power-event context for observed-off classification (2026-07-06): blackouts,
   * changeovers, collapses and gen brownouts turn ACs off, and their shadows can
   * lag the event by MINUTES (13 min observed live) — an un-commanded OFF near a
   * power event is a power-loss off, NOT the user's hand, and must never record
   * a sacred manual-off lock (two bogus locks stranded a hot room overnight,
   * live 2026-07-05/06). Stamped via the leveler's onPowerEvent dep.
   */
  private lastPowerEventAt = 0;
  /**
   * The last power event of a kind that physically RESTARTS the ACs
   * (`powerEventRestartsAcs`: a real source change, a collapse, a dead AC
   * circuit), and per device the last beep-reset fingerprint seen (a power-loss
   * restart with no source change). Either one after our power ON voids the
   * "the unit itself went off after our ON" verdict: a restarting unit's
   * reports, and a beep reset the shadow shows late, are exactly what could
   * otherwise mint a sacred lock (hard rule 2, 2026-09-27).
   */
  private lastRestartPowerEventAt = 0;
  private acBeepResetSeenAt = new Map<string, number>();
  private readonly AC_POWER_EVENT_GRACE_MS = 15 * 60_000;
  /**
   * Server-commanded AC power-ons (automation/schedule/timer/leveler/UI) can
   * take seconds-to-minutes to reach the TCL shadow; until then the device
   * still reads OFF. An observed OFF inside this window is OUR command in
   * flight, never the user's hand — 2026-07-27 17:15: a leveler restore's
   * 5.8s shadow lag minted a bogus observed_off lock that stranded the room.
   */
  private lastServerAcOnAt = new Map<string, number>();
  private readonly AC_SERVER_ON_SHADOW_GRACE_MS = 120_000;
  /**
   * Last time the LIVE shadow was observed powered ON. The server-on grace is
   * only shadow-lag while the shadow has not yet confirmed our ON
   * (observedOnAt < serverOnAt); once it has, a later OFF is a real transition,
   * not lag, and must lock on the FIRST observation. Stamped in
   * noteAcObservedPower alongside acManualOffSeenOff.
   */
  private lastAcObservedOnAt = new Map<string, number>();
  /**
   * When the server-on grace REVERSES an observed off (our own ON still
   * unconfirmed by the shadow), it stamps this. Belt for the residual lag-window
   * fight: a REMOTE (TCL-app) off is not commanded through us, so the automation
   * re-sends power=1 and re-arms the grace (2026-08-08: Najat cycled on/off with
   * nothing in the dashboard). A repeat off within AC_REPEAT_OFF_MANUAL_MS of
   * the previous reversal, with an ON confirmed in between (lastAcObservedOnAt >
   * this) and AWAY from any power event, is a human flipping through the lag:
   * record the lock. A stale shadow shows no intervening ON, so it can never
   * trip this. Cleared whenever the device's lock is recorded or cleared.
   */
  private acServerOnReversalAt = new Map<string, number>();
  private readonly AC_REPEAT_OFF_MANUAL_MS = 10 * 60_000;
  /**
   * The armed "off when back online" OFFs this process published, per device:
   * a plain server-commanded OFF that the observed-off classifier must never
   * take for a human's (owner decision 2026-10-10, hard rule 2: no lock by the
   * back door). One record per publish (`OffWhenOnlineOffRecord`), appended at
   * the publish boundary (`noteOffWhenOnlineOffPublished`); a publish the cloud
   * did not accept is voided by its own operation, never by another one. Read
   * by `isOffWhenOnlineOff` (`classifyOffWhenOnlineOff`). Memory only.
   */
  private offWhenOnlineOffs = new Map<string, OffWhenOnlineOffRecord[]>();
  private offWhenOnlineOffSeq = 0;
  // Loop-liveness watchdog (2026-07-06 ~3h silent stall): heartbeat + per-step
  // deadlines so one hung external call can never freeze every automation.
  private lastLoopTickAt = Date.now();
  private currentStep: string | null = null;
  private loopWatchdog: NodeJS.Timeout | null = null;
  private readonly STEP_TIMEOUT_MS = 90_000;
  private readonly LOOP_STALL_WARN_MS = 60_000;
  private readonly LOOP_STALL_FATAL_MS = 3 * 60_000;
  /** Ambient Weather meters 1 request/sec per USER — the poll and the backfill share this budget. */
  private readonly AW_MIN_REQUEST_GAP_MS = 1_100;
  private readonly awGate = new RateGate(this.AW_MIN_REQUEST_GAP_MS);

  getLatestAir(): Record<string, unknown> | null {
    return this.latestAirRow;
  }

  /** The request only renews demand. Cloud calls run on a separate collector
   * timer, so a slow provider cannot hold up the response or the leveling loop. */
  noteWatchRequest(): void {
    this.watchActiveUntil = Date.now() + 120_000;
    this.watchTimer ??= setInterval(() => this.refreshWatchDevices(), WATCH_REFRESH_MS).unref();
  }

  private refreshWatchDevices(): void {
    if (Date.now() >= this.watchActiveUntil) {
      clearInterval(this.watchTimer);
      this.watchTimer = undefined;
      return;
    }
    if (this.xiaomiCloud?.isReady()) {
      void this.xiaomiCloud.fetchDevicesLive().catch(() => log.warn("[collector] Watch purifier refresh failed"));
    }
    if (this.tclCloud?.isReady()) {
      void this.tclCloud.getDevicesNoOlderThan(WATCH_REFRESH_MS - 1).then(devices => this.rememberWatchAcs(devices))
        .catch(() => log.warn("[collector] Watch AC refresh failed"));
    }
  }

  private rememberWatchAcs(acs: AcDevice[]): void {
    // A subsequent list fetch can succeed while one unit's shadow read
    // fails. Retain that unit's most recent actual report across the failure.
    for (const d of acs) {
      if (d.lastSeenAt != null && d.lastSeenAt >= (this.watchAcs.get(d.id)?.lastSeenAt ?? 0)) this.watchAcs.set(d.id, d);
    }
  }

  getWatchDeviceState() {
    const acs = this.tclCloud?.getDevices() ?? [];
    this.rememberWatchAcs(acs);
    const controller = this.leveling();
    return {
      acs,
      lastAcs: this.watchAcs,
      purifiers: this.xiaomiCloud?.getDevices() ?? [],
      hasPowerReading: this.latestPowerTs != null,
      // A silent meter blanks the tuple at read time too, not only at the next tick.
      meter: this.watchMeter?.controller === controller && this.latestPowerTs != null
        && Date.now() - this.latestPowerTs.getTime() <= STALE_POWER_MS ? this.watchMeter : null,
      leveling: controller.getStatus(),
    };
  }

  isAcTurnedDown(deviceId: string): boolean {
    return this.isLevelerShed(deviceId) || this.hasLevelerFanHold(deviceId);
  }

  preserveWatchGeneratorCap(deviceId: string): boolean {
    if (!isAcLevelingEligible(deviceId)) return false;
    // Before the controller has evaluated this room, keep its existing cap.
    // Once known, use the same live management decision as automation sends.
    return this.isAcLevelingManaged(deviceId) || !this.leveling().getStatus().acs.some(ac => ac.deviceId === deviceId);
  }

  /** Read-only view of the newest ESP reading, for observability (diagnostics.ts). */
  getLatestPower(): Record<string, unknown> | null {
    return this.latestPowerRow;
  }

  setLatestPower(data: { ts: string; voltage: number; current_1: number; current_2: number; power_1: number; power_2: number }): void {
    this.latestPowerRow = data as unknown as Record<string, unknown>;
    this.latestPowerTs = new Date(data.ts);
    this.recentPowerReadings = [
      ...this.recentPowerReadings.slice(-7),
      { tsMs: this.latestPowerTs.getTime(), row: this.latestPowerRow },
    ];
    // Streaks are counted per ESP reading, not per collector tick
    // Both controllers always ingest readings: the shadow/idle one keeps its
    // meter state warm so a live flag flip needs no warm-up.
    this.acLeveler.onPowerReading(data);
    this.acLeveler2.onPowerReading(data);
    this.acCalibrator.onPowerReading(data);
  }

  invalidateAutomationRules(): void {
    this.automationRulesLastFetch = 0;
    this.automationRulesGeneration++;
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
    // The reversal episode is resolved (this off is now locked) — forget it so a
    // future grace reversal starts a fresh repeat window.
    this.acServerOnReversalAt.delete(deviceId);
    await this.pool.query(
      `INSERT INTO ac_manual_off_locks (device_id, locked_at, reason)
       VALUES ($1, NOW(), $2)
       ON CONFLICT (device_id) DO UPDATE SET locked_at = NOW(), reason = EXCLUDED.reason`,
      [deviceId, reason],
    );
    this.devicePowerCache.set(deviceId, { power: "off", ts: Date.now() });
    if (!wasLocked) log.info(`[collector] AC ${deviceId}: manual-off lock recorded (${reason})`);
  }

  /** Returns whether THIS call is the one that released a lock — `Set.delete`
   * is atomic, so concurrent turn-ons can't both claim the release (which would
   * double-notify). */
  async clearAcManualOff(deviceId: string): Promise<boolean> {
    await this.ensureAcManualOffLocksLoaded();
    const wasLocked = this.acManualOffLocks.delete(deviceId);
    this.acManualOffLockTimes.delete(deviceId);
    this.acManualOffSeenOff.delete(deviceId);
    // The AC is back on — any pending repeat-off window is stale.
    this.acServerOnReversalAt.delete(deviceId);
    if (wasLocked) {
      await this.pool.query("DELETE FROM ac_manual_off_locks WHERE device_id = $1", [deviceId]);
    }
    this.devicePowerCache.set(deviceId, { power: "on", ts: Date.now() });
    // Covers the UI set_power=1 path (a commanded ON whose shadow may lag OFF
    // for minutes). Also fires on observed-ON clears, where the stamp is
    // harmless: the shadow already shows ON, and a remote off soon after at
    // worst skips one observed-off lock (errs toward cooling; a dashboard off
    // still locks instantly via its commanded path).
    this.noteServerAcOn(deviceId);
    if (wasLocked) log.info(`[collector] AC ${deviceId}: manual-off lock cleared`);
    return wasLocked;
  }

  async isAcManualOffLocked(deviceId: string): Promise<boolean> {
    await this.ensureAcManualOffLocksLoaded();
    return this.acManualOffLocks.has(deviceId);
  }

  /**
   * A commanded power-ON released a manual-off lock. That is the ONLY path that
   * undoes a user's sacred off, so it is announced: on 2026-07-24 four
   * authenticated set_power=1 calls re-armed Najat's automation overnight and
   * nobody at home had pressed anything (see docs/agent/ac-automations.md).
   * Critical, so it beats the leveling push throttle — the opt-in toggle still
   * gates it.
   */
  notifyAcLockCleared(deviceId: string, authKind: AuthKind, ip: string): void {
    const name = this.tclCloud?.getDevices().find((d) => d.id === deviceId)?.name ?? deviceId;
    const source = actorName[authKind];
    log.info(`[collector] AC ${deviceId}: manual-off lock released by a power-ON from ${source} (ip=${ip})`);
    void this.broadcastPush({
      title: "AC manual-off released",
      body: `${name} was turned ON from ${source} (${ip}) — the manual-off lock is cleared and automations resume.`,
      type: "leveling",
    });
  }

  /**
   * An OBSERVED (un-commanded) ON released a manual-off lock — announced too,
   * because a release nobody can attribute is exactly the one the user needs to
   * see. Deliberately NOT called from `clearAcManualOff()`: the `set_power=1`
   * route pushes its own richer, actor-carrying message and the two would
   * double-push (2026-08-05).
   */
  private notifyObservedAcLockCleared(deviceId: string): void {
    const name = this.tclCloud?.getDevices().find((d) => d.id === deviceId)?.name ?? deviceId;
    log.info(`[collector] AC ${deviceId}: manual-off lock released by an observed ON (no command of ours)`);
    void this.broadcastPush({
      title: "AC manual-off released",
      body: `${name} was turned back on physically (remote / app / panel) — the manual-off lock is cleared and automations resume.`,
      type: "leveling",
    });
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

  /** Note a LIVE-observed power state for an AC: observing the OFF proves a
   * lock took effect (precondition for a later ON to clear it), and observing
   * the ON confirms our server ON reached the shadow — which transition-gates
   * the observed-off shadow-lag grace. */
  private noteAcObservedPower(deviceId: string, power: "on" | "off" | undefined): void {
    if (power === "on") this.lastAcObservedOnAt.set(deviceId, Date.now());
    if (power === "off" && this.acManualOffLocks.has(deviceId)) {
      this.acManualOffSeenOff.add(deviceId);
    }
  }

  /**
   * Stamped by the leveler on source changes, collapses, and meter dropouts.
   * EVERY kind opens the observed-off classification window (hard rule 2); only
   * the kinds that physically restart the units also power-cycle their intent.
   *
   * `now` is the leveler's OWN timestamp for the event (2026-09-05): this
   * window and the controller's level-jump window judge the same event, so they
   * are stamped from one clock rather than two `Date.now()` calls a few
   * milliseconds apart. It defaults for the callers that have no event of their
   * own (tests, and v1, whose dep signature carries only the kind).
   */
  notePowerEvent(kind: string, now: number = Date.now()): void {
    this.lastPowerEventAt = now;
    // Shadows go stale across power events (ACs restart, firmware republishes
    // late) — force the next leveling tick to fetch live device state.
    this.lastLevelerDevicesFetch = 0;
    // A changeover / collapse / blackout restarts the units themselves: the
    // firmware resets the blower to built-in auto and re-reads swing. That is a
    // power cycle for every managed AC, and none of it passes through a
    // rule-owned clear site (2026-08-06). A bare telemetry gap is NOT that
    // event: the meter went quiet, the house did not. Live 2026-08-31, a 24s
    // "ESP gap" across continuous 12.7A of grid current reverted the user's
    // fan 5 / swing 9; he re-corrected twice and was reverted twice. The
    // classification window above still stands for every kind; only the per-AC
    // intent wipe is gated. A blackout that changes no source is caught per
    // device by the beep-reset fingerprint in `noteBeepResetPowerCycle`.
    const restartsAcs = powerEventRestartsAcs(kind);
    if (restartsAcs) this.lastRestartPowerEventAt = now;
    // The same restart is a new power epoch for every armed "off when back
    // online": a report from before it says nothing about the unit after it.
    // Optional call: test doubles of the cloud predate it.
    if (restartsAcs) this.tclCloud?.noteOffWhenOnlinePowerEpoch?.(now);
    for (const dev of this.tclCloud?.getDevices() ?? []) {
      if (restartsAcs) this.notePowerCycle(dev.id, `power event (${kind})`, now);
      const hasSystemProfile = this.automationRules.some(
        (rule) => rule.device_type === "ac" && (rule.device_ids ?? [rule.device_id]).includes(dev.id),
      );
      // Last-state recovery belongs to a real source transition on a grid-only
      // line the leveler does not own. ESP gaps and leveler-only collapses say
      // nothing about a separate line such as Guest's. The boot/cold-start
      // "source none → X" event must NEVER arm — it would freeze a stale disk
      // snapshot and revert a running unit after every deploy. Restore
      // eligibility is a POSITIVE per-device fact (verified physical wiring),
      // never inferred from the absence of leveling: an unknown future AC whose
      // line the leveler may yet own must not be armed on "not leveling-eligible".
      if (
        !hasSystemProfile
        && kind.startsWith("source ")
        && !kind.startsWith("source none")
        && isPowerCycleRestoreEligible(dev.id)
      ) {
        this.tclCloud?.preparePowerCycleRestore?.(dev.id);
      }
    }
    log.info(
      `[collector] Power event (${kind}) — observed AC offs read as power-loss for the next 15 min`
      + (restartsAcs ? "" : "; meter telemetry only, AC fan/swing intent kept"),
    );
  }

  /**
   * An AC power-cycled for a reason the rule that owns it never observed — a
   * leveler shed/restore, or a mains power event. `clearAcFanEnforcement`'s
   * contract has always been "any AC power cycle the rule owns", but only the
   * five automation-driven cycles honored it: a leveler shed skips the
   * observed-off branch outright (`isShed` → continue) and a leveler restore
   * has no automation site at all. So `acFanEnforcement.manual` survived from
   * BEFORE the cycle, `effectiveAcRangeProfile` deleted fan_speed/turbo from
   * every enforced profile, and the AC sat on device-auto ('A') indefinitely —
   * live 2026-08-06 02:32Z, Najat shed + restored across a grid→gen changeover.
   *
   * Only PRE-cycle intent is forgotten: this is edge-triggered, so a manual
   * change made AFTER the cycle re-arms the override and still wins.
   *
   * The fan entry is released, NOT deleted — the five rule-owned sites can drop
   * the whole entry because each one re-sends the full profile in the same
   * breath and `noteAcFanCommanded` rebuilds it; nothing re-sends here, and the
   * baseline (`lastCommandedFan`/`lastFanCommandAt`) is what `refreshAcFanBaseline`
   * updates on every leveler fan command and what keeps a later drift check from
   * misreading our own send as a manual change.
   */
  private notePowerCycle(deviceId: string, reason: string, now: number = Date.now()): void {
    this.acPowerCycleAt.set(deviceId, now);
    // Only a REAL source transition physically reboots the AC (a "source none → X"
    // boot restarts only the server; an ESP gap / leveler cycle says nothing
    // about a mains changeover), so only those reasons arm the post-changeover
    // boot hold-off. Gate on this dedicated map — `acPowerCycleAt`'s semantics
    // must stay untouched for its many other consumers (2026-08-18).
    if (reason.includes("source ") && !reason.includes("source none")) {
      this.acSourceCycleAt.set(deviceId, now);
    }
    let cleared = false;
    for (const [key, entry] of this.acFanEnforcement) {
      if (!key.endsWith(`:${deviceId}`)) continue;
      if (entry.manual) cleared = true;
      this.acFanEnforcement.set(key, { ...entry, manual: false, initializationPending: true });
    }
    for (const key of this.acSwingOverrides.keys()) {
      if (key.endsWith(`:${deviceId}`)) {
        this.acSwingOverrides.delete(key);
        cleared = true;
      }
    }
    for (const key of this.acProfileEnforcement.keys()) {
      if (key.endsWith(`:${deviceId}`)) {
        this.acProfileEnforcement.delete(key);
        cleared = true;
      }
    }
    if (cleared) {
      log.info(`[collector] AC ${deviceId}: ${reason} — dropping pre-cycle fan/swing intent, enforcement resumes`);
    }
  }

  /**
   * Leveler shed edges the `setDevicePowerCache` hook cannot see: a shed
   * adopted from the DB at boot, a controller flip, or a shed cleared by
   * another path. Only the false→true edge clears intent — a shed clears on the
   * CONFIRMED shadow ON, which lags the restore command by 5.8s–13min
   * (ac-leveling invariant 4), so treating the un-shed edge as the cycle would
   * wipe a manual change the user made minutes after the room was already back.
   */
  private observeLevelerShedEdges(deviceIds: string[]): void {
    const leveling = this.leveling();
    for (const deviceId of deviceIds) {
      if (!leveling.isShed(deviceId)) {
        this.acShedSeen.delete(deviceId);
        continue;
      }
      if (this.acShedSeen.has(deviceId)) continue;
      this.acShedSeen.add(deviceId);
      this.notePowerCycle(deviceId, "leveler shed");
    }
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
  private classifyObservedAcOff(
    deviceId: string,
    observed?: Pick<AcDevice, "power" | "beep" | "fanSpeed">,
  ): "power_event" | "manual" {
    if (!this.config.observedOffLocks) return "power_event";
    const dev = observed ?? this.tclCloud?.getDevices().find((d) => d.id === deviceId);
    // Negative fingerprint beats the window: firmware resets beepSwitch to ON on
    // EVERY power-loss restart, so an off still showing beep=false on a
    // beep-off-enforced AC proves the unit never lost power — a by-hand off
    // (remote / TCL app), even mid-changeover chaos.
    if (dev && !dev.power && this.acBeepOffPrefs.has(deviceId) && dev.beep === false) return "manual";
    if (Date.now() - this.lastPowerEventAt < this.AC_POWER_EVENT_GRACE_MS) return "power_event";
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
    // A commanded off (UI / turn-off timer) records its lock BEFORE the shadow
    // ever shows the off — an already-locked device is the user's own off, never
    // a power event. Keep the lock; no re-record, no push (the user acted).
    if (await this.isAcManualOffLocked(deviceId)) {
      log.info(`[collector] ${context}: device ${deviceId} observed OFF but already manual-off locked — keeping the lock`);
      return false;
    }
    // Our own armed "off when back online" OFF is server-commanded, never a
    // human's: no lock (hard rule 2), and the rule stands down as after its own
    // OFF. Ahead of the server-ON grace, whose "lag" reading would re-ON the unit.
    if (this.isOffWhenOnlineOff(deviceId)) {
      log.info(`[collector] ${context}: device ${deviceId} observed OFF is our own off-when-back-online OFF (server-commanded), not a manual off: no lock`);
      return false;
    }
    // An OFF observed shortly after a power ON we ourselves commanded CAN be the
    // shadow lagging our own command — but only until the shadow actually
    // CONFIRMS the ON. The fingerprint carries no staleness information (a shed
    // room's stale shadow reads exactly power=0/beep=false, identical to a
    // genuine remote off), which is why the grace exists. So the fast-path is
    // TRANSITION-GATED: once the shadow has been observed ON since our server ON,
    // a later OFF is a REAL transition, not lag — skip the fast-path and let
    // classifyObservedAcOff apply the power-event window, the fingerprints, and
    // lock on the FIRST observation (2026-08-08: a remote off cycled Najat while
    // the dashboard showed nothing; the grace kept reversing it forever).
    const serverOnAt = this.lastServerAcOnAt.get(deviceId) ?? 0;
    const observedOnAt = this.lastAcObservedOnAt.get(deviceId) ?? 0;
    // The shadow's own metadata CAN carry staleness information (2026-09-27
    // probe): a `powerSwitch` report that came ALONE, strictly after our ON was
    // sent, is the unit itself going off after our ON landed. Our polls just
    // never caught the ON in between. That is not lag, so it goes to the
    // classifier below (beep fingerprint, power-event window, hard rule 2) like
    // any other off. A stale report or a full-state reconnect dump answers false
    // and keeps the lag reading (see `isolatedPowerOffAfter`).
    const inGrace =
      serverOnAt > 0 &&
      Date.now() - serverOnAt < this.AC_SERVER_ON_SHADOW_GRACE_MS &&
      observedOnAt < serverOnAt; // the shadow has NOT confirmed this server ON yet
    const dev = inGrace ? this.tclCloud?.getDevices().find((d) => d.id === deviceId) : undefined;
    if (inGrace && dev && this.unitSwitchedOffAfterOurOn(dev, serverOnAt)) {
      log.info(
        `[collector] ${context}: device ${deviceId} observed OFF reported by the unit ` +
          `${Math.round(((dev.powerReportedAt ?? serverOnAt) - serverOnAt) / 1000)}s after our ON, ` +
          `after the ON's own full-state report (isolated, ${dev.powerReportCohort} field(s)); not shadow lag, classifying`,
      );
    } else if (inGrace) {
      // Repeat guard: a belt for offs that arrive before the shadow ever
      // confirmed our ON (the residual lag-window fight). A stale shadow never
      // shows an intervening ON, so it can NEVER trip this; a human flipping
      // off→on→off through the lag does (observedOnAt lands after the previous
      // reversal). The power-event exclusion is load-bearing (hard rule 2): a
      // changeover can blink a room off twice in 10 min, and an off near a power
      // event must NEVER record a lock.
      const lastReversal = this.acServerOnReversalAt.get(deviceId) ?? 0;
      const nearPowerEvent = Date.now() - this.lastPowerEventAt < this.AC_POWER_EVENT_GRACE_MS;
      if (
        this.config.observedOffLocks &&
        lastReversal > 0 &&
        Date.now() - lastReversal < this.AC_REPEAT_OFF_MANUAL_MS &&
        !nearPowerEvent &&
        observedOnAt > lastReversal // an intervening confirmed ON = a human flip, not staleness
      ) {
        log.info(`[collector] ${context}: device ${deviceId} observed OFF again ${Math.round((Date.now() - lastReversal) / 1000)}s after a reversal, with an ON confirmed in between (no power event) — a human is insisting, recording lock`);
        await this.recordObservedManualOff(
          deviceId, "observed_off_repeat", "AC automation paused — repeated off",
          `${deviceName} was turned off by hand again — automations stay off until it's turned back on from the dashboard.`,
        );
        return false;
      }
      this.acServerOnReversalAt.set(deviceId, Date.now());
      log.info(
        `[collector] ${context}: device ${deviceId} observed OFF ${Math.round((Date.now() - serverOnAt) / 1000)}s after a server-commanded ON the shadow has not confirmed — shadow lag, not a manual off`,
      );
      return true;
    }
    await this.ensureAcBeepPrefsLoaded();
    if (this.classifyObservedAcOff(deviceId) === "power_event") {
      log.info(`[collector] ${context}: device ${deviceId} observed OFF near a power event — not a manual off, automation resumes`);
      return true;
    }
    log.info(`[collector] ${context}: device ${deviceId} manually turned OFF, recording manual-off lock`);
    await this.recordObservedManualOff(
      deviceId, "observed_off", "AC automation paused",
      `${deviceName} was turned off by hand — automations stay off until it's turned back on from the dashboard.`,
    );
    return false;
  }

  /**
   * Causal evidence that the unit went off by itself AFTER our power ON landed
   * (`isolatedPowerOffAfter`: our ON's full-state dump, then a lone powerSwitch
   * OFF), and nothing since our ON that restarts units: a restart-kind power
   * event or a beep-reset sighting voids the verdict (ambiguous, so the caller
   * keeps today's behaviour).
   */
  private unitSwitchedOffAfterOurOn(
    dev: Pick<AcDevice, "id" | "power" | "powerReportedAt" | "powerReportCohort" | "fullStateReportAt">,
    sentAt: number,
  ): boolean {
    if (!isolatedPowerOffAfter(dev, sentAt)) return false;
    if (this.lastRestartPowerEventAt >= sentAt) return false;
    if ((this.acBeepResetSeenAt.get(dev.id) ?? 0) >= sentAt) return false;
    return true;
  }

  /**
   * The leveler asks: a shed room's restore landed and the unit then went off on
   * its own. Runs the SAME judgment as every observed off (the causal evidence
   * and restart voids above, then `classifyObservedAcOff`: beep fingerprints and
   * the power-event window) and, on "manual", records the persistent manual-off
   * lock (reason `restore_declined`) with the usual push, so the human's choice
   * survives an idle rule's auto-on path, a rule re-enabled later, and a restart
   * (the lock is in the DB). Anything else answers false: the leveler keeps the
   * shed and its ordinary confirm-or-resend.
   */
  private async recordDeclinedRestore(deviceId: string, sentAt: number, device: AcDevice): Promise<boolean> {
    if (!this.unitSwitchedOffAfterOurOn(device, sentAt)) {
      log.info(`[collector] AC ${deviceId}: leveler asked about a declined restore, but the evidence is ambiguous; keeping the restore`);
      return false;
    }
    if (await this.isAcManualOffLocked(deviceId)) return true; // the user's own off already stands
    await this.ensureAcBeepPrefsLoaded();
    if (this.classifyObservedAcOff(deviceId, device) !== "manual") {
      log.info(`[collector] AC ${deviceId}: restore switched off near a power event (or observed-off locks disabled): not a manual off, keeping the restore`);
      return false;
    }
    const name = this.tclCloud?.getDevices().find((d) => d.id === deviceId)?.name ?? device.name ?? deviceId;
    log.info(`[collector] AC ${deviceId}: switched off by hand right after a Smart AC Leveling restore, recording manual-off lock`);
    await this.recordObservedManualOff(
      deviceId, "restore_declined", "AC automation paused",
      `${name} was switched off by hand right after Smart AC Leveling turned it back on. It stays off until it's turned back on from the dashboard.`,
    );
    return true;
  }

  /** Record an observed-off manual lock and push the paused alert (one wrong
   * guess is a 10-second fix from the phone instead of a hot room at dawn). */
  private async recordObservedManualOff(deviceId: string, reason: string, title: string, body: string): Promise<void> {
    await this.recordAcManualOff(deviceId, reason);
    void this.broadcastPush({ title, body, type: "leveling" });
  }

  async reconcileAcManualOffLocks(devices: Pick<AcDevice, "id" | "power">[]): Promise<Set<string>> {
    await this.ensureAcManualOffLocksLoaded();
    for (const dev of devices) {
      if (!this.acManualOffLocks.has(dev.id)) continue;
      this.noteAcObservedPower(dev.id, dev.power ? "on" : "off");
      if (dev.power && this.canClearAcManualOff(dev.id)) {
        if (await this.clearAcManualOff(dev.id)) this.notifyObservedAcLockCleared(dev.id);
      }
    }
    return this.getAcManualOffLockedIds(devices.map((dev) => dev.id));
  }

  private async ensureAcBeepPrefsLoaded(): Promise<void> {
    if (this.acBeepPrefsLoaded) return;
    const result = await this.pool.query("SELECT device_id, set_at FROM ac_beep_off");
    this.acBeepOffPrefs = new Set(result.rows.map((row) => String(row.device_id)));
    // `set_at` carries the toggle across a restart: a deploy seconds after the
    // user's Beep OFF must not let the still-lagging shadow read as a restart.
    for (const row of result.rows) {
      const setAt = row.set_at instanceof Date ? row.set_at.getTime() : Date.parse(String(row.set_at));
      if (Number.isFinite(setAt)) this.acBeepOffRecordedAt.set(String(row.device_id), setAt);
    }
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
    this.acBeepOffRecordedAt.set(deviceId, Date.now());
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
    this.acBeepOffRecordedAt.delete(deviceId);
    if (wasSet) {
      await this.pool.query("DELETE FROM ac_beep_off WHERE device_id = $1", [deviceId]);
      log.info(`[collector] AC ${deviceId}: beep-off preference cleared`);
    }
  }

  /**
   * The per-device belt for a blackout that changed no source (2026-08-31): the
   * meter can only report a gap, which is no longer read as a power cycle, but
   * the firmware DID restart the unit, and it resets `beepSwitch` to ON ONLY on
   * a power-loss restart (the same fingerprint the observed-off classifier
   * trusts, and all 3 managed ACs carry an `ac_beep_off` row). So a beep-off AC
   * seen ON with the buzzer back is the unit's own evidence of a cycle nothing
   * else could attribute. Two guards, both needed:
   * - inside `AC_POWER_CYCLE_RESET_MS` of the device's last cycle, stay quiet:
   *   a lagging shadow echoes `beep: true` for ticks after the restart, and a
   *   changeover has already noted the cycle;
   * - inside `AC_BEEP_PREF_SETTLE_MS` of the pref being recorded, stay quiet:
   *   the user's own fresh Beep OFF also reads true until the shadow catches up.
   * Known exposure, inherited from the fingerprint: the ~30s after a real
   * restart in which beep reads true is exactly the window this uses. A unit
   * that never accepts `set_beep 0` therefore re-notes a cycle every 15 min;
   * accepted, as the enforcement re-send is already fighting that device.
   */
  private noteBeepResetPowerCycle(deviceId: string): void {
    const now = Date.now();
    if (now - (this.acPowerCycleAt.get(deviceId) ?? 0) < this.AC_POWER_CYCLE_RESET_MS) return;
    if (now - (this.acBeepOffRecordedAt.get(deviceId) ?? 0) < this.AC_BEEP_PREF_SETTLE_MS) return;
    const reason = "beep reset observed (power-loss restart)";
    this.notePowerCycle(deviceId, reason, now);
    // …and tell the v2 leveler, which has no other way to learn about this one:
    // a blackout that changes no source reaches it as an `esp_gap` at most, and
    // the unit's shadow never showed the off, so its structural OFF→ON flip
    // never ran (2026-09-05). Straight to `acLeveler2` because this is v2-owned
    // state and v1 is rollback-only, exactly like the shadow tick below.
    this.acLeveler2.onDevicePowerCycle(deviceId, reason, now);
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
      // The raw sighting, ungated by the cycle de-dup below: our own restore
      // stamps a power cycle at send, and a real restart right after it must
      // still void a "human off" verdict (see `unitSwitchedOffAfterOurOn`).
      if (Date.now() - (this.acBeepOffRecordedAt.get(dev.id) ?? 0) >= this.AC_BEEP_PREF_SETTLE_MS) {
        this.acBeepResetSeenAt.set(dev.id, Date.now());
      }
      this.noteBeepResetPowerCycle(dev.id);
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
    const levelerDeps = {
      getTclCloud: () => this.tclCloud,
      broadcast: (payload: Record<string, unknown>) => this.broadcastPush(payload),
      setDevicePowerCache: (deviceId: string, power: "on" | "off", at?: number) => {
        this.devicePowerCache.set(deviceId, { power, ts: Date.now() });
        // `at`: when the leveler PUBLISHED the power ON (v2 passes it; v1 does not).
        if (power === "on") this.noteServerAcOn(deviceId, at);
        // The leveler touches this on its OWN shed and restore ONLY, so it is
        // the exact edge of a leveler-driven power cycle — and neither edge
        // reaches any rule-owned fan/swing clear site.
        this.notePowerCycle(deviceId, power === "on" ? "leveler restore" : "leveler shed");
      },
      isManualOffLocked: (deviceId: string) => this.isAcManualOffLocked(deviceId),
      onLevelerFanCommand: (deviceId: string, fan: number) => this.refreshAcFanBaseline(deviceId, fan),
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
      // `now` is optional because v1's dep signature never had it; v2 always
      // passes its own event timestamp so both windows run off one clock.
      onPowerEvent: (kind: string, now?: number) => this.notePowerEvent(kind, now),
      // A shed room's restore landed and was switched straight back off by hand:
      // classify it the same way as any observed off and, on "manual", persist
      // the lock (2026-09-27). False keeps the shed and the ordinary resend.
      onRestoreDeclined: (deviceId: string, sentAt: number, device: AcDevice) =>
        this.recordDeclinedRestore(deviceId, sentAt, device),
    };
    this.acLeveler = new AcLeveler(pool, levelerDeps);
    // v2 controller (server/src/leveling/) — selected via the `controller`
    // flag in ac_leveling_config row id=2: "v1" (default), "shadow" (v2
    // journals its decisions, v1 acts), "v2" (v2 acts, v1 idle).
    this.acLeveler2 = new LevelingControllerV2(pool, levelerDeps);
    this.acCalibrator = new AcCalibrator(pool, {
      getTclCloud: () => this.tclCloud,
      getLimits: () => this.leveling().getLimits(),
      broadcast: (payload) => this.broadcastPush(payload),
      // Calibration power-cycled these ACs while leveling was suspended —
      // re-arm their compressor ramps so the first post-run tick doesn't
      // misread the restart as established draw (phantom headroom).
      onDevicesRestored: (deviceIds) => this.leveling().rearmRamp(deviceIds.filter(isAcLevelingEligible)),
    });

    if (config.vapidPublicKey && config.vapidPrivateKey) {
      webpush.setVapidDetails(config.vapidSubject, config.vapidPublicKey, config.vapidPrivateKey);
      log.info("[collector] Web Push configured");
    }
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.watchTimer);
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
    // Startup fires this WITHOUT awaiting it (runForever), so the loop is already
    // ticking while the first login runs: this attempt has to hold the single
    // login slot too, or the first tick sees a not-yet-ready cloud and launches a
    // SECOND concurrent login into the same authStatus and 2FA resolver.
    const attempt = this.beginXiaomiAuthAttempt();
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
    } finally {
      this.endXiaomiAuthAttempt(attempt);
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
      if (this.xiaomiCloud) {
        await this.runStep("xiaomi-devices", () => this.refreshXiaomiDevices());
      }
    } catch (err) {
      log.warn("[collector] Xiaomi device refresh failed:", (err as Error).message);
    }

    try {
      // Calibration owns the ACs while active — the AC automation/timer/
      // leveler checks below all stand down until it finishes.
      await this.runStep("calibration", () => this.acCalibrator.tick());
    } catch (err) {
      log.error("[collector] AC calibration tick failed:", err);
    }

    try {
      // Before the automations: an armed "off when back online" OFF goes out
      // (and is booked as ours) before any rule or timer of this tick looks.
      await this.runStep("ac-off-when-online", () => this.checkOffWhenOnline());
    } catch (err) {
      log.error("[collector] AC off-when-back-online check failed:", err);
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

    try {
      // After leveling, so fan holds and shed flags are this tick's truth.
      await this.runStep("ac-enforce", () => this.checkAcRangeEnforcement());
    } catch (err) {
      log.error("[collector] AC fan/swing enforcement failed:", err);
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
    const generation = this.automationRulesGeneration;
    const fetchSeq = ++this.automationRulesFetchSeq;
    const result = await this.pool.query(
      "SELECT * FROM automations WHERE enabled = true",
    );
    // Fetches can overlap: the step timeout abandons a tick whose fetch is still
    // out, and the next tick starts another. Only a fetch that STARTED after the
    // last installed one may install, or a late pre-change result would
    // overwrite newer rows under their fresh timestamp for 30 s (2026-09-27).
    if (fetchSeq <= this.automationRulesInstalledSeq) return;
    this.automationRulesInstalledSeq = fetchSeq;
    // Rows are installed even when an invalidation landed mid-fetch: they are
    // newer than the set they replace. Only the timestamp is withheld, so the
    // next tick (<= 5 s) reads the post-mutation rows instead of trusting these
    // for 30 s.
    this.automationRules = result.rows as AutomationRule[];
    if (generation === this.automationRulesGeneration) this.automationRulesLastFetch = Date.now();

    // Prune stale state for deleted rules
    const activeIds = new Set(this.automationRules.map((r) => r.id));
    for (const id of this.automationState.keys()) {
      if (!activeIds.has(id)) this.automationState.delete(id);
    }
  }

  /**
   * The server's own eyes on the Xiaomi device list. Deliberately NOT inside
   * checkAutomations(), which returns early when there are no automation rules:
   * refreshDevices() had ZERO callers repo-wide, so the only thing that ever hit
   * /home/device_list was a browser on /api/devices and a dead token could sit
   * unnoticed for hours (the 2026-08-31 wedge, 1h25m with no purifiers in the
   * UI). refreshDevices' own 5-minute throttle paces this to ~12 list calls/hour.
   */
  private async refreshXiaomiDevices(): Promise<void> {
    if (!this.xiaomiCloud) return;
    if (!this.xiaomiCloud.isReady()) {
      // A wedged session is exactly what this step exists to notice.
      this.maybeReauthXiaomiCloud();
      return;
    }
    await this.xiaomiCloud.refreshDevices();
  }

  /** Backoff for the NEXT re-auth attempt: 60s, then 5 min, then 15 min. */
  private xiaomiReauthDelay(): number {
    const ladder = this.XIAOMI_REAUTH_BACKOFF_MS;
    return ladder[Math.min(this.xiaomiReauthFailures, ladder.length - 1)];
  }

  private noteXiaomiReauthFailure(): void {
    this.xiaomiReauthFailures++;
    const delay = this.xiaomiReauthDelay();
    // The throttle was armed BEFORE the launch, so re-arm it from the escalated
    // ladder now that we know this attempt failed.
    this.xiaomiRetryAt = Math.max(this.xiaomiRetryAt, Date.now() + delay);
    log.warn(`[collector] Xiaomi re-auth failed ${this.xiaomiReauthFailures}x in a row, next attempt in ${Math.round(delay / 1000)}s`);
  }

  /** Claim the single login slot; the returned id settles it (endXiaomiAuthAttempt). */
  private beginXiaomiAuthAttempt(): number {
    this.xiaomiReauthInFlightSince = Date.now();
    return ++this.xiaomiReauthAttempt;
  }

  /**
   * Release the login slot. Returns false when this attempt was already written
   * off by XIAOMI_REAUTH_INFLIGHT_MAX_MS and a newer one owns the slot: a stale
   * attempt may neither free a slot it no longer holds nor have its verdict read.
   */
  private endXiaomiAuthAttempt(attempt: number): boolean {
    if (attempt !== this.xiaomiReauthAttempt) return false;
    this.xiaomiReauthInFlightSince = 0;
    return true;
  }

  /**
   * A human pressed Retry Sign-In (POST /api/xiaomi/relogin has already dropped
   * the session). Clear the backoff so the next collect tick (~5s) acts on it
   * rather than sitting out whatever rung the ladder had reached: answering
   * {ok:true} and then doing nothing for up to 15 minutes would be a lie told in
   * exactly the situation that endpoint exists for. Deliberately does NOT release
   * the in-flight slot: one login at a time is what keeps two of them from
   * sharing authStatus and the credentials file, and the deadline already frees
   * a genuinely hung attempt.
   */
  requestXiaomiRelogin(): void {
    this.xiaomiRetryAt = 0;
    this.xiaomiReauthFailures = 0;
    log.info("[collector] Xiaomi re-login requested, backoff cleared");
  }

  /**
   * Record the outcome of one re-auth attempt. Only the attempt that still owns
   * the login slot may touch the ladder: a written-off attempt settling late must
   * not stamp a failure over a session a newer login already fixed.
   */
  private finishXiaomiReauth(attempt: number, threw: boolean): void {
    if (!this.endXiaomiAuthAttempt(attempt)) {
      log.warn(`[collector] Xiaomi re-auth attempt #${attempt} settled after being superseded, verdict ignored`);
      return;
    }
    // init() swallows its own errors, so isReady() is the only honest verdict.
    if (!threw && this.xiaomiCloud?.isReady()) {
      this.xiaomiReauthFailures = 0;
      return;
    }
    this.noteXiaomiReauthFailure();
  }

  private maybeReauthXiaomiCloud(): void {
    if (!this.xiaomiCloud || this.xiaomiCloud.isReady()) return;
    const authInfo = this.xiaomiCloud.getAuthStatus();
    // needs_2fa/needs_captcha park on a human answering POST /api/xiaomi/verify;
    // retrying there only re-prompts, so that path deliberately stops retrying.
    if (authInfo.status === "needs_2fa" || authInfo.status === "needs_captcha") return;
    if (Date.now() < this.xiaomiRetryAt) return;
    // One login outstanding at a time. The ladder only escalates when init()
    // SETTLES, so an init() that hangs for a reason the status never reflects
    // never escalates, and the bottom rung would relaunch a fresh login every
    // 60s indefinitely: 60 logins/hour is the volume that makes Xiaomi answer
    // with a captcha, and a captcha needs a human. Written off after
    // XIAOMI_REAUTH_INFLIGHT_MAX_MS so the guard cannot wedge recovery in turn,
    // which caps the hung case at 6 logins/hour.
    if (this.xiaomiReauthInFlightSince && Date.now() - this.xiaomiReauthInFlightSince < this.XIAOMI_REAUTH_INFLIGHT_MAX_MS) return;

    // Fire-and-forget: init() blocks until 2FA/captcha is answered, and its
    // on2fa/onCaptcha callbacks return promises that only resolve via
    // POST /api/xiaomi/verify. Awaiting here would freeze the ENTIRE
    // collection loop (weather, alerts, automations, timers, beep) until
    // a human submits a code. Mirror the non-blocking startup path
    // (see initXiaomiCloud call in runForever). Throttle set BEFORE the
    // launch so a pending 2FA prompt (status not yet flipped) can't be
    // relaunched on the next tick.
    this.xiaomiRetryAt = Date.now() + this.xiaomiReauthDelay();
    const attempt = this.beginXiaomiAuthAttempt();
    log.warn("[collector] Xiaomi Cloud not ready, attempting re-auth");
    void this.xiaomiCloud.init().then(
      () => this.finishXiaomiReauth(attempt, false),
      (err: unknown) => {
        log.error("[collector] Xiaomi Cloud re-auth failed:", (err as Error).message);
        this.finishXiaomiReauth(attempt, true);
      },
    );
  }

  private async checkAutomations(): Promise<void> {
    await this.refreshAutomationRules();
    // Load leveler state early so shed guards and gen-strip checks see DB state
    await this.leveling().ensureLoaded();
    if (this.automationRules.length === 0) return;

    // Fire-and-forget for the same reason as the Xiaomi re-auth below: nothing
    // awaited inside the collection loop may block on an unbounded wait. TCL
    // auto-refreshes (no human 2FA today), but a hung auth request must not
    // freeze weather/alerts/automations. AC rules that need TCL just skip the
    // tick until isReady() (see the device-loop guard below).
    this.maybeReauthTclCloud();

    // Same ladder as the periodic device step above; the throttle makes the
    // second caller per tick a no-op.
    this.maybeReauthXiaomiCloud();

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

  /**
   * Throttled TCL re-auth while the cloud is not ready: at most one attempt a
   * minute (`tclRetryAt`, set before the launch so an in-flight init isn't
   * relaunched next tick), fire-and-forget. Shared by the automations and the
   * off-when-online step, which needs it when no automation rule exists.
   */
  private maybeReauthTclCloud(): void {
    if (!this.tclCloud || this.tclCloud.isReady() || Date.now() < this.tclRetryAt) return;
    this.tclRetryAt = Date.now() + 60_000;
    log.warn("[collector] TCL Cloud not ready, attempting re-auth");
    void this.tclCloud.init().catch((err) =>
      log.error("[collector] TCL Cloud re-auth failed:", (err as Error).message));
  }

  private async executeAutomationAction(rule: AutomationRule, action: PurifierAction | AcAction, deviceIds: string[]): Promise<void> {
    if (rule.device_type === "ac") {
      await this.tclCloud!.ensureDeviceCachePopulated();
    }
    for (const did of deviceIds) {
      const effectiveAction = this.stripLeveledControls(rule, action, did);
      if (rule.device_type === "ac") {
        // Captured BEFORE the call: a power-on publishes powerSwitch first and
        // only then waits ~3 s to send the profile, so "after the call" is ~3 s
        // late and a remote off inside that gap would read as older than our ON.
        const sentAt = Date.now();
        try {
          await this.tclCloud!.executeAcAction(did, effectiveAction as AcAction);
        } catch (err) {
          // The power ON was accepted and only the profile failed: the AC is
          // coming ON, so the rule must book it as sent (stamp, triggered state)
          // and let its diff re-enforcement re-assert the profile next tick.
          // Treating it as a refused send left a later remote off unjudged
          // (2026-09-27).
          if (!isPowerAcceptedError(err)) throw err;
          log.warn(`[collector] Automation "${rule.name}": ${err.message}; ON counts as sent, the profile is re-asserted by enforcement`);
        }
        if ((effectiveAction as AcAction).power === 1) this.noteServerAcOn(did, sentAt);
      } else {
        await this.xiaomiCloud!.executeAction(did, effectiveAction as PurifierAction);
      }
    }
  }

  /** Stamp a server-commanded AC power-on for observed-off shadow-lag grace.
   * `at` is when the power ON was PUBLISHED (captured before the send call,
   * committed only once the send was accepted), not when the call returned. */
  private noteServerAcOn(deviceId: string, at: number = Date.now()): void {
    this.lastServerAcOnAt.set(deviceId, at);
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
          targetDeviceIds = targetDeviceIds.filter((did) => !this.isLevelerShed(did));
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
                if (this.isLevelerShed(did)) continue; // leveler shed it — not a manual off
                // A fetch gap is not an observation — never lock on undefined.
                if (power === undefined) continue;
                if (!(await this.handleObservedAcOff(`Automation "${rule.name}"`, did, deviceNames))) {
                  this.automationState.set(rule.id, { status: "idle", lastToggle: now, conditionSince: null, conditionLostAt: null, canAutoTurnOn: false });
                  continue;
                }
                // Power-event off → fall through to the re-turn-on below,
                // unless a manual-off lock exists (locks beat ALL auto-on paths).
                if (await this.isAcManualOffLocked(did)) {
                  log.info(`[collector] Automation "${rule.name}": device ${did} is manual-off locked, skipping power-event re-on`);
                  continue;
                }
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
            if (rule.device_type === "ac" && isAcLevelingEligible(did)) await this.leveling().clearShed(did, "metric_turn_off");
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
          if (await this.clearAcManualOff(deviceId)) this.notifyObservedAcLockCleared(deviceId);
        }
        if (isAcLevelingEligible(deviceId)) await this.leveling().reconcileObservedOn(deviceId);
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
    this.acProfileEnforcement.delete(this.acFanKey(ruleId, deviceId));
  }

  private acSwingKey(ruleId: number, deviceId: string): string {
    return `${ruleId}:${deviceId}`;
  }

  /** Drops a manual swing override — call on any AC power cycle the rule owns. */
  private clearAcSwingOverride(ruleId: number, deviceId: string): void {
    this.acSwingOverrides.delete(this.acSwingKey(ruleId, deviceId));
  }

  /**
   * Is a manual fan override still describing the device? Manual wins over
   * automation enforcement — but only while the AC still HAS the fan the user
   * chose.
   *
   * An observed fan of 0 is the device's BUILT-IN auto, which nothing in this
   * system can have asked for: range automations never command 0, and the
   * dashboard's A button DELETES the override rather than marking it manual
   * (`noteUserAcFanAuto`). So a `manual` flag sitting on an observed 0 is
   * pre-power-cycle intent the firmware has already eaten — the documented
   * "until the AC power cycles" release, read off the firmware's own
   * fingerprint for the cycles no clear site witnessed. This is what lets a
   * unit stuck on 'A' self-heal (live 2026-08-06: Najat, after a leveler shed +
   * restore across a grid→gen changeover).
   *
   * ⚠ RELEASED, not deleted — `notePowerCycle`'s own rule, and for its own
   * reason. This is a read-side predicate: nothing here re-sends the profile, so
   * dropping the whole entry would throw away the baseline
   * (`lastCommandedFan`/`lastFanCommandAt`) that `refreshAcFanBaseline` keeps
   * current on every leveler fan command — and `driftedRangeFan` reads that
   * entry for its `AC_FAN_SETTLE_MS` guard on the very next line, so deleting it
   * here destroyed the settle window the caller was about to consult. The five
   * rule-owned clear sites may delete because each re-sends the full profile in
   * the same breath and `noteAcFanCommanded` rebuilds the entry.
   */
  private acFanOverrideActive(ruleId: number, deviceId: string): boolean {
    const key = this.acFanKey(ruleId, deviceId);
    const entry = this.acFanEnforcement.get(key);
    if (!entry?.manual) return false;
    if (this.tclCloud?.getDeviceState(deviceId)?.fan_speed !== 0) return true;
    this.acFanEnforcement.set(key, { ...entry, manual: false });
    log.info(`[collector] AC ${deviceId}: manual fan override released — the unit is on built-in auto (power-cycle reset), resuming enforcement`);
    return false;
  }

  /**
   * Is a manual swing override still live for this rule+device? The override is
   * keyed to the slot it was taken under, so a slot change resumes enforcement.
   */
  private acSwingOverrideActive(ruleId: number, deviceId: string, slot: AutomationRangeSlot): boolean {
    const key = this.acSwingKey(ruleId, deviceId);
    const override = this.acSwingOverrides.get(key);
    if (!override) return false;
    if (override.slotId === slot.id) return true;
    this.acSwingOverrides.delete(key); // active slot changed — resume swing enforcement
    return false;
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
    if (this.acSwingOverrideActive(rule.id, deviceId, slot)) {
      delete profile.vertical_swing; // user took manual swing control — leave it untouched
    } else if (slot.vertical_swing != null) {
      // 0 (Off) is a real value — overrides the preset's swing; absent falls through.
      profile.vertical_swing = slot.vertical_swing;
    }
    if (this.acFanOverrideActive(rule.id, deviceId)) {
      // Non-Najat fan 7 == turbo — enforcing turbo would clobber a manual fan choice
      delete profile.fan_speed;
      delete profile.turbo;
    } else {
      profile.fan_speed = this.resolveRangeFan(rule, slot, deviceId, value);
    }
    this.updateAcProfileTracking(rule, slot, deviceId, profile, Date.now());
    const profileTracking = this.acProfileEnforcement.get(this.acFanKey(rule.id, deviceId));
    for (const field of profileTracking?.manual ?? []) {
      delete profile[field];
    }
    return profile;
  }

  /**
   * Establish a system baseline, then treat unexplained live-shadow drift as a
   * physical-remote/manual change. A slot/profile change clears only the fields
   * whose system intent changed. Power/source boundaries drop the whole entry
   * in notePowerCycle, causing the system profile to initialize again.
   */
  private updateAcProfileTracking(
    rule: AutomationRule,
    slot: AutomationRangeSlot,
    deviceId: string,
    profile: AcAction,
    now: number,
  ): void {
    const key = this.acFanKey(rule.id, deviceId);
    let entry = this.acProfileEnforcement.get(key);
    if (!entry || entry.slotId !== slot.id) {
      entry = { slotId: slot.id, desired: {}, baseline: {}, lastCommandAt: {}, manual: new Set() };
      this.acProfileEnforcement.set(key, entry);
    }
    const observed = this.tclCloud?.getDeviceState(deviceId);
    if (!observed) return;

    for (const field of AC_PROFILE_TRACKED_FIELDS) {
      const desired = profile[field];
      if (desired == null) {
        delete entry.desired[field];
        delete entry.baseline[field];
        delete entry.lastCommandAt[field];
        entry.manual.delete(field);
        continue;
      }
      const hadDesired = Object.prototype.hasOwnProperty.call(entry.desired, field);
      if (hadDesired && entry.desired[field] !== desired) {
        // A new preset/slot value is a new system decision and therefore a new
        // initialization boundary for this field.
        delete entry.baseline[field];
        delete entry.lastCommandAt[field];
        entry.manual.delete(field);
      }
      entry.desired[field] = desired;
      if (entry.manual.has(field)) continue;

      const liveValue = observed[field];
      if (liveValue == null) continue;
      const baseline = entry.baseline[field];
      if (baseline == null) {
        if (liveValue === desired) {
          entry.baseline[field] = desired;
          entry.lastCommandAt[field] = now;
        }
        continue;
      }
      if (liveValue === baseline) continue;
      if (now - (entry.lastCommandAt[field] ?? 0) < this.AC_FAN_SETTLE_MS) continue;
      // A power cycle's swing reset arrives through the lagging shadow seconds to
      // minutes late — past the 15s settle window, so it reads as drift — and TCL
      // firmware zeroes swing on a power-loss restart (same class as the beep
      // reset). Inside the 15-min post-cycle window (the same window `driftedRangeSwing`
      // trusts) a difference is a firmware reset, not a hand: leave the field
      // system-owned so the ordinary diff re-asserts the slot value within a tick
      // and the device self-heals. Live 2026-08-18: a grid→gen changeover flagged
      // "manual" swing on BOTH ACs within 5s, twice (08:33 and 10:22Z) — a firmware
      // reset is not two synchronized hands (hard rule 5b class). Accepted trade-off
      // (as the fan tracker and swing sweep already document): a GENUINE remote change
      // inside this window is overridden by the system profile. The dashboard hook
      // `noteUserAcProfileChange` stays ungated — a REST command is attributable.
      if (now - (this.acPowerCycleAt.get(deviceId) ?? 0) < this.AC_POWER_CYCLE_RESET_MS) continue;
      entry.manual.add(field);
      log.info(`[collector] AC range "${rule.name}": manual ${field} change on ${deviceId} (${baseline} → ${liveValue}), suspending that field until profile or power-source change`);
    }
  }

  private noteAcProfileCommanded(
    rule: AutomationRule,
    slot: AutomationRangeSlot,
    deviceId: string,
    sent: AcAction,
  ): void {
    const key = this.acFanKey(rule.id, deviceId);
    let entry = this.acProfileEnforcement.get(key);
    if (!entry || entry.slotId !== slot.id) {
      entry = { slotId: slot.id, desired: {}, baseline: {}, lastCommandAt: {}, manual: new Set() };
      this.acProfileEnforcement.set(key, entry);
    }
    const now = Date.now();
    for (const field of AC_PROFILE_TRACKED_FIELDS) {
      const value = sent[field];
      if (value == null) continue;
      entry.desired[field] = value;
      entry.baseline[field] = value;
      entry.lastCommandAt[field] = now;
      entry.manual.delete(field);
    }
  }

  /**
   * Detects manual fan changes (shadow drift vs the fan we last commanded) and
   * resets the bookkeeping when the active range slot changes. Call before
   * computing the enforcement diff.
   */
  private updateAcFanTracking(rule: AutomationRule, slot: AutomationRangeSlot, deviceId: string, value: number, now: number): void {
    // While the leveler holds the fan down (last try before a shed), the drift
    // is ours — don't misread it as a manual change.
    if (this.hasLevelerFanHold(deviceId)) return;
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
    if (observed === entry.lastCommandedFan) {
      // A slot whose fan already matches what the firmware restored sends no
      // diff, so `noteAcFanCommanded` never clears `initializationPending` and
      // the marker persists indefinitely — swallowing the NEXT genuine remote
      // fan change (hours later). Clear it here, but ONLY on a FRESH post-cycle
      // report: right after the cycle the cached shadow still shows pre-event
      // state that can coincidentally equal the system fan, and clearing on that
      // stale match would let the real reboot echo (arriving later with
      // firmware-memory fan) be misread as a manual change — the exact bug this
      // flag exists to stop. No lastSeenAt → keep the flag.
      if (entry.initializationPending) {
        const lastSeenAt = this.tclCloud?.getDevices().find((d) => d.id === deviceId)?.lastSeenAt;
        const cycleAt = this.acPowerCycleAt.get(deviceId);
        if (lastSeenAt != null && cycleAt != null && lastSeenAt > cycleAt) {
          const { initializationPending: _cleared, ...rest } = entry;
          this.acFanEnforcement.set(key, rest);
        }
      }
      return;
    }
    // The first post-cycle shadow is firmware/remote memory, not a new manual
    // decision. Keep the system fan in the effective profile so this tick
    // reasserts it; noteAcFanCommanded clears this initialization marker.
    if (entry.initializationPending) return;
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
    if (sent.fan_speed != null) {
      this.acFanEnforcement.set(this.acFanKey(rule.id, deviceId), {
        slotId: slot.id,
        lastCommandedFan: sent.fan_speed,
        lastFanCommandAt: Date.now(),
        manual: false,
      });
    }
    this.noteAcProfileCommanded(rule, slot, deviceId, sent);
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
    if (isAcLevelingEligible(deviceId)) void this.leveling().onUserFanChange(deviceId);
    let dropped = false;
    for (const key of this.acFanEnforcement.keys()) {
      if (key.endsWith(`:${deviceId}`)) {
        this.acFanEnforcement.delete(key);
        dropped = true;
      }
    }
    // Say what actually happens next. A stale entry can outlive its rule (live
    // 2026-09-26: the owner's rule was disabled and this still claimed smart
    // auto resumed), so name the ENABLED range rules that now own the fan.
    const owners = this.automationRules.filter(
      (rule) =>
        rule.enabled !== false &&
        rule.device_type === "ac" &&
        rule.automation_type === "metric" &&
        rule.threshold_low != null &&
        (rule.device_ids ?? [rule.device_id]).includes(deviceId),
    );
    if (owners.length > 0) {
      // …and what each owner will actually do with it: the active slot's fan is
      // smart auto (no fixed gear) or a fixed gear, or no slot is active now and
      // nothing is enforced until one is.
      const what = owners.map((rule) => {
        const slot = findActiveRangeSlot(
          rule.range_slots ?? getLegacyRangeSlots(rule.threshold_low!, rule.threshold!),
          getBaghdadMinutes(),
          (prayer, offset) => this.resolvePrayerMinutes(prayer, offset),
        );
        if (!slot) return `"${rule.name}" (no active slot: nothing enforced until one starts)`;
        return slot.fan_speed != null && slot.fan_speed >= 1
          ? `"${rule.name}" (slot "${slot.id}": fixed fan ${slot.fan_speed})`
          : `"${rule.name}" (slot "${slot.id}": smart auto)`;
      });
      log.info(`[collector] AC ${deviceId}: user fan Auto: fan handed back to range rule(s) ${what.join(", ")}`);
    } else {
      log.info(
        `[collector] AC ${deviceId}: user fan Auto: no enabled range rule owns this AC` +
          `${dropped ? " (stale fan enforcement dropped)" : ""}; the unit stays on its built-in auto`,
      );
    }
  }

  /**
   * UI gen-level change → record + delegate to the leveler. For a leveler-managed
   * AC the leveler owns the intent (manualCap/manualTarget); for an UNMANAGED AC
   * (leveling off / opted out) the recorded timestamp suppresses range
   * generator_mode re-enforcement so the manual level isn't slammed back.
   */
  noteUserAcGenLevel(deviceId: string): void {
    this.lastUserGenChangeAt.set(deviceId, Date.now());
  }

  onUserAcGenLevel(deviceId: string, level: number): Promise<{ reverted: boolean; level: number }> {
    this.noteUserAcGenLevel(deviceId);
    if (!isAcLevelingEligible(deviceId)) return Promise.resolve({ reverted: false, level });
    return this.leveling().onUserGenLevel(deviceId, level);
  }

  /** A manual gen-level change is still "active" (suppresses range re-enforcement). */
  private hasRecentUserGenChange(deviceId: string): boolean {
    const at = this.lastUserGenChangeAt.get(deviceId);
    return at != null && Date.now() - at < this.AC_USER_GEN_OVERRIDE_MS;
  }

  /** UI fan/turbo change — suspend fan enforcement immediately (no settle-window race). */
  noteUserAcFanChange(deviceId: string): void {
    if (isAcLevelingEligible(deviceId)) void this.leveling().onUserFanChange(deviceId);
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

  /** Direct dashboard control: record manual ownership immediately rather than
   * waiting for the next live shadow to drift past the settle window. */
  noteUserAcProfileChange(deviceId: string, command: string): void {
    const field = AC_COMMAND_PROFILE_FIELD[command];
    if (!field) return;
    for (const rule of this.automationRules) {
      if (rule.device_type !== "ac" || rule.automation_type !== "metric" || rule.threshold_low == null) continue;
      if (!(rule.device_ids ?? [rule.device_id]).includes(deviceId)) continue;
      const slot = findActiveRangeSlot(
        rule.range_slots ?? getLegacyRangeSlots(rule.threshold_low, rule.threshold),
        getBaghdadMinutes(),
        (prayer, offset) => this.resolvePrayerMinutes(prayer, offset),
      );
      if (!slot) continue;
      const key = this.acFanKey(rule.id, deviceId);
      let entry = this.acProfileEnforcement.get(key);
      if (!entry || entry.slotId !== slot.id) {
        entry = { slotId: slot.id, desired: {}, baseline: {}, lastCommandAt: {}, manual: new Set() };
        this.acProfileEnforcement.set(key, entry);
      }
      entry.manual.add(field);
      log.info(`[collector] AC ${deviceId}: user ${field} change — suspending that field for rule "${rule.name}"`);
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
        let unlockedDeviceIds = deviceIds.filter((did) => !lockedIds.has(did) && !this.isLevelerShed(did));
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
                if (diff && !this.holdRangeEnforcementForBoot(did)) {
                  log.info(`[collector] AC range "${rule.name}": device ${did} is ON while locked, adopting with diff: ${JSON.stringify(diff)}`);
                  const execution = await this.tclCloud!.executeAcAction(did, diff, {
                    suppressWhileManualPresetPending: true,
                  });
                  if (execution !== "suppressed") this.noteAcFanCommanded(rule, activeSlot, did, diff);
                }
                this.automationState.set(rule.id, { status: "triggered", lastToggle: now, conditionSince: null, conditionLostAt: null, canAutoTurnOn: false });
                return;
              }
              log.info(`[collector] AC range "${rule.name}": device ${did} is manual-off locked, skipping auto-on`);
            } catch (err) {
              log.error(`[collector] AC range "${rule.name}" lock-check failed for ${did}:`, (err as Error).message);
            }
          }
          unlockedDeviceIds = deviceIds.filter((did) => !this.acManualOffLocks.has(did) && !this.isLevelerShed(did));
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
                if (isAcLevelingEligible(did)) await this.leveling().rememberStableLevel(did);
                await this.executeAutomationAction(rule, { power: 0 } as AcAction, [did]);
                this.acRangeOffAt.set(did, now);
                this.devicePowerCache.set(did, { power: "off", ts: Date.now() });
              } else {
                this.updateAcFanTracking(rule, activeSlot, did, value, now);
                const { power: _p, ...profileOnly } = this.effectiveAcRangeProfile(rule, activeSlot, did, value);
                const diff = this.tclCloud!.computeAcDiff(did, this.stripLeveledControls(rule, profileOnly, did));
                if (diff && !this.holdRangeEnforcementForBoot(did)) {
                  log.info(`[collector] AC range "${rule.name}": device ${did} is ON in dead zone (${rule.metric}=${value}), adopting with diff: ${JSON.stringify(diff)}`);
                  const execution = await this.tclCloud!.executeAcAction(did, diff, {
                    suppressWhileManualPresetPending: true,
                  });
                  if (execution !== "suppressed") this.noteAcFanCommanded(rule, activeSlot, did, diff);
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
          for (const did of deviceIds.filter(isAcLevelingEligible)) await this.leveling().rememberStableLevel(did);
          await this.executeAutomationAction(rule, { power: 0 } as AcAction, deviceIds);
          // The automation owns the OFF now — a leveler shed must not restore it
          for (const did of deviceIds) {
            if (isAcLevelingEligible(did)) await this.leveling().clearShed(did, "range_turn_off");
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
              if (this.isLevelerShed(did)) continue; // leveler shed it — not a manual off
              // A fetch gap is not an observation — never lock on undefined.
              if (power === undefined) continue;
              // Our own recent off still propagating is not an external off.
              if (now - (this.acRangeOffAt.get(did) ?? 0) < this.AC_OFF_REFIRE_GRACE_MS) continue;
              // Classify FIRST: the fan-0 power-loss fingerprint reads the fan we
              // last commanded (`lastCommandedFan`), and the clears below delete
              // it; in the old order that fingerprint was dead at this site.
              const resume = await this.handleObservedAcOff(`AC range "${rule.name}"`, did, deviceNames);
              this.clearAcFanEnforcement(rule.id, did); // power cycle — fan intent resets
              this.clearAcSwingOverride(rule.id, did);  // and swing intent resets
              if (resume) {
                // Locks beat ALL auto-on paths — even the power-event resume.
                if (await this.isAcManualOffLocked(did)) {
                  log.info(`[collector] AC range "${rule.name}": device ${did} is manual-off locked, skipping power-event re-on`);
                  this.automationState.set(rule.id, { status: "idle", lastToggle: now, conditionSince: null, conditionLostAt: null, canAutoTurnOn: false });
                  return;
                }
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
            if (diff && !this.holdRangeEnforcementForBoot(did)) {
              log.info(`[collector] AC range "${rule.name}": re-enforcing diff for ${did}: ${JSON.stringify(diff)}`);
              const execution = await this.tclCloud!.executeAcAction(did, diff, {
                suppressWhileManualPresetPending: true,
              });
              if (execution !== "suppressed") this.noteAcFanCommanded(rule, activeSlot, did, diff);
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
        if (isAcLevelingEligible(did)) await this.leveling().clearShed(did, "outside_range_off");
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

  /**
   * Beep-style enforcement sweep for the two channels the diff path can lose:
   * fan and vertical swing (added 2026-08-06).
   *
   * `checkAcRangeAutomation` only re-enforces along its own state machine — and
   * a device it is skipping (shed, an off it never saw, a lagging shadow) is
   * exactly the device whose fan came back as built-in auto. This sweep asks
   * the same question `checkAcBeepEnforcement` asks about the buzzer, once a
   * tick, independent of that state machine: does the shadow still carry what
   * the active slot resolves to? It never fights the leveler (fan holds and
   * sheds stand it down), never fights the user (a live manual override stands
   * it down), and never fights itself (30s per-device cooldown + the 15s fan
   * settle window).
   */
  private async checkAcRangeEnforcement(): Promise<void> {
    if (!this.tclCloud || !this.tclCloud.isReady()) return;
    if (this.acCalibrator.isActive()) return; // calibration owns the ACs
    const now = Date.now();
    const devices = this.tclCloud.getDevices();
    this.observeLevelerShedEdges(devices.filter((dev) => isAcLevelingEligible(dev.id)).map((dev) => dev.id));
    if (devices.length === 0) return;

    for (const rule of this.automationRules) {
      if (rule.device_type !== "ac" || rule.automation_type !== "metric" || rule.threshold_low == null) continue;
      if (!rule.metric) continue;
      const def = ALERT_METRICS[rule.metric];
      if (!def) continue;
      // Same freshness bars the rule itself uses — a stale metric resolves a
      // smart-auto fan from a temperature nobody can vouch for.
      if (def.source === "weather" && (!this.latestWeatherTs || now - this.latestWeatherTs.getTime() > 300_000)) continue;
      if (def.source === "air" && (!this.latestAirTs || now - this.latestAirTs.getTime() > 300_000)) continue;
      if (def.source === "power" && (!this.latestPowerTs || now - this.latestPowerTs.getTime() > 60_000)) continue;
      const value = getMetricValue(rule.metric, this.latestWeatherRow, this.latestAirRow, this.latestPowerRow);
      if (value == null) continue;
      const slot = findActiveRangeSlot(
        rule.range_slots ?? getLegacyRangeSlots(rule.threshold_low, rule.threshold),
        getBaghdadMinutes(),
        (prayer, offset) => this.resolvePrayerMinutes(prayer, offset),
      );
      if (!slot) continue; // outside every window — this rule owes the device an OFF, not a fan
      const isCool = (rule.action_on as Record<string, unknown>).mode === 1;
      const shouldTurnOff = isCool ? value <= slot.threshold_low : value >= slot.threshold;
      if (shouldTurnOff) continue; // ditto: don't dress a device the rule is about to switch off

      for (const deviceId of rule.device_ids ?? [rule.device_id]) {
        const dev = devices.find((d) => d.id === deviceId);
        if (!dev) continue; // not in the shared cache — nothing observed to compare against
        try {
          await this.enforceAcFanSwing(rule, slot, dev, value, now);
        } catch (err) {
          log.warn(`[collector] AC range "${rule.name}": fan/swing enforcement failed for ${deviceId}: ${(err as Error).message}`);
        }
      }
    }
  }

  /**
   * Post-changeover boot hold-off (2026-08-18): true when a BACKGROUND range
   * enforcement send must be SKIPPED this tick because the unit is still booting
   * after a real source transition power-cycled it — retried next tick.
   *
   * A gen→grid changeover at 14:28:20Z power-cycled the ESP-line ACs; 25 s later
   * the range diff re-enforcement landed `{fan_speed:7, vertical_swing:10,
   * horizontal_swing:11}` on CA5IMhFAAAE, still booting. The firmware ECHOED it
   * into the shadow (reported turbo=1, so `computeAcDiff` saw "no diff" forever)
   * but never physically applied it — the fan ran quiet until the user hand-
   * cycled 7→6→7 at 14:57Z. The lying shadow makes `sendControlVerified` /
   * confirm-or-resend / the enforcement sweep all blind by construction (hard
   * rule 5b adjacent: the shadow near a power event is NOT the device), so the
   * only server-side lever is to stop commanding a unit while it boots. The unit
   * must therefore PROVE it finished booting — its first fresh post-event shadow
   * report — before background enforcement commands it, capped at
   * `BOOT_HOLDOFF_MAX_MS` so nothing blocks forever.
   *
   * Freshness bar (`lastSeenAt == null || lastSeenAt <= cycleAt`) mirrors the
   * `initializationPending` clear in `updateAcFanTracking`. Scope: only real
   * source transitions arm this (`acSourceCycleAt`). NOT gated elsewhere: user
   * commands, timers, schedule/metric turn-ONs (power:1 wakes the unit; the 3s
   * boot delay + profile path already orders that), leveler commands (their own
   * physics), and the manual preset path. Logged once per device per episode.
   */
  private holdRangeEnforcementForBoot(deviceId: string): boolean {
    const cycleAt = this.acSourceCycleAt.get(deviceId);
    if (cycleAt == null) return false;
    if (Date.now() - cycleAt >= this.BOOT_HOLDOFF_MAX_MS) return false; // capped — sends resume even if the shadow stays silent
    const lastSeenAt = this.tclCloud?.getDevices().find((d) => d.id === deviceId)?.lastSeenAt ?? null;
    if (lastSeenAt != null && lastSeenAt > cycleAt) return false; // reported fresh post-event → boot finished, enforce
    if (this.acBootHoldLoggedAt.get(deviceId) !== cycleAt) {
      this.acBootHoldLoggedAt.set(deviceId, cycleAt);
      log.info(`[collector] AC ${deviceId}: holding range enforcement — unit is booting after a changeover (shadow not fresh yet)`);
    }
    return true;
  }

  /** One device of `checkAcRangeEnforcement` — gates, then at most one re-assert per channel. */
  private async enforceAcFanSwing(
    rule: AutomationRule,
    slot: AutomationRangeSlot,
    dev: AcDevice,
    value: number,
    now: number,
  ): Promise<void> {
    const deviceId = dev.id;
    if (!dev.power) return; // off — the range/leveler paths own bringing it back
    const leveling = this.leveling();
    if (leveling.isShed(deviceId)) return; // leveler owns a shed device
    if (leveling.hasFanHold(deviceId)) return; // leveler owns the fan channel while it holds it
    // The rule's OWN cooldown, and it is not redundant with the per-device one
    // below: manual-fan detection lives in `updateAcFanTracking`, which the
    // rule's turn-on, locked-adopt and power-event re-turn-on paths all bypass —
    // each stamps `lastToggle: now` and RETURNS before tracking runs. Inside
    // `cooldown_secs` of one of those, no tick has yet had the chance to notice
    // a remote/app fan change, so a sweep firing there reverts the user within
    // 30 s and never records the override at all. Waiting out the rule's own
    // cooldown guarantees manual detection gets a tick first. (Review,
    // 2026-08-06; the sweep landed without any lastToggle gate.)
    const ruleState = this.automationState.get(rule.id);
    if (ruleState != null && now - ruleState.lastToggle < (rule.cooldown_secs ?? 5) * 1000) return;
    // Our own commands still in flight: an off just sent, a turn-on still
    // booting, or a previous sweep send inside its cooldown.
    if (now - (this.acRangeOffAt.get(deviceId) ?? 0) < this.AC_OFF_REFIRE_GRACE_MS) return;
    if (now - (this.lastServerAcOnAt.get(deviceId) ?? 0) < this.AC_FAN_SETTLE_MS) return;
    if (now - (this.acEnforceLastSent.get(deviceId) ?? 0) < this.AC_ENFORCE_RESEND_COOLDOWN_MS) return;
    // A command into a unit still booting after a changeover is echoed into the
    // shadow but never applied — the lying shadow blinds every verify path, so
    // hold until it reports fresh post-event (2026-08-18; holdRangeEnforcementForBoot).
    if (this.holdRangeEnforcementForBoot(deviceId)) return;

    const fan = this.driftedRangeFan(rule, slot, dev, value, now);
    const swing = this.driftedRangeSwing(rule, slot, dev, now);
    if (fan == null && swing == null) return;
    this.acEnforceLastSent.set(deviceId, now);
    let sent = false;
    // One property per send: on a TAC-12CHSD the fan block is silently dropped
    // when it shares an update with anything else (tcl-ac.md, "the fan block
    // must travel ALONE").
    if (fan != null) {
      log.info(`[collector] AC range "${rule.name}": ${deviceId} fan drifted to ${dev.fanSpeed}, re-asserting ${fan}`);
      const execution = await this.tclCloud!.executeAcAction(deviceId, { fan_speed: fan }, {
        suppressWhileManualPresetPending: true,
      });
      if (execution !== "suppressed") {
        sent = true;
        this.noteAcFanCommanded(rule, slot, deviceId, { fan_speed: fan });
      }
    }
    if (swing != null) {
      log.info(`[collector] AC range "${rule.name}": ${deviceId} swing drifted to ${dev.verticalSwing} after a power cycle, re-asserting ${swing}`);
      const execution = await this.tclCloud!.executeAcAction(deviceId, { vertical_swing: swing }, {
        suppressWhileManualPresetPending: true,
      });
      if (execution !== "suppressed") sent = true;
    }
    if (!sent) this.acEnforceLastSent.delete(deviceId);
  }

  /** The slot's resolved fan when the shadow has drifted off it, else null. */
  private driftedRangeFan(
    rule: AutomationRule,
    slot: AutomationRangeSlot,
    dev: AcDevice,
    value: number,
    now: number,
  ): number | null {
    if (this.acFanOverrideActive(rule.id, dev.id)) return null; // manual wins
    const entry = this.acFanEnforcement.get(this.acFanKey(rule.id, dev.id));
    if (entry && now - entry.lastFanCommandAt < this.AC_FAN_SETTLE_MS) return null; // our own send, still landing
    const desired = this.resolveRangeFan(rule, slot, dev.id, value);
    return dev.fanSpeed === desired ? null : desired;
  }

  /**
   * The slot's pinned swing when a POWER CYCLE has knocked the device off it.
   *
   * Swing deliberately has no drift detection (its power-loss reset value is
   * unknown), so a mid-session difference stays what it has always been — the
   * ordinary `computeAcDiff` re-enforcement's business, not this sweep's. Only
   * inside the window after an attributable power cycle is a difference known
   * to be a firmware reset, and only then does the sweep speak.
   */
  private driftedRangeSwing(
    rule: AutomationRule,
    slot: AutomationRangeSlot,
    dev: AcDevice,
    now: number,
  ): number | null {
    if (slot.vertical_swing == null) return null; // nothing pinned for this slot
    if (this.acSwingOverrideActive(rule.id, dev.id, slot)) return null; // manual wins
    if (this.acProfileEnforcement.get(this.acFanKey(rule.id, dev.id))?.manual.has("vertical_swing")) return null;
    if (now - (this.acPowerCycleAt.get(dev.id) ?? 0) > this.AC_POWER_CYCLE_RESET_MS) return null;
    return dev.verticalSwing === slot.vertical_swing ? null : slot.vertical_swing;
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
            if (rule.device_type === "ac" && this.isLevelerShed(did)) continue; // leveler shed it
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
              if (rule.device_type === "ac" && isAcLevelingEligible(did)) await this.leveling().clearShed(did, "schedule_turn_off");
            } catch (err) {
              log.error(`[collector] Schedule "${rule.name}" turn-off failed for ${did}:`, (err as Error).message);
            }
          }
        }
        this.automationState.set(rule.id, { status: "idle", lastToggle: now, conditionSince: null, conditionLostAt: null, canAutoTurnOn: true });
      }
    }
  }

  /**
   * "Turn off once back online" (owner request 2026-10-09; TclCloud stores the
   * arms). The armed OFF resolves HERE, in its own loop step right before the
   * automations, never inside a device fetch (a fetch only observes). It is a
   * plain server-commanded OFF (owner decision 2026-10-10: the manual-off lock
   * was tried and dropped): nothing on this path reads, records or clears a
   * lock, and the OFF is booked at its publish boundary so the observed-off
   * classifier never takes it for a human's (`isOffWhenOnlineOff`). An OFF any
   * device fetch sees ends the arm in that fetch (TclCloud); this step pins it
   * as our OFF's report when it is one. Each armed device is claimed (token and
   * lease) BEFORE the snapshot is read, so an operation that runStep
   * abandoned, or that outlived its lease, is taken over and can then neither
   * publish nor change the arm. With the cloud not ready it drives the
   * throttled re-auth itself: no automation rule may exist.
   */
  private async checkOffWhenOnline(): Promise<void> {
    const tcl = this.tclCloud;
    if (!tcl) return;
    this.pinSeenOffWhenOnlineOffs(tcl);
    const arms = tcl.getOffWhenOnlineArms();
    if (arms.length === 0) return;
    if (!tcl.isReady()) {
      this.maybeReauthTclCloud();
      return;
    }
    const claimed: Array<{ arm: OffWhenOnlineArm; token: number }> = [];
    for (const arm of arms) {
      const token = tcl.claimOffWhenOnline(arm.deviceId);
      if (token != null) claimed.push({ arm, token });
    }
    if (claimed.length === 0) return;
    try {
      const devices = await tcl.getDevicesNoOlderThan(this.OFF_WHEN_ONLINE_SNAPSHOT_MAX_AGE_MS);
      // That snapshot's own fetch may have ended an arm on an OFF.
      this.pinSeenOffWhenOnlineOffs(tcl);
      for (const { arm, token } of claimed) {
        const device = devices.find((d) => d.id === arm.deviceId);
        if (!device) continue;
        try {
          await this.stepOffWhenOnline(tcl, arm, token, device);
        } catch (err) {
          log.warn(`[collector] Off-when-back-online for ${arm.deviceId} failed: ${(err as Error).message}`);
        }
      }
    } finally {
      for (const { arm, token } of claimed) tcl.releaseOffWhenOnline(arm.deviceId, token);
    }
  }

  private async stepOffWhenOnline(tcl: TclCloud, arm: OffWhenOnlineArm, token: number, device: AcDevice): Promise<void> {
    // An arm a device fetch ended on an OFF (our OFF landing, or the unit
    // coming back OFF) is no longer current: no further OFF, even when the unit
    // reads ON again by now (someone switched it back on, and they win, hard
    // rule 7).
    if (!tcl.isOffWhenOnlineOperationCurrent(arm, token)) return;
    // AWS metadata is second-resolution: only a report strictly after the arm
    // and the last power epoch proves the unit came back (the stale offline
    // shadow still says ON), and only a CURRENT one proves it is still there,
    // so a brief report followed by another outage spends nothing. The epoch
    // this gate read goes with the send: a newer one stops it at its publish.
    const reportedAt = device.lastSeenAt;
    const gatedEpochAt = arm.epochAt;
    if (!device.isOnline || reportedAt == null || reportedAt <= Math.max(arm.armedAt, gatedEpochAt)) return;
    if (!device.power) {
      this.pinOffWhenOnlineOff(arm.deviceId, device.powerReportedAt ?? null);
      tcl.finishOffWhenOnline(arm, token, arm.attempts > 0 ? "done: unit reported OFF" : "done: unit reported OFF, nothing sent");
      return;
    }
    const now = Date.now();
    if (arm.attempts >= OFF_WHEN_ONLINE_MAX_ATTEMPTS) {
      if (now - arm.lastSentAt < OFF_WHEN_ONLINE_RESEND_MS) return;
      tcl.finishOffWhenOnline(arm, token, `gave up: still ON after ${arm.attempts} OFF sends`, "warn");
      return;
    }
    if (arm.attempts > 0 && now - arm.lastSentAt < OFF_WHEN_ONLINE_RESEND_MS) return;
    // Each publish appends its own record at its boundary, so a fast echo of
    // our OFF is never taken for a human's. This operation owns the records it
    // appended and voids only those: all of them when the cloud did not accept
    // the send (rejected or superseded), and all but the last when it did (a
    // re-auth retry publishes again only after a 403 refused the publish
    // before it). Another operation's record is never touched, so an old
    // operation's rollback can never take back a newer accepted OFF.
    const published: OffWhenOnlineOffRecord[] = [];
    let accepted = false;
    try {
      accepted = await tcl.sendOffWhenOnline(
        arm,
        token,
        () => published.push(this.noteOffWhenOnlineOffPublished(arm.deviceId)),
        gatedEpochAt,
      ) === "sent";
    } finally {
      const kept = accepted ? published[published.length - 1] : undefined;
      for (const record of published) if (record !== kept) record.voided = true;
    }
  }

  /**
   * Record an off-when-online OFF at its publish boundary: a new record of its
   * own, appended to the device's list (`offWhenOnlineOffs`). Returned to the
   * publishing operation, the only one that may void it.
   */
  private noteOffWhenOnlineOffPublished(deviceId: string): OffWhenOnlineOffRecord {
    const record: OffWhenOnlineOffRecord = { id: ++this.offWhenOnlineOffSeq, publishedAt: Date.now(), voided: false, reportAt: null };
    this.offWhenOnlineOffs.set(deviceId, [...this.offWhenOnlineOffRecords(deviceId), record]);
    return record;
  }

  /**
   * The device's records that can still count, and the list pruned to them so
   * it stays bounded. A voided publish, one a newer server ON voided, and an
   * unmatched one past its expiry can never make an OFF ours again. A pinned
   * one stays, whatever newer pins follow: a fetch that answers late can
   * present its older OFF again, and dropping it would read our own OFF as a
   * human's (2026-10-10 repair). Past OFF_WHEN_ONLINE_RECORD_CAP the oldest
   * go (records are appended in publish order). Only the list is replaced: no
   * record is changed.
   */
  private offWhenOnlineOffRecords(deviceId: string): OffWhenOnlineOffRecord[] {
    const records = this.offWhenOnlineOffs.get(deviceId);
    if (!records) return [];
    const now = Date.now();
    const serverOnAt = this.lastServerAcOnAt.get(deviceId) ?? 0;
    const kept = records
      .filter((record) => offWhenOnlineOffCounts(record, serverOnAt))
      .filter((record) => record.reportAt != null || now - record.publishedAt < this.AC_POWER_EVENT_GRACE_MS)
      .slice(-OFF_WHEN_ONLINE_RECORD_CAP);
    if (kept.length > 0) this.offWhenOnlineOffs.set(deviceId, kept);
    else this.offWhenOnlineOffs.delete(deviceId);
    return kept;
  }

  /**
   * Classify an OFF (power report `reportAt`) against the device's records
   * (`classifyOffWhenOnlineOff`) and pin the records it matched for the first
   * time, so the same OFF reads as ours to every later look.
   */
  private matchOffWhenOnlineOff(deviceId: string, reportAt: number | null): boolean {
    const records = this.offWhenOnlineOffRecords(deviceId);
    if (records.length === 0) return false;
    const serverOnAt = this.lastServerAcOnAt.get(deviceId) ?? 0;
    const { ours, firstMatch } = classifyOffWhenOnlineOff(records, reportAt, serverOnAt, Date.now(), this.AC_POWER_EVENT_GRACE_MS);
    for (const record of firstMatch) record.reportAt = reportAt;
    return ours;
  }

  /** Pin the OFFs device fetches ended arms on (`TclCloud.takeOffWhenOnlineSeenOffs`). Optional call: test doubles of the cloud predate it. */
  private pinSeenOffWhenOnlineOffs(tcl: TclCloud): void {
    for (const [deviceId, reportAt] of tcl.takeOffWhenOnlineSeenOffs?.() ?? []) this.pinOffWhenOnlineOff(deviceId, reportAt);
  }

  /**
   * An arm ended on an OFF (power report `reportAt`): pin it as our OFF's
   * report when it is one (`matchOffWhenOnlineOff`). An unmatched record past
   * the shadow-lag allowance has expired first: it is never pinned, since a
   * pin would make that late OFF ours for good.
   */
  private pinOffWhenOnlineOff(deviceId: string, reportAt: number | null): void {
    if (reportAt != null) this.matchOffWhenOnlineOff(deviceId, reportAt);
  }

  /**
   * Is the OFF a rule just observed our own off-when-online OFF? Only a record
   * no server ON (dashboard, automation, timer) came after counts. The unit's
   * OFF is ours when it is the first power report at or after such a publish
   * (AWS stamps whole seconds); that report is pinned, so the same OFF reads as
   * ours to every rule for as long as it stands, while a LATER OFF (after an
   * ON) is judged as before. An unmatched record expires after the shadow-lag
   * allowance the power-event window uses: an OFF that took longer to show is
   * not ours. Only the powerSwitch report dates an OFF (other fields re-stamp
   * while the unit sits OFF); one the snapshot cannot date (no such metadata,
   * or the snapshot already reads ON again) is ours while a record is matched
   * or fresh.
   */
  private isOffWhenOnlineOff(deviceId: string): boolean {
    if (!this.offWhenOnlineOffs.has(deviceId)) return false;
    const dev = this.tclCloud?.getDevices().find((d) => d.id === deviceId);
    const reportAt = dev && !dev.power ? (dev.powerReportedAt ?? null) : null;
    return this.matchOffWhenOnlineOff(deviceId, reportAt);
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
          if (isAcLevelingEligible(deviceId)) await this.leveling().clearShed(deviceId, "timer_off");
          log.info(`[collector] AC timer: turned OFF device ${deviceId}`);
        } else {
          if (this.isLevelerShed(deviceId)) {
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
          const sentAt = Date.now(); // the power ON publishes first; see executeAutomationAction
          try {
            await this.tclCloud.executeAcAction(deviceId, action);
          } catch (err) {
            if (!isPowerAcceptedError(err)) throw err;
            // The AC is coming ON; only the preset profile failed.
            log.warn(`[collector] AC timer: ${err.message}; the ON counts as sent`);
          }
          this.noteServerAcOn(deviceId, sentAt);
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
    return isAcLevelingEligible(deviceId)
      && this.leveling().isEnabled()
      && !this.acRuleOptsOutOfLeveling(deviceId);
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
  private stripGenIfLeveled<T extends PurifierAction | AcAction>(rule: AutomationRule, action: T, deviceId: string): T {
    if (rule.device_type !== "ac" || !isAcLevelingEligible(deviceId) || rule.smart_leveling === false || !this.leveling().isEnabled()) {
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
    let stripped = this.stripGenIfLeveled(rule, action, deviceId);
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
    if (rule.device_type !== "ac" || !this.hasLevelerFanHold(deviceId)) return stripped;
    const { fan_speed: _f, turbo: _t, ...rest } = stripped as AcAction;
    return rest as T;
  }

  /**
   * Need for the leveler: ACs with an active range automation use the same
   * room metric vs the active slot; others use the AC's internal sensor vs the
   * comfort target (heat mode inverts the comparison). The delta (°C past the
   * satisfied point) orders raises and shed selection. The active slot's
   * gen_level rides along as the leveler's hard cap for this device.
   *
   * `slotKey` names the automation regime this device is under, so the leveler
   * can release a manual pin when it changes (2026-09-05). Three encodings, and
   * the difference between the last two matters:
   *  - `"<ruleId>:<slotId>"`  an active slot with a live metric value;
   *  - `"<ruleId>:inactive"`  every matching rule is out of window: the regime
   *                           is KNOWN, and it is "off";
   *  - `null`                 UNKNOWN (no matching rule at all, or an active
   *                           slot whose metric had no value this tick), which
   *                           the leveler neither compares nor stores.
   * The rule id is part of the key because one device can be targeted by more
   * than one rule (the fan/swing trackers key on `${ruleId}:${deviceId}` for the
   * same reason).
   */
  private computeAcNeed(
    deviceId: string,
    device: AcDevice,
  ): { tier: NeedTier; delta: number; slotGenCap: number | null; slotKey: string | null } {
    /** The first matching rule that is merely out of window: it owns the "inactive" key. */
    let firstInactiveRuleId: number | null = null;
    /** A matching rule IS in window but its metric had no value: the regime is unknown. */
    let sawActiveWithoutValue = false;
    for (const rule of this.automationRules) {
      if (rule.device_type !== "ac" || rule.automation_type !== "metric" || rule.threshold_low == null) continue;
      if (!(rule.device_ids ?? [rule.device_id]).includes(deviceId)) continue;
      if (!rule.metric) continue;
      // A matching metric rule bypasses the per-AC need override entirely: this
      // branch reads a WEATHER/AIR metric against the slot's own limits, never
      // the AC's internal thermometer, so neither the sensor calibration nor
      // the own-setpoint target has anything to correct here.
      const slot = findActiveRangeSlot(
        rule.range_slots ?? getLegacyRangeSlots(rule.threshold_low, rule.threshold),
        getBaghdadMinutes(),
        (prayer, offset) => this.resolvePrayerMinutes(prayer, offset),
      );
      if (!slot) {
        firstInactiveRuleId ??= rule.id;
        continue;
      }
      const value = getMetricValue(rule.metric, this.latestWeatherRow, this.latestAirRow, this.latestPowerRow);
      if (value == null) {
        sawActiveWithoutValue = true;
        continue;
      }
      const isCool = (rule.action_on as Record<string, unknown>).mode === 1;
      const slotGenCap = slot.gen_level ?? null;
      const slotKey = `${rule.id}:${slot.id}`;
      if (isCool) {
        return {
          tier: computeNeedTier({ kind: "range", value, slotLow: slot.threshold_low, slotHigh: slot.threshold }),
          delta: value - slot.threshold_low,
          slotGenCap,
          slotKey,
        };
      }
      // Heat: need grows as the value drops below the low limit — negate to reuse the cool mapping
      return {
        tier: computeNeedTier({ kind: "range", value: -value, slotLow: -slot.threshold, slotHigh: -slot.threshold_low }),
        delta: slot.threshold - value,
        slotGenCap,
        slotKey,
      };
    }
    // No rule governed this tick. A metric gap beats an inactive rule: an active
    // window whose value is missing says nothing about the regime, and reporting
    // it as "inactive" would be a boundary the automation never crossed.
    const slotKey = sawActiveWithoutValue || firstInactiveRuleId == null ? null : `${firstInactiveRuleId}:inactive`;
    if (!device.currentTemp || device.currentTemp <= 0) return { tier: "mild", delta: 1, slotGenCap: null, slotKey };
    // Per-AC corrections to this room's OWN comfort question (config-driven, no
    // device ids in code). `tempOffsetC` calibrates a thermometer that reads
    // high or low; `targetFromSetpoint` says this occupant's target is what he
    // set on the AC, not the shared household one (user, 2026-08-05: "consider
    // the room temp is what we get from the AC − 1°C, and the target is what is
    // set"). A setpoint of 0 is not a setpoint — fall back to the shared target
    // rather than declaring the room 27°C too hot.
    const override = isAcLevelingEligible(deviceId) ? this.leveling().getNeedOverride(deviceId) : undefined;
    const roomTemp = device.currentTemp + (override?.tempOffsetC ?? 0);
    const target =
      override?.targetFromSetpoint && device.targetTemp != null && device.targetTemp > 0
        ? device.targetTemp
        : this.leveling().getComfortTarget();
    if (device.mode === 4) {
      // Heat mode: deviation is how far the room is below the comfort target
      return {
        tier: computeNeedTier({ kind: "comfort", currentTemp: 2 * target - roomTemp, target }),
        delta: target - roomTemp,
        slotGenCap: null,
        slotKey,
      };
    }
    return {
      tier: computeNeedTier({ kind: "comfort", currentTemp: roomTemp, target }),
      delta: roomTemp - target,
      slotGenCap: null,
      slotKey,
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
          const passStartedAt = Date.now();
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
          // A QUEUED follow-up used to run the instant this pass resolved.
          // `bucket_empty` re-fires on every over-limit reading, so a pass that
          // had just acted was immediately re-entered against the same device
          // cache and a meter that had not moved — and acted again. Live
          // 2026-08-02: 16:55:34 and :35 shed two rooms one SECOND apart for a
          // 0.5A deficit; 17:51:21 sent the same fan trim twice, 200ms apart.
          //
          // Drop a follow-up that would re-decide within the ESP cadence. This
          // never drops the episode: while the bucket is empty every reading
          // re-fires the trigger, so the pass simply happens one reading later,
          // against a meter that has actually moved.
          if (this.levelingCheckQueued && Date.now() - passStartedAt < LEVELING_RERUN_MIN_MS) {
            this.levelingCheckQueued = false;
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
    // v2 load failures must never take the acting v1 controller down with them.
    await this.acLeveler2.ensureLoaded().catch((err) =>
      log.warn(`[collector] v2 leveler load failed: ${(err as Error).message}`));
    if (!this.leveling().isEnabled()) return;
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

    const ctx: LevelerDeviceContext[] = devices.filter((device) => isAcLevelingEligible(device.id)).map((device) => {
      const need = this.computeAcNeed(device.id, device);
      return {
        device,
        managed: !this.acRuleOptsOutOfLeveling(device.id),
        needTier: need.tier,
        needDelta: need.delta,
        slotGenCap: need.slotGenCap,
        slotKey: need.slotKey,
      };
    });
    const controller = this.leveling();
    const previousStatus = controller.getStatus();
    await controller.tick(ctx, outdoorTempC);
    const status = controller.getStatus();
    // The watch's power tuple is one observation of the acting controller:
    // its source, smoothed amps and limit as this tick left them, stamped
    // with the tick's end time (the amps are smoothed over a window, so no
    // single meter sample stands behind them). Recorded only while the
    // meter itself is live, so a silent ESP never looks fresh.
    const tickedAt = Date.now();
    const sampleAt = this.latestPowerTs?.getTime();
    if (status !== previousStatus && sampleAt != null && tickedAt - sampleAt <= STALE_POWER_MS) {
      this.watchMeter = { controller, source: status.source, amps: status.measuredAmps, limit: status.limitAmps, ts: tickedAt };
    }
    // Shadow phase: v2 also evaluates (journal-only, no commands) so its
    // decisions can be compared against v1's before cutover.
    if (this.acLeveler2.controllerFlavor() === "shadow") {
      await this.acLeveler2.tick(ctx, outdoorTempC).catch((err) =>
        log.warn(`[collector] v2 shadow tick failed: ${(err as Error).message}`));
    }
  }

  // ---------- Ambient Weather ----------

  private async collectAmbientWeather(): Promise<void> {
    const url = new URL("https://rt.ambientweather.net/v1/devices");
    url.searchParams.set("apiKey", this.config.awApiKey);
    url.searchParams.set("applicationKey", this.config.awAppKey);

    const resp = await this.awGate.run(() => fetch(url.toString(), {
      signal: AbortSignal.timeout(30_000),
    }));
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
        // No sleep here — `awGate` paces every AW request, including against
        // the concurrent collection poll, which a local sleep could not.
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

    const resp = await this.awGate.run(() => fetch(url.toString(), {
      signal: AbortSignal.timeout(60_000),
    }));
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
    const realtime = msg.type === QP_MSG_REALTIME || msg.type === undefined;
    if (realtime) {
      // Real-time by protocol, so it always wins: no device-clock ordering on this side.
      const live = row as unknown as Record<string, unknown>;
      // battery.status: 1 = charging (USB plugged), 0 = discharging
      live.batteryCharging = sensors.battery?.status === 1;
      this.latestAirRow = live;
      // latestAirTs never decreases, written so (a server clock stepping back must not rewind it,
      // or the cloud's cached sample could later out-date this real-time reading).
      this.latestAirTs = this.latestAirTs && this.latestAirTs.getTime() > row.ts.getTime() ? this.latestAirTs : row.ts;
      // MQTT counts as live (pausing the cloud fallback) only while real-time readings arrive.
      this.lastMqttMessage = Date.now();
      this.qpRealtimeSeq++;
    }
    // The interval setting is otherwise sent only when OUR client connects, so a monitor that
    // rebooted (flat battery) and came back on its 15-minute default stayed slow until the next
    // container restart (2026-11-23: ~15-min-old air data for 3 h). Its first late report says so.
    const prevReportAt = this.lastQpReportAt;
    this.lastQpReportAt = Date.now();
    if (
      prevReportAt > 0 &&
      this.lastQpReportAt - prevReportAt > QP_SLOW_REPORT_GAP_MS &&
      this.lastQpReportAt - this.lastQpIntervalConfigAt >= QP_INTERVAL_RESEND_MIN_MS
    ) {
      log.info(
        `[collector] MQTT: air monitor silent ${Math.round((this.lastQpReportAt - prevReportAt) / 1000)}s before this report; re-sending its 15s interval setting`,
      );
      this.sendIntervalConfig();
    }
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

    this.lastQpIntervalConfigAt = Date.now();
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
    const realtimeSeqAtStart = this.qpRealtimeSeq; // before ANY await, token refresh included
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
    const sampleSec: unknown = data.timestamp?.value;
    const sampleAt = typeof sampleSec === "number" && sampleSec > 0 ? new Date(sampleSec * 1000) : null;
    if (!sampleAt || !Number.isFinite(sampleAt.getTime())) { // also beyond the Date range (1e20)
      log.warn("[collector] Qingping cloud sample without a valid timestamp, ignored");
      return;
    }
    const row = this.toAirRow(sampleAt, data);
    await this.storeAir(row);
    // The cloud copy can be OLDER than the last MQTT reading (2026-11-23: a 04:15 cloud sample
    // replaced a 04:21 MQTT one). One rule, on the server clock: the live reading's time only moves
    // forward. Live MQTT is type 12 only, real-time, so its arrival stamp IS its sample time and
    // compares directly with the cloud's sample time. A sample dated after the server clock (a
    // fast or wrong device clock) is not live until it is in the past, so every later MQTT
    // arrival is later than it and latestAirTs never decreases; a type-12 reading that landed
    // while this poll was in flight wins; and the cached sample the cloud keeps returning can
    // never re-win (its time is not newer than itself). The stored row is a real sample either way.
    const sampleMs = row.ts.getTime();
    const keep =
      sampleMs > Date.now() ||
      this.qpRealtimeSeq !== realtimeSeqAtStart ||
      (this.latestAirTs !== null && sampleMs <= this.latestAirTs.getTime());
    if (keep) {
      log.info(`[collector] Stored air reading at ${row.ts.toISOString()} (not adopted as live)`);
      return;
    }
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
