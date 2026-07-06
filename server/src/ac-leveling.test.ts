import { describe, it, expect } from "vitest";
import {
  computeAllocation,
  computeEmergencyReduction,
  selectReduction,
  estimateAcDraw,
  determineSource,
  computeNeedTier,
  needCap,
  FAN_REDUCE_SAVINGS_AMPS,
  REDUCE_STREAK,
  REDUCE_STREAK_SEVERE,
  RAISE_STREAK,
  RESTORE_SHED_STREAK,
  type AllocatorInput,
  type EmergencyInput,
  type LevelerAcSnapshot,
  type AcAmpModel,
} from "./ac-leveling.js";

// Amp models: Abdu = 4A at L1 + 2A/level; Najat & Abdullah = 2A at L1 + 1A/level
const MODELS: Record<string, AcAmpModel> = {
  najat: { baseAmps: 2, stepAmps: 1 },
  abdu: { baseAmps: 4, stepAmps: 2 },
  abdullah: { baseAmps: 2, stepAmps: 1 },
};

const TIER_DELTAS = { satisfied: -0.5, mild: 1, full: 2 } as const;

function ac(id: string, over: Partial<LevelerAcSnapshot> = {}): LevelerAcSnapshot {
  const snapshot: LevelerAcSnapshot = {
    deviceId: id,
    on: true,
    managed: true,
    shed: false,
    // All production ACs are 3-level since 2026-06 (TCL removed Najat's 4–6).
    // Tests that exercise >3-level math pass an explicit maxLevel override —
    // the allocator takes maxLevel as data and must stay generic.
    maxLevel: 3,
    currentLevel: 1,
    minLevel: 1,
    needTier: "full",
    needDelta: 0,
    manualCap: null,
    manualTarget: null,
    fanSpeed: 1,
    fanRestoreTarget: null,
    fanExempt: false,
    bounceCap: null,
    restoreBlocked: false,
    slotCap: null,
    reachableCap: null,
    warmStartLevel: null,
    ...over,
  };
  if (over.needDelta === undefined) snapshot.needDelta = TIER_DELTAS[snapshot.needTier];
  return snapshot;
}

// acs are pre-sorted by priority (highest first): najat > abdu > abdullah
function input(over: Partial<AllocatorInput> = {}): AllocatorInput {
  return {
    limitAmps: 30,
    marginAmps: 1,
    raiseBufferAmps: 0,
    // 0 keeps the near-target band a no-op for legacy tests (only delta ≤ 0 =
    // satisfied caps at L1); the dedicated near-target suite sets 0.5.
    nearTargetBandC: 0,
    nonAcLoadAmps: 0,
    overLimitStreak: 0,
    severeOverLimitStreak: 0,
    headroomStreak: RAISE_STREAK,
    inSettle: false,
    forceEvaluate: false,
    acs: [ac("najat"), ac("abdu"), ac("abdullah")],
    ampModels: MODELS,
    ...over,
  };
}

describe("estimateAcDraw", () => {
  it("computes per-level draw from base + step", () => {
    expect(estimateAcDraw(1, 3, MODELS.abdu)).toBe(4);
    expect(estimateAcDraw(2, 3, MODELS.abdu)).toBe(6);
    expect(estimateAcDraw(3, 3, MODELS.abdu)).toBe(8);
    expect(estimateAcDraw(1, 6, MODELS.najat)).toBe(2);
    expect(estimateAcDraw(6, 6, MODELS.najat)).toBe(7);
  });

  it("treats level 0 (unrestricted) as one step above max level", () => {
    expect(estimateAcDraw(0, 3, MODELS.abdu)).toBe(10);
    expect(estimateAcDraw(0, 6, MODELS.najat)).toBe(8);
  });

  it("clamps levels above max", () => {
    expect(estimateAcDraw(9, 3, MODELS.abdullah)).toBe(4);
  });
});

describe("determineSource", () => {
  it("returns none for missing or stale readings", () => {
    expect(determineSource(null, 0)).toBe("none");
    expect(determineSource({ current_1: 10, current_2: 0 }, 16_000)).toBe("none");
  });

  it("detects single active source above noise threshold", () => {
    expect(determineSource({ current_1: 5, current_2: 0 }, 1000)).toBe("grid");
    expect(determineSource({ current_1: 0, current_2: 3 }, 1000)).toBe("gen");
    expect(determineSource({ current_1: 0.05, current_2: 0.05 }, 1000)).toBe("none");
  });

  it("picks the larger current when both lines are active (mirrors power card)", () => {
    expect(determineSource({ current_1: 8, current_2: 2 }, 1000)).toBe("grid");
    expect(determineSource({ current_1: 1, current_2: 4 }, 1000)).toBe("gen");
  });
});

describe("computeNeedTier", () => {
  it("classifies range automation values against the active slot", () => {
    expect(computeNeedTier({ kind: "range", value: 24, slotLow: 25, slotHigh: 28 })).toBe("satisfied");
    expect(computeNeedTier({ kind: "range", value: 25, slotLow: 25, slotHigh: 28 })).toBe("satisfied");
    expect(computeNeedTier({ kind: "range", value: 26.5, slotLow: 25, slotHigh: 28 })).toBe("mild");
    expect(computeNeedTier({ kind: "range", value: 28, slotLow: 25, slotHigh: 28 })).toBe("full");
  });

  it("classifies comfort deviation for ACs without automations", () => {
    expect(computeNeedTier({ kind: "comfort", currentTemp: 25.5, target: 26 })).toBe("satisfied");
    expect(computeNeedTier({ kind: "comfort", currentTemp: 27, target: 26 })).toBe("mild");
    expect(computeNeedTier({ kind: "comfort", currentTemp: 27.6, target: 26 })).toBe("full");
  });
});

describe("needCap", () => {
  it("maps tiers to level caps", () => {
    expect(needCap("satisfied", 6)).toBe(1);
    expect(needCap("mild", 6)).toBe(3);
    expect(needCap("mild", 3)).toBe(2);
    expect(needCap("full", 6)).toBe(6);
    expect(needCap("full", 3)).toBe(3);
  });
});

describe("computeAllocation — priority fill", () => {
  it("saturates highest priority first in the ideal allocation", () => {
    const r = computeAllocation(input());
    // budget 29: najat L3 (4) + abdu L3 (8) + abdullah L3 (4) = 16
    expect(r.idealLevels).toEqual({ najat: 3, abdu: 3, abdullah: 3 });
    expect(r.budgetAmps).toBe(29);
  });

  it("jumps straight to the ideal allocation when headroom is sustained", () => {
    const r = computeAllocation(input());
    expect(r.desiredLevels).toEqual({ najat: 3, abdu: 3, abdullah: 3 });
    expect(r.toShed).toEqual([]);
    expect(r.toRestore).toEqual([]);
  });

  it("spreads levels evenly before saturating anyone when the budget is tight", () => {
    const r = computeAllocation(input({ nonAcLoadAmps: 16 }));
    // budget 13: L1 sum 8 → najat L2 (9), abdu L2 (11), abdullah L2 (12), najat L3 (13)
    expect(r.idealLevels).toEqual({ najat: 3, abdu: 2, abdullah: 2 });
  });

  it("gives the next level to the hottest-above-target room first", () => {
    const tight = { nonAcLoadAmps: 20, headroomStreak: 0 }; // budget 9, one step fits
    const r1 = computeAllocation(input({
      ...tight,
      acs: [ac("najat", { needDelta: 3 }), ac("abdu", { needDelta: 1 }), ac("abdullah", { needDelta: 2 })],
    }));
    expect(r1.idealLevels).toEqual({ najat: 2, abdu: 1, abdullah: 1 });

    const r2 = computeAllocation(input({
      ...tight,
      acs: [ac("najat", { needDelta: 1 }), ac("abdu", { needDelta: 2 }), ac("abdullah", { needDelta: 5 })],
    }));
    expect(r2.idealLevels).toEqual({ najat: 1, abdu: 1, abdullah: 2 });
  });

  it("stops the ideal fill at the budget", () => {
    const r = computeAllocation(input({ nonAcLoadAmps: 20 }));
    // budget 9: L1 sum 8, najat +1 → 9, no more room
    expect(r.idealLevels).toEqual({ najat: 2, abdu: 1, abdullah: 1 });
  });

  it("suppresses raises without sustained headroom", () => {
    const r = computeAllocation(input({ headroomStreak: RAISE_STREAK - 1 }));
    expect(r.desiredLevels).toEqual({});
  });

  it("suppresses raises during settle", () => {
    const r = computeAllocation(input({ inSettle: true }));
    expect(r.desiredLevels).toEqual({});
  });
});

describe("computeAllocation — raise buffer (hysteresis)", () => {
  // Single Abdullah (base 2 + 1/level, max 3). limit 15, margin 1.
  const oneAc = (over: Partial<LevelerAcSnapshot> = {}) => [ac("abdullah", { needTier: "full", ...over })];

  it("stops the raise fill a buffer short of the real budget", () => {
    // budget = 15 − 1 − 8.5 = 5.5; floor L1 = 2. Without buffer L1→…→ fits L3 (4).
    // With buffer 2 → raiseBudget 3.5: from L1(2) only +1 (L2=3) fits, not L3(4).
    const withBuffer = computeAllocation(input({
      limitAmps: 15, nonAcLoadAmps: 8.5, raiseBufferAmps: 2, acs: oneAc(),
    }));
    expect(withBuffer.idealLevels).toEqual({ abdullah: 2 });
    // Same input, no buffer → fills to L3.
    const noBuffer = computeAllocation(input({
      limitAmps: 15, nonAcLoadAmps: 8.5, raiseBufferAmps: 0, acs: oneAc(),
    }));
    expect(noBuffer.idealLevels).toEqual({ abdullah: 3 });
  });

  it("never sheds because of the buffer — over-budget uses the FULL budget", () => {
    // Three ACs at floor cost 2+4+2 = 8. budget 15−1−5 = 9 (floors fit), but
    // raiseBudget 9−3 = 6 < 8. The buffer must NOT trigger a shed.
    const r = computeAllocation(input({
      limitAmps: 15, nonAcLoadAmps: 5, raiseBufferAmps: 3,
      acs: [ac("najat"), ac("abdu"), ac("abdullah")],
    }));
    expect(r.toShed).toEqual([]);
    expect(r.idealLevels).toEqual({ najat: 1, abdu: 1, abdullah: 1 });
  });

  it("never lowers a hard floor / boost minimum", () => {
    // raiseBudget = 15 − 1 − 8 − 5 = 1 — the buffer eats the whole budget, yet
    // the floor (L2 boost min) is never lowered below 2.
    const r = computeAllocation(input({
      limitAmps: 15, nonAcLoadAmps: 8, raiseBufferAmps: 5,
      acs: oneAc({ minLevel: 2, currentLevel: 2 }),
    }));
    expect(r.idealLevels).toEqual({ abdullah: 2 });
  });

  it("never blocks a below-floor correction (ungated by the buffer)", () => {
    const r = computeAllocation(input({
      limitAmps: 15, nonAcLoadAmps: 5, raiseBufferAmps: 5, headroomStreak: 0,
      acs: oneAc({ minLevel: 2, currentLevel: 1 }),
    }));
    // Below the boost floor — corrected to the floor immediately even with no
    // headroom streak and a budget-eating buffer.
    expect(r.desiredLevels).toEqual({ abdullah: 2 });
  });

  it("does NOT apply the raise buffer to restores (2026-06-18 — restores fit the un-buffered limit)", () => {
    // Abdullah ON at floor L2 (3A); Najat shed, floor L1 (2A). budget = 15−1−9 = 5;
    // cost 3 + Najat 2 = 5 = budget → fits exactly at limit−margin. The buffer used
    // to park restores below this (left a room shed in the deadband though it fit);
    // now only LEVEL raises honor the buffer, so the restore fires whatever it is.
    const acs = [
      ac("abdullah", { on: true, currentLevel: 2, minLevel: 2, needTier: "satisfied" }),
      ac("najat", { on: false, shed: true, needTier: "full", needDelta: 3 }),
    ];
    expect(computeAllocation(input({ limitAmps: 15, nonAcLoadAmps: 9, raiseBufferAmps: 2, acs })).toRestore).toEqual(["najat"]);
    expect(computeAllocation(input({ limitAmps: 15, nonAcLoadAmps: 9, raiseBufferAmps: 0, acs })).toRestore).toEqual(["najat"]);
    // Still blocked when it genuinely won't fit under the limit (nonAcLoad 10 → budget 4 < 5).
    expect(computeAllocation(input({ limitAmps: 15, nonAcLoadAmps: 10, raiseBufferAmps: 0, acs })).toRestore).toEqual([]);
  });

  it("still caps a level-0 (unrestricted) AC immediately under any buffer", () => {
    // raiseBudget = 15 − 1 − 8 − 5 = 1 → fill stays at the floor, but the
    // level-0 AC must still be capped (never left unrestricted) → L1.
    const r = computeAllocation(input({
      limitAmps: 15, nonAcLoadAmps: 8, raiseBufferAmps: 5,
      acs: oneAc({ currentLevel: 0 }),
    }));
    expect(r.desiredLevels).toEqual({ abdullah: 1 });
  });

  it("clamps a negative buffer to zero (never raises above limit − margin)", () => {
    const neg = computeAllocation(input({
      limitAmps: 15, nonAcLoadAmps: 8.5, raiseBufferAmps: -5, acs: oneAc(),
    }));
    const zero = computeAllocation(input({
      limitAmps: 15, nonAcLoadAmps: 8.5, raiseBufferAmps: 0, acs: oneAc(),
    }));
    expect(neg.idealLevels).toEqual(zero.idealLevels);
  });
});

describe("computeAllocation — warm restore", () => {
  it("jumps to the remembered level skipping the headroom streak, capped at remembered", () => {
    // 6-level max: generic >3 coverage (the allocator takes maxLevel as data)
    const r = computeAllocation(input({
      headroomStreak: 0,
      acs: [ac("najat", { maxLevel: 6, currentLevel: 1, warmStartLevel: 4 })],
    }));
    // budget fits L6, but the warm restore only goes back to the remembered L4.
    expect(r.desiredLevels).toEqual({ najat: 4 });
  });

  it("does not warm-restore above the remembered level", () => {
    const r = computeAllocation(input({
      headroomStreak: 0,
      acs: [ac("najat", { currentLevel: 4, warmStartLevel: 4 })],
    }));
    expect(r.desiredLevels).toEqual({});
  });

  it("budget still clamps the warm restore below the remembered level", () => {
    const r = computeAllocation(input({
      limitAmps: 15,
      nonAcLoadAmps: 11, // budget 3 → najat fits only L2 (3A), not L3 (4A)
      headroomStreak: 0,
      acs: [ac("najat", { currentLevel: 1, warmStartLevel: 4 })],
    }));
    expect(r.desiredLevels).toEqual({ najat: 2 });
  });

  it("defers the warm restore during settle", () => {
    const r = computeAllocation(input({
      headroomStreak: 0,
      inSettle: true,
      acs: [ac("najat", { currentLevel: 1, warmStartLevel: 4 })],
    }));
    expect(r.desiredLevels).toEqual({});
  });

  it("defers the warm restore while a raise hold is active", () => {
    const r = computeAllocation(input({
      headroomStreak: 0,
      raiseHold: true,
      acs: [ac("najat", { currentLevel: 1, warmStartLevel: 4 })],
    }));
    expect(r.desiredLevels).toEqual({});
  });

  it("raises past the remembered level once headroom is sustained", () => {
    const r = computeAllocation(input({
      headroomStreak: RAISE_STREAK,
      acs: [ac("najat", { maxLevel: 6, currentLevel: 1, warmStartLevel: 4 })],
    }));
    // canRaise is met → full budget-fitted ideal, not capped at the remembered L4.
    expect(r.desiredLevels).toEqual({ najat: 6 });
  });
});

describe("computeAllocation — need and manual caps", () => {
  it("caps satisfied at L1 but soft-fills mild rooms when budget allows", () => {
    const r = computeAllocation(input({
      acs: [
        ac("najat", { needTier: "mild" }),
        ac("abdu", { needTier: "satisfied" }),
        ac("abdullah", { needTier: "full" }),
      ],
    }));
    // budget 29: surplus lets mild najat soft-fill to max while satisfied abdu stays L1
    expect(r.idealLevels).toEqual({ najat: 3, abdu: 1, abdullah: 3 });
  });

  it("keeps the mild cap when the budget is tight", () => {
    const r = computeAllocation(input({
      nonAcLoadAmps: 13,
      acs: [
        ac("najat", { needTier: "mild" }),
        ac("abdu", { needTier: "full" }),
        ac("abdullah", { needTier: "full" }),
      ],
    }));
    // budget 16: need caps {najat 3, abdu 3, abdullah 3} cost exactly 4+8+4 — no surplus
    expect(r.idealLevels).toEqual({ najat: 3, abdu: 3, abdullah: 3 });
  });

  it("never raises above a manual cap (user reduction)", () => {
    const r = computeAllocation(input({
      acs: [ac("najat", { manualCap: 2 }), ac("abdu"), ac("abdullah")],
    }));
    expect(r.idealLevels.najat).toBe(2);
  });

  it("lets a manual target override the need cap", () => {
    // satisfied → need cap L1; the user's explicit L3 wins
    const r = computeAllocation(input({
      acs: [ac("najat", { needTier: "satisfied", manualTarget: 3 }), ac("abdu"), ac("abdullah")],
    }));
    expect(r.idealLevels.najat).toBe(3);
  });

  it("clamps manual targets to the device max level", () => {
    const r = computeAllocation(input({
      acs: [ac("abdullah", { manualTarget: 9 }), ac("najat"), ac("abdu")],
    }));
    expect(r.idealLevels.abdullah).toBe(3);
  });
});

describe("computeAllocation — startAtFloors re-asserts floor (ungated)", () => {
  it("drops an above-floor AC to its floor even without canReduce", () => {
    // Gen changeover: the fill is skipped so target IS the floor; the firmware can
    // come back above the commanded floor, so the floor-down must re-send every
    // tick the shadow still reads high — NOT gated behind the over-limit streak.
    const r = computeAllocation(input({
      acs: [ac("abdu", { currentLevel: 3 })],
      nonAcLoadAmps: 5,
      forceEvaluate: false,
      overLimitStreak: 0,
      headroomStreak: 0,
      startAtFloors: true,
    }));
    expect(r.desiredLevels).toEqual({ abdu: 1 });
  });

  it("does NOT drop an above-floor AC without startAtFloors when canReduce is false (today's bug)", () => {
    const r = computeAllocation(input({
      acs: [ac("abdu", { currentLevel: 3 })],
      nonAcLoadAmps: 5,
      forceEvaluate: false,
      overLimitStreak: 0,
      headroomStreak: 0,
      startAtFloors: false,
    }));
    expect(r.desiredLevels).toEqual({});
  });

  it("sends nothing once the AC is already at floor (re-send stops on confirm)", () => {
    const r = computeAllocation(input({
      acs: [ac("abdu", { currentLevel: 1 })],
      nonAcLoadAmps: 5,
      forceEvaluate: false,
      overLimitStreak: 0,
      headroomStreak: 0,
      startAtFloors: true,
    }));
    expect(r.desiredLevels).toEqual({});
  });

  it("respects a boost floor (L2) instead of L1 under startAtFloors", () => {
    const r = computeAllocation(input({
      acs: [ac("abdullah", { currentLevel: 3, minLevel: 2 })],
      nonAcLoadAmps: 5,
      forceEvaluate: false,
      overLimitStreak: 0,
      headroomStreak: 0,
      startAtFloors: true,
    }));
    expect(r.desiredLevels).toEqual({ abdullah: 2 });
  });
});

describe("computeAllocation — reductions", () => {
  const highLevels = [
    ac("najat", { currentLevel: 6 }),
    ac("abdu", { currentLevel: 3 }),
    ac("abdullah", { currentLevel: 3 }),
  ];

  it("does not reduce before the over-limit streak is reached", () => {
    const r = computeAllocation(input({
      acs: highLevels,
      nonAcLoadAmps: 20,
      overLimitStreak: REDUCE_STREAK - 1,
      headroomStreak: 0,
    }));
    expect(r.desiredLevels).toEqual({});
    expect(r.toShed).toEqual([]);
  });

  it("reduces to the ideal allocation in one batch after the streak", () => {
    const r = computeAllocation(input({
      acs: highLevels,
      nonAcLoadAmps: 20,
      overLimitStreak: REDUCE_STREAK,
      headroomStreak: 0,
    }));
    // budget 9 → ideal { najat 2, abdu 1, abdullah 1 }
    expect(r.desiredLevels).toEqual({ najat: 2, abdu: 1, abdullah: 1 });
  });

  it("reduces immediately on forceEvaluate (proactive path)", () => {
    const r = computeAllocation(input({
      acs: highLevels,
      nonAcLoadAmps: 20,
      overLimitStreak: 0,
      forceEvaluate: true,
      headroomStreak: 0,
    }));
    expect(r.desiredLevels).toEqual({ najat: 2, abdu: 1, abdullah: 1 });
  });

  it("reduces on the fast severe path before the mild streak is reached", () => {
    // overLimitStreak short of REDUCE_STREAK, but a severe streak of 2 acts now.
    const r = computeAllocation(input({
      acs: highLevels,
      nonAcLoadAmps: 20,
      overLimitStreak: REDUCE_STREAK_SEVERE,
      severeOverLimitStreak: REDUCE_STREAK_SEVERE,
      headroomStreak: 0,
    }));
    expect(r.desiredLevels).toEqual({ najat: 2, abdu: 1, abdullah: 1 });
  });

  it("does not reduce on a single severe reading (needs the severe streak)", () => {
    const r = computeAllocation(input({
      acs: highLevels,
      nonAcLoadAmps: 20,
      overLimitStreak: 1,
      severeOverLimitStreak: REDUCE_STREAK_SEVERE - 1,
      headroomStreak: 0,
    }));
    expect(r.desiredLevels).toEqual({});
    expect(r.toShed).toEqual([]);
  });

  it("always caps a managed ON AC left at level 0 regardless of gating", () => {
    const r = computeAllocation(input({
      acs: [ac("najat", { currentLevel: 0 }), ac("abdu"), ac("abdullah")],
      headroomStreak: 0,
    }));
    expect(r.desiredLevels.najat).toBe(3);
  });
});

describe("computeAllocation — minimum level boost", () => {
  it("holds a boosted AC at its floor even when the room is satisfied", () => {
    const r = computeAllocation(input({
      acs: [ac("najat"), ac("abdu"), ac("abdullah", { minLevel: 2, needTier: "satisfied" })],
    }));
    expect(r.idealLevels.abdullah).toBe(2);
  });

  it("corrects a below-floor AC immediately without raise gating", () => {
    const r = computeAllocation(input({
      headroomStreak: 0,
      acs: [ac("najat"), ac("abdu"), ac("abdullah", { minLevel: 2, currentLevel: 1 })],
    }));
    // Only the floor correction goes out — other raises stay gated
    expect(r.desiredLevels).toEqual({ abdullah: 2 });
  });

  it("jumps a below-floor AC to its full ideal when raise gating allows", () => {
    const r = computeAllocation(input({
      acs: [ac("najat"), ac("abdu"), ac("abdullah", { minLevel: 2, currentLevel: 1 })],
    }));
    expect(r.desiredLevels.abdullah).toBe(3);
  });

  it("lets a manual reduction below the floor win", () => {
    const r = computeAllocation(input({
      headroomStreak: 0,
      acs: [ac("najat"), ac("abdu"), ac("abdullah", { minLevel: 2, currentLevel: 1, manualCap: 1 })],
    }));
    expect(r.desiredLevels).toEqual({});
    expect(r.idealLevels.abdullah).toBe(1);
  });
});

describe("computeAllocation — shed by need", () => {
  // User scenario: Abdullah (top priority) pinned at L2 by the outdoor boost;
  // Mom (najat) and Abdu at L1; over the generator limit → shed the room with
  // the smaller delta between target and actual, NOT strict reverse priority.
  it("sheds the least-needy non-top AC first", () => {
    const r = computeAllocation(input({
      limitAmps: 15,
      nonAcLoadAmps: 7,
      forceEvaluate: true,
      headroomStreak: 0,
      acs: [
        ac("abdullah", { minLevel: 2, currentLevel: 2, needDelta: 1.5 }),
        ac("najat", { needDelta: 0.8 }),
        ac("abdu", { needDelta: 2.5 }),
      ],
    }));
    // budget 7: abdullah L2 (3) + najat L1 (2) + abdu L1 (4) = 9 → shed najat (lowest delta)
    expect(r.toShed).toEqual(["najat"]);
    expect(r.idealLevels.abdullah).toBe(2);
    expect(r.idealLevels.abdu).toBe(1);
  });

  it("protects the top-priority AC until last", () => {
    const r = computeAllocation(input({
      limitAmps: 15,
      nonAcLoadAmps: 13,
      forceEvaluate: true,
      headroomStreak: 0,
      acs: [
        ac("abdullah", { minLevel: 2, currentLevel: 2, needDelta: 1.5 }),
        ac("najat", { needDelta: 0.8 }),
        ac("abdu", { needDelta: 2.5 }),
      ],
    }));
    expect(r.toShed).toEqual(["najat", "abdu", "abdullah"]);
  });
});

describe("computeAllocation — shedding", () => {
  it("sheds the single big AC over two small ones when one shed fits (fewer rooms off)", () => {
    const r = computeAllocation(input({
      limitAmps: 15,
      nonAcLoadAmps: 9,
      overLimitStreak: REDUCE_STREAK,
      headroomStreak: 0,
    }));
    // budget 5: L1 sum najat 2 + abdu 4 + abdullah 2 = 8, all equally needy.
    // The cost-aware optimizer sheds ONLY abdu (4A) — remaining 4 ≤ 5 — keeping
    // najat AND abdullah on. The old greedy shed abdullah + abdu (two rooms off,
    // over-cut 3A); one big shed (over-cut 1A) is strictly less disruptive.
    expect(r.toShed).toEqual(["abdu"]);
    expect(r.idealLevels.najat).toBe(1);
    expect(r.idealLevels.abdullah).toBe(1);
  });

  it("does not shed before the streak / force gate", () => {
    const r = computeAllocation(input({
      limitAmps: 15,
      nonAcLoadAmps: 9,
      overLimitStreak: REDUCE_STREAK - 1,
      headroomStreak: 0,
    }));
    expect(r.toShed).toEqual([]);
  });

  it("sheds everything managed when the budget is negative", () => {
    const r = computeAllocation(input({
      limitAmps: 15,
      nonAcLoadAmps: 16,
      forceEvaluate: true,
      headroomStreak: 0,
    }));
    expect(r.toShed).toEqual(["abdullah", "abdu", "najat"]);
  });
});

describe("computeAllocation — restore", () => {
  it("restores the highest-priority shed AC when headroom allows", () => {
    const r = computeAllocation(input({
      nonAcLoadAmps: 10,
      acs: [
        ac("najat", { currentLevel: 2 }),
        ac("abdu", { on: false, shed: true }),
        ac("abdullah", { on: false, shed: true }),
      ],
    }));
    expect(r.toRestore).toEqual(["abdu"]);
  });

  it("does not raise levels on the same call as a restore", () => {
    const r = computeAllocation(input({
      acs: [
        ac("najat", { currentLevel: 1 }),
        ac("abdu"),
        ac("abdullah", { on: false, shed: true }),
      ],
    }));
    expect(r.toRestore).toEqual(["abdullah"]);
    expect(r.desiredLevels).toEqual({});
  });

  it("blocks restore without the (shorter) sustained headroom or during settle", () => {
    const base = {
      acs: [ac("najat"), ac("abdu"), ac("abdullah", { on: false, shed: true })],
    };
    // A shed restore uses RESTORE_SHED_STREAK (3); below it there is no restore…
    expect(computeAllocation(input({ ...base, headroomStreak: RESTORE_SHED_STREAK - 1 })).toRestore).toEqual([]);
    // …but it fires a streak earlier than a level raise would (RAISE_STREAK − 1).
    expect(computeAllocation(input({ ...base, headroomStreak: RESTORE_SHED_STREAK })).toRestore).toEqual(["abdullah"]);
    expect(computeAllocation(input({ ...base, inSettle: true })).toRestore).toEqual([]);
  });

  it("restores the most-needy shed AC first regardless of priority", () => {
    const r = computeAllocation(input({
      nonAcLoadAmps: 10,
      acs: [
        ac("najat", { currentLevel: 2 }),
        ac("abdu", { on: false, shed: true, needDelta: 1 }),
        ac("abdullah", { on: false, shed: true, needDelta: 3 }),
      ],
    }));
    expect(r.toRestore).toEqual(["abdullah"]);
  });

  it("budgets a boosted shed AC at its floor level for restore", () => {
    const base = {
      limitAmps: 15,
      acs: [
        ac("najat", { currentLevel: 1 }),
        ac("abdullah", { on: false, shed: true, minLevel: 2 }),
      ],
    };
    // najat L1 (2A) + abdullah floor L2 (3A) = 5A
    expect(computeAllocation(input({ ...base, nonAcLoadAmps: 9 })).toRestore).toEqual(["abdullah"]);
    expect(computeAllocation(input({ ...base, nonAcLoadAmps: 10 })).toRestore).toEqual([]);
  });

  it("blocks restore when the budget cannot fit the L1 draw", () => {
    const r = computeAllocation(input({
      limitAmps: 15,
      nonAcLoadAmps: 8,
      acs: [
        ac("najat", { currentLevel: 1 }),
        ac("abdu", { currentLevel: 1 }),
        ac("abdullah", { on: false, shed: true }),
      ],
    }));
    // budget 6: najat 2 + abdu 4 = 6, no room for abdullah L1 (2)
    expect(r.toRestore).toEqual([]);
  });

  it("restores a shed AC that fits under the limit even with a raise buffer set (2026-06-18)", () => {
    // raiseBuffer 1 + margin 1: abdu's floor (4A) brings the total to exactly
    // limit − margin (budget 6A). The OLD code parked restores a full buffer
    // below (needed ≤ 5A) and left the room shed in the deadband though it fit —
    // the leveler shed at the limit but only restored limit−margin−buffer, so a
    // room sat OFF until the user turned it on by hand. Restores now fit the
    // UN-buffered budget; level raises keep the buffer.
    const base = {
      limitAmps: 15,
      marginAmps: 1,
      raiseBufferAmps: 1,
      nonAcLoadAmps: 8,
      acs: [ac("najat", { currentLevel: 1 }), ac("abdu", { on: false, shed: true })],
    };
    expect(computeAllocation(input(base)).toRestore).toEqual(["abdu"]);
    // Still respects the real limit: at nonAcLoad 9 he genuinely doesn't fit.
    expect(computeAllocation(input({ ...base, nonAcLoadAmps: 9 })).toRestore).toEqual([]);
  });
});

describe("computeAllocation — raise-miss hold", () => {
  it("blocks raises while the hold is active", () => {
    const r = computeAllocation(input({ raiseHold: true }));
    // budget 29 would normally raise everyone to the ideal — hold gates it
    expect(r.desiredLevels).toEqual({});
    expect(r.idealLevels).toEqual({ najat: 3, abdu: 3, abdullah: 3 });
  });

  it("blocks restores while the hold is active", () => {
    const r = computeAllocation(input({
      raiseHold: true,
      acs: [ac("najat"), ac("abdu"), ac("abdullah", { on: false, shed: true })],
    }));
    expect(r.toRestore).toEqual([]);
  });

  it("never blocks reductions — safety first", () => {
    const r = computeAllocation(input({
      raiseHold: true,
      overLimitStreak: REDUCE_STREAK,
      nonAcLoadAmps: 18,
      acs: [ac("najat", { currentLevel: 6 }), ac("abdu", { currentLevel: 3 }), ac("abdullah", { currentLevel: 3 })],
    }));
    // budget 11: fitted ideal is below current levels → reductions go out
    expect(Object.keys(r.desiredLevels).length).toBeGreaterThan(0);
    for (const [id, level] of Object.entries(r.desiredLevels)) {
      const current = id === "najat" ? 6 : 3;
      expect(level).toBeLessThan(current);
    }
  });
});

describe("computeAllocation — restore with reduction", () => {
  // All ACs on at lower levels beats one AC raised high: restore feasibility
  // is judged at FLOORS, and raised ACs are pulled down in the same batch.
  it("reduces raised ACs to make room and restores in the same call", () => {
    const r = computeAllocation(input({
      limitAmps: 15,
      nonAcLoadAmps: 3,
      acs: [
        ac("najat", { currentLevel: 6 }),
        ac("abdu", { currentLevel: 3 }),
        ac("abdullah", { on: false, shed: true }),
      ],
    }));
    // budget 11; floors najat 2 + abdu 4 = 6, + abdullah floor 2 = 8 fits.
    // Fill: najat→2 (9), abdu→2 (11). Old code compared against current
    // levels (7 + 8 = 15) and blocked the restore forever.
    expect(r.toRestore).toEqual(["abdullah"]);
    expect(r.desiredLevels).toEqual({ najat: 2, abdu: 2 });
    expect(r.idealLevels.abdullah).toBe(1);
  });

  it("emits the accompanying reductions without an over-limit streak", () => {
    const r = computeAllocation(input({
      limitAmps: 15,
      nonAcLoadAmps: 3,
      overLimitStreak: 0,
      forceEvaluate: false,
      acs: [
        ac("najat", { currentLevel: 6 }),
        ac("abdu", { currentLevel: 3 }),
        ac("abdullah", { on: false, shed: true }),
      ],
    }));
    // canReduce is false — the reductions ride the restore (raise gate).
    expect(r.desiredLevels).toEqual({ najat: 2, abdu: 2 });
  });

  it("does not reduce anyone when even the floors cannot fit the candidate", () => {
    const r = computeAllocation(input({
      limitAmps: 15,
      nonAcLoadAmps: 7,
      acs: [
        ac("najat", { currentLevel: 6 }),
        ac("abdu", { currentLevel: 3 }),
        ac("abdullah", { on: false, shed: true }),
      ],
    }));
    // budget 7; floors 6 + abdullah 2 = 8 > 7 → no restore, and no
    // reduction may leak through without canReduce.
    expect(r.toRestore).toEqual([]);
    expect(r.desiredLevels).toEqual({});
  });

  it("restores at most one shed AC per call (most-needy first)", () => {
    const r = computeAllocation(input({
      acs: [
        ac("najat", { currentLevel: 1 }),
        ac("abdu", { on: false, shed: true, needDelta: 1 }),
        ac("abdullah", { on: false, shed: true, needDelta: 3 }),
      ],
    }));
    expect(r.toRestore).toEqual(["abdullah"]);
    expect(r.idealLevels.abdu).toBeUndefined();
  });

  it("falls back to a less-needy candidate whose floor fits", () => {
    const r = computeAllocation(input({
      limitAmps: 15,
      nonAcLoadAmps: 9,
      acs: [
        ac("najat", { currentLevel: 1 }),
        ac("abdu", { on: false, shed: true, needDelta: 3 }),
        ac("abdullah", { on: false, shed: true, needDelta: 1 }),
      ],
    }));
    // budget 5: najat 2 + abdu 4 = 6 won't fit, najat 2 + abdullah 2 = 4 does
    expect(r.toRestore).toEqual(["abdullah"]);
  });

  it("reduces a manualTarget AC too — floors ignore manual targets", () => {
    const r = computeAllocation(input({
      limitAmps: 15,
      nonAcLoadAmps: 3,
      acs: [
        ac("najat", { currentLevel: 6, manualTarget: 6 }),
        ac("abdu", { currentLevel: 3 }),
        ac("abdullah", { on: false, shed: true }),
      ],
    }));
    expect(r.toRestore).toEqual(["abdullah"]);
    expect(r.desiredLevels.najat).toBeLessThan(6);
  });

  it("gates the restore-reductions with the restore itself", () => {
    const acs = [
      ac("najat", { currentLevel: 6 }),
      ac("abdu", { currentLevel: 3 }),
      ac("abdullah", { on: false, shed: true }),
    ];
    const noHeadroom = computeAllocation(input({
      limitAmps: 15, nonAcLoadAmps: 3, acs, headroomStreak: RESTORE_SHED_STREAK - 1,
    }));
    expect(noHeadroom.toRestore).toEqual([]);
    expect(noHeadroom.desiredLevels).toEqual({});
    const settling = computeAllocation(input({
      limitAmps: 15, nonAcLoadAmps: 3, acs, inSettle: true,
    }));
    expect(settling.toRestore).toEqual([]);
    expect(settling.desiredLevels).toEqual({});
  });
});

describe("computeAllocation — unmanaged ACs", () => {
  it("counts unmanaged draw against the budget but never touches them", () => {
    const r = computeAllocation(input({
      acs: [
        ac("najat"),
        ac("abdu", { managed: false, currentLevel: 0 }),
        ac("abdullah"),
      ],
    }));
    // unmanaged abdu at L0 = 10A fixed → budget 19; najat L3 (4) + abdullah L3 (4) = 8
    expect(r.budgetAmps).toBe(19);
    expect(r.idealLevels).toEqual({ najat: 3, abdullah: 3 });
    expect(r.desiredLevels.abdu).toBeUndefined();
    expect(r.toShed).not.toContain("abdu");
  });
});

describe("computeAllocation — status fields", () => {
  it("reports projected amps from current levels", () => {
    const r = computeAllocation(input({
      nonAcLoadAmps: 5,
      acs: [
        ac("najat", { currentLevel: 3 }),
        ac("abdu", { currentLevel: 2 }),
        ac("abdullah", { on: false }),
      ],
    }));
    // 5 + najat L3 (4) + abdu L2 (6) = 15
    expect(r.projectedAmps).toBe(15);
    expect(r.nonAcLoadAmps).toBe(5);
  });
});

describe("computeAllocation — soft need caps", () => {
  it("spreads surplus budget across mild rooms level-by-level", () => {
    // najat at a generic 6-level max so the spread past L3 stays covered
    const r = computeAllocation(input({
      acs: [
        ac("najat", { maxLevel: 6, needTier: "mild" }),
        ac("abdu", { needTier: "mild" }),
        ac("abdullah", { needTier: "mild" }),
      ],
    }));
    // budget 29: surplus soft-fills all to max
    expect(r.idealLevels).toEqual({ najat: 6, abdu: 3, abdullah: 3 });
  });

  it("never soft-fills past a manual target", () => {
    const r = computeAllocation(input({
      acs: [ac("najat", { needTier: "mild", manualTarget: 2 }), ac("abdu"), ac("abdullah")],
    }));
    // surplus budget would fill to max 3, but the user's explicit pick stays the ceiling
    expect(r.idealLevels.najat).toBe(2);
  });

  it("never soft-fills past a manual cap", () => {
    const r = computeAllocation(input({
      acs: [ac("najat", { needTier: "mild", manualCap: 2 }), ac("abdu"), ac("abdullah")],
    }));
    expect(r.idealLevels.najat).toBe(2);
  });
});

describe("computeAllocation — fan reduction before shed", () => {
  // Same over-budget setup as the shedding suite: budget 5, L1 floors cost 8.
  const overLimit = {
    limitAmps: 15,
    nonAcLoadAmps: 9,
    overLimitStreak: REDUCE_STREAK,
    headroomStreak: 0,
  };

  it("reduces all reducible fans instead of shedding", () => {
    const r = computeAllocation(input({
      ...overLimit,
      acs: [
        ac("najat", { fanSpeed: 3 }),
        ac("abdu", { fanSpeed: 0 }), // built-in auto counts as reducible
        ac("abdullah", { fanSpeed: 1 }), // already at minimum
      ],
    }));
    expect(r.toFanReduce).toEqual(["najat", "abdu"]);
    expect(r.toShed).toEqual([]);
  });

  it("floors gen levels in the same batch as the fan reduction", () => {
    const r = computeAllocation(input({
      ...overLimit,
      acs: [
        ac("najat", { fanSpeed: 3, currentLevel: 4 }),
        ac("abdu", { fanSpeed: 2, currentLevel: 3 }),
        ac("abdullah", { fanSpeed: 1, currentLevel: 2 }),
      ],
    }));
    expect(r.toFanReduce).toEqual(["najat", "abdu"]);
    // No one is shed, so everyone reduces to floor — including would-be-shed ACs
    expect(r.desiredLevels).toEqual({ najat: 1, abdu: 1, abdullah: 1 });
  });

  it("skips exempt, unknown-fan, and unmanaged ACs", () => {
    const r = computeAllocation(input({
      ...overLimit,
      acs: [
        ac("najat", { fanSpeed: 3, fanExempt: true }),
        ac("abdu", { fanSpeed: null }),
        ac("abdullah", { fanSpeed: 5, managed: false }),
      ],
    }));
    // Nothing reducible → the shed path runs instead
    expect(r.toFanReduce).toEqual([]);
    expect(r.toShed.length).toBeGreaterThan(0);
  });

  it("sheds when every fan is already at minimum", () => {
    const r = computeAllocation(input(overLimit));
    // ac() defaults to fanSpeed 1 — not reducible. budget 5, floors sum 8, all
    // equally needy → one big shed (abdu, 4A) fits and keeps two rooms on.
    expect(r.toFanReduce).toEqual([]);
    expect(r.toShed).toEqual(["abdu"]);
  });

  it("is gated by the over-limit streak", () => {
    const r = computeAllocation(input({
      ...overLimit,
      overLimitStreak: REDUCE_STREAK - 1,
      acs: [ac("najat", { fanSpeed: 3 }), ac("abdu"), ac("abdullah")],
    }));
    expect(r.toFanReduce).toEqual([]);
    expect(r.toShed).toEqual([]);
  });

  it("fires immediately on forceEvaluate", () => {
    const r = computeAllocation(input({
      ...overLimit,
      overLimitStreak: 0,
      forceEvaluate: true,
      acs: [ac("najat", { fanSpeed: 3 }), ac("abdu"), ac("abdullah")],
    }));
    expect(r.toFanReduce).toEqual(["najat"]);
  });
});

describe("computeAllocation — fan restore (one jump)", () => {
  it("restores the highest-priority pending hold straight to its original fan", () => {
    const r = computeAllocation(input({
      acs: [
        ac("najat", { fanSpeed: 1, fanRestoreTarget: 4 }),
        ac("abdu", { fanSpeed: 1, fanRestoreTarget: 3 }),
        ac("abdullah"),
      ],
    }));
    expect(r.toFanRaise).toEqual({ deviceId: "najat", fan: 4 });
  });

  it("restores an auto-fan hold straight to 0", () => {
    const r = computeAllocation(input({
      acs: [ac("najat", { fanSpeed: 1, fanRestoreTarget: 0 }), ac("abdu"), ac("abdullah")],
    }));
    expect(r.toFanRaise).toEqual({ deviceId: "najat", fan: 0 });
  });

  it("jumps to the target from any intermediate fan", () => {
    const r = computeAllocation(input({
      acs: [ac("najat", { fanSpeed: 3, fanRestoreTarget: 7 }), ac("abdu"), ac("abdullah")],
    }));
    expect(r.toFanRaise).toEqual({ deviceId: "najat", fan: 7 });
  });

  it("restores only to the highest fan that fits — the sweet spot (2026-06-18)", () => {
    // najat alone, floor 2A; budget = 15 − 1 − 9.5 = 4.5, so the fan's headroom
    // is 4.5 − 2 = 2.5A. At the LEARNED 1A/step that's 2 steps → fan 1→3, NOT a
    // phantom jump to 5 that would re-push the meter over and bounce.
    const acs = [ac("najat", { fanSpeed: 1, fanRestoreTarget: 5 })];
    expect(computeAllocation(input({
      limitAmps: 15, nonAcLoadAmps: 9.5, acs, fanStepCost: { najat: 1 },
    })).toFanRaise).toEqual({ deviceId: "najat", fan: 3 });
    // Without a learned cost the 0.5A heuristic over-credits the headroom and
    // jumps straight to full (the pre-fix, bounce-prone behavior).
    expect(computeAllocation(input({
      limitAmps: 15, nonAcLoadAmps: 9.5, acs,
    })).toFanRaise).toEqual({ deviceId: "najat", fan: 5 });
  });

  it("restores an auto-fan hold only when the full auto cost fits (can't subdivide)", () => {
    const acs = [ac("najat", { fanSpeed: 1, fanRestoreTarget: 0 })];
    // headroom 4A ≥ 3A learned auto cost → restore to auto.
    expect(computeAllocation(input({
      limitAmps: 15, nonAcLoadAmps: 8, acs, fanStepCost: { najat: 3 },
    })).toFanRaise).toEqual({ deviceId: "najat", fan: 0 });
    // headroom 2A < 3A → hold at 1 (no intermediate for auto).
    expect(computeAllocation(input({
      limitAmps: 15, nonAcLoadAmps: 10, acs, fanStepCost: { najat: 3 },
    })).toFanRaise).toBeNull();
  });

  it("emits nothing when the hold is already complete", () => {
    const r = computeAllocation(input({
      acs: [ac("najat", { fanSpeed: 4, fanRestoreTarget: 4 }), ac("abdu"), ac("abdullah")],
    }));
    expect(r.toFanRaise).toBeNull();
  });

  it("is suppressed without sustained headroom, during settle, or over budget", () => {
    const held = [ac("najat", { fanSpeed: 1, fanRestoreTarget: 4 }), ac("abdu"), ac("abdullah")];
    expect(computeAllocation(input({ acs: held, headroomStreak: RAISE_STREAK - 1 })).toFanRaise).toBeNull();
    expect(computeAllocation(input({ acs: held, inSettle: true })).toFanRaise).toBeNull();
    expect(computeAllocation(input({
      acs: held.map((a) => ({ ...a })),
      limitAmps: 15,
      nonAcLoadAmps: 9, // budget 5 < floors 8 — over budget
    })).toFanRaise).toBeNull();
  });

  it("lets a shed restore take precedence over a fan raise", () => {
    const r = computeAllocation(input({
      nonAcLoadAmps: 10,
      acs: [
        ac("najat", { fanSpeed: 1, fanRestoreTarget: 4 }),
        ac("abdu", { on: false, shed: true }),
        ac("abdullah"),
      ],
    }));
    expect(r.toRestore).toEqual(["abdu"]);
    expect(r.toFanRaise).toBeNull();
  });

  it("suppresses gen raises while any hold is pending", () => {
    const r = computeAllocation(input({
      acs: [
        ac("najat", { fanSpeed: 1, fanRestoreTarget: 4, currentLevel: 1 }),
        ac("abdu", { currentLevel: 1 }),
        ac("abdullah", { currentLevel: 1 }),
      ],
    }));
    expect(r.toFanRaise).toEqual({ deviceId: "najat", fan: 4 });
    expect(r.desiredLevels).toEqual({});
  });

  it("still corrects a below-floor AC while a hold is pending", () => {
    const r = computeAllocation(input({
      headroomStreak: 0,
      acs: [
        ac("najat", { fanSpeed: 1, fanRestoreTarget: 4 }),
        ac("abdu"),
        ac("abdullah", { minLevel: 2, currentLevel: 1 }),
      ],
    }));
    expect(r.desiredLevels).toEqual({ abdullah: 2 });
  });
});

describe("computeAllocation — bounce caps", () => {
  it("never raises above a bounce cap, in either fill pass", () => {
    const r = computeAllocation(input({
      acs: [ac("najat"), ac("abdu", { bounceCap: 1 }), ac("abdullah")],
    }));
    // budget 29: without the cap abdu (full tier) would soft-fill to 3
    expect(r.idealLevels).toEqual({ najat: 3, abdu: 1, abdullah: 3 });
  });

  it("gives the budget to the other ACs when the neediest is bounce-capped", () => {
    const base = {
      nonAcLoadAmps: 19,
      acs: [
        ac("najat", { needDelta: 2 }),
        ac("abdu", { needDelta: 3 }),
        ac("abdullah", { needTier: "satisfied" as const }),
      ],
    };
    // budget 10, base cost 8: without a cap the hottest room (abdu, step 2A) wins the surplus
    expect(computeAllocation(input(base)).idealLevels).toEqual({ najat: 1, abdu: 2, abdullah: 1 });
    // bounce-capped abdu steps aside — najat absorbs the surplus instead
    const capped = {
      ...base,
      acs: [base.acs[0], ac("abdu", { needDelta: 3, bounceCap: 1 }), base.acs[2]],
    };
    expect(computeAllocation(input(capped)).idealLevels).toEqual({ najat: 3, abdu: 1, abdullah: 1 });
  });

  it("defers a manual target while the bounce cap is active", () => {
    const r = computeAllocation(input({
      acs: [ac("najat"), ac("abdu", { manualTarget: 3, bounceCap: 1 }), ac("abdullah")],
    }));
    expect(r.idealLevels.abdu).toBe(1);
  });

  it("never lowers the hard boost floor", () => {
    const r = computeAllocation(input({
      acs: [ac("najat"), ac("abdu"), ac("abdullah", { minLevel: 2, bounceCap: 1 })],
    }));
    expect(r.idealLevels.abdullah).toBe(2);
  });

  it("produces no commands when the only raise candidate is bounce-capped", () => {
    const r = computeAllocation(input({
      nonAcLoadAmps: 19,
      acs: [
        ac("najat", { needTier: "satisfied" }),
        ac("abdu", { bounceCap: 1 }),
        ac("abdullah", { needTier: "satisfied" }),
      ],
    }));
    expect(r.desiredLevels).toEqual({});
    expect(r.toShed).toEqual([]);
  });

  it("skips a restore-blocked shed AC and restores the next-most-needy", () => {
    const r = computeAllocation(input({
      nonAcLoadAmps: 10,
      acs: [
        ac("najat", { currentLevel: 2 }),
        ac("abdu", { on: false, shed: true, needDelta: 3, restoreBlocked: true }),
        ac("abdullah", { on: false, shed: true, needDelta: 1 }),
      ],
    }));
    expect(r.toRestore).toEqual(["abdullah"]);
  });

  it("restores nothing when every shed candidate is restore-blocked", () => {
    const r = computeAllocation(input({
      nonAcLoadAmps: 10,
      acs: [
        ac("najat", { currentLevel: 2 }),
        ac("abdu", { on: false, shed: true, restoreBlocked: true }),
        ac("abdullah", { on: false, shed: true, restoreBlocked: true }),
      ],
    }));
    expect(r.toRestore).toEqual([]);
  });
});

describe("computeAllocation — slot gen caps (per-range-slot level)", () => {
  it("never raises above an active slot cap in the fill", () => {
    const r = computeAllocation(input({
      acs: [ac("najat", { slotCap: 2 }), ac("abdu"), ac("abdullah")],
    }));
    expect(r.desiredLevels.najat).toBe(2);
    expect(r.desiredLevels.abdu).toBe(3);
    expect(r.desiredLevels.abdullah).toBe(3);
  });

  it("slot cap below a boost floor wins (explicit per-window intent)", () => {
    const r = computeAllocation(input({
      forceEvaluate: true,
      acs: [ac("najat"), ac("abdu"), ac("abdullah", { minLevel: 2, currentLevel: 2, slotCap: 1 })],
    }));
    expect(r.desiredLevels.abdullah).toBe(1);
  });

  it("still sheds a slot-capped AC when the budget demands it", () => {
    const r = computeAllocation(input({
      limitAmps: 15,
      nonAcLoadAmps: 13, // budget 1 < najat's floor 2A
      overLimitStreak: REDUCE_STREAK,
      acs: [ac("najat", { slotCap: 3 })],
    }));
    expect(r.toShed).toEqual(["najat"]);
  });

  it("still reduces below the slot cap when over the limit", () => {
    const r = computeAllocation(input({
      limitAmps: 15,
      nonAcLoadAmps: 11, // budget 3 — fill stops at L2 (2A floor + 1A step)
      overLimitStreak: REDUCE_STREAK,
      acs: [ac("najat", { currentLevel: 4, slotCap: 4 })],
    }));
    expect(r.desiredLevels.najat).toBe(2);
  });

  it("intersects with a bounce cap — the lower wins", () => {
    const capped = computeAllocation(input({
      acs: [ac("najat", { slotCap: 4, bounceCap: 2 }), ac("abdu"), ac("abdullah")],
    }));
    expect(capped.desiredLevels.najat).toBe(2);
    const slotLower = computeAllocation(input({
      acs: [ac("najat", { slotCap: 2, bounceCap: 4 }), ac("abdu"), ac("abdullah")],
    }));
    expect(slotLower.desiredLevels.najat).toBe(2);
  });

  it("a slot cap of 1 still caps a level-0 AC at L1, never 0", () => {
    const r = computeAllocation(input({
      acs: [ac("najat", { currentLevel: 0, slotCap: 1 }), ac("abdu"), ac("abdullah")],
    }));
    expect(r.desiredLevels.najat).toBe(1);
  });

  it("the soft surplus pass respects the slot cap too", () => {
    // Surplus budget would soft-fill mild najat to max 3 — the slot cap holds it at 2.
    const r = computeAllocation(input({
      acs: [ac("najat", { needTier: "mild", slotCap: 2 }), ac("abdu"), ac("abdullah")],
    }));
    expect(r.desiredLevels.najat).toBe(2);
  });

  it("manualTarget above the slot cap wins — manual beats automation", () => {
    const r = computeAllocation(input({
      acs: [ac("najat", { slotCap: 1, manualTarget: 3 }), ac("abdu"), ac("abdullah")],
    }));
    expect(r.desiredLevels.najat).toBe(3);
  });
});

describe("computeAllocation — reachable caps (firmware-unreachable levels)", () => {
  it("never targets a level above the reachable cap in either pass", () => {
    const r = computeAllocation(input({
      acs: [ac("najat", { reachableCap: 2 }), ac("abdu"), ac("abdullah")],
    }));
    expect(r.desiredLevels.najat).toBe(2);
  });

  it("clamps a manualTarget the firmware cannot reach", () => {
    const r = computeAllocation(input({
      acs: [ac("najat", { manualTarget: 3, reachableCap: 2 }), ac("abdu"), ac("abdullah")],
    }));
    expect(r.desiredLevels.najat).toBe(2);
  });

  it("clamps a boost floor the firmware cannot reach", () => {
    const r = computeAllocation(input({
      acs: [ac("najat"), ac("abdu"), ac("abdullah", { minLevel: 3, currentLevel: 1, reachableCap: 2 })],
    }));
    expect(r.desiredLevels.abdullah).toBe(2);
  });

  it("clamps a warm-start jump to the reachable cap", () => {
    const r = computeAllocation(input({
      headroomStreak: 0, // raise gate closed — only the warm-start path may act
      acs: [ac("najat", { warmStartLevel: 3, reachableCap: 2 }), ac("abdu"), ac("abdullah")],
    }));
    expect(r.desiredLevels.najat).toBe(2);
  });

  it("a reachable cap of 1 still caps a level-0 AC at L1, never 0", () => {
    const r = computeAllocation(input({
      acs: [ac("najat", { currentLevel: 0, reachableCap: 1 }), ac("abdu"), ac("abdullah")],
    }));
    expect(r.desiredLevels.najat).toBe(1);
  });
});

describe("near-target band (hard L1 cap, 2026-06-11)", () => {
  it("hard-caps an AC within the band at L1 in both fill passes", () => {
    const r = computeAllocation(input({
      nearTargetBandC: 0.5,
      acs: [ac("najat", { needTier: "mild", needDelta: 0.3 })],
    }));
    // Budget is ample (29A) — the soft pass must NOT raise a near-target room.
    expect(r.idealLevels.najat).toBe(1);
  });

  it("fills toward max above the band — the mild ceil(max/2) cap is gone", () => {
    // 6-level max keeps the regression contrast sharp: the old mild cap was
    // ceil(6/2)=3, the fill must reach 6.
    const r = computeAllocation(input({
      nearTargetBandC: 0.5,
      acs: [ac("najat", { maxLevel: 6, needTier: "mild", needDelta: 0.6 })],
    }));
    expect(r.idealLevels.najat).toBe(6);
  });

  it("a hard boost floor still wins over the near-target L1 cap", () => {
    const r = computeAllocation(input({
      nearTargetBandC: 0.5,
      acs: [ac("najat", { needTier: "mild", needDelta: 0.3, minLevel: 2, currentLevel: 2 })],
    }));
    expect(r.idealLevels.najat).toBe(2);
  });

  it("manualTarget overrides the near-target cap", () => {
    const r = computeAllocation(input({
      nearTargetBandC: 0.5,
      acs: [ac("najat", { needTier: "mild", needDelta: 0.3, manualTarget: 3 })],
    }));
    expect(r.idealLevels.najat).toBe(3);
  });

  it("caps a satisfied room (delta ≤ 0) at L1 like before", () => {
    const r = computeAllocation(input({
      nearTargetBandC: 0.5,
      acs: [ac("najat", { needTier: "satisfied" })],
    }));
    expect(r.idealLevels.najat).toBe(1);
  });
});

describe("restore during a raise hold (2026-06-11)", () => {
  it("restores while a hold is active when the expectation leaves room", () => {
    const r = computeAllocation(input({
      limitAmps: 15,
      nonAcLoadAmps: 4,
      raiseHold: true,
      raiseHoldExpectedAmps: 6, // 4A non-AC + 2A restored floor of the prior batch
      acs: [
        ac("najat", { on: false, shed: true, needDelta: 3 }),
      ],
    }));
    // 6A expected + 2A floor ≤ 14A buffered limit → the restore need not wait
    // out the hold (waiting cost Abdu ~20 min off, live 2026-06-11).
    expect(r.toRestore).toEqual(["najat"]);
  });

  it("waits out the hold when the expectation leaves no room", () => {
    const r = computeAllocation(input({
      limitAmps: 15,
      nonAcLoadAmps: 4,
      raiseHold: true,
      raiseHoldExpectedAmps: 12,
      acs: [
        ac("abdu", { on: false, shed: true, needDelta: 3 }),
      ],
    }));
    // 12A expected + 4A floor > 14A → blocked until the hold releases.
    expect(r.toRestore).toEqual([]);
  });

  it("counts the batch's own reductions against the hold expectation", () => {
    // The live Abdullah-preemption shape: Abdullah was just raised to L3 (the
    // hold expectation includes his 4A draw), but the restore batch pulls him
    // back to his 2A floor in the same batch — those 2A of savings must count
    // toward the expectation check, or the restore wrongly waits out the hold.
    const restoreUnderHold = (expectedAmps: number) => computeAllocation(input({
      limitAmps: 15,
      nonAcLoadAmps: 5,
      raiseHold: true,
      raiseHoldExpectedAmps: expectedAmps,
      acs: [
        ac("abdullah", { currentLevel: 3, needDelta: 1.2 }),
        ac("abdu", { on: false, shed: true, needDelta: 3 }),
      ],
    }));
    // savings = est(L3) − est(L1) = 2A; Abdu's floor = 4A; buffered limit 14A.
    // Expectation 12: 12 − 2 + 4 = 14 ≤ 14 → fits (without the savings credit
    // this would read 16 > 14 and wrongly block).
    const fits = restoreUnderHold(12);
    expect(fits.toRestore).toEqual(["abdu"]);
    // The accompanying pull-to-floor ships in the same batch, and the fill is
    // skipped so it can't take the savings back.
    expect(fits.desiredLevels.abdullah).toBe(1);
    // Expectation 13: 13 − 2 + 4 = 15 > 14 → still waits out the hold.
    expect(restoreUnderHold(13).toRestore).toEqual([]);
  });

  it("warm-start raises are parked while a floor-feasible restore waits", () => {
    const r = computeAllocation(input({
      limitAmps: 15,
      nonAcLoadAmps: 4,
      headroomStreak: 0, // gates the restore (and ordinary raises)…
      acs: [
        ac("najat", { currentLevel: 1, warmStartLevel: 3, needDelta: 2 }),
        ac("abdu", { on: false, shed: true, needDelta: 3 }),
      ],
    }));
    // …but a warm-start raise skips the streak gate. While the shed AC's
    // restore is floor-feasible and merely gated, the warm raise must not
    // consume its headroom or arm a hold that pushes the restore out.
    expect(r.toRestore).toEqual([]);
    expect(r.desiredLevels.najat).toBeUndefined();
  });
});

// Meter-sized emergency cuts (severe over-limit fast path). Draw math with
// MODELS (maxLevel 3): najat/abdullah L1=2 L2=3 L3=4 L0=5; abdu L1=4 L2=6
// L3=8 L0=10. Priority order in acs: najat (top, protected) > abdu > abdullah.
describe("computeEmergencyReduction", () => {
  function eInput(over: Partial<EmergencyInput> = {}): EmergencyInput {
    return {
      limitAmps: 30,
      marginAmps: 1,
      nonAcLoadAmps: 0,
      requiredSavingsAmps: 1,
      acs: [ac("najat"), ac("abdu"), ac("abdullah")],
      ampModels: MODELS,
      ...over,
    };
  }

  it("drops the least-needy AC's levels first and stops once the required savings are met", () => {
    const r = computeEmergencyReduction(eInput({
      requiredSavingsAmps: 2,
      acs: [
        ac("najat", { needDelta: 2 }),
        ac("abdu", { currentLevel: 3, needDelta: 2 }),
        ac("abdullah", { currentLevel: 3, needDelta: 0.5 }),
      ],
    }));
    // Abdullah (least needy): L3→L2 (1A) → L2→L1 (1A) = 2A — abdu untouched.
    expect(r.desiredLevels).toEqual({ abdullah: 1 });
    expect(r.toFanReduce).toEqual([]);
    expect(r.toShed).toEqual([]);
    expect(r.toRestore).toEqual([]);
    expect(r.toFanRaise).toBeNull();
    expect(r.estimatedSavingsAmps).toBe(2);
    expect(r.satisfied).toBe(true);
  });

  it("prefers a level-down over a shed when the learned cost credits it (Fix D)", () => {
    // Single abdu at L2. The static model step (2A) makes one L2→L1 look too
    // small to cover the 3A target → the optimizer sheds (turns the AC OFF).
    const acs = [ac("abdu", { currentLevel: 2, needDelta: 1 })];
    const modelOnly = computeEmergencyReduction(eInput({ requiredSavingsAmps: 3, acs }));
    expect(modelOnly.toShed).toEqual(["abdu"]);
    expect(modelOnly.desiredLevels.abdu).toBeUndefined();
    // With the learned REAL cost (3.5A/level) the level-down covers → no shed.
    const learned = computeEmergencyReduction(eInput({
      requiredSavingsAmps: 3, acs, raiseSurge: { abdu: 3.5 },
    }));
    expect(learned.toShed).toEqual([]);
    expect(learned.desiredLevels).toEqual({ abdu: 1 });
  });

  it("still sheds when everyone is at floor and floors exceed the target (Fix D safe)", () => {
    // At L1 floor there is no level-down to credit — a shed is genuinely the
    // only lever, learned cost or not.
    const acs = [ac("abdu", { currentLevel: 1, needDelta: 0 })];
    const r = computeEmergencyReduction(eInput({
      requiredSavingsAmps: 3, acs, raiseSurge: { abdu: 3.5 },
    }));
    expect(r.toShed).toEqual(["abdu"]);
  });

  it("moves to the next AC's levels when the first reaches its floor", () => {
    const r = computeEmergencyReduction(eInput({
      requiredSavingsAmps: 3,
      acs: [
        ac("najat", { needDelta: 2 }),
        ac("abdu", { currentLevel: 3, needDelta: 1 }),
        ac("abdullah", { currentLevel: 2, needDelta: 0.5 }),
      ],
    }));
    // Abdullah L2→L1 (1A) hits floor; abdu L3→L2 (2A) covers the rest.
    expect(r.desiredLevels).toEqual({ abdullah: 1, abdu: 2 });
    expect(r.estimatedSavingsAmps).toBe(3);
    expect(r.satisfied).toBe(true);
  });

  it("cuts the top-priority AC's levels only after every other AC is at its floor", () => {
    const acs = [
      ac("najat", { currentLevel: 2, needDelta: 1 }),
      ac("abdu", { currentLevel: 2, needDelta: 1 }),
      ac("abdullah", { currentLevel: 2, needDelta: 1 }),
    ];
    // Others cover 3A (abdullah 1 + abdu 2) — najat untouched at 3A required…
    const spared = computeEmergencyReduction(eInput({ requiredSavingsAmps: 3, acs }));
    expect(spared.desiredLevels.najat).toBeUndefined();
    expect(spared.desiredLevels).toEqual({ abdullah: 1, abdu: 1 });
    // …but at 3.5A she is the only level cut left.
    const cut = computeEmergencyReduction(eInput({ requiredSavingsAmps: 3.5, acs }));
    expect(cut.desiredLevels.najat).toBe(1);
  });

  it("adds fan drops in the same batch when floors aren't enough", () => {
    const r = computeEmergencyReduction(eInput({
      requiredSavingsAmps: 1,
      acs: [
        ac("najat", { needDelta: 2 }),
        ac("abdu", { fanSpeed: 3, needDelta: 1 }),
        ac("abdullah", { fanSpeed: 0, needDelta: 0.5 }), // built-in auto counts as reducible
      ],
    }));
    // Everyone at L1 floors — two 0.5A fan drops cover the 1A in ONE batch.
    expect(r.desiredLevels).toEqual({});
    expect(r.toFanReduce).toEqual(["abdullah", "abdu"]);
    expect(r.toShed).toEqual([]);
    expect(r.estimatedSavingsAmps).toBe(2 * FAN_REDUCE_SAVINGS_AMPS);
    expect(r.satisfied).toBe(true);
  });

  it("skips fan-exempt, fan-unknown, and fan-already-1 ACs in the fan phase", () => {
    const r = computeEmergencyReduction(eInput({
      requiredSavingsAmps: 0.5,
      acs: [
        ac("najat", { fanSpeed: 1 }),
        ac("abdu", { fanSpeed: 5, fanExempt: true }),
        ac("abdullah", { fanSpeed: null }),
        ac("extra", { fanSpeed: 4, needDelta: 3 }),
      ],
    }));
    expect(r.toFanReduce).toEqual(["extra"]);
  });

  it("best-fit final step: a sub-fan-sized remainder takes a fan drop, not a level step", () => {
    const acs = [
      ac("najat", { fanSpeed: 3, needDelta: 2 }),
      ac("abdu", { currentLevel: 3, needDelta: 1 }),
      ac("abdullah", { needDelta: 0.5 }),
    ];
    // 0.4A remainder ≤ one fan (0.5A) → the 2A abdu level step is spared.
    const fan = computeEmergencyReduction(eInput({ requiredSavingsAmps: 0.4, acs }));
    expect(fan.desiredLevels).toEqual({});
    expect(fan.toFanReduce).toEqual(["najat"]);
    expect(fan.estimatedSavingsAmps).toBe(FAN_REDUCE_SAVINGS_AMPS);
    // No fan available → the level step is the only cut that covers it.
    const noFan = computeEmergencyReduction(eInput({
      requiredSavingsAmps: 0.4,
      acs: acs.map((a) => ({ ...a, fanSpeed: 1 })),
    }));
    expect(noFan.desiredLevels).toEqual({ abdu: 2 });
    expect(noFan.toFanReduce).toEqual([]);
  });

  it("keeps cuts-only when the cut capacity exactly covers the target", () => {
    const r = computeEmergencyReduction(eInput({
      requiredSavingsAmps: 4,
      acs: [
        ac("najat", { needDelta: 2 }),
        ac("abdu", { currentLevel: 3, needDelta: 1 }),
        ac("abdullah", { needDelta: 0.5 }),
      ],
    }));
    // Abdu L3→L1 = exactly 4A — fixable with cuts alone, so no shed enters
    // ("if it can be fixed with just reduce levels/fan, let it do").
    expect(r.desiredLevels).toEqual({ abdu: 1 });
    expect(r.toShed).toEqual([]);
    expect(r.satisfied).toBe(true);
  });

  it("incident regression: a sufficient shed rides in the SAME batch, skipping insufficient ACs", () => {
    // The live 2026-06-12 18A gen incident shape: everyone at floors, only
    // fans left (1.5A) against a 4.4A target. The old staging shipped the
    // knowably-insufficient fans, waited a fresh streak, shed the least-needy
    // AC (whose savings couldn't cover it either), waited again, then shed
    // the right one — 3 batches where 1 sufficed.
    const r = computeEmergencyReduction(eInput({
      requiredSavingsAmps: 4.4,
      acs: [
        ac("najat", { fanSpeed: 3, needDelta: 2 }),
        ac("abdu", { fanSpeed: 3, needDelta: 1 }),
        ac("abdullah", { fanSpeed: 3, needDelta: 0.5 }),
      ],
    }));
    // Abdullah (least needy, 2A) can't cover 4.4A even with the others' fans
    // (3A total) — skipped. Abdu (4A + 1A of fans) can — shed directly, in
    // the same batch as the one fan drop that covers the 0.4A remainder.
    expect(r.toShed).toEqual(["abdu"]);
    expect(r.toFanReduce).toEqual(["abdullah"]);
    expect(r.desiredLevels).toEqual({});
    expect(r.estimatedSavingsAmps).toBe(4.5);
    expect(r.satisfied).toBe(true);
  });

  it("sub-fan shortfall still sheds — the user's any-shortfall rule", () => {
    // 1.7A required vs 1.5A of fans: cuts knowably can't cover it, so the
    // least-needy SUFFICIENT AC is shed instead (no staged escalation).
    const r = computeEmergencyReduction(eInput({
      requiredSavingsAmps: 1.7,
      acs: [
        ac("najat", { fanSpeed: 3, needDelta: 2 }),
        ac("abdu", { fanSpeed: 3, needDelta: 1 }),
        ac("abdullah", { fanSpeed: 3, needDelta: 0.5 }),
      ],
    }));
    // Abdullah (least needy, 2A ≥ 1.7A) suffices alone — no fan drops needed.
    expect(r.toShed).toEqual(["abdullah"]);
    expect(r.toFanReduce).toEqual([]);
    expect(r.desiredLevels).toEqual({});
    expect(r.satisfied).toBe(true);
  });

  it("the top-priority AC is never single-picked while a non-top combination covers", () => {
    // Abdu is top here (6A at L2 — alone sufficient for the 6A target), but
    // protection wins: the non-top pair + abdu's level cut cover it instead.
    const r = computeEmergencyReduction(eInput({
      requiredSavingsAmps: 6,
      acs: [
        ac("abdu", { currentLevel: 2, needDelta: 2 }),
        ac("najat", { needDelta: 1 }),
        ac("abdullah", { needDelta: 0.5 }),
      ],
    }));
    expect(r.toShed).toEqual(["abdullah", "najat"]);
    expect(r.desiredLevels).toEqual({ abdu: 1 });
    expect(r.estimatedSavingsAmps).toBe(6);
    expect(r.satisfied).toBe(true);
  });

  it("counts a pre-pass level-0 AC's savings once at full draw when it is shed", () => {
    const r = computeEmergencyReduction(eInput({
      requiredSavingsAmps: 12,
      acs: [
        ac("najat", { needDelta: 2 }),
        ac("abdu", { currentLevel: 0, needDelta: 1 }),
        ac("abdullah", { needDelta: 0.5 }),
      ],
    }));
    // Abdu's never-level-0 pre-pass credited 2A (L0 10 → L3 8); shedding him
    // must yield his full 10A observed draw, not 10+2 stacked. 2 + 10 = 12.
    expect(r.toShed).toEqual(["abdullah", "abdu"]);
    expect(r.desiredLevels).toEqual({}); // the pre-pass cap never ships for a shed AC
    expect(r.estimatedSavingsAmps).toBe(12);
    expect(r.satisfied).toBe(true);
  });

  it("sheds the least-needy AC when nothing else is reducible", () => {
    const r = computeEmergencyReduction(eInput({
      requiredSavingsAmps: 2,
      acs: [
        ac("najat", { needDelta: 2 }),
        ac("abdu", { needDelta: 0.2 }),
        ac("abdullah", { needDelta: 1 }),
      ],
    }));
    // Everyone at L1/fan-1 — abdu (least needy, 4A at L1) covers the 2A alone.
    expect(r.desiredLevels).toEqual({});
    expect(r.toFanReduce).toEqual([]);
    expect(r.toShed).toEqual(["abdu"]);
    expect(r.satisfied).toBe(true);
  });

  it("sheds multiple ACs for a large overshoot; the top-priority AC only as last resort", () => {
    const acs = [
      ac("najat", { needDelta: 2 }),
      ac("abdu", { needDelta: 0.2 }),
      ac("abdullah", { needDelta: 1 }),
    ];
    const two = computeEmergencyReduction(eInput({ requiredSavingsAmps: 5, acs }));
    expect(two.toShed).toEqual(["abdu", "abdullah"]); // 4A + 2A ≥ 5A — najat protected
    const all = computeEmergencyReduction(eInput({ requiredSavingsAmps: 12, acs }));
    expect(all.toShed).toEqual(["abdu", "abdullah", "najat"]);
    expect(all.satisfied).toBe(false); // 8A total < 12A — everything cut, still short
    expect(all.desiredLevels).toEqual({}); // shed ACs get no level/fan commands
    expect(all.toFanReduce).toEqual([]);
  });

  it("never cuts below a boost floor via levels — the next AC continues instead", () => {
    const r = computeEmergencyReduction(eInput({
      requiredSavingsAmps: 3,
      acs: [
        ac("najat", { needDelta: 2 }),
        ac("abdu", { currentLevel: 2, needDelta: 1 }),
        ac("abdullah", { currentLevel: 3, minLevel: 2, needDelta: 0.5 }),
      ],
    }));
    // Abdullah (least needy) stops at his L2 boost floor with savings still
    // owed — the remainder comes from abdu's level, never from below a floor.
    expect(r.desiredLevels).toEqual({ abdullah: 2, abdu: 1 });
    expect(r.toShed).toEqual([]);
    expect(r.satisfied).toBe(true);
  });

  it("caps a level-0 unrestricted AC with the smallest cut regardless of the savings target", () => {
    const r = computeEmergencyReduction(eInput({
      requiredSavingsAmps: 0.1,
      acs: [
        ac("najat", { currentLevel: 0, needDelta: 2 }),
        ac("abdu", { needDelta: 1 }),
        ac("abdullah", { needDelta: 0.5 }),
      ],
    }));
    // Never-level-0 is a hard rule — but the re-entry is the TOP commandable
    // level (L3), not the floor: the invariant alone must not over-reduce.
    expect(r.desiredLevels).toEqual({ najat: 3 });
    expect(r.estimatedSavingsAmps).toBe(1); // draw(0)=5 − draw(3)=4
    expect(r.satisfied).toBe(true);
  });

  it("honors reachable and slot caps for the level-0 re-entry", () => {
    const r = computeEmergencyReduction(eInput({
      requiredSavingsAmps: 0.1,
      acs: [
        ac("najat", { currentLevel: 0, reachableCap: 2, needDelta: 2 }),
        ac("abdu", { currentLevel: 0, slotCap: 1, needDelta: 1 }),
        ac("abdullah", { needDelta: 0.5 }),
      ],
    }));
    expect(r.desiredLevels.najat).toBe(2); // firmware can't hold L3
    expect(r.desiredLevels.abdu).toBe(1); // slot cap is a hard ceiling
  });

  it("ignores off, unmanaged, and already-shed ACs", () => {
    const r = computeEmergencyReduction(eInput({
      requiredSavingsAmps: 5,
      acs: [
        ac("najat", { on: false }),
        ac("abdu", { managed: false, currentLevel: 3 }),
        ac("abdullah", { shed: true }),
      ],
    }));
    expect(r.desiredLevels).toEqual({});
    expect(r.toFanReduce).toEqual([]);
    expect(r.toShed).toEqual([]);
    expect(r.satisfied).toBe(false);
  });
});

describe("selectReduction — cost-aware, need-based protection (the live complaint)", () => {
  // acs are pre-sorted by priority, highest first. The live config protected the
  // top-priority (cool) room and shed the user's hot AC. The optimizer is
  // need-based: it sheds the rooms that need cooling LEAST, keeping the hot one.
  it("sheds two cool rooms — incl. the top-priority one — before the hot user's AC", () => {
    const acs = [
      ac("abdullah", { needDelta: -0.5 }), // top priority but SATISFIED
      ac("najat", { needDelta: -0.5 }),     // satisfied
      ac("abdu", { needDelta: 2.5 }),        // HOT — the user's room (4A at L1)
    ];
    // All at L1 floors → only sheds available; budget shortfall ~4A.
    const plan = selectReduction(acs, 4, { ampModels: MODELS });
    expect(plan.toShed).not.toContain("abdu");          // hot room kept running
    expect([...plan.toShed].sort()).toEqual(["abdullah", "najat"]);
    expect(plan.satisfied).toBe(true);
  });

  it("levels a hot room down rather than turning any room off when leveling covers", () => {
    const acs = [
      ac("abdullah", { currentLevel: 1, needDelta: -0.5 }),
      ac("najat", { currentLevel: 1, needDelta: -0.5 }),
      ac("abdu", { currentLevel: 3, needDelta: 2.5 }), // hot at L3 (8A)
    ];
    // 2A needed → abdu L3→L2 saves 2A; no room is shed (prefer level over off).
    const plan = selectReduction(acs, 2, { ampModels: MODELS });
    expect(plan.toShed).toEqual([]);
    expect(plan.desiredLevels).toEqual({ abdu: 2 });
  });

  it("sheds the big AC when it is the most SATISFIED room (need decides, not size)", () => {
    const acs = [
      ac("najat", { needDelta: 2 }),     // hot
      ac("abdu", { needDelta: -1 }),     // big but SATISFIED → shed it
      ac("abdullah", { needDelta: 1.5 }),
    ];
    const plan = selectReduction(acs, 3, { ampModels: MODELS });
    expect(plan.toShed).toEqual(["abdu"]);
  });

  it("never leaves a managed AC at level 0 and never cuts below a boost floor", () => {
    const acs = [
      ac("najat", { currentLevel: 0, needDelta: 1 }),               // unrestricted → re-capped
      ac("abdu", { currentLevel: 3, minLevel: 2, needDelta: 1 }),   // boost floor L2
      ac("abdullah", { currentLevel: 2, needDelta: 1 }),
    ];
    const plan = selectReduction(acs, 1, { ampModels: MODELS });
    expect(plan.toShed).not.toContain("najat");
    expect(plan.idealLevels.najat).toBeGreaterThan(0);       // never level 0
    if (plan.idealLevels.abdu != null) expect(plan.idealLevels.abdu).toBeGreaterThanOrEqual(2);
  });

  it("when even cutting everything falls short, reports unsatisfied with max savings", () => {
    const acs = [ac("najat", { needDelta: 1 }), ac("abdu", { needDelta: 1 }), ac("abdullah", { needDelta: 1 })];
    const plan = selectReduction(acs, 99, { ampModels: MODELS });
    expect(plan.satisfied).toBe(false);
    expect([...plan.toShed].sort()).toEqual(["abdu", "abdullah", "najat"]);
  });
});

describe("one-step + surge-gated raises (gen)", () => {
  it("maxRaiseStep paces the COMMAND to one level while the ideal stays the full target", () => {
    const res = computeAllocation(input({
      acs: [ac("abdu", { currentLevel: 1, needTier: "full", needDelta: 3 })],
      nonAcLoadAmps: 0,
      maxRaiseStep: 1,
    }));
    expect(res.idealLevels.abdu).toBe(3); // fitted equilibrium unchanged
    expect(res.desiredLevels.abdu).toBe(2); // commanded one step at a time
  });

  it("without maxRaiseStep raises still command straight to the fitted ideal", () => {
    const res = computeAllocation(input({
      acs: [ac("abdu", { currentLevel: 1, needTier: "full", needDelta: 3 })],
      nonAcLoadAmps: 0,
    }));
    expect(res.idealLevels.abdu).toBe(3);
    expect(res.desiredLevels.abdu).toBe(3);
  });

  it("maxRaiseStep keeps an AC at its current top level (no spurious reduction)", () => {
    const res = computeAllocation(input({
      acs: [ac("abdu", { currentLevel: 3, needTier: "full", needDelta: 3 })],
      nonAcLoadAmps: 0,
      maxRaiseStep: 1,
    }));
    expect(res.idealLevels.abdu).toBe(3);
    expect(res.desiredLevels.abdu).toBeUndefined();
  });

  it("maxRaiseStep does not stage reductions (reduces fully in one batch)", () => {
    const res = computeAllocation(input({
      acs: [ac("abdu", { currentLevel: 3, needTier: "full", needDelta: 3 })],
      nonAcLoadAmps: 24,
      forceEvaluate: true,
      maxRaiseStep: 1,
    }));
    expect(res.idealLevels.abdu).toBe(1);
    expect(res.desiredLevels.abdu).toBe(1);
  });

  it("raiseSurge blocks a raise the real surge would not fit, even when the model step would", () => {
    const base = {
      acs: [ac("abdu", { currentLevel: 1, needTier: "full" as const, needDelta: 3 })],
      nonAcLoadAmps: 22, // budget = 30 - 1 - 22 = 7; abdu L1 = 4A → 3A headroom
    };
    const withModel = computeAllocation(input(base));
    expect(withModel.idealLevels.abdu).toBe(2); // model step 2 ≤ 3 → raises
    const withSurge = computeAllocation(input({ ...base, raiseSurge: { abdu: 5 } }));
    expect(withSurge.idealLevels.abdu).toBe(1); // real surge 5 > 3 → holds
  });

  it("raiseSurge charges only above-current steps; re-fill to current uses the model", () => {
    const res = computeAllocation(input({
      acs: [ac("abdu", { currentLevel: 2, needTier: "full", needDelta: 3 })],
      nonAcLoadAmps: 23, // budget = 30 - 1 - 23 = 6 = abdu L2 model cost exactly
      raiseSurge: { abdu: 5 },
    }));
    expect(res.idealLevels.abdu).toBe(2); // holds at L2, not dropped
    expect(res.desiredLevels.abdu).toBeUndefined();
  });
});

describe("computeAllocation — ramp clamp (rampMeterFits, 2026-07-06)", () => {
  // A peer's power flip forces evaluation mid-ramp, where the model fill (not
  // the meter) computes targets — its chronic error then "reduced" ACs the
  // meter had room for, bouncing Abdullah L3↔L2 on every Najat on/off cycle.
  const acs = [
    ac("najat", { currentLevel: 3 }),
    ac("abdu", { currentLevel: 3 }),
  ];

  it("holds current levels when the ramp-projected meter fits (no over-limit evidence)", () => {
    const r = computeAllocation(input({
      acs,
      nonAcLoadAmps: 20, // model fill wants najat 2 / abdu 2 — a phantom reduce
      forceEvaluate: true,
      headroomStreak: 0,
      rampMeterFits: true,
    }));
    expect(r.desiredLevels).toEqual({});
    expect(r.toShed).toEqual([]);
  });

  it("still reduces on the same inputs without the clamp (pre-fix behavior)", () => {
    const r = computeAllocation(input({
      acs,
      nonAcLoadAmps: 20,
      forceEvaluate: true,
      headroomStreak: 0,
    }));
    expect(r.desiredLevels).toEqual({ najat: 2, abdu: 2 });
  });

  it("over-limit evidence overrides the clamp (safety net stays live)", () => {
    const r = computeAllocation(input({
      acs,
      nonAcLoadAmps: 20,
      overLimitStreak: REDUCE_STREAK,
      headroomStreak: 0,
      rampMeterFits: true,
    }));
    expect(r.desiredLevels).toEqual({ najat: 2, abdu: 2 });
  });

  it("cap-driven reductions (slot cap) still fire under the clamp", () => {
    const r = computeAllocation(input({
      acs: [ac("najat", { currentLevel: 3, slotCap: 1 })],
      nonAcLoadAmps: 5,
      forceEvaluate: true,
      headroomStreak: 0,
      rampMeterFits: true,
    }));
    expect(r.desiredLevels).toEqual({ najat: 1 });
  });
});
