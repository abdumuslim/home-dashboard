import { describe, it, expect } from "vitest";
import { DEFAULT_LEVELING_CONFIG_V2, mergeLevelingConfigV2 } from "./config.js";

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

  it("clamps calm seconds to sane minimums", () => {
    expect(mergeLevelingConfigV2({ raiseCalmSeconds: 1 }).raiseCalmSeconds).toBe(5);
    expect(mergeLevelingConfigV2({ restoreCalmSeconds: 0 }).restoreCalmSeconds).toBe(5);
  });
});
