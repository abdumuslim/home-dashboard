import { describe, it, expect } from "vitest";
import {
  computeAllocation,
  estimateAcDraw,
  determineSource,
  computeNeedTier,
  needCap,
  REDUCE_STREAK,
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
    nonAcLoadAmps: 0,
    overLimitStreak: 0,
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

describe("computeAllocation — staged fan restore", () => {
  it("raises the highest-priority pending hold one step", () => {
    const r = computeAllocation(input({
      acs: [
        ac("najat", { fanSpeed: 1, fanRestoreTarget: 4 }),
        ac("abdu", { fanSpeed: 1, fanRestoreTarget: 3 }),
        ac("abdullah"),
      ],
    }));
    expect(r.toFanRaise).toEqual({ deviceId: "najat", fan: 2 });
  });

  it("restores an auto-fan hold straight to 0", () => {
    const r = computeAllocation(input({
      acs: [ac("najat", { fanSpeed: 1, fanRestoreTarget: 0 }), ac("abdu"), ac("abdullah")],
    }));
    expect(r.toFanRaise).toEqual({ deviceId: "najat", fan: 0 });
  });

  it("clamps the final step to the target", () => {
    const r = computeAllocation(input({
      acs: [ac("najat", { fanSpeed: 3, fanRestoreTarget: 4 }), ac("abdu"), ac("abdullah")],
    }));
    expect(r.toFanRaise).toEqual({ deviceId: "najat", fan: 4 });
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
    expect(r.toFanRaise).toEqual({ deviceId: "najat", fan: 2 });
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
