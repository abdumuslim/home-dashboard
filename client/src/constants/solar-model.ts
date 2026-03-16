/** Theoretical clear-sky GHI from solar geometry (Haurwitz model). */

const LAT = 33.3215;
const LON = 44.3583;
const DEG = Math.PI / 180;

export interface ClearSkyResult {
  clearSkyGHI: number;
  solarElevation: number;
  isNight: boolean;
}

export function getClearSky(date: Date = new Date()): ClearSkyResult {
  const doy =
    Math.floor(
      (date.getTime() - new Date(date.getFullYear(), 0, 0).getTime()) /
        86400000,
    );

  // Solar declination (Spencer, 1971)
  const B = ((doy - 1) * 360) / 365;
  const declination =
    (23.45 * Math.sin(((360 / 365) * (doy + 284)) * DEG)) * DEG;

  // Equation of time (minutes)
  const Br = B * DEG;
  const EoT =
    229.18 *
    (0.000075 +
      0.001868 * Math.cos(Br) -
      0.032077 * Math.sin(Br) -
      0.014615 * Math.cos(2 * Br) -
      0.04089 * Math.sin(2 * Br));

  // Solar hour angle
  const utcHours = date.getUTCHours() + date.getUTCMinutes() / 60;
  const solarTime = utcHours + LON / 15 + EoT / 60;
  const hourAngle = (solarTime - 12) * 15 * DEG;

  // Solar elevation
  const latRad = LAT * DEG;
  const sinElev =
    Math.sin(latRad) * Math.sin(declination) +
    Math.cos(latRad) * Math.cos(declination) * Math.cos(hourAngle);
  const elevation = Math.asin(Math.max(-1, Math.min(1, sinElev))) / DEG;

  if (elevation <= 0) {
    return { clearSkyGHI: 0, solarElevation: elevation, isNight: true };
  }

  // Haurwitz clear-sky model (calibrated for Baghdad's dusty atmosphere)
  const zenith = (90 - elevation) * DEG;
  const cosZ = Math.cos(zenith);
  const ghi = 1250 * cosZ * Math.exp(-0.43 / cosZ);

  return {
    clearSkyGHI: Math.max(0, ghi),
    solarElevation: elevation,
    isNight: false,
  };
}
