// prayer-engine — high-precision, GPS-portable Islamic prayer times.
//
// Astronomical core: astronomy-engine (Don Cross, MIT) — ~1 arcminute solar
// position with observer-elevation-aware rise/set. All returned instants are
// absolute (UTC); format to a local timezone for display.
//
//   import { calculatePrayerTimes } from "./prayer-engine/index.js";
//   const t = calculatePrayerTimes(
//     { latitude: 33.321502, longitude: 44.358335 },
//     new Date(),
//     { method: "BaghdadYMA", timezone: "Asia/Baghdad" },
//   );

import {
  makeSunContext,
  riseSet,
  transit,
  depressionEvent,
  descendToAltitude,
  sunDeclination,
  type SunContext,
} from "./astro.js";
import { asrAltitude, shadowFactorFor } from "./asr.js";
import { highLatFajr, highLatIsha } from "./high-latitude.js";
import { applyOffsetAndRound, roundingFor } from "./rounding.js";
import { midnight as sunnahMidnight, nightThird, duhaWindow } from "./sunnah.js";
import { resolveMethod } from "./methods.js";
import { zonedMidnightUtc } from "./timezone.js";
import type {
  AngleOrInterval,
  AsrMadhab,
  GeoCoordinates,
  HighLatitudeRule,
  Method,
  PrayerConfig,
  PrayerTimesResult,
  RoundingConfig,
  TimeName,
} from "./types.js";

export * from "./types.js";
export { METHODS, resolveMethod, type MethodName } from "./methods.js";

const MIN_MS = 60_000;

interface Resolved {
  params: Method["params"];
  asr: AsrMadhab;
  highLat: HighLatitudeRule;
  elevation: number;
  timezone: string;
  adjustments: Partial<Record<TimeName, number>>;
  rounding: RoundingConfig | undefined;
}

function isInterval(x: AngleOrInterval): x is { minutes: number } {
  return typeof x === "object";
}

function resolveElevation(
  cfg: boolean | number | undefined,
  coords: GeoCoordinates,
  method: Method,
): number {
  if (cfg === false) return 0;
  if (typeof cfg === "number") return cfg;
  return coords.elevation ?? method.elevationMeters ?? 0;
}

/** Compute the six finalized (offset + rounded) core times for one civil day. */
function computeCoreTimes(coords: GeoCoordinates, anchor: Date, r: Resolved) {
  const ctx = makeSunContext(coords, r.elevation, anchor);

  const sunriseRaw = riseSet(ctx, +1);
  const maghribRaw =
    r.params.maghribAngle != null ? depressionEvent(ctx, -1, r.params.maghribAngle) : riseSet(ctx, -1);
  const dhuhrRaw = transit(ctx);
  const dec = sunDeclination(ctx, dhuhrRaw);
  const asrRaw = descendToAltitude(ctx, asrAltitude(coords.latitude, dec, shadowFactorFor(r.asr)), dhuhrRaw);

  let fajrRaw = isInterval(r.params.fajr)
    ? shiftMinutes(sunriseRaw, -r.params.fajr.minutes)
    : depressionEvent(ctx, +1, r.params.fajr);
  let ishaRaw = isInterval(r.params.isha)
    ? shiftMinutes(maghribRaw, r.params.isha.minutes)
    : depressionEvent(ctx, -1, r.params.isha, maghribRaw ?? undefined);

  // High-latitude fallback when a twilight angle is never reached.
  if ((fajrRaw == null || ishaRaw == null) && r.highLat !== "None" && sunriseRaw && maghribRaw) {
    const nextSunrise = riseSet(ctx, +1, maghribRaw);
    if (nextSunrise) {
      const night = { sunset: maghribRaw, nextSunrise };
      if (fajrRaw == null && typeof r.params.fajr === "number") {
        fajrRaw = highLatFajr(r.highLat, r.params.fajr, sunriseRaw, night);
      }
      if (ishaRaw == null && typeof r.params.isha === "number") {
        ishaRaw = highLatIsha(r.highLat, r.params.isha, maghribRaw, night);
      }
    }
  }

  return {
    fajr: finalize(fajrRaw, "fajr", r),
    sunrise: finalize(sunriseRaw, "sunrise", r),
    dhuhr: finalize(dhuhrRaw, "dhuhr", r),
    asr: finalize(asrRaw, "asr", r),
    maghrib: finalize(maghribRaw, "maghrib", r),
    isha: finalize(ishaRaw, "isha", r),
  };
}

function finalize(raw: Date | null, name: TimeName, r: Resolved): Date {
  if (!raw || Number.isNaN(raw.getTime())) return new Date(NaN);
  return applyOffsetAndRound(raw, r.adjustments[name] ?? 0, roundingFor(r.rounding, name));
}

function shiftMinutes(date: Date | null, minutes: number): Date | null {
  return date ? new Date(date.getTime() + minutes * MIN_MS) : null;
}

export function calculatePrayerTimes(
  coords: GeoCoordinates,
  date: Date,
  config: PrayerConfig = {},
): PrayerTimesResult {
  const method = resolveMethod(config.method);
  const r: Resolved = {
    params: method.params,
    asr: config.asr ?? method.asr ?? "Standard",
    highLat: config.highLatitudeRule ?? method.highLatitudeRule ?? "None",
    elevation: resolveElevation(config.elevation, coords, method),
    timezone: config.timezone ?? "UTC",
    adjustments: { ...method.adjustments, ...config.adjustments },
    rounding: config.rounding ?? method.rounding,
  };

  const anchor = zonedMidnightUtc(date, r.timezone);
  const core = computeCoreTimes(coords, anchor, r);
  const result: PrayerTimesResult = { ...core };

  const sunnah = config.sunnah;
  if (sunnah) {
    // Next civil day's fajr/sunrise drive the night-based Sunnah times.
    const tomorrowAnchor = zonedMidnightUtc(new Date(anchor.getTime() + 36 * 3_600_000), r.timezone);
    const tomorrow = computeCoreTimes(coords, tomorrowAnchor, r);

    if (sunnah.imsak != null) {
      result.imsak = isInterval(sunnah.imsak)
        ? new Date(core.fajr.getTime() - sunnah.imsak.minutes * MIN_MS)
        : finalizeSunnah(depressionEvent(makeSunContext(coords, r.elevation, anchor), +1, sunnah.imsak));
    }
    if (sunnah.midnight) {
      const ref = sunnah.midnight === "Jafari" ? tomorrow.fajr : tomorrow.sunrise;
      result.midnight = roundToMinute(sunnahMidnight(core.maghrib, ref));
    }
    if (sunnah.firstThird) result.firstThird = roundToMinute(nightThird(core.maghrib, tomorrow.fajr, "first"));
    if (sunnah.lastThird) result.lastThird = roundToMinute(nightThird(core.maghrib, tomorrow.fajr, "last"));
    if (sunnah.duha) {
      const { start, end } = duhaWindow(core.sunrise, core.dhuhr);
      result.duhaStart = roundToMinute(start);
      result.duhaEnd = roundToMinute(end);
    }
  }

  return result;
}

function finalizeSunnah(raw: Date | null): Date {
  return raw ? roundToMinute(raw) : new Date(NaN);
}

function roundToMinute(date: Date): Date {
  return applyOffsetAndRound(date, 0, "nearest");
}

/** Convenience for callers that want a single-prayer accessor by name. */
export function prayerByName(result: PrayerTimesResult, name: TimeName): Date {
  return result[name];
}
