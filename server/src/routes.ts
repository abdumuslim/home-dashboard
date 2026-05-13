import { Router, type Request, type Response } from "express";
import pg from "pg";
import { Coordinates, CalculationMethod, PrayerTimes, Prayer, Rounding } from "adhan";
import type { Config } from "./config.js";
import { ALERT_METRICS, VALID_PRAYER_NAMES, PRAYER_LABELS } from "./alert-metrics.js";
import type { XiaomiCloud } from "./xiaomi-cloud.js";
import type { TclCloud } from "./tcl-cloud.js";
import type { ForecastResponse } from "./forecast.js";
import { createAuthMiddleware, requireAuth, handleLogin, handleLogout, handleAuthStatus } from "./auth.js";

export interface AcTimer {
  deviceId: string;
  action: "on" | "off";
  preset?: Record<string, unknown>;
  fireAt: number;
}

export const acTimers = new Map<string, AcTimer>();

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

export function createRouter(pool: pg.Pool, config?: Config, getXiaomiCloud?: () => XiaomiCloud | null, getTclCloud?: () => TclCloud | null, getLatestAir?: () => Record<string, unknown> | null, getForecast?: () => ForecastResponse | null, onPowerIngest?: (data: { ts: string; voltage: number; current_1: number; current_2: number; power_1: number; power_2: number }) => void, onAutomationRulesChanged?: () => void): Router {
  const router = Router();

  // Health check — before auth middleware, no auth required
  router.get("/api/health", async (_req: Request, res: Response) => {
    try {
      await pool.query("SELECT 1");
      res.json({ status: "ok", uptime: process.uptime() });
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

  // Prayer times — public, computed server-side via adhan library
  const BAGHDAD = new Coordinates(33.321502, 44.358335);
  const PRAYER_CALC = CalculationMethod.Dubai();
  PRAYER_CALC.adjustments = { fajr: 0, sunrise: 2, dhuhr: 2, asr: 0, maghrib: 0, isha: -6 };
  PRAYER_CALC.rounding = Rounding.None;

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

  function roundPrayer(date: Date, prayer: string): Date {
    const d = new Date(date);
    const s = d.getSeconds();
    const ms = d.getMilliseconds();
    if (prayer === "fajr") {
      if (s > 0 || ms > 0) d.setMinutes(d.getMinutes() + 1);
    } else {
      if (s >= 30) d.setMinutes(d.getMinutes() + 1);
    }
    d.setSeconds(0, 0);
    return d;
  }

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

  router.get("/api/prayer-times", (_req: Request, res: Response) => {
    const now = new Date();
    const dateKey = now.toLocaleDateString("en-CA", { timeZone: "Asia/Baghdad" });
    const [y, m, d] = dateKey.split("-").map(Number);
    const pt = new PrayerTimes(BAGHDAD, new Date(y, m - 1, d, 12, 0, 0), PRAYER_CALC);

    const tomorrow = new Date(y, m - 1, d + 1, 12, 0, 0);
    const ptTomorrow = new PrayerTimes(BAGHDAD, tomorrow, PRAYER_CALC);

    const prayerOrder: { key: string; label: string }[] = [
      { key: "fajr", label: "Fajr" },
      { key: "sunrise", label: "Sunrise" },
      { key: "dhuhr", label: "Dhuhr" },
      { key: "asr", label: "Asr" },
      { key: "maghrib", label: "Maghrib" },
      { key: "isha", label: "Isha" },
    ];

    const nowMs = now.getTime();
    const nextPrayerEnum = pt.nextPrayer(now);
    const allPassed = nextPrayerEnum === Prayer.None;

    const prayers = prayerOrder.map(({ key, label }) => {
      const raw = pt[key as keyof PrayerTimes] as Date;
      const time = roundPrayer(raw, key);
      const diffMs = time.getTime() - nowMs;
      const isPassed = diffMs < 0;
      const isNext = !allPassed && nextPrayerEnum === key;
      return {
        name: key,
        label,
        time: fmtTime(time),
        isPassed,
        isNext,
        countdown: isPassed ? null : fmtCountdown(diffMs),
      };
    });

    let nextPrayer: { name: string; label: string; time: string; countdown: string } | null = null;
    if (allPassed) {
      const fajrTime = roundPrayer(ptTomorrow.fajr, "fajr");
      const diffMs = fajrTime.getTime() - nowMs;
      nextPrayer = { name: "fajr", label: "Fajr (tomorrow)", time: fmtTime(fajrTime), countdown: fmtCountdown(diffMs) };
    } else {
      const p = prayers.find((p) => p.isNext);
      if (p) nextPrayer = { name: p.name, label: p.label, time: p.time, countdown: p.countdown! };
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

    res.json({ prayers, nextPrayer, hijriDate, nextEvent });
  });

  // Auth middleware — sets req.authenticated on every request
  if (config) {
    router.use(createAuthMiddleware(config));
  }

  // Auth routes
  router.post("/api/auth/login", handleLogin(config!));
  router.post("/api/auth/logout", handleLogout);
  router.get("/api/auth/me", handleAuthStatus);

  // In-memory latest power reading (updated every ingest ~1s), saved to DB every 60s
  let latestPower: { ts: string; voltage: number; current_1: number; current_2: number; power_1: number; power_2: number } | null = null;
  let lastPowerSave = 0;
  const POWER_SAVE_INTERVAL = 60_000;
  const powerBuffer: { v: number; i1: number; i2: number }[] = [];

  router.get("/api/current", async (_req: Request, res: Response) => {
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

    res.json({
      weather: weatherRow,
      air: air ?? (airResult?.rows[0] ? rowToDict(airResult.rows[0]) : null),
      power: power ?? (powerResult?.rows[0] ? rowToDict(powerResult.rows[0]) as any : null),
    });
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
    device_ids: string[];
    device_names: string[];
    enabled?: boolean;
    ac_profile?: Record<string, unknown>;
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
  }

  type AutomationBody = MetricAutomationBody | ScheduleAutomationBody;

  function validateAcProfile(p: unknown): string | null {
    if (!p || typeof p !== "object") return "AC profile required";
    const { mode, temperature, fan_speed } = p as Record<string, number>;
    if (mode == null || !Number.isInteger(mode) || mode < 0 || mode > 4) return "Mode must be 0–4";
    if (temperature == null || !Number.isInteger(temperature) || temperature < 16 || temperature > 36) return "Temperature must be 16–36";
    if (fan_speed == null || !Number.isInteger(fan_speed) || fan_speed < 0 || fan_speed > 7) return "Fan speed must be 0–7";
    return null;
  }

  function validateMetricAutomation(body: MetricAutomationBody): string | null {
    if (!body.metric || !(body.metric in ALERT_METRICS)) return "Invalid metric";
    if (body.device_type !== "ac" && ALERT_METRICS[body.metric].source !== "air") return "Only air quality metrics allowed for purifiers";
    const def = ALERT_METRICS[body.metric];
    if (typeof body.threshold !== "number" || !isFinite(body.threshold)) return "Threshold must be a finite number";
    if (body.threshold < def.min || body.threshold > def.max) return `Threshold must be between ${def.min} and ${def.max}`;

    if (body.device_type === "ac") {
      if (typeof body.threshold_low !== "number" || !isFinite(body.threshold_low)) return "Low threshold required for AC range";
      if (body.threshold_low < def.min || body.threshold_low > def.max) return `Low threshold must be between ${def.min} and ${def.max}`;
      if (body.threshold_low >= body.threshold) return "Low threshold must be less than high threshold";
      const profileErr = validateAcProfile(body.ac_profile);
      if (profileErr) return profileErr;
    } else {
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
         device_id, device_name, device_ids, device_names, action_on, action_off, cooldown_secs)
         VALUES ($1, $2, 'schedule', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb, $18::jsonb, 60) RETURNING *`,
        [name, sb.enabled ?? true, devType,
         startMode === "exact" ? sb.time_start : null, endMode === "exact" ? sb.time_end : null, turnOff,
         startMode, startMode === "prayer" ? sb.start_prayer : null, startMode === "prayer" ? sb.start_prayer_offset : null,
         endMode, endMode === "prayer" ? sb.end_prayer : null, endMode === "prayer" ? sb.end_prayer_offset : null,
         sb.device_ids[0], sb.device_names[0] ?? sb.device_ids[0], sb.device_ids, sb.device_names, actionOn, actionOff],
      );
      res.json({ automation: result.rows[0] });
    } else {
      const mb = body as MetricAutomationBody;
      const err = validateMetricAutomation(mb);
      if (err) { res.status(400).json({ error: err }); return; }

      const mins = mb.sustained_minutes ?? 0;
      const devType = mb.device_type ?? "purifier";
      const isAcRange = devType === "ac" && mb.threshold_low != null;
      const turnOff = isAcRange ? true : (mb.turn_off_at_end ?? false);
      const condition = isAcRange ? "above" : mb.condition;

      let name: string;
      if (isAcRange && mb.ac_profile) {
        const modeName = AC_MODE_NAMES[mb.ac_profile.mode as number] ?? "?";
        name = `${ALERT_METRICS[mb.metric].label} ${mb.threshold_low}°–${mb.threshold}° → ${modeName} ${mb.ac_profile.temperature}°`;
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
        `INSERT INTO automations (name, enabled, automation_type, device_type, metric, condition, threshold, threshold_low, sustained_minutes, turn_off_at_end, device_id, device_name, device_ids, device_names, action_on, action_off, cooldown_secs)
         VALUES ($1, $2, 'metric', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15::jsonb, 5) RETURNING *`,
        [name, mb.enabled ?? true, devType, mb.metric, condition, mb.threshold, mb.threshold_low ?? null, mins, turnOff, mb.device_ids[0], mb.device_names[0] ?? mb.device_ids[0], mb.device_ids, mb.device_names, actionOn, actionOff],
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
         metric=NULL, condition=NULL, threshold=NULL, sustained_minutes=0,
         action_on=$13::jsonb, action_off=$14::jsonb, device_id=$15, device_name=$16, device_ids=$17, device_names=$18
         WHERE id=$19 RETURNING *`,
        [name, sb.enabled ?? true, devType,
         startMode === "exact" ? sb.time_start : null, endMode === "exact" ? sb.time_end : null, turnOff,
         startMode, startMode === "prayer" ? sb.start_prayer : null, startMode === "prayer" ? sb.start_prayer_offset : null,
         endMode, endMode === "prayer" ? sb.end_prayer : null, endMode === "prayer" ? sb.end_prayer_offset : null,
         actionOn, actionOff, sb.device_ids[0], sb.device_names[0] ?? sb.device_ids[0], sb.device_ids, sb.device_names, id],
      );
      if (result.rowCount === 0) { res.status(404).json({ error: "Not found" }); return; }
      res.json({ automation: result.rows[0] });
    } else {
      const mb = body as MetricAutomationBody;
      const err = validateMetricAutomation(mb);
      if (err) { res.status(400).json({ error: err }); return; }

      const mins = mb.sustained_minutes ?? 0;
      const devType = mb.device_type ?? "purifier";
      const isAcRange = devType === "ac" && mb.threshold_low != null;
      const turnOff = isAcRange ? true : (mb.turn_off_at_end ?? false);
      const condition = isAcRange ? "above" : mb.condition;

      let name: string;
      if (isAcRange && mb.ac_profile) {
        const modeName = AC_MODE_NAMES[mb.ac_profile.mode as number] ?? "?";
        name = `${ALERT_METRICS[mb.metric].label} ${mb.threshold_low}°–${mb.threshold}° → ${modeName} ${mb.ac_profile.temperature}°`;
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
         device_id=$12, device_name=$13, device_ids=$14, device_names=$15
         WHERE id=$16 RETURNING *`,
        [name, mb.enabled ?? true, devType, mb.metric, condition, mb.threshold, mb.threshold_low ?? null, mins, turnOff, actionOn, actionOff, mb.device_ids[0], mb.device_names[0] ?? mb.device_ids[0], mb.device_ids, mb.device_names, id],
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
      res.json({ devices, available: true });
    } catch (err) {
      res.json({ devices: cloud.getDevices(), available: true, error: (err as Error).message });
    }
  });

  const ALLOWED_AC_COMMANDS = ["set_power", "set_mode", "set_temperature", "set_fan_speed", "set_eco", "set_screen", "set_sleep", "set_vertical_swing", "set_horizontal_swing", "set_turbo", "set_fresh_air", "set_generator_mode", "set_beep"];

  router.post("/api/ac/devices/:id/control", requireAuth, async (req: Request, res: Response) => {
    const cloud = getTclCloud?.();
    if (!cloud || !cloud.isReady()) {
      res.status(503).json({ error: "TCL Cloud not available" });
      return;
    }
    const id = String(req.params.id);
    const { command, value } = req.body as { command: string; value: unknown };
    if (!command || !ALLOWED_AC_COMMANDS.includes(command)) {
      res.status(400).json({ error: `Invalid command. Allowed: ${ALLOWED_AC_COMMANDS.join(", ")}` });
      return;
    }
    try {
      await cloud.sendControl(id, command, value);
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

  router.post("/api/ac/timer", requireAuth, (req: Request, res: Response) => {
    const { deviceId, action, minutes, preset } = req.body as { deviceId: string; action: "on" | "off"; minutes: number; preset?: Record<string, unknown> };
    if (!deviceId || !action || !minutes) { res.status(400).json({ error: "deviceId, action, minutes required" }); return; }
    if (action !== "on" && action !== "off") { res.status(400).json({ error: "action must be 'on' or 'off'" }); return; }
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 480) { res.status(400).json({ error: "minutes must be 1–480" }); return; }
    const fireAt = Date.now() + minutes * 60_000;
    acTimers.set(deviceId, { deviceId, action, preset: action === "on" ? preset : undefined, fireAt });
    res.json({ ok: true, fireAt });
  });

  router.delete("/api/ac/timer/:deviceId", requireAuth, (req: Request, res: Response) => {
    acTimers.delete(String(req.params.deviceId));
    res.json({ ok: true });
  });

  // ---------- AC Presets (server-side) ----------

  router.get("/api/ac/presets/:deviceId", requireAuth, async (req: Request, res: Response) => {
    const deviceId = String(req.params.deviceId);
    const result = await pool.query("SELECT slot, data FROM ac_presets WHERE device_id = $1 ORDER BY slot", [deviceId]);
    const presets: Record<number, unknown> = { 1: null, 2: null, 3: null, 4: null, 5: null };
    for (const row of result.rows) presets[row.slot] = row.data;
    res.json({ presets });
  });

  router.put("/api/ac/presets/:deviceId/:slot", requireAuth, async (req: Request, res: Response) => {
    const deviceId = String(req.params.deviceId);
    const slot = parseInt(String(req.params.slot), 10);
    if (isNaN(slot) || slot < 1 || slot > 5) { res.status(400).json({ error: "Slot must be 1-5" }); return; }
    const { presetData } = req.body as { presetData: Record<string, unknown> };
    if (!presetData || typeof presetData !== "object") { res.status(400).json({ error: "presetData required" }); return; }
    await pool.query(
      `INSERT INTO ac_presets (device_id, slot, data, updated_at) VALUES ($1, $2, $3::jsonb, NOW())
       ON CONFLICT (device_id, slot) DO UPDATE SET data = $3::jsonb, updated_at = NOW()`,
      [deviceId, slot, JSON.stringify(presetData)],
    );
    res.json({ ok: true });
  });

  // ---------- Preset Sync ----------

  router.post("/api/ac/preset-sync", requireAuth, async (req: Request, res: Response) => {
    const { deviceId, slot, presetData } = req.body as { deviceId: string; slot: number; presetData: Record<string, unknown> };
    if (!deviceId || !slot || !presetData) { res.status(400).json({ error: "deviceId, slot, presetData required" }); return; }

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
    if (!deviceId || !slot || !presetData) { res.status(400).json({ error: "deviceId, slot, presetData required" }); return; }

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
       WHERE device_type = 'ac' AND enabled = true AND $2 = ANY(device_ids)`,
      [actionOn, deviceId],
    );
    onAutomationRulesChanged?.();
    res.json({ ok: true, updated: result.rowCount });
  });

  return router;
}
