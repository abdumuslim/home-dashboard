import type { MetricInfo } from "@/types/alerts";

export const ALERT_METRICS: Record<string, MetricInfo> = {
  // Outdoor
  temp_c:           { label: "Outdoor Temperature", unit: "°C", group: "Outdoor", min: -50, max: 70 },
  humidity:         { label: "Outdoor Humidity", unit: "%", group: "Outdoor", min: 0, max: 100 },
  wind_speed_kmh:   { label: "Wind Speed", unit: "km/h", group: "Outdoor", min: 0, max: 200 },
  wind_gust_kmh:    { label: "Wind Gust", unit: "km/h", group: "Outdoor", min: 0, max: 300 },
  pressure_rel_hpa: { label: "Barometric Pressure", unit: "hPa", group: "Outdoor", min: 870, max: 1084 },
  rain_hourly_mm:   { label: "Rain (Hourly)", unit: "mm", group: "Outdoor", min: 0, max: 300 },
  rain_daily_mm:    { label: "Rain (Daily)", unit: "mm", group: "Outdoor", min: 0, max: 500 },
  solar_radiation:  { label: "Solar Radiation", unit: "W/m²", group: "Outdoor", min: 0, max: 1400 },
  uv_index:         { label: "UV Index", unit: "", group: "Outdoor", min: 0, max: 16 },

  // Indoor
  temp_indoor_c:    { label: "Indoor Temperature (Mom)", unit: "°C", group: "Indoor", min: -10, max: 60 },
  humidity_indoor:  { label: "Indoor Humidity (Mom)", unit: "%", group: "Indoor", min: 0, max: 100 },
  temp_ch8_c:       { label: "Indoor Temperature (Abdu)", unit: "°C", group: "Indoor", min: -10, max: 60 },
  humidity_ch8:     { label: "Indoor Humidity (Abdu)", unit: "%", group: "Indoor", min: 0, max: 100 },

  // Air Quality (Qingping)
  temperature_air:  { label: "Kitchen Temperature", unit: "°C", group: "Air Quality", min: -10, max: 60 },
  humidity_air:     { label: "Kitchen Humidity", unit: "%", group: "Air Quality", min: 0, max: 100 },
  co2:              { label: "CO₂", unit: "ppm", group: "Air Quality", min: 0, max: 5000 },
  pm25:             { label: "PM2.5", unit: "µg/m³", group: "Air Quality", min: 0, max: 500 },
  pm10:             { label: "PM10", unit: "µg/m³", group: "Air Quality", min: 0, max: 600 },
  tvoc:             { label: "tVOC", unit: "ppb", group: "Air Quality", min: 0, max: 1000 },
  noise:            { label: "Noise", unit: "dB", group: "Air Quality", min: 0, max: 130 },
};

export const PRAYER_NAMES = ["fajr", "dhuhr", "asr", "maghrib", "isha"] as const;
