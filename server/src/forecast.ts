import fs from "node:fs";
import { childLogger } from "./logger.js";

const log = childLogger("forecast");

const LAT = 33.3215;
const LON = 44.3583;
const TZ = "Asia/Baghdad";
const FETCH_INTERVAL = 30 * 60 * 1000; // 30 minutes

interface BiasTable {
  calibration_period: string;
  generated_at: string;
  metrics: {
    temperature: (number | null)[][];
    humidity: (number | null)[][];
    wind_speed: (number | null)[][];
    solar_radiation: (number | null)[][];
  };
}

interface OpenMeteoForecast {
  hourly: {
    time: string[];
    temperature_2m: (number | null)[];
    relative_humidity_2m: (number | null)[];
    dew_point_2m: (number | null)[];
    apparent_temperature: (number | null)[];
    surface_pressure: (number | null)[];
    wind_speed_10m: (number | null)[];
    wind_direction_10m: (number | null)[];
    wind_gusts_10m: (number | null)[];
    shortwave_radiation: (number | null)[];
    uv_index: (number | null)[];
    cloud_cover: (number | null)[];
    precipitation_probability: (number | null)[];
    precipitation: (number | null)[];
    weather_code: (number | null)[];
  };
  daily: {
    time: string[];
    temperature_2m_max: (number | null)[];
    temperature_2m_min: (number | null)[];
    sunrise: string[];
    sunset: string[];
    precipitation_sum: (number | null)[];
    precipitation_probability_max: (number | null)[];
    uv_index_max: (number | null)[];
    wind_speed_10m_max: (number | null)[];
    weather_code: (number | null)[];
  };
}

export interface ForecastResponse {
  generated_at: string;
  hourly: {
    time: string[];
    temperature: (number | null)[];
    humidity: (number | null)[];
    dew_point: (number | null)[];
    feels_like: (number | null)[];
    pressure: (number | null)[];
    wind_speed: (number | null)[];
    wind_direction: (number | null)[];
    wind_gusts: (number | null)[];
    solar_radiation: (number | null)[];
    uv_index: (number | null)[];
    cloud_cover: (number | null)[];
    precip_probability: (number | null)[];
    precipitation: (number | null)[];
    weather_code: (number | null)[];
  };
  daily: {
    date: string[];
    temp_max: (number | null)[];
    temp_min: (number | null)[];
    sunrise: string[];
    sunset: string[];
    precip_sum: (number | null)[];
    precip_probability_max: (number | null)[];
    uv_index_max: (number | null)[];
    wind_speed_max: (number | null)[];
    weather_code: (number | null)[];
  };
}

function round1(v: number | null): number | null {
  return v != null ? Math.round(v * 10) / 10 : null;
}

function clamp(v: number | null, min: number, max: number): number | null {
  if (v == null) return null;
  return Math.max(min, Math.min(max, v));
}

export class ForecastService {
  private biasTable: BiasTable | null = null;
  private cached: ForecastResponse | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private biasPath: string;

  constructor(biasPath: string) {
    this.biasPath = biasPath;
  }

  init(): void {
    // Load bias table
    try {
      const raw = fs.readFileSync(this.biasPath, "utf-8");
      this.biasTable = JSON.parse(raw) as BiasTable;
      log.info(`Bias table loaded: ${this.biasTable.calibration_period}`);
    } catch (err) {
      log.warn({ err }, "Failed to load bias table — forecasts will be uncorrected");
    }

    // Fetch immediately, then every 30 min
    this.fetchAndCache().catch((err) => log.error({ err }, "Initial forecast fetch failed"));
    this.timer = setInterval(() => {
      this.fetchAndCache().catch((err) => log.error({ err }, "Forecast fetch failed"));
    }, FETCH_INTERVAL);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getForecast(): ForecastResponse | null {
    return this.cached;
  }

  private getBias(metric: keyof BiasTable["metrics"], month: number, hour: number): number {
    if (!this.biasTable) return 0;
    const val = this.biasTable.metrics[metric]?.[month]?.[hour];
    return val ?? 0;
  }

  private async fetchAndCache(): Promise<void> {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}&hourly=temperature_2m,relative_humidity_2m,dew_point_2m,apparent_temperature,surface_pressure,wind_speed_10m,wind_direction_10m,wind_gusts_10m,shortwave_radiation,uv_index,cloud_cover,precipitation_probability,precipitation,weather_code&daily=temperature_2m_max,temperature_2m_min,sunrise,sunset,precipitation_sum,precipitation_probability_max,uv_index_max,wind_speed_10m_max,weather_code&timezone=${TZ}&forecast_days=7`;

    const res = await fetch(url);
    if (!res.ok) {
      log.error(`Open-Meteo forecast API error: ${res.status}`);
      return;
    }
    const raw = (await res.json()) as OpenMeteoForecast;
    const now = new Date();

    // Apply bias correction to hourly data
    const times = raw.hourly.time;
    const temperature: (number | null)[] = [];
    const humidity: (number | null)[] = [];
    const wind_speed: (number | null)[] = [];
    const solar_radiation: (number | null)[] = [];

    for (let i = 0; i < times.length; i++) {
      // Parse time: "2026-03-16T11:00"
      const month = parseInt(times[i].slice(5, 7), 10) - 1;
      const hour = parseInt(times[i].slice(11, 13), 10);

      const t = raw.hourly.temperature_2m[i];
      temperature.push(round1(t != null ? t + this.getBias("temperature", month, hour) : null));

      const h = raw.hourly.relative_humidity_2m[i];
      humidity.push(round1(clamp(h != null ? h + this.getBias("humidity", month, hour) : null, 0, 100)));

      const w = raw.hourly.wind_speed_10m[i];
      wind_speed.push(round1(clamp(w != null ? w + this.getBias("wind_speed", month, hour) : null, 0, Infinity)));

      const s = raw.hourly.shortwave_radiation[i];
      solar_radiation.push(round1(clamp(s != null ? s + this.getBias("solar_radiation", month, hour) : null, 0, Infinity)));
    }

    // Apply bias to daily max/min using typical peak hours
    const dailyTempMax: (number | null)[] = [];
    const dailyTempMin: (number | null)[] = [];
    for (let i = 0; i < raw.daily.time.length; i++) {
      const month = parseInt(raw.daily.time[i].slice(5, 7), 10) - 1;
      const tMax = raw.daily.temperature_2m_max[i];
      const tMin = raw.daily.temperature_2m_min[i];
      dailyTempMax.push(round1(tMax != null ? tMax + this.getBias("temperature", month, 14) : null));
      dailyTempMin.push(round1(tMin != null ? tMin + this.getBias("temperature", month, 5) : null));
    }

    // Format sunrise/sunset to HH:MM
    const sunrises = raw.daily.sunrise.map((s) => s?.slice(11, 16) ?? "");
    const sunsets = raw.daily.sunset.map((s) => s?.slice(11, 16) ?? "");

    this.cached = {
      generated_at: now.toISOString(),
      hourly: {
        time: times,
        temperature,
        humidity,
        dew_point: raw.hourly.dew_point_2m.map(round1),
        feels_like: raw.hourly.apparent_temperature.map(round1),
        pressure: raw.hourly.surface_pressure.map(round1),
        wind_speed,
        wind_direction: raw.hourly.wind_direction_10m,
        wind_gusts: raw.hourly.wind_gusts_10m.map(round1),
        solar_radiation,
        uv_index: raw.hourly.uv_index,
        cloud_cover: raw.hourly.cloud_cover,
        precip_probability: raw.hourly.precipitation_probability,
        precipitation: raw.hourly.precipitation.map(round1),
        weather_code: raw.hourly.weather_code,
      },
      daily: {
        date: raw.daily.time,
        temp_max: dailyTempMax,
        temp_min: dailyTempMin,
        sunrise: sunrises,
        sunset: sunsets,
        precip_sum: raw.daily.precipitation_sum.map(round1),
        precip_probability_max: raw.daily.precipitation_probability_max,
        uv_index_max: raw.daily.uv_index_max,
        wind_speed_max: raw.daily.wind_speed_10m_max.map(round1),
        weather_code: raw.daily.weather_code,
      },
    };

    log.info(`Forecast updated: ${times.length} hourly, ${raw.daily.time.length} daily entries`);
  }
}
