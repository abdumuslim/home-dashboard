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

  it("a partial overlap is no better than a different set — every running room must have been modeled", () => {
    // Sampled with {abdullah, najat}: any abdu draw in that reading was booked
    // as house. Reusing it while abdu runs would double-count him.
    const withoutAbdu = [ac("abdullah", { currentLevel: 2, minLevel: 2 }), ac("najat", { currentLevel: 1 })];
    const s = sampleHouseLoad(initialHouseLoad(), {
      source: "gen",
      at: T,
      smoothedAmps: 8.6,
      acs: withoutAbdu,
      config: cfg,
    });
    expect(houseLoadAmps(s, "gen", T, [ac("najat"), ac("abdu")])).toBe(0);
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
    expect((s.gen?.samples ?? []).length).toBeLessThanOrEqual(400);
  });
});

// ---------------------------------------------------------------------------
// 2026-08-01, 15A gen (live 17:27 Baghdad). Abdullah's AC turned off; the next
// tick's smoothed meter still carried his dying compressor, the modeled side
// had already dropped him, and the residual booked 7.1A of "house" (real:
// ~4.1A). That single sample was the only one tagged with the new set, so it
// WAS the 15-minute peak — every raise was refused at "worst case 16.2A >
// 14.9A" while the meter sat at 11–12A, until the user raised Abdu by hand.
// The fix: a modeled DROP (turn-off, shed, level cut — the model falls before
// the meter can follow) pauses sampling for a cooldown, and while the new set
// has no samples of its own the envelope carries the peak from samples whose
// set modeled every room now running (a superset cannot double-count anyone).
// ---------------------------------------------------------------------------

// Mirrors HOUSE_SAMPLE_COOLDOWN_MS — the tests spell it out so a constant edit
// is a conscious re-verification, not a silent retune.
const COOLDOWN_MS = 2 * 60_000;

describe("turn-off decay contamination (2026-08-01)", () => {
  const afterOff = () => [ac("najat", { currentLevel: 1 }), ac("abdu", { currentLevel: 1 })]; // modeled 6.6

  it("never books the dying compressor as house — the honest pre-off peak carries instead", () => {
    // Settled honest sample: 13.9 − 11.4 = 2.5A of real house.
    let s = sampleHouseLoad(initialHouseLoad(), {
      source: "gen",
      at: T,
      smoothedAmps: 13.9,
      acs: live(),
      config: cfg,
    });
    // Abdullah goes off. Model: 6.6. Smoothed: still 13.7 → the live 7.1 shape.
    s = sampleHouseLoad(s, {
      source: "gen",
      at: T + 60_000,
      smoothedAmps: 13.7,
      acs: afterOff(),
      config: cfg,
    });
    expect(houseLoadAmps(s, "gen", T + 60_000, afterOff())).toBeCloseTo(2.5, 5);
    // Still cooling 30s later — the sampler stays paused.
    s = sampleHouseLoad(s, {
      source: "gen",
      at: T + 90_000,
      smoothedAmps: 12.4,
      acs: afterOff(),
      config: cfg,
    });
    expect(houseLoadAmps(s, "gen", T + 90_000, afterOff())).toBeCloseTo(2.5, 5);
    // Past the cooldown the meter has settled: 11.1 − 6.6 = 4.5 honest amps,
    // and the new set's own samples take over from the carried peak.
    const resumed = T + 60_000 + COOLDOWN_MS + 1_000;
    s = sampleHouseLoad(s, {
      source: "gen",
      at: resumed,
      smoothedAmps: 11.1,
      acs: afterOff(),
      config: cfg,
    });
    expect(houseLoadAmps(s, "gen", resumed, afterOff())).toBeCloseTo(4.5, 5);
  });

  it("a level cut's wind-down is skipped the same way — the model fell, the meter has not", () => {
    const before = [ac("abdullah", { currentLevel: 2, minLevel: 2 }), ac("najat"), ac("abdu", { currentLevel: 2 })]; // 13.9
    const after = [ac("abdullah", { currentLevel: 2, minLevel: 2 }), ac("najat"), ac("abdu", { currentLevel: 1 })]; // 11.4
    let s = sampleHouseLoad(initialHouseLoad(), {
      source: "gen",
      at: T,
      smoothedAmps: 15.4, // honest 1.5
      acs: before,
      config: cfg,
    });
    // Abdu's demote confirms; the compressor is still throttling down.
    s = sampleHouseLoad(s, {
      source: "gen",
      at: T + 30_000,
      smoothedAmps: 15.2, // would book 3.8 phantom amps
      acs: after,
      config: cfg,
    });
    // Same members, same tag — the pre-cut sample IS the peak.
    expect(houseLoadAmps(s, "gen", T + 30_000, after)).toBeCloseTo(1.5, 5);
    const resumed = T + 30_000 + COOLDOWN_MS + 1_000;
    s = sampleHouseLoad(s, {
      source: "gen",
      at: resumed,
      smoothedAmps: 13.0, // settled: 1.6 honest
      acs: after,
      config: cfg,
    });
    expect(houseLoadAmps(s, "gen", resumed, after)).toBeCloseTo(1.6, 5);
  });

  it("a second drop re-arms the cooldown — a double shed stays unsampled to the end", () => {
    const soloAbdu = () => [ac("abdu", { currentLevel: 1 })]; // modeled 4.3
    let s = sampleHouseLoad(initialHouseLoad(), {
      source: "gen",
      at: T,
      smoothedAmps: 13.9, // honest 2.5
      acs: live(),
      config: cfg,
    });
    s = sampleHouseLoad(s, { source: "gen", at: T + 60_000, smoothedAmps: 13.7, acs: afterOff(), config: cfg });
    // Najat goes too, 90s later — inside the first cooldown.
    s = sampleHouseLoad(s, { source: "gen", at: T + 150_000, smoothedAmps: 9.9, acs: soloAbdu(), config: cfg });
    // The first cooldown alone would have expired here; the re-arm must not have.
    s = sampleHouseLoad(s, { source: "gen", at: T + 200_000, smoothedAmps: 9.7, acs: soloAbdu(), config: cfg });
    expect(houseLoadAmps(s, "gen", T + 200_000, soloAbdu())).toBeCloseTo(2.5, 5);
    const resumed = T + 150_000 + COOLDOWN_MS + 1_000;
    s = sampleHouseLoad(s, { source: "gen", at: resumed, smoothedAmps: 8.4, acs: soloAbdu(), config: cfg });
    expect(houseLoadAmps(s, "gen", resumed, soloAbdu())).toBeCloseTo(4.1, 5);
  });
});
