import type { ThresholdEntry } from "@/types/api";

export const TZ = "Asia/Baghdad";
export const REFRESH = 5000;
export const CHART_REFRESH = 60000;

export const THRESHOLDS: Record<string, ThresholdEntry[]> = {
  co2: [
    { max: 800, level: "good", label: "Good" },
    { max: 1200, level: "moderate", label: "Moderate" },
    { max: Infinity, level: "poor", label: "High" },
  ],
  pm25: [
    { max: 35, level: "good", label: "Good" },
    { max: 75, level: "moderate", label: "Moderate" },
    { max: Infinity, level: "poor", label: "Unhealthy" },
  ],
  pm10: [
    { max: 50, level: "good", label: "Good" },
    { max: 150, level: "moderate", label: "Moderate" },
    { max: Infinity, level: "poor", label: "Unhealthy" },
  ],
  tvoc: [
    { max: 100, level: "good", label: "Low" },
    { max: 250, level: "moderate", label: "Moderate" },
    { max: Infinity, level: "poor", label: "High" },
  ],
  noise: [
    { max: 40, level: "good", label: "Quiet" },
    { max: 65, level: "moderate", label: "Normal" },
    { max: Infinity, level: "poor", label: "Loud" },
  ],
  uv: [
    { max: 2, level: "good", label: "Low Risk" },
    { max: 5, level: "moderate", label: "Moderate" },
    { max: 7, level: "poor", label: "High" },
    { max: 10, level: "severe", label: "Very High" },
    { max: Infinity, level: "extreme", label: "Extreme" },
  ],
};

export const DIRS = [
  "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
  "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
];

export function getStatus(metric: string, value: number | null | undefined) {
  if (value == null) return { level: null, label: "--" };
  const thresholds = THRESHOLDS[metric];
  if (!thresholds) return { level: null, label: "--" };
  for (const t of thresholds) {
    if (value <= t.max) return t;
  }
  return { level: null, label: "--" };
}

export function degDir(d: number | null | undefined): string {
  if (d == null) return "--";
  return DIRS[Math.round(d / 22.5) % 16];
}

export function fmt(v: number | null | undefined, decimals: number): string {
  if (v == null) return "--";
  return Number(v).toFixed(decimals);
}
