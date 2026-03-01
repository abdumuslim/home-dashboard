import pg from "pg";
import type { Config } from "./config.js";

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AWData = Record<string, any>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class Collector {
  private pool: pg.Pool;
  private config: Config;
  private qpToken: string | null = null;
  private qpTokenExpires = 0;
  private stopped = false;

  constructor(pool: pg.Pool, config: Config) {
    this.pool = pool;
    this.config = config;
  }

  stop(): void {
    this.stopped = true;
  }

  async runForever(): Promise<void> {
    await this.backfillAmbientHistory();
    await sleep(2000);
    await this.backfillQingpingHistory();
    while (!this.stopped) {
      try {
        await this.collectAll();
      } catch (err) {
        console.error("[collector] Collection cycle failed:", err);
      }
      await sleep(5000);
    }
  }

  private async collectAll(): Promise<void> {
    const results = await Promise.allSettled([
      this.collectAmbientWeather(),
      this.collectQingping(),
    ]);
    for (const r of results) {
      if (r.status === "rejected") {
        console.error("[collector] Collection error:", r.reason);
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

  private async backfillQingpingHistory(): Promise<void> {
    const mac = "582D3470F981";
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

        interface QpHistoryItem {
          timestamp: { value: number };
          temperature?: { value: number };
          humidity?: { value: number };
          co2?: { value: number };
          pm25?: { value: number };
          pm10?: { value: number };
          tvoc_index?: { value: number };
          noise?: { value: number };
          battery?: { value: number };
        }
        interface QpHistoryResponse {
          total?: number;
          data?: QpHistoryItem[];
        }

        const body = (await resp.json()) as QpHistoryResponse;
        const items = body.data ?? [];
        if (items.length === 0) break;

        for (const d of items) {
          const row: AirRow = {
            ts: new Date(d.timestamp.value * 1000),
            temperature: d.temperature?.value ?? null,
            humidity: d.humidity?.value ?? null,
            co2: d.co2?.value ?? null,
            pm25: d.pm25?.value ?? null,
            pm10: d.pm10?.value ?? null,
            tvoc: d.tvoc_index?.value ?? null,
            noise: d.noise?.value ?? null,
            battery: d.battery?.value ?? null,
          };
          await this.storeAir(row);
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

  // ---------- Qingping ----------

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
      data: Record<string, { value: number }>;
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
    const ts = new Date(data.timestamp.value * 1000);

    const row: AirRow = {
      ts,
      temperature: data.temperature?.value ?? null,
      humidity: data.humidity?.value ?? null,
      co2: data.co2?.value ?? null,
      pm25: data.pm25?.value ?? null,
      pm10: data.pm10?.value ?? null,
      tvoc: data.tvoc_index?.value ?? null,
      noise: data.noise?.value ?? null,
      battery: data.battery?.value ?? null,
    };
    await this.storeAir(row);
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
