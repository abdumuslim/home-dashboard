import { describe, it, expect } from "vitest";
import { planReduction, type ReduceInput } from "./reduce.js";
import { updateCost, type CostBook } from "./costs.js";
import { DEFAULT_LEVELING_CONFIG_V2, type LevelingConfigV2 } from "./config.js";
import { SHED_NEED_GAP_C } from "./reduce.js";
import { NON_COOLING_NEED_C } from "./needs.js";
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
    big: { baseAmps: 4.3, stepAmps: 2.5 },
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
    startBaselineAmps: null,
    rampBaselineAmps: null,
    rampAbsorbedAmps: null,
    reshedPenalized: false,
    satisfiedForMs: 0,
    subFloorStalledMs: 0,
    compressorOffLikely: false,
    roomTempC: null,
    boostFloorHard: false,
    unmeteredJumpAmps: 0,
    ...overrides,
    envelopeLevel: overrides.envelopeLevel ?? overrides.currentLevel ?? 2,
    rankNeedDelta: overrides.rankNeedDelta ?? overrides.needDelta ?? 2,
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

describe("room-vs-room ranks on REAL temperature (user, 2026-08-04)", () => {
  // "coolest in real temp, not feels like". `computeAcNeed` returns a
  // FEELS-LIKE delta for a room whose range rule uses that metric and a
  // real-temperature delta for every other room, so cross-room comparisons
  // mixed units and humidity alone could make a milder room outrank a hotter
  // one. `rankNeedDelta` asks the same question of every room.
  const room = (id: string, ownMetricNeed: number, realNeed: number): AcView =>
    ac(id, { currentLevel: 1, fanSpeed: 1, needDelta: ownMetricNeed, rankNeedDelta: realNeed });

  it("sheds the room that is coolest by thermometer, not by its own metric", () => {
    // `humid` looks needier on its own feels-like metric (4.0 vs 2.0) while its
    // ROOM is four degrees cooler. Ranked on the metric, the hot room pays.
    const p = plan([room("humid", 4, 2), room("hot", 2, 6)], 1.5);
    expect(p.toShed).toEqual(["humid"]);
  });

  it("falls back to the room's own metric when the thermometer is dead", () => {
    // buildViews sets rankNeedDelta = needDelta for a dead sensor, so the
    // ordering is exactly what it was before any of this existed.
    const p = plan([room("dead-a", 4, 4), room("dead-b", 2, 2)], 1.5);
    expect(p.toShed).toEqual(["dead-b"]);
  });
});

describe("one room at a time (user, 2026-08-02)", () => {
  // Live 16:51:11 and 16:55:34/35: both remaining rooms went off together — the
  // second pair one SECOND apart — to answer a 0.5A deficit. Bringing them back
  // one by one then leaves each room heating while its compressor is off.
  const atFloor = (id: string, need: number): AcView =>
    ac(id, { currentLevel: 1, fanSpeed: 1, needDelta: need });

  // Each room draws 2A at L1 under the test models.
  it("sheds ONE room when one covers the deficit", () => {
    const p = plan([atFloor("hot", 3), atFloor("cool", 0.3)], 1.5);
    expect(p.toShed).toEqual(["cool"]); // least-needy first
    expect(p.satisfied).toBe(true);
  });

  it("an extreme overshoot one room covers is still exactly one room", () => {
    const p = plan([atFloor("hot", 3), atFloor("cool", 0.3)], 1.8, { requireShed: true });
    expect(p.toShed).toHaveLength(1);
  });

  it("escalates to two ONLY when one genuinely cannot cover it", () => {
    // 3.5A needed, 2A per room — the "big pump" case the user carved out.
    const p = plan([atFloor("hot", 3), atFloor("cool", 0.3)], 3.5);
    expect(p.toShed).toHaveLength(2);
    expect(p.satisfied).toBe(true);
  });

  // The user's full shed-choice policy, 2026-08-04 ~17:25, after watching
  // 12:53:45Z shed both remaining rooms for a mean 0.025A over the limit:
  // "if the system knows that it can cover with the coolest room ac, let it do
  // it. if not, and knows the other 2 ton will be enough, it can turn it off
  // only. if the spike is too much and no single ac can cover it, let it turn
  // off the coolest 2 acs."
  describe("shed choice — coolest that covers, else the coolest two (user, 2026-08-04)", () => {
    // Live capacities: Abdu is the 2-ton, the other two are 1-tons.
    const rooms = () => [
      ac("big", { currentLevel: 1, fanSpeed: 1, needDelta: 2, rankNeedDelta: 2 }),
      ac("hot", { currentLevel: 1, fanSpeed: 1, needDelta: 6, rankNeedDelta: 6 }),
      ac("cool", { currentLevel: 1, fanSpeed: 1, needDelta: 0.3, rankNeedDelta: 0.3 }),
    ];
    // `big` draws 4.3A at L1 under the test models; `hot`/`cool` draw 2A.

    it("takes the coolest room when its own off covers the deficit (the 12:53:45Z fixture)", () => {
      // The honest sizing of that live input is ~0.2A, not the 4.57A one inrush
      // spike invented — and one room covers it many times over.
      const p = plan(rooms(), 0.2, { requireShed: true });
      expect(p.toShed).toEqual(["cool"]);
    });

    it("takes the 2-ton alone when the coolest cannot cover it but that one can", () => {
      // 3.0A: neither 1-ton covers it, the 2-ton does. One room, not a pair.
      const p = plan(rooms(), 3.0, { requireShed: true });
      expect(p.toShed).toEqual(["big"]);
    });

    it("takes the COOLEST TWO in one batch when no single room covers it", () => {
      // 5.0A: bigger than any single off. The hottest room survives.
      const p = plan(rooms(), 5.0, { requireShed: true });
      expect(p.toShed.slice().sort()).toEqual(["big", "cool"]);
      expect(p.toShed).not.toContain("hot");
    });

    it("the hottest room survives even a deficit the coolest pair cannot cover", () => {
      // 12A is more than the whole house; the ceiling still stops at two.
      const p = plan(rooms(), 12, { requireShed: true });
      expect(p.toShed).toHaveLength(2);
      expect(p.toShed).not.toContain("hot");
    });
  });
});

describe("the sub-floor rung — a comfort floor is not worth a power_off (2026-08-02)", () => {
  // Live 19:27/19:32/19:36 Baghdad: the TOP-priority room sat at its L2 boost
  // floor (outdoor ≥39°C) with both peers already at L1 and fan 1. Its own fan
  // trim was worth 0.6A against a 1.14A deficit, so the only feasible plan the
  // reducer could build was 4.8A of power_off — three times in ten minutes.
  const boosted = (o: Partial<AcView> = {}): AcView =>
    ac("hot", { minLevel: 2, currentLevel: 2, fanSpeed: 1, needDelta: 7, ...o });

  it("drops below the boost floor instead of shedding THAT room", () => {
    // The directive's own case: the alternative on the table is shedding the
    // same room. A level — even a non-cooling one — is recoverable with one
    // set_level and never lands a manual-off lock, so it must still win.
    const p = plan([boosted()], 1.5);
    expect(p.toShed).toHaveLength(0);
    expect(p.desiredLevels.hot).toBe(1);
    expect(p.satisfied).toBe(true);
  });

  it("a shed-free plan still takes the cheap sub-floor rung over any peer's off", () => {
    // The ladder order is untouched: nobody is switched off while a level can
    // still answer the deficit, even though that level stops the hot room
    // cooling. This is the rung the 2026-08-02 directive bought.
    const p = plan([boosted(), ac("cool", { currentLevel: 1, fanSpeed: 1, needDelta: 0.3 })], 1.5);
    expect(p.toShed).toHaveLength(0);
    expect(p.desiredLevels.hot).toBe(1);
    expect(p.satisfied).toBe(true);
  });

  it("still prefers a fan trim when the fan alone can cover it", () => {
    const p = plan([boosted({ fanSpeed: 5 }), ac("cool", { currentLevel: 1, fanSpeed: 1, needDelta: 0.3 })], 0.2);
    expect(p.desiredLevels).toEqual({});
    expect(p.fanCuts.length).toBeGreaterThan(0);
  });

  it("prefers an ordinary above-floor level cut on a peer over going sub-floor", () => {
    const p = plan([boosted(), ac("cool", { currentLevel: 3, fanSpeed: 1, needDelta: 0.3 })], 1.5);
    expect(p.desiredLevels.hot).toBeUndefined();
    expect(p.desiredLevels.cool).toBeLessThan(3);
  });

  it("never goes to level 0 — that is unrestricted draw, not a reduction", () => {
    const p = plan([boosted({ minLevel: 3, currentLevel: 3 })], 99);
    for (const level of Object.values(p.desiredLevels)) expect(level).toBeGreaterThanOrEqual(1);
  });

  // R14-hard (user, 2026-08-04 ~17:35, at 47°C outdoor — 8°C past Abdullah's
  // configured 39): "that should never put it at l1". Live 17:27:18 the reducer
  // did exactly that to the hottest room, because with the peer already at its
  // floor it was the only level rung left on the board.
  describe("…but not past the boost band (R14-hard)", () => {
    it("does not enumerate L1 at all for a room past its band", () => {
      const p = plan([boosted({ boostFloorHard: true })], 1.5);
      expect(p.desiredLevels.hot).toBeUndefined();
    });

    it("the 17:27:18 input sheds the coolest room instead of parking the hottest at L1", () => {
      // The live board: hottest room at its L2 floor, the peer already at L1,
      // fans already trimmed. Pre-R14-hard the only move was hot→L1.
      const board = [
        boosted({ boostFloorHard: true }),
        ac("cool", { currentLevel: 1, fanSpeed: 1, needDelta: 0.3, rankNeedDelta: 0.3 }),
      ];
      const p = plan(board, 1.5);
      expect(p.desiredLevels.hot).toBeUndefined();
      expect(p.toShed).toEqual(["cool"]);
    });

    it("keeps the rung for the SAME room inside the band — it might still cool there", () => {
      // 39–41°C is the flexible zone: the 2026-08-02 rung is alive, and only
      // the learned hold can revoke it. Narrowed, not deleted.
      const p = plan([boosted({ boostFloorHard: false })], 1.5);
      expect(p.desiredLevels.hot).toBe(1);
      expect(p.toShed).toHaveLength(0);
    });

    it("a manual pin to L1 keeps the rung even past the band (invariant 42)", () => {
      const p = plan([boosted({ boostFloorHard: true, manualTarget: 1 })], 1.5);
      expect(p.desiredLevels.hot).toBe(1);
    });
  });

  it("a plan that already sheds does not ALSO stop the hottest room cooling (2026-08-03)", () => {
    // Live 11:25:32: a 3.65A extreme deficit. {shed Najat (need 1.6) + Abdullah
    // L2→L1} scored 1.6 on the protection term and beat {shed Abdu} at 1.8 —
    // so the reducer switched off the milder room AND stopped the hottest,
    // top-priority room cooling, for a deficit the bigger room covered alone.
    // Abdullah then sat at a non-cooling L1 for 20 minutes with nothing
    // tracking him as out of service.
    const p = plan(
      [
        boosted({ needDelta: 3 }),
        ac("cool", { currentLevel: 1, fanSpeed: 1, needDelta: 1.6 }),
        ac("big", { currentLevel: 1, fanSpeed: 1, needDelta: 1.8 }),
      ],
      3.65,
    );
    expect(p.toShed).toEqual(["big"]);
    expect(p.desiredLevels.hot).toBeUndefined();
    expect(p.satisfied).toBe(true);
  });

  it("the 2°C band decides whether the sub-floor rung is free (user rule, 2026-08-03)", () => {
    // One house, one variable: how far the boosted room is from its setpoint.
    // Within the band that level still cools, so the cheap rung is used and the
    // mildest room covers the rest. Past it the level buys nothing but silence,
    // so the room is left alone and the deficit comes out of the big room.
    const house = (need: number): AcView[] => [
      boosted({ needDelta: need }),
      ac("cool", { currentLevel: 1, fanSpeed: 1, needDelta: 0.3 }),
      ac("big", { currentLevel: 1, fanSpeed: 1, needDelta: 1.8 }),
    ];

    const inBand = plan(house(NON_COOLING_NEED_C - 0.5), 3.65);
    expect(inBand.desiredLevels.hot).toBe(1);
    expect(inBand.toShed).toEqual(["cool"]);

    const beyond = plan(house(NON_COOLING_NEED_C + 1), 3.65);
    expect(beyond.desiredLevels.hot).toBeUndefined();
    expect(beyond.toShed).toEqual(["big"]);
  });

  it("sheds only once the sub-floor rung is exhausted too", () => {
    // At L1 with fan 1 there is nothing left to give but the room itself.
    const p = plan([ac("hot", { minLevel: 2, currentLevel: 1, fanSpeed: 1, needDelta: 7 })], 3);
    expect(p.toShed).toContain("hot");
  });
});

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

  it("a PEER above its floor blocks the fan — levels are set-wide, not per-AC (2026-07-31 trip)", () => {
    // Live 17:32:53: gen 1.0A over its limit. Abdullah sat at L3 (floor L2) with
    // a 2.5A cut on the table; Abdu was at his floor with fan 7. The per-AC
    // floor gate offered Abdu's fan, the comparator took it (cost 4.6 vs 140),
    // and the level did not come down for another 38s — the breaker went first.
    const atFloorWithFan = ac("cool", { currentLevel: 1, fanSpeed: 7, needDelta: 2.4 });
    const aboveFloor = ac("hot", { currentLevel: 3, minLevel: 2, fanSpeed: 3, needDelta: 7 });
    const p = plan([aboveFloor, atFloorWithFan], 0.45);
    expect(p.fanCuts).toHaveLength(0);
    expect(p.desiredLevels.hot).toBe(2);
    expect(p.satisfied).toBe(true);
  });

  it("combines a level cut WITH a fan trim rather than shedding a room", () => {
    // The trap in the first version of this rule: gating fans on "no level cut
    // exists anywhere" made the reducer unable to reach the fan while a level
    // remained, so a deficit that levels alone could not cover escalated
    // straight to a power_off. "Fans are the last try BEFORE turning off" means
    // levels+fans must always be reachable first.
    // Model step 2A; required 2.3A. One level cut (2A) is short, and the plan
    // that ends with everyone at their floor may add the fan to close it.
    const aboveFloor = ac("hot", { currentLevel: 2, fanSpeed: 1, needDelta: 5 });
    const atFloorWithFan = ac("cool", { currentLevel: 1, fanSpeed: 7, needDelta: 0.4 });
    const p = plan([aboveFloor, atFloorWithFan], 2.3);
    expect(p.toShed).toHaveLength(0);
    expect(p.desiredLevels.hot).toBe(1);
    expect(p.fanCuts.length).toBeGreaterThan(0);
    expect(p.satisfied).toBe(true);
  });

  it("once every AC is at its floor the fan is back on the table", () => {
    const atFloorWithFan = ac("cool", { currentLevel: 1, fanSpeed: 7, needDelta: 2.4 });
    const alsoAtFloor = ac("hot", { currentLevel: 2, minLevel: 2, fanSpeed: 3, needDelta: 7 });
    const p = plan([alsoAtFloor, atFloorWithFan], 0.45);
    expect(p.desiredLevels).toEqual({});
    expect(p.toShed).toHaveLength(0);
    expect(p.fanCuts.length).toBeGreaterThan(0);
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

describe("turn-on inrush blanking (2026-07-25 restore-bounce storm)", () => {
  // Everyone pinned at their floor with no fan slack, so a shed is the only
  // cover the search can normally find — the live 20:23 state.
  const pinned = (): AcView[] => [
    ac("hot", { currentLevel: 1, minLevel: 1, fanSpeed: 1, needDelta: 3 }),
    ac("cool", { currentLevel: 1, minLevel: 1, fanSpeed: 1, needDelta: 0.5 }),
  ];

  it("allowShed=false withholds the power-off entirely", () => {
    expect(plan(pinned(), 1.5).toShed).toEqual(["cool"]);
    expect(plan(pinned(), 1.5, { allowShed: false }).toShed).toEqual([]);
  });

  it("still cuts levels and trims fans while blanking — it is not a no-op", () => {
    const acs = [ac("hot", { currentLevel: 3, needDelta: 3 }), ac("cool", { currentLevel: 1, fanSpeed: 1 })];
    const p = plan(acs, 1.5, { allowShed: false });
    expect(p.desiredLevels.hot).toBeLessThan(3);
    expect(p.satisfied).toBe(true);
  });

  it("a forced shed (extreme) overrides the blanking — a real breach still sheds", () => {
    const p = plan(pinned(), 1.5, { allowShed: false, requireShed: true });
    expect(p.toShed.length).toBeGreaterThanOrEqual(1);
  });

  it("reports satisfied=false rather than shedding when blanking leaves no cover", () => {
    const p = plan(pinned(), 1.5, { allowShed: false });
    expect(p.satisfied).toBe(false);
    expect(p.toShed).toEqual([]);
  });
});

describe("preferShed — undo the turn-on that caused this, never a bystander", () => {
  it("sheds the preferred room when the bystander is comparably warm", () => {
    // Within SHED_NEED_GAP_C the no-surprise rule holds: you should not switch
    // your AC on and find a similarly-warm room switched off instead.
    //
    // `shield` is the top-priority room (priority order IS the `acs` order) and
    // is only here to keep the causer OFF that slot: since 2026-08-06 the top
    // room exports to any strictly cooler peer, which is a different rule with
    // its own describe below. It is the hottest room in the house, so it is
    // never a shed candidate and changes nothing else.
    const acs = [
      ac("shield", { currentLevel: 1, minLevel: 1, fanSpeed: 1, needDelta: 9 }),
      ac("hot", { currentLevel: 1, minLevel: 1, fanSpeed: 1, needDelta: 3 }),
      ac("cool", { currentLevel: 1, minLevel: 1, fanSpeed: 1, needDelta: 3 - (SHED_NEED_GAP_C - 0.1) }),
    ];
    expect(plan(acs, 1.5).toShed).toEqual(["cool"]); // least-needy, no hint
    expect(plan(acs, 1.5, { preferShed: "hot" }).toShed).toEqual(["hot"]);
  });

  it("sheds a CLEARLY milder bystander instead of the causer (user, 2026-08-03)", () => {
    // Amended that evening: "why it turned off mine not najat?". Live 20:24:50
    // a 0.3A overshoot shed the user's own 33°C room (need 4.2) while a 28.2°C
    // room (need 2.5) kept running — and shedding the milder one covered the
    // deficit many times over. Past the gap, protecting the hotter room wins.
    const acs = [
      ac("hot", { currentLevel: 1, minLevel: 1, fanSpeed: 1, needDelta: 4.2 }),
      ac("cool", { currentLevel: 1, minLevel: 1, fanSpeed: 1, needDelta: 2.5 }),
    ];
    expect(plan(acs, 1.5, { preferShed: "hot" }).toShed).toEqual(["cool"]);
  });

  it("the preferred room is exempt from its own re-shed penalty", () => {
    // Equal need, so the shedNeed term ties and COST decides: `cool` bounced and
    // carries the +400 re-shed penalty, which pushes the shed onto `hot` — the
    // bystander that did nothing. The hint reverses that.
    const acs = [
      ac("hot", { currentLevel: 1, minLevel: 1, fanSpeed: 1, needDelta: 0.5 }),
      ac("cool", { currentLevel: 1, minLevel: 1, fanSpeed: 1, needDelta: 0.5, reshedPenalized: true }),
    ];
    expect(plan(acs, 1.5).toShed).toEqual(["hot"]);
    expect(plan(acs, 1.5, { preferShed: "cool" }).toShed).toEqual(["cool"]);
  });

  it("is inert when the preferred room is not shed at all (level cuts cover it)", () => {
    const acs = [ac("hot", { currentLevel: 3, needDelta: 3 }), ac("cool", { currentLevel: 1, fanSpeed: 1 })];
    const p = plan(acs, 1.5, { preferShed: "hot" });
    expect(p.toShed).toEqual([]);
    expect(p.satisfied).toBe(true);
  });

  // 2026-08-06 15:48:47Z, the third Abdullah cycle of that day. Abdullah —
  // priority #1, real need 4.0°C — was switched on into a saturated house (the
  // ~5A heater on, fans trimmed house-wide, every room at its floor and his own
  // sub-floor rung barred by the hard boost zone), and the 0.28A overshoot 82s
  // later had exactly one enumerable answer: a room off. The causer rule named
  // him, and Najat — 0.6°C cooler, inside the gap — kept running.
  //
  // The user's amendment that evening ("can turn Najat off instead"): for the
  // TOP-PRIORITY room only, the export bar drops from SHED_NEED_GAP_C to
  // "strictly cooler". He accepted the cost out loud — his own click may now
  // switch off a comparably warm room, as long as it is genuinely cooler.
  describe("the top-priority causer exports to any strictly cooler room (user, 2026-08-06)", () => {
    const room = (id: string, need: number): AcView =>
      ac(id, { currentLevel: 1, minLevel: 1, fanSpeed: 1, needDelta: need, rankNeedDelta: need });
    // Priority order IS the `acs` order, so a NON-top causer needs a room above
    // it. This one is the hottest in the house and never a shed candidate.
    const shield = (): AcView => room("shield", 9);

    it("sheds a peer six tenths cooler rather than the top room that caused it", () => {
      const p = plan([room("abdullah", 4.0), room("najat", 3.4)], 1.5, { preferShed: "abdullah" });
      expect(p.toShed).toEqual(["najat"]);
    });

    it("…but never one the thermometer cannot tell apart from it", () => {
      // The shedNeed rung rounds to a tenth and so does this bar: a room cooler
      // by less than the comparator's own resolution is not cooler, and the
      // causer undoes its own turn-on exactly as it did before.
      const p = plan([room("abdullah", 4.0), room("najat", 3.96)], 1.5, { preferShed: "abdullah" });
      expect(p.toShed).toEqual(["abdullah"]);
    });

    it("every other causer still owes the full degree (2026-08-03 stands)", () => {
      // Najat is the causer and priority #2, so the amendment does not reach
      // her: 0.6°C is inside SHED_NEED_GAP_C and her own turn-on is undone.
      const p = plan([shield(), room("najat", 4.0), room("abdu", 3.4)], 1.5, { preferShed: "najat" });
      expect(p.toShed).toEqual(["najat"]);
    });

    it("…and a non-top causer still exports past that degree", () => {
      const p = plan([shield(), room("najat", 4.0), room("abdu", 3.0)], 1.5, { preferShed: "najat" });
      expect(p.toShed).toEqual(["abdu"]);
    });
  });
});

// 2026-08-06 14:38:11Z. Since 2026-08-04 the thermometer decides shed choice
// absolutely, top priority included — and that afternoon it shed ABDULLAH,
// priority #1, real need 4.0°C, because Abdu ranked a few DECIMALS hotter (the
// comparator rounds shedNeed to a tenth, so 4.05 rounded past 4.0). The two
// rooms sat far inside SHED_NEED_GAP_C of each other, which is the band the
// user himself calibrated as "equally hot — 1°C is enough to switch between
// acs".
//
// His rule, that afternoon: when the shed candidates are inside the gap, the
// configured priority list breaks the tie and the top-priority room survives.
// Outside the gap the thermometer still decides absolutely — a clearly cooler
// top-priority room still sheds, and 2026-08-04 stands.
describe("priority breaks a shed tie inside the need gap (user, 2026-08-06)", () => {
  // Priority order is the `acs` array order: abdullah #1, najat #2, abdu #3.
  const room = (id: string, need: number): AcView =>
    ac(id, { currentLevel: 1, fanSpeed: 1, needDelta: need, rankNeedDelta: need });

  it("sheds the LOW-priority room when the two are inside the gap", () => {
    // 0.1°C apart: decimals, not a difference anyone reads off a thermometer.
    // Either room's off covers the deficit several times over.
    const p = plan([room("abdullah", 4.0), room("abdu", 4.1)], 1.5);
    expect(p.toShed).toEqual(["abdu"]);
    expect(p.satisfied).toBe(true);
  });

  it("reports the tie-break so the journal can name it", () => {
    // A silent tie-break is a future mystery — every one of these shed rules
    // was debugged off the shed-choice decision detail.
    const p = plan([room("abdullah", 4.0), room("abdu", 4.1)], 1.5);
    expect(p.priorityTieBreak).toEqual({ shedDeviceId: "abdu", protectedDeviceId: "abdullah" });
  });

  it("outside the gap the thermometer still decides absolutely (2026-08-04)", () => {
    // 1.5°C apart, clear of the gap: the top-priority room is genuinely the
    // cooler one, so it pays. This is the rule the tie-break must NOT undo.
    const p = plan([room("abdullah", 4.0), room("abdu", 5.5)], 1.5);
    expect(p.toShed).toEqual(["abdullah"]);
    expect(p.priorityTieBreak).toBeNull();
  });

  it("exactly one gap apart is OUTSIDE it — the boundary shedsOnlyMilder already uses", () => {
    // One constant, one meaning: `shedsOnlyMilder` and the recovery admission
    // both call a room "clearly milder" at exactly the gap. Live 2026-07-28
    // 07:18 the two remaining rooms sat exactly 1.0°C apart, and an inclusive
    // boundary re-decides that shed on priority — which changes which cliff the
    // collapse detector then has to explain.
    const p = plan([room("abdullah", 0.5), room("abdu", 0.5 + SHED_NEED_GAP_C)], 1.5);
    expect(p.toShed).toEqual(["abdullah"]);
    expect(p.priorityTieBreak).toBeNull();
  });

  it("the causer still sheds inside the gap, priority or not (invariant 43)", () => {
    // Abdullah is priority #1 AND the room whose own turn-on caused this.
    // `exportsShed` is compared before the shedNeed rung, so undoing the
    // turn-on outranks the tie-break: you do not flip your own AC on and find
    // a comparably warm room switched off instead.
    const p = plan([room("abdullah", 4.0), room("abdu", 4.1)], 1.5, { preferShed: "abdullah" });
    expect(p.toShed).toEqual(["abdullah"]);
  });

  it("a two-room batch prefers the pair without the top-priority room", () => {
    // No single off covers 3.5A (each room is worth 2A at L1), so the search
    // escalates to pairs. {abdullah, najat} totals 4.0 and {najat, abdu} 4.1 —
    // a tenth apart, deep inside the gap — and the best-protected room of each
    // pair is what decides.
    const p = plan([room("abdullah", 2.0), room("najat", 2.0), room("abdu", 2.1)], 3.5);
    expect(p.toShed.slice().sort()).toEqual(["abdu", "najat"]);
    expect(p.toShed).not.toContain("abdullah");
    expect(p.satisfied).toBe(true);
  });

  it("never moves the off UP the priority list", () => {
    // The thermometer has already picked the LOWER-priority room, and abdullah
    // is 0.9°C hotter — inside the gap, but promoting him would sacrifice the
    // better-protected room to protect a worse-placed one. "The top-priority
    // room survives" is the whole rule; an off only ever moves down the list.
    const p = plan([room("abdullah", 3.0), room("abdu", 2.1)], 1.5);
    expect(p.toShed).toEqual(["abdu"]);
    expect(p.priorityTieBreak).toBeNull();
  });

  it("a chain of three rooms still spares the top-priority one", () => {
    // The rule is about the FIELD of candidates, not about pairs. Staircase the
    // three rooms 0.6°C apart — abdullah #1 at 4.0, najat #2 at 4.6, abdu #3 at
    // 5.4 — and every adjacent pair is inside the gap while the ends are 1.4°C
    // apart. A pairwise gap test is not transitive over that shape: najat loses
    // to abdu on priority, then abdullah takes the incumbent on raw need, and
    // the room the rule exists to protect goes off while najat — 0.6°C inside
    // his gap — keeps running.
    //
    // Anchoring on the thermometer's own pick is what makes it a rule: the raw
    // winner is abdullah, najat is inside his gap and lower priority, abdu is
    // not. najat pays.
    const p = plan([room("abdullah", 4.0), room("najat", 4.6), room("abdu", 5.4)], 1.5);
    expect(p.toShed).toEqual(["najat"]);
    expect(p.priorityTieBreak).toEqual({ shedDeviceId: "najat", protectedDeviceId: "abdullah" });
  });

  it("leaves an ordinary shed-free plan alone — nobody off, nothing to break a tie between", () => {
    const p = plan([ac("hot", { currentLevel: 3 }), ac("cool", { currentLevel: 3, needDelta: 0.5 })], 1.8);
    expect(p.toShed).toEqual([]);
    expect(p.priorityTieBreak).toBeNull();
  });
});

// 2026-07-28 16:06:07 Baghdad, gen 15A, over_severe needing 1.1A. Najat sat
// SATISFIED at L3 (needDelta 0.5 → her own ceiling is L1) and, with Abdullah's
// AC off, she was the first ON AC in priority order — so she inherited the
// +25 top-priority surcharge. Cutting her: 1 step × 10 × (1+1.5×0.5) = 17.5,
// +25 = 42.5. Cutting Abdu, whose room was 1.9°C hot: 10 × (1+1.5×1.9) = 38.5.
// The reducer took the amps from the hot room and left three dormant levels
// standing. It repeated at 16:38 and 16:40.
describe("2026-07-28 16:06 replay — dormant levels are not comfort", () => {
  const liveCfg: LevelingConfigV2 = {
    ...cfg,
    priority: ["abdullah", "najat", "abdu"],
    genAmpModels: {
      abdu: { baseAmps: 4.3, stepAmps: 2.5 },
      najat: { baseAmps: 2.3, stepAmps: 2.0 },
    },
  };
  // Priority-sorted with Abdullah OFF, exactly as the controller passes them.
  const acs = [
    ac("najat", { currentLevel: 3, needDelta: 0.5, fanSpeed: 1 }),
    ac("abdu", { currentLevel: 3, needDelta: 1.9, fanSpeed: 1 }),
  ];

  it("cuts the satisfied room's dormant level, not the hot room", () => {
    const p = planReduction({
      acs,
      requiredAmps: 1.14,
      requireShed: false,
      fanTrimEnabled: true,
      book: {},
      config: liveCfg,
      source: "gen",
      now: T,
    });
    expect(p.desiredLevels).toHaveProperty("najat");
    expect(p.desiredLevels).not.toHaveProperty("abdu");
    expect(p.satisfied).toBe(true);
  });

  it("still shields the top room's levels while its own need justifies them", () => {
    // Same shape, but Najat is genuinely hot too — now the surcharge applies
    // and the reducer must not single her out.
    const hotTop = [
      ac("najat", { currentLevel: 3, needDelta: 2.0, fanSpeed: 1 }),
      ac("abdu", { currentLevel: 3, needDelta: 1.9, fanSpeed: 1 }),
    ];
    const p = planReduction({
      acs: hotTop,
      requiredAmps: 1.14,
      requireShed: false,
      fanTrimEnabled: true,
      book: {},
      config: liveCfg,
      source: "gen",
      now: T,
    });
    expect(p.desiredLevels).toHaveProperty("abdu");
    expect(p.desiredLevels).not.toHaveProperty("najat");
  });

  it("a manual pin keeps full protection even when the room reads satisfied", () => {
    const pinned = [
      ac("najat", { currentLevel: 3, needDelta: 0.5, fanSpeed: 1, manualTarget: 3 }),
      ac("abdu", { currentLevel: 3, needDelta: 1.9, fanSpeed: 1 }),
    ];
    const p = planReduction({
      acs: pinned,
      requiredAmps: 1.14,
      requireShed: false,
      fanTrimEnabled: true,
      book: {},
      config: liveCfg,
      source: "gen",
      now: T,
    });
    expect(p.desiredLevels).not.toHaveProperty("najat");
  });
});
