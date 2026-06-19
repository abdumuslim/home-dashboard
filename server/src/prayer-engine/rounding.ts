// Per-prayer minute offset + rounding. Operates on the absolute instant: minute
// boundaries and whole-second values are identical in every real (whole-minute)
// timezone, so this is timezone-independent.

import type { RoundingConfig, RoundingRule, TimeName } from "./types.js";

const MIN_MS = 60_000;

/** Apply a constant minute offset, then round to the minute per `rule`. */
export function applyOffsetAndRound(date: Date, offsetMin: number, rule: RoundingRule): Date {
  const t = date.getTime() + offsetMin * MIN_MS;
  if (rule === "none") return new Date(t);
  const floored = Math.floor(t / MIN_MS) * MIN_MS;
  const intoMinuteMs = t - floored;
  switch (rule) {
    case "down":
      return new Date(floored);
    case "up":
      return new Date(intoMinuteMs > 0 ? floored + MIN_MS : floored);
    case "nearest":
    default:
      return new Date(intoMinuteMs >= 30_000 ? floored + MIN_MS : floored);
  }
}

/** Resolve a single or per-prayer rounding config into a lookup by prayer. */
export function roundingFor(config: RoundingConfig | undefined, prayer: TimeName): RoundingRule {
  if (config == null) return "nearest";
  if (typeof config === "string") return config;
  return config[prayer] ?? "nearest";
}
