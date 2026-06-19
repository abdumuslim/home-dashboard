import { useState, useEffect, useMemo } from "react";
import { TZ } from "@/constants/thresholds";

// Prayer times are computed server-side by the prayer-engine (BaghdadYMA
// profile) and served at /api/prayer-times with machine-readable timestamps.
// This hook fetches them once per Baghdad civil day and ticks the live
// countdown locally — the client no longer re-implements the calculation, so
// it can never drift from the server / automations. Hijri date + Islamic events
// stay local (Intl-based, no extra dependency).

// Sorted by month/day — must stay in chronological order for lookup
const ISLAMIC_EVENTS = [
  // Muharram (1)
  { month: 1, day: 1, name: "Islamic New Year" },
  { month: 1, day: 10, name: "Day of Ashura" },
  // Rabi al-Awwal (3)
  { month: 3, day: 12, name: "Mawlid al-Nabi" },
  // Rajab (7)
  { month: 7, day: 10, name: "Battle of Tabuk" },
  { month: 7, day: 27, name: "Isra & Mi'raj" },
  // Sha'ban (8)
  { month: 8, day: 15, name: "Change of Qibla" },
  // Ramadan (9)
  { month: 9, day: 1, name: "Ramadan" },
  { month: 9, day: 17, name: "Battle of Badr" },
  { month: 9, day: 20, name: "Conquest of Mecca" },
  { month: 9, day: 27, name: "Laylat al-Qadr" },
  // Shawwal (10)
  { month: 10, day: 1, name: "Eid al-Fitr" },
  { month: 10, day: 7, name: "Battle of Uhud" },
  { month: 10, day: 10, name: "Battle of Hunayn" },
  { month: 10, day: 15, name: "Battle of Khandaq" },
  // Dhul Qi'dah (11)
  { month: 11, day: 1, name: "Treaty of Hudaybiyyah" },
  // Dhul Hijjah (12)
  { month: 12, day: 8, name: "Hajj Begins" },
  { month: 12, day: 9, name: "Day of Arafah" },
  { month: 12, day: 10, name: "Eid al-Adha" },
];

const HIJRI_MONTH_DAYS = [30, 29, 30, 29, 30, 29, 30, 29, 30, 29, 30, 29];

function hijriDayOfYear(month: number, day: number): number {
  let total = 0;
  for (let m = 1; m < month; m++) total += HIJRI_MONTH_DAYS[m - 1];
  return total + day;
}

const HIJRI_YEAR_DAYS = HIJRI_MONTH_DAYS.reduce((a, b) => a + b, 0);

export interface IslamicEvent {
  name: string;
  isToday: boolean;
  daysLeft: number;
}

function getNextIslamicEvent(month: number, day: number): IslamicEvent {
  const todayDoy = hijriDayOfYear(month, day);

  for (const ev of ISLAMIC_EVENTS) {
    const evDoy = hijriDayOfYear(ev.month, ev.day);
    if (evDoy === todayDoy) return { name: ev.name, isToday: true, daysLeft: 0 };
    if (evDoy > todayDoy) return { name: ev.name, isToday: false, daysLeft: evDoy - todayDoy };
  }

  // Wrap to first event of next year
  const first = ISLAMIC_EVENTS[0];
  const daysLeft = HIJRI_YEAR_DAYS - todayDoy + hijriDayOfYear(first.month, first.day);
  return { name: first.name, isToday: false, daysLeft };
}

export type PrayerName = "fajr" | "sunrise" | "dhuhr" | "asr" | "maghrib" | "isha";
export type ProximityLevel = "safe" | "warning" | "urgent" | "critical" | "imminent";

export interface PrayerInfo {
  name: PrayerName;
  label: string;
  time: Date;
  formattedTime: string;
  isPassed: boolean;
  isNext: boolean;
  countdown: string | null;
  proximity: ProximityLevel | null;
}

const PRAYER_KEYS: PrayerName[] = ["fajr", "sunrise", "dhuhr", "asr", "maghrib", "isha"];

interface ApiPrayer {
  name: string;
  label: string;
  timestamp: number;
}

interface FetchedPrayers {
  prayers: { name: PrayerName; label: string; time: Date }[];
  tomorrowFajr: Date;
}

// Module-level cache so the header + content instances of the hook share one
// fetch per civil day (and stay perfectly in sync).
let cache: { dateKey: string; data: FetchedPrayers } | null = null;
let inflight: { dateKey: string; promise: Promise<FetchedPrayers> } | null = null;

async function loadPrayers(dateKey: string): Promise<FetchedPrayers> {
  if (cache && cache.dateKey === dateKey) return cache.data;
  if (inflight && inflight.dateKey === dateKey) return inflight.promise;

  const promise = fetch("/api/prayer-times")
    .then((r) => {
      if (!r.ok) throw new Error(`prayer-times ${r.status}`);
      return r.json() as Promise<{ prayers: ApiPrayer[]; tomorrowFajr: number }>;
    })
    .then((json) => {
      const order = (name: string) => PRAYER_KEYS.indexOf(name as PrayerName);
      const data: FetchedPrayers = {
        prayers: json.prayers
          .filter((p) => order(p.name) !== -1)
          .sort((a, b) => order(a.name) - order(b.name))
          .map((p) => ({ name: p.name as PrayerName, label: p.label, time: new Date(p.timestamp) })),
        tomorrowFajr: new Date(json.tomorrowFajr),
      };
      cache = { dateKey, data };
      inflight = null;
      return data;
    })
    .catch((err) => {
      inflight = null;
      throw err;
    });

  inflight = { dateKey, promise };
  return promise;
}

function formatCountdown(diffMs: number): string {
  const totalSec = Math.max(0, Math.floor(diffMs / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function getProximity(diffMs: number): ProximityLevel {
  const min = diffMs / 60000;
  if (min <= 2) return "imminent";
  if (min <= 4) return "critical";
  if (min <= 7) return "urgent";
  if (min <= 15) return "warning";
  return "safe";
}

function getDateKey(nowMs: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(nowMs));
}

function formatPrayerTime(date: Date): string {
  return date.toLocaleTimeString("en-US", {
    timeZone: TZ,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

export function usePrayerTimes() {
  const [nowMs, setNowMs] = useState(Date.now());
  const [fetched, setFetched] = useState<FetchedPrayers | null>(() => cache?.data ?? null);

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const dateKey = getDateKey(nowMs);

  useEffect(() => {
    let cancelled = false;
    loadPrayers(dateKey)
      .then((data) => {
        if (!cancelled) setFetched(data);
      })
      .catch(() => {
        /* keep last good data; transient fetch errors are non-fatal */
      });
    return () => {
      cancelled = true;
    };
  }, [dateKey]);

  const hijriDate = useMemo(() => {
    return new Intl.DateTimeFormat("en-US-u-ca-islamic-umalqura", {
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: TZ,
    }).format(new Date(nowMs));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateKey]);

  const islamicEvent = useMemo(() => {
    const parts = new Intl.DateTimeFormat("en-US-u-ca-islamic-umalqura", {
      day: "numeric",
      month: "numeric",
      timeZone: TZ,
    }).formatToParts(new Date(nowMs));
    const month = Number(parts.find((p) => p.type === "month")?.value);
    const day = Number(parts.find((p) => p.type === "day")?.value);
    if (!month || !day) return null;
    return getNextIslamicEvent(month, day);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateKey]);

  const prayers: PrayerInfo[] = useMemo(() => {
    if (!fetched) return [];
    const nextIdx = fetched.prayers.findIndex((p) => p.time.getTime() > nowMs);
    return fetched.prayers.map((p, i) => {
      const diffMs = p.time.getTime() - nowMs;
      const isPassed = diffMs < 0;
      return {
        name: p.name,
        label: p.label,
        time: p.time,
        formattedTime: formatPrayerTime(p.time),
        isPassed,
        isNext: i === nextIdx,
        countdown: isPassed ? null : formatCountdown(diffMs),
        proximity: isPassed ? null : getProximity(diffMs),
      };
    });
  }, [fetched, nowMs]);

  // When all of today's prayers have passed, surface tomorrow's Fajr as next.
  let nextPrayer: PrayerInfo | null = null;
  if (fetched) {
    const upcoming = prayers.find((p) => p.isNext);
    if (upcoming) {
      nextPrayer = upcoming;
    } else {
      const diffMs = fetched.tomorrowFajr.getTime() - nowMs;
      nextPrayer = {
        name: "fajr",
        label: "Fajr",
        time: fetched.tomorrowFajr,
        formattedTime: formatPrayerTime(fetched.tomorrowFajr),
        isPassed: false,
        isNext: true,
        countdown: formatCountdown(diffMs),
        proximity: getProximity(diffMs),
      };
    }
  }

  return { prayers, hijriDate, nextPrayer, islamicEvent };
}
