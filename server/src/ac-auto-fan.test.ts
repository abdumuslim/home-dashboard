import { describe, expect, it } from "vitest";
import { computeAutoFanLevel } from "./ac-auto-fan.js";

describe("computeAutoFanLevel", () => {
  it("maps delta to levels: L1 ≤0.5, L2 ≤1.0, then +1 per 0.2", () => {
    expect(computeAutoFanLevel(-1)).toBe(1);
    expect(computeAutoFanLevel(0)).toBe(1);
    expect(computeAutoFanLevel(0.4)).toBe(1);
    expect(computeAutoFanLevel(0.5)).toBe(1);
    expect(computeAutoFanLevel(0.6)).toBe(2);
    expect(computeAutoFanLevel(1.0)).toBe(2);
    expect(computeAutoFanLevel(1.05)).toBe(3);
    expect(computeAutoFanLevel(1.2)).toBe(3);
    expect(computeAutoFanLevel(1.21)).toBe(4);
    expect(computeAutoFanLevel(1.4)).toBe(4);
    expect(computeAutoFanLevel(1.6)).toBe(5);
    expect(computeAutoFanLevel(1.8)).toBe(6);
    expect(computeAutoFanLevel(1.9)).toBe(7);
    expect(computeAutoFanLevel(5.0)).toBe(7);
  });

  it("raises immediately past the previous level", () => {
    expect(computeAutoFanLevel(1.2, 2)).toBe(3);
    expect(computeAutoFanLevel(2.5, 3)).toBe(7);
  });

  it("holds the previous level within the 0.1° down-hysteresis band", () => {
    // raw(0.95)=2 < prev=3, but raw(0.95+0.1)=3 — hold
    expect(computeAutoFanLevel(0.95, 3)).toBe(3);
    // raw(0.5)=1 < prev=2, but raw(0.6)=2 — hold
    expect(computeAutoFanLevel(0.5, 2)).toBe(2);
  });

  it("lowers once the delta clears the hysteresis band", () => {
    // raw(0.85)=2 and raw(0.95)=2 < prev=3 — drop to 2
    expect(computeAutoFanLevel(0.85, 3)).toBe(2);
    // big drop skips levels
    expect(computeAutoFanLevel(0.3, 6)).toBe(1);
  });

  it("ignores out-of-range previous levels", () => {
    expect(computeAutoFanLevel(0.95, 0)).toBe(2);
    expect(computeAutoFanLevel(0.95, null)).toBe(2);
    expect(computeAutoFanLevel(0.95, 8)).toBe(2);
  });
});
