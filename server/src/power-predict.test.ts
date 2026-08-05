import { describe, expect, it } from "vitest";
import type { PowerSource } from "./ac-leveling.js";
import { MINUTE_MS, type Session } from "./power-stats.js";
import {
  buildRationIntervals,
  completedIntervals,
  switchEvents,
  fitCycle,
  learnHoldModel,
  holdsWithin,
  survivalRemaining,
  outageIntervals,
  slotOfDay,
  offsetFromBoundary,
  nextBoundaryMs,
  minutesToNextBoundary,
  recencyWeight,
  explainNextSwitch,
  predictNextSwitch,
  DEFAULT_TUNING,
  MIN_CYCLE_CONCENTRATION,
  MIN_INFORMATIVE_EVENTS,
  IMMINENT_FLOOR_MINUTES,
  PREDICT_MAX_MINUTES,
  type PredictTuning,
} from "./power-predict.js";

// ---------------------------------------------------------------- helpers ---

function sess(source: PowerSource, startMs: number, endMs: number): Session {
  return { source, startMs, endMs, minutes: (endMs - startMs) / MINUTE_MS };
}

/** Lay `[source, minutes]` pairs end to end from `startMs` — one contiguous session list. */
function chain(startMs: number, spec: [PowerSource, number][]): Session[] {
  let t = startMs;
  return spec.map(([source, minutes]) => {
    const s = sess(source, t, t + minutes * MINUTE_MS);
    t = s.endMs;
    return s;
  });
}

/** Repeat `spec` `days`-worth of times (enough cycles to cover the window). */
function repeat(spec: [PowerSource, number][], times: number): [PowerSource, number][] {
  const out: [PowerSource, number][] = [];
  for (let i = 0; i < times; i++) out.push(...spec);
  return out;
}

/**
 * A UTC instant whose Baghdad-local minute-of-day is 83 — i.e. it sits exactly on
 * a 120-minute grid of phase +83, the shape the real utility runs. Every synthetic
 * cycle below starts here so its switches land on that grid by construction.
 */
const GRID_ORIGIN = Date.UTC(2026, 6, 1, 22, 23); // 2026-07-02 01:23 Baghdad
const H = 60 * MINUTE_MS;

// --------------------------------------------------------------- primitives ---

describe("clock primitives", () => {
  it("locates the next boundary of a phased grid", () => {
    // GRID_ORIGIN is itself a boundary, so the next one is a full period later.
    expect(minutesToNextBoundary(GRID_ORIGIN, 120, 83)).toBe(120);
    expect(minutesToNextBoundary(GRID_ORIGIN + 30 * MINUTE_MS, 120, 83)).toBe(90);
    expect(nextBoundaryMs(GRID_ORIGIN + 30 * MINUTE_MS, 120, 83)).toBe(GRID_ORIGIN + 120 * MINUTE_MS);
  });

  it("signs the offset from the nearest boundary: negative before, positive after", () => {
    expect(offsetFromBoundary(GRID_ORIGIN, 120, 83)).toBeCloseTo(0, 10);
    expect(offsetFromBoundary(GRID_ORIGIN + 5 * MINUTE_MS, 120, 83)).toBe(5); // switched late
    expect(offsetFromBoundary(GRID_ORIGIN - 5 * MINUTE_MS, 120, 83)).toBe(-5); // switched early
  });

  it("slots partition the Baghdad day from the fitted phase", () => {
    expect(slotOfDay(GRID_ORIGIN, 120, 83)).toBe(0);
    expect(slotOfDay(GRID_ORIGIN + 2 * H, 120, 83)).toBe(1);
    expect(slotOfDay(GRID_ORIGIN + 24 * H, 120, 83)).toBe(0); // same slot next day
  });

  it("recency weight halves every half-life and never exceeds 1", () => {
    const now = GRID_ORIGIN;
    expect(recencyWeight(now, now, 5)).toBe(1);
    expect(recencyWeight(now - 5 * 24 * H, now, 5)).toBeCloseTo(0.5, 6);
    expect(recencyWeight(now + 24 * H, now, 5)).toBe(1); // future never up-weights
  });
});

// --------------------------------------------------------- event extraction ---

describe("buildRationIntervals", () => {
  const t0 = GRID_ORIGIN;

  it("merges a transient blackout that recovers to the SAME source", () => {
    const sessions = chain(t0, [["grid", 60], ["none", 8], ["grid", 52], ["gen", 120]]);
    const iv = buildRationIntervals(sessions);
    expect(iv.map((x) => [x.source, x.minutes])).toEqual([
      ["grid", 120], // 60 + 8 + 52 — the outage did not end the ration interval
      ["gen", 120],
    ]);
  });

  it("stamps a cross-source blackout as a switch at the GAP START", () => {
    const sessions = chain(t0, [["grid", 60], ["none", 10], ["gen", 110]]);
    const iv = buildRationIntervals(sessions);
    expect(iv.map((x) => x.source)).toEqual(["grid", "gen"]);
    expect(iv[0].endMs).toBe(t0 + 60 * MINUTE_MS);
    expect(iv[1].startMs).toBe(t0 + 60 * MINUTE_MS); // the gen interval owns the gap
    expect(switchEvents(iv)).toEqual([{ atMs: t0 + 60 * MINUTE_MS, from: "grid", to: "gen" }]);
  });

  it("censors the first and last intervals and keeps them out of the learning set", () => {
    const iv = buildRationIntervals(chain(t0, [["grid", 60], ["gen", 120], ["grid", 30]]));
    expect(iv[0].leftCensored).toBe(true);
    expect(iv[iv.length - 1].rightCensored).toBe(true);
    expect(completedIntervals(iv).map((x) => x.source)).toEqual(["gen"]);
  });

  it("ignores transitions in and out of a window-edge blackout", () => {
    const iv = buildRationIntervals(chain(t0, [["none", 30], ["grid", 120], ["gen", 120], ["none", 30]]));
    // Only the genuine grid->gen changeover counts; the edge outages are not switches.
    expect(switchEvents(iv)).toEqual([{ atMs: t0 + 150 * MINUTE_MS, from: "grid", to: "gen" }]);
  });
});

describe("holdsWithin", () => {
  it("counts only boundaries strictly inside the interval, with jitter grace", () => {
    const one = { startMs: GRID_ORIGIN, endMs: GRID_ORIGIN + 2 * H };
    const two = { startMs: GRID_ORIGIN, endMs: GRID_ORIGIN + 4 * H };
    expect(holdsWithin(one, 120, 83)).toBe(0); // ends ON the next boundary — no hold
    expect(holdsWithin(two, 120, 83)).toBe(1); // survived one boundary
  });

  it("a switch a few minutes late is still not a hold", () => {
    const late = { startMs: GRID_ORIGIN, endMs: GRID_ORIGIN + 2 * H + 8 * MINUTE_MS };
    expect(holdsWithin(late, 120, 83)).toBe(0);
  });
});

// ---------------------------------------------------------- cycle learning ---

describe("fitCycle", () => {
  const now = GRID_ORIGIN + 15 * 24 * H;

  function cycleOf(spec: [PowerSource, number][], times: number) {
    const sessions = chain(now - 15 * 24 * H, repeat(spec, times));
    return fitCycle(switchEvents(buildRationIntervals(sessions)), now);
  }

  it("learns the period and phase of a 120-minute grid", () => {
    const fit = cycleOf([["grid", 120], ["gen", 120]], 100);
    expect(fit?.periodMinutes).toBe(120);
    expect(fit?.phaseMinutes).toBeCloseTo(83, 5);
    expect(fit?.concentration).toBeGreaterThan(0.99);
  });

  it("does NOT collapse onto the 60-minute harmonic", () => {
    // Every 120-boundary is also a 60-boundary at the same offset, so concentration
    // alone ties at R=1. Only the boundary-use factor separates them.
    const fit = cycleOf([["grid", 120], ["gen", 120]], 100);
    expect(fit?.periodMinutes).not.toBe(60);
    expect(fit?.boundaryUse).toBeCloseTo(1, 2);
  });

  it("learns a 90-minute rota instead — the period is not hardcoded", () => {
    const fit = cycleOf([["grid", 90], ["gen", 90]], 130);
    expect(fit?.periodMinutes).toBe(90);
    expect(fit?.concentration).toBeGreaterThan(0.99);
  });

  it("scores unstructured switching below the confidence gate", () => {
    // Durations drawn from a spread that lands on no common grid.
    const spec: [PowerSource, number][] = [];
    const jitter = [37, 96, 143, 61, 178, 84, 119, 52, 205, 73, 131, 47];
    for (let i = 0; i < 24; i++) {
      spec.push([i % 2 === 0 ? "grid" : "gen", jitter[i % jitter.length] + ((i * 17) % 29)]);
    }
    const sessions = chain(now - 15 * 24 * H, spec);
    const fit = fitCycle(switchEvents(buildRationIntervals(sessions)), now);
    expect(fit!.concentration).toBeLessThan(MIN_CYCLE_CONCENTRATION);
  });

  it("returns null when there is nothing to fit", () => {
    expect(fitCycle([], now)).toBeNull();
  });
});

// ------------------------------------------------------------- hold model ---

describe("learnHoldModel", () => {
  const now = GRID_ORIGIN + 15 * 24 * H;

  /** Fit a cycle on `spec` and read back each source's level-1 hold probability. */
  function holdRates(spec: [PowerSource, number][], times: number) {
    const sessions = chain(now - 15 * 24 * H, repeat(spec, times));
    const intervals = buildRationIntervals(sessions);
    const cycle = fitCycle(switchEvents(intervals), now)!;
    const model = learnHoldModel(intervals, cycle, now);
    const slotFor = (source: PowerSource) => {
      const iv = completedIntervals(intervals).find((x) => x.source === source)!;
      return slotOfDay(iv.startMs, cycle.periodMinutes, cycle.phaseMinutes);
    };
    return {
      cycle,
      grid: model.get("grid")!,
      gen: model.get("gen")!,
      gridP: model.get("grid")!.holdProbability(1, slotFor("grid")),
      genP: model.get("gen")!.holdProbability(1, slotFor("gen")),
    };
  }

  it("learns an asymmetry that is in the data, not in the code", () => {
    // gen takes two slots every time, grid exactly one.
    const r = holdRates([["grid", 120], ["gen", 240]], 60);
    expect(r.genP).toBeGreaterThan(0.8);
    expect(r.gridP).toBeLessThan(0.2);
    expect(r.gen.maxHolds).toBe(1);
    expect(r.grid.maxHolds).toBe(0);
  });

  it("learns the MIRRORED asymmetry when the roles are swapped", () => {
    // The same shape with grid as the source that keeps the extra slot. If any
    // per-source behaviour were baked in, this is the test that would fail.
    const r = holdRates([["grid", 240], ["gen", 120]], 60);
    expect(r.gridP).toBeGreaterThan(0.8);
    expect(r.genP).toBeLessThan(0.2);
    expect(r.grid.maxHolds).toBe(1);
    expect(r.gen.maxHolds).toBe(0);
  });

  it("learns the signed offset of switches from the grid", () => {
    // Every switch lands 6 minutes late: grid runs 126, gen runs 114, so the
    // boundaries stay on the 120 grid but each interval ends +6 past one.
    const sessions = chain(GRID_ORIGIN - 15 * 24 * H + 6 * MINUTE_MS, repeat([["grid", 120], ["gen", 120]], 100));
    const intervals = buildRationIntervals(sessions);
    const cycle = fitCycle(switchEvents(intervals), now)!;
    const model = learnHoldModel(intervals, cycle, now);
    expect(Math.abs(model.get("grid")!.endOffsetMinutes)).toBeLessThan(2);
    expect(cycle.phaseMinutes).toBeCloseTo(89, 0); // 83 + 6, learned not assumed
  });
});

// ---------------------------------------------------------------- survival ---

describe("survivalRemaining", () => {
  const now = GRID_ORIGIN;
  const intervals = [30, 40, 50, 60, 70].map((m, i) => ({
    source: "gen" as PowerSource,
    startMs: now - (i + 1) * 24 * H,
    endMs: now - (i + 1) * 24 * H + m * MINUTE_MS,
    minutes: m,
    leftCensored: false,
    rightCensored: false,
  }));

  it("takes the median residual among intervals that outlived the current age", () => {
    // Age 35 -> survivors 40,50,60,70 -> residuals 5,15,25,35; recency favours the
    // nearer (shorter) ones, so the weighted median sits at the low end.
    const r = survivalRemaining(intervals, 35, now);
    expect(r?.sampleCount).toBe(4);
    expect(r!.remainingMinutes).toBeGreaterThan(0);
    expect(r!.remainingMinutes).toBeLessThanOrEqual(35);
  });

  it("returns null below the informative-event floor", () => {
    expect(survivalRemaining(intervals, 65, now)).toBeNull(); // only 70 survives
    expect(MIN_INFORMATIVE_EVENTS).toBe(4);
  });
});

// -------------------------------------------------------------- prediction ---

describe("predictNextSwitch — slot path", () => {
  const now = GRID_ORIGIN + 15 * 24 * H;
  /** 15 days of "grid takes one slot, gen takes two" ending exactly at `now`. */
  const asymmetric = () => chain(now - 15 * 24 * H, repeat([["grid", 120], ["gen", 240]], 60));

  it("a source that never holds is predicted to the next boundary", () => {
    // Cut the window so grid has been running 30 minutes at `now`.
    const sessions = chain(now - 15 * 24 * H, [...repeat([["grid", 120], ["gen", 240]], 59), ["grid", 30]]);
    const t = sessions[sessions.length - 1].endMs;
    const r = explainNextSwitch({ sessions, nowMs: t, liveSource: "grid" });
    expect(r.prediction?.method).toBe("slot");
    expect(r.holdChain[0]).toBeLessThan(0.5);
    expect(r.prediction?.remainingMinutes).toBe(90); // 120 - 30, no extra slot
  });

  it("a source that always holds is predicted a whole extra slot", () => {
    const sessions = chain(now - 15 * 24 * H, [...repeat([["grid", 120], ["gen", 240]], 59), ["grid", 120], ["gen", 30]]);
    const t = sessions[sessions.length - 1].endMs;
    const r = explainNextSwitch({ sessions, nowMs: t, liveSource: "gen" });
    expect(r.prediction?.method).toBe("slot");
    expect(r.holdChain[0]).toBeGreaterThan(0.5);
    expect(r.prediction?.remainingMinutes).toBe(210); // 90 to the boundary + one 120 slot
  });

  it("stops the hold chain at the most holds ever observed", () => {
    // gen never manages two extra slots in this window, so the chain cannot invent one.
    const sessions = chain(now - 15 * 24 * H, [...repeat([["grid", 120], ["gen", 240]], 59), ["grid", 120], ["gen", 30]]);
    const t = sessions[sessions.length - 1].endMs;
    const r = explainNextSwitch({ sessions, nowMs: t, liveSource: "gen" });
    expect(r.maxHolds).toBe(1);
    expect(r.holdChain.length).toBeLessThanOrEqual(2);
    expect(r.prediction!.remainingMinutes).toBeLessThan(2 * 240);
  });

  it("clamps to 24 hours and never returns a negative", () => {
    const r = predictNextSwitch({ sessions: asymmetric(), nowMs: now, liveSource: "gen" });
    expect(r!.remainingMinutes).toBeGreaterThanOrEqual(0);
    expect(r!.remainingMinutes).toBeLessThanOrEqual(PREDICT_MAX_MINUTES);
  });
});

describe("boundary-miss grace", () => {
  const now = GRID_ORIGIN + 15 * 24 * H;

  /** Window where grid NEVER holds, with the live grid interval `ranMin` old. */
  function gridRunning(ranMin: number) {
    return chain(now - 15 * 24 * H, [...repeat([["grid", 120], ["gen", 240]], 59), ["grid", ranMin]]);
  }

  it("a boundary that just slipped past predicts imminent, not a whole period later", () => {
    const sessions = gridRunning(125); // 5 minutes past the boundary, still on grid
    const t = sessions[sessions.length - 1].endMs;
    const r = explainNextSwitch({ sessions, nowMs: t, liveSource: "grid" });
    expect(r.prediction?.method).toBe("slot");
    expect(r.holdsConfirmed).toBe(0); // inside the grace: not yet conceded as a hold
    expect(r.prediction?.remainingMinutes).toBe(IMMINENT_FLOOR_MINUTES);
  });

  it("past the grace it concedes the hold instead of holding the boundary open", () => {
    const sessions = gridRunning(145); // 25 minutes past — beyond LIVE_GRACE_MINUTES
    const t = sessions[sessions.length - 1].endMs;
    const r = explainNextSwitch({ sessions, nowMs: t, liveSource: "grid" });
    expect(r.holdsConfirmed).toBe(1);
    // Grid was never seen to hold in this window, so the slot model has nothing to
    // say about this state and must hand over rather than invent a second slot.
    expect(r.reason).toContain("exceeds the observed maximum");
    expect(r.prediction?.method ?? "null").not.toBe("slot");
  });
});

describe("fallbacks", () => {
  const now = GRID_ORIGIN + 15 * 24 * H;

  it("engages survival when the cycle confidence gate fails", () => {
    // Unstructured switching: a rhythm exists, but it locks to no slot grid.
    const spec: [PowerSource, number][] = [];
    const jitter = [37, 96, 143, 61, 178, 84, 119, 52, 205, 73, 131, 47];
    for (let i = 0; i < 40; i++) {
      spec.push([i % 2 === 0 ? "grid" : "gen", jitter[i % jitter.length] + ((i * 17) % 29)]);
    }
    const sessions = chain(now - 15 * 24 * H, spec);
    const t = sessions[sessions.length - 1].endMs;
    const r = explainNextSwitch({ sessions, nowMs: t, liveSource: sessions[sessions.length - 1].source });
    expect(r.cycle!.concentration).toBeLessThan(MIN_CYCLE_CONCENTRATION);
    expect(r.reason).toContain("below the gate");
    expect(r.prediction?.method).toBe("survival");
  });

  it("returns null on scarce data rather than guessing", () => {
    const sessions = chain(now - 4 * H, [["grid", 120], ["gen", 120]]);
    expect(predictNextSwitch({ sessions, nowMs: now, liveSource: "gen" })).toBeNull();
  });

  it("estimates blackout recovery from past outages", () => {
    // Six completed 20-minute outages punctuating a normal cycle, then a live one.
    const spec: [PowerSource, number][] = [];
    for (let i = 0; i < 30; i++) {
      spec.push(["grid", 120], ["gen", 100], ["none", 20], ["gen", 120]);
    }
    const sessions = chain(now - 15 * 24 * H, spec);
    const t = sessions[sessions.length - 1].endMs + 5 * MINUTE_MS;
    const r = explainNextSwitch({ sessions, nowMs: t, liveSource: "none" });
    expect(r.prediction?.method).toBe("survival");
    expect(r.reason).toContain("blackout");
    expect(r.prediction!.remainingMinutes).toBe(15); // 20-minute outages, 5 minutes in
    expect(outageIntervals(sessions).length).toBeGreaterThanOrEqual(MIN_INFORMATIVE_EVENTS);
  });

  it("returns null for a blackout with no comparable history", () => {
    const sessions = chain(now - 15 * 24 * H, repeat([["grid", 120], ["gen", 240]], 60));
    const r = explainNextSwitch({ sessions, nowMs: now + 5 * MINUTE_MS, liveSource: "none" });
    expect(r.prediction).toBeNull();
    expect(r.reason).toContain("too few past outages");
  });
});

describe("tuning is data, not policy", () => {
  it("a stricter evidence gate pushes even perfectly slotted data onto survival", () => {
    const start = GRID_ORIGIN;
    // End the window 100 minutes into a gen interval, so the survival path has both
    // a live age to condition on and completed 240-minute intervals that outlive it.
    const sessions = chain(start, [...repeat([["grid", 120], ["gen", 240]], 59), ["grid", 120], ["gen", 100]]);
    const now = sessions[sessions.length - 1].endMs;
    const relaxed = explainNextSwitch({ sessions, nowMs: now, liveSource: "gen" });
    expect(relaxed.prediction?.method).toBe("slot");

    const strict: PredictTuning = { ...DEFAULT_TUNING, minSwitches: 10_000 };
    const r = explainNextSwitch({ sessions, nowMs: now, liveSource: "gen", tuning: strict });
    expect(r.reason).toContain("too few switches");
    expect(r.prediction?.method).toBe("survival");
  });
});

// ------------------------------------------------- real-data regression set ---

/**
 * The three worked failures from `backtest_current.md` §5, replayed as fixtures.
 *
 * Each WINDOW is the EXACT 15-day session list production would have built at that
 * instant (R = grid, E = gen, O = none, followed by the run length in minutes),
 * extracted from the 60-day minute stream. These lock in the behaviour the backtest
 * measured — including the two cases the model still gets wrong, so that a future
 * change which moves them has to be looked at rather than absorbed silently.
 */
function decodeWindow(startMs: number, code: string): Session[] {
  let t = startMs;
  return code.split(" ").map((tok) => {
    const source: PowerSource = tok[0] === "R" ? "grid" : tok[0] === "E" ? "gen" : "none";
    const s = sess(source, t, t + Number(tok.slice(1)) * MINUTE_MS);
    t = s.endMs;
    return s;
  });
}

const CASE_A_WINDOW =
  "E6 R109 E244 R120 E239 R115 E260 R106 E240 R33 E17 R63 E254 R39 E7 R80 E230 R61 E147 R142 E139 R106 E120 R120 E245 R116 E251 R109 E249 R113 E249 R105 E241 R60 E179 R67 E184 R114 E248 R112 E250 R107 E244 R150 E213 R44 E195 R115 E235 R134 E239 R4 E14 R74 E260 R112 O5 R1 E43 R41 O4 R1 E163 R109 E131 R111 E254 R44 E199 R25 E10 R13 E180 R113 E120 R115 E245 R117 E254 R109 E250 R107 E251 R99 O202 R8 O3 R40 E5 O7 E120 R9 E103 R117 E182 R58 E137 R105 O3 R1 E4 O17 E216 R121 E237 R120 E245 R112 O23 E6 O20 E13 O18 E135 O4 E29 R111 O4 R1 E247 R106 E137 R106 E133 R110 E126 R117 E242 R3 O5 R103 E245 R118 E238 R122 E247 R52 E179 R63 E192 R108 E247 R112 E241 R117 E131 R109 E253 R113 E242 R117 E136 R106 O1 E124 R109 E124 R119 E249 R104 E256 R102 E137 R111 E117 R121 E136 R98 E258 R108 E248 R108 E124 R121 E123";

const CASE_B_WINDOW =
  "E116 R119 E253 R65 O42 R1 E139 R104 E244 R122 E236 R117 E255 R110 E236 R117 E248 R125 O1 E228 R122 E137 R103 O8 R1 E243 R108 E126 R114 E245 R113 E249 R114 E119 R124 O11 R1 E105 R120 E13 O5 E111 O4 E89 R30 O5 R1 E7 R97 E244 R110 E136 R112 E131 R105 E134 R110 E121 R115 E253 R109 E301 R59 E112 O19 E5 O47 E54 R121 E120 R118 E252 R106 O12 R1 E154 O33 E33 R129 E133 R113 E242 R110 E137 R108 E120 O1 R118 E132 R110 E127 R113 E137 R102 E118 R107 O3 R16 E167 R83 E99 R115 E157 O12 E1 R89 E243 R109 E119 R119 E127 R105 O6 R3 E133 R14 E45 R49 E248 R113 E148 R90 E124 R120 E121 R116 E171 R68 E132 R107 E251 R106 E138 R106 E119 O1 R86 E157 R118 E248 R110 E144 R101 E248 R111 E122 R118 E123 R116 E250 R105 E227 R130 E139 R114 E128 R107 E129 R118 E128 R6 E9 R43 E14 R31 E123 R123 E124 O1 R103 E127 R122 E117 R117 E134 R114 E237 R119 O3 R1 E238 R116 E253 R110 E129 R109 E244 R120 E239 R115 E2";

const CASE_C_WINDOW =
  "E126 R118 E128 R6 E9 R43 E14 R31 E123 R123 E124 O1 R103 E127 R122 E117 R117 E134 R114 E237 R119 O3 R1 E238 R116 E253 R110 E129 R109 E244 R120 E239 R115 E260 R106 E240 R33 E17 R63 E254 R39 E7 R80 E230 R61 E147 R142 E139 R106 E120 R120 E245 R116 E251 R109 E249 R113 E249 R105 E241 R60 E179 R67 E184 R114 E248 R112 E250 R107 E244 R150 E213 R44 E195 R115 E235 R134 E239 R4 E14 R74 E260 R112 O5 R1 E43 R41 O4 R1 E163 R109 E131 R111 E254 R44 E199 R25 E10 R13 E180 R113 E120 R115 E245 R117 E254 R109 E250 R107 E251 R99 O202 R8 O3 R40 E5 O7 E120 R9 E103 R117 E182 R58 E137 R105 O3 R1 E4 O17 E216 R121 E237 R120 E245 R112 O23 E6 O20 E13 O18 E135 O4 E29 R111 O4 R1 E247 R106 E137 R106 E133 R110 E126 R117 E242 R3 O5 R103 E245 R118 E238 R122 E247 R52 E179 R63 E192 R108 E247 R112 E241 R117 E131 R109 E253 R113 E242 R117 E136 R106 O1 E117";

const LOOKBACK_MS = 15 * 24 * H;

describe("regression — the three worked failures from backtest_current.md", () => {
  it("2026-07-30 07:22: shipped said 243 min, truth was 2 — the slot model says 5", () => {
    const nowMs = 1785385320000;
    const sessions = decodeWindow(nowMs - LOOKBACK_MS, CASE_A_WINDOW);
    const r = explainNextSwitch({ sessions, nowMs, liveSource: "gen" });
    const ACTUAL = 2;

    expect(r.cycle?.periodMinutes).toBe(120);
    expect(r.cycle!.concentration).toBeGreaterThan(0.75);
    expect(r.prediction?.method).toBe("slot");
    expect(r.holdChain).toHaveLength(1); // hands over at this boundary
    expect(r.holdChain[0]).toBeLessThan(0.5);
    expect(Math.abs(r.prediction!.remainingMinutes - ACTUAL)).toBeLessThanOrEqual(15);
  });

  it("2026-07-15 21:17: still wrong (gen DID hold), but a 129-min error instead of 248", () => {
    const nowMs = 1784139420000;
    const sessions = decodeWindow(nowMs - LOOKBACK_MS, CASE_B_WINDOW);
    const r = explainNextSwitch({ sessions, nowMs, liveSource: "gen" });
    const ACTUAL = 258;
    const SHIPPED_ERROR = Math.abs(10 - ACTUAL); // shipped predicted 10 min

    // The boundary estimate is sound; the hold coin-flip landed just the wrong side
    // of 0.5, which costs exactly one slot. That is the model's irreducible failure
    // mode on this data, not a bug — so it is pinned, not papered over.
    expect(r.prediction?.method).toBe("slot");
    expect(r.holdChain).toHaveLength(1);
    expect(r.holdChain[0]).toBeGreaterThan(0.4);
    expect(r.holdChain[0]).toBeLessThan(0.5);
    const error = Math.abs(r.prediction!.remainingMinutes - ACTUAL);
    expect(error).toBeLessThan(SHIPPED_ERROR / 1.5);
    expect(error).toBeCloseTo(129, -1); // one whole slot short
  });

  it("2026-07-28 07:22: still wrong (gen did NOT hold), but a 118-min error instead of 236", () => {
    const nowMs = 1785212520000;
    const sessions = decodeWindow(nowMs - LOOKBACK_MS, CASE_C_WINDOW);
    const r = explainNextSwitch({ sessions, nowMs, liveSource: "gen" });
    const ACTUAL = 7;
    const SHIPPED_ERROR = Math.abs(243 - ACTUAL); // shipped predicted 243 min

    // Mirror image of the previous case: P(hold) came out at 0.65 and the slot was
    // handed over anyway. The first boundary it computed was the right one — had the
    // coin landed the other way this would have been a 2-minute error.
    expect(r.prediction?.method).toBe("slot");
    expect(r.holdChain).toHaveLength(2);
    expect(r.holdChain[0]).toBeGreaterThan(0.5); // predicted the hold that did not happen
    const firstBoundary = nextBoundaryMs(
      r.currentStartMs + DEFAULT_TUNING.graceMinutes * MINUTE_MS,
      r.cycle!.periodMinutes,
      r.cycle!.phaseMinutes,
    );
    const boundaryError = Math.abs((firstBoundary - nowMs) / MINUTE_MS + r.endOffsetMinutes - ACTUAL);
    expect(boundaryError).toBeLessThanOrEqual(15); // the grid itself was located correctly

    const error = Math.abs(r.prediction!.remainingMinutes - ACTUAL);
    expect(error).toBeLessThan(SHIPPED_ERROR / 1.5);
  });
});
