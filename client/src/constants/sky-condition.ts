import { getClearSky } from "./solar-model";
import type { WeatherReading } from "@/types/api";

export interface SkyResult {
  label: string;
  icon: string;
  color: string;
}

/**
 * Determine sky condition from current weather readings + theoretical clear-sky model.
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
      (humidity != null && humidity >= 70) ||
      (dewSpread != null && dewSpread < 4)
    ) {
      return { label: "Cloudy Night", icon: "/weather-icons/overcast-night.svg", color: "#c0c7d0" };
    }
    return { label: "Clear Night", icon: "/weather-icons/clear-night.svg", color: "#a78bfa" };
  }

  // Daytime: need radiation and a valid reference
  if (radiation == null || clearSkyGHI < 1) return null;

  const level = radiation / clearSkyGHI;

  // Compute variability from last 10 minutes of readings
  const now = Date.now();
  const pts = history
    .filter(
      (r) =>
        r.solar_radiation != null && now - new Date(r.ts).getTime() <= 600000,
    )
    .map((r) => ({
      t: new Date(r.ts).getTime(),
      v: r.solar_radiation as number,
    }))
    .sort((a, b) => a.t - b.t);

  let variability = 0;
  if (pts.length >= 3) {
    const first = pts[0],
      last = pts[pts.length - 1];
    const dt = last.t - first.t;
    const slope = dt > 0 ? (last.v - first.v) / dt : 0;
    let maxDev = 0;
    for (const pt of pts) {
      const expected = first.v + slope * (pt.t - first.t);
      maxDev = Math.max(maxDev, Math.abs(pt.v - expected));
    }
    variability = clearSkyGHI > 0 ? maxDev / clearSkyGHI : 0;
  }

  // Classification
  if (level > 0.7) {
    if (variability < 0.15)
      return { label: "Sunny", icon: "/weather-icons/clear-day.svg", color: "#ffc107" };
    return { label: "Partly Cloudy", icon: "/weather-icons/partly-cloudy-day.svg", color: "#fbbf24" };
  }
  if (level > 0.4) {
    if (variability < 0.15)
      return { label: "Partly Cloudy", icon: "/weather-icons/partly-cloudy-day.svg", color: "#fbbf24" };
    return { label: "Mostly Cloudy", icon: "/weather-icons/overcast-day.svg", color: "#d1d5db" };
  }
  if (level > 0.15)
    return { label: "Mostly Cloudy", icon: "/weather-icons/overcast-day.svg", color: "#d1d5db" };
  return { label: "Cloudy", icon: "/weather-icons/cloudy.svg", color: "#c0c7d0" };
}
