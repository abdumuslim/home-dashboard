# @home/prayer-engine

A high-precision, **GPS-portable** Islamic prayer-time engine. Pure TypeScript,
framework-agnostic, one dependency (`astronomy-engine`). Give it coordinates, a
date, and a method profile — get accurate prayer times for **any location on
Earth**, elevation-aware, with high-latitude handling and opt-in Sunnah times.

> Self-contained and lift-and-shift: copy this folder into another project (it
> only needs `astronomy-engine`), or publish it to npm. It currently lives under
> `server/src/` so the dashboard's existing `tsc`/Docker build compiles it with
> zero extra wiring. **Why under `server/src/` and not a repo-root package:** the
> Dockerfile builds `server/` and `client/` as fully independent stages (each
> copies only its own dir, no repo-root `package.json`), so a shared root module
> consumed by both would force a Docker/workspace rework. Keeping the engine
> server-only + making the client API-driven avoids that. Don't "promote" it to a
> root package without reworking the per-app Docker stages.

## Why astronomy-engine

The astronomical core is [`astronomy-engine`](https://github.com/cosinekitty/astronomy)
(Don Cross, MIT) — ~1 arcminute solar accuracy validated against NOVAS/JPL
Horizons, with **observer-elevation-aware** rise/set (horizon dip + refraction
built in) and exact event-search primitives. That is more accurate, and more
globally correct, than the fixed-angle approximations most prayer apps use.

## Usage

```ts
import { calculatePrayerTimes } from "./index.js";

const times = calculatePrayerTimes(
  { latitude: 33.321502, longitude: 44.358335 }, // Baghdad
  new Date(),
  { method: "BaghdadYMA", timezone: "Asia/Baghdad" },
);
// times.fajr … times.isha are absolute Date instants (UTC). Format to a
// timezone for display, e.g. with Intl.DateTimeFormat({ timeZone }).
```

All returned instants are absolute (UTC). The `timezone` only selects *which
civil day* to compute and is correct at any longitude.

## Configuration (`PrayerConfig`)

| Field | Default | Notes |
|---|---|---|
| `method` | `"MWL"` | A preset name (see below) or inline `{ fajr, isha, maghribAngle? }`. |
| `asr` | `"Standard"` | `"Standard"` (Shafi/Maliki/Hanbali) or `"Hanafi"`. |
| `highLatitudeRule` | `"None"` | `"NightMiddle"` / `"OneSeventh"` / `"AngleBased"` rescue Fajr/Isha where the sun never reaches the twilight angle. |
| `elevation` | use coords/profile | `false` = sea level; a number = metres; `true`/omitted = `coords.elevation` (then the profile default). |
| `timezone` | `"UTC"` | IANA tz; anchors the civil day. |
| `adjustments` | profile's | Per-prayer minute offsets, merged over the method's. |
| `rounding` | profile's / `"nearest"` | `"none"`/`"nearest"`/`"up"`/`"down"`, single or per-prayer. |
| `sunnah` | — | Opt-in: `{ imsak, midnight, firstThird, lastThird, duha }`. |

### Method presets

`MWL`, `ISNA`, `Egyptian`, `UmmAlQura`, `Karachi`, `Dubai`, `Qatar`, `Kuwait`,
`Singapore`, `Diyanet`, `Tehran`, `Jafari`, and **`BaghdadYMA`**.

`BaghdadYMA` is the جمعية الشبان المسلمين / official Iraqi Sunni Endowment
profile: MWL angles (Fajr 18°, Isha 17°), Standard Asr, observer at Baghdad's
~34 m elevation, plus per-prayer offsets/rounding **calibrated to the printed
2026 calendar** — max error 1 minute, mean ≈ 0.12 over 38 dates spanning the
full seasonal range (see `calibrate.ts`, verified by `prayer-engine.test.ts`).

## Optional / Sunnah times

Opt-in via `config.sunnah`. Computed only when requested:

- `imsak` — angle or minutes before Fajr (Ramadan fasting start).
- `midnight` — `"Standard"` ½(sunset→next sunrise) or `"Jafari"` ½(sunset→next fajr).
- `firstThird` / `lastThird` — thirds of the qiyam night (maghrib → next fajr).
- `duha` — `duhaStart` = sunrise + 15 min, `duhaEnd` = dhuhr − 15 min.

## Notes

- `astronomy-engine` is loaded via `createRequire` because its dual CJS/ESM
  package resolves inconsistently across tooling (tsx/vitest) — the CJS build
  works uniformly. This makes the engine Node-only; it is not browser-ready
  as-is.
- At extreme latitudes with `highLatitudeRule: "None"`, an unreachable twilight
  angle yields an `Invalid Date` for that prayer — choose a fallback rule there.
