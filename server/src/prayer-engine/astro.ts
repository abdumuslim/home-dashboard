// Thin wrappers over astronomy-engine — the only module that touches the
// ephemeris. Everything here returns plain JS Dates (UTC instants) or null
// (when the event does not occur, e.g. polar day/night).

import { createRequire } from "node:module";
import type { GeoCoordinates } from "./types.js";

// astronomy-engine ships dual CJS/ESM. Tooling (tsx, vitest) resolves it
// inconsistently across the two builds — the enum `Body` in particular fails as
// a named ESM import under tsx. Loading the CJS build via createRequire gives a
// single plain object that works identically under node, tsx, and vitest. The
// engine is server-only, so this Node API is always available.
const require = createRequire(import.meta.url);
const { Observer, Body, SearchRiseSet, SearchAltitude, SearchHourAngle, Equator } =
  require("astronomy-engine") as typeof import("astronomy-engine");
type Observer = InstanceType<typeof Observer>;

export const DEG = Math.PI / 180;

export interface SunContext {
  obs: Observer;
  /** UTC instant of local midnight of the target civil day — search start. */
  anchor: Date;
  /** Observer elevation in metres (drives horizon dip + refraction in rise/set). */
  elevation: number;
}

export function makeSunContext(coords: GeoCoordinates, elevation: number, anchor: Date): SunContext {
  return { obs: new Observer(coords.latitude, coords.longitude, elevation), anchor, elevation };
}

/** Solar transit (upper culmination) = Dhuhr basis. Always defined. */
export function transit(ctx: SunContext): Date {
  return SearchHourAngle(Body.Sun, ctx.obs, 0, ctx.anchor, +1).time.date;
}

/**
 * Rise (direction +1) or set (-1) of the sun's upper limb, with the observer's
 * elevation applied (astronomy-engine adds horizon dip + refraction internally).
 * Returns null at high latitudes when the event does not occur.
 */
export function riseSet(ctx: SunContext, direction: 1 | -1, from?: Date): Date | null {
  const t = SearchRiseSet(Body.Sun, ctx.obs, direction, from ?? ctx.anchor, 1, ctx.elevation);
  return t ? t.date : null;
}

/**
 * Time the sun's CENTER crosses a given depression angle below the horizon.
 * direction +1 = ascending (dawn side: Fajr/Imsak), -1 = descending (dusk side:
 * Isha, Jafari Maghrib). Returns null when the angle is never reached.
 */
export function depressionEvent(
  ctx: SunContext,
  direction: 1 | -1,
  angleDeg: number,
  from?: Date,
): Date | null {
  const t = SearchAltitude(Body.Sun, ctx.obs, direction, from ?? ctx.anchor, 1, -angleDeg);
  return t ? t.date : null;
}

/**
 * Time the sun's center descends to a given POSITIVE altitude after `from`
 * (used for Asr, where the target altitude is above the horizon).
 */
export function descendToAltitude(ctx: SunContext, altitudeDeg: number, from: Date): Date | null {
  const t = SearchAltitude(Body.Sun, ctx.obs, -1, from, 1, altitudeDeg);
  return t ? t.date : null;
}

/** Apparent solar declination (degrees) at an instant, topocentric. */
export function sunDeclination(ctx: SunContext, at: Date): number {
  return Equator(Body.Sun, at, ctx.obs, true, true).dec;
}
