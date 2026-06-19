// One-off calibration: find the constant per-prayer minute offset + rounding
// rule that makes the astronomy-engine output (MWL 18°/17°, Standard Asr,
// Baghdad @ ~34 m) reproduce the official جمعية الشبان المسلمين Baghdad calendar.
// Angles are fixed (not swept) — only constant offsets/rounding are fit, which
// is the anti-overfitting constraint. Run: `npx tsx src/prayer-engine/calibrate.ts`.

import {
  makeSunContext,
  riseSet,
  transit,
  depressionEvent,
  descendToAltitude,
  sunDeclination,
} from "./astro.js";
import { asrAltitude, shadowFactorFor } from "./asr.js";
import { zonedMidnightUtc } from "./timezone.js";

const TZ = "Asia/Baghdad";
const COORDS = { latitude: 33.321502, longitude: 44.358335 };
const ELEVATION = 34;
const FAJR_ANGLE = 18;
const ISHA_ANGLE = 17;

type Prayer = "fajr" | "sunrise" | "dhuhr" | "asr" | "maghrib" | "isha";
const PRAYERS: Prayer[] = ["fajr", "sunrise", "dhuhr", "asr", "maghrib", "isha"];

// Official table (24-hour). [date, fajr, sunrise, dhuhr, asr, maghrib, isha]
const TABLE: ReadonlyArray<readonly [string, string, string, string, string, string, string]> = [
  ["2026-01-20", "05:38", "07:04", "12:18", "15:06", "17:25", "18:44"],
  ["2026-01-25", "05:37", "07:02", "12:20", "15:10", "17:30", "18:48"],
  ["2026-01-30", "05:34", "06:59", "12:21", "15:14", "17:35", "18:53"],
  ["2026-02-04", "05:32", "06:55", "12:21", "15:18", "17:40", "18:57"],
  ["2026-02-09", "05:28", "06:51", "12:22", "15:22", "17:45", "19:01"],
  ["2026-02-14", "05:24", "06:46", "12:22", "15:25", "17:49", "19:05"],
  ["2026-02-18", "05:20", "06:42", "12:21", "15:28", "17:53", "19:08"],
  ["2026-02-23", "05:15", "06:37", "12:21", "15:31", "17:57", "19:12"],
  ["2026-02-28", "05:09", "06:31", "12:20", "15:33", "18:01", "19:16"],
  ["2026-03-05", "05:03", "06:25", "12:19", "15:36", "18:05", "19:20"],
  ["2026-03-11", "04:56", "06:17", "12:17", "15:38", "18:10", "19:25"],
  ["2026-03-15", "04:50", "06:12", "12:16", "15:39", "18:13", "19:28"],
  ["2026-03-19", "04:45", "06:06", "12:15", "15:40", "18:17", "19:31"],
  ["2026-03-24", "04:38", "06:00", "12:14", "15:41", "18:20", "19:35"],
  ["2026-03-29", "04:31", "05:53", "12:12", "15:42", "18:24", "19:40"],
  ["2026-04-03", "04:23", "05:47", "12:11", "15:43", "18:27", "19:44"],
  ["2026-04-08", "04:16", "05:40", "12:09", "15:43", "18:31", "19:48"],
  ["2026-04-13", "04:08", "05:34", "12:08", "15:44", "18:35", "19:53"],
  ["2026-04-18", "04:01", "05:28", "12:07", "15:44", "18:38", "19:58"],
  ["2026-04-23", "03:54", "05:22", "12:06", "15:44", "18:42", "20:03"],
  ["2026-04-28", "03:47", "05:17", "12:05", "15:44", "18:46", "20:08"],
  ["2026-05-03", "03:41", "05:12", "12:04", "15:45", "18:50", "20:13"],
  ["2026-05-08", "03:34", "05:07", "12:04", "15:45", "18:53", "20:18"],
  ["2026-05-13", "03:29", "05:03", "12:04", "15:45", "18:57", "20:23"],
  ["2026-05-17", "03:25", "05:00", "12:04", "15:45", "19:00", "20:27"],
  ["2026-05-18", "03:24", "04:59", "12:04", "15:45", "19:01", "20:29"],
  ["2026-05-23", "03:19", "04:57", "12:04", "15:46", "19:04", "20:33"],
  ["2026-05-28", "03:16", "04:54", "12:05", "15:47", "19:07", "20:38"],
  ["2026-06-01", "03:13", "04:53", "12:05", "15:47", "19:09", "20:41"],
  ["2026-06-06", "03:11", "04:52", "12:06", "15:48", "19:13", "20:45"],
  ["2026-06-11", "03:10", "04:51", "12:07", "15:49", "19:15", "20:47"],
  ["2026-06-16", "03:10", "04:52", "12:08", "15:50", "19:17", "20:50"],
  ["2026-06-21", "03:10", "04:52", "12:09", "15:51", "19:18", "20:52"],
  ["2026-06-26", "03:12", "04:54", "12:10", "15:52", "19:19", "20:52"],
  ["2026-07-01", "03:14", "04:56", "12:11", "15:53", "19:19", "20:52"],
  ["2026-07-06", "03:17", "04:58", "12:12", "15:54", "19:18", "20:50"],
  ["2026-07-11", "03:21", "05:01", "12:13", "15:55", "19:17", "20:48"],
  ["2026-07-16", "03:25", "05:04", "12:14", "15:55", "19:15", "20:45"],
];

const RULES = ["down", "nearest", "up"] as const;
type Rule = (typeof RULES)[number];

function toMinute(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/** Raw seconds-of-day in Baghdad for an instant (Baghdad is UTC+3, fixed). */
function baghdadSecondsOfDay(instant: Date): number {
  const map: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant)) {
    if (p.type !== "literal") map[p.type] = p.value;
  }
  return Number(map.hour) * 3600 + Number(map.minute) * 60 + Number(map.second);
}

function rawSeconds(dateStr: string): Record<Prayer, number> {
  const [y, m, d] = dateStr.split("-").map(Number);
  const anchor = zonedMidnightUtc(new Date(Date.UTC(y, m - 1, d, 9, 0, 0)), TZ);
  const ctx = makeSunContext(COORDS, ELEVATION, anchor);
  const sunrise = riseSet(ctx, +1)!;
  const maghrib = riseSet(ctx, -1)!;
  const dhuhr = transit(ctx);
  const dec = sunDeclination(ctx, dhuhr);
  const asr = descendToAltitude(ctx, asrAltitude(COORDS.latitude, dec, shadowFactorFor("Standard")), dhuhr)!;
  const fajr = depressionEvent(ctx, +1, FAJR_ANGLE)!;
  const isha = depressionEvent(ctx, -1, ISHA_ANGLE, maghrib)!;
  return {
    fajr: baghdadSecondsOfDay(fajr),
    sunrise: baghdadSecondsOfDay(sunrise),
    dhuhr: baghdadSecondsOfDay(dhuhr),
    asr: baghdadSecondsOfDay(asr),
    maghrib: baghdadSecondsOfDay(maghrib),
    isha: baghdadSecondsOfDay(isha),
  };
}

function predictMinute(rawSec: number, offsetMin: number, rule: Rule): number {
  const t = rawSec + offsetMin * 60;
  const minutes = t / 60;
  if (rule === "down") return Math.floor(minutes);
  if (rule === "up") return Math.ceil(minutes);
  return Math.round(minutes);
}

function main(): void {
  const raws = TABLE.map(([date]) => rawSeconds(date));
  const fit: Record<string, { offset: number; rule: Rule; maxErr: number; meanErr: number }> = {};

  for (const prayer of PRAYERS) {
    let best = { offset: 0, rule: "nearest" as Rule, maxErr: Infinity, meanErr: Infinity };
    for (const rule of RULES) {
      for (let offset = -12; offset <= 12; offset++) {
        let maxErr = 0;
        let sumErr = 0;
        TABLE.forEach((row, i) => {
          const idx = PRAYERS.indexOf(prayer) + 1;
          const target = toMinute(row[idx] as string);
          const pred = predictMinute(raws[i][prayer], offset, rule);
          const err = Math.abs(pred - target);
          maxErr = Math.max(maxErr, err);
          sumErr += err;
        });
        const meanErr = sumErr / TABLE.length;
        if (maxErr < best.maxErr || (maxErr === best.maxErr && meanErr < best.meanErr) ||
            (maxErr === best.maxErr && meanErr === best.meanErr && Math.abs(offset) < Math.abs(best.offset))) {
          best = { offset, rule, maxErr, meanErr };
        }
      }
    }
    fit[prayer] = best;
  }

  console.log("\n=== BaghdadYMA best-fit (angles fixed 18°/17°, Standard Asr, elev 34m) ===");
  let overallMax = 0;
  let overallSum = 0;
  let overallN = 0;
  for (const prayer of PRAYERS) {
    const f = fit[prayer];
    console.log(
      `${prayer.padEnd(8)} offset=${String(f.offset).padStart(3)}  rule=${f.rule.padEnd(7)}  maxErr=${f.maxErr}  meanErr=${f.meanErr.toFixed(3)}`,
    );
    overallMax = Math.max(overallMax, f.maxErr);
    overallSum += f.meanErr * TABLE.length;
    overallN += TABLE.length;
  }
  console.log(`OVERALL  maxErr=${overallMax}  meanErr=${(overallSum / overallN).toFixed(3)}  (n=${TABLE.length} dates)`);

  // Per-date residual dump for dates exceeding 0 error anywhere.
  console.log("\n=== residuals (pred − table), only non-zero rows ===");
  TABLE.forEach((row, i) => {
    const errs = PRAYERS.map((p, j) => {
      const target = toMinute(row[j + 1] as string);
      const pred = predictMinute(raws[i][p], fit[p].offset, fit[p].rule);
      return pred - target;
    });
    if (errs.some((e) => e !== 0)) {
      console.log(`${row[0]}  ` + PRAYERS.map((p, j) => `${p}:${errs[j] >= 0 ? "+" : ""}${errs[j]}`).join("  "));
    }
  });

  console.log("\n=== paste into methods.ts BaghdadYMA ===");
  const adj = PRAYERS.filter((p) => fit[p].offset !== 0).map((p) => `${p}: ${fit[p].offset}`).join(", ");
  console.log(`adjustments: { ${adj} },`);
  const allSameRule = PRAYERS.every((p) => fit[p].rule === fit.fajr.rule);
  if (allSameRule) {
    console.log(`rounding: "${fit.fajr.rule}",`);
  } else {
    console.log(`rounding: { ${PRAYERS.map((p) => `${p}: "${fit[p].rule}"`).join(", ")} },`);
  }
}

main();
