// Client-side prayer minute-of-day cache for the alerts/automation form's
// overlap preview. Sourced from /api/prayer-times (same engine the server uses)
// so the client never re-implements prayer math. Best-effort: until loaded,
// callers treat prayer-relative windows as unconstrained (the server validates
// authoritatively on save).

import { TZ } from "@/constants/thresholds";

let cache: Record<string, number> | null = null;

function baghdadMinuteOfDay(ms: number): number {
  const map: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(ms))) {
    if (p.type !== "literal") map[p.type] = p.value;
  }
  return Number(map.hour) * 60 + Number(map.minute);
}

/** Fetch today's prayer times and populate the minute-of-day cache (idempotent-ish). */
export async function loadPrayerMinutes(): Promise<void> {
  try {
    const r = await fetch("/api/prayer-times");
    if (!r.ok) return;
    const json = (await r.json()) as { prayers: { name: string; timestamp: number }[] };
    const next: Record<string, number> = {};
    for (const p of json.prayers) next[p.name] = baghdadMinuteOfDay(p.timestamp);
    cache = next;
  } catch {
    /* keep last good cache; non-fatal */
  }
}

/** Minute-of-day (0–1439) for a prayer, or null if not loaded yet. */
export function prayerMinute(prayer: string): number | null {
  return cache?.[prayer] ?? null;
}
