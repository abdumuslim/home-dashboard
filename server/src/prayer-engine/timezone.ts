// Timezone helpers — anchor "which civil day" at any longitude, with no deps.
// All prayer instants the engine returns are absolute (UTC); the timezone only
// decides which calendar day to compute and is used to find the day's local
// midnight as a precise UTC instant.

/** Offset (ms) of `tz` from UTC at the given instant: tzWallClock − utcWallClock. */
export function tzOffsetMs(instant: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const map: Record<string, string> = {};
  for (const p of dtf.formatToParts(instant)) {
    if (p.type !== "literal") map[p.type] = p.value;
  }
  const asUtc = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour),
    Number(map.minute),
    Number(map.second),
  );
  return asUtc - instant.getTime();
}

/** The UTC instant for a wall-clock time in `tz` (DST-aware via a one-step correction). */
export function wallTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz: string,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offset = tzOffsetMs(new Date(guess), tz);
  return new Date(guess - offset);
}

/** The UTC instant of local midnight (00:00) of the civil day that `date` falls on in `tz`. */
export function zonedMidnightUtc(date: Date, tz: string): Date {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const map: Record<string, string> = {};
  for (const p of dtf.formatToParts(date)) {
    if (p.type !== "literal") map[p.type] = p.value;
  }
  return wallTimeToUtc(Number(map.year), Number(map.month), Number(map.day), 0, 0, tz);
}
