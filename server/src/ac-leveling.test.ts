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
  it("caps satisfied rooms at L1 and mild rooms at half max", () => {
    const r = computeAllocation(input({
      acs: [
        ac("najat", { needTier: "mild" }),
        ac("abdu", { needTier: "satisfied" }),
        ac("abdullah", { needTier: "full" }),
      ],
    }));
    expect(r.idealLevels).toEqual({ najat: 3, abdu: 1, abdullah: 3 });
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
