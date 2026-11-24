import express, { type ErrorRequestHandler, type RequestHandler } from "express";
import type pg from "pg";
import type { Collector } from "./collector.js";
import type { Config } from "./config.js";
import { matchesWatchBearer } from "./auth.js";
import { STALE_POWER_MS } from "./ac-leveling.js";
import { isAcLevelingEligible } from "./ac-capabilities.js";
import { childLogger } from "./logger.js";
import { median, type DeviceControls } from "./routes.js";

const log = childLogger("watch");
const rooms = new Map([
  ["DHihohFAAAE", "ماما"], ["CA5IMhFAAAE", "عبدو"],
  ["Cy3aihFAAAE", "عبدالله"], ["DlXqDBFAAAE", "الضيوف"],
]);
const purifierModels = new Map([
  ["357465941", { name: "ماما", model: "zhimi.airpurifier.v7", fan: false, max: 16 }],
  ["317499063", { name: "عبدو", model: "zhimi.airpurifier.vb2", fan: true, max: 14 }],
]);
const acModes = ["auto", "cool", "dry", "fan", "heat"];
const purifierModes = ["auto", "silent", "favorite", "fan"];
const minute = 60_000, day = 24 * 60 * minute, yesterdayWindow = 5 * minute;
type Reading = Record<string, unknown>;
type WatchCollector = Pick<Collector, "noteWatchRequest" | "getWatchDeviceState" |
  "getLatestAir" | "getAcManualOffLockedIds" | "isAcTurnedDown" | "preserveWatchGeneratorCap">;

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function epoch(value: unknown): number | null {
  if (value instanceof Date) return number(value.getTime());
  return typeof value === "string" ? number(Date.parse(value)) : number(value);
}

function acMode(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) ? acModes[value] ?? null : null;
}

// Same Haurwitz model as client/src/constants/solar-model.ts. The station's
// calendar day is Baghdad's (UTC+3 year round); the solar hour is UTC.
export function watchSun(ts: number) {
  const date = new Date(ts);
  const local = new Date(ts + 3 * 60 * minute);
  const doy = Math.floor((local.getTime() - Date.UTC(local.getUTCFullYear(), 0, 0)) / 86_400_000);
  const rad = Math.PI / 180;
  const b = (doy - 1) * 360 / 365 * rad;
  const dec = 23.45 * Math.sin(360 / 365 * (doy + 284) * rad) * rad;
  const eot = 229.18 * (0.000075 + 0.001868 * Math.cos(b) - 0.032077 * Math.sin(b)
    - 0.014615 * Math.cos(2 * b) - 0.04089 * Math.sin(2 * b));
  const solarHour = date.getUTCHours() + date.getUTCMinutes() / 60 + 44.3583 / 15 + eot / 60;
  const lat = 33.3215 * rad;
  const sinElev = Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos((solarHour - 12) * 15 * rad);
  const elevation = Math.asin(Math.max(-1, Math.min(1, sinElev))) / rad;
  const cosZenith = Math.cos((90 - elevation) * rad);
  return { isDay: elevation > 0, elevation, ghi: elevation > 0 ? 1250 * cosZenith * Math.exp(-0.43 / cosZenith) : 0 };
}

export function watchSky(row: Reading, history: Reading[], ts: number) {
  const { isDay, ghi } = watchSun(ts);
  const rain = number(row.rain_hourly_mm);
  if (rain != null && rain > 0) return rain > 2.5 ? "heavy_rain" : "light_rain";
  if (!isDay) {
    const humidity = number(row.humidity), temp = number(row.temp_c), dew = number(row.dew_point_c);
    return (humidity != null && humidity >= 85) || (temp != null && dew != null && temp - dew < 2.5)
      ? "cloudy_night" : "clear_night";
  }
  const radiation = number(row.solar_radiation);
  if (radiation == null || ghi < 1) return null;
  const values = [radiation / ghi];
  for (const sample of history) {
    const at = epoch(sample.ts), rad = number(sample.solar_radiation);
    if (rad == null || at == null || at > ts || ts - at > 7 * minute) continue;
    const reference = watchSun(at).ghi;
    if (reference >= 50) values.push(rad / reference);
  }
  values.sort((a, b) => a - b);
  const percentile = (p: number) => {
    const idx = p * (values.length - 1), lo = Math.floor(idx);
    return values[lo] + (values[Math.ceil(idx)] - values[lo]) * (idx - lo);
  };
  const mid = percentile(0.5), spread = percentile(0.8) - percentile(0.2);
  if (mid > 0.85) return spread < 0.2 ? "sunny" : "partly_cloudy";
  if (mid > 0.55) return spread < 0.15 ? "partly_cloudy" : "mostly_cloudy";
  return mid > 0.25 ? "mostly_cloudy" : "cloudy";
}

// good = the dashboard's normal/excellent/good bands, moderate = its slightly-high
// (PM2.5 "Moderate") band, bad = anything worse (client/src/constants/thresholds.ts).
const airBands = { co2: [1000, 2000], pm25: [35, 75], tvoc: [37, 120] } as const;
export function airLevel(metric: keyof typeof airBands, value: number | null) {
  const [first, second] = airBands[metric];
  return value == null ? null : value <= first ? "good" : value <= second ? "moderate" : "bad";
}

// Same comparison as the dashboard's temperature card: the mean of the last 5
// minutes against the mean of the 5 minutes starting 24 hours earlier; null
// unless both windows hold a reading. Both windows hang off asOf, the cutoff
// the SQL used, so the fetched rows always cover them.
function meanTemp(rows: Reading[], from: number, to: number) {
  let sum = 0, count = 0;
  for (const sample of rows) {
    const temp = number(sample.temp_c), at = epoch(sample.ts);
    if (temp != null && at != null && at >= from && at <= to) { sum += temp; count++; }
  }
  return count ? sum / count : null;
}

function weatherGroup(rows: Reading[], yesterdayRows: Reading[], now: number, asOf: number) {
  const row = rows[0] ?? {}, ts = epoch(row.ts);
  const speeds: number[] = [];
  for (const sample of rows) {
    const speed = number(sample.wind_speed_kmh), at = epoch(sample.ts);
    if (speed != null && at != null && at <= now && now - at <= 10 * minute) speeds.push(speed);
  }
  const today = meanTemp(rows, asOf - yesterdayWindow, asOf);
  const before = meanTemp(yesterdayRows, asOf - day, asOf - day + yesterdayWindow);
  return {
    sky: ts == null ? null : watchSky(row, rows, now),
    isDay: ts == null ? null : watchSun(now).isDay,
    tempC: number(row.temp_c), feelsLikeC: number(row.feels_like_c), humidity: number(row.humidity),
    vsYesterdayC: today == null || before == null ? null : Math.round((today - before) * 10) / 10,
    windKmh: speeds.length ? median(speeds) : null,
    windDir: ts != null && now - ts <= 10 * minute ? number(row.wind_dir_avg10m) : null,
    rainMmH: number(row.rain_hourly_mm), ts,
  };
}

function powerGroup(reading: ReturnType<WatchCollector["getWatchDeviceState"]>["meter"], now: number) {
  if (!reading || now - reading.ts > STALE_POWER_MS) {
    return { source: null, amps: null, limit: null, ts: null };
  }
  return { source: reading.source === "gen" ? "generator" : reading.source,
    amps: reading.amps == null ? null : Math.round(reading.amps * 10) / 10, limit: reading.limit, ts: reading.ts };
}

async function buildSnapshot(pool: pg.Pool, collector: WatchCollector) {
  const asOf = new Date(), liveAir = collector.getLatestAir();
  const [weather, yesterday, storedAir, locked] = await Promise.all([
    pool.query(`SELECT ts, temp_c, humidity, feels_like_c, dew_point_c, rain_hourly_mm, solar_radiation,
      wind_speed_kmh, wind_dir_avg10m FROM weather_readings
      WHERE ts <= $1 AND ts >= (SELECT MAX(ts) FROM weather_readings WHERE ts <= $1) - INTERVAL '10 minutes'
      ORDER BY ts DESC`, [asOf]),
    pool.query("SELECT ts, temp_c FROM weather_readings WHERE ts >= $1 AND ts <= $2",
      [new Date(asOf.getTime() - day), new Date(asOf.getTime() - day + yesterdayWindow)]),
    liveAir ? null : pool.query("SELECT ts, co2, pm25, tvoc FROM air_readings WHERE ts <= $1 ORDER BY ts DESC LIMIT 1", [asOf]),
    collector.getAcManualOffLockedIds(),
  ]);
  const air = liveAir ?? storedAir?.rows[0], co2 = number(air?.co2), pm25 = number(air?.pm25), tvoc = number(air?.tvoc);
  const state = collector.getWatchDeviceState();
  const now = Date.now();
  if (!air && !weather.rows.length && !state.hasPowerReading && !state.acs.length && !state.lastAcs.size &&
      !state.purifiers.length) return null;

  const acs = Array.from(rooms, ([id, name]) => {
    const current = state.acs.find(d => d.id === id), saved = state.lastAcs.get(id);
    const d = saved && (saved.lastSeenAt ?? 0) > (current?.lastSeenAt ?? 0) ? saved : current;
    const power = current?.powerKnown ? current : d;
    const controller = state.leveling.acs.find(a => a.deviceId === id);
    const fanKnown = d?.capabilities.fanSpeeds.some(option => option.value >= 2 && option.value <= 6) || (d?.fanSpeed ?? 0) > 0;
    const gridOnly = !isAcLevelingEligible(id);
    return {
      id, name, online: current?.isOnline ?? d?.isOnline ?? null,
      on: power?.powerKnown ? power.power : null,
      mode: d?.capabilities.modes.length ? acMode(d.mode) : null,
      // The TCL cache substitutes 24 / 0 for a missing target / room reading;
      // its presence flags say whether the shadow really carried the value.
      setC: d?.targetTempKnown ? number(d.targetTemp) : null,
      roomC: d?.currentTempKnown ? number(d.currentTemp) : null,
      fan: d && fanKnown ? d.fanSpeed === 0 ? "A" : d.fanSpeed : null,
      level: !gridOnly && state.leveling.enabled && controller?.managed ? number(controller.level) : null,
      manualOffLock: locked.has(id),
      turnedDown: collector.isAcTurnedDown(id) || (controller || gridOnly ? false : null),
      gridOnly, ts: d?.lastSeenAt ?? null,
    };
  });
  const purifiers = Array.from(purifierModels, ([id, model]) => {
    const current = state.purifiers.find(d => d.id === id && d.model === model.model);
    const d = current?.readingsAt != null ? current : undefined;
    const pm25 = number(d?.aqi);
    return {
      id, name: model.name, online: current?.isOnline ?? null,
      on: d?.power === "on" ? true : d?.power === "off" ? false : null,
      mode: d?.mode && purifierModes.includes(d.mode) && (d.mode !== "fan" || model.fan) ? d.mode : null,
      fanLevel: model.fan ? number(d?.fan_level) : null, favoriteLevel: number(d?.favorite_level),
      favoriteMax: model.max, pm25, pm25Level: airLevel("pm25", pm25), ts: d?.readingsAt ?? null,
    };
  });
  return { v: 1, ts: now, power: powerGroup(state.meter, now), weather: weatherGroup(weather.rows, yesterday.rows, now, asOf.getTime()),
    air: { co2, co2Level: airLevel("co2", co2), pm25, pm25Level: airLevel("pm25", pm25),
      tvoc, tvocLevel: airLevel("tvoc", tvoc), ts: epoch(air?.ts) }, acs, purifiers };
}

function purifierCommand(command: unknown, value: unknown, model: { max: number; fan: boolean }) {
  if (command === "power" && typeof value === "boolean") return { command: "set_power", value: value ? "on" : "off" };
  if (command === "mode" && typeof value === "string" && purifierModes.includes(value) && (value !== "fan" || model.fan)) {
    return { command: "set_mode", value };
  }
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (command === "fan" && model.fan && value >= 1 && value <= 3) return { command: "set_fan_level", value };
  if (command === "favorite" && value >= 0 && value <= model.max) return { command: "set_level_favorite", value };
  return null;
}

export function createWatchGate(config: Config, pool: pg.Pool, collector: WatchCollector, controls: DeviceControls): RequestHandler {
  const collision = !!config.watchApiToken && config.watchApiToken === config.hermesApiToken;
  if (collision) log.error("Watch and Hermes bearer keys coincide. Refusing the shared bearer.");
  const router = express.Router({ caseSensitive: true, strict: true });
  const deny: RequestHandler = (_req, res) => { res.status(401).json({ error: "Unauthorized" }); };
  const json = express.json();
  router.param("id", (req, res, next, id) => {
    const known = req.route.path.startsWith("/api/watch/ac/") ? rooms : purifierModels;
    if (!known.has(id)) { deny(req, res, next); return; }
    next();
  });
  router.get("/api/watch", async (_req, res) => {
    collector.noteWatchRequest();
    const snapshot = await buildSnapshot(pool, collector);
    if (!snapshot) { res.status(503).json({ error: "No readings available" }); return; }
    res.json(snapshot);
  });
  router.post("/api/watch/ac/:id/power", json, (req, res) => {
    const on = req.body?.on;
    if (typeof on !== "boolean") { res.status(400).json({ error: "on must be boolean" }); return; }
    collector.noteWatchRequest();
    return controls.ac(req, res, String(req.params.id), { command: "set_power", value: on ? 1 : 0 });
  });
  router.get("/api/watch/ac/:id/presets", async (req, res) => {
    collector.noteWatchRequest();
    const { rows } = await pool.query("SELECT slot, data FROM ac_presets WHERE device_id = $1 ORDER BY slot", [req.params.id]);
    res.json({ presets: rows.map(({ slot, data }) => ({
      slot, on: true, mode: acMode(data?.mode), setC: number(data?.targetTemp),
    })) });
  });
  router.post("/api/watch/ac/:id/preset", json, async (req, res) => {
    const slot = req.body?.slot, id = String(req.params.id);
    if (!Number.isInteger(slot) || slot < 1 || slot > 10 || Object.keys(req.body).length !== 1) {
      res.status(400).json({ error: "Expected a saved slot from 1 to 10" }); return;
    }
    collector.noteWatchRequest();
    await controls.preset(req, res, id, slot, async () => {
      const { rows } = await pool.query("SELECT data FROM ac_presets WHERE device_id = $1 AND slot = $2", [id, slot]);
      return rows[0]?.data ?? null;
    }, () => collector.preserveWatchGeneratorCap(id));
  });
  router.post("/api/watch/purifier/:id", json, (req, res) => {
    const id = String(req.params.id), model = purifierModels.get(id)!;
    const device = collector.getWatchDeviceState().purifiers.find(d => d.id === id && d.model === model.model);
    if (!device) { res.status(404).json({ error: "Unknown purifier" }); return; }
    const control = purifierCommand(req.body?.command, req.body?.value, model);
    if (!control) { res.status(400).json({ error: "Invalid control for this purifier" }); return; }
    collector.noteWatchRequest();
    return controls.purifier(req, res, id, { command: control.command, params: [control.value] });
  });
  router.use(deny);
  const handleError: ErrorRequestHandler = (err, req, res, next) => {
    if (err instanceof URIError) { deny(req, res, next); return; }
    const status = err.status >= 400 && err.status < 500 ? err.status : 500;
    res.status(status).json({ error: status === 500 ? "Watch API unavailable" : "Invalid request" });
  };
  router.use(handleError);
  return (req: express.Request, res, next) => {
    const bearer = matchesWatchBearer(req, config);
    if (!bearer && !/^\/api\/watch(?:\/|$)/i.test(req.path)) { next(); return; }
    res.set("Cache-Control", "no-store");
    if (!bearer || collision || (req.method !== "GET" && req.method !== "POST")) {
      deny(req, res, next); return;
    }
    req.authKind = "watch";
    router(req, res, () => deny(req, res, next));
  };
}
