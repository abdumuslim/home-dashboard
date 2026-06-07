import { describe, it, expect } from "vitest";
import {
  powerConditionSustained,
  POWER_ALERT_READINGS,
  POWER_ALERT_MAX_GAP_MS,
  type PowerReadingEntry,
} from "./alert-metrics.js";

/** Build readings 5s apart ending at t=0 baseline, one per given current_1 value. */
function readings(values: Array<number | null>, gapMs = 5_000): PowerReadingEntry[] {
  return values.map((v, i) => ({
    tsMs: i * gapMs,
    row: v == null
      ? { voltage: 230 }
      : { voltage: 230, current_1: v, power_1: v * 230, power_2: 0 },
  }));
}

describe("powerConditionSustained", () => {
  it("fires when the last 4 readings all exceed the threshold (above)", () => {
    const r = readings([5, 21, 22, 23, 24]);
    expect(powerConditionSustained("current_grid", "above", 20, r)).toBe(true);
  });

  it("fires when the last 4 readings are all under the threshold (below)", () => {
    const r = readings([25, 4, 3, 2, 1]);
    expect(powerConditionSustained("current_grid", "below", 5, r)).toBe(true);
  });

  it("below does not fire when one reading in the window is back above", () => {
    const r = readings([4, 3, 6, 2]);
    expect(powerConditionSustained("current_grid", "below", 5, r)).toBe(false);
  });

  it("does not fire with fewer than 4 readings", () => {
    const r = readings([25, 25, 25]);
    expect(r.length).toBeLessThan(POWER_ALERT_READINGS);
    expect(powerConditionSustained("current_grid", "above", 20, r)).toBe(false);
  });

  it("does not fire when one reading in the window dips below the threshold", () => {
    const r = readings([25, 25, 19, 25]);
    expect(powerConditionSustained("current_grid", "above", 20, r)).toBe(false);
  });

  it("does not fire on a single spike", () => {
    const r = readings([5, 5, 5, 25]);
    expect(powerConditionSustained("current_grid", "above", 20, r)).toBe(false);
  });

  it("a >15s gap between readings breaks the streak", () => {
    const r = readings([25, 25, 25, 25]);
    const gapped = [
      r[0],
      { ...r[1], tsMs: r[0].tsMs + POWER_ALERT_MAX_GAP_MS + 1 },
      { ...r[2], tsMs: r[0].tsMs + POWER_ALERT_MAX_GAP_MS + 1 + 5_000 },
      { ...r[3], tsMs: r[0].tsMs + POWER_ALERT_MAX_GAP_MS + 1 + 10_000 },
    ];
    expect(powerConditionSustained("current_grid", "above", 20, gapped)).toBe(false);
  });

  it("a gap of exactly 15s does not break the streak", () => {
    const r = readings([25, 25, 25, 25], POWER_ALERT_MAX_GAP_MS);
    expect(powerConditionSustained("current_grid", "above", 20, r)).toBe(true);
  });

  it("a null metric value in the window breaks the streak", () => {
    const r = readings([25, 25, null, 25]);
    expect(powerConditionSustained("current_grid", "above", 20, r)).toBe(false);
  });

  it("computed power_total works across readings", () => {
    const r = [10, 11, 12, 13].map((v, i) => ({
      tsMs: i * 5_000,
      row: { power_1: v * 230, power_2: 500 },
    }));
    // power_total = power_1 + power_2 → 2800..3490 W
    expect(powerConditionSustained("power_total", "above", 2500, r)).toBe(true);
    expect(powerConditionSustained("power_total", "above", 3000, r)).toBe(false);
  });

  it("older out-of-range readings before the last 4 are ignored", () => {
    const r = readings([1, 2, 3, 4, 25, 26, 27, 28]);
    expect(powerConditionSustained("current_grid", "above", 20, r)).toBe(true);
  });

  it("unknown metric never fires", () => {
    const r = readings([25, 25, 25, 25]);
    expect(powerConditionSustained("nonexistent", "above", 20, r)).toBe(false);
  });
});
