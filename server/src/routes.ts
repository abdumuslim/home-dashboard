import { Router, type Request, type Response } from "express";
import pg from "pg";
import type { Config } from "./config.js";

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

export function createRouter(pool: pg.Pool, config?: Config): Router {
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

  return router;
}
