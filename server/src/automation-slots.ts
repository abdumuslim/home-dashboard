import { MAX_GENERATOR_LEVEL } from "./tcl-cloud.js";
import { getBaghdadPrayerTimes, baghdadMinuteOfDay, prayerInstant } from "./prayer.js";

const MINUTES_PER_DAY = 1440;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const VALID_PRAYERS = new Set(["fajr", "dhuhr", "asr", "maghrib", "isha"]);
const VALID_VERTICAL_SWING = new Set([0, 1, 2, 3, 9, 10, 11, 12, 13]);

export type RangeSlotType = "all_day" | "window";
export type RangeSlotTimeMode = "exact" | "prayer";
export type PrayerResolver = (prayer: string, offset: number) => number | null;

export interface AutomationRangeSlot {
  id: string;
  label?: string;
  type: RangeSlotType;
  start_mode?: RangeSlotTimeMode;
  start_time?: string;
  start_prayer?: string;
  start_prayer_offset?: number;
  end_mode?: RangeSlotTimeMode;
  end_time?: string;
  end_prayer?: string;
  end_prayer_offset?: number;
  threshold_low: number;
  threshold: number;
  /** 0 = smart auto (delta-based), 1–7 fixed level, absent = preset profile fan. */
  fan_speed?: number;
  /**
   * Generator-level cap while this slot is active (1–6); absent = Auto.
   * When Smart AC Leveling manages the device this is a HARD CAP (never raised
   * above, reductions/sheds below stay allowed; a live manual target still
   * wins). When unmanaged (leveler off or smart_leveling=false) it is sent
   * directly as the profile's generator_mode, overriding the preset's.
   */
  gen_level?: number;
  /**
   * Vertical swing while this slot is active (TCL vertical encoding:
   * 0=Off, 1=Full, 2=Up, 3=Down, 9=Top, 10=Upper, 11=Mid, 12=Lower,
   * 13=Bottom); absent = preset profile's vertical_swing. Unlike gen_level,
   * 0 is a VALID stored value (swing mode), not "Auto".
   */
  vertical_swing?: number;
}

interface ResolvedWindow {
  slot: AutomationRangeSlot;
  start: number;
  end: number;
  intervals: Array<{ start: number; end: number }>;
}

export interface RangeSlotValidationResult {
  ok: boolean;
  error?: string;
  slots?: AutomationRangeSlot[];
}

export function parseTimeToMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

export function getBaghdadMinutes(date = new Date()): number {
  const baghdadNow = new Date(date.toLocaleString("en-US", { timeZone: "Asia/Baghdad" }));
  return baghdadNow.getHours() * 60 + baghdadNow.getMinutes();
}

export function createBaghdadPrayerResolver(date = new Date()): PrayerResolver {
  const times = getBaghdadPrayerTimes(date);
  return (prayer: string, offset: number): number | null => {
    const t = prayerInstant(times, prayer);
    if (!t) return null;
    return normalizeMinute(baghdadMinuteOfDay(t) + offset);
  };
}

export function normalizeRangeSlots(value: unknown): AutomationRangeSlot[] | null {
  if (!Array.isArray(value)) return null;
  return value.map((raw, idx) => {
    const item = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    return {
      id: typeof item.id === "string" && item.id.trim() ? item.id.trim() : `slot-${idx + 1}`,
      ...(typeof item.label === "string" && item.label.trim() ? { label: item.label.trim() } : {}),
      type: item.type === "all_day" ? "all_day" : "window",
      start_mode: item.start_mode === "prayer" ? "prayer" : "exact",
      ...(typeof item.start_time === "string" ? { start_time: item.start_time } : {}),
      ...(typeof item.start_prayer === "string" ? { start_prayer: item.start_prayer } : {}),
      ...(typeof item.start_prayer_offset === "number" ? { start_prayer_offset: item.start_prayer_offset } : {}),
      end_mode: item.end_mode === "prayer" ? "prayer" : "exact",
      ...(typeof item.end_time === "string" ? { end_time: item.end_time } : {}),
      ...(typeof item.end_prayer === "string" ? { end_prayer: item.end_prayer } : {}),
      ...(typeof item.end_prayer_offset === "number" ? { end_prayer_offset: item.end_prayer_offset } : {}),
      threshold_low: typeof item.threshold_low === "number" ? item.threshold_low : Number.NaN,
      threshold: typeof item.threshold === "number" ? item.threshold : Number.NaN,
      ...(typeof item.fan_speed === "number" ? { fan_speed: item.fan_speed } : {}),
      ...(typeof item.gen_level === "number" ? { gen_level: item.gen_level } : {}),
      ...(typeof item.vertical_swing === "number" ? { vertical_swing: item.vertical_swing } : {}),
    };
  });
}

export function getLegacyRangeSlots(thresholdLow: number | null, threshold: number | null): AutomationRangeSlot[] {
  if (thresholdLow == null || threshold == null) return [];
  return [{
    id: "default",
    type: "all_day",
    threshold_low: thresholdLow,
    threshold,
  }];
}

export function findActiveRangeSlot(
  slots: AutomationRangeSlot[],
  nowMinutes: number,
  resolvePrayerMinutes: PrayerResolver,
): AutomationRangeSlot | null {
  let fallback: AutomationRangeSlot | null = null;
  const activeWindows: Array<{ slot: AutomationRangeSlot; sortKey: number }> = [];

  for (const slot of slots) {
    if (slot.type === "all_day") {
      fallback ??= slot;
      continue;
    }
    const window = resolveWindow(slot, resolvePrayerMinutes);
    if (!window) continue;
    const active = window.start <= window.end
      ? nowMinutes >= window.start && nowMinutes < window.end
      : nowMinutes >= window.start || nowMinutes < window.end;
    if (active) {
      activeWindows.push({
        slot,
        sortKey: window.start <= nowMinutes ? window.start : window.start - MINUTES_PER_DAY,
      });
    }
  }

  activeWindows.sort((a, b) => b.sortKey - a.sortKey);
  return activeWindows[0]?.slot ?? fallback;
}

export function validateRangeSlots(
  rawSlots: unknown,
  bounds: { min: number; max: number },
  resolvePrayerMinutes: PrayerResolver,
): RangeSlotValidationResult {
  const slots = normalizeRangeSlots(rawSlots);
  if (!slots) return { ok: false, error: "Range slots are required for AC automations" };
  if (slots.length < 1 || slots.length > 24) return { ok: false, error: "Range slots must contain 1–24 entries" };

  const seenIds = new Set<string>();
  let allDayCount = 0;
  const windows: ResolvedWindow[] = [];

  for (let i = 0; i < slots.length; i += 1) {
    const slot = slots[i];
    const label = slotLabel(slot, i);
    if (seenIds.has(slot.id)) return { ok: false, error: `Duplicate range slot id "${slot.id}"` };
    seenIds.add(slot.id);

    if (!Number.isFinite(slot.threshold_low) || !Number.isFinite(slot.threshold)) {
      return { ok: false, error: `${label}: thresholds must be finite numbers` };
    }
    if (slot.threshold_low < bounds.min || slot.threshold_low > bounds.max) {
      return { ok: false, error: `${label}: low threshold must be between ${bounds.min} and ${bounds.max}` };
    }
    if (slot.threshold < bounds.min || slot.threshold > bounds.max) {
      return { ok: false, error: `${label}: high threshold must be between ${bounds.min} and ${bounds.max}` };
    }
    if (slot.threshold_low >= slot.threshold) {
      return { ok: false, error: `${label}: low threshold must be less than high threshold` };
    }
    if (slot.fan_speed != null && (!Number.isInteger(slot.fan_speed) || slot.fan_speed < 0 || slot.fan_speed > 7)) {
      return { ok: false, error: `${label}: fan speed must be an integer 0–7` };
    }
    // 0 is deliberately rejected — "Auto" is the ABSENT field; level 0 means
    // unrestricted in the TCL protocol, a footgun for a cap.
    if (slot.gen_level != null && (!Number.isInteger(slot.gen_level) || slot.gen_level < 1 || slot.gen_level > MAX_GENERATOR_LEVEL)) {
      return { ok: false, error: `${label}: generator level must be an integer 1–${MAX_GENERATOR_LEVEL}` };
    }
    // Unlike gen_level, 0 (Off) is a valid swing value — absent = preset's swing.
    if (slot.vertical_swing != null && !VALID_VERTICAL_SWING.has(slot.vertical_swing)) {
      return { ok: false, error: `${label}: vertical swing must be one of 0,1,2,3,9–13` };
    }

    if (slot.type === "all_day") {
      allDayCount += 1;
      if (allDayCount > 1) return { ok: false, error: "Only one all-day range slot is allowed" };
      continue;
    }

    const window = resolveWindow(slot, resolvePrayerMinutes);
    if (!window) return { ok: false, error: `${label}: invalid start or end time` };
    if (window.start === window.end) return { ok: false, error: `${label}: start and end time cannot be the same` };
    windows.push(window);
  }

  for (let i = 0; i < windows.length; i += 1) {
    for (let j = i + 1; j < windows.length; j += 1) {
      if (windowsOverlap(windows[i], windows[j])) {
        return {
          ok: false,
          error: `Range slots overlap: ${slotLabel(windows[i].slot, i)} and ${slotLabel(windows[j].slot, j)}`,
        };
      }
    }
  }

  return { ok: true, slots };
}

function normalizeMinute(value: number): number {
  return ((value % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
}

function resolveEndpoint(
  slot: AutomationRangeSlot,
  prefix: "start" | "end",
  resolvePrayerMinutes: PrayerResolver,
): number | null {
  const mode = slot[`${prefix}_mode`] ?? "exact";
  if (mode === "prayer") {
    const prayer = slot[`${prefix}_prayer`];
    const offset = slot[`${prefix}_prayer_offset`] ?? 0;
    if (!prayer || !VALID_PRAYERS.has(prayer)) return null;
    if (!Number.isInteger(offset) || offset < -120 || offset > 120) return null;
    return resolvePrayerMinutes(prayer, offset);
  }

  const time = slot[`${prefix}_time`];
  if (!time || !TIME_RE.test(time)) return null;
  return parseTimeToMinutes(time);
}

function resolveWindow(slot: AutomationRangeSlot, resolvePrayerMinutes: PrayerResolver): ResolvedWindow | null {
  const start = resolveEndpoint(slot, "start", resolvePrayerMinutes);
  const end = resolveEndpoint(slot, "end", resolvePrayerMinutes);
  if (start == null || end == null) return null;
  if (start === end) return null;
  return {
    slot,
    start,
    end,
    intervals: start < end
      ? [{ start, end }]
      : [{ start, end: MINUTES_PER_DAY }, { start: 0, end }],
  };
}

function windowsOverlap(a: ResolvedWindow, b: ResolvedWindow): boolean {
  return a.intervals.some((ai) => b.intervals.some((bi) => ai.start < bi.end && bi.start < ai.end));
}

function slotLabel(slot: AutomationRangeSlot, index: number): string {
  return slot.label || slot.id || `Slot ${index + 1}`;
}
