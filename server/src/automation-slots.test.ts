import { describe, expect, it } from "vitest";
import {
  findActiveRangeSlot,
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
