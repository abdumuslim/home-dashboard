import { useState, useEffect, useMemo } from "react";
import {
  Coordinates,
  CalculationMethod,
  PrayerTimes,
  Prayer,
} from "adhan";
import { TZ } from "@/constants/thresholds";

const BAGHDAD = new Coordinates(33.321502, 44.358335);
const PARAMS = CalculationMethod.Dubai();
PARAMS.adjustments = { fajr: 0, sunrise: 2, dhuhr: 2, asr: 0, maghrib: 0, isha: -6 };

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

const PRAYER_ORDER: { key: PrayerName; label: string }[] = [
  { key: "fajr", label: "Fajr" },
  { key: "sunrise", label: "Sunrise" },
  { key: "dhuhr", label: "Dhuhr" },
  { key: "asr", label: "Asr" },
  { key: "maghrib", label: "Maghrib" },
  { key: "isha", label: "Isha" },
];

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

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const dateKey = getDateKey(nowMs);

  const { todayPrayers, tomorrowPrayers } = useMemo(() => {
    const today = new Date(nowMs);
    const tomorrow = new Date(nowMs);
    tomorrow.setDate(tomorrow.getDate() + 1);
    return {
      todayPrayers: new PrayerTimes(BAGHDAD, today, PARAMS),
      tomorrowPrayers: new PrayerTimes(BAGHDAD, tomorrow, PARAMS),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const now = new Date(nowMs);
  const nextPrayerEnum = todayPrayers.nextPrayer(now);
  const allPassed = nextPrayerEnum === Prayer.None;

  const prayers: PrayerInfo[] = PRAYER_ORDER.map(({ key, label }) => {
    const time = todayPrayers[key] as Date;
    const diffMs = time.getTime() - nowMs;
    const isPassed = diffMs < 0;
    const isNext = !allPassed && nextPrayerEnum === key;

    return {
      name: key,
      label,
      time,
      formattedTime: formatPrayerTime(time),
      isPassed,
      isNext,
      countdown: isPassed ? null : formatCountdown(diffMs),
      proximity: isPassed ? null : getProximity(diffMs),
    };
  });

  // When all today's prayers have passed, provide tomorrow's Fajr as next
  let nextPrayer: PrayerInfo | null = null;
  if (allPassed) {
    const fajrTime = tomorrowPrayers.fajr;
    const diffMs = fajrTime.getTime() - nowMs;
    nextPrayer = {
      name: "fajr",
      label: "Fajr",
      time: fajrTime,
      formattedTime: formatPrayerTime(fajrTime),
      isPassed: false,
      isNext: true,
      countdown: formatCountdown(diffMs),
      proximity: getProximity(diffMs),
    };
  } else {
    nextPrayer = prayers.find((p) => p.isNext) ?? null;
  }

  return { prayers, hijriDate, nextPrayer, islamicEvent };
}
