import { describe, it, expect } from "vitest";
import {
  DEFAULT_LEVELING_CONFIG_V2,
  LEVELING_V2_CONFIG_KEYS,
  OVER_LIMIT_BUDGET_MAX,
  OVER_LIMIT_BUDGET_MIN,
  isLevelingV2Key,
  mergeLevelingConfigV2,
} from "./config.js";

describe("mergeLevelingConfigV2", () => {
  it("returns defaults for an empty/absent row", () => {
    expect(mergeLevelingConfigV2(null)).toEqual(DEFAULT_LEVELING_CONFIG_V2);
    expect(mergeLevelingConfigV2({})).toEqual(DEFAULT_LEVELING_CONFIG_V2);
  });

  it("v1 raiseBufferAmps seeds restingBufferAmps; explicit v2 field wins", () => {
    expect(mergeLevelingConfigV2({ raiseBufferAmps: 0.7 }).restingBufferAmps).toBe(0.7);
    expect(mergeLevelingConfigV2({ raiseBufferAmps: 0.7, restingBufferAmps: 0.3 }).restingBufferAmps).toBe(0.3);
    expect(mergeLevelingConfigV2({ restingBufferAmps: -2 }).restingBufferAmps).toBe(0);
  });

  it("fundedSpend defaults ON and takes only a real boolean (2026-08-31)", () => {
    // The kill-switch for spending budget a cut has freed but the meter has not
    // shown. Same shape as `fanTrimEnabled`: a stored non-boolean (or an absent
    // key) leaves the default standing rather than silently disabling it.
    expect(DEFAULT_LEVELING_CONFIG_V2.fundedSpend).toBe(true);
    expect(mergeLevelingConfigV2({ fundedSpend: false }).fundedSpend).toBe(false);
    expect(mergeLevelingConfigV2({ fundedSpend: "no" }).fundedSpend).toBe(true);
    expect(mergeLevelingConfigV2({}).fundedSpend).toBe(true);
  });

  it("controller flag falls back to v1 on unknown values", () => {
    expect(mergeLevelingConfigV2({ controller: "v2" }).controller).toBe("v2");
    expect(mergeLevelingConfigV2({ controller: "shadow" }).controller).toBe("shadow");
    expect(mergeLevelingConfigV2({ controller: "bogus" }).controller).toBe("v1");
  });

  it("keeps the live v1 field names for limits/models", () => {
    const merged = mergeLevelingConfigV2({
      gridLimitAmps: 27,
      genLimitAmps: 14.9,
      marginAmps: 0.1,
      ampModels: { a: { baseAmps: 4.1, stepAmps: 2.2 } },
      genAmpModels: { a: { baseAmps: 4.5, stepAmps: 2.4 } },
      levelBoosts: { b: { minLevel: 2, outdoorAtLeastC: 39 } },
      priority: ["b", "a"],
    });
    expect(merged.gridLimitAmps).toBe(27);
    expect(merged.genLimitAmps).toBe(14.9);
    expect(merged.marginAmps).toBe(0.1);
    expect(merged.ampModels.a).toEqual({ baseAmps: 4.1, stepAmps: 2.2 });
    expect(merged.genAmpModels.a).toEqual({ baseAmps: 4.5, stepAmps: 2.4 });
    expect(merged.levelBoosts.b).toEqual({ minLevel: 2, outdoorAtLeastC: 39 });
    expect(merged.priority).toEqual(["b", "a"]);
  });

  it("drops malformed model/boost/priority entries instead of crashing", () => {
    const merged = mergeLevelingConfigV2({
      ampModels: { ok: { baseAmps: 2, stepAmps: 1 }, bad: { baseAmps: "x" }, worse: null },
      levelBoosts: { bad: { minLevel: 0 }, ok: { minLevel: 2.4, outdoorAtLeastC: 37 } },
      priority: ["a", 5, null, "b"],
    } as unknown as Record<string, unknown>);
    expect(Object.keys(merged.ampModels)).toEqual(["ok"]);
    expect(merged.levelBoosts.ok).toEqual({ minLevel: 2, outdoorAtLeastC: 37 });
    expect(merged.priority).toEqual(["a", "b"]);
  });

  it("defaults needOverrides to an empty map — no room is special until configured", () => {
    expect(mergeLevelingConfigV2({}).needOverrides).toEqual({});
    expect(DEFAULT_LEVELING_CONFIG_V2.needOverrides).toEqual({});
  });

  it("round-trips a valid need override", () => {
    const merged = mergeLevelingConfigV2({
      needOverrides: { abdullah: { tempOffsetC: -1, targetFromSetpoint: true } },
    } as unknown as Record<string, unknown>);
    expect(merged.needOverrides.abdullah).toEqual({ tempOffsetC: -1, targetFromSetpoint: true });
  });

  it("drops junk need-override entries and fields, and clamps the offset to ±5", () => {
    const merged = mergeLevelingConfigV2({
      needOverrides: {
        notObject: 7,
        nulled: null,
        badFields: { tempOffsetC: "x", targetFromSetpoint: "yes" },
        empty: {},
        tooCold: { tempOffsetC: -12 },
        tooHot: { tempOffsetC: 12 },
        offsetOnly: { tempOffsetC: -1 },
        flagOnly: { targetFromSetpoint: false },
      },
    } as unknown as Record<string, unknown>);
    // `badFields` keeps neither field, so it drops out with the junk entries —
    // an override that changes nothing must not read as "this room is special".
    expect(Object.keys(merged.needOverrides).sort()).toEqual(["flagOnly", "offsetOnly", "tooCold", "tooHot"]);
    expect(merged.needOverrides.tooCold).toEqual({ tempOffsetC: -5 });
    expect(merged.needOverrides.tooHot).toEqual({ tempOffsetC: 5 });
    expect(merged.needOverrides.offsetOnly).toEqual({ tempOffsetC: -1 });
    expect(merged.needOverrides.flagOnly).toEqual({ targetFromSetpoint: false });
  });

  it("clamps calm seconds to sane minimums", () => {
    expect(mergeLevelingConfigV2({ raiseCalmSeconds: 1 }).raiseCalmSeconds).toBe(5);
    expect(mergeLevelingConfigV2({ restoreCalmSeconds: 0 }).restoreCalmSeconds).toBe(5);
  });

  it("overLimitBudgetPoints defaults to 5 and is clamped to whole points in 4–20", () => {
    // The bucket is compared against integer drains, and a capacity outside the
    // bounds is one the invariant-19 safety argument no longer covers, so the
    // merge sanitizes rather than trusts a hand-edited row.
    expect(DEFAULT_LEVELING_CONFIG_V2.overLimitBudgetPoints).toBe(5);
    expect(mergeLevelingConfigV2({ overLimitBudgetPoints: 3 }).overLimitBudgetPoints).toBe(OVER_LIMIT_BUDGET_MIN);
    expect(mergeLevelingConfigV2({ overLimitBudgetPoints: 25 }).overLimitBudgetPoints).toBe(OVER_LIMIT_BUDGET_MAX);
    expect(mergeLevelingConfigV2({ overLimitBudgetPoints: 6.6 }).overLimitBudgetPoints).toBe(7);
    // A string or a NaN is not a number the controller may run on: default.
    expect(mergeLevelingConfigV2({ overLimitBudgetPoints: "8" } as unknown as Record<string, unknown>).overLimitBudgetPoints).toBe(5);
    expect(mergeLevelingConfigV2({ overLimitBudgetPoints: Number.NaN }).overLimitBudgetPoints).toBe(5);
    expect(mergeLevelingConfigV2({}).overLimitBudgetPoints).toBe(5);
  });

  it("clamps restoreCalmSeconds to raiseCalmSeconds (restore must outrank raises)", () => {
    // A restore that waited LONGER for calm than a raise would let a running
    // AC's raise become eligible first and steal the pending restore's headroom.
    const merged = mergeLevelingConfigV2({ restoreCalmSeconds: 120, raiseCalmSeconds: 30 });
    expect(merged.restoreCalmSeconds).toBe(30);
    expect(merged.raiseCalmSeconds).toBe(30);
    // A shorter restore gate is left as-is.
    expect(mergeLevelingConfigV2({ restoreCalmSeconds: 10, raiseCalmSeconds: 30 }).restoreCalmSeconds).toBe(10);
  });
});

// One shared key list feeds the controller's row-1/row-2 split and the API's
// forwarding filter; a key present in one copy and missing from the other is
// dropped silently behind a 200 (invariant 37's shape).
describe("LEVELING_V2_CONFIG_KEYS", () => {
  const V1_SHARED_KEYS = [
    "enabled",
    "gridLimitAmps",
    "genLimitAmps",
    "marginAmps",
    "comfortTargetC",
    "nearTargetBandC",
    "priority",
    "ampModels",
    "genAmpModels",
    "levelBoosts",
    "needOverrides",
  ];

  it("is exactly the v2-owned fields, and the guard agrees with it", () => {
    expect([...LEVELING_V2_CONFIG_KEYS]).toEqual([
      "controller",
      "restingBufferAmps",
      "raiseCalmSeconds",
      "restoreCalmSeconds",
      "fanTrimEnabled",
      "fundedSpend",
      "overLimitBudgetPoints",
    ]);
    for (const key of LEVELING_V2_CONFIG_KEYS) expect(isLevelingV2Key(key)).toBe(true);
    for (const key of V1_SHARED_KEYS) expect(isLevelingV2Key(key)).toBe(false);
    expect(isLevelingV2Key("raiseBufferAmps")).toBe(false);
  });

  it("covers every field of the merged config between the two rows", () => {
    // The compile-time half of this lives in config.ts (`LevelingV2KeysAreComplete`):
    // a field added to the interface and classified as neither v1-shared nor
    // v2-owned fails `tsc`. This is the runtime net for the same drift.
    expect(Object.keys(DEFAULT_LEVELING_CONFIG_V2).sort()).toEqual(
      [...LEVELING_V2_CONFIG_KEYS, ...V1_SHARED_KEYS].sort(),
    );
  });
});
