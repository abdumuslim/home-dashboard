import type { ThresholdEntry } from "@/types/api";

export const TZ = "Asia/Baghdad";
export const REFRESH = 5000;
export const CHART_REFRESH = 60000;

export const THRESHOLDS: Record<string, ThresholdEntry[]> = {
  co2: [
    { max: 1000, level: "normal", label: "Normal" },
    { max: 2000, level: "slightly_high", label: "Slightly high" },
    { max: 3000, level: "high", label: "High" },
    { max: Infinity, level: "very_high", label: "Very high" },
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
    { max: 3, level: "excellent", label: "Excellent" },
    { max: 37, level: "good", label: "Good" },
    { max: 120, level: "slightly_high", label: "Slightly high" },
    { max: 293, level: "high", label: "High" },
    { max: Infinity, level: "very_high", label: "Very high" },
  ],
  noise: [
    { max: 50, level: "low", label: "Low" },
    { max: 70, level: "moderate", label: "Moderate" },
    { max: Infinity, level: "high", label: "High" },
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

const TEMP_COLORS: [number, string][] = [
  [0, "#60a5fa"],   // Blue — freezing
  [5, "#38bdf8"],   // Sky — very cold
  [10, "#22d3ee"],  // Cyan — cold
  [18, "#4ade80"],  // Green — cool
  [26, "#a3e635"],  // Lime — comfortable
  [32, "#facc15"],  // Yellow — warm
  [40, "#fb923c"],  // Orange — hot
  [49, "#fb7185"],  // Rose — very hot
];

export function getTempColor(temp: number | null | undefined): string {
  if (temp == null) return "#00d4ff";
  for (const [max, color] of TEMP_COLORS) {
    if (temp <= max) return color;
  }
  return "#c084fc"; // Purple — extreme heat (≥50)
}
