// Incident regressions for leveling v2, encoded against the scenario harness.
// Each block names the live incident (or chronic pattern) it pins down.

import { describe, it, expect } from "vitest";
import { Scenario, type SimAcSetup } from "./scenario.js";
import { DEFAULT_LEVELING_CONFIG_V2, type LevelingConfigV2 } from "./config.js";
import type { Command } from "./types.js";

const cfg: LevelingConfigV2 = {
  ...DEFAULT_LEVELING_CONFIG_V2,
  enabled: true,
  controller: "v2",
  genLimitAmps: 14.9,
  gridLimitAmps: 27,
  marginAmps: 0.1,
  restingBufferAmps: 0.2,
  raiseCalmSeconds: 30,
  restoreCalmSeconds: 15,
  fanTrimEnabled: true,
  nearTargetBandC: 0.5,
  priority: ["abdullah", "najat", "abdu"],
  ampModels: {
    abdu: { baseAmps: 4.1, stepAmps: 2.2 },
    abdullah: { baseAmps: 2.3, stepAmps: 1.5 },
    najat: { baseAmps: 2.5, stepAmps: 1.5 },
  },
  genAmpModels: {
    abdu: { baseAmps: 4.5, stepAmps: 2.4 },
    abdullah: { baseAmps: 2.5, stepAmps: 1.6 },
    najat: { baseAmps: 2.7, stepAmps: 1.6 },
  },
};

// Capacity-corrected hot-case cap ceilings (2-ton Abdu; 1-ton Abdullah/Najat).
const ABDU: SimAcSetup = {
  deviceId: "abdu",
  capAmps: [4.1, 6.5, 9.0],
  demandAmps: 6.0,
  needDelta: 2,
  level: 2,
  rampSeconds: 30,
};
const ABDULLAH: SimAcSetup = {
  deviceId: "abdullah",
  capAmps: [2.2, 3.9, 5.3],
  demandAmps: 3.5,
  needDelta: 1,
  level: 2,
  rampSeconds: 30,
};
const NAJAT: SimAcSetup = {
  deviceId: "najat",
  capAmps: [2.2, 3.9, 5.3],
  demandAmps: 3.0,
  needDelta: 0.4,
  level: 1,
  rampSeconds: 30,
};

const setLevels = (s: Scenario, since: number) =>
  s.commandsSince(since, "set_level").map((e) => ({ at: e.at, cmd: e.cmd as Extract<Command, { kind: "set_level" }> }));

describe("quiet at the resting point (anti-churn acceptance)", () => {
  it("±0.5A noise near the resting point → ZERO commands for 30 minutes", () => {
    const s = new Scenario(cfg, [ABDU, ABDULLAH, NAJAT], { nonAcAmps: 2, source: "gen" });
    s.advance(60); // settle in
    s.setNoise(0.5);
    const t0 = s.now;
    s.advance(30 * 60);
    expect(s.commandsSince(t0)).toHaveLength(0);
  });
});

describe("mild overload → one graduated level cut (v1 could only floor-everyone or cascade fans)", () => {
  it("a ~0.6A overshoot cuts ONE level once fans can't cover — no cascade, no shed, no floor-everyone", () => {
    const s = new Scenario(cfg, [ABDU, ABDULLAH, NAJAT], { nonAcAmps: 2.6, source: "gen" });
    s.advance(30); // total ≈ 14.6, stable
    const t0 = s.now;
    s.setDemand("abdu", 7); // cap-bound at L2 → 6.5 → total ≈ 15.1–15.2 (mild over)
    s.advance(35); // enough for the bucket (5 mild readings) + the cut
    const cuts = setLevels(s, t0);
    expect(cuts).toHaveLength(1);
    // Top-priority Abdullah is cut LAST among levels (ported weighting) — the
    // optimizer takes Abdu's level even though his room is hotter.
    expect(cuts[0].cmd).toMatchObject({ deviceId: "abdu", level: 1 });
    // Aftermath: freed headroom may legitimately raise a peer, but never a
    // shed, never a fan cascade, and the meter lands under the limit.
    s.advance(60);
    expect(s.commandsSince(t0, "power_off")).toHaveLength(0);
    expect(s.totalAmps()).toBeLessThan(14.9);
  });
});

describe("extreme overshoot forces a shed (breaker thermal curve beats cap-throttle latency)", () => {
  it("a ~4A overshoot sheds the most-satisfied room within seconds — the hot room stays on", () => {
    const s = new Scenario(cfg, [ABDU, ABDULLAH, NAJAT], { nonAcAmps: 2.6, source: "gen" });
    s.advance(30);
    s.setDemand("abdu", 11, 3);
    s.setDemand("abdullah", 5.5, 2);
    s.setDemand("najat", 5, 0.3);
    const t0 = s.now;
    s.setNonAc(6.2); // total ≈ 19.1 — like the live 08:43 event at 18.9A
    s.advance(20);
    const sheds = s.commandsSince(t0, "power_off");
    expect(sheds.length).toBeGreaterThanOrEqual(1);
    expect(sheds[0].cmd.deviceId).toBe("najat"); // most satisfied, NOT the hot room
    expect(s.sim("abdu").on).toBe(true);
  });
});

describe("gen entry floors (changeover AND cold start) then meter-confirmed one-step climb", () => {
  it("floors every above-floor AC immediately, waits out confirm+ramp+calm, then raises ONE step per batch", () => {
    const hot = { ...ABDU, level: 3, demandAmps: 8, confirmDelayMs: 10_000 };
    const hot2 = { ...ABDULLAH, level: 3, demandAmps: 4.5, confirmDelayMs: 10_000 };
    const s = new Scenario(cfg, [hot, hot2, NAJAT], { nonAcAmps: 2, source: "grid" });
    s.advance(60); // on grid, 27A limit — everything fits
    const flip = s.now;
    s.setSource("gen");
    s.advance(10);
    // Floors shipped promptly on gen entry (re-asserted until the shadow confirms):
    const floored = new Set(
      setLevels(s, flip)
        .filter((c) => c.cmd.level === 1)
        .map((c) => c.cmd.deviceId),
    );
    expect([...floored].sort()).toEqual(["abdu", "abdullah"]);
    // No raise before confirm (10s) + ramp (30s) + calm (30s):
    s.advance(30);
    expect(setLevels(s, flip + 10_000).filter((c) => c.cmd.level > 1)).toHaveLength(0);
    // The climb resumes — one raise command per batch on gen, spaced by settle.
    s.advance(180);
    const raises = setLevels(s, flip + 40_000).filter((c) => c.cmd.level > 1);
    expect(raises.length).toBeGreaterThanOrEqual(1);
    // Never two upward levels in the same batch (the 07-23 double-raise → 16.6A):
    const byTime = new Map<number, number>();
    for (const r of raises) byTime.set(r.at, (byTime.get(r.at) ?? 0) + 1);
    for (const count of byTime.values()) expect(count).toBe(1);
    // And the meter never crossed the breaker during the whole climb:
    expect(s.totalAmps()).toBeLessThanOrEqual(14.9);
  });

  it("cold start into gen (deploy/blackout mid-gen) floors too — the 2026-07-10 regression", () => {
    const hot = { ...ABDU, level: 3, demandAmps: 8 };
    const s = new Scenario(cfg, [hot, ABDULLAH, NAJAT], { nonAcAmps: 2, source: "gen", coldStart: true });
    // First reading is none→gen (fresh controller state) — FLOORS must arm.
    s.advance(10);
    const floors = setLevels(s, 0);
    expect(floors.some((c) => c.cmd.deviceId === "abdu" && c.cmd.level === 1)).toBe(true);
  });
});

describe("power collapse (external trip — the dominant real-world event)", () => {
  function settled(): Scenario {
    const s = new Scenario(cfg, [ABDU, ABDULLAH, { ...NAJAT, needDelta: 2, demandAmps: 3 }], {
      nonAcAmps: 2,
      source: "gen",
    });
    s.advance(120);
    return s;
  }

  it("latches, blocks ALL commands, and calm stays frozen while the line is dead", () => {
    const s = settled();
    const t0 = s.now;
    s.trip();
    s.advance(60);
    expect(s.events.some((e) => e.event.kind === "collapse")).toBe(true);
    expect(s.commandsSince(t0)).toHaveLength(0);
    expect(s.plans[s.plans.length - 1].reason).toBe("collapsed");
  });

  it("after recovery: no raise during the compressor ramp; the meter never crosses the breaker", () => {
    const s = settled();
    s.trip();
    s.advance(30);
    const rec = s.now;
    s.recoverLine();
    s.setDemand("najat", 3.5, 2.5); // make a raise tempting immediately
    s.advance(25); // inside the 30s ramp
    expect(setLevels(s, rec).filter((c) => c.cmd.level > 1)).toHaveLength(0);
    s.advance(120);
    expect(s.totalAmps()).toBeLessThanOrEqual(14.9);
  });
});

describe("restore backoff (kills the 49m/1h18m strands, bounds the shed↔restore churn)", () => {
  it("a bouncing restore retries on a growing-but-CAPPED ladder — no strand, no machine-gunning", () => {
    // Peers pinned at floors with no fan slack; Najat's startup surge (2× her
    // L1 cap — the measured 4.4A vs 2.2A) breaches the limit after every
    // restore, so the ONLY cover is re-shedding her: the v1 bounce loop.
    const s = new Scenario(
      cfg,
      [
        { ...ABDU, level: 1, fan: 1, demandAmps: 6, needDelta: 2 },
        { ...ABDULLAH, level: 1, fan: 1, demandAmps: 3.5, needDelta: 1 },
        { ...NAJAT, shed: true, fan: 1, demandAmps: 4.5, needDelta: 0.8, surgeFactor: 2, rampSeconds: 60 },
      ],
      { nonAcAmps: 5.7, source: "gen" }, // total with Najat off ≈ 12.0
    );
    const t0 = s.now;
    s.advance(30 * 60);
    const restores = s.commandsSince(t0, "power_on");
    const sheds = s.commandsSince(t0, "power_off");
    // Retries keep happening (no strand)…
    expect(restores.length).toBeGreaterThanOrEqual(2);
    // …every failure is followed by a bounded wait (ladder cap 15m + slack):
    for (let i = 1; i < restores.length; i++) {
      expect(restores[i].at - restores[i - 1].at).toBeLessThanOrEqual(16 * 60_000);
    }
    // …and the gaps GROW (the ladder bites — v1 re-shed 6× in 31 minutes):
    if (restores.length >= 3) {
      const g1 = restores[1].at - restores[0].at;
      const gLast = restores[restores.length - 1].at - restores[restores.length - 2].at;
      expect(gLast).toBeGreaterThan(g1);
    }
    expect(sheds.length).toBeLessThanOrEqual(restores.length + 1);
  });
});

describe("fans are last-resort trim (57% of v1 fan cuts fired with level cuts available)", () => {
  it("at floors, a tiny overshoot trims a fan instead of shedding — and the restore waits out the long calm", () => {
    const floored = (setup: SimAcSetup, demand: number, need: number): SimAcSetup => ({
      ...setup,
      level: 1,
      demandAmps: demand,
      needDelta: need,
      fan: 5,
    });
    const s = new Scenario(
      cfg,
      [floored(ABDU, 4.1, 1), floored(ABDULLAH, 2.4, 0.8), floored(NAJAT, 2.4, 0.4)],
      { nonAcAmps: 5.8, source: "gen" },
    );
    // total ≈ 5.8 + 4.1 + 2.2 + 2.2 + fan extras 0.6 ≈ 15.0 → mild over.
    const t0 = s.now;
    s.advance(90);
    expect(s.commandsSince(t0, "power_off")).toHaveLength(0);
    expect(s.commandsSince(t0, "set_level")).toHaveLength(0); // everyone already at floor
    expect(s.commandsSince(t0, "set_fan").length).toBeGreaterThanOrEqual(1);
    // Restore side: drop the load, then verify the held fan does NOT bounce
    // back within v1's 61s median — it waits out the 5-minute calm gate.
    s.setNonAc(4.0);
    const t1 = s.now;
    s.advance(240);
    expect(s.commandsSince(t1, "set_fan")).toHaveLength(0); // 4 min < 5 min gate
    s.advance(120);
    expect(s.commandsSince(t1, "set_fan").length).toBeGreaterThanOrEqual(1); // climbed after 5 min
  });
});

describe("2026-07-23 double-L3 gen trip (physics-envelope regression)", () => {
  // The live incident: the meter showed room (cool compressors / lagging ramp /
  // frozen ESP), the controller climbed BOTH big rooms to L3 on the 15A gen,
  // and when demand arrived the caps entitled 15.6A → breaker trip 68s later.
  // The envelope veto must refuse the second L3 END-STATE regardless of meter.
  it("never lands abdu AND najat on L3 together; the later heat surge stays under the breaker", () => {
    const s = new Scenario(
      cfg,
      [
        { ...ABDU, level: 1, demandAmps: 5, needDelta: 3.4 }, // cool now — draws under cap
        { ...NAJAT, level: 1, demandAmps: 3, needDelta: 2.7 },
      ],
      { nonAcAmps: 1.3, source: "gen" },
    );
    s.advance(600); // let it climb as far as it wants
    // The meter never objected (cool draws), so only the envelope can have
    // stopped the last step: najat must never be COMMANDED to L3 while abdu
    // holds L3 (worst case 9.3 + 5.9 = 15.2 > 14.8 ceiling).
    const najatL3 = s.commandsSince(0, "set_level").filter(
      (e) => e.cmd.deviceId === "najat" && (e.cmd as Extract<Command, { kind: "set_level" }>).level === 3,
    );
    expect(najatL3).toHaveLength(0);
    expect(s.plans.some((p) => p.decisions.some((d) => d.blockedBy === "physics envelope"))).toBe(true);
    // Now the afternoon heat arrives — compressors go cap-bound. The commanded
    // end-state must still fit under the breaker (this is what tripped live).
    s.setDemand("abdu", 9, 3.4);
    s.setDemand("najat", 5.3, 2.7);
    s.advance(120);
    expect(s.totalAmps()).toBeLessThanOrEqual(14.9);
  });
});

describe("frozen ESP (2026-07-23: readings stuck at ~14.8A for 17.5 min)", () => {
  it("flags the freeze, suspends raises on the stale value, and recovers when readings move", () => {
    const s = new Scenario(
      cfg,
      [
        { ...ABDU, level: 1, demandAmps: 4, needDelta: 0.3 },
        { ...NAJAT, level: 1, demandAmps: 2, needDelta: 0.3 },
      ],
      { nonAcAmps: 2, source: "gen" },
    );
    s.advance(90); // settled, satisfied rooms — nothing to raise
    s.freezeEsp(true);
    s.advance(70); // > METER_FROZEN_AFTER_MS of identical payloads
    expect(s.events.some((e) => e.event.kind === "meter_frozen")).toBe(true);
    // Rooms heat up — but the meter is a lie; no raise may spend on it.
    s.setDemand("abdu", 6, 3);
    s.setDemand("najat", 3.5, 2);
    const t0 = s.now;
    s.advance(180);
    expect(setLevels(s, t0).filter((c) => c.cmd.level > 1)).toHaveLength(0);
    // Readings come back alive → unfreeze, calm rebuilds, the climb resumes.
    s.freezeEsp(false);
    s.advance(120);
    expect(s.events.some((e) => e.event.kind === "meter_unfrozen")).toBe(true);
    expect(setLevels(s, t0).filter((c) => c.cmd.level > 1).length).toBeGreaterThanOrEqual(1);
  });
});

describe("grid entry starts FULL, then drops on evidence (2026-07-23 directive)", () => {
  it("gen→grid drives every ON managed AC to its ceiling in one batch", () => {
    const s = new Scenario(
      cfg,
      [
        { ...ABDU, level: 1, demandAmps: 5, needDelta: 3 },
        { ...ABDULLAH, level: 1, demandAmps: 3, needDelta: 2 },
        { ...NAJAT, level: 1, demandAmps: 3, needDelta: 2 },
      ],
      { nonAcAmps: 3, source: "gen" },
    );
    s.advance(30);
    const flip = s.now;
    s.setSource("grid");
    s.advance(10);
    const fulls = setLevels(s, flip).filter((c) => c.cmd.level === 3);
    expect(new Set(fulls.map((c) => c.cmd.deviceId))).toEqual(new Set(["abdu", "abdullah", "najat"]));
    // All three ride in the FIRST batch (one evaluation) — full-start, not a
    // climb. (Later same-level re-asserts until the shadow confirms are fine —
    // the controller shell dedupes sends; the harness records them raw.)
    const firstAt = fulls[0].at;
    expect(new Set(fulls.filter((c) => c.at === firstAt).map((c) => c.cmd.deviceId)).size).toBe(3);
  });

  it("when full doesn't fit, the reducer trims and the entry window stops fighting it", () => {
    const s = new Scenario(
      cfg,
      [
        { ...ABDU, level: 1, demandAmps: 11, needDelta: 3, rampSeconds: 5 },
        { ...ABDULLAH, level: 1, demandAmps: 6.5, needDelta: 2, rampSeconds: 5 },
        { ...NAJAT, level: 1, demandAmps: 6.5, needDelta: 2, rampSeconds: 5 },
      ],
      { nonAcAmps: 2, source: "gen" },
    );
    s.advance(30);
    const flip = s.now;
    s.setSource("grid");
    s.setNonAc(8); // grid household load joins
    s.advance(120); // full-start → caps release → 9 + 5.3 + 5.3 + 8 ≈ 27.9 > 27 → bucket → cut
    const cuts = setLevels(s, flip).filter((c) => c.cmd.level < 3);
    expect(cuts.length).toBeGreaterThanOrEqual(1);
    // After the reducer acted, GRID_FULL must NOT re-push the cut level back up.
    const firstCutAt = cuts[0].at;
    const rePush = setLevels(s, firstCutAt + 1).filter(
      (c) => c.cmd.level === 3 && cuts.some((k) => k.cmd.deviceId === c.cmd.deviceId),
    );
    expect(rePush).toHaveLength(0);
    expect(s.totalAmps()).toBeLessThanOrEqual(27);
  });
});

describe("proactive near-limit turn-on (instant reduce, no bucket wait)", () => {
  it("an automation turn-on that projects over the limit triggers a cut within one evaluation", () => {
    const s = new Scenario(
      cfg,
      [
        { ...ABDU, demandAmps: 6.0, needDelta: 2, level: 2 },
        { ...ABDULLAH, demandAmps: 3.9, needDelta: 1, level: 2 },
        { ...NAJAT, on: false, demandAmps: 4.5, needDelta: 2 },
      ],
      { nonAcAmps: 2.6, source: "gen" },
    );
    s.advance(60); // settled ≈ 12.7A
    const t0 = s.now;
    s.turnOn("najat", 1); // projection: 12.7 + 2.7 (model on@L1) > 14.9
    s.advance(10);
    const cuts = setLevels(s, t0);
    expect(cuts.length).toBeGreaterThanOrEqual(1);
    expect(cuts[0].cmd.level).toBeLessThan(2.5);
  });
});
