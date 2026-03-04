import type { CSSProperties } from "react";
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

const TEMP_RANGES: { max: number; from: string; to: string }[] = [
  { max: -23.3, from: "#F141DA", to: "#D61CC0" }, // Magenta
  { max: -17.8, from: "#9F33F2", to: "#7F11D0" }, // Purple
  { max: -12.2, from: "#3C14F5", to: "#1D00CD" }, // Dark Blue
  { max: -6.7,  from: "#3B69FF", to: "#1144EB" }, // Blue
  { max: -1.1,  from: "#1ABCFE", to: "#0098DF" }, // Light Blue
  { max: 4.4,   from: "#1AEEF4", to: "#00CCD3" }, // Cyan
  { max: 10.0,  from: "#B7FE1E", to: "#95D900" }, // Lime Green
  { max: 15.6,  from: "#FFE316", to: "#DBC100" }, // Yellow
  { max: 21.1,  from: "#FFBA13", to: "#E09E00" }, // Gold
  { max: 26.7,  from: "#FF941A", to: "#DA7600" }, // Orange
  { max: 32.2,  from: "#FF6E1D", to: "#D55400" }, // Dark Orange
  { max: 37.8,  from: "#F64B17", to: "#CC3500" }, // Orange Red
  { max: 43.3,  from: "#D93A17", to: "#B02800" }, // Red
];
const TEMP_EXTREME = { from: "#C42B16", to: "#981900" }; // Dark Red (> 43.3)

export function getTempColor(temp: number | null | undefined): string {
  if (temp == null) return "#00d4ff";
  for (const r of TEMP_RANGES) {
    if (temp <= r.max) return r.from;
  }
  return TEMP_EXTREME.from;
}

export function getTempGradientStyle(temp: number | null | undefined): CSSProperties {
  if (temp == null) return { color: "#00d4ff" };
  let from: string, to: string;
  const range = TEMP_RANGES.find(r => temp <= r.max);
  if (range) { from = range.from; to = range.to; }
  else { from = TEMP_EXTREME.from; to = TEMP_EXTREME.to; }
  return {
    background: `linear-gradient(to bottom, ${from}, ${to})`,
    backgroundClip: "text",
    WebkitBackgroundClip: "text",
    WebkitTextFillColor: "transparent",
  };
}
