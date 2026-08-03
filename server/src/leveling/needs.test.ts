import { describe, it, expect } from "vitest";
import {
  boostFloor,
  ceilCapOf,
  ceilOf,
  floorOf,
  isNonCooling,
  nearTargetNeedCap,
  nextSubFloorWatch,
  NON_COOLING_NEED_C,
  SUBFLOOR_PROGRESS_C,
  SUBFLOOR_WATCH_MS,
} from "./needs.js";
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
    startBaselineAmps: null,
    rampBaselineAmps: null,
    rampAbsorbedAmps: null,
    reshedPenalized: false,
    satisfiedForMs: 0,
    subFloorStalledMs: 0,
    unmeteredJumpAmps: 0,
    ...overrides,
    envelopeLevel: overrides.envelopeLevel ?? overrides.currentLevel ?? 1,
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

describe("a level that does not cool is an off (user rule, 2026-08-03 evening)", () => {
  // "L1 with Abdullah AC and above the specified temp should not happen unless
  // there is a real helpful need, and within only 2 degrees above the specified;
  // otherwise consider it off." Measured that evening: held at L1 through 47.3°C
  // outdoors, his room went 30 → 34°C against a setpoint of 20, and switching
  // the AC off moved the meter barely at all.
  const boosted = (o: Partial<AcView> = {}): AcView => ac({ minLevel: 2, currentLevel: 1, ...o });

  it("is OFF below an active floor when the room is more than 2°C from target", () => {
    expect(isNonCooling(boosted({ needDelta: NON_COOLING_NEED_C + 0.1 }), 1)).toBe(true);
  });

  it("is NOT off within the band — that level still does useful work", () => {
    expect(isNonCooling(boosted({ needDelta: NON_COOLING_NEED_C }), 1)).toBe(false);
    expect(isNonCooling(boosted({ needDelta: 0.4 }), 1)).toBe(false);
  });

  it("never applies at or above the floor, however hot the room", () => {
    expect(isNonCooling(boosted({ needDelta: 9 }), 2)).toBe(false);
    expect(isNonCooling(ac({ minLevel: 1, needDelta: 9 }), 1)).toBe(false);
  });

  it("WATCHES inside the band: no cooling for the watch window is an off too", () => {
    // The band is a prediction; this is the check on it ("at the 2 degrees the
    // system should watch it if the compressor fall"). A room that is not
    // getting cooler is not being cooled, however close to target it looks.
    const stalled = boosted({ needDelta: 1.0, subFloorStalledMs: SUBFLOOR_WATCH_MS });
    expect(isNonCooling(stalled, 1)).toBe(true);
    const progressing = boosted({ needDelta: 1.0, subFloorStalledMs: SUBFLOOR_WATCH_MS - 1 });
    expect(isNonCooling(progressing, 1)).toBe(false);
  });
});

describe("the sub-floor watch (nextSubFloorWatch — one implementation, shell and harness)", () => {
  const base = { active: true, belowFloor: true, needDelta: 1.0, tempKnown: true, now: 0 };

  it("accrues while the room makes no progress, re-bases on real cooling", () => {
    const t0 = nextSubFloorWatch(null, base);
    expect(t0.stalledMs).toBe(0);
    const later = nextSubFloorWatch(t0.watch, { ...base, now: 300_000 });
    expect(later.stalledMs).toBe(300_000);
    // 0.2°C of progress is real cooling — the clock starts over.
    const cooled = nextSubFloorWatch(later.watch, { ...base, needDelta: 1.0 - SUBFLOOR_PROGRESS_C, now: 310_000 });
    expect(cooled.stalledMs).toBe(0);
    expect(cooled.watch?.at).toBe(310_000);
  });

  it("a dead thermometer can NEVER accrue toward a spend (2026-08-03 review)", () => {
    // computeAcNeed maps a missing sensor to needDelta exactly 1 — constant,
    // inside the 2°C band, incapable of showing progress. Without this gate,
    // ten minutes of dead sensor reads as a stalled compressor and the
    // recovery path spends on a thermometer that is lying.
    const t0 = nextSubFloorWatch(null, base);
    const blind = nextSubFloorWatch(t0.watch, { ...base, tempKnown: false, now: SUBFLOOR_WATCH_MS + 60_000 });
    expect(blind.stalledMs).toBe(0);
    // The record survives the gap: two REAL endpoint readings still answer
    // "did this room get cooler" — and here they say no.
    const returned = nextSubFloorWatch(blind.watch, { ...base, now: SUBFLOOR_WATCH_MS + 120_000 });
    expect(returned.stalledMs).toBeGreaterThanOrEqual(SUBFLOOR_WATCH_MS);
  });

  it("leaving the sub-floor state (or the room going off) resets the clock", () => {
    const t0 = nextSubFloorWatch(null, base);
    expect(nextSubFloorWatch(t0.watch, { ...base, belowFloor: false, now: 60_000 }).watch).toBeNull();
    expect(nextSubFloorWatch(t0.watch, { ...base, active: false, now: 60_000 }).watch).toBeNull();
  });
});

describe("manual wins over the boost floor (user, 2026-08-03 evening)", () => {
  // Live 19:29:27 the user pinned Abdullah to L1 from the dashboard while his
  // L2 heat boost was active. `ceilOf` returned max(floor 2, target 1) = 2 and
  // the leveler raised him back at 19:32:13 and 19:38:33. The status showed
  // manualTarget 1 the whole time — the pin was recorded and ignored.
  const pinned = (target: number | null, o: Partial<AcView> = {}): AcView =>
    ac({ minLevel: 2, currentLevel: 1, manualTarget: target, needDelta: 9, ...o });

  it("a pin BELOW an active boost floor lowers the floor and holds", () => {
    expect(floorOf(pinned(1))).toBe(1);
    expect(ceilOf(pinned(1), 0.5)).toBe(1); // was 2 — the raise that undid the pin
  });

  it("an unpinned room keeps its boost floor", () => {
    expect(floorOf(pinned(null))).toBe(2);
    // …and its ceiling is still need-driven (9°C from target → the top level).
    expect(ceilOf(pinned(null), 0.5)).toBe(3);
  });

  it("a pin ABOVE the floor changes nothing about the floor", () => {
    expect(floorOf(pinned(3))).toBe(2);
    expect(ceilOf(pinned(3), 0.5)).toBe(3);
  });

  it("a pinned room is NOT classified non-cooling — no peer is shed for it", () => {
    // Manual wins means the controller stops arguing, in both directions: it
    // may not raise the room back, and it may not switch off a neighbour to
    // fund a level the user deliberately declined.
    expect(isNonCooling(pinned(1, { needDelta: 11 }), 1)).toBe(false);
    expect(isNonCooling(pinned(null, { needDelta: 11 }), 1)).toBe(true);
  });

  it("but the WATCH still observes it — reported, not enforced", () => {
    // The watch keys off the boost minimum, so a pin cannot blind it: the
    // stall clock keeps running and can still tell the user their pinned room
    // has not cooled in ten minutes.
    const belowBoostFloor = (ac_: AcView): boolean => ac_.currentLevel < ac_.minLevel;
    expect(belowBoostFloor(pinned(1))).toBe(true);
  });
});
