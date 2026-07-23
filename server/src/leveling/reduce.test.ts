import { describe, it, expect } from "vitest";
import { planReduction, type ReduceInput } from "./reduce.js";
import { updateCost, type CostBook } from "./costs.js";
import { DEFAULT_LEVELING_CONFIG_V2, type LevelingConfigV2 } from "./config.js";
import type { AcView } from "./types.js";

const T = 1_000_000;

// Simple models: every AC base 2, step 2 → each level step worth 2A (model).
const cfg: LevelingConfigV2 = {
  ...DEFAULT_LEVELING_CONFIG_V2,
  genLimitAmps: 15,
  marginAmps: 0.1,
  ampModels: {
    hot: { baseAmps: 2, stepAmps: 2 },
    cool: { baseAmps: 2, stepAmps: 2 },
    third: { baseAmps: 2, stepAmps: 2 },
  },
};

function ac(id: string, overrides: Partial<AcView> = {}): AcView {
  return {
    deviceId: id,
    name: id,
    on: true,
    managed: true,
    shed: false,
    maxLevel: 3,
    currentLevel: 2,
    fanSpeed: 5,
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

function plan(acs: AcView[], requiredAmps: number, overrides: Partial<ReduceInput> = {}) {
  return planReduction({
    acs,
    requiredAmps,
    requireShed: false,
    fanTrimEnabled: true,
    book: {},
    config: cfg,
    source: "gen",
    now: T,
    ...overrides,
  });
}

describe("levels before fans (user complaint B — 57% of v1 fan cuts fired with level cuts available)", () => {
  it("a small overshoot on an above-floor AC cuts ONE level, never a fan", () => {
    const p = plan([ac("hot", { currentLevel: 3 })], 1.5);
    expect(p.desiredLevels.hot).toBe(2);
    expect(p.fanCuts).toHaveLength(0);
    expect(p.satisfied).toBe(true);
  });

  it("the 7-pass fan cascade scenario: AC at L3, ~2A over → level cut in ONE batch", () => {
    // v1 live 07-23 05:22: ratcheted Abdu's fan 7→1 in 7 emergency passes while he sat at L3.
    const p = plan([ac("hot", { currentLevel: 3, fanSpeed: 7 })], 2.0);
    expect(p.desiredLevels.hot).toBe(2);
    expect(p.fanCuts).toHaveLength(0);
  });

  it("fan trim only fires when the AC is at floor and the residual is small", () => {
    const p = plan([ac("hot", { currentLevel: 1, fanSpeed: 5 })], 0.3);
    expect(p.desiredLevels).toEqual({});
    expect(p.toShed).toHaveLength(0);
    expect(p.fanCuts.length).toBeGreaterThan(0);
    expect(p.fanCuts[0].deviceId).toBe("hot");
  });

  it("fanTrimEnabled=false removes fans entirely (escalates to shed when levels can't cover)", () => {
    const p = plan([ac("cool", { currentLevel: 1, fanSpeed: 7, needDelta: 0.2 })], 0.4, {
      fanTrimEnabled: false,
    });
    expect(p.fanCuts).toHaveLength(0);
    expect(p.toShed).toEqual(["cool"]);
  });

  it("a fan-exempt AC (user touched the fan) is never trimmed", () => {
    const p = plan([ac("hot", { currentLevel: 1, fanSpeed: 7, fanExempt: true, needDelta: 0.2 })], 0.3);
    expect(p.fanCuts).toHaveLength(0);
  });
});

describe("graduated cuts + learned costs (the 4.3A-shed-for-0.3A regression)", () => {
  it("a learned-cost level-down beats a shed when it covers the target", () => {
    // Model step is 2A; required 3.0A. Without learning, one step can't cover
    // → the search would need two steps or a shed. With the learned hot-case
    // jump (3.8A), ONE level cut covers.
    const book: CostBook = updateCost({}, "hot", "gen", "level:1>2", 3.8, T);
    const p = plan([ac("hot", { currentLevel: 2 }), ac("cool", { currentLevel: 1, needDelta: 0.2 })], 3.0, { book });
    expect(p.toShed).toHaveLength(0);
    expect(p.desiredLevels.hot).toBe(1);
    expect(p.satisfied).toBe(true);
  });

  it("cuts are graduated — a mild target takes one step, not floor-everyone", () => {
    const p = plan([ac("hot", { currentLevel: 3 }), ac("cool", { currentLevel: 3, needDelta: 0.5 })], 1.8);
    // One AC steps down one level (2A model) — the other is untouched.
    const changed = Object.keys(p.desiredLevels);
    expect(changed).toHaveLength(1);
    expect(p.idealLevels[changed[0]]).toBe(2);
  });
});

describe("shed selection (need-based protection, ported v1 semantics)", () => {
  it("sheds the most-satisfied room, keeps the hot one — even against priority", () => {
    // Both at floor, no fan slack; required exceeds all cut capacity → shed.
    const coolTop = ac("cool", { currentLevel: 1, fanSpeed: 1, needDelta: 0.1 });
    const hotLow = ac("hot", { currentLevel: 1, fanSpeed: 1, needDelta: 4 });
    const p = plan([coolTop, hotLow], 1.5);
    expect(p.toShed).toEqual(["cool"]);
  });

  it("equal need → lowest priority sheds first", () => {
    const top = ac("cool", { currentLevel: 1, fanSpeed: 1, needDelta: 1 });
    const low = ac("third", { currentLevel: 1, fanSpeed: 1, needDelta: 1 });
    const p = plan([top, low], 1.5);
    expect(p.toShed).toEqual(["third"]);
  });

  it("a reshed-penalized AC is avoided when a peer covers equally", () => {
    const blocked = ac("cool", { currentLevel: 1, fanSpeed: 1, needDelta: 1, reshedPenalized: true });
    const peer = ac("third", { currentLevel: 1, fanSpeed: 1, needDelta: 1 });
    const p = plan([blocked, peer], 1.5);
    expect(p.toShed).toEqual(["third"]);
  });
});

describe("requireShed (extreme overshoot — compressor-off beats cap-throttle)", () => {
  it("forces a shed even when level cuts nominally cover, and enumerates no fans", () => {
    const p = plan(
      [ac("hot", { currentLevel: 3, needDelta: 3 }), ac("cool", { currentLevel: 3, needDelta: 0.2 })],
      3.5,
      { requireShed: true },
    );
    expect(p.toShed).toEqual(["cool"]); // most satisfied
    expect(p.fanCuts).toHaveLength(0);
    expect(p.satisfied).toBe(true);
  });
});

describe("never level 0", () => {
  it("an unrestricted AC is re-capped at its top commandable level, not left at 0", () => {
    const p = plan([ac("hot", { currentLevel: 0 })], 0.1);
    expect(p.desiredLevels.hot).toBe(3);
  });

  it("the re-cap respects reachable/slot/manual caps", () => {
    const p = plan([ac("hot", { currentLevel: 0, reachableCap: 2 })], 0.1);
    expect(p.desiredLevels.hot).toBe(2);
  });
});

describe("reduce-only contract & floors", () => {
  it("never emits a raise (boost floor above observed level is not the reducer's job)", () => {
    const p = plan([ac("hot", { currentLevel: 1, minLevel: 2, fanSpeed: 1 }), ac("cool", { currentLevel: 3 })], 1.8);
    expect(p.desiredLevels.hot).toBeUndefined();
    expect(p.desiredLevels.cool).toBe(2);
  });

  it("reports satisfied=false when everything reducible still can't cover", () => {
    const p = plan([ac("hot", { currentLevel: 1, fanSpeed: 1, needDelta: 4 })], 10, { fanTrimEnabled: false });
    // Only move left is shedding the single hot AC — savings 2A < 10A.
    expect(p.satisfied).toBe(false);
    expect(p.toShed).toEqual(["hot"]);
  });
});
