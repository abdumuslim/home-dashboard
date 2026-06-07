export interface MetricDef {
  label: string;
  unit: string;
  group: string;
  source: "weather" | "air" | "power";
  min: number;
  max: number;
  dbColumn?: string; // override when metric key differs from DB column
}

export const ALERT_METRICS: Record<string, MetricDef> = {
  // Outdoor
  temp_c:           { label: "Outdoor Temperature", unit: "°C", group: "Outdoor", source: "weather", min: -50, max: 70 },
  humidity:         { label: "Outdoor Humidity", unit: "%", group: "Outdoor", source: "weather", min: 0, max: 100 },
  wind_speed_kmh:   { label: "Wind Speed", unit: "km/h", group: "Outdoor", source: "weather", min: 0, max: 200 },
  wind_gust_kmh:    { label: "Wind Gust", unit: "km/h", group: "Outdoor", source: "weather", min: 0, max: 300 },
  pressure_rel_hpa: { label: "Barometric Pressure", unit: "hPa", group: "Outdoor", source: "weather", min: 870, max: 1084 },
  rain_hourly_mm:   { label: "Rain (Hourly)", unit: "mm", group: "Outdoor", source: "weather", min: 0, max: 300 },
  rain_daily_mm:    { label: "Rain (Daily)", unit: "mm", group: "Outdoor", source: "weather", min: 0, max: 500 },
  solar_radiation:  { label: "Solar Radiation", unit: "W/m²", group: "Outdoor", source: "weather", min: 0, max: 1400 },
  uv_index:         { label: "UV Index", unit: "", group: "Outdoor", source: "weather", min: 0, max: 16 },

  // Indoor
  temp_indoor_c:    { label: "Indoor Temperature (Mom)", unit: "°C", group: "Indoor", source: "weather", min: -10, max: 60 },
  humidity_indoor:  { label: "Indoor Humidity (Mom)", unit: "%", group: "Indoor", source: "weather", min: 0, max: 100 },
  temp_ch8_c:       { label: "Indoor Temperature (Abdu)", unit: "°C", group: "Indoor", source: "weather", min: -10, max: 60 },
  humidity_ch8:     { label: "Indoor Humidity (Abdu)", unit: "%", group: "Indoor", source: "weather", min: 0, max: 100 },
  feels_like_indoor_c: { label: "Feels Like (Mom)", unit: "°C", group: "Indoor", source: "weather", min: -10, max: 60 },
  feels_like_ch8_c:    { label: "Feels Like (Abdu)", unit: "°C", group: "Indoor", source: "weather", min: -10, max: 60 },

  // Air Quality (Qingping)
  temperature_air:  { label: "Kitchen Temperature", unit: "°C", group: "Air Quality", source: "air", min: -10, max: 60, dbColumn: "temperature" },
  humidity_air:     { label: "Kitchen Humidity", unit: "%", group: "Air Quality", source: "air", min: 0, max: 100, dbColumn: "humidity" },
  co2:              { label: "CO₂", unit: "ppm", group: "Air Quality", source: "air", min: 0, max: 5000 },
  pm25:             { label: "PM2.5", unit: "µg/m³", group: "Air Quality", source: "air", min: 0, max: 500 },
  pm10:             { label: "PM10", unit: "µg/m³", group: "Air Quality", source: "air", min: 0, max: 600 },
  tvoc:             { label: "tVOC", unit: "ppb", group: "Air Quality", source: "air", min: 0, max: 1000 },
  noise:            { label: "Noise", unit: "dB", group: "Air Quality", source: "air", min: 0, max: 130 },

  // Power
  voltage:          { label: "Voltage", unit: "V", group: "Power", source: "power", min: 0, max: 300 },
  power_grid:       { label: "Grid Power", unit: "W", group: "Power", source: "power", min: 0, max: 25000, dbColumn: "power_1" },
  power_gen:        { label: "Generator Power", unit: "W", group: "Power", source: "power", min: 0, max: 25000, dbColumn: "power_2" },
  power_total:      { label: "Total Power", unit: "W", group: "Power", source: "power", min: 0, max: 50000 },
  current_grid:     { label: "Grid Current", unit: "A", group: "Power", source: "power", min: 0, max: 100, dbColumn: "current_1" },
  current_gen:      { label: "Generator Current", unit: "A", group: "Power", source: "power", min: 0, max: 100, dbColumn: "current_2" },
};

export const VALID_PRAYER_NAMES = ["fajr", "dhuhr", "asr", "maghrib", "isha"] as const;

export const PRAYER_LABELS: Record<string, string> = {
  fajr: "Fajr", dhuhr: "Dhuhr", asr: "Asr", maghrib: "Maghrib", isha: "Isha",
};

/** One ESP power reading with its ingest timestamp (ms epoch). */
export interface PowerReadingEntry {
  tsMs: number;
  row: Record<string, unknown>;
}

/** Consecutive readings required before a power alert fires (~20s at the ESP's 5s cadence). */
export const POWER_ALERT_READINGS = 4;
/** A gap larger than this between readings breaks the streak (3 missed readings = no electricity). */
export const POWER_ALERT_MAX_GAP_MS = 15_000;

/**
 * Sustained-condition check for fluctuating power metrics: true only when the
 * last POWER_ALERT_READINGS readings all meet the condition and are consecutive
 * in time (no gap > POWER_ALERT_MAX_GAP_MS). Pure — no I/O.
 */
export function powerConditionSustained(
  metric: string,
  condition: "above" | "below",
  threshold: number,
  readings: ReadonlyArray<PowerReadingEntry>,
): boolean {
  if (readings.length < POWER_ALERT_READINGS) return false;
  const window = readings.slice(-POWER_ALERT_READINGS);

  for (let i = 0; i < window.length; i++) {
    if (i > 0 && window[i].tsMs - window[i - 1].tsMs > POWER_ALERT_MAX_GAP_MS) return false;
    const value = getMetricValue(metric, null, null, window[i].row);
    if (value == null) return false;
    const met = condition === "above" ? value > threshold : value < threshold;
    if (!met) return false;
  }
  return true;
}

export function getMetricValue(
  metric: string,
  weather: Record<string, unknown> | null,
  air: Record<string, unknown> | null,
  power?: Record<string, unknown> | null,
): number | null {
  const def = ALERT_METRICS[metric];
  if (!def) return null;

  if (metric === "power_total") {
    if (!power) return null;
    const p1 = power.power_1;
    const p2 = power.power_2;
    if (typeof p1 !== "number" || typeof p2 !== "number") return null;
    return p1 + p2;
  }

  const row = def.source === "weather" ? weather : def.source === "air" ? air : power ?? null;
  if (!row) return null;

  const col = def.dbColumn ?? metric;
  const val = row[col];
  return typeof val === "number" ? val : null;
}
