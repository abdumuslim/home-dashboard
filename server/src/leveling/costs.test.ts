import { describe, it, expect } from "vitest";
import {
  EWMA_ALPHA,
  FAN_FULL_DROP_DEFAULT_AMPS,
  FAN_STEP_DEFAULT_AMPS,
  LEARNED_STALE_MS,
  fanTrimSavings,
  learnedFor,
  levelCutSavings,
  modelFor,
  raiseJumpAmps,
  steadyDraw,
  turnOnAmps,
  updateCost,
  type CostBook,
} from "./costs.js";
import { DEFAULT_LEVELING_CONFIG_V2, type LevelingConfigV2 } from "./config.js";

const T = 1_000_000;

const cfg: LevelingConfigV2 = {
  ...DEFAULT_LEVELING_CONFIG_V2,
  ampModels: { a: { baseAmps: 4.1, stepAmps: 2.2 } },
  genAmpModels: { a: { baseAmps: 4.5, stepAmps: 2.4 } },
};

describe("steadyDraw & modelFor", () => {
  it("level 0 budgets one step above max; levels clamp to max", () => {
    const m = { baseAmps: 2, stepAmps: 1 };
    expect(steadyDraw(0, 3, m)).toBe(5);
    expect(steadyDraw(1, 3, m)).toBe(2);
    expect(steadyDraw(3, 3, m)).toBe(4);
    expect(steadyDraw(9, 3, m)).toBe(4);
  });

  it("gen model overrides on gen, grid model is the fallback", () => {
    expect(modelFor(cfg, "a", "gen").baseAmps).toBe(4.5);
    expect(modelFor(cfg, "a", "grid").baseAmps).toBe(4.1);
    expect(modelFor(cfg, "unknown", "gen")).toEqual({ baseAmps: 2, stepAmps: 1 });
  });
});

describe("updateCost / learnedFor", () => {
  it("first observation adopts; later ones EWMA", () => {
    let book: CostBook = {};
    book = updateCost(book, "a", "gen", "level:1>2", 4.0, T);
    expect(learnedFor(book, "a", "gen", "level:1>2", T)).toBe(4.0);
    book = updateCost(book, "a", "gen", "level:1>2", 2.0, T + 1_000);
    expect(learnedFor(book, "a", "gen", "level:1>2", T + 1_000)).toBeCloseTo(4.0 + EWMA_ALPHA * (2.0 - 4.0));
    expect(book[`a|gen|level:1>2`].samples).toBe(2);
  });

  it("a stale entry is ignored and a new observation restarts it", () => {
    let book: CostBook = updateCost({}, "a", "gen", "level:1>2", 4.0, T);
    expect(learnedFor(book, "a", "gen", "level:1>2", T + LEARNED_STALE_MS)).toBeNull();
    book = updateCost(book, "a", "gen", "level:1>2", 2.5, T + LEARNED_STALE_MS + 1);
    const entry = book[`a|gen|level:1>2`];
    expect(entry.ewmaAmps).toBe(2.5);
    expect(entry.samples).toBe(1);
  });
});

describe("raiseJumpAmps (admission is trip-safe: max of model and learned)", () => {
  it("uses the model delta when nothing is learned", () => {
    const est = raiseJumpAmps({}, cfg, "a", "gen", 1, 2, 3, T);
    expect(est.amps).toBeCloseTo(2.4);
    expect(est.confidence).toBe("seed");
  });

  it("a learned jump above the model wins; below the model the model floors it", () => {
    const hot = updateCost({}, "a", "gen", "level:1>2", 3.8, T);
    expect(raiseJumpAmps(hot, cfg, "a", "gen", 1, 2, 3, T)).toEqual({ amps: 3.8, confidence: "learned" });
    const cool = updateCost({}, "a", "gen", "level:1>2", 1.0, T);
    const est = raiseJumpAmps(cool, cfg, "a", "gen", 1, 2, 3, T);
    expect(est.amps).toBeCloseTo(2.4);
  });

  it("a learned single-step jump charges multi-step targets per step", () => {
    const book = updateCost({}, "a", "gen", "level:1>2", 3.5, T);
    const est = raiseJumpAmps(book, cfg, "a", "gen", 1, 3, 3, T);
    expect(est.amps).toBeCloseTo(7.0); // 2 steps × 3.5 > model 4.8
    expect(est.confidence).toBe("learned");
  });

  it("charges nothing for a re-fill to the current level", () => {
    expect(raiseJumpAmps({}, cfg, "a", "gen", 2, 2, 3, T).amps).toBe(0);
  });
});

describe("turnOnAmps / levelCutSavings / fanTrimSavings", () => {
  it("restore admission uses max(model floor draw, learned on-cost)", () => {
    expect(turnOnAmps({}, cfg, "a", "gen", 1, 3, T).amps).toBeCloseTo(4.5);
    const book = updateCost({}, "a", "gen", "on@L1", 7.3, T);
    expect(turnOnAmps(book, cfg, "a", "gen", 1, 3, T)).toEqual({ amps: 7.3, confidence: "learned" });
  });

  it("level-cut savings mirror the raise jump (under-crediting a cut caused premature sheds)", () => {
    const book = updateCost({}, "a", "gen", "level:1>2", 3.8, T);
    expect(levelCutSavings(book, cfg, "a", "gen", 2, 1, 3, T)).toBe(3.8);
    expect(levelCutSavings({}, cfg, "a", "gen", 2, 1, 3, T)).toBeCloseTo(2.4);
  });

  it("fan savings use the learned step cost, else tiny defaults", () => {
    expect(fanTrimSavings({}, "a", "gen", 2, T)).toBeCloseTo(FAN_STEP_DEFAULT_AMPS * 2);
    expect(fanTrimSavings({}, "a", "gen", 6, T)).toBe(FAN_FULL_DROP_DEFAULT_AMPS);
    const book = updateCost({}, "a", "gen", "fan:step", 0.2, T);
    expect(fanTrimSavings(book, "a", "gen", 3, T)).toBeCloseTo(0.6);
  });
});
