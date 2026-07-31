import { describe, it, expect } from "vitest";
import {
  HOUSE_LOAD_WINDOW_MS,
  houseLoadAmps,
  houseLoadResidual,
  initialHouseLoad,
  sampleHouseLoad,
} from "./house-load.js";
import { DEFAULT_LEVELING_CONFIG_V2, type LevelingConfigV2 } from "./config.js";
import type { AcView } from "./types.js";

const T = 1_000_000;

// The 2026-07-31 live models: Abdullah L2 4.8, Najat L1 2.3, Abdu L1 4.3 → 11.4A.
const cfg: LevelingConfigV2 = {
  ...DEFAULT_LEVELING_CONFIG_V2,
  genLimitAmps: 15,
  genAmpModels: {
    abdullah: { baseAmps: 2.3, stepAmps: 2.5 },
    najat: { baseAmps: 2.3, stepAmps: 2.0 },
    abdu: { baseAmps: 4.3, stepAmps: 2.5 },
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
    currentLevel: 1,
    fanSpeed: 3,
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
    unmeteredJumpAmps: 0,
    ...overrides,
    envelopeLevel: overrides.envelopeLevel ?? overrides.currentLevel ?? 1,
  };
}

const live = () => [
  ac("abdullah", { currentLevel: 2, minLevel: 2 }),
  ac("najat", { currentLevel: 1 }),
  ac("abdu", { currentLevel: 1 }),
];

describe("houseLoadResidual", () => {
  it("is the meter minus the modeled AC draw (the live 17:23:29 reading)", () => {
    expect(houseLoadResidual(12.965, live(), cfg, "gen")).toBeCloseTo(1.565, 3);
  });

  it("floors at zero — a satisfied house cycling under its caps owes nothing", () => {
    expect(houseLoadResidual(5.0, live(), cfg, "gen")).toBe(0);
  });

  it("skips the sample entirely while a compressor is ramping", () => {
    const ramping = [ac("abdullah", { currentLevel: 2, minLevel: 2, ramping: true }), ac("najat")];
    expect(houseLoadResidual(12.965, ramping, cfg, "gen")).toBeNull();
  });

  it("counts an off/shed/unmanaged AC's load as house, not as AC", () => {
    const acs = [ac("abdu", { currentLevel: 1 }), ac("najat", { on: false, shed: true })];
    // Only Abdu's 4.3 is modeled; Najat contributes nothing to the AC side.
    expect(houseLoadResidual(6.0, acs, cfg, "gen")).toBeCloseTo(1.7, 5);
  });
});

describe("houseLoadAmps — the rolling PEAK", () => {
  it("returns 0 before anything is sampled (the AC-only envelope v2 shipped with)", () => {
    expect(houseLoadAmps(initialHouseLoad(), "gen", T, live())).toBe(0);
  });

  it("takes the peak, not the latest — a trough must not make the guard permissive", () => {
    // The live shape: 1.57A at 17:23:29, then 0.90A eight minutes later while
    // the compressors sat closer to their caps. The envelope wants the 1.57.
    let s = sampleHouseLoad(initialHouseLoad(), {
      source: "gen",
      at: T,
      smoothedAmps: 12.965,
      acs: live(),
      config: cfg,
    });
    s = sampleHouseLoad(s, {
      source: "gen",
      at: T + 8 * 60_000,
      smoothedAmps: 12.295,
      acs: live(),
      config: cfg,
    });
    expect(houseLoadAmps(s, "gen", T + 8 * 60_000, live())).toBeCloseTo(1.565, 3);
  });

  it("lets a stale peak expire out of the window", () => {
    const s = sampleHouseLoad(initialHouseLoad(), {
      source: "gen",
      at: T,
      smoothedAmps: 12.965,
      acs: live(),
      config: cfg,
    });
    expect(houseLoadAmps(s, "gen", T + HOUSE_LOAD_WINDOW_MS, live())).toBe(0);
  });

  it("never mixes sources — a gen residual says nothing about grid", () => {
    const s = sampleHouseLoad(initialHouseLoad(), {
      source: "gen",
      at: T,
      smoothedAmps: 12.965,
      acs: live(),
      config: cfg,
    });
    expect(houseLoadAmps(s, "grid", T, live())).toBe(0);
    expect(houseLoadAmps(s, "none", T, live())).toBe(0);
  });

  it("a ramping tick leaves the state untouched", () => {
    const before = initialHouseLoad();
    const after = sampleHouseLoad(before, {
      source: "gen",
      at: T,
      smoothedAmps: 12.965,
      acs: [ac("abdu", { ramping: true })],
      config: cfg,
    });
    expect(after).toBe(before);
  });

  it("ignores samples taken with a DIFFERENT set of ACs running", () => {
    // While a room is off its whole draw lands in the residual — reuse that
    // sample once it comes back and the room is counted twice (as house, and
    // as a cap in the envelope). Live-shaped: house 1.6A, Abdu's 4.3A off.
    const withoutAbdu = [ac("abdullah", { currentLevel: 2, minLevel: 2 }), ac("najat", { currentLevel: 1 })];
    const s = sampleHouseLoad(initialHouseLoad(), {
      source: "gen",
      at: T,
      smoothedAmps: 12.965, // residual 12.965 − 7.1 = 5.865 with Abdu off
      acs: withoutAbdu,
      config: cfg,
    });
    expect(houseLoadAmps(s, "gen", T, withoutAbdu)).toBeCloseTo(5.865, 3);
    expect(houseLoadAmps(s, "gen", T, live())).toBe(0);
  });

  it("prunes as it writes — a long session stays bounded", () => {
    let s = initialHouseLoad();
    for (let i = 0; i < 600; i++) {
      s = sampleHouseLoad(s, {
        source: "gen",
        at: T + i * 5_000,
        smoothedAmps: 12.965,
        acs: live(),
        config: cfg,
      });
    }
    expect((s.gen ?? []).length).toBeLessThanOrEqual(400);
  });
});
