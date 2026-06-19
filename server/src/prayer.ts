// Dashboard-side wrapper around the portable prayer-engine, pinned to the
// household: Baghdad coordinates + the calibrated "BaghdadYMA" profile, with
// Baghdad-timezone helpers. The engine itself (server/src/prayer-engine) is
// location-agnostic; this is the single place the app's location/profile live.

import { calculatePrayerTimes, type PrayerTimesResult, type TimeName } from "./prayer-engine/index.js";

export const BAGHDAD_COORDS = { latitude: 33.321502, longitude: 44.358335 };
export const BAGHDAD_TZ = "Asia/Baghdad";
const PROFILE = "BaghdadYMA";

/** Final (offset + rounded) prayer times for the Baghdad civil day `date` falls on. */
export function getBaghdadPrayerTimes(date: Date = new Date()): PrayerTimesResult {
  return calculatePrayerTimes(BAGHDAD_COORDS, date, { method: PROFILE, timezone: BAGHDAD_TZ });
}

/** Minute-of-day (0–1439) in Baghdad local time for an instant. */
export function baghdadMinuteOfDay(d: Date): number {
  const map: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat("en-GB", {
    timeZone: BAGHDAD_TZ,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(d)) {
    if (p.type !== "literal") map[p.type] = p.value;
  }
  return Number(map.hour) * 60 + Number(map.minute);
}

/** Baghdad civil date key (YYYY-MM-DD) — used to invalidate per-day caches. */
export function baghdadDateKey(date: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: BAGHDAD_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** Look up a single prayer instant from a result, or null if uncomputable. */
export function prayerInstant(times: PrayerTimesResult, prayer: string): Date | null {
  const t = times[prayer as TimeName];
  return t instanceof Date && !Number.isNaN(t.getTime()) ? t : null;
}
