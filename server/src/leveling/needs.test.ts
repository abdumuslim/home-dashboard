import { describe, it, expect } from "vitest";
import { boostFloor, ceilCapOf, ceilOf, floorOf, nearTargetNeedCap } from "./needs.js";
import type { AcView } from "./types.js";

function ac(overrides: Partial<AcView> = {}): AcView {
  return {
    deviceId: "a",
    name: "A",
    on: true,
    managed: true,
    shed: false,
    maxLevel: 3,
    currentLevel: 1,
    fanSpeed: 3,
    fanExempt: false,
    needDelta: 2,
    minLevel: 1,
    manualCap: null,
    manualTarget: null,
    slotCap: null,
    reachableCap: null,
    warmStartLevel: null,
    ramping: false,
    reshedPenalized: false,
    ...overrides,
  };
}

describe("floorOf", () => {
  it("boost floor holds unless manual/slot/reachable clamp below it", () => {
    expect(floorOf(ac({ minLevel: 2 }))).toBe(2);
    expect(floorOf(ac({ minLevel: 2, manualCap: 1 }))).toBe(1);
    expect(floorOf(ac({ minLevel: 2, slotCap: 1 }))).toBe(1);
    expect(floorOf(ac({ minLevel: 2, reachableCap: 1 }))).toBe(1);
    expect(floorOf(ac({ minLevel: 0 }))).toBe(1); // never level 0
  });
});

describe("ceilOf / ceilCapOf", () => {
  it("near-target band hard-caps at L1; beyond it the max decides", () => {
    expect(nearTargetNeedCap(0.3, 0.5, 3)).toBe(1);
    expect(nearTargetNeedCap(0.6, 0.5, 3)).toBe(3);
    expect(ceilOf(ac({ needDelta: 0.3 }), 0.5)).toBe(1);
    expect(ceilOf(ac({ needDelta: 2 }), 0.5)).toBe(3);
  });

  it("manualTarget bypasses need and slot caps but not reachableCap", () => {
    expect(ceilOf(ac({ needDelta: 0.3, manualTarget: 3 }), 0.5)).toBe(3);
    expect(ceilOf(ac({ slotCap: 1, manualTarget: 3 }), 0.5)).toBe(3);
    expect(ceilOf(ac({ manualTarget: 3, reachableCap: 2 }), 0.5)).toBe(2);
  });

  it("manualCap and slotCap intersect; never below the floor", () => {
    expect(ceilOf(ac({ manualCap: 2, slotCap: 3 }), 0.5)).toBe(2);
    expect(ceilOf(ac({ slotCap: 1, minLevel: 2 }), 0.5)).toBe(1); // slot clamps the floor too
  });

  it("ceilCapOf is the never-level-0 re-entry ceiling", () => {
    expect(ceilCapOf(ac())).toBe(3);
    expect(ceilCapOf(ac({ reachableCap: 2 }))).toBe(2);
    expect(ceilCapOf(ac({ manualCap: 1 }))).toBe(1);
  });
});

describe("boostFloor hysteresis", () => {
  const boost = { minLevel: 2, outdoorAtLeastC: 39 };

  it("activates at ≥ threshold, releases at ≤ threshold − 1", () => {
    expect(boostFloor(boost, 39, false)).toEqual({ minLevel: 2, active: true });
    expect(boostFloor(boost, 38.5, false)).toEqual({ minLevel: 1, active: false });
    expect(boostFloor(boost, 38.5, true)).toEqual({ minLevel: 2, active: true });
    expect(boostFloor(boost, 38, true)).toEqual({ minLevel: 1, active: false });
  });

  it("holds its last state when outdoor is unknown", () => {
    expect(boostFloor(boost, null, true).active).toBe(true);
    expect(boostFloor(boost, null, false).active).toBe(false);
    expect(boostFloor(undefined, 45, true).active).toBe(false);
  });
});
