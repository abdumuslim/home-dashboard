// Opt-in Sunnah / secondary times. Pure date math; the engine supplies the
// already-computed core instants.

const MIN_MS = 60_000;

/** Islamic midnight: half-way from sunset to the night's reference (next sunrise or next fajr). */
export function midnight(sunset: Date, nightEndRef: Date): Date {
  return new Date(sunset.getTime() + (nightEndRef.getTime() - sunset.getTime()) / 2);
}

/**
 * A third of the qiyam night, measured maghrib → next fajr (adhan SunnahTimes
 * convention). `which` = "first" (sunset + night/3) or "last" (sunset + 2·night/3,
 * the tahajjud window start).
 */
export function nightThird(maghrib: Date, nextFajr: Date, which: "first" | "last"): Date {
  const nightMs = nextFajr.getTime() - maghrib.getTime();
  const frac = which === "first" ? 1 / 3 : 2 / 3;
  return new Date(maghrib.getTime() + nightMs * frac);
}

/** Duha window: starts 15 min after sunrise, ends 15 min before Dhuhr. */
export function duhaWindow(sunrise: Date, dhuhr: Date): { start: Date; end: Date } {
  return {
    start: new Date(sunrise.getTime() + 15 * MIN_MS),
    end: new Date(dhuhr.getTime() - 15 * MIN_MS),
  };
}
