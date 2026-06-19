// Public types for the prayer-engine. Pure data — no runtime dependencies.

/** The six canonical daily times (sunrise included for completeness). */
export type TimeName = "fajr" | "sunrise" | "dhuhr" | "asr" | "maghrib" | "isha";

/** Optional, opt-in Sunnah/secondary times. */
export type SunnahName =
  | "imsak"
  | "midnight"
  | "firstThird"
  | "lastThird"
  | "duhaStart"
  | "duhaEnd";

export interface GeoCoordinates {
  /** Degrees north, -90..90. */
  latitude: number;
  /** Degrees east, -180..180. */
  longitude: number;
  /** Metres above mean sea level. Default 0 (sea level). */
  elevation?: number;
}

/**
 * A twilight parameter: either a solar depression ANGLE in degrees (e.g. 18),
 * or a fixed INTERVAL in minutes (e.g. `{ minutes: 90 }` — Umm al-Qura / Qatar Isha).
 */
export type AngleOrInterval = number | { minutes: number };

export interface MethodParams {
  /** Fajr: depression angle (deg) or minutes before sunrise. */
  fajr: AngleOrInterval;
  /** Isha: depression angle (deg) or minutes after maghrib. */
  isha: AngleOrInterval;
  /**
   * Maghrib depression angle (deg). Omit for the mainstream rule
   * (maghrib = visual sunset, top-of-disk + refraction). Set e.g. 4 for the
   * Jafari/Shia convention (maghrib a few degrees after sunset).
   */
  maghribAngle?: number;
}

export type AsrMadhab = "Standard" | "Hanafi";

/**
 * What to do when the sun never reaches a twilight angle (high latitudes,
 * summer). "None" = leave the angle search result (may be an Invalid Date at
 * extreme latitudes). The others approximate from the night length.
 */
export type HighLatitudeRule = "None" | "NightMiddle" | "OneSeventh" | "AngleBased";

export type RoundingRule = "none" | "nearest" | "up" | "down";

export type RoundingConfig = RoundingRule | Partial<Record<TimeName, RoundingRule>>;

export interface SunnahConfig {
  /** Imsak: depression angle (deg) or minutes before Fajr (Ramadan fasting start). */
  imsak?: AngleOrInterval;
  /** Islamic midnight: Standard = ½(sunset→next sunrise); Jafari = ½(sunset→next fajr). */
  midnight?: "Standard" | "Jafari";
  /** First third of the night (sunset → 1/3 of the night). */
  firstThird?: boolean;
  /** Last third of the night (qiyam/tahajjud window start). */
  lastThird?: boolean;
  /** Duha window: sunrise+15min → dhuhr-15min. */
  duha?: boolean;
}

/** A named calculation profile (preset). */
export interface Method {
  /** Human label. */
  name: string;
  params: MethodParams;
  /** Default Asr madhab for this profile. */
  asr?: AsrMadhab;
  /** Default per-prayer minute offsets baked into the profile. */
  adjustments?: Partial<Record<TimeName, number>>;
  /** Default rounding for this profile. */
  rounding?: RoundingConfig;
  /** Default observer elevation (m) for this profile (e.g. Baghdad ≈ 34). */
  elevationMeters?: number;
  /** Default high-latitude rule for this profile. */
  highLatitudeRule?: HighLatitudeRule;
}

export interface PrayerConfig {
  /** A preset name (see methods.ts) or inline params. Default: "MWL". */
  method?: string | MethodParams;
  /** Asr madhab override. */
  asr?: AsrMadhab;
  /** High-latitude rule override. */
  highLatitudeRule?: HighLatitudeRule;
  /**
   * Elevation handling: `false` = sea level; a number = explicit metres;
   * `true`/omitted = use coords.elevation (falling back to the method's default).
   */
  elevation?: boolean | number;
  /** IANA timezone used to anchor "which civil day". Default "UTC". */
  timezone?: string;
  /** Per-prayer minute offsets, merged over (and overriding) the method's. */
  adjustments?: Partial<Record<TimeName, number>>;
  /** Rounding override (single rule or per-prayer). */
  rounding?: RoundingConfig;
  /** Opt-in Sunnah/secondary times. */
  sunnah?: SunnahConfig;
}

export interface PrayerTimesResult {
  fajr: Date;
  sunrise: Date;
  dhuhr: Date;
  asr: Date;
  maghrib: Date;
  isha: Date;
  imsak?: Date;
  midnight?: Date;
  firstThird?: Date;
  lastThird?: Date;
  duhaStart?: Date;
  duhaEnd?: Date;
}
