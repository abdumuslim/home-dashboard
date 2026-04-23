/**
 * Map WMO weather codes to Meteocon SVG icon paths.
 * Uses the same animated fill-style icons from client/public/weather-icons/.
 */

interface WmoMapping {
  label: string;
  dayIcon: string;
  nightIcon: string;
}

const WMO_MAP: Record<number, WmoMapping> = {
  0: { label: "Clear", dayIcon: "/weather-icons/clear-day.svg", nightIcon: "/weather-icons/clear-night.svg" },
  1: { label: "Mostly Clear", dayIcon: "/weather-icons/clear-day.svg", nightIcon: "/weather-icons/clear-night.svg" },
  2: { label: "Partly Cloudy", dayIcon: "/weather-icons/partly-cloudy-day.svg", nightIcon: "/weather-icons/overcast-night.svg" },
  3: { label: "Overcast", dayIcon: "/weather-icons/overcast-day.svg", nightIcon: "/weather-icons/overcast-night.svg" },
  45: { label: "Fog", dayIcon: "/weather-icons/cloudy.svg", nightIcon: "/weather-icons/cloudy.svg" },
  48: { label: "Freezing Fog", dayIcon: "/weather-icons/cloudy.svg", nightIcon: "/weather-icons/cloudy.svg" },
  51: { label: "Light Drizzle", dayIcon: "/weather-icons/drizzle.svg", nightIcon: "/weather-icons/drizzle.svg" },
  53: { label: "Drizzle", dayIcon: "/weather-icons/drizzle.svg", nightIcon: "/weather-icons/drizzle.svg" },
  55: { label: "Heavy Drizzle", dayIcon: "/weather-icons/drizzle.svg", nightIcon: "/weather-icons/drizzle.svg" },
  56: { label: "Freezing Drizzle", dayIcon: "/weather-icons/drizzle.svg", nightIcon: "/weather-icons/drizzle.svg" },
  57: { label: "Heavy Freezing Drizzle", dayIcon: "/weather-icons/drizzle.svg", nightIcon: "/weather-icons/drizzle.svg" },
  61: { label: "Light Rain", dayIcon: "/weather-icons/drizzle.svg", nightIcon: "/weather-icons/drizzle.svg" },
  63: { label: "Rain", dayIcon: "/weather-icons/rain.svg", nightIcon: "/weather-icons/rain.svg" },
  65: { label: "Heavy Rain", dayIcon: "/weather-icons/rain.svg", nightIcon: "/weather-icons/rain.svg" },
  66: { label: "Freezing Rain", dayIcon: "/weather-icons/rain.svg", nightIcon: "/weather-icons/rain.svg" },
  67: { label: "Heavy Freezing Rain", dayIcon: "/weather-icons/rain.svg", nightIcon: "/weather-icons/rain.svg" },
  71: { label: "Light Snow", dayIcon: "/weather-icons/cloudy.svg", nightIcon: "/weather-icons/cloudy.svg" },
  73: { label: "Snow", dayIcon: "/weather-icons/cloudy.svg", nightIcon: "/weather-icons/cloudy.svg" },
  75: { label: "Heavy Snow", dayIcon: "/weather-icons/cloudy.svg", nightIcon: "/weather-icons/cloudy.svg" },
  77: { label: "Snow Grains", dayIcon: "/weather-icons/cloudy.svg", nightIcon: "/weather-icons/cloudy.svg" },
  80: { label: "Light Showers", dayIcon: "/weather-icons/drizzle.svg", nightIcon: "/weather-icons/drizzle.svg" },
  81: { label: "Showers", dayIcon: "/weather-icons/rain.svg", nightIcon: "/weather-icons/rain.svg" },
  82: { label: "Heavy Showers", dayIcon: "/weather-icons/rain.svg", nightIcon: "/weather-icons/rain.svg" },
  85: { label: "Snow Showers", dayIcon: "/weather-icons/cloudy.svg", nightIcon: "/weather-icons/cloudy.svg" },
  86: { label: "Heavy Snow Showers", dayIcon: "/weather-icons/cloudy.svg", nightIcon: "/weather-icons/cloudy.svg" },
  95: { label: "Thunderstorm", dayIcon: "/weather-icons/rain.svg", nightIcon: "/weather-icons/rain.svg" },
  96: { label: "Thunderstorm + Hail", dayIcon: "/weather-icons/rain.svg", nightIcon: "/weather-icons/rain.svg" },
  99: { label: "Thunderstorm + Heavy Hail", dayIcon: "/weather-icons/rain.svg", nightIcon: "/weather-icons/rain.svg" },
};

const FALLBACK: WmoMapping = { label: "Unknown", dayIcon: "/weather-icons/cloudy.svg", nightIcon: "/weather-icons/cloudy.svg" };

export function getWeatherIcon(code: number | null, isNight = false): string {
  if (code == null) return FALLBACK.dayIcon;
  const entry = WMO_MAP[code] ?? FALLBACK;
  return isNight ? entry.nightIcon : entry.dayIcon;
}

export function getWeatherLabel(code: number | null): string {
  if (code == null) return FALLBACK.label;
  return (WMO_MAP[code] ?? FALLBACK).label;
}

/** Get day-of-week label for a date string "YYYY-MM-DD" */
export function getDayLabel(dateStr: string, index: number): string {
  if (index === 0) return "Today";
  if (index === 1) return "Tomorrow";
  const date = new Date(dateStr + "T12:00:00");
  return date.toLocaleDateString("en-US", { weekday: "short" });
}
