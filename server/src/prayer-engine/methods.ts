// Calculation-method presets. Angles are solar depression angles (degrees);
// `{ minutes }` Isha is a fixed interval after Maghrib.
//
// Sources: praytimes.org/docs/methods, api.aladhan.com/v1/methods,
// fiqhcouncil.org. The "BaghdadYMA" profile (جمعية الشبان المسلمين / official
// Iraqi Sunni Endowment convention) is MWL angles calibrated to that printed
// calendar — see calibrate.ts and prayer-engine.test.ts.

import type { Method } from "./types.js";

export const METHODS: Record<string, Method> = {
  MWL: { name: "Muslim World League", params: { fajr: 18, isha: 17 } },
  ISNA: { name: "Islamic Society of North America", params: { fajr: 15, isha: 15 } },
  Egyptian: { name: "Egyptian General Authority of Survey", params: { fajr: 19.5, isha: 17.5 } },
  UmmAlQura: { name: "Umm al-Qura, Makkah", params: { fajr: 18.5, isha: { minutes: 90 } } },
  Karachi: { name: "University of Islamic Sciences, Karachi", params: { fajr: 18, isha: 18 } },
  Dubai: { name: "Dubai", params: { fajr: 18.2, isha: 18.2 } },
  Qatar: { name: "Qatar", params: { fajr: 18, isha: { minutes: 90 } } },
  Kuwait: { name: "Kuwait", params: { fajr: 18, isha: 17.5 } },
  Singapore: { name: "Singapore (MUIS)", params: { fajr: 20, isha: 18 } },
  Diyanet: { name: "Turkey (Diyanet)", params: { fajr: 18, isha: 17 } },
  Tehran: { name: "Tehran, Institute of Geophysics", params: { fajr: 17.7, isha: 14, maghribAngle: 4.5 } },
  Jafari: { name: "Shia Ithna-Ashari (Jafari, Leva)", params: { fajr: 16, isha: 14, maghribAngle: 4 } },

  // Baghdad — جمعية الشبان المسلمين / ديوان الوقف السني. MWL angles (18/17),
  // Standard Asr, observer at Baghdad's ~34 m elevation. Per-prayer offsets +
  // rounding below are calibrated to the printed 2026 calendar (calibrate.ts):
  // max error 1 min, mean 0.12 over 38 dates spanning the full seasonal range —
  // every residual in {-1,0,+1}. With elevation modelled, sunrise/fajr/isha need
  // zero offset; only dhuhr/asr/maghrib carry small conventional offsets. Fajr
  // floors to the minute (matches the printed table most closely). Verified by
  // prayer-engine.test.ts.
  BaghdadYMA: {
    name: "Baghdad — Young Muslims Association (Iraqi Sunni)",
    params: { fajr: 18, isha: 17 },
    asr: "Standard",
    elevationMeters: 34,
    adjustments: { dhuhr: 5, asr: 3, maghrib: 2 },
    rounding: { fajr: "down" },
  },
};

export type MethodName = keyof typeof METHODS;

export function resolveMethod(method: string | Method["params"] | undefined): Method {
  if (method == null) return METHODS.MWL;
  if (typeof method === "string") {
    const found = METHODS[method];
    if (!found) throw new Error(`Unknown prayer method: ${method}`);
    return found;
  }
  return { name: "custom", params: method };
}
