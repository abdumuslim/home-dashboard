import { describe, expect, it } from "vitest";
import { computeChangedKeys } from "./leveling-config-audit.js";

describe("computeChangedKeys", () => {
  it("returns nothing when the snapshots are identical", () => {
    const cfg = { enabled: true, gridLimitAmps: 32, priority: ["a", "b"] };
    expect(computeChangedKeys(cfg, { ...cfg })).toEqual([]);
  });

  it("reports only the top-level keys whose value changed, sorted", () => {
    const before = { enabled: true, gridLimitAmps: 32, marginAmps: 2 };
    const after = { enabled: false, gridLimitAmps: 32, marginAmps: 3 };
    expect(computeChangedKeys(before, after)).toEqual(["enabled", "marginAmps"]);
  });

  it("collapses a nested change to its top-level key", () => {
    const before = { ampModels: { DEV1: { baseAmps: 4, stepAmps: 1 } } };
    const after = { ampModels: { DEV1: { baseAmps: 4, stepAmps: 2 } } };
    expect(computeChangedKeys(before, after)).toEqual(["ampModels"]);
  });

  it("does not flag a nested object that is deeply equal", () => {
    const before = { levelBoosts: { DEV1: { minLevel: 2, outdoorAtLeastC: 40 } } };
    const after = { levelBoosts: { DEV1: { minLevel: 2, outdoorAtLeastC: 40 } } };
    expect(computeChangedKeys(before, after)).toEqual([]);
  });

  it("treats a key present on only one side as changed (added)", () => {
    expect(computeChangedKeys({ enabled: true }, { enabled: true, needOverrides: {} }))
      .toEqual(["needOverrides"]);
  });

  it("treats a key dropped from the incoming side as changed (removed)", () => {
    expect(computeChangedKeys({ enabled: true, genAmpModels: {} }, { enabled: true }))
      .toEqual(["genAmpModels"]);
  });

  it("is stable when either side is null or undefined", () => {
    expect(computeChangedKeys(null, null)).toEqual([]);
    expect(computeChangedKeys(undefined, undefined)).toEqual([]);
    expect(computeChangedKeys(null, { enabled: false })).toEqual(["enabled"]);
    expect(computeChangedKeys({ enabled: false }, undefined)).toEqual(["enabled"]);
  });
});
