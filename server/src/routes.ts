import { Router, type Request, type Response } from "express";
import pg from "pg";
import webpush from "web-push";
import { getBaghdadPrayerTimes } from "./prayer.js";
import type { TimeName } from "./prayer-engine/index.js";
import type { Config } from "./config.js";
import { ALERT_METRICS, VALID_PRAYER_NAMES, PRAYER_LABELS } from "./alert-metrics.js";
import type { XiaomiCloud } from "./xiaomi-cloud.js";
import type { TclCloud, AcAction } from "./tcl-cloud.js";
import { MAX_GENERATOR_LEVEL } from "./tcl-cloud.js";
import { isAcLevelingEligible, maxGeneratorLevelForDevices, validateLevelingDeviceReferences } from "./ac-capabilities.js";
import type { ForecastResponse } from "./forecast.js";
import type { AcLevelingConfig, AcAmpModel, AcLevelBoost, AcNeedOverride } from "./ac-leveling.js";
import type { AcLevelingStatus } from "./ac-leveler.js";
import type { AcCalibrationStatus, CalibrationResultRow, CalibrationFit } from "./ac-calibration.js";
import { PowerStatsService } from "./power-stats-service.js";
import { createAuthMiddleware, requireAuth, handleLogin, handleLogout, handleAuthStatus, handleAgentSession, clientIp, type AuthKind } from "./auth.js";
import { childLogger } from "./logger.js";
import { computeChangedKeys } from "./leveling-config-audit.js";
import {
  createBaghdadPrayerResolver,
  getLegacyRangeSlots,
  validateRangeSlots,
  type AutomationRangeSlot,
} from "./automation-slots.js";

const log = childLogger("routes");

export interface AcTimer {
  deviceId: string;
  action: "on" | "off";
  preset?: AcAction;
  fireAt: number;
}

export const acTimers = new Map<string, AcTimer>();

export interface AcManualOffLockHandlers {
  record(deviceId: string, reason: string): Promise<void>;
  /** Resolves true when THIS call released a lock (false when none was held). */
  clear(deviceId: string): Promise<boolean>;
  isLocked(deviceId: string): Promise<boolean>;
  getLockedIds(deviceIds?: string[]): Promise<Set<string>>;
  reconcileDevices(devices: Array<{ id: string; power: boolean }>): Promise<Set<string>>;
  /** UI fan/turbo change — range automations suspend fan enforcement for this device. */
  onUserFanChange?(deviceId: string): void;
  /** UI fan set to Auto (0) — range automations resume fan control (delta-based smart auto). */
  onUserFanAuto?(deviceId: string): void;
  /** UI vertical-swing change — range automations suspend swing enforcement until slot change or power cycle. */
  onUserSwingChange?(deviceId: string): void;
  /** Other direct comfort controls become per-field manual overrides. */
  onUserProfileChange?(deviceId: string, command: string): void;
  /** UI beep toggle — beep off becomes a persistent enforced preference, beep on releases it. */
  onUserBeep?(deviceId: string, beepOn: boolean): void;
  /** A commanded power-ON released a manual-off lock — push so a turn-on the user did not make is visible immediately. */
  notifyLockCleared?(deviceId: string, authKind: AuthKind, ip: string): void;
}

export interface AcLevelingHandlers {
  getConfig(): Promise<unknown>;
  updateConfig(cfg: AcLevelingConfig): Promise<unknown>;
  getStatus(): AcLevelingStatus;
  onUserPowerOff(deviceId: string): Promise<void>;
  onUserPowerOn(deviceId: string): Promise<void>;
  /** Records direct user intent even for ACs outside the ESP controller. */
  noteUserGenLevel?(deviceId: string, level: number): void;
  onUserGenLevel(deviceId: string, level: number): Promise<{ reverted: boolean; level: number }>;
  /** v2 controller extras (absent while only v1 is wired). */
  updateV2Config?(cfg: Record<string, unknown>): Promise<unknown>;
  getJournal?(hours: number): Promise<unknown[]>;
  resetCosts?(): Promise<void>;
}

export interface AcCalibrationHandlers {
  start(deviceIds: string[], includeFan: boolean): Promise<{ ok: true } | { error: string; status: number }>;
  abort(reason: string): Promise<void>;
  getStatus(): AcCalibrationStatus;
  getResults(): Promise<{ results: CalibrationResultRow[]; suggestedFit: Record<string, { grid?: CalibrationFit; gen?: CalibrationFit }> }>;
  /** Called on any user AC control — a running calibration aborts (user intent wins). */
  requestAbort(reason: string): void;
}

export function median(arr: number[]): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const RANGE_MAP: Record<string, string> = {
  "6h": "6 hours",
  "24h": "24 hours",
  "25h": "25 hours",
  "48h": "48 hours",
  "1w": "7 days",
  "30d": "30 days",
};

const WEATHER_AVG_COLS: string[] = [
  "temp_c", "humidity", "wind_speed_kmh", "wind_gust_kmh",
  "pressure_rel_hpa", "pressure_abs_hpa", "solar_radiation",
  "uv_index", "temp_indoor_c", "humidity_indoor",
  "feels_like_c", "dew_point_c", "temp_ch8_c", "humidity_ch8",
  "feels_like_indoor_c", "dew_point_indoor_c",
  "feels_like_ch8_c", "dew_point_ch8_c",
  "rain_hourly_mm",
];

const AIR_AVG_COLS: string[] = [
  "temperature", "humidity", "co2", "pm25", "pm10",
  "tvoc", "noise", "battery",
];

const POWER_AVG_COLS: string[] = [
  "voltage", "current_1", "current_2", "power_1", "power_2",
];

function rowToDict(row: Record<string, unknown>): Record<string, unknown> {
  const d: Record<string, unknown> = { ...row };
  for (const key of Object.keys(d)) {
    const val = d[key];
    if (val instanceof Date) {
      d[key] = val.toISOString();
    }
  }
  return d;
}

export function createRouter(pool: pg.Pool, config?: Config, getXiaomiCloud?: () => XiaomiCloud | null, getTclCloud?: () => TclCloud | null, getLatestAir?: () => Record<string, unknown> | null, getForecast?: () => ForecastResponse | null, onPowerIngest?: (data: { ts: string; voltage: number; current_1: number; current_2: number; power_1: number; power_2: number }) => void, onAutomationRulesChanged?: () => void, acManualOffLocks?: AcManualOffLockHandlers, acLeveling?: AcLevelingHandlers, acCalibration?: AcCalibrationHandlers, getLoopAgeMs?: () => number): Router {
  const router = Router();

  // Health check — before auth middleware, no auth required
  router.get("/api/health", async (_req: Request, res: Response) => {
    try {
      await pool.query("SELECT 1");
      // A stale collector-loop heartbeat means automations are dead even
      // though HTTP works — surface it (the in-process watchdog restarts the
      // container; this makes the stall visible to `docker ps` / monitoring).
      const loopAgeMs = getLoopAgeMs?.() ?? null;
      if (loopAgeMs != null && loopAgeMs > 3 * 60_000) {
        res.status(503).json({ status: "loop-stalled", uptime: process.uptime(), loopAgeMs });
        return;
      }
      res.json({ status: "ok", uptime: process.uptime(), ...(loopAgeMs != null ? { loopAgeMs } : {}) });
    } catch {
      res.status(503).json({ status: "unhealthy", error: "database unreachable" });
    }
  });

  // Forecast — public endpoint, before auth middleware
  router.get("/api/forecast", (_req: Request, res: Response) => {
    const data = getForecast?.();
    if (!data) {
      res.status(503).json({ error: "Forecast not available yet" });
      return;
    }
    res.json(data);
  });

  // Prayer times — public, computed server-side via the prayer-engine
  // (BaghdadYMA profile). All instants are already offset + rounded.
  const HIJRI_MONTH_DAYS = [30, 29, 30, 29, 30, 29, 30, 29, 30, 29, 30, 29];
  const HIJRI_YEAR_DAYS = HIJRI_MONTH_DAYS.reduce((a, b) => a + b, 0);

  const ISLAMIC_EVENTS = [
    { month: 1, day: 1, name: "Islamic New Year" },
    { month: 1, day: 10, name: "Day of Ashura" },
    { month: 3, day: 12, name: "Mawlid al-Nabi" },
    { month: 7, day: 27, name: "Isra & Mi'raj" },
    { month: 8, day: 15, name: "Change of Qibla" },
    { month: 9, day: 1, name: "Ramadan" },
    { month: 9, day: 27, name: "Laylat al-Qadr" },
    { month: 10, day: 1, name: "Eid al-Fitr" },
    { month: 12, day: 9, name: "Day of Arafah" },
    { month: 12, day: 10, name: "Eid al-Adha" },
  ];

  function fmtTime(date: Date): string {
    return date.toLocaleTimeString("en-US", { timeZone: "Asia/Baghdad", hour: "numeric", minute: "2-digit", hour12: true });
  }

  function fmtCountdown(diffMs: number): string {
    const totalSec = Math.max(0, Math.floor(diffMs / 1000));
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  function getPrayerTimesPayload() {
    const now = new Date();
    const nowMs = now.getTime();
    const today = getBaghdadPrayerTimes(now);
    const tomorrow = getBaghdadPrayerTimes(new Date(nowMs + 24 * 60 * 60 * 1000));

    const prayerOrder: { key: TimeName; label: string }[] = [
      { key: "fajr", label: "Fajr" },
      { key: "sunrise", label: "Sunrise" },
      { key: "dhuhr", label: "Dhuhr" },
      { key: "asr", label: "Asr" },
      { key: "maghrib", label: "Maghrib" },
      { key: "isha", label: "Isha" },
    ];

    // Next = first of today's times still ahead; null once all have passed.
    const nextKey = prayerOrder.find(({ key }) => today[key].getTime() > nowMs)?.key ?? null;

    const prayers = prayerOrder.map(({ key, label }) => {
      const time = today[key];
      const ms = time.getTime();
      const diffMs = ms - nowMs;
      const isPassed = diffMs < 0;
      return {
        name: key,
        label,
        // Machine-readable epoch ms drives the client's live countdown locally.
        timestamp: ms,
        time: fmtTime(time),
        isPassed,
        isNext: key === nextKey,
        countdown: isPassed ? null : fmtCountdown(diffMs),
      };
    });

    let nextPrayer:
      | { name: string; label: string; time: string; timestamp: number; countdown: string }
      | null = null;
    if (!nextKey) {
      const fajrTime = tomorrow.fajr;
      const diffMs = fajrTime.getTime() - nowMs;
      nextPrayer = {
        name: "fajr",
        label: "Fajr (tomorrow)",
        time: fmtTime(fajrTime),
        timestamp: fajrTime.getTime(),
        countdown: fmtCountdown(diffMs),
      };
    } else {
      const p = prayers.find((pr) => pr.isNext);
      if (p) nextPrayer = { name: p.name, label: p.label, time: p.time, timestamp: p.timestamp, countdown: p.countdown! };
    }

    // Hijri date
    const hijriDate = new Intl.DateTimeFormat("en-US-u-ca-islamic-umalqura", {
      day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Baghdad",
    }).format(now);

    // Next Islamic event
    const hijriParts = new Intl.DateTimeFormat("en-US-u-ca-islamic-umalqura", {
      day: "numeric", month: "numeric", timeZone: "Asia/Baghdad",
    }).formatToParts(now);
    const hMonth = Number(hijriParts.find((p) => p.type === "month")?.value);
    const hDay = Number(hijriParts.find((p) => p.type === "day")?.value);

    let nextEvent: { name: string; isToday: boolean; daysLeft: number } | null = null;
    if (hMonth && hDay) {
      const todayDoy = HIJRI_MONTH_DAYS.slice(0, hMonth - 1).reduce((a, b) => a + b, 0) + hDay;
      for (const ev of ISLAMIC_EVENTS) {
        const evDoy = HIJRI_MONTH_DAYS.slice(0, ev.month - 1).reduce((a, b) => a + b, 0) + ev.day;
        if (evDoy === todayDoy) { nextEvent = { name: ev.name, isToday: true, daysLeft: 0 }; break; }
        if (evDoy > todayDoy) { nextEvent = { name: ev.name, isToday: false, daysLeft: evDoy - todayDoy }; break; }
      }
      if (!nextEvent) {
        const first = ISLAMIC_EVENTS[0];
        const firstDoy = first.day;
        nextEvent = { name: first.name, isToday: false, daysLeft: HIJRI_YEAR_DAYS - todayDoy + firstDoy };
      }
    }

    return { prayers, nextPrayer, hijriDate, nextEvent, tomorrowFajr: tomorrow.fajr.getTime() };
  }

  router.get("/api/prayer-times", (_req: Request, res: Response) => {
    res.json(getPrayerTimesPayload());
  });

  // Auth middleware — sets req.authenticated on every request
  if (config) {
    router.use(createAuthMiddleware(config));
  }

  // Auth routes
  router.post("/api/auth/login", handleLogin(config!));
  router.post("/api/auth/logout", handleLogout);
  router.get("/api/auth/me", handleAuthStatus);

  // Agent access for Hermes and other trusted local automations.
  router.post("/api/agent/session", handleAgentSession(config!));

  router.get("/api/agent/snapshot", requireAuth, async (_req: Request, res: Response) => {
    const [current, automationsResult] = await Promise.all([
      getCurrentPayload(),
      pool.query("SELECT * FROM automations ORDER BY created_at ASC"),
    ]);

    const xiaomi = getXiaomiCloud?.();
    const purifiers = await (async () => {
      if (!xiaomi) return { devices: [], available: false };
      try {
        return {
          devices: await xiaomi.fetchDevicesLive(),
          available: true,
          region: xiaomi.getRegion(),
        };
      } catch (err) {
        return {
          devices: xiaomi.getDevices(),
          available: true,
          region: xiaomi.getRegion(),
          error: (err as Error).message,
        };
      }
    })();

    const tcl = getTclCloud?.();
    const ac = await (async () => {
      if (!tcl || !tcl.isReady()) return { devices: [], available: false };
      try {
        const devices = await tcl.fetchDevicesLive();
        const lockedIds = await acManualOffLocks?.reconcileDevices(devices) ?? new Set<string>();
        return {
          devices: devices.map((device) => ({ ...device, manualOffLocked: lockedIds.has(device.id) })),
          available: true,
        };
      } catch (err) {
        const devices = tcl.getDevices();
        const lockedIds = await acManualOffLocks?.getLockedIds(devices.map((device) => device.id)) ?? new Set<string>();
        return {
          devices: devices.map((device) => ({ ...device, manualOffLocked: lockedIds.has(device.id) })),
          available: true,
          error: (err as Error).message,
        };
      }
    })();

    res.json({
      generatedAt: new Date().toISOString(),
      current,
      forecast: getForecast?.() ?? null,
      prayerTimes: getPrayerTimesPayload(),
      devices: { purifiers, ac },
      acTimers: Array.from(acTimers.values()),
      automations: automationsResult.rows,
    });
  });

  // In-memory latest power reading (updated every ingest ~1s), saved to DB every 60s
  let latestPower: { ts: string; voltage: number; current_1: number; current_2: number; power_1: number; power_2: number } | null = null;
  let lastPowerSave = 0;
  const POWER_SAVE_INTERVAL = 60_000;
  const powerBuffer: { v: number; i1: number; i2: number }[] = [];

  async function getCurrentPayload() {
    // Use in-memory caches where available, fall back to DB in parallel
    const air: Record<string, unknown> | null = getLatestAir?.() ?? null;
    const power = latestPower;

    const [weatherResult, airResult, powerResult, maxGustResult] = await Promise.all([
      pool.query("SELECT * FROM weather_readings ORDER BY ts DESC LIMIT 1"),
      air ? null : pool.query("SELECT * FROM air_readings ORDER BY ts DESC LIMIT 1"),
      power ? null : pool.query("SELECT * FROM power_readings ORDER BY ts DESC LIMIT 1"),
      pool.query("SELECT MAX(wind_gust_kmh) as max_gust FROM weather_readings WHERE ts >= date_trunc('day', now())"),
    ]);

    const weatherRow = weatherResult.rows[0] ? rowToDict(weatherResult.rows[0]) : null;
    if (weatherRow) {
      weatherRow.max_daily_gust_kmh = maxGustResult.rows[0]?.max_gust ?? null;
    }

    return {
      weather: weatherRow,
      air: air ?? (airResult?.rows[0] ? rowToDict(airResult.rows[0]) : null),
      power: power ?? (powerResult?.rows[0] ? rowToDict(powerResult.rows[0]) as any : null),
    };
  }

  router.get("/api/current", async (_req: Request, res: Response) => {
    res.json(await getCurrentPayload());
  });

  // Lightweight power-only endpoint for 1s polling
  // Returns null if no reading received in 15s (ESP sends every 5s — 3 missed = no electricity)
  router.get("/api/current/power", (_req: Request, res: Response) => {
    if (latestPower) {
      const age = Date.now() - new Date(latestPower.ts).getTime();
      if (age > 15_000) {
        res.json(null);
        return;
      }
    }
    res.json(latestPower);
  });

  // Derived power-source stats (session duration, 24h grid hours, 7-day
  // averages, temp-weighted time-remaining prediction) + per-day history
  // breakdown. Constructed here because `latestPower` is closure-local.
  const powerStatsService = new PowerStatsService(pool, () => latestPower);

  router.get("/api/power/stats", async (_req: Request, res: Response) => {
    res.json(await powerStatsService.getStats());
  });

  router.get("/api/power/day-breakdown", async (req: Request, res: Response) => {
    const range = (req.query.range as string) || "24h";
    const interval = RANGE_MAP[range];
    if (!interval) {
      res.status(400).json({ error: `Invalid range: ${range}` });
      return;
    }
    res.json(await powerStatsService.getDayBreakdown(range, interval));
  });

  router.get("/api/history", async (req: Request, res: Response) => {
    const source = (req.query.source as string) || "weather";
    const range = (req.query.range as string) || "24h";

    const tableMap: Record<string, string> = { weather: "weather_readings", air: "air_readings", power: "power_readings" };
    const table = tableMap[source];
    if (!table) {
      res.status(400).json({ error: `Invalid source: ${source}` });
      return;
    }
    const interval = RANGE_MAP[range];
    if (!interval) {
      res.status(400).json({ error: `Invalid range: ${range}` });
      return;
    }

    let rows: Record<string, unknown>[];

    if (range === "30d") {
      const cols = source === "weather" ? WEATHER_AVG_COLS : source === "power" ? POWER_AVG_COLS : AIR_AVG_COLS;
      const avgExprs = cols.map((c) => `AVG(${c})::REAL AS ${c}`).join(", ");
      const result = await pool.query(
        `SELECT date_trunc('hour', ts) AS ts, ${avgExprs}
         FROM ${table}
         WHERE ts >= NOW() - INTERVAL '${interval}'
         GROUP BY date_trunc('hour', ts)
         ORDER BY ts ASC`
      );
      rows = result.rows;
    } else {
      const result = await pool.query(
        `SELECT * FROM ${table}
         WHERE ts >= NOW() - INTERVAL '${interval}'
         ORDER BY ts ASC`
      );
      rows = result.rows;
    }

    res.json({
      source,
      range,
      count: rows.length,
      data: rows.map(rowToDict),
    });
  });

  // Reference solar radiation per 5-min slot: average of the 3 clearest days.
  // 5-min resolution eliminates intra-slot variation that caused false cloud
  // detection in late afternoon when radiation drops rapidly.
  router.get("/api/solar-reference", async (_req: Request, res: Response) => {
    const result = await pool.query(
      `WITH daily_totals AS (
         SELECT DATE(ts AT TIME ZONE 'Asia/Baghdad') AS day,
                SUM(solar_radiation) AS total
         FROM weather_readings
         WHERE ts >= NOW() - INTERVAL '7 days' AND solar_radiation IS NOT NULL
         GROUP BY day
       ),
       best_days AS (
         SELECT day FROM daily_totals ORDER BY total DESC LIMIT 3
       )
       SELECT
         EXTRACT(HOUR FROM ts AT TIME ZONE 'Asia/Baghdad')::int AS hour,
         (EXTRACT(MINUTE FROM ts AT TIME ZONE 'Asia/Baghdad')::int / 5) AS slot,
         AVG(solar_radiation)::real AS ref_radiation
       FROM weather_readings
       WHERE DATE(ts AT TIME ZONE 'Asia/Baghdad') IN (SELECT day FROM best_days)
         AND solar_radiation IS NOT NULL
       GROUP BY hour, slot
       ORDER BY hour, slot`
    );
    const slotRef: Record<string, number> = {};
    for (const row of result.rows) {
      slotRef[`${row.hour}:${row.slot}`] = row.ref_radiation as number;
    }
    res.json({ quarter_hourly_max: slotRef });
  });

  router.get("/api/status", async (_req: Request, res: Response) => {
    const [weatherLastResult, airLastResult, powerLastResult, weatherCountResult, airCountResult, powerCountResult] = await Promise.all([
      pool.query("SELECT ts FROM weather_readings ORDER BY ts DESC LIMIT 1"),
      pool.query("SELECT ts FROM air_readings ORDER BY ts DESC LIMIT 1"),
      pool.query("SELECT ts FROM power_readings ORDER BY ts DESC LIMIT 1"),
      pool.query("SELECT COUNT(*) FROM weather_readings"),
      pool.query("SELECT COUNT(*) FROM air_readings"),
      pool.query("SELECT COUNT(*) FROM power_readings"),
    ]);

    const weatherLast: Date | null = weatherLastResult.rows[0]?.ts ?? null;
    const airLast: Date | null = airLastResult.rows[0]?.ts ?? null;
    const powerLast: Date | null = powerLastResult.rows[0]?.ts ?? null;

    res.json({
      weather_last_update: weatherLast ? weatherLast.toISOString() : null,
      air_last_update: airLast ? airLast.toISOString() : null,
      power_last_update: powerLast ? powerLast.toISOString() : null,
      weather_total_readings: parseInt(weatherCountResult.rows[0].count as string, 10),
      air_total_readings: parseInt(airCountResult.rows[0].count as string, 10),
      power_total_readings: parseInt(powerCountResult.rows[0].count as string, 10),
      collector_interval_seconds: 300,
    });
  });

  // ---------- Power Ingest (ESP) ----------

  router.post("/api/power/ingest", async (req: Request, res: Response) => {
    const { v, i1, i2 } = req.body as { v: number; i1: number; i2: number };
    if (typeof v !== "number" || typeof i1 !== "number" || typeof i2 !== "number") {
      res.status(400).json({ error: "Missing or invalid fields: v, i1, i2 (all required, numeric)" });
      return;
    }
    if (!isFinite(v) || !isFinite(i1) || !isFinite(i2)) {
      res.status(400).json({ error: "Values must be finite numbers" });
      return;
    }
    const p1 = v * i1;
    const p2 = v * i2;
    const now = new Date();
    latestPower = { ts: now.toISOString(), voltage: v, current_1: i1, current_2: i2, power_1: p1, power_2: p2 };
    onPowerIngest?.(latestPower);
    powerBuffer.push({ v, i1, i2 });

    // Persist median of buffered readings to DB every 60 seconds
    if (now.getTime() - lastPowerSave >= POWER_SAVE_INTERVAL && powerBuffer.length > 0) {
      lastPowerSave = now.getTime();
      const medV = median(powerBuffer.map(r => r.v));
      const medI1 = median(powerBuffer.map(r => r.i1));
      const medI2 = median(powerBuffer.map(r => r.i2));
      const medP1 = medV * medI1;
      const medP2 = medV * medI2;
      powerBuffer.length = 0;
      await pool.query(
        `INSERT INTO power_readings (ts, voltage, current_1, current_2, power_1, power_2)
         VALUES (NOW(), $1, $2, $3, $4, $5)
         ON CONFLICT (ts) DO NOTHING`,
        [medV, medI1, medI2, medP1, medP2],
      );
    }
    res.json({ ok: true });
  });

  // ---------- Push Notifications ----------

  router.get("/api/push/vapid-key", (_req: Request, res: Response) => {
    res.json({ publicKey: config?.vapidPublicKey ?? "" });
  });

  router.post("/api/push/subscribe", async (req: Request, res: Response) => {
    const { subscription, breakpoints } = req.body as {
      subscription: { endpoint: string };
      breakpoints?: number[];
    };
    if (!subscription?.endpoint) {
      res.status(400).json({ error: "Missing subscription" });
      return;
    }
    const bp = breakpoints ?? [15, 7, 4, 2, 0];
    await pool.query(
      `INSERT INTO push_subscriptions (endpoint, subscription, breakpoints)
       VALUES ($1, $2, $3)
       ON CONFLICT (endpoint) DO UPDATE SET subscription = $2, breakpoints = $3`,
      [subscription.endpoint, JSON.stringify(subscription), bp]
    );
    res.json({ ok: true });
  });

  router.post("/api/push/unsubscribe", async (req: Request, res: Response) => {
    const { endpoint } = req.body as { endpoint: string };
    if (!endpoint) {
      res.status(400).json({ error: "Missing endpoint" });
      return;
    }
    await pool.query("DELETE FROM push_subscriptions WHERE endpoint = $1", [endpoint]);
    res.json({ ok: true });
  });

  // Per-device opt-in for Smart AC Leveling notifications (off by default).
  router.get("/api/push/leveling", async (req: Request, res: Response) => {
    const endpoint = req.query.endpoint as string | undefined;
    if (!endpoint) {
      res.status(400).json({ error: "Missing endpoint" });
      return;
    }
    const result = await pool.query(
      "SELECT leveling_notifications FROM push_subscriptions WHERE endpoint = $1",
      [endpoint]
    );
    res.json({ enabled: result.rows[0]?.leveling_notifications === true });
  });

  router.post("/api/push/leveling", async (req: Request, res: Response) => {
    const { endpoint, enabled } = req.body as { endpoint?: string; enabled?: unknown };
    if (!endpoint) {
      res.status(400).json({ error: "Missing endpoint" });
      return;
    }
    await pool.query(
      "UPDATE push_subscriptions SET leveling_notifications = $2 WHERE endpoint = $1",
      [endpoint, enabled === true]
    );
    res.json({ ok: true });
  });

  // ---------- Alerts ----------

  router.get("/api/alerts", async (req: Request, res: Response) => {
    const endpoint = req.query.endpoint as string;
    if (!endpoint) {
      res.status(400).json({ error: "Missing endpoint" });
      return;
    }
    const result = await pool.query(
      "SELECT * FROM alert_rules WHERE endpoint = $1 ORDER BY created_at ASC",
      [endpoint]
    );
    res.json({ alerts: result.rows });
  });

  interface AlertBody {
    endpoint: string;
    alert_type: string;
    metric?: string;
    condition?: string;
    threshold?: number;
    prayer_timing?: string;
    prayer_minutes?: number;
    prayer_names?: string[];
  }

  function validateAlertFields(body: AlertBody): string | null {
    const { alert_type, metric, condition, threshold, prayer_timing, prayer_minutes, prayer_names } = body;
    if (alert_type === "sensor") {
      if (!metric || !(metric in ALERT_METRICS)) return "Invalid metric";
      if (condition !== "above" && condition !== "below") return "Condition must be 'above' or 'below'";
      if (typeof threshold !== "number" || !isFinite(threshold)) return "Threshold must be a finite number";
      const def = ALERT_METRICS[metric];
      if (threshold < def.min || threshold > def.max) return `Threshold must be between ${def.min} and ${def.max}`;
    } else if (alert_type === "prayer") {
      if (prayer_timing !== "at_time" && prayer_timing !== "before") return "prayer_timing must be 'at_time' or 'before'";
      if (prayer_timing === "before") {
        if (typeof prayer_minutes !== "number" || !Number.isInteger(prayer_minutes) || prayer_minutes < 1 || prayer_minutes > 120)
          return "prayer_minutes must be an integer between 1 and 120";
      }
      if (!Array.isArray(prayer_names) || prayer_names.length === 0) return "At least one prayer must be selected";
      const validNames = VALID_PRAYER_NAMES as readonly string[];
      if (!prayer_names.every((n) => validNames.includes(n))) return "Invalid prayer name";
    } else {
      return "alert_type must be 'sensor' or 'prayer'";
    }
    return null;
  }

  router.post("/api/alerts", async (req: Request, res: Response) => {
    const body = req.body as AlertBody;
    if (!body.endpoint) { res.status(400).json({ error: "Missing endpoint" }); return; }

    const sub = await pool.query("SELECT 1 FROM push_subscriptions WHERE endpoint = $1", [body.endpoint]);
    if (sub.rowCount === 0) { res.status(400).json({ error: "Subscription not found" }); return; }

    const err = validateAlertFields(body);
    if (err) { res.status(400).json({ error: err }); return; }

    if (body.alert_type === "sensor") {
      const result = await pool.query(
        `INSERT INTO alert_rules (endpoint, alert_type, metric, condition, threshold)
         VALUES ($1, 'sensor', $2, $3, $4) RETURNING *`,
        [body.endpoint, body.metric, body.condition, body.threshold]
      );
      res.json({ alert: result.rows[0] });
    } else {
      const mins = body.prayer_timing === "at_time" ? null : body.prayer_minutes;
      const result = await pool.query(
        `INSERT INTO alert_rules (endpoint, alert_type, prayer_timing, prayer_minutes, prayer_names)
         VALUES ($1, 'prayer', $2, $3, $4) RETURNING *`,
        [body.endpoint, body.prayer_timing, mins, body.prayer_names]
      );
      res.json({ alert: result.rows[0] });
    }
  });

  router.put("/api/alerts/:id", async (req: Request, res: Response) => {
    const id = parseInt(String(req.params.id), 10);
    const body = req.body as AlertBody;
    if (!body.endpoint || isNaN(id)) { res.status(400).json({ error: "Missing endpoint or invalid id" }); return; }

    // Verify ownership
    const existing = await pool.query(
      "SELECT id, alert_type FROM alert_rules WHERE id = $1 AND endpoint = $2",
      [id, body.endpoint]
    );
    if (existing.rowCount === 0) { res.status(404).json({ error: "Alert not found" }); return; }

    const err = validateAlertFields(body);
    if (err) { res.status(400).json({ error: err }); return; }

    if (body.alert_type === "sensor") {
      const result = await pool.query(
        `UPDATE alert_rules SET alert_type = 'sensor', metric = $1, condition = $2, threshold = $3,
         prayer_timing = NULL, prayer_minutes = NULL, prayer_names = NULL
         WHERE id = $4 RETURNING *`,
        [body.metric, body.condition, body.threshold, id]
      );
      res.json({ alert: result.rows[0] });
    } else {
      const mins = body.prayer_timing === "at_time" ? null : body.prayer_minutes;
      const result = await pool.query(
        `UPDATE alert_rules SET alert_type = 'prayer', prayer_timing = $1, prayer_minutes = $2, prayer_names = $3,
         metric = NULL, condition = NULL, threshold = NULL
         WHERE id = $4 RETURNING *`,
        [body.prayer_timing, mins, body.prayer_names, id]
      );
      res.json({ alert: result.rows[0] });
    }
  });

  router.delete("/api/alerts/:id", async (req: Request, res: Response) => {
    const id = parseInt(String(req.params.id), 10);
    const endpoint = req.query.endpoint as string;
    if (!endpoint || isNaN(id)) {
      res.status(400).json({ error: "Missing endpoint or invalid id" });
      return;
    }
    await pool.query(
      "DELETE FROM alert_rules WHERE id = $1 AND endpoint = $2",
      [id, endpoint]
    );
    res.json({ ok: true });
  });

  // ---------- Xiaomi Cloud Auth ----------

  router.get("/api/xiaomi/auth-status", requireAuth, (_req: Request, res: Response) => {
    const cloud = getXiaomiCloud?.();
    if (!cloud) {
      res.json({ status: "not_configured" });
      return;
    }
    res.json(cloud.getAuthStatus());
  });

  router.post("/api/xiaomi/verify", requireAuth, async (req: Request, res: Response) => {
    const cloud = getXiaomiCloud?.();
    if (!cloud) {
      res.status(503).json({ error: "Xiaomi Cloud not available" });
      return;
    }
    const { code } = req.body as { code: string };
    if (!code) {
      res.status(400).json({ error: "Missing code" });
      return;
    }
    const result = await cloud.submitVerification(code);
    res.json(result);
  });

  // ---------- Devices (Xiaomi Cloud) ----------

  router.get("/api/devices", requireAuth, async (_req: Request, res: Response) => {
    const cloud = getXiaomiCloud?.();
    if (!cloud) {
      res.json({ devices: [], available: false });
      return;
    }
    try {
      const devices = await cloud.fetchDevicesLive();
      res.json({ devices, available: true, region: cloud.getRegion() });
    } catch (err) {
      res.json({ devices: cloud.getDevices(), available: true, region: cloud.getRegion(), error: (err as Error).message });
    }
  });

  // ---------- Device Control ----------

  const ALLOWED_COMMANDS = ["set_power", "set_mode", "set_level_favorite", "set_fan_level", "set_led", "set_buzzer", "set_child_lock"];

  router.post("/api/devices/:id/control", requireAuth, async (req: Request, res: Response) => {
    const cloud = getXiaomiCloud?.();
    if (!cloud) { res.status(503).json({ error: "Xiaomi Cloud not available" }); return; }
    const id = String(req.params.id);
    const { command, params } = req.body as { command: string; params: unknown[] };
    if (!command || !ALLOWED_COMMANDS.includes(command)) {
      res.status(400).json({ error: `Invalid command. Allowed: ${ALLOWED_COMMANDS.join(", ")}` });
      return;
    }
    try {
      await cloud.sendControlCommand(id, command, params ?? []);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ---------- Automations ----------

  const AC_MODE_NAMES: Record<number, string> = { 0: "Auto", 1: "Cool", 2: "Dry", 3: "Fan", 4: "Heat" };

  router.get("/api/automations", requireAuth, async (_req: Request, res: Response) => {
    const result = await pool.query("SELECT * FROM automations ORDER BY created_at ASC");
    res.json({ automations: result.rows });
  });

  interface MetricAutomationBody {
    automation_type?: "metric";
    device_type?: "purifier" | "ac";
    metric: string;
    condition: string;
    threshold: number;
    threshold_low?: number;
    sustained_minutes?: number;
    turn_off_at_end?: boolean;
    range_slots?: AutomationRangeSlot[];
    device_ids: string[];
    device_names: string[];
    enabled?: boolean;
    ac_profile?: Record<string, unknown>;
    smart_leveling?: boolean;
  }

  interface ScheduleAutomationBody {
    automation_type: "schedule";
    device_type?: "purifier" | "ac";
    time_start: string;
    time_end: string;
    start_mode?: "exact" | "prayer";
    start_prayer?: string;
    start_prayer_offset?: number;
    end_mode?: "exact" | "prayer";
    end_prayer?: string;
    end_prayer_offset?: number;
    turn_off_at_end?: boolean;
    device_ids: string[];
    device_names: string[];
    enabled?: boolean;
    ac_profile?: { mode: number; temperature: number; fan_speed: number };
    smart_leveling?: boolean;
  }

  type AutomationBody = MetricAutomationBody | ScheduleAutomationBody;

  async function knownAcDeviceError(deviceIds: string[]): Promise<{ status: 404 | 503; error: string } | null> {
    const cloud = getTclCloud?.();
    if (!cloud || !cloud.isReady()) return { status: 503, error: "TCL Cloud not available" };
    try {
      await cloud.ensureDeviceCachePopulated();
      const unknown = deviceIds.find((deviceId) => cloud.sanitizeAcAction(deviceId, {}) == null);
      return unknown ? { status: 404, error: `Unknown AC device: ${unknown}` } : null;
    } catch (err) {
      return { status: 503, error: (err as Error).message };
    }
  }

  function validateAcProfile(p: unknown): string | null {
    if (!p || typeof p !== "object") return "AC profile required";
    const { mode, temperature, fan_speed } = p as Record<string, number>;
    if (mode == null || !Number.isInteger(mode) || mode < 0 || mode > 4) return "Mode must be 0–4";
    if (temperature == null || !Number.isInteger(temperature) || temperature < 16 || temperature > 36) return "Temperature must be 16–36";
    if (fan_speed == null || !Number.isInteger(fan_speed) || fan_speed < 0 || fan_speed > 7) return "Fan speed must be 0–7";
    return null;
  }

  function validateAcRangeSlots(body: MetricAutomationBody): ReturnType<typeof validateRangeSlots> {
    const def = ALERT_METRICS[body.metric];
    const slotsInput = body.range_slots ?? (
      typeof body.threshold_low === "number" && typeof body.threshold === "number"
        ? getLegacyRangeSlots(body.threshold_low, body.threshold)
        : null
    );
    return validateRangeSlots(
      slotsInput,
      { min: def.min, max: def.max },
      createBaghdadPrayerResolver(),
      maxGeneratorLevelForDevices(Array.isArray(body.device_ids) ? body.device_ids : []),
    );
  }

  function primaryRangeSlot(slots: AutomationRangeSlot[]): AutomationRangeSlot {
    return slots.find((s) => s.type === "all_day") ?? slots[0];
  }

  function formatRangeSummary(metric: string, slots: AutomationRangeSlot[]): string {
    const unit = ALERT_METRICS[metric].unit ?? "";
    if (slots.length === 1) {
      const only = slots[0];
      return `${only.threshold_low}–${only.threshold}${unit}`;
    }
    const fallback = slots.find((s) => s.type === "all_day");
    return fallback
      ? `${slots.length} ranges, default ${fallback.threshold_low}–${fallback.threshold}${unit}`
      : `${slots.length} ranges`;
  }

  function validateMetricAutomation(body: MetricAutomationBody): string | null {
    if (!body.metric || !(body.metric in ALERT_METRICS)) return "Invalid metric";
    if (body.device_type !== "ac" && ALERT_METRICS[body.metric].source !== "air") return "Only air quality metrics allowed for purifiers";
    const def = ALERT_METRICS[body.metric];

    if (body.device_type === "ac") {
      const slotsResult = validateAcRangeSlots(body);
      if (!slotsResult.ok) return slotsResult.error ?? "Invalid range slots";
      const profileErr = validateAcProfile(body.ac_profile);
      if (profileErr) return profileErr;
    } else {
      if (typeof body.threshold !== "number" || !isFinite(body.threshold)) return "Threshold must be a finite number";
      if (body.threshold < def.min || body.threshold > def.max) return `Threshold must be between ${def.min} and ${def.max}`;
      if (body.condition !== "above" && body.condition !== "below") return "Condition must be 'above' or 'below'";
    }

    if (body.sustained_minutes != null && (!Number.isInteger(body.sustained_minutes) || body.sustained_minutes < 0 || body.sustained_minutes > 60))
      return "Sustained minutes must be 0–60";
    if (!Array.isArray(body.device_ids) || body.device_ids.length === 0) return "Select at least one device";
    return null;
  }

  function validatePrayerField(prayer?: string, offset?: number, label = "Prayer"): string | null {
    const validNames = VALID_PRAYER_NAMES as readonly string[];
    if (!prayer || !validNames.includes(prayer)) return `Invalid ${label.toLowerCase()} prayer name`;
    if (offset == null || !Number.isInteger(offset) || offset < -120 || offset > 120)
      return `${label} offset must be an integer between -120 and 120`;
    return null;
  }

  function formatTimeLabel(mode: string, time: string | undefined, prayer: string | undefined, offset: number | undefined): string {
    if (mode === "prayer" && prayer) {
      const abs = Math.abs(offset ?? 0);
      const dir = (offset ?? 0) < 0 ? "before" : (offset ?? 0) > 0 ? "after" : "at";
      return abs > 0 ? `${abs}min ${dir} ${PRAYER_LABELS[prayer] ?? prayer}` : PRAYER_LABELS[prayer] ?? prayer;
    }
    return time ?? "??:??";
  }

  function validateScheduleAutomation(body: ScheduleAutomationBody): string | null {
    const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;
    const startMode = body.start_mode ?? "exact";
    const endMode = body.end_mode ?? "exact";

    if (startMode === "prayer") {
      const err = validatePrayerField(body.start_prayer, body.start_prayer_offset, "Start");
      if (err) return err;
    } else {
      if (!body.time_start || !timeRegex.test(body.time_start)) return "Invalid start time (HH:MM)";
    }

    if (endMode === "prayer") {
      const err = validatePrayerField(body.end_prayer, body.end_prayer_offset, "End");
      if (err) return err;
    } else {
      if (!body.time_end || !timeRegex.test(body.time_end)) return "Invalid end time (HH:MM)";
    }

    if (startMode === "exact" && endMode === "exact" && body.time_start === body.time_end)
      return "Start and end time cannot be the same";

    if (!Array.isArray(body.device_ids) || body.device_ids.length === 0) return "Select at least one device";
    if (body.device_type === "ac") {
      const profileErr = validateAcProfile(body.ac_profile);
      if (profileErr) return profileErr;
    }
    return null;
  }

  router.post("/api/automations", requireAuth, async (req: Request, res: Response) => {
    const body = req.body as AutomationBody;
    const isSchedule = body.automation_type === "schedule";

    if (isSchedule) {
      const sb = body as ScheduleAutomationBody;
      const err = validateScheduleAutomation(sb);
      if (err) { res.status(400).json({ error: err }); return; }
      if (sb.device_type === "ac") {
        const deviceErr = await knownAcDeviceError(sb.device_ids);
        if (deviceErr) { res.status(deviceErr.status).json({ error: deviceErr.error }); return; }
      }

      const turnOff = sb.turn_off_at_end ?? false;
      const devType = sb.device_type ?? "purifier";
      const startMode = sb.start_mode ?? "exact";
      const endMode = sb.end_mode ?? "exact";
      const startLabel = formatTimeLabel(startMode, sb.time_start, sb.start_prayer, sb.start_prayer_offset);
      const endLabel = formatTimeLabel(endMode, sb.time_end, sb.end_prayer, sb.end_prayer_offset);
      const prefix = devType === "ac" ? "AC " : "";
      const name = `${prefix}Schedule ${startLabel} – ${endLabel}${turnOff ? " (off at end)" : ""}`;
      const actionOn = devType === "ac" && sb.ac_profile
        ? JSON.stringify({ power: 1, ...sb.ac_profile })
        : '{"power":"on"}';
      const actionOff = turnOff
        ? (devType === "ac" ? '{"power":0}' : '{"power":"off"}')
        : null;
      const result = await pool.query(
        `INSERT INTO automations (name, enabled, automation_type, device_type, time_start, time_end, turn_off_at_end,
         start_mode, start_prayer, start_prayer_offset, end_mode, end_prayer, end_prayer_offset,
         device_id, device_name, device_ids, device_names, action_on, action_off, smart_leveling, cooldown_secs)
         VALUES ($1, $2, 'schedule', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb, $18::jsonb, $19, 60) RETURNING *`,
        [name, sb.enabled ?? true, devType,
         startMode === "exact" ? sb.time_start : null, endMode === "exact" ? sb.time_end : null, turnOff,
         startMode, startMode === "prayer" ? sb.start_prayer : null, startMode === "prayer" ? sb.start_prayer_offset : null,
         endMode, endMode === "prayer" ? sb.end_prayer : null, endMode === "prayer" ? sb.end_prayer_offset : null,
         sb.device_ids[0], sb.device_names[0] ?? sb.device_ids[0], sb.device_ids, sb.device_names, actionOn, actionOff,
         devType === "ac" ? (sb.smart_leveling ?? true) : true],
      );
      res.json({ automation: result.rows[0] });
    } else {
      const mb = body as MetricAutomationBody;
      const err = validateMetricAutomation(mb);
      if (err) { res.status(400).json({ error: err }); return; }
      if (mb.device_type === "ac") {
        const deviceErr = await knownAcDeviceError(mb.device_ids);
        if (deviceErr) { res.status(deviceErr.status).json({ error: deviceErr.error }); return; }
      }

      const mins = mb.sustained_minutes ?? 0;
      const devType = mb.device_type ?? "purifier";
      const rangeSlots = devType === "ac" ? validateAcRangeSlots(mb).slots ?? [] : [];
      const primarySlot = devType === "ac" ? primaryRangeSlot(rangeSlots) : null;
      const isAcRange = devType === "ac";
      const turnOff = isAcRange ? true : (mb.turn_off_at_end ?? false);
      const condition = isAcRange ? "above" : mb.condition;

      let name: string;
      if (isAcRange && mb.ac_profile) {
        const modeName = AC_MODE_NAMES[mb.ac_profile.mode as number] ?? "?";
        name = `${ALERT_METRICS[mb.metric].label} ${formatRangeSummary(mb.metric, rangeSlots)} → ${modeName} ${mb.ac_profile.temperature}°`;
      } else {
        const offSuffix = turnOff ? " (off)" : "";
        const acLabel = devType === "ac" && mb.ac_profile ? ` → ${AC_MODE_NAMES[mb.ac_profile.mode as number] ?? "?"} ${mb.ac_profile.temperature}°` : "";
        name = `${ALERT_METRICS[mb.metric].label} ${mb.condition} ${mb.threshold}${mins > 0 ? ` for ${mins}min` : ""}${acLabel}${offSuffix}`;
      }

      const actionOn = devType === "ac" && mb.ac_profile
        ? JSON.stringify({ power: 1, ...mb.ac_profile })
        : '{"power":"on"}';
      const actionOff = turnOff
        ? (devType === "ac" ? '{"power":0}' : '{"power":"off"}')
        : null;
      const result = await pool.query(
        `INSERT INTO automations (name, enabled, automation_type, device_type, metric, condition, threshold, threshold_low, sustained_minutes, turn_off_at_end, device_id, device_name, device_ids, device_names, action_on, action_off, smart_leveling, cooldown_secs, range_slots)
         VALUES ($1, $2, 'metric', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15::jsonb, $16, 5, $17::jsonb) RETURNING *`,
        [
          name,
          mb.enabled ?? true,
          devType,
          mb.metric,
          condition,
          primarySlot ? primarySlot.threshold : mb.threshold,
          primarySlot ? primarySlot.threshold_low : mb.threshold_low ?? null,
          mins,
          turnOff,
          mb.device_ids[0],
          mb.device_names[0] ?? mb.device_ids[0],
          mb.device_ids,
          mb.device_names,
          actionOn,
          actionOff,
          devType === "ac" ? (mb.smart_leveling ?? true) : true,
          devType === "ac" ? JSON.stringify(rangeSlots) : null,
        ],
      );
      res.json({ automation: result.rows[0] });
    }
  });

  router.put("/api/automations/:id", requireAuth, async (req: Request, res: Response) => {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

    const body = req.body as AutomationBody;
    const isSchedule = body.automation_type === "schedule";

    if (isSchedule) {
      const sb = body as ScheduleAutomationBody;
      const err = validateScheduleAutomation(sb);
      if (err) { res.status(400).json({ error: err }); return; }
      if (sb.device_type === "ac") {
        const deviceErr = await knownAcDeviceError(sb.device_ids);
        if (deviceErr) { res.status(deviceErr.status).json({ error: deviceErr.error }); return; }
      }

      const turnOff = sb.turn_off_at_end ?? false;
      const devType = sb.device_type ?? "purifier";
      const startMode = sb.start_mode ?? "exact";
      const endMode = sb.end_mode ?? "exact";
      const startLabel = formatTimeLabel(startMode, sb.time_start, sb.start_prayer, sb.start_prayer_offset);
      const endLabel = formatTimeLabel(endMode, sb.time_end, sb.end_prayer, sb.end_prayer_offset);
      const prefix = devType === "ac" ? "AC " : "";
      const name = `${prefix}Schedule ${startLabel} – ${endLabel}${turnOff ? " (off at end)" : ""}`;
      const actionOn = devType === "ac" && sb.ac_profile
        ? JSON.stringify({ power: 1, ...sb.ac_profile })
        : '{"power":"on"}';
      const actionOff = turnOff
        ? (devType === "ac" ? '{"power":0}' : '{"power":"off"}')
        : null;
      const result = await pool.query(
        `UPDATE automations SET name=$1, enabled=$2, automation_type='schedule', device_type=$3,
         time_start=$4, time_end=$5, turn_off_at_end=$6,
         start_mode=$7, start_prayer=$8, start_prayer_offset=$9,
         end_mode=$10, end_prayer=$11, end_prayer_offset=$12,
         metric=NULL, condition=NULL, threshold=NULL, threshold_low=NULL, sustained_minutes=0,
         action_on=$13::jsonb, action_off=$14::jsonb, device_id=$15, device_name=$16, device_ids=$17, device_names=$18
         , range_slots=NULL, smart_leveling=$19
         WHERE id=$20 RETURNING *`,
        [name, sb.enabled ?? true, devType,
         startMode === "exact" ? sb.time_start : null, endMode === "exact" ? sb.time_end : null, turnOff,
         startMode, startMode === "prayer" ? sb.start_prayer : null, startMode === "prayer" ? sb.start_prayer_offset : null,
         endMode, endMode === "prayer" ? sb.end_prayer : null, endMode === "prayer" ? sb.end_prayer_offset : null,
         actionOn, actionOff, sb.device_ids[0], sb.device_names[0] ?? sb.device_ids[0], sb.device_ids, sb.device_names,
         devType === "ac" ? (sb.smart_leveling ?? true) : true, id],
      );
      if (result.rowCount === 0) { res.status(404).json({ error: "Not found" }); return; }
      res.json({ automation: result.rows[0] });
    } else {
      const mb = body as MetricAutomationBody;
      const err = validateMetricAutomation(mb);
      if (err) { res.status(400).json({ error: err }); return; }
      if (mb.device_type === "ac") {
        const deviceErr = await knownAcDeviceError(mb.device_ids);
        if (deviceErr) { res.status(deviceErr.status).json({ error: deviceErr.error }); return; }
      }

      const mins = mb.sustained_minutes ?? 0;
      const devType = mb.device_type ?? "purifier";
      const rangeSlots = devType === "ac" ? validateAcRangeSlots(mb).slots ?? [] : [];
      const primarySlot = devType === "ac" ? primaryRangeSlot(rangeSlots) : null;
      const isAcRange = devType === "ac";
      const turnOff = isAcRange ? true : (mb.turn_off_at_end ?? false);
      const condition = isAcRange ? "above" : mb.condition;

      let name: string;
      if (isAcRange && mb.ac_profile) {
        const modeName = AC_MODE_NAMES[mb.ac_profile.mode as number] ?? "?";
        name = `${ALERT_METRICS[mb.metric].label} ${formatRangeSummary(mb.metric, rangeSlots)} → ${modeName} ${mb.ac_profile.temperature}°`;
      } else {
        const offSuffix = turnOff ? " (off)" : "";
        const acLabel = devType === "ac" && mb.ac_profile ? ` → ${AC_MODE_NAMES[mb.ac_profile.mode as number] ?? "?"} ${mb.ac_profile.temperature}°` : "";
        name = `${ALERT_METRICS[mb.metric].label} ${mb.condition} ${mb.threshold}${mins > 0 ? ` for ${mins}min` : ""}${acLabel}${offSuffix}`;
      }

      const actionOn = devType === "ac" && mb.ac_profile
        ? JSON.stringify({ power: 1, ...mb.ac_profile })
        : '{"power":"on"}';
      const actionOff = turnOff
        ? (devType === "ac" ? '{"power":0}' : '{"power":"off"}')
        : null;
      const result = await pool.query(
        `UPDATE automations SET name=$1, enabled=$2, automation_type='metric', device_type=$3, metric=$4, condition=$5, threshold=$6, threshold_low=$7, sustained_minutes=$8,
         time_start=NULL, time_end=NULL, turn_off_at_end=$9, action_on=$10::jsonb, action_off=$11::jsonb,
         start_mode='exact', start_prayer=NULL, start_prayer_offset=NULL,
         end_mode='exact', end_prayer=NULL, end_prayer_offset=NULL,
         device_id=$12, device_name=$13, device_ids=$14, device_names=$15, range_slots=$16::jsonb, smart_leveling=$17
         WHERE id=$18 RETURNING *`,
        [
          name,
          mb.enabled ?? true,
          devType,
          mb.metric,
          condition,
          primarySlot ? primarySlot.threshold : mb.threshold,
          primarySlot ? primarySlot.threshold_low : mb.threshold_low ?? null,
          mins,
          turnOff,
          actionOn,
          actionOff,
          mb.device_ids[0],
          mb.device_names[0] ?? mb.device_ids[0],
          mb.device_ids,
          mb.device_names,
          devType === "ac" ? JSON.stringify(rangeSlots) : null,
          devType === "ac" ? (mb.smart_leveling ?? true) : true,
          id,
        ],
      );
      if (result.rowCount === 0) { res.status(404).json({ error: "Not found" }); return; }
      res.json({ automation: result.rows[0] });
    }
  });

  router.delete("/api/automations/:id", requireAuth, async (req: Request, res: Response) => {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
    await pool.query("DELETE FROM automations WHERE id = $1", [id]);
    res.json({ ok: true });
  });

  router.post("/api/automations/:id/test", requireAuth, async (req: Request, res: Response) => {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

    const result = await pool.query("SELECT * FROM automations WHERE id = $1", [id]);
    if (result.rowCount === 0) { res.status(404).json({ error: "Not found" }); return; }
    const rule = result.rows[0] as { device_ids?: string[]; device_id: string; device_type?: string; action_on: Record<string, unknown> };

    try {
      const ids = rule.device_ids ?? [rule.device_id];
      if (rule.device_type === "ac") {
        const tcl = getTclCloud?.();
        if (!tcl || !tcl.isReady()) { res.status(503).json({ error: "TCL Cloud not available" }); return; }
        await tcl.ensureDeviceCachePopulated();
        for (const did of ids) {
          await tcl.executeAcAction(did, rule.action_on as unknown as import("./tcl-cloud.js").AcAction);
        }
      } else {
        const cloud = getXiaomiCloud?.();
        if (!cloud) { res.status(503).json({ error: "Xiaomi Cloud not available" }); return; }
        for (const did of ids) {
          await cloud.sendCommand(did, "set_power", ["on"]);
        }
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Enable/disable toggle
  router.patch("/api/automations/:id", requireAuth, async (req: Request, res: Response) => {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
    const { enabled } = req.body as { enabled: boolean };
    if (typeof enabled !== "boolean") { res.status(400).json({ error: "enabled must be boolean" }); return; }

    const result = await pool.query(
      "UPDATE automations SET enabled = $1 WHERE id = $2 RETURNING *",
      [enabled, id],
    );
    if (result.rowCount === 0) { res.status(404).json({ error: "Not found" }); return; }
    res.json({ automation: result.rows[0] });
  });

  // ---------- AC Devices (TCL Cloud) ----------

  router.get("/api/ac/devices", requireAuth, async (_req: Request, res: Response) => {
    const cloud = getTclCloud?.();
    if (!cloud || !cloud.isReady()) {
      res.json({ devices: [], available: false });
      return;
    }
    try {
      const devices = await cloud.fetchDevicesLive();
      const lockedIds = await acManualOffLocks?.reconcileDevices(devices) ?? new Set<string>();
      res.json({ devices: devices.map((device) => ({ ...device, manualOffLocked: lockedIds.has(device.id) })), available: true });
    } catch (err) {
      const devices = cloud.getDevices();
      const lockedIds = await acManualOffLocks?.getLockedIds(devices.map((device) => device.id)) ?? new Set<string>();
      res.json({ devices: devices.map((device) => ({ ...device, manualOffLocked: lockedIds.has(device.id) })), available: true, error: (err as Error).message });
    }
  });

  const AC_AUDIT_RETENTION_DAYS = 30;
  let lastAcAuditPruneAt = 0;

  /**
   * Durable record of who commanded an AC. Docker logs rotate in ~1.5 days, so
   * "which client turned this AC back on?" was unanswerable after the fact
   * (2026-07-24 Najat incident) — this table outlives them. Fire-and-forget:
   * an audit failure must never block the user's command.
   */
  function auditAcControl(req: Request, deviceId: string, command: string, value: unknown): void {
    const authKind: AuthKind = req.authKind ?? "user";
    const ip = clientIp(req);
    const uaHeader = req.headers["user-agent"];
    const userAgent = (Array.isArray(uaHeader) ? uaHeader[0] : uaHeader)?.slice(0, 300) ?? null;
    log.info(`[routes] AC control ${command}=${JSON.stringify(value)} → ${deviceId} (${authKind}, ip=${ip})`);
    void pool
      .query(
        `INSERT INTO ac_control_audit (device_id, command, value, auth_kind, ip, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [deviceId, command, JSON.stringify(value ?? null), authKind, ip, userAgent],
      )
      .catch((err) => log.error("[routes] AC control audit insert failed:", err));

    const now = Date.now();
    if (now - lastAcAuditPruneAt > 24 * 3_600_000) {
      lastAcAuditPruneAt = now;
      void pool
        .query("DELETE FROM ac_control_audit WHERE at < NOW() - ($1 || ' days')::interval", [
          String(AC_AUDIT_RETENTION_DAYS),
        ])
        .catch((err) => log.error("[routes] AC control audit prune failed:", err));
    }
  }

  const LEVELING_AUDIT_RETENTION_DAYS = 30;
  let lastLevelingAuditPruneAt = 0;

  /**
   * Durable record of who changed Smart AC Leveling config. On 2026-08-06 someone
   * disabled the whole controller from the dashboard and it stayed off 7h12m with
   * NOTHING to attribute it — PUT /api/ac/leveling was neither audited nor logged,
   * unlike the per-AC ac_control_audit path. Killing the controller is at least as
   * loud as a shed now. Fire-and-forget: an audit failure must never fail the save.
   */
  function auditLevelingConfig(req: Request, changedKeys: string[], enabledBefore: boolean | null, enabledAfter: boolean): void {
    const authKind: AuthKind = req.authKind ?? "user";
    const ip = clientIp(req);
    const uaHeader = req.headers["user-agent"];
    const userAgent = (Array.isArray(uaHeader) ? uaHeader[0] : uaHeader)?.slice(0, 300) ?? null;
    log.info(`[routes] Leveling config saved: keys=[${changedKeys.join(",")}] enabled ${enabledBefore}→${enabledAfter} (${authKind}, ip=${ip})`);
    void pool
      .query(
        `INSERT INTO ac_leveling_config_audit (auth_kind, ip, user_agent, changed_keys, enabled_before, enabled_after)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [authKind, ip, userAgent, changedKeys, enabledBefore, enabledAfter],
      )
      .catch((err) => log.warn("[routes] Leveling config audit insert failed:", err));

    const now = Date.now();
    if (now - lastLevelingAuditPruneAt > 24 * 3_600_000) {
      lastLevelingAuditPruneAt = now;
      void pool
        .query("DELETE FROM ac_leveling_config_audit WHERE at < NOW() - ($1 || ' days')::interval", [
          String(LEVELING_AUDIT_RETENTION_DAYS),
        ])
        .catch((err) => log.warn("[routes] Leveling config audit prune failed:", err));
    }
  }

  /**
   * Push to the "Smart AC Leveling alerts" audience (opt-in subscriptions). Mirrors
   * collector.broadcastPush — which is private to the Collector and not injected
   * here — so the PUT handler can announce a controller ON/OFF flip from the same
   * request path that persists it, the way notifyAcLockCleared announces a released
   * manual-off. Fire-and-forget: a push failure never fails the save.
   */
  async function broadcastLevelingPush(payload: Record<string, unknown>): Promise<void> {
    try {
      const result = await pool.query(
        "SELECT subscription FROM push_subscriptions WHERE leveling_notifications = true",
      );
      for (const row of result.rows) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await webpush.sendNotification(row.subscription as any, JSON.stringify(payload));
        } catch (err) {
          log.warn(`[routes] Leveling config push failed:`, (err as Error).message);
        }
      }
    } catch (err) {
      log.warn("[routes] Leveling config push broadcast failed:", (err as Error).message);
    }
  }

  router.post("/api/ac/devices/:id/control", requireAuth, async (req: Request, res: Response) => {
    const cloud = getTclCloud?.();
    if (!cloud || !cloud.isReady()) {
      res.status(503).json({ error: "TCL Cloud not available" });
      return;
    }
    const id = String(req.params.id);
    const { command, value } = req.body as { command: string; value: unknown };
    if (!command || typeof command !== "string") {
      res.status(400).json({ error: "command is required" });
      return;
    }
    try {
      const validation = await cloud.validateControlLive(id, command, value);
      if (!validation.ok) {
        res.status(validation.status).json({ error: validation.error });
        return;
      }
      auditAcControl(req, id, command, value);
      // A user touching any AC mid-calibration aborts the run — their intent wins
      acCalibration?.requestAbort("user_control");
      // Releasing a manual-off lock is the one command that undoes the user's
      // sacred off — notify so an ON nobody at home made surfaces within
      // seconds instead of being found in rotated logs. The release is reported
      // by clear() itself, so two concurrent turn-ons can't both claim it and
      // double-push. Claimed BEFORE the send (same reason the OFF branch records
      // first): the send's restoreLastState lets the TCL shadow echo our own ON
      // ~1s later, and the device poll's observed-ON reconcile then wins the
      // atomic release and clears it silently — this call site is the only one
      // that knows the actor, so its push is lost (2026-08-05 00:42:34). If the
      // send then throws, the lock stays released: the user's latest intent was
      // ON, and the 500 tells them the command itself failed.
      const releasedLock = command === "set_power" && value === 1
        ? await acManualOffLocks?.clear(id)
        : false;
      if (releasedLock) acManualOffLocks?.notifyLockCleared?.(id, req.authKind ?? "user", clientIp(req));
      const protectsManualOff = (command === "set_power" && value === 0)
        || (command === "set_self_clean" && value === 1);
      if (protectsManualOff) {
        // Establish intent before the cloud command: a fast shadow poll must
        // never let an automation or the leveler turn the unit back on.
        await acManualOffLocks?.record(id, command === "set_self_clean" ? "self_clean" : "ui");
        if (isAcLevelingEligible(id)) await acLeveling?.onUserPowerOff(id);
      }
      // Claim per-field manual ownership before the cloud send. A verified
      // command may spend 5–20s confirming; the automation loop must not race
      // in during that window and restore the old system value.
      acManualOffLocks?.onUserProfileChange?.(id, command);
      // Verified send: the firmware (Najat especially) sometimes accepts a
      // command without applying it — the shadow is re-checked every 5s and
      // the command re-sent up to 3 times (gen level/beep/fan-auto excluded).
      await cloud.sendControlVerified(id, command, value);
      if (command === "set_power") {
        if (value === 1 && isAcLevelingEligible(id)) {
          await acLeveling?.onUserPowerOn(id);
        }
      } else if (command === "set_generator_mode" && typeof value === "number") {
        const eligible = isAcLevelingEligible(id);
        if (!eligible) acLeveling?.noteUserGenLevel?.(id, value);
        const result = eligible ? await acLeveling?.onUserGenLevel(id, value) : undefined;
        res.json({ ok: true, ...(result?.reverted ? { reverted: true, level: result.level } : {}) });
        return;
      } else if (command === "set_fan_speed" && value === 0) {
        acManualOffLocks?.onUserFanAuto?.(id);
      } else if (command === "set_fan_speed" || command === "set_turbo") {
        acManualOffLocks?.onUserFanChange?.(id);
      } else if (command === "set_vertical_swing") {
        acManualOffLocks?.onUserSwingChange?.(id);
      } else if (command === "set_beep") {
        acManualOffLocks?.onUserBeep?.(id, value === 1);
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ---------- AC Timers ----------

  router.get("/api/ac/timers", requireAuth, (_req: Request, res: Response) => {
    const timers = Array.from(acTimers.values());
    res.json({ timers });
  });

  router.post("/api/ac/timer", requireAuth, async (req: Request, res: Response) => {
    const { deviceId, action, minutes, preset } = req.body as { deviceId: string; action: "on" | "off"; minutes: number; preset?: Record<string, unknown> };
    if (!deviceId || !action || !minutes) { res.status(400).json({ error: "deviceId, action, minutes required" }); return; }
    if (action !== "on" && action !== "off") { res.status(400).json({ error: "action must be 'on' or 'off'" }); return; }
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 480) { res.status(400).json({ error: "minutes must be 1–480" }); return; }
    const cloud = getTclCloud?.();
    if (!cloud || !cloud.isReady()) { res.status(503).json({ error: "TCL Cloud not available" }); return; }
    await cloud.ensureDeviceCachePopulated();
    const knownDevice = cloud.sanitizeAcAction(deviceId, {});
    if (!knownDevice) { res.status(404).json({ error: `Unknown AC device: ${deviceId}` }); return; }
    if (action === "on" && await acManualOffLocks?.isLocked(deviceId)) {
      res.status(409).json({ error: "AC is manually off. Turn it on manually before setting an on timer." });
      return;
    }
    const safePreset = action === "on" && preset
      ? cloud.sanitizeAcAction(deviceId, preset as AcAction) ?? undefined
      : undefined;
    const fireAt = Date.now() + minutes * 60_000;
    acTimers.set(deviceId, { deviceId, action, preset: safePreset, fireAt });
    res.json({ ok: true, fireAt });
  });

  router.delete("/api/ac/timer/:deviceId", requireAuth, (req: Request, res: Response) => {
    acTimers.delete(String(req.params.deviceId));
    res.json({ ok: true });
  });

  // ---------- Smart AC Leveling ----------

  function validateLevelingConfig(b: Partial<AcLevelingConfig>): string | null {
    const num = (v: unknown): v is number => typeof v === "number" && isFinite(v);
    if (typeof b.enabled !== "boolean") return "enabled must be boolean";
    if (!num(b.gridLimitAmps) || b.gridLimitAmps < 1 || b.gridLimitAmps > 100) return "gridLimitAmps must be 1–100";
    if (!num(b.genLimitAmps) || b.genLimitAmps < 1 || b.genLimitAmps > 100) return "genLimitAmps must be 1–100";
    if (!num(b.marginAmps) || b.marginAmps < 0 || b.marginAmps > 10) return "marginAmps must be 0–10";
    // Optional for backward compatibility (old clients omit it → defaults to 1).
    if (b.raiseBufferAmps != null && (!num(b.raiseBufferAmps) || b.raiseBufferAmps < 0 || b.raiseBufferAmps > 10)) return "raiseBufferAmps must be 0–10";
    if (!num(b.comfortTargetC) || b.comfortTargetC < 16 || b.comfortTargetC > 32) return "comfortTargetC must be 16–32";
    // Optional for backward compatibility (old clients omit it → defaults to 0.5).
    if (b.nearTargetBandC != null && (!num(b.nearTargetBandC) || b.nearTargetBandC < 0 || b.nearTargetBandC > 5)) return "nearTargetBandC must be 0–5";
    // Optional (old clients omit → defaults to 1). Integer 1–3: levels an AC may
    // be raised per batch on each source. 1 = one-step pacing; ≥2 is no pacing
    // for 3-level ACs (L1→L3 fits in one batch).
    if (b.maxRaiseStepGrid != null && (!Number.isInteger(b.maxRaiseStepGrid) || b.maxRaiseStepGrid < 1 || b.maxRaiseStepGrid > 3)) return "maxRaiseStepGrid must be an integer 1–3";
    if (b.maxRaiseStepGen != null && (!Number.isInteger(b.maxRaiseStepGen) || b.maxRaiseStepGen < 1 || b.maxRaiseStepGen > 3)) return "maxRaiseStepGen must be an integer 1–3";
    if (!Array.isArray(b.priority) || b.priority.some((p) => typeof p !== "string")) return "priority must be a string array";
    if (!b.ampModels || typeof b.ampModels !== "object") return "ampModels required";
    for (const model of Object.values(b.ampModels as Record<string, AcAmpModel>)) {
      if (!model || !num(model.baseAmps) || model.baseAmps < 0.5 || model.baseAmps > 20) return "baseAmps must be 0.5–20";
      if (!num(model.stepAmps) || model.stepAmps < 0 || model.stepAmps > 10) return "stepAmps must be 0–10";
    }
    if (b.genAmpModels != null) {
      if (typeof b.genAmpModels !== "object" || Array.isArray(b.genAmpModels)) return "genAmpModels must be an object";
      for (const model of Object.values(b.genAmpModels as Record<string, AcAmpModel>)) {
        if (!model || !num(model.baseAmps) || model.baseAmps < 0.5 || model.baseAmps > 20) return "gen baseAmps must be 0.5–20";
        if (!num(model.stepAmps) || model.stepAmps < 0 || model.stepAmps > 10) return "gen stepAmps must be 0–10";
      }
    }
    if (b.levelBoosts != null) {
      if (typeof b.levelBoosts !== "object" || Array.isArray(b.levelBoosts)) return "levelBoosts must be an object";
      for (const boost of Object.values(b.levelBoosts as Record<string, AcLevelBoost>)) {
        if (!boost || !Number.isInteger(boost.minLevel) || boost.minLevel < 1 || boost.minLevel > MAX_GENERATOR_LEVEL) return `boost minLevel must be 1–${MAX_GENERATOR_LEVEL}`;
        if (!num(boost.outdoorAtLeastC) || boost.outdoorAtLeastC < 25 || boost.outdoorAtLeastC > 55) return "boost outdoor temp must be 25–55";
      }
    }
    if (b.needOverrides != null) {
      if (typeof b.needOverrides !== "object" || Array.isArray(b.needOverrides)) return "needOverrides must be an object";
      for (const o of Object.values(b.needOverrides as Record<string, AcNeedOverride>)) {
        if (!o || typeof o !== "object") return "needOverride must be an object";
        if (o.tempOffsetC != null && (!num(o.tempOffsetC) || o.tempOffsetC < -5 || o.tempOffsetC > 5)) return "needOverride tempOffsetC must be -5–5";
        if (o.targetFromSetpoint != null && typeof o.targetFromSetpoint !== "boolean") return "needOverride targetFromSetpoint must be boolean";
      }
    }
    const policyError = validateLevelingDeviceReferences(b as Record<string, unknown>);
    if (policyError) return policyError;
    return null;
  }

  router.get("/api/ac/leveling", requireAuth, async (_req: Request, res: Response) => {
    if (!acLeveling) { res.status(503).json({ error: "Smart AC leveling not available" }); return; }
    try {
      const config = await acLeveling.getConfig();
      res.json({ config, status: acLeveling.getStatus() });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.put("/api/ac/leveling", requireAuth, async (req: Request, res: Response) => {
    if (!acLeveling) { res.status(503).json({ error: "Smart AC leveling not available" }); return; }
    const body = req.body as Partial<AcLevelingConfig>;
    const validationError = validateLevelingConfig(body);
    if (validationError) { res.status(400).json({ error: validationError }); return; }
    try {
      // Read the pre-save config BEFORE we persist so the audit's before-image and
      // the enabled transition reflect the real prior state (2026-08-06: a dashboard
      // disable that stayed off 7h12m with nothing to attribute it). getConfig() is
      // the acting controller's merged view — the cleanest existing read.
      const prevConfig = (await acLeveling.getConfig().catch(() => ({}))) as Record<string, unknown>;
      const enabledBefore = prevConfig.enabled === true ? true : prevConfig.enabled === false ? false : null;
      const enabledAfter = body.enabled === true;
      const config = await acLeveling.updateConfig({
        enabled: body.enabled === true,
        gridLimitAmps: body.gridLimitAmps as number,
        genLimitAmps: body.genLimitAmps as number,
        marginAmps: body.marginAmps as number,
        raiseBufferAmps: (body.raiseBufferAmps as number) ?? 0.2,
        comfortTargetC: body.comfortTargetC as number,
        nearTargetBandC: (body.nearTargetBandC as number) ?? 0.5,
        priority: body.priority as string[],
        ampModels: body.ampModels as Record<string, AcAmpModel>,
        genAmpModels: (body.genAmpModels as Record<string, AcAmpModel>) ?? {},
        levelBoosts: (body.levelBoosts as Record<string, AcLevelBoost>) ?? {},
        // Forwarded ONLY when the body carries it — deliberately NOT the `?? {}`
        // its neighbours use. The dashboard UI does not know this field, so a
        // default of `{}` would make every ordinary UI save erase the stored
        // override: the save path merges the given keys over row 1, which
        // preserves an omitted key and overwrites an explicit empty one.
        ...(body.needOverrides != null ? { needOverrides: body.needOverrides } : {}),
        maxRaiseStepGrid: (body.maxRaiseStepGrid as number) ?? 1,
        maxRaiseStepGen: (body.maxRaiseStepGen as number) ?? 1,
      });
      // Forward v2-owned fields (controller flag, resting buffer, calm gates,
      // fan trim) to the v2 controller's own config row when present.
      const v2Body = req.body as Record<string, unknown>;
      const v2Keys = ["controller", "restingBufferAmps", "raiseCalmSeconds", "restoreCalmSeconds", "fanTrimEnabled"];
      if (acLeveling.updateV2Config && v2Keys.some((k) => k in v2Body)) {
        const flavor = v2Body.controller;
        if (flavor != null && flavor !== "v1" && flavor !== "shadow" && flavor !== "v2") {
          res.status(400).json({ error: "controller must be v1|shadow|v2" });
          return;
        }
        const num = (key: string, min: number, max: number): boolean => {
          const v = v2Body[key];
          return v == null || (typeof v === "number" && v >= min && v <= max);
        };
        if (!num("restingBufferAmps", 0, 10) || !num("raiseCalmSeconds", 5, 600) || !num("restoreCalmSeconds", 5, 600)) {
          res.status(400).json({ error: "invalid v2 leveling field" });
          return;
        }
        await acLeveling.updateV2Config(Object.fromEntries(v2Keys.filter((k) => k in v2Body).map((k) => [k, v2Body[k]])));
      }
      // Attribute the save: which top-level keys changed and any enabled flip. Loud
      // like a shed — killing the controller must leave a trail (ac_control_audit did
      // for per-AC commands; this PUT did not, hence the 2026-08-06 blind spot).
      const changedKeys = computeChangedKeys(prevConfig, req.body as Record<string, unknown>);
      auditLevelingConfig(req, changedKeys, enabledBefore, enabledAfter);
      // A controller ON/OFF flip is announced to the leveling-alerts audience the same
      // way a released manual-off is: OFF is CRITICAL (the household current is no longer
      // being kept under the breaker limit), ON is a normal-urgency all-clear.
      const source = (req.authKind ?? "user") === "agent" ? "the Hermes agent" : "the dashboard";
      if (enabledBefore === true && enabledAfter === false) {
        void broadcastLevelingPush({
          title: "Smart AC Leveling turned OFF",
          body: `Smart AC Leveling was turned OFF from ${source} (${clientIp(req)}) — household current is no longer kept under the breaker limit.`,
          type: "leveling",
        });
      } else if (enabledBefore === false && enabledAfter === true) {
        void broadcastLevelingPush({
          title: "Smart AC Leveling turned back ON",
          body: `Smart AC Leveling was turned back ON from ${source} (${clientIp(req)}).`,
          type: "leveling",
        });
      }
      res.json({ config });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // v2 decision journal — durable forensics (docker logs rotate in ~1.5 days).
  router.get("/api/ac/leveling/journal", requireAuth, async (req: Request, res: Response) => {
    if (!acLeveling?.getJournal) { res.status(503).json({ error: "journal not available" }); return; }
    const hours = Math.max(1, Math.min(24 * 60, Number(req.query.hours) || 24));
    try {
      res.json({ hours, entries: (await acLeveling.getJournal(hours)).map((r) => rowToDict(r as Record<string, unknown>)) });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Explicit learned-cost reset (config saves no longer wipe them in v2).
  router.post("/api/ac/leveling/costs/reset", requireAuth, async (_req: Request, res: Response) => {
    if (!acLeveling?.resetCosts) { res.status(503).json({ error: "not available" }); return; }
    try {
      await acLeveling.resetCosts();
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ---------- AC Calibration ----------

  router.get("/api/ac/calibration", requireAuth, async (_req: Request, res: Response) => {
    if (!acCalibration) { res.status(503).json({ error: "Calibration not available" }); return; }
    try {
      const { results, suggestedFit } = await acCalibration.getResults();
      res.json({ status: acCalibration.getStatus(), results, suggestedFit });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post("/api/ac/calibration/start", requireAuth, async (req: Request, res: Response) => {
    if (!acCalibration) { res.status(503).json({ error: "Calibration not available" }); return; }
    const { deviceIds, includeFan } = req.body as { deviceIds?: unknown; includeFan?: unknown };
    if (!Array.isArray(deviceIds) || deviceIds.length === 0 || deviceIds.some((id) => typeof id !== "string")) {
      res.status(400).json({ error: "deviceIds must be a non-empty string array" });
      return;
    }
    try {
      const result = await acCalibration.start(deviceIds as string[], includeFan !== false);
      if ("error" in result) {
        res.status(result.status).json({ error: result.error });
        return;
      }
      res.status(202).json({ ok: true, status: acCalibration.getStatus() });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post("/api/ac/calibration/abort", requireAuth, async (_req: Request, res: Response) => {
    if (!acCalibration) { res.status(503).json({ error: "Calibration not available" }); return; }
    try {
      await acCalibration.abort("user_abort");
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ---------- AC Presets (server-side) ----------

  router.get("/api/ac/presets/:deviceId", requireAuth, async (req: Request, res: Response) => {
    const deviceId = String(req.params.deviceId);
    const result = await pool.query("SELECT slot, data FROM ac_presets WHERE device_id = $1 ORDER BY slot", [deviceId]);
    const presets: Record<number, unknown> = { 1: null, 2: null, 3: null, 4: null, 5: null, 6: null, 7: null, 8: null, 9: null, 10: null };
    for (const row of result.rows) presets[row.slot] = row.data;
    res.json({ presets });
  });

  router.put("/api/ac/presets/:deviceId/:slot", requireAuth, async (req: Request, res: Response) => {
    const deviceId = String(req.params.deviceId);
    const slot = parseInt(String(req.params.slot), 10);
    if (isNaN(slot) || slot < 1 || slot > 10) { res.status(400).json({ error: "Slot must be 1-10" }); return; }
    const { presetData } = req.body as { presetData: Record<string, unknown> };
    if (!presetData || typeof presetData !== "object") { res.status(400).json({ error: "presetData required" }); return; }
    const deviceErr = await knownAcDeviceError([deviceId]);
    if (deviceErr) { res.status(deviceErr.status).json({ error: deviceErr.error }); return; }
    await pool.query(
      `INSERT INTO ac_presets (device_id, slot, data, updated_at) VALUES ($1, $2, $3::jsonb, NOW())
       ON CONFLICT (device_id, slot) DO UPDATE SET data = $3::jsonb, updated_at = NOW()`,
      [deviceId, slot, JSON.stringify(presetData)],
    );
    res.json({ ok: true });
  });

  // ---------- Preset Sync ----------

  function presetDataToAcAction(presetData: Record<string, unknown>): AcAction {
    const binary = (value: unknown): unknown => typeof value === "boolean" ? (value ? 1 : 0) : value;
    return {
      ...(presetData.mode != null ? { mode: presetData.mode as number } : {}),
      ...(presetData.targetTemp != null ? { temperature: presetData.targetTemp as number } : {}),
      ...(presetData.fanSpeed != null ? { fan_speed: presetData.fanSpeed as number } : {}),
      ...(presetData.eco != null ? { eco: binary(presetData.eco) as number } : {}),
      ...(presetData.turbo != null ? { turbo: binary(presetData.turbo) as number } : {}),
      ...(presetData.screen != null ? { screen: binary(presetData.screen) as number } : {}),
      ...(presetData.verticalSwing != null ? { vertical_swing: presetData.verticalSwing as number } : {}),
      ...(presetData.horizontalSwing != null ? { horizontal_swing: presetData.horizontalSwing as number } : {}),
      ...(presetData.freshAir != null ? { fresh_air: binary(presetData.freshAir) as number } : {}),
      ...(presetData.generatorMode != null ? { generator_mode: presetData.generatorMode as number } : {}),
    };
  }

  router.post("/api/ac/preset-sync", requireAuth, async (req: Request, res: Response) => {
    const { deviceId, slot, presetData } = req.body as { deviceId: string; slot: number; presetData: Record<string, unknown> };
    if (!deviceId || !slot || !presetData) { res.status(400).json({ error: "deviceId, slot, presetData required" }); return; }
    const deviceErr = await knownAcDeviceError([deviceId]);
    if (deviceErr) { res.status(deviceErr.status).json({ error: deviceErr.error }); return; }

    await pool.query(
      `INSERT INTO ac_presets (device_id, slot, data, updated_at) VALUES ($1, $2, $3::jsonb, NOW())
       ON CONFLICT (device_id, slot) DO UPDATE SET data = $3::jsonb, updated_at = NOW()`,
      [deviceId, slot, JSON.stringify(presetData)],
    );

    const actionOn = JSON.stringify({
      power: 1,
      mode: presetData.mode,
      temperature: presetData.targetTemp,
      fan_speed: presetData.fanSpeed,
      eco: presetData.eco ? 1 : 0,
      turbo: presetData.turbo ? 1 : 0,
      screen: presetData.screen ? 1 : 0,
      vertical_swing: presetData.verticalSwing,
      horizontal_swing: presetData.horizontalSwing,
      fresh_air: presetData.freshAir ? 1 : 0,
      generator_mode: presetData.generatorMode,
      _preset_slot: slot,
    });

    const result = await pool.query(
      `UPDATE automations SET action_on = $1::jsonb
       WHERE device_type = 'ac' AND $2 = ANY(device_ids)
       AND (action_on->>'_preset_slot')::int = $3`,
      [actionOn, deviceId, slot],
    );
    res.json({ ok: true, updated: result.rowCount });
  });

  // ---------- Preset Apply (update active automations) ----------

  router.post("/api/ac/preset-apply", requireAuth, async (req: Request, res: Response) => {
    const { deviceId, slot, presetData } = req.body as { deviceId: string; slot: number; presetData: Record<string, unknown> };
    if (!deviceId || !Number.isInteger(slot) || slot < 1 || slot > 10 || !presetData || typeof presetData !== "object") {
      res.status(400).json({ error: "deviceId, slot 1–10, and presetData required" });
      return;
    }
    const cloud = getTclCloud?.();
    if (!cloud || !cloud.isReady()) { res.status(503).json({ error: "TCL Cloud not available" }); return; }
    try {
      await cloud.ensureDeviceCachePopulated();
      const action = cloud.sanitizeAcAction(deviceId, presetDataToAcAction(presetData));
      if (!action) { res.status(404).json({ error: `Unknown AC device: ${deviceId}` }); return; }

      // One server-side profile avoids mode-dependent validation races such as
      // Fan→Cool followed immediately by Eco while the shadow still says Fan.
      acCalibration?.requestAbort("user_control");
      auditAcControl(req, deviceId, "apply_preset", { slot, action });
      const delivery = await cloud.executeAcActionVerified(deviceId, action);
      if (delivery === "superseded") {
        res.status(409).json({ error: "Preset was superseded by a newer AC control" });
        return;
      }
      if (action.generator_mode != null) {
        const eligible = isAcLevelingEligible(deviceId);
        if (!eligible) acLeveling?.noteUserGenLevel?.(deviceId, action.generator_mode);
        else await acLeveling?.onUserGenLevel(deviceId, action.generator_mode);
      }
      if (action.fan_speed === 0) acManualOffLocks?.onUserFanAuto?.(deviceId);
      else if (action.fan_speed != null || action.turbo != null) acManualOffLocks?.onUserFanChange?.(deviceId);
      if (action.vertical_swing != null) acManualOffLocks?.onUserSwingChange?.(deviceId);

      const actionOn = JSON.stringify({ power: 1, ...action, _preset_slot: slot });
      const result = await pool.query(
        `UPDATE automations SET action_on = $1::jsonb
         WHERE device_type = 'ac' AND enabled = true AND $2 = ANY(device_ids)`,
        [actionOn, deviceId],
      );
      onAutomationRulesChanged?.();
      res.json({ ok: true, updated: result.rowCount, action });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
