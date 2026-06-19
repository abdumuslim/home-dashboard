import { describe, it, expect } from "vitest";
import { calculatePrayerTimes } from "./index.js";
import type { PrayerConfig, TimeName } from "./types.js";

const BAGHDAD = { latitude: 33.321502, longitude: 44.358335 };
const TZ = "Asia/Baghdad";

function baghdadMinute(d: Date): number {
  const map: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(d)) {
    if (p.type !== "literal") map[p.type] = p.value;
  }
  return Number(map.hour) * 60 + Number(map.minute);
}

function tableMinute(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function dateFor(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  // Any instant inside the Baghdad civil day; engine re-anchors to local midnight.
  return new Date(Date.UTC(y, m - 1, d, 9, 0, 0));
}

describe("BaghdadYMA profile vs official جمعية الشبان المسلمين calendar", () => {
  // [date, fajr, sunrise, dhuhr, asr, maghrib, isha] — 24h, from the printed table.
  const ROWS: ReadonlyArray<readonly [string, string, string, string, string, string, string]> = [
    ["2026-01-20", "05:38", "07:04", "12:18", "15:06", "17:25", "18:44"],
    ["2026-02-18", "05:20", "06:42", "12:21", "15:28", "17:53", "19:08"],
    ["2026-03-20", "04:43", "06:05", "12:15", "15:40", "18:17", "19:32"],
    ["2026-04-19", "04:00", "05:27", "12:07", "15:44", "18:39", "19:59"],
    ["2026-05-18", "03:24", "04:59", "12:04", "15:45", "19:01", "20:29"],
    ["2026-06-21", "03:10", "04:52", "12:09", "15:51", "19:18", "20:52"],
    ["2026-07-01", "03:14", "04:56", "12:11", "15:53", "19:19", "20:52"],
    ["2026-07-16", "03:25", "05:04", "12:14", "15:55", "19:15", "20:45"],
  ];
  const ORDER: TimeName[] = ["fajr", "sunrise", "dhuhr", "asr", "maghrib", "isha"];
  const config: PrayerConfig = { method: "BaghdadYMA", timezone: TZ };

  it.each(ROWS)("%s — all six prayers within ±1 min", (date, ...expected) => {
    const t = calculatePrayerTimes(BAGHDAD, dateFor(date), config);
    ORDER.forEach((name, i) => {
      const diff = Math.abs(baghdadMinute(t[name]) - tableMinute(expected[i]));
      expect(diff, `${date} ${name}`).toBeLessThanOrEqual(1);
    });
  });

  // Angle-sensitive prayers exact on dates the calibration confirmed zero-residual,
  // at both declination extremes (locks 18°/17°/Standard). A wrong angle shifts
  // Fajr/Isha by minutes and would fail.
  it.each([
    ["2026-02-18", "05:20", "17:53", "19:08"],
    ["2026-06-21", "03:10", "19:18", "20:52"],
  ] as const)("%s — fajr/maghrib/isha exact", (date, fajr, maghrib, isha) => {
    const t = calculatePrayerTimes(BAGHDAD, dateFor(date), config);
    expect(baghdadMinute(t.fajr)).toBe(tableMinute(fajr));
    expect(baghdadMinute(t.maghrib)).toBe(tableMinute(maghrib));
    expect(baghdadMinute(t.isha)).toBe(tableMinute(isha));
  });
});

describe("engine behaviour", () => {
  const date = dateFor("2026-01-20");

  it("Hanafi Asr is meaningfully later than Standard Asr", () => {
    const std = calculatePrayerTimes(BAGHDAD, date, { method: "MWL", asr: "Standard", timezone: TZ });
    const han = calculatePrayerTimes(BAGHDAD, date, { method: "MWL", asr: "Hanafi", timezone: TZ });
    expect(han.asr.getTime()).toBeGreaterThan(std.asr.getTime() + 30 * 60_000);
  });

  it("higher elevation moves sunrise earlier and maghrib later", () => {
    const sea = calculatePrayerTimes(BAGHDAD, date, { method: "MWL", elevation: false, rounding: "none", timezone: TZ });
    const high = calculatePrayerTimes(BAGHDAD, date, { method: "MWL", elevation: 2000, rounding: "none", timezone: TZ });
    expect(high.sunrise.getTime()).toBeLessThan(sea.sunrise.getTime());
    expect(high.maghrib.getTime()).toBeGreaterThan(sea.maghrib.getTime());
  });

  it("Umm al-Qura Isha is a 90-minute interval after Maghrib", () => {
    const t = calculatePrayerTimes(BAGHDAD, date, { method: "UmmAlQura", rounding: "none", timezone: TZ });
    const gapMin = (t.isha.getTime() - t.maghrib.getTime()) / 60_000;
    expect(gapMin).toBeGreaterThanOrEqual(89);
    expect(gapMin).toBeLessThanOrEqual(91);
  });

  it("Jafari Maghrib falls after visual sunset (MWL maghrib)", () => {
    const mwl = calculatePrayerTimes(BAGHDAD, date, { method: "MWL", rounding: "none", timezone: TZ });
    const jafari = calculatePrayerTimes(BAGHDAD, date, { method: "Jafari", rounding: "none", timezone: TZ });
    expect(jafari.maghrib.getTime()).toBeGreaterThan(mwl.maghrib.getTime());
  });

  it("high latitudes: 18° twilight is unreachable, fallback rule rescues it", () => {
    const london = { latitude: 51.5074, longitude: -0.1278 };
    const solstice = dateFor("2026-06-21");
    const none = calculatePrayerTimes(london, solstice, { method: "MWL", highLatitudeRule: "None", timezone: "Europe/London" });
    expect(Number.isNaN(none.fajr.getTime())).toBe(true);
    const rescued = calculatePrayerTimes(london, solstice, { method: "MWL", highLatitudeRule: "AngleBased", timezone: "Europe/London" });
    expect(Number.isNaN(rescued.fajr.getTime())).toBe(false);
    expect(rescued.fajr.getTime()).toBeLessThan(rescued.sunrise.getTime());
  });

  it("opt-in Sunnah times: imsak, midnight, last third, duha", () => {
    const t = calculatePrayerTimes(BAGHDAD, date, {
      method: "BaghdadYMA",
      timezone: TZ,
      sunnah: { imsak: { minutes: 7 }, midnight: "Standard", lastThird: true, firstThird: true, duha: true },
    });
    expect((t.fajr.getTime() - t.imsak!.getTime()) / 60_000).toBe(7);
    expect(t.lastThird!.getTime()).toBeGreaterThan(t.firstThird!.getTime());
    expect(t.duhaStart!.getTime()).toBeGreaterThan(t.sunrise.getTime());
    expect(t.duhaEnd!.getTime()).toBeLessThan(t.dhuhr.getTime());
    expect(t.midnight).toBeInstanceOf(Date);
  });
});
