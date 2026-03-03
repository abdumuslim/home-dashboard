export interface MetricDef {
  label: string;
  unit: string;
  group: string;
  source: "weather" | "air";
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

  // Air Quality (Qingping)
  temperature_air:  { label: "Kitchen Temperature", unit: "°C", group: "Air Quality", source: "air", min: -10, max: 60, dbColumn: "temperature" },
  humidity_air:     { label: "Kitchen Humidity", unit: "%", group: "Air Quality", source: "air", min: 0, max: 100, dbColumn: "humidity" },
  co2:              { label: "CO₂", unit: "ppm", group: "Air Quality", source: "air", min: 0, max: 5000 },
  pm25:             { label: "PM2.5", unit: "µg/m³", group: "Air Quality", source: "air", min: 0, max: 500 },
  pm10:             { label: "PM10", unit: "µg/m³", group: "Air Quality", source: "air", min: 0, max: 600 },
  tvoc:             { label: "tVOC", unit: "ppb", group: "Air Quality", source: "air", min: 0, max: 1000 },
  noise:            { label: "Noise", unit: "dB", group: "Air Quality", source: "air", min: 0, max: 130 },
};

export const VALID_PRAYER_NAMES = ["fajr", "dhuhr", "asr", "maghrib", "isha"] as const;

export function getMetricValue(
  metric: string,
  weather: Record<string, unknown> | null,
  air: Record<string, unknown> | null,
): number | null {
  const def = ALERT_METRICS[metric];
  if (!def) return null;

  const row = def.source === "weather" ? weather : air;
  if (!row) return null;

  const col = def.dbColumn ?? metric;
  const val = row[col];
  return typeof val === "number" ? val : null;
}
