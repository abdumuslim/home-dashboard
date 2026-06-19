// Asr time from the shadow-ratio rule.
import { DEG } from "./astro.js";

/**
 * The sun's altitude (degrees, above horizon) at which Asr begins.
 *
 *   asrAltitude = arccot( shadowFactor + tan(|latitude − declination|) )
 *
 * shadowFactor = 1 for Standard (Shafi/Maliki/Hanbali), 2 for Hanafi.
 * Caller then searches for when the sun descends to this altitude after Dhuhr.
 */
export function asrAltitude(latitudeDeg: number, declinationDeg: number, shadowFactor: number): number {
  const x = shadowFactor + Math.tan(Math.abs(latitudeDeg - declinationDeg) * DEG);
  return Math.atan(1 / x) / DEG;
}

export function shadowFactorFor(madhab: "Standard" | "Hanafi"): number {
  return madhab === "Hanafi" ? 2 : 1;
}
