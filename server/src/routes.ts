import { Router, type Request, type Response } from "express";
import pg from "pg";
import type { Config } from "./config.js";
import { ALERT_METRICS, VALID_PRAYER_NAMES } from "./alert-metrics.js";
import type { XiaomiCloud } from "./xiaomi-cloud.js";
import type { TclCloud } from "./tcl-cloud.js";

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

export function createRouter(pool: pg.Pool, config?: Config, getXiaomiCloud?: () => XiaomiCloud | null, getTclCloud?: () => TclCloud | null): Router {
  const router = Router();

  router.get("/api/current", async (_req: Request, res: Response) => {
    const weatherResult = await pool.query(
      "SELECT * FROM weather_readings ORDER BY ts DESC LIMIT 1"
    );
    const airResult = await pool.query(
      "SELECT * FROM air_readings ORDER BY ts DESC LIMIT 1"
    );
    const weather = weatherResult.rows[0] ?? null;
    const air = airResult.rows[0] ?? null;
    res.json({
      weather: weather ? rowToDict(weather) : null,
      air: air ? rowToDict(air) : null,
    });
  });

  router.get("/api/history", async (req: Request, res: Response) => {
    const source = (req.query.source as string) || "weather";
    const range = (req.query.range as string) || "24h";

    const table = source === "weather" ? "weather_readings" : "air_readings";
    const interval = RANGE_MAP[range];
    if (!interval) {
      res.status(400).json({ error: `Invalid range: ${range}` });
      return;
    }

    let rows: Record<string, unknown>[];

    if (range === "30d") {
      const cols = source === "weather" ? WEATHER_AVG_COLS : AIR_AVG_COLS;
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
    const weatherLastResult = await pool.query(
      "SELECT ts FROM weather_readings ORDER BY ts DESC LIMIT 1"
    );
    const airLastResult = await pool.query(
      "SELECT ts FROM air_readings ORDER BY ts DESC LIMIT 1"
    );
    const weatherCountResult = await pool.query(
      "SELECT COUNT(*) FROM weather_readings"
    );
    const airCountResult = await pool.query(
      "SELECT COUNT(*) FROM air_readings"
    );

    const weatherLast: Date | null = weatherLastResult.rows[0]?.ts ?? null;
    const airLast: Date | null = airLastResult.rows[0]?.ts ?? null;

    res.json({
      weather_last_update: weatherLast ? weatherLast.toISOString() : null,
      air_last_update: airLast ? airLast.toISOString() : null,
      weather_total_readings: parseInt(weatherCountResult.rows[0].count as string, 10),
      air_total_readings: parseInt(airCountResult.rows[0].count as string, 10),
      collector_interval_seconds: 300,
    });
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

  router.get("/api/xiaomi/auth-status", (_req: Request, res: Response) => {
    const cloud = getXiaomiCloud?.();
    if (!cloud) {
      res.json({ status: "not_configured" });
      return;
    }
    res.json(cloud.getAuthStatus());
  });

  router.post("/api/xiaomi/verify", async (req: Request, res: Response) => {
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

  router.get("/api/devices", async (_req: Request, res: Response) => {
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

  router.post("/api/devices/:id/control", async (req: Request, res: Response) => {
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

  router.get("/api/automations", async (_req: Request, res: Response) => {
    const result = await pool.query("SELECT * FROM automations ORDER BY created_at ASC");
    res.json({ automations: result.rows });
  });

  interface MetricAutomationBody {
    automation_type?: "metric";
    metric: string;
    condition: string;
    threshold: number;
    sustained_minutes?: number;
    device_ids: string[];
    device_names: string[];
    enabled?: boolean;
  }

  interface ScheduleAutomationBody {
    automation_type: "schedule";
    time_start: string;
    time_end: string;
    turn_off_at_end?: boolean;
    device_ids: string[];
    device_names: string[];
    enabled?: boolean;
  }

  type AutomationBody = MetricAutomationBody | ScheduleAutomationBody;

  function validateMetricAutomation(body: MetricAutomationBody): string | null {
    if (!body.metric || !(body.metric in ALERT_METRICS)) return "Invalid metric";
    if (ALERT_METRICS[body.metric].source !== "air") return "Only air quality metrics allowed";
    if (body.condition !== "above" && body.condition !== "below") return "Condition must be 'above' or 'below'";
    if (typeof body.threshold !== "number" || !isFinite(body.threshold)) return "Threshold must be a finite number";
    const def = ALERT_METRICS[body.metric];
    if (body.threshold < def.min || body.threshold > def.max) return `Threshold must be between ${def.min} and ${def.max}`;
    if (body.sustained_minutes != null && (!Number.isInteger(body.sustained_minutes) || body.sustained_minutes < 0 || body.sustained_minutes > 60))
      return "Sustained minutes must be 0–60";
    if (!Array.isArray(body.device_ids) || body.device_ids.length === 0) return "Select at least one device";
    return null;
  }

  function validateScheduleAutomation(body: ScheduleAutomationBody): string | null {
    const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;
    if (!body.time_start || !timeRegex.test(body.time_start)) return "Invalid start time (HH:MM)";
    if (!body.time_end || !timeRegex.test(body.time_end)) return "Invalid end time (HH:MM)";
    if (body.time_start === body.time_end) return "Start and end time cannot be the same";
    if (!Array.isArray(body.device_ids) || body.device_ids.length === 0) return "Select at least one device";
    return null;
  }

  router.post("/api/automations", async (req: Request, res: Response) => {
    const body = req.body as AutomationBody;
    const isSchedule = body.automation_type === "schedule";

    if (isSchedule) {
      const sb = body as ScheduleAutomationBody;
      const err = validateScheduleAutomation(sb);
      if (err) { res.status(400).json({ error: err }); return; }

      const turnOff = sb.turn_off_at_end ?? false;
      const name = `Schedule ${sb.time_start} – ${sb.time_end}${turnOff ? " (off at end)" : ""}`;
      const actionOff = turnOff ? '{"power":"off"}' : null;
      const result = await pool.query(
        `INSERT INTO automations (name, enabled, automation_type, time_start, time_end, turn_off_at_end, device_id, device_name, device_ids, device_names, action_on, action_off, cooldown_secs)
         VALUES ($1, $2, 'schedule', $3, $4, $5, $6, $7, $8, $9, '{"power":"on"}', $10, 60) RETURNING *`,
        [name, sb.enabled ?? true, sb.time_start, sb.time_end, turnOff, sb.device_ids[0], sb.device_names[0] ?? sb.device_ids[0], sb.device_ids, sb.device_names, actionOff],
      );
      res.json({ automation: result.rows[0] });
    } else {
      const mb = body as MetricAutomationBody;
      const err = validateMetricAutomation(mb);
      if (err) { res.status(400).json({ error: err }); return; }

      const mins = mb.sustained_minutes ?? 0;
      const name = `${ALERT_METRICS[mb.metric].label} ${mb.condition} ${mb.threshold}${mins > 0 ? ` for ${mins}min` : ""}`;
      const result = await pool.query(
        `INSERT INTO automations (name, enabled, automation_type, metric, condition, threshold, sustained_minutes, device_id, device_name, device_ids, device_names, action_on, action_off, cooldown_secs)
         VALUES ($1, $2, 'metric', $3, $4, $5, $6, $7, $8, $9, $10, '{"power":"on"}', NULL, 300) RETURNING *`,
        [name, mb.enabled ?? true, mb.metric, mb.condition, mb.threshold, mins, mb.device_ids[0], mb.device_names[0] ?? mb.device_ids[0], mb.device_ids, mb.device_names],
      );
      res.json({ automation: result.rows[0] });
    }
  });

  router.put("/api/automations/:id", async (req: Request, res: Response) => {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

    const body = req.body as AutomationBody;
    const isSchedule = body.automation_type === "schedule";

    if (isSchedule) {
      const sb = body as ScheduleAutomationBody;
      const err = validateScheduleAutomation(sb);
      if (err) { res.status(400).json({ error: err }); return; }

      const turnOff = sb.turn_off_at_end ?? false;
      const name = `Schedule ${sb.time_start} – ${sb.time_end}${turnOff ? " (off at end)" : ""}`;
      const actionOff = turnOff ? '{"power":"off"}' : null;
      const result = await pool.query(
        `UPDATE automations SET name=$1, enabled=$2, automation_type='schedule', time_start=$3, time_end=$4, turn_off_at_end=$5,
         metric=NULL, condition=NULL, threshold=NULL, sustained_minutes=0,
         action_off=$6, device_id=$7, device_name=$8, device_ids=$9, device_names=$10
         WHERE id=$11 RETURNING *`,
        [name, sb.enabled ?? true, sb.time_start, sb.time_end, turnOff, actionOff, sb.device_ids[0], sb.device_names[0] ?? sb.device_ids[0], sb.device_ids, sb.device_names, id],
      );
      if (result.rowCount === 0) { res.status(404).json({ error: "Not found" }); return; }
      res.json({ automation: result.rows[0] });
    } else {
      const mb = body as MetricAutomationBody;
      const err = validateMetricAutomation(mb);
      if (err) { res.status(400).json({ error: err }); return; }

      const mins = mb.sustained_minutes ?? 0;
      const name = `${ALERT_METRICS[mb.metric].label} ${mb.condition} ${mb.threshold}${mins > 0 ? ` for ${mins}min` : ""}`;
      const result = await pool.query(
        `UPDATE automations SET name=$1, enabled=$2, automation_type='metric', metric=$3, condition=$4, threshold=$5, sustained_minutes=$6,
         time_start=NULL, time_end=NULL, turn_off_at_end=false, action_off=NULL,
         device_id=$7, device_name=$8, device_ids=$9, device_names=$10
         WHERE id=$11 RETURNING *`,
        [name, mb.enabled ?? true, mb.metric, mb.condition, mb.threshold, mins, mb.device_ids[0], mb.device_names[0] ?? mb.device_ids[0], mb.device_ids, mb.device_names, id],
      );
      if (result.rowCount === 0) { res.status(404).json({ error: "Not found" }); return; }
      res.json({ automation: result.rows[0] });
    }
  });

  router.delete("/api/automations/:id", async (req: Request, res: Response) => {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
    await pool.query("DELETE FROM automations WHERE id = $1", [id]);
    res.json({ ok: true });
  });

  router.post("/api/automations/:id/test", async (req: Request, res: Response) => {
    const cloud = getXiaomiCloud?.();
    if (!cloud) { res.status(503).json({ error: "Xiaomi Cloud not available" }); return; }
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

    const result = await pool.query("SELECT * FROM automations WHERE id = $1", [id]);
    if (result.rowCount === 0) { res.status(404).json({ error: "Not found" }); return; }
    const rule = result.rows[0] as { device_ids?: string[]; device_id: string; action_on: { power?: string } };

    try {
      const ids = rule.device_ids ?? [rule.device_id];
      for (const did of ids) {
        await cloud.sendCommand(did, "set_power", ["on"]);
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Enable/disable toggle
  router.patch("/api/automations/:id", async (req: Request, res: Response) => {
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

  router.get("/api/ac/devices", async (_req: Request, res: Response) => {
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

  const ALLOWED_AC_COMMANDS = ["set_power", "set_mode", "set_temperature", "set_fan_speed", "set_eco", "set_screen", "set_sleep", "set_swing", "set_turbo"];

  router.post("/api/ac/devices/:id/control", async (req: Request, res: Response) => {
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

  return router;
}
