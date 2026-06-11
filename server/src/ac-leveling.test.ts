import { describe, it, expect } from "vitest";
import {
  computeAllocation,
  estimateAcDraw,
  determineSource,
  computeNeedTier,
  needCap,
  REDUCE_STREAK,
  REDUCE_STREAK_SEVERE,
  RAISE_STREAK,
  type AllocatorInput,
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
    maxLevel: id === "najat" ? 6 : 3,
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
    // budget 29: najat L6 (7) + abdu L3 (8) + abdullah L3 (4) = 19
    expect(r.idealLevels).toEqual({ najat: 6, abdu: 3, abdullah: 3 });
    expect(r.budgetAmps).toBe(29);
  });

  it("jumps straight to the ideal allocation when headroom is sustained", () => {
    const r = computeAllocation(input());
    expect(r.desiredLevels).toEqual({ najat: 6, abdu: 3, abdullah: 3 });
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

  it("honors the buffer for restore feasibility", () => {
    // Najat (managed, shed, off) floor L1 = 2. One ON Abdullah at floor 2.
    // budget = 15 − 1 − 9 = 5; cost so far 2 → restore needs 2 more = 4 ≤ 5 OK
    // without buffer, but raiseBudget 5−2 = 3 < 4 → blocked with buffer 2.
    const acs = [
      ac("abdullah", { on: true, currentLevel: 2, minLevel: 2, needTier: "satisfied" }),
      ac("najat", { on: false, shed: true, needTier: "full", needDelta: 3 }),
    ];
    const blocked = computeAllocation(input({
      limitAmps: 15, nonAcLoadAmps: 9, raiseBufferAmps: 2, acs,
    }));
    expect(blocked.toRestore).toEqual([]);
    // Drop the buffer → restore fits.
    const fits = computeAllocation(input({
      limitAmps: 15, nonAcLoadAmps: 9, raiseBufferAmps: 0, acs,
    }));
    expect(fits.toRestore).toEqual(["najat"]);
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
    const r = computeAllocation(input({
      headroomStreak: 0,
      acs: [ac("najat", { currentLevel: 1, warmStartLevel: 4 })],
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
      acs: [ac("najat", { currentLevel: 1, warmStartLevel: 4 })],
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
    // budget 29: surplus lets mild najat soft-fill past its need cap (3) to max
    expect(r.idealLevels).toEqual({ najat: 6, abdu: 1, abdullah: 3 });
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
    const r = computeAllocation(input({
      acs: [ac("najat", { needTier: "satisfied", manualTarget: 4 }), ac("abdu"), ac("abdullah")],
    }));
    expect(r.idealLevels.najat).toBe(4);
  });

  it("clamps manual targets to the device max level", () => {
    const r = computeAllocation(input({
      acs: [ac("abdullah", { manualTarget: 9 }), ac("najat"), ac("abdu")],
    }));
    expect(r.idealLevels.abdullah).toBe(3);
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
    expect(r.desiredLevels.najat).toBe(6);
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
  it("sheds lowest-priority ACs until the L1 base fits", () => {
    const r = computeAllocation(input({
      limitAmps: 15,
      nonAcLoadAmps: 9,
      overLimitStreak: REDUCE_STREAK,
      headroomStreak: 0,
    }));
    // budget 5: L1 sum 8 → shed abdullah (6 > 5) → shed abdu (2 ≤ 5)
    expect(r.toShed).toEqual(["abdullah", "abdu"]);
    expect(r.idealLevels.najat).toBe(1);
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

  it("blocks restore without sustained headroom or during settle", () => {
    const base = {
      acs: [ac("najat"), ac("abdu"), ac("abdullah", { on: false, shed: true })],
    };
    expect(computeAllocation(input({ ...base, headroomStreak: RAISE_STREAK - 1 })).toRestore).toEqual([]);
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
});

describe("computeAllocation — raise-miss hold", () => {
  it("blocks raises while the hold is active", () => {
    const r = computeAllocation(input({ raiseHold: true }));
    // budget 29 would normally raise everyone to the ideal — hold gates it
    expect(r.desiredLevels).toEqual({});
    expect(r.idealLevels).toEqual({ najat: 6, abdu: 3, abdullah: 3 });
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
      limitAmps: 15, nonAcLoadAmps: 3, acs, headroomStreak: RAISE_STREAK - 1,
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
    // unmanaged abdu at L0 = 10A fixed → budget 19; najat L6 (7) + abdullah L3 (4) = 11
    expect(r.budgetAmps).toBe(19);
    expect(r.idealLevels).toEqual({ najat: 6, abdullah: 3 });
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
    const r = computeAllocation(input({
      acs: [
        ac("najat", { needTier: "mild" }),
        ac("abdu", { needTier: "mild" }),
        ac("abdullah", { needTier: "mild" }),
      ],
    }));
    // budget 29: need caps {3,2,2} cost 4+6+3=13, surplus soft-fills all to max
    expect(r.idealLevels).toEqual({ najat: 6, abdu: 3, abdullah: 3 });
  });

  it("never soft-fills past a manual target", () => {
    const r = computeAllocation(input({
      acs: [ac("najat", { needTier: "mild", manualTarget: 4 }), ac("abdu"), ac("abdullah")],
    }));
    // surplus budget, but the user's explicit pick stays the ceiling
    expect(r.idealLevels.najat).toBe(4);
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
    // ac() defaults to fanSpeed 1 — not reducible
    expect(r.toFanReduce).toEqual([]);
    expect(r.toShed).toEqual(["abdullah", "abdu"]);
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
    expect(r.idealLevels).toEqual({ najat: 6, abdu: 1, abdullah: 3 });
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
    // Mild tier caps najat at ceil(6/2)=3; surplus budget would soft-fill to 6
    // — the slot cap holds it at 4.
    const r = computeAllocation(input({
      acs: [ac("najat", { needTier: "mild", slotCap: 4 }), ac("abdu"), ac("abdullah")],
    }));
    expect(r.desiredLevels.najat).toBe(4);
  });

  it("manualTarget above the slot cap wins — manual beats automation", () => {
    const r = computeAllocation(input({
      acs: [ac("najat", { slotCap: 2, manualTarget: 5 }), ac("abdu"), ac("abdullah")],
    }));
    expect(r.desiredLevels.najat).toBe(5);
  });
});

describe("computeAllocation — reachable caps (firmware-unreachable levels)", () => {
  it("never targets a level above the reachable cap in either pass", () => {
    const r = computeAllocation(input({
      acs: [ac("najat", { reachableCap: 5 }), ac("abdu"), ac("abdullah")],
    }));
    expect(r.desiredLevels.najat).toBe(5);
  });

  it("clamps a manualTarget the firmware cannot reach", () => {
    const r = computeAllocation(input({
      acs: [ac("najat", { manualTarget: 6, reachableCap: 5 }), ac("abdu"), ac("abdullah")],
    }));
    expect(r.desiredLevels.najat).toBe(5);
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
      acs: [ac("najat", { warmStartLevel: 6, reachableCap: 4 }), ac("abdu"), ac("abdullah")],
    }));
    expect(r.desiredLevels.najat).toBe(4);
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
    const r = computeAllocation(input({
      nearTargetBandC: 0.5,
      acs: [ac("najat", { needTier: "mild", needDelta: 0.6 })],
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
