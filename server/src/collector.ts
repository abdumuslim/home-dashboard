import pg from "pg";
import webpush from "web-push";
import mqtt from "mqtt";
import { Coordinates, CalculationMethod, PrayerTimes, Rounding } from "adhan";
import type { Config } from "./config.js";
import { getMetricValue, ALERT_METRICS, VALID_PRAYER_NAMES, PRAYER_LABELS } from "./alert-metrics.js";
import { XiaomiCloud, type PurifierAction } from "./xiaomi-cloud.js";

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
  battery?: { value: number };
}

const QP_MSG_SETTINGS_ACK = "28";
const QP_MSG_INTERVAL_CONFIG = "17";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AWData = Record<string, any>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const BAGHDAD_COORDS = new Coordinates(33.321502, 44.358335);
const PRAYER_PARAMS = CalculationMethod.Dubai();
PRAYER_PARAMS.adjustments = { fajr: 0, sunrise: 2, dhuhr: 2, asr: 0, maghrib: 0, isha: -6 };
PRAYER_PARAMS.rounding = Rounding.None;

function roundPrayerTime(date: Date, prayer: string): Date {
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
  metric: string | null;
  condition: "above" | "below" | null;
  threshold: number | null;
  time_start: string | null;
  time_end: string | null;
  device_id: string;
  device_name: string;
  device_ids: string[] | null;
  device_names: string[] | null;
  action_on: PurifierAction;
  action_off: PurifierAction | null;
  cooldown_secs: number;
}

function parseTimeToMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

interface AutomationState {
  status: "idle" | "triggered";
  lastToggle: number;
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
  private sensorAlertState = new Map<number, "idle" | "triggered">();
  private latestWeatherRow: Record<string, unknown> | null = null;
  private latestWeatherTs: Date | null = null;
  private latestAirRow: Record<string, unknown> | null = null;
  private latestAirTs: Date | null = null;
  private cachedPrayerTimes: PrayerTimes | null = null;
  private cachedPrayerDateKey = "";
  // Automation system
  xiaomiCloud: XiaomiCloud | null = null;
  private automationRules: AutomationRule[] = [];
  private automationRulesLastFetch = 0;
  private automationState = new Map<number, AutomationState>();
  private devicePowerCache = new Map<string, { power: "on" | "off" | undefined; ts: number }>();
  private readonly POWER_CACHE_TTL = 5_000;

  constructor(pool: pg.Pool, config: Config) {
    this.pool = pool;
    this.config = config;

    if (config.vapidPublicKey && config.vapidPrivateKey) {
      webpush.setVapidDetails(config.vapidSubject, config.vapidPublicKey, config.vapidPrivateKey);
      console.log("[collector] Web Push configured");
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.mqttClient) {
      this.mqttClient.end(true);
      console.log("[collector] MQTT client closed");
    }
  }

  async runForever(): Promise<void> {
    await this.backfillAmbientHistory();
    await sleep(2000);
    await this.backfillQingpingHistory();
    this.startMqtt();
    await this.initXiaomiCloud();
    while (!this.stopped) {
      try {
        await this.collectAll();
      } catch (err) {
        console.error("[collector] Collection cycle failed:", err);
      }
      await sleep(5000);
    }
  }

  private async initXiaomiCloud(): Promise<void> {
    if (!this.config.miEmail || !this.config.miPassword) {
      console.log("[collector] Xiaomi Cloud not configured (MI_EMAIL empty), automations disabled");
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
      console.error("[collector] Xiaomi Cloud init failed:", (err as Error).message);
      this.xiaomiCloud = null;
    }
  }

  private async collectAll(): Promise<void> {
    const mqttActive = this.mqttClient?.connected &&
      (Date.now() - this.lastMqttMessage < 120_000);

    const tasks: Promise<void>[] = [this.collectAmbientWeather()];
    if (!mqttActive) {
      tasks.push(this.collectQingping());
    }

    const results = await Promise.allSettled(tasks);
    for (const r of results) {
      if (r.status === "rejected") {
        console.error("[collector] Collection error:", r.reason);
      }
    }

    try {
      await this.checkAlerts();
    } catch (err) {
      console.error("[collector] Alert check failed:", err);
    }

    try {
      await this.checkAutomations();
    } catch (err) {
      console.error("[collector] Automation check failed:", err);
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

    for (const rule of this.alertRules) {
      if (rule.alert_type === "sensor") {
        const def = rule.metric ? ALERT_METRICS[rule.metric] : null;
        if (!def || !rule.condition || rule.threshold == null) continue;

        // Skip if source data is stale
        if (def.source === "weather" && weatherStale) continue;
        if (def.source === "air" && airStale) continue;

        const value = getMetricValue(
          rule.metric!,
          this.latestWeatherRow,
          this.latestAirRow,
        );
        if (value == null) continue;

        const conditionMet = rule.condition === "above"
          ? value > rule.threshold
          : value < rule.threshold;

        const state = this.sensorAlertState.get(rule.id) ?? "idle";

        if (conditionMet && state === "idle") {
          this.sensorAlertState.set(rule.id, "triggered");
          await this.sendAlertPush(rule, value);
        } else if (!conditionMet && state === "triggered") {
          // Value returned to normal — reset to idle (hysteresis)
          this.sensorAlertState.set(rule.id, "idle");
        }
      }
    }

    // Check prayer alerts (cache PrayerTimes per day — changes only at midnight)
    if (dateKey !== this.cachedPrayerDateKey) {
      this.cachedPrayerTimes = new PrayerTimes(BAGHDAD_COORDS, now, PRAYER_PARAMS);
      this.cachedPrayerDateKey = dateKey;
    }
    const pt = this.cachedPrayerTimes!;
    const nowMs = now.getTime();

    for (const rule of this.alertRules) {
      if (rule.alert_type !== "prayer") continue;
      if (!rule.prayer_names?.length) continue;

      const bp = rule.prayer_timing === "at_time" ? 0 : (rule.prayer_minutes ?? 0);

      for (const name of rule.prayer_names) {
        const rawPrayerTime = pt[name as keyof PrayerTimes] as Date | undefined;
        if (!(rawPrayerTime instanceof Date)) continue;
        const prayerTime = roundPrayerTime(rawPrayerTime, name);

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

  private async sendPush(subscription: unknown, payload: Record<string, unknown>): Promise<void> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await webpush.sendNotification(subscription as any, JSON.stringify(payload));
      console.log(`[collector] Sent push: ${payload.title}`);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        const endpoint = (subscription as { endpoint?: string }).endpoint;
        if (endpoint) {
          await this.pool.query("DELETE FROM push_subscriptions WHERE endpoint = $1", [endpoint]);
          console.log("[collector] Removed stale push subscription");
          this.alertRulesLastFetch = 0; // Force refresh on next cycle
        }
      } else {
        console.error(`[collector] Push failed (${status}):`, (err as Error).message);
      }
    }
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
    if (!this.xiaomiCloud || !this.xiaomiCloud.isReady()) return;

    await this.refreshAutomationRules();
    if (this.automationRules.length === 0) return;

    for (const rule of this.automationRules) {
      if (rule.automation_type === "schedule") {
        await this.checkScheduleAutomation(rule);
      } else {
        await this.checkMetricAutomation(rule);
      }
    }
  }

  private async checkMetricAutomation(rule: AutomationRule): Promise<void> {
    if (!rule.metric || !rule.condition || rule.threshold == null) return;

    const now = Date.now();
    const weatherStale = !this.latestWeatherTs || (now - this.latestWeatherTs.getTime() > 300_000);
    const airStale = !this.latestAirTs || (now - this.latestAirTs.getTime() > 300_000);

    const def = ALERT_METRICS[rule.metric];
    if (!def) return;

    if (def.source === "weather" && weatherStale) return;
    if (def.source === "air" && airStale) return;

    const value = getMetricValue(rule.metric, this.latestWeatherRow, this.latestAirRow);
    if (value == null) return;

    const conditionMet = rule.condition === "above"
      ? value > rule.threshold
      : value < rule.threshold;

    const state = this.automationState.get(rule.id) ?? { status: "idle", lastToggle: 0 };
    const cooldownMs = (rule.cooldown_secs ?? 300) * 1000;

    const deviceIds = rule.device_ids ?? [rule.device_id];
    const deviceNames = (rule.device_names ?? [rule.device_name]).join(", ");

    if (conditionMet && state.status === "idle" && (now - state.lastToggle >= cooldownMs)) {
      console.log(
        `[collector] Automation "${rule.name}": ${rule.metric}=${value} ${rule.condition} ${rule.threshold}, turning ON [${deviceNames}]`,
      );
      try {
        for (const did of deviceIds) {
          await this.xiaomiCloud!.executeAction(did, rule.action_on);
        }
        this.automationState.set(rule.id, { status: "triggered", lastToggle: now });
      } catch (err) {
        console.error(`[collector] Automation "${rule.name}" action_on failed:`, (err as Error).message);
      }
    } else if (!conditionMet && state.status === "triggered" && rule.action_off && (now - state.lastToggle >= cooldownMs)) {
      console.log(
        `[collector] Automation "${rule.name}": ${rule.metric}=${value} returned below ${rule.threshold}, turning OFF [${deviceNames}]`,
      );
      try {
        for (const did of deviceIds) {
          await this.xiaomiCloud!.executeAction(did, rule.action_off);
        }
        this.automationState.set(rule.id, { status: "idle", lastToggle: now });
      } catch (err) {
        console.error(`[collector] Automation "${rule.name}" action_off failed:`, (err as Error).message);
      }
    }
  }

  private async getDevicePowerCached(deviceId: string): Promise<"on" | "off" | undefined> {
    const cached = this.devicePowerCache.get(deviceId);
    if (cached && Date.now() - cached.ts < this.POWER_CACHE_TTL) return cached.power;
    const power = await this.xiaomiCloud!.getDevicePower(deviceId);
    this.devicePowerCache.set(deviceId, { power, ts: Date.now() });
    return power;
  }

  private async checkScheduleAutomation(rule: AutomationRule): Promise<void> {
    if (!rule.time_start || !rule.time_end) return;

    const baghdadNow = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Baghdad" }));
    const nowMinutes = baghdadNow.getHours() * 60 + baghdadNow.getMinutes();
    const startMinutes = parseTimeToMinutes(rule.time_start);
    const endMinutes = parseTimeToMinutes(rule.time_end);

    // Handle overnight ranges (e.g., 22:00 → 07:00)
    const inWindow = startMinutes <= endMinutes
      ? (nowMinutes >= startMinutes && nowMinutes < endMinutes)
      : (nowMinutes >= startMinutes || nowMinutes < endMinutes);

    const state = this.automationState.get(rule.id) ?? { status: "idle", lastToggle: 0 };
    const now = Date.now();
    const cooldownMs = (rule.cooldown_secs ?? 60) * 1000;

    if (inWindow) {
      if (now - state.lastToggle < cooldownMs) return;

      const deviceIds = rule.device_ids ?? [rule.device_id];
      const deviceNames = (rule.device_names ?? [rule.device_name]).join(", ");

      for (const did of deviceIds) {
        try {
          const power = await this.getDevicePowerCached(did);
          if (power === "off" || power === undefined) {
            console.log(
              `[collector] Schedule "${rule.name}": device ${did} is OFF during active window, turning ON [${deviceNames}]`,
            );
            await this.xiaomiCloud!.executeAction(did, rule.action_on);
            // Update cache immediately after turning on
            this.devicePowerCache.set(did, { power: "on", ts: Date.now() });
            this.automationState.set(rule.id, { status: "triggered", lastToggle: now });
          }
        } catch (err) {
          console.error(`[collector] Schedule "${rule.name}" check failed for ${did}:`, (err as Error).message);
        }
      }
    } else {
      // Outside window: reset state to idle
      if (state.status === "triggered") {
        this.automationState.set(rule.id, { status: "idle", lastToggle: now });
      }
    }
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
      console.warn("[collector] No devices from Ambient Weather");
      return;
    }
    const data = devices[0].lastData as AWData;
    const row = this.convertAW(data);
    await this.storeWeather(row);
    this.latestWeatherRow = row as unknown as Record<string, unknown>;
    this.latestWeatherTs = row.ts;
    console.log(`[collector] Stored weather reading at ${row.ts.toISOString()}`);
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
      max_daily_gust_kmh: mph2kmh(d.maxdailygust),
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
      console.log("[collector] Weather data already spans 30+ days, fetching latest batch only");
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
          console.log(`[collector] AW backfill: got ${count} < 288 records, no more data`);
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
      console.log(`[collector] Backfilled ${totalCount} weather records total`);
    } catch (err) {
      console.error(`[collector] AW backfill stopped after ${totalCount} records:`, err);
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
    for (const record of records) {
      const row = this.convertAW(record);
      await this.storeWeather(row);
    }
    if (records.length > 0) {
      console.log(`[collector] AW backfill page: ${records.length} records`);
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
      console.log("[collector] Air data already spans 30+ days, skipping backfill");
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

        for (const d of items) {
          await this.storeAir(this.toAirRow(new Date(d.timestamp.value * 1000), d));
        }

        totalCount += items.length;
        offset += items.length;
        console.log(`[collector] QP backfill page: ${items.length} records (total: ${totalCount})`);

        const total = body.total ?? 0;
        if (offset >= total) break;

        await sleep(500);
      }
      console.log(`[collector] Backfilled ${totalCount} air records total`);
    } catch (err) {
      console.error("[collector] QP backfill failed:", err);
    }
  }

  // ---------- MQTT (Qingping direct) ----------

  private startMqtt(): void {
    if (!this.config.mqttUsername) {
      console.log("[collector] MQTT not configured, skipping");
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
      console.log("[collector] MQTT connected to broker");
      this.mqttClient!.subscribe(topic, { qos: 1 }, (err) => {
        if (err) {
          console.error("[collector] MQTT subscribe error:", err);
        } else {
          console.log(`[collector] MQTT subscribed to ${topic}`);
          this.sendIntervalConfig();
        }
      });
    });

    this.mqttClient.on("message", (_topic: string, payload: Buffer) => {
      this.handleMqttMessage(payload).catch((err) => {
        console.error("[collector] MQTT message handling error:", err);
      });
    });

    this.mqttClient.on("error", (err) => {
      console.error("[collector] MQTT error:", err);
    });

    this.mqttClient.on("reconnect", () => {
      console.log("[collector] MQTT reconnecting...");
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
      console.warn("[collector] MQTT: non-JSON message, ignoring");
      return;
    }

    if (msg.type === QP_MSG_SETTINGS_ACK) {
      console.log("[collector] MQTT: received settings ack");
      return;
    }

    const sensors = msg.sensorData?.[0];
    if (!sensors) {
      console.warn("[collector] MQTT: no sensorData in message");
      return;
    }

    const row = this.toAirRow(new Date(), sensors);
    await this.storeAir(row);
    this.latestAirRow = row as unknown as Record<string, unknown>;
    this.latestAirTs = row.ts;
    this.lastMqttMessage = Date.now();
    console.log(`[collector] MQTT air reading stored at ${row.ts.toISOString()}`);
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
        report_interval: 30,
        collect_interval: 30,
        co2_sampling_interval: 30,
        pm_sampling_interval: 30,
      },
    };

    this.mqttClient.publish(topic, JSON.stringify(cfg), { qos: 1 }, (err) => {
      if (err) {
        console.error("[collector] MQTT interval config publish failed:", err);
      } else {
        console.log("[collector] MQTT interval config sent (30s intervals)");
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
    console.log(`[collector] Qingping token refreshed, expires in ${expiresIn}s`);
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
      console.warn("[collector] No devices from Qingping");
      return;
    }
    const data = body.devices[0].data;
    const row = this.toAirRow(new Date(data.timestamp.value * 1000), data);
    await this.storeAir(row);
    this.latestAirRow = row as unknown as Record<string, unknown>;
    this.latestAirTs = row.ts;
    console.log(`[collector] Stored air reading at ${row.ts.toISOString()}`);
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
}
