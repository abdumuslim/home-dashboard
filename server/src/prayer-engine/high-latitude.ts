// High-latitude fallbacks for Fajr/Isha when the sun never reaches the twilight
// angle (summer above ~48°). Portions of the night are measured from sunset to
// the next sunrise. See praytimes.org/docs/calculation.

import type { HighLatitudeRule } from "./types.js";

/** Fraction of the night allotted to a twilight, per the chosen rule. */
function nightPortion(rule: HighLatitudeRule, angleDeg: number): number {
  switch (rule) {
    case "AngleBased":
      return angleDeg / 60;
    case "OneSeventh":
      return 1 / 7;
    case "NightMiddle":
      return 1 / 2;
    default:
      return 0;
  }
}

export interface NightContext {
  sunset: Date;
  /** Sunrise of the FOLLOWING day (defines night length). */
  nextSunrise: Date;
}

/** Fajr = sunrise − portion·night, clamped so it never precedes the night's start. */
export function highLatFajr(
  rule: HighLatitudeRule,
  fajrAngleDeg: number,
  todaySunrise: Date,
  night: NightContext,
): Date | null {
  if (rule === "None") return null;
  const nightMs = night.nextSunrise.getTime() - night.sunset.getTime();
  if (!(nightMs > 0)) return null;
  const portionMs = nightPortion(rule, fajrAngleDeg) * nightMs;
  return new Date(todaySunrise.getTime() - portionMs);
}

/** Isha = sunset + portion·night. */
export function highLatIsha(
  rule: HighLatitudeRule,
  ishaAngleDeg: number,
  sunset: Date,
  night: NightContext,
): Date | null {
  if (rule === "None") return null;
  const nightMs = night.nextSunrise.getTime() - night.sunset.getTime();
  if (!(nightMs > 0)) return null;
  const portionMs = nightPortion(rule, ishaAngleDeg) * nightMs;
  return new Date(sunset.getTime() + portionMs);
}
