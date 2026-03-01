// ── Unit type definitions ──────────────────────────────────────────

export type TemperatureUnit = "C" | "F";
export type PressureUnit = "hPa" | "inHg" | "mmHg";
export type WindSpeedUnit = "km/h" | "mph" | "ft/s" | "m/s" | "knots";
export type RainfallUnit = "mm" | "in";
export type SolarUnit = "W/m2" | "lux";

export interface UnitPreferences {
  temperature: TemperatureUnit;
  pressure: PressureUnit;
  windSpeed: WindSpeedUnit;
  rainfall: RainfallUnit;
  solar: SolarUnit;
}

export const DEFAULT_UNITS: UnitPreferences = {
  temperature: "C",
  pressure: "hPa",
  windSpeed: "km/h",
  rainfall: "mm",
  solar: "W/m2",
};

// ── Display labels ─────────────────────────────────────────────────

export const TEMP_LABELS: Record<TemperatureUnit, string> = { C: "\u00B0C", F: "\u00B0F" };
export const PRESSURE_LABELS: Record<PressureUnit, string> = { hPa: "hPa", inHg: "inHg", mmHg: "mmHg" };
export const WIND_LABELS: Record<WindSpeedUnit, string> = { "km/h": "km/h", mph: "mph", "ft/s": "ft/s", "m/s": "m/s", knots: "knots" };
export const RAIN_RATE_LABELS: Record<RainfallUnit, string> = { mm: "mm/hr", in: "in/hr" };
export const RAIN_ACCUM_LABELS: Record<RainfallUnit, string> = { mm: "mm", in: "in" };
export const SOLAR_LABELS: Record<SolarUnit, string> = { "W/m2": "W/m\u00B2", lux: "lux" };

// ── Decimal precision per unit ─────────────────────────────────────

export const TEMP_DECIMALS: Record<TemperatureUnit, number> = { C: 1, F: 1 };
export const PRESSURE_DECIMALS: Record<PressureUnit, number> = { hPa: 1, inHg: 2, mmHg: 1 };
export const WIND_DECIMALS: Record<WindSpeedUnit, number> = { "km/h": 1, mph: 1, "ft/s": 1, "m/s": 1, knots: 1 };
export const RAIN_DECIMALS: Record<RainfallUnit, number> = { mm: 1, in: 2 };
export const SOLAR_DECIMALS: Record<SolarUnit, number> = { "W/m2": 0, lux: 0 };

// ── Conversion functions (from metric base) ────────────────────────

export function convertTemp(celsius: number, to: TemperatureUnit): number {
  if (to === "F") return (celsius * 9) / 5 + 32;
  return celsius;
}

/** Scale-only conversion for temperature deltas (no +32 offset) */
export function convertTempDelta(deltaCelsius: number, to: TemperatureUnit): number {
  if (to === "F") return (deltaCelsius * 9) / 5;
  return deltaCelsius;
}

export function convertPressure(hpa: number, to: PressureUnit): number {
  if (to === "inHg") return hpa / 33.8639;
  if (to === "mmHg") return hpa * 0.750062;
  return hpa;
}

export function convertWindSpeed(kmh: number, to: WindSpeedUnit): number {
  if (to === "mph") return kmh / 1.60934;
  if (to === "ft/s") return kmh * 0.911344;
  if (to === "m/s") return kmh / 3.6;
  if (to === "knots") return kmh / 1.852;
  return kmh;
}

export function convertRainfall(mm: number, to: RainfallUnit): number {
  if (to === "in") return mm / 25.4;
  return mm;
}

export function convertSolar(wm2: number, to: SolarUnit): number {
  if (to === "lux") return wm2 * 120;
  return wm2;
}

// ── Settings modal option definitions ──────────────────────────────

export const UNIT_OPTIONS = {
  temperature: [
    { value: "F" as const, label: "\u00B0F" },
    { value: "C" as const, label: "\u00B0C" },
  ],
  pressure: [
    { value: "inHg" as const, label: "inHg" },
    { value: "mmHg" as const, label: "mmHg" },
    { value: "hPa" as const, label: "hPa" },
  ],
  windSpeed: [
    { value: "mph" as const, label: "mph" },
    { value: "ft/s" as const, label: "ft/sec" },
    { value: "m/s" as const, label: "m/sec" },
    { value: "km/h" as const, label: "km/hr" },
    { value: "knots" as const, label: "knots" },
  ],
  rainfall: [
    { value: "in" as const, label: "in/hr" },
    { value: "mm" as const, label: "mm/hr" },
  ],
  solar: [
    { value: "W/m2" as const, label: "W/m\u00B2" },
    { value: "lux" as const, label: "lux" },
  ],
} as const;

export const STORAGE_KEY = "home-dashboard-units";
