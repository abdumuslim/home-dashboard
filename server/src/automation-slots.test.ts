import { describe, expect, it } from "vitest";
import {
  findActiveRangeSlot,
  normalizeRangeSlots,
  validateRangeSlots,
  type AutomationRangeSlot,
} from "./automation-slots.js";

const metricBounds = { min: 0, max: 50 };

function slot(overrides: Partial<AutomationRangeSlot>): AutomationRangeSlot {
  return {
    id: "slot-1",
    type: "window",
    start_mode: "exact",
    start_time: "08:00",
    end_mode: "exact",
    end_time: "12:00",
    threshold_low: 22,
    threshold: 26,
    ...overrides,
  };
}

describe("AC automation range slots", () => {
  it("selects a timed slot over the all-day default", () => {
    const slots = [
      slot({ id: "default", type: "all_day", threshold_low: 20, threshold: 28 }),
      slot({ id: "morning", start_time: "06:00", end_time: "10:00", threshold_low: 22, threshold: 25 }),
    ];

    expect(findActiveRangeSlot(slots, 7 * 60, () => null)?.id).toBe("morning");
    expect(findActiveRangeSlot(slots, 12 * 60, () => null)?.id).toBe("default");
  });

  it("supports overnight windows", () => {
    const slots = [
      slot({ id: "night", start_time: "22:00", end_time: "07:00" }),
    ];

    expect(findActiveRangeSlot(slots, 23 * 60, () => null)?.id).toBe("night");
    expect(findActiveRangeSlot(slots, 6 * 60, () => null)?.id).toBe("night");
    expect(findActiveRangeSlot(slots, 12 * 60, () => null)).toBeNull();
  });

  it("rejects overlapping timed slots but allows an all-day fallback", () => {
    const result = validateRangeSlots([
      slot({ id: "default", type: "all_day", threshold_low: 20, threshold: 28 }),
      slot({ id: "morning", start_time: "06:00", end_time: "10:00" }),
      slot({ id: "overlap", start_time: "09:30", end_time: "11:00" }),
    ], metricBounds, () => null);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("morning");
    expect(result.error).toContain("overlap");
  });

  it("rejects overnight overlaps after splitting across midnight", () => {
    const result = validateRangeSlots([
      slot({ id: "night", start_time: "22:00", end_time: "07:00" }),
      slot({ id: "early", start_time: "06:30", end_time: "08:00" }),
    ], metricBounds, () => null);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("night");
    expect(result.error).toContain("early");
  });

  it("resolves prayer-relative windows before overlap validation", () => {
    const result = validateRangeSlots([
      slot({ id: "fajr", start_mode: "prayer", start_prayer: "fajr", start_prayer_offset: 0, end_time: "08:00" }),
      slot({ id: "morning", start_time: "06:00", end_time: "09:00" }),
    ], metricBounds, (prayer) => prayer === "fajr" ? 5 * 60 : null);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("fajr");
    expect(result.error).toContain("morning");
  });

  it("accepts and preserves a valid per-slot fan speed", () => {
    const result = validateRangeSlots([
      slot({ id: "auto", fan_speed: 0 }),
      slot({ id: "max", start_time: "13:00", end_time: "15:00", fan_speed: 7 }),
      slot({ id: "preset", start_time: "16:00", end_time: "18:00" }),
    ], metricBounds, () => null);

    expect(result.ok).toBe(true);
    expect(result.slots?.[0].fan_speed).toBe(0);
    expect(result.slots?.[1].fan_speed).toBe(7);
    expect(result.slots?.[2].fan_speed).toBeUndefined();
  });

  it("rejects out-of-range or non-integer fan speeds", () => {
    expect(validateRangeSlots([slot({ fan_speed: 8 })], metricBounds, () => null).ok).toBe(false);
    expect(validateRangeSlots([slot({ fan_speed: -1 })], metricBounds, () => null).ok).toBe(false);
    expect(validateRangeSlots([slot({ fan_speed: 2.5 })], metricBounds, () => null).ok).toBe(false);
  });

  it("accepts and preserves a valid per-slot generator level", () => {
    const result = validateRangeSlots([
      slot({ id: "capped", gen_level: 2 }),
      slot({ id: "auto", start_time: "13:00", end_time: "15:00" }),
    ], metricBounds, () => null);

    expect(result.ok).toBe(true);
    expect(result.slots?.[0].gen_level).toBe(2);
    expect(result.slots?.[1].gen_level).toBeUndefined();
  });

  it("rejects out-of-range or non-integer generator levels (0 = use absent for Auto)", () => {
    expect(validateRangeSlots([slot({ gen_level: 0 })], metricBounds, () => null).ok).toBe(false);
    // 4 was valid for Najat until TCL removed levels 4–6 in 2026-06
    expect(validateRangeSlots([slot({ gen_level: 4 })], metricBounds, () => null).ok).toBe(false);
    expect(validateRangeSlots([slot({ gen_level: 7 })], metricBounds, () => null).ok).toBe(false);
    expect(validateRangeSlots([slot({ gen_level: 1.5 })], metricBounds, () => null).ok).toBe(false);
  });

  it("regression: normalizeRangeSlots whitelists gen_level (silently-dropped-field guard)", () => {
    const normalized = normalizeRangeSlots([
      { id: "s1", type: "all_day", threshold_low: 24, threshold: 26, gen_level: 3, unknown_field: 1 },
    ]);
    expect(normalized?.[0].gen_level).toBe(3);
    expect((normalized?.[0] as unknown as Record<string, unknown>).unknown_field).toBeUndefined();
  });

  it("validates slot count and threshold bounds", () => {
    expect(validateRangeSlots([], metricBounds, () => null).ok).toBe(false);
    expect(validateRangeSlots(
      [slot({ threshold_low: 27, threshold: 26 })],
      metricBounds,
      () => null,
    ).ok).toBe(false);
    expect(validateRangeSlots(
      [slot({ threshold_low: -1, threshold: 26 })],
      metricBounds,
      () => null,
    ).ok).toBe(false);
  });
});
