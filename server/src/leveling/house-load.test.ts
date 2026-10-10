import { describe, it, expect } from "vitest";
import {
  armDropCooldown,
  HOUSE_LOAD_WINDOW_MS,
  houseLoadAmps,
  houseLoadResidual,
  initialHouseLoad,
  sampleHouseLoad,
  voidSamples,
} from "./house-load.js";
import { DEFAULT_LEVELING_CONFIG_V2, type LevelingConfigV2 } from "./config.js";
import type { AcView } from "./types.js";

const T = 1_000_000;

// The 2026-07-31 live models: Abdullah L2 4.8, Najat L1 2.3, Abdu L1 4.3 → 11.4A.
const models = {
  abdullah: { baseAmps: 2.3, stepAmps: 2.5 },
  najat: { baseAmps: 2.3, stepAmps: 2.0 },
  abdu: { baseAmps: 4.3, stepAmps: 2.5 },
};
const cfg: LevelingConfigV2 = {
  ...DEFAULT_LEVELING_CONFIG_V2,
  genLimitAmps: 15,
  // Same models on both lines, so the cross-source carry tests below compare
  // like with like: the house is the same house whichever line feeds it.
  ampModels: models,
  genAmpModels: models,
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
    subFloorStalledMs: 0,
    compressorOffLikely: false,
    roomTempC: null,
    boostFloorHard: false,
    unmeteredJumpAmps: 0,
    ...overrides,
    envelopeLevel: overrides.envelopeLevel ?? overrides.currentLevel ?? 1,
    rankNeedDelta: overrides.rankNeedDelta ?? overrides.needDelta ?? 2,
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
    // 10.7A against an 11.4A model: the compressors are drawing a little under
    // their caps, which is ordinary and still an honest zero-house reading.
    expect(houseLoadResidual(10.7, live(), cfg, "gen")).toBe(0);
  });

  it("refuses the reading entirely once the model sits well above the meter", () => {
    // The 2026-08-04 11:20 shape: 6.1A metered against an 11.4A model, because
    // every compressor was still in restart protection. `max(0, …)` would floor
    // that to a confident 0.0A of house — fiction, not measurement.
    expect(houseLoadResidual(6.1, live(), cfg, "gen")).toBeNull();
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

describe("voidSamples — a room that was drawing before we knew (2026-08-02)", () => {
  // The rise-side twin of the turn-off decay contamination below: `runningSet`
  // keys off the cloud SHADOW, so a room physically on with a lagging shadow
  // books its whole compressor as "house", tagged with the set that excludes
  // it — the same set that recurs on every re-shed. Live: 6.0A of "house"
  // against a real ~2.7A, blocking every raise for 15 minutes.
  const withoutNajat = () => [ac("abdullah", { currentLevel: 2, minLevel: 2 }), ac("abdu")];

  const poisoned = () => {
    // 12.0A metered while the model only knows Abdullah 4.8 + Abdu 4.3 = 9.1;
    // Najat's 2.9 lands in the residual.
    const s = sampleHouseLoad(initialHouseLoad(), {
      source: "gen",
      at: T,
      smoothedAmps: 12.0,
      acs: withoutNajat(),
      config: cfg,
    });
    expect(houseLoadAmps(s, "gen", T + 1_000, withoutNajat())).toBeCloseTo(2.9, 5);
    return s;
  };

  it("drops samples that modeled the room off while it was drawing", () => {
    const voided = voidSamples(poisoned(), "gen", { excludeDeviceId: "najat", since: T - 1 });
    expect(houseLoadAmps(voided, "gen", T + 1_000, withoutNajat())).toBe(0);
  });

  it("keeps samples older than the window it can vouch for", () => {
    const voided = voidSamples(poisoned(), "gen", { excludeDeviceId: "najat", since: T + 1 });
    expect(houseLoadAmps(voided, "gen", T + 1_000, withoutNajat())).toBeCloseTo(2.9, 5);
  });

  it("keeps samples that DID model the room — those were honest", () => {
    const s = sampleHouseLoad(initialHouseLoad(), {
      source: "gen",
      at: T,
      smoothedAmps: 12.0,
      acs: live(),
      config: cfg,
    });
    const voided = voidSamples(s, "gen", { excludeDeviceId: "najat", since: T - 1 });
    expect(houseLoadAmps(voided, "gen", T + 1_000, live())).toBeGreaterThan(0);
  });

  it("is a no-op for a source that has never been sampled", () => {
    const s = poisoned();
    expect(voidSamples(s, "grid", { excludeDeviceId: "najat", since: T - 1 })).toBe(s);
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

  it("is 0 with no power source, whatever either line has measured", () => {
    const s = sampleHouseLoad(initialHouseLoad(), {
      source: "gen",
      at: T,
      smoothedAmps: 12.965,
      acs: live(),
      config: cfg,
    });
    expect(houseLoadAmps(s, "none", T, live())).toBe(0);
  });

  it("a ramping tick records no sample but ADVANCES the drop detector's memory (2026-08-08)", () => {
    // Was `expect(after).toBe(before)` — the old behavior this fix corrects. A
    // restore→shed round trip completes entirely inside the ramp, and a memory
    // frozen at the pre-restore total never sees the re-shed's modeled drop, so
    // the first tick that resumed sampling booked the dying compressor as house
    // (7.2 A phantom, live). No usable residual while a compressor ramps, but
    // the memory must move.
    const before = initialHouseLoad();
    const after = sampleHouseLoad(before, {
      source: "gen",
      at: T,
      smoothedAmps: 12.965,
      acs: [ac("abdu", { ramping: true })],
      config: cfg,
    });
    expect(after.gen?.samples ?? []).toHaveLength(0);
    expect(after.gen?.lastModeledAmps).toBeCloseTo(4.3, 5); // abdu L1
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

// ---------------------------------------------------------------------------
// 2026-08-08: a restore→shed round trip that completes entirely inside a
// sampling suppression froze the drop detector's memory at the PRE-restore
// total, so the re-shed's modeled drop was invisible and the first tick that
// resumed sampling booked the dying compressor as house (7.2A phantom, live,
// tagged with the 2-room set so it recurred on every re-shed). The memory must
// advance on EVERY tick — the ramp skip and the shell's stand-downs gate the
// SAMPLE only — and the belt (`armDropCooldown`) pauses sampling the moment a
// commanded cut ships, even if the detector's memory is ever starved again.
// ---------------------------------------------------------------------------

describe("restore→shed round trip inside a suppression (2026-08-08)", () => {
  const peer = () => [ac("abdullah", { currentLevel: 2, minLevel: 2 }), ac("abdu", { currentLevel: 1 })]; // 9.1

  it("the ramp rebases the memory so the re-shed's drop arms the cooldown", () => {
    // Peer set settled, sampling live: 12.9 − 9.1 = 3.8A honest house.
    let s = sampleHouseLoad(initialHouseLoad(), {
      source: "gen", at: T, smoothedAmps: 12.9, acs: peer(), config: cfg,
    });
    expect(s.gen?.lastModeledAmps).toBeCloseTo(9.1, 5);
    // Najat's restore is sent — the shell suppresses the SAMPLE (unconfirmed ON)
    // but the memory must still advance. Najat is still shed (modeled 9.1).
    s = sampleHouseLoad(s, {
      source: "gen", at: T + 5_000, smoothedAmps: 12.9, acs: peer(), config: cfg,
      sampleSuppressed: true,
    });
    expect(s.gen?.samples).toHaveLength(1); // no new sample under the stand-down
    expect(s.gen?.lastModeledAmps).toBeCloseTo(9.1, 5);
    // The shadow confirms: najat joins the running set and RAMPS. No sample, but
    // the memory rebases UP to 11.4 — the step that used to freeze.
    s = sampleHouseLoad(s, {
      source: "gen", at: T + 10_000, smoothedAmps: 13.5,
      acs: [ac("abdullah", { currentLevel: 2, minLevel: 2 }), ac("abdu"), ac("najat", { ramping: true })],
      config: cfg,
    });
    expect(s.gen?.samples).toHaveLength(1);
    expect(s.gen?.lastModeledAmps).toBeCloseTo(11.4, 5);
    // Najat is re-shed 90s later (inside the ramp). The next tick's smoothed still
    // carries her dying compressor (15.1), but the modeled side has already
    // dropped to 9.1: the drop is SEEN (11.4 → 9.1), the cooldown arms, and the
    // 15.1 − 9.1 = 6.0A phantom is never recorded — the honest pre-restore peak
    // (3.8) carries instead.
    s = sampleHouseLoad(s, {
      source: "gen", at: T + 100_000, smoothedAmps: 15.1, acs: peer(), config: cfg,
    });
    expect(s.gen?.samples).toHaveLength(1);
    expect(houseLoadAmps(s, "gen", T + 100_000, peer())).toBeCloseTo(3.8, 5);
    // Past the cooldown the meter has settled: the NEW sample is the honest
    // 11.1 − 9.1 = 2.0A residual, not the phantom.
    const resumed = T + 100_000 + COOLDOWN_MS + 1_000;
    s = sampleHouseLoad(s, { source: "gen", at: resumed, smoothedAmps: 11.1, acs: peer(), config: cfg });
    const samples = s.gen?.samples ?? [];
    expect(samples).toHaveLength(2);
    expect(samples[samples.length - 1].amps).toBeCloseTo(2.0, 5);
  });

  it("armDropCooldown pauses sampling without touching the detector's memory", () => {
    // The belt: a commanded cut arms the cooldown directly. The reading that
    // follows — the dying compressor still on the meter — is refused as a sample,
    // and the memory is left for the detector alone (no phantom drop or rise).
    let s = sampleHouseLoad(initialHouseLoad(), {
      source: "gen", at: T, smoothedAmps: 12.9, acs: peer(), config: cfg,
    });
    const before = s.gen?.lastModeledAmps;
    s = armDropCooldown(s, "gen", T + 1_000);
    expect(s.gen?.lastModeledAmps).toBe(before); // memory untouched
    s = sampleHouseLoad(s, { source: "gen", at: T + 5_000, smoothedAmps: 15.1, acs: peer(), config: cfg });
    expect(s.gen?.samples).toHaveLength(1); // refused inside the armed cooldown
    const resumed = T + 1_000 + COOLDOWN_MS + 1_000;
    s = sampleHouseLoad(s, { source: "gen", at: resumed, smoothedAmps: 11.5, acs: peer(), config: cfg });
    expect(s.gen?.samples).toHaveLength(2); // honest sampling resumes
  });

  it("armDropCooldown on a source with no record arms the cooldown from nothing", () => {
    const s = armDropCooldown(initialHouseLoad(), "gen", T);
    const after = sampleHouseLoad(s, { source: "gen", at: T + 5_000, smoothedAmps: 15.1, acs: peer(), config: cfg });
    expect(after.gen?.samples ?? []).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 2026-08-04, the changeover dead window (11:16–11:23 Baghdad, 15A gen). The
// grid→gen changeover power-cycled all three ACs and TCL restart protection
// held every compressor off for ~6 minutes. The sampler, freed the moment the
// 240s ramp windows expired on the clock, recorded `max(0, 6.1 − 10.4) = 0` —
// fictitious ZERO-amp house samples — and the envelope then admitted two raises
// "incl. 0.0A house" against a house that was really ~6A. Everything engaged at
// once at 11:22 and the meter went to 16.6A.
//
// The residual can be wrong-LOW, not only wrong-high (invariant 20's blind
// side), and wrong-low is the permissive direction.
// ---------------------------------------------------------------------------

describe("the dead window (2026-08-04)", () => {
  it("records nothing at all while the model sits above the meter", () => {
    const s = sampleHouseLoad(initialHouseLoad(), {
      source: "gen",
      at: T,
      smoothedAmps: 6.1, // vs an 11.4A model — no compressor is running
      acs: live(),
      config: cfg,
    });
    expect(s.gen?.samples ?? []).toHaveLength(0);
  });

  it("a dead-compressor tick must not displace the honest peak it would replace", () => {
    // The discriminating shape: an honest sample tagged with all three rooms,
    // then one room off (its cooldown expires), then the compressors are still
    // dead — a changeover, a power cut, restart protection. The fiction would be
    // tagged with the CURRENT set, and an exact-set sample outranks the superset
    // carry, so a single 0.0 would erase 2.5A of measured house.
    const pair = () => [ac("abdullah", { currentLevel: 2, minLevel: 2 }), ac("abdu")];
    let s = sampleHouseLoad(initialHouseLoad(), {
      source: "gen",
      at: T,
      smoothedAmps: 13.9, // honest 2.5 with all three modeled (11.4)
      acs: live(),
      config: cfg,
    });
    s = sampleHouseLoad(s, {
      source: "gen",
      at: T + 60_000,
      smoothedAmps: 13.7, // najat off: the modeled drop arms the cooldown
      acs: pair(),
      config: cfg,
    });
    // Past the cooldown, but every compressor is dead: 6.1A metered against a
    // 9.1A model.
    const dead = T + 60_000 + COOLDOWN_MS + 5_000;
    s = sampleHouseLoad(s, { source: "gen", at: dead, smoothedAmps: 6.1, acs: pair(), config: cfg });
    expect(houseLoadAmps(s, "gen", dead, pair())).toBeCloseTo(2.5, 5);
  });

  it("records the METER itself as the house once every room is provably dead", () => {
    // What would have told the envelope "house ≈ 6A" BEFORE the 11:20 raises.
    const s = sampleHouseLoad(initialHouseLoad(), {
      source: "gen",
      at: T,
      smoothedAmps: 6.1,
      acs: live(),
      config: cfg,
      deadWindow: true,
    });
    expect(houseLoadAmps(s, "gen", T, live())).toBeCloseTo(6.1, 5);
  });

  it("the direct sample overrides the ramping skip and the modeled-drop cooldown", () => {
    // Both guards keep a RESIDUAL honest, and this is not a residual. During a
    // dead window every AC is ramping by construction, and the gen-entry FLOORS
    // clamp drops the model at exactly the wrong moment — honouring either would
    // blind the envelope to the only reading that can help it.
    const ramping = () => [
      ac("abdullah", { currentLevel: 2, minLevel: 2, ramping: true }),
      ac("najat", { ramping: true }),
      ac("abdu", { ramping: true }),
    ];
    let s = sampleHouseLoad(initialHouseLoad(), {
      source: "gen",
      at: T,
      smoothedAmps: 13.9,
      acs: live(),
      config: cfg,
    });
    // FLOORS clamps Abdu L2→L1 five seconds in: modeled drops, cooldown arms.
    const clamped = () => [
      ac("abdullah", { currentLevel: 2, minLevel: 2, ramping: true }),
      ac("najat", { ramping: true }),
      ac("abdu", { currentLevel: 1, ramping: true }),
    ];
    s = sampleHouseLoad(s, { source: "gen", at: T + 5_000, smoothedAmps: 10.0, acs: clamped(), config: cfg });
    s = sampleHouseLoad(s, {
      source: "gen",
      at: T + 60_000,
      smoothedAmps: 6.1,
      acs: clamped(),
      config: cfg,
      deadWindow: true,
    });
    expect(houseLoadAmps(s, "gen", T + 60_000, ramping())).toBeCloseTo(6.1, 5);
  });
});

describe("houseLoadAmps — the cross-source carry (2026-08-04)", () => {
  // A changeover ages the new source's record out by definition, which is
  // exactly when the envelope most needs a house figure: entry re-levels the
  // whole house. 0 is the one answer known to be wrong.
  const gridHouse = () =>
    sampleHouseLoad(initialHouseLoad(), {
      source: "grid",
      at: T,
      smoothedAmps: 17.4, // 6.0A of house over the 11.4A model
      acs: live(),
      config: cfg,
    });

  it("stands in the other line's measured house when this one has nothing usable", () => {
    expect(houseLoadAmps(gridHouse(), "gen", T + 60_000, live())).toBeCloseTo(6.0, 5);
  });

  it("a same-source sample outranks the carry the moment one exists", () => {
    const s = sampleHouseLoad(gridHouse(), {
      source: "gen",
      at: T + 60_000,
      smoothedAmps: 13.0, // 1.6A of house on this line
      acs: live(),
      config: cfg,
    });
    expect(houseLoadAmps(s, "gen", T + 60_000, live())).toBeCloseTo(1.6, 5);
  });

  it("even a same-source ZERO outranks the carry — that is a measurement too", () => {
    const s = sampleHouseLoad(gridHouse(), {
      source: "gen",
      at: T + 60_000,
      smoothedAmps: 10.7, // inside the trust gap: an honest house of 0
      acs: live(),
      config: cfg,
    });
    expect(houseLoadAmps(s, "gen", T + 60_000, live())).toBe(0);
  });

  it("ages the carry out on the same 15-minute window", () => {
    expect(houseLoadAmps(gridHouse(), "gen", T + HOUSE_LOAD_WINDOW_MS, live())).toBe(0);
  });

  it("applies the same set rules to the other line — a partial overlap carries nothing", () => {
    // Sampled on grid with {abdullah, najat}: any Abdu draw in that reading was
    // booked as house, so reusing it while Abdu runs would double-count him —
    // crossing lines does not relax that.
    const withoutAbdu = [ac("abdullah", { currentLevel: 2, minLevel: 2 }), ac("najat")];
    const s = sampleHouseLoad(initialHouseLoad(), {
      source: "grid",
      at: T,
      smoothedAmps: 8.6,
      acs: withoutAbdu,
      config: cfg,
    });
    expect(houseLoadAmps(s, "gen", T, live())).toBe(0);
    expect(houseLoadAmps(s, "gen", T, withoutAbdu)).toBeCloseTo(1.5, 5);
  });
});

describe("houseLoadAmps — the grid session memory (2026-09-27, Stream G)", () => {
  // Nearly every grid entry follows ~2 h of generator. The 15-minute window
  // has aged the grid record out by then, and the generator's house excludes
  // every grid-only load (the unmanaged guest AC among it), so the grid entry
  // used to be budgeted against a 4A house while the real one was 12A.
  const H = 60 * 60_000;
  const onGrid = (at: number, smoothedAmps: number, acs = live()) =>
    (state = initialHouseLoad()) =>
      sampleHouseLoad(state, { source: "grid", at, smoothedAmps, acs, config: cfg });
  const onGen = (at: number, smoothedAmps: number) => (state = initialHouseLoad()) =>
    sampleHouseLoad(state, { source: "gen", at, smoothedAmps, acs: live(), config: cfg });

  // Grid session: 12A of house over the 11.4A model. Then 2 h of generator at 4A.
  const afterGen = () => onGen(T + 2 * H, 15.4)(onGrid(T, 23.4)());

  it("a grid entry after a long generator session is budgeted on the grid house it last measured", () => {
    expect(houseLoadAmps(afterGen(), "grid", T + 2 * H, live())).toBeCloseTo(12.0, 5);
  });

  it("…the larger of the remembered grid house and the carried generator house", () => {
    const bigGen = onGen(T + 2 * H, 25.4)(onGrid(T, 23.4)()); // 14A on the generator
    expect(houseLoadAmps(bigGen, "grid", T + 2 * H, live())).toBeCloseTo(14.0, 5);
  });

  it("the memory is bounded: a day-old grid session is forgotten", () => {
    const s = onGen(T + 25 * H, 15.4)(onGrid(T, 23.4)());
    expect(houseLoadAmps(s, "grid", T + 25 * H, live())).toBeCloseTo(4.0, 5);
  });

  it("remembers the PEAK of the session's last window, the figure the grid itself reported", () => {
    // 20A of house early in the session, 12A at its end: the early peak aged out
    // of the grid ring while grid was still live, so it is not remembered.
    const s = onGrid(T + 20 * 60_000, 23.4)(onGrid(T, 31.4)());
    const after = onGen(T + 2 * H, 15.4)(s);
    expect(houseLoadAmps(after, "grid", T + 2 * H, live())).toBeCloseTo(12.0, 5);
  });

  it("only remembers samples that were themselves valid (a ramping tick is never a sample)", () => {
    const ramping = [ac("abdullah", { currentLevel: 2, minLevel: 2, ramping: true }), ac("najat"), ac("abdu")];
    const s = onGrid(T + 60_000, 30.0, ramping)(onGrid(T, 23.4)());
    const after = onGen(T + 2 * H, 15.4)(s);
    expect(houseLoadAmps(after, "grid", T + 2 * H, live())).toBeCloseTo(12.0, 5);
  });

  it("survives the first tick back on grid, which prunes the ring before anything is usable", () => {
    // Every compressor is ramping after the changeover: the tick is not a
    // sample, but it does prune the stale ring. The memory must outlive that.
    const ramping = live().map((a) => ({ ...a, ramping: true }));
    const back = onGrid(T + 2 * H, 30.0, ramping)(afterGen());
    expect(back.grid.samples).toHaveLength(0);
    expect(houseLoadAmps(back, "grid", T + 2 * H, live())).toBeCloseTo(12.0, 5);
  });

  it("a sample voided as a phantom leaves the memory too", () => {
    // The 12A reading turns out to have been Najat drawing before her shadow
    // said so (she was not in the running set): voiding it must drop it here.
    const withoutNajat = [ac("abdullah", { currentLevel: 2, minLevel: 2 }), ac("abdu")];
    const early = onGrid(T, 11.1, withoutNajat)(); // 2.0A of house over the 9.1A model
    const phantom = onGrid(T + 60_000, 21.1, withoutNajat)(early); // "12A" of house
    const voided = voidSamples(phantom, "grid", { excludeDeviceId: "najat", since: T + 30_000 });
    const after = onGen(T + 2 * H, 15.4)(voided);
    expect(houseLoadAmps(after, "grid", T + 2 * H, live())).toBeCloseTo(4.0, 5); // gen carry wins over 2.0
  });

  it("a POST-RETURN sample voided as a phantom falls back to the prior valid grid memory (Sol, 2026-09-27)", () => {
    // Back on grid: the ramping first tick prunes the stale ring (the 12A memory
    // survives beside it); a later usable sample replaces the memory; then the
    // shell discovers Najat was already drawing and voids that sample. The ring
    // is empty again, and the grid figure must fall back to the 12A the last
    // VALID grid session measured, not to the 4A generator carry.
    const withoutNajat = [ac("abdullah", { currentLevel: 2, minLevel: 2 }), ac("abdu")];
    const ramping = withoutNajat.map((a) => ({ ...a, ramping: true }));
    const back = onGrid(T + 2 * H, 30.0, ramping)(afterGen());
    expect(back.grid.samples).toHaveLength(0);
    // Past the drop cooldown the entry tick armed: a genuinely usable sample.
    const at = T + 2 * H + 3 * 60_000;
    const sampled = onGrid(at, 16.1, withoutNajat)(back); // "7A", Najat's hidden draw included
    expect(sampled.grid.samples).toHaveLength(1);
    expect(houseLoadAmps(sampled, "grid", at, live())).toBeCloseTo(7.0, 5); // precondition: memory replaced
    const voided = voidSamples(sampled, "grid", { excludeDeviceId: "najat", since: T + 2 * H });
    expect(voided.grid.samples).toHaveLength(0);
    expect(houseLoadAmps(voided, "grid", at, live())).toBeCloseTo(12.0, 5);
  });

  it("…but a prior memory that was ITSELF the voided evidence is dropped", () => {
    // The 12A session peak was taken with Najat drawing unseen (not in its set):
    // voiding her from before that sample must not keep it alive as memory.
    const withoutNajat = [ac("abdullah", { currentLevel: 2, minLevel: 2 }), ac("abdu")];
    const phantomSession = onGrid(T, 21.1, withoutNajat)(); // "12A" of house
    const afterGenPhantom = onGen(T + 2 * H, 15.4)(phantomSession);
    const ramping = withoutNajat.map((a) => ({ ...a, ramping: true }));
    const back = onGrid(T + 2 * H, 30.0, ramping)(afterGenPhantom);
    const at = T + 2 * H + 3 * 60_000;
    const sampled = onGrid(at, 16.1, withoutNajat)(back);
    const voided = voidSamples(sampled, "grid", { excludeDeviceId: "najat", since: T - 60_000 });
    expect(houseLoadAmps(voided, "grid", at, live())).toBeCloseTo(4.0, 5); // the gen carry alone
  });

  it("fresh grid evidence still wins the moment it exists", () => {
    const s = onGrid(T + 2 * H + 60_000, 17.4)(afterGen()); // 6A of house now
    expect(houseLoadAmps(s, "grid", T + 2 * H + 60_000, live())).toBeCloseTo(6.0, 5);
  });

  it("the generator's figure is untouched by the grid memory", () => {
    const s = onGrid(T, 23.4)();
    // No gen samples: the gen query still carries only a fresh (in-window) grid peak.
    expect(houseLoadAmps(s, "gen", T + 2 * H, live())).toBe(0);
    expect(houseLoadAmps(afterGen(), "gen", T + 2 * H, live())).toBeCloseTo(4.0, 5);
  });
});
