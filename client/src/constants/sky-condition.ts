import { getClearSky } from "./solar-model";
import type { WeatherReading } from "@/types/api";

export interface SkyResult {
  label: string;
  icon: string;
  color: string;
}

const WINDOW_MS = 7 * 60 * 1000;

/** Interpolated k-th percentile (k in 0–1) of a pre-sorted numeric array. */
function percentile(sorted: number[], k: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = k * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/** Compute median CSI and percentile spread over a rolling time window. */
function computeWindowCSI(
  history: WeatherReading[],
  currentRadiation: number,
  currentClearSkyGHI: number,
  date: Date,
  windowMs: number,
): { medianCSI: number; spread: number; count: number } {
  const now = date.getTime();
  const csiValues: number[] = [];

  for (const r of history) {
    if (r.solar_radiation == null) continue;
    const age = now - new Date(r.ts).getTime();
    if (age < 0 || age > windowMs) continue;
    const { clearSkyGHI } = getClearSky(new Date(r.ts));
    if (clearSkyGHI < 50) continue; // unreliable near horizon
    csiValues.push(r.solar_radiation / clearSkyGHI);
  }

  // Always include the current reading as the freshest point
  csiValues.push(currentRadiation / currentClearSkyGHI);

  // Fallback: not enough data for meaningful statistics
  if (csiValues.length < 2) {
    return {
      medianCSI: currentRadiation / currentClearSkyGHI,
      spread: 0,
      count: csiValues.length,
    };
  }

  csiValues.sort((a, b) => a - b);

  return {
    medianCSI: percentile(csiValues, 0.5),
    spread: percentile(csiValues, 0.8) - percentile(csiValues, 0.2),
    count: csiValues.length,
  };
}

/**
 * Determine sky condition from current weather readings + theoretical clear-sky model.
 * Uses a 7-minute rolling window of CSI values for stable classification.
 * Returns one of 8 states, each with a unique animated Meteocon SVG.
 */
export function getSkyCondition(
  radiation: number | null | undefined,
  rainHourlyMm: number | null | undefined,
  humidity: number | null | undefined,
  dewPointC: number | null | undefined,
  tempC: number | null | undefined,
  history: WeatherReading[],
  date: Date = new Date(),
): SkyResult | null {
  // Rain overrides everything (check first)
  if (rainHourlyMm != null && rainHourlyMm > 0) {
    if (rainHourlyMm > 2.5)
      return { label: "Heavy Rain", icon: "/weather-icons/rain.svg", color: "#1976d2" };
    return { label: "Light Rain", icon: "/weather-icons/drizzle.svg", color: "#2196ff" };
  }

  const { clearSkyGHI, isNight } = getClearSky(date);

  // Nighttime: use humidity + dew point spread
  if (isNight) {
    const dewSpread =
      tempC != null && dewPointC != null ? tempC - dewPointC : null;
    if (
      (humidity != null && humidity >= 85) ||
      (dewSpread != null && dewSpread < 2.5)
    ) {
      return { label: "Cloudy Night", icon: "/weather-icons/overcast-night.svg", color: "#c0c7d0" };
    }
    return { label: "Clear Night", icon: "/weather-icons/clear-night.svg", color: "#a78bfa" };
  }

  // Daytime: need radiation and a valid reference
  if (radiation == null || clearSkyGHI < 1) return null;

  const { medianCSI, spread } = computeWindowCSI(
    history, radiation, clearSkyGHI, date, WINDOW_MS,
  );

  // Classification: medianCSI for level, spread for variability
  if (medianCSI > 0.7) {
    if (spread < 0.2)
      return { label: "Sunny", icon: "/weather-icons/clear-day.svg", color: "#ffc107" };
    return { label: "Partly Cloudy", icon: "/weather-icons/partly-cloudy-day.svg", color: "#fbbf24" };
  }
  if (medianCSI > 0.4) {
    if (spread < 0.15)
      return { label: "Partly Cloudy", icon: "/weather-icons/partly-cloudy-day.svg", color: "#fbbf24" };
    return { label: "Mostly Cloudy", icon: "/weather-icons/overcast-day.svg", color: "#d1d5db" };
  }
  if (medianCSI > 0.15)
    return { label: "Mostly Cloudy", icon: "/weather-icons/overcast-day.svg", color: "#d1d5db" };
  return { label: "Cloudy", icon: "/weather-icons/cloudy.svg", color: "#c0c7d0" };
}
