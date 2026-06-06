import { describe, expect, it } from "vitest";
import { computeAutoFanLevel } from "./ac-auto-fan.js";

describe("computeAutoFanLevel", () => {
  it("maps delta to levels: L1 ≤0.5, then +1 per 0.3", () => {
    expect(computeAutoFanLevel(-1)).toBe(1);
    expect(computeAutoFanLevel(0)).toBe(1);
    expect(computeAutoFanLevel(0.4)).toBe(1);
    expect(computeAutoFanLevel(0.5)).toBe(1);
    expect(computeAutoFanLevel(0.6)).toBe(2);
    expect(computeAutoFanLevel(0.8)).toBe(2);
    expect(computeAutoFanLevel(0.81)).toBe(3);
    expect(computeAutoFanLevel(1.1)).toBe(3);
    expect(computeAutoFanLevel(1.2)).toBe(4);
    expect(computeAutoFanLevel(1.4)).toBe(4);
    expect(computeAutoFanLevel(1.7)).toBe(5);
    expect(computeAutoFanLevel(2.0)).toBe(6);
    expect(computeAutoFanLevel(2.1)).toBe(7);
    expect(computeAutoFanLevel(5.0)).toBe(7);
  });

  it("raises immediately past the previous level", () => {
    expect(computeAutoFanLevel(1.2, 2)).toBe(4);
    expect(computeAutoFanLevel(2.5, 3)).toBe(7);
  });

  it("holds the previous level within the 0.1° down-hysteresis band", () => {
    // raw(0.75)=2 < prev=3, but raw(0.75+0.1)=3 — hold
    expect(computeAutoFanLevel(0.75, 3)).toBe(3);
    // raw(0.45)=1 < prev=2, but raw(0.55)=2 — hold
    expect(computeAutoFanLevel(0.45, 2)).toBe(2);
  });

  it("lowers once the delta clears the hysteresis band", () => {
    // raw(0.65)=2 and raw(0.75)=2 < prev=3 — drop to 2
    expect(computeAutoFanLevel(0.65, 3)).toBe(2);
    // big drop skips levels
    expect(computeAutoFanLevel(0.3, 6)).toBe(1);
  });

  it("ignores out-of-range previous levels", () => {
    expect(computeAutoFanLevel(0.6, 0)).toBe(2);
    expect(computeAutoFanLevel(0.6, null)).toBe(2);
    expect(computeAutoFanLevel(0.6, 8)).toBe(2);
  });
});
