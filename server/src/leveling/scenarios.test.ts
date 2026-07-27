// Incident regressions for leveling v2, encoded against the scenario harness.
// Each block names the live incident (or chronic pattern) it pins down.

import { describe, it, expect } from "vitest";
import { Scenario, type SimAcSetup } from "./scenario.js";
import { meterView } from "./sensing.js";
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
    // Restore side: drop the load, then verify the held fan waits out the calm
    // gate (no v1-style 61s bounce) before climbing back.
    s.setNonAc(4.0);
    const t1 = s.now;
    s.advance(40);
    expect(s.commandsSince(t1, "set_fan")).toHaveLength(0); // < FAN_RESTORE_CALM_MS
    s.advance(60);
    expect(s.commandsSince(t1, "set_fan").length).toBeGreaterThanOrEqual(1); // climbed after the gate
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

describe("the 2026-07-25 grid turn-on incident (L1 for 4m41s with ~5A free)", () => {
  // Live: the user turned Abdu on at 08:00:45 while already on grid. The TCL
  // restored the gen level it was last left at (L1, from the previous gen
  // episode), and the leveler could not touch it for the whole 4-min compressor
  // ramp — L1→L2 landed at 08:04:50, L2→L3 at 08:05:26. Grid had ~5A free the
  // entire time. The grid entry directive ("start all to full, then drop") now
  // applies to a TURN-ON too, priced against the pre-start house load because
  // the meter has not absorbed the new compressor yet.
  const hotAbdu: SimAcSetup = { ...ABDU, on: false, level: 1, demandAmps: 9, needDelta: 3, rampSeconds: 240 };

  it("a turn-on on grid lands at its ceiling in the FIRST batch, not 4 minutes later", () => {
    const s = new Scenario(cfg, [hotAbdu, ABDULLAH, NAJAT], { nonAcAmps: 10, source: "grid" });
    s.advance(60); // house resting ≈ 17A without Abdu
    const on = s.now;
    s.turnOn("abdu", 1);
    s.advance(30); // still deep inside the 4-min ramp
    const lifts = setLevels(s, on).filter((c) => c.cmd.deviceId === "abdu");
    expect(lifts.length).toBeGreaterThan(0);
    expect(lifts[0].cmd.level).toBe(3);
    expect(lifts[0].at - on).toBeLessThanOrEqual(10_000);
    // …and the house stays under the breaker as the compressor ramps in.
    s.advance(300);
    expect(s.totalAmps()).toBeLessThanOrEqual(27);
  });

  it("degrades to what the pre-start baseline affords instead of overshooting", () => {
    // House ≈ 20A without Abdu: L3 (model 8.5A) would land at 28.5A, L2 fits.
    const s = new Scenario(cfg, [hotAbdu, ABDULLAH, NAJAT], { nonAcAmps: 13, source: "grid" });
    s.advance(60);
    const on = s.now;
    s.turnOn("abdu", 1);
    s.advance(30);
    const lifts = setLevels(s, on).filter((c) => c.cmd.deviceId === "abdu");
    expect(lifts[0].cmd.level).toBe(2);
    s.advance(300);
    expect(s.totalAmps()).toBeLessThanOrEqual(27);
  });

  it("a turn-on on GEN keeps the floors-first policy — no full start", () => {
    const s = new Scenario(cfg, [{ ...hotAbdu, demandAmps: 6 }, NAJAT], { nonAcAmps: 2, source: "gen" });
    s.advance(60);
    const on = s.now;
    s.turnOn("abdu", 1);
    s.advance(30);
    const lifts = setLevels(s, on).filter((c) => c.cmd.deviceId === "abdu");
    expect(lifts.every((c) => c.cmd.level < 3)).toBe(true);
  });
});

describe("the 2026-07-24 restore-vs-raise incident (15A gen)", () => {
  // Live: the leveler shed Najat, she restore-bounced (backoff armed), the user
  // then turned a PEER off to free budget — and 11s later the leveler raised a
  // running AC into that headroom instead of restoring the shed room. The fix:
  // a feasible-but-gated shed restore reserves its amps and PARKS raises, a peer
  // power-off resets calm so the meter settles first, and the room returns
  // gently (fan pinned) so its surge fits.
  it("freed headroom goes to the pending shed room, not a peer's raise", () => {
    const s = new Scenario(
      cfg,
      [
        { ...ABDU, level: 1, fan: 1, demandAmps: 7, needDelta: 3 }, // hot, wants to climb
        { ...ABDULLAH, level: 1, fan: 1, demandAmps: 3.5, needDelta: 1 }, // the peer the user turns off
        { ...NAJAT, shed: true, fan: 1, demandAmps: 4.5, needDelta: 0.8, surgeFactor: 2, rampSeconds: 60 },
      ],
      { nonAcAmps: 5.7, source: "gen" }, // peers + nonAc ≈ 12.0 with Najat off
    );
    const t0 = s.now;
    // Najat restore-bounces once or twice → restore backoff arms. While that
    // feasible restore is pending, the fix parks Abdu's raise.
    s.advance(150);
    expect(s.plans.some((p) => p.decisions.some((d) => d.blockedBy === "restore reservation"))).toBe(true);
    expect(setLevels(s, t0).filter((c) => c.cmd.deviceId === "abdu" && c.cmd.level > 1)).toHaveLength(0);

    // The user frees real headroom by turning the peer off.
    s.turnOff("abdullah");
    s.advance(20 * 60); // outlast the backoff ladder

    const najatRestores = s
      .commandsSince(t0, "power_on")
      .filter((c) => c.cmd.deviceId === "najat");
    expect(najatRestores.length).toBeGreaterThanOrEqual(1);
    // Gentle: every Najat restore pinned the fan to 1.
    expect(
      najatRestores.every((c) => (c.cmd as Extract<Command, { kind: "power_on" }>).fan === 1),
    ).toBe(true);
    // Abdu never grabbed a raise before the shed room came back.
    const lastRestoreAt = najatRestores[najatRestores.length - 1].at;
    const abduRaisesBeforeRestore = setLevels(s, t0).filter(
      (c) => c.cmd.deviceId === "abdu" && c.cmd.level > 1 && c.at <= lastRestoreAt,
    );
    expect(abduRaisesBeforeRestore).toHaveLength(0);
    // Najat is back on and stable, and the meter never crossed the breaker.
    expect(s.sim("najat").on).toBe(true);
    expect(s.totalAmps()).toBeLessThanOrEqual(14.9);
  });

  it("a gentle restore holds the fan at 1, then climbs back to auto after the long calm", () => {
    const s = new Scenario(
      cfg,
      [
        { ...ABDU, level: 1, demandAmps: 4, needDelta: 0.3 },
        { ...NAJAT, shed: true, demandAmps: 3, needDelta: 0.3, rampSeconds: 30 },
      ],
      { nonAcAmps: 3, source: "gen" }, // ample room — Najat restores and stays
    );
    const t0 = s.now;
    s.advance(30); // calm builds → gentle restore
    const restore = s.commandsSince(t0, "power_on").find((c) => c.cmd.deviceId === "najat");
    expect(restore).toBeDefined();
    expect((restore!.cmd as Extract<Command, { kind: "power_on" }>).fan).toBe(1);
    // Fan stays pinned through the short term (< the calm gate)…
    s.advance(40);
    expect(s.commandsSince(restore!.at, "set_fan")).toHaveLength(0);
    // …and climbs back toward auto once the calm gate passes.
    s.advance(60);
    expect(s.commandsSince(restore!.at, "set_fan").length).toBeGreaterThanOrEqual(1);
  });
});

describe("the 2026-07-25 restore-bounce storm (first night of v2 acting)", () => {
  // Live 20:22–21:03 on the 15A gen: six restores of the shed room, each undone
  // by a shed 8–65s later — EVERY one of them fired while the smoothed meter read
  // 11.9–12.6A, i.e. 2.4–3.1A UNDER the limit. Two causes, both reproduced here:
  //   1. the restore was ADMITTED at the gentle steady cost (2.3A) and then, on
  //      the very next tick, re-priced by the freshly-on projection at the
  //      fan-slam learned cost (3.7A) — a guaranteed self-inflicted "over".
  //   2. the reducer may shed during that inrush, and because the bouncing room
  //      earns a re-shed penalty the shed migrates to a BYSTANDER (live: Abdu,
  //      the room the user then found off and switched on by hand).
  // Everyone sits at their floor with no fan slack, so a shed is the only cover
  // the reducer can find — exactly the live 20:23 state (Abdullah pinned at his
  // 39°C boost floor L2, Abdu and Najat at L1, fans already trimmed to 1).
  const bounceBook = {
    // What the meter learned from the OLD fan-slam restores — the number the
    // projection charged while admission used the gentle 2.7A model draw.
    "najat|gen|on@L1": { ewmaAmps: 4.2, samples: 3, updatedAt: 1_000_000_000 },
  };
  const storm = (): Scenario =>
    new Scenario(
      cfg,
      [
        { ...ABDU, level: 1, fan: 1, demandAmps: 7, needDelta: 3 },
        { ...ABDULLAH, level: 2, minLevel: 2, fan: 1, demandAmps: 3.5, needDelta: 1 },
        { ...NAJAT, shed: true, fan: 1, demandAmps: 4.5, needDelta: 0.8, surgeFactor: 1.6, rampSeconds: 60 },
      ],
      { nonAcAmps: 4.3, source: "gen", book: bounceBook }, // ≈11.9A with Najat off
    );

  it("a gentle restore is not undone by its own inrush", () => {
    const s = storm();
    const t0 = s.now;
    s.advance(120);

    const restore = s.commandsSince(t0, "power_on").find((c) => c.cmd.deviceId === "najat");
    expect(restore).toBeDefined();
    // Najat's steady L1 draw fits (11.9 + 2.2 = 14.1 < 14.9); only the ~1-min
    // startup transient crosses. Nothing may be shed while it decays.
    const shedsAfterRestore = s
      .commandsSince(restore!.at, "power_off")
      .filter((e) => e.at - restore!.at <= 90_000);
    expect(shedsAfterRestore).toHaveLength(0);
    expect(s.sim("najat").on).toBe(true);
  });

  it("the inrush never sheds a bystander room", () => {
    const s = storm();
    const t0 = s.now;
    s.advance(15 * 60);
    // Abdu is the hottest room (needDelta 3) and did nothing — he must never be
    // the one paying for another room's restore.
    expect(s.commandsSince(t0, "power_off").filter((e) => e.cmd.deviceId === "abdu")).toHaveLength(0);
    expect(s.sim("abdu").on).toBe(true);
  });

  it("settles with every room on and under the breaker", () => {
    const s = storm();
    s.advance(15 * 60);
    expect(s.acsOn()).toEqual(["abdu", "abdullah", "najat"]);
    expect(s.totalAmps()).toBeLessThanOrEqual(14.9);
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

// ── 2026-07-26: three gen trips in 25 minutes ────────────────────────────────
// #1 10:29:41 at 15.65A — the leveler shed Abdu at 10:25:14, restored him at
//    10:25:45, then raised NAJAT L1→L2 (10:26:22) and L2→L3 (10:26:57) while
//    the journal was recording `Abdu: raise blockedBy "ramping"` in the very
//    same batches. The meter had seen almost none of Abdu's 4.3A.
// #2 ~10:40:45 at 14.48A — recovery only cleared the collapse latch, so the
//    power-cycled ACs climbed the house straight back to the tripping load.
// #3 ~10:53:30 at 13.99A — an ordinary single raise, admitted correctly
//    against a 15A limit the hot breaker was no longer holding.
describe("the 2026-07-26 triple gen trip", () => {
  // Live shape: a big non-AC baseline (measured ~7–8A that morning) leaves only
  // ~6A for the ACs on the 15A gen. Sized so that everyone at their floor fits
  // (7.3 + 4.1 + 2.2 = 13.6) but ONE peer raise does not (+1.7 = 15.3 > 14.9) —
  // i.e. the trap only springs if the controller spends amps the meter has not
  // seen yet. Both compressors carry the real 4-minute ramp.
  const trips = (): Scenario =>
    new Scenario(
      cfg,
      [
        { ...ABDU, shed: true, demandAmps: 9.0, needDelta: 3, fan: 1, rampSeconds: 240 },
        { ...NAJAT, level: 1, demandAmps: 5.3, needDelta: 2.5, fan: 1, rampSeconds: 240 },
      ],
      { nonAcAmps: 7.3, source: "gen" },
    );

  it("does not raise a peer on the headroom a restored room is still ramping into", () => {
    const s = trips();
    const t0 = s.now;
    s.advance(6 * 60); // restore, then the whole 4-min ramp window after it

    const restore = s.commandsSince(t0, "power_on").find((c) => c.cmd.deviceId === "abdu");
    expect(restore).toBeDefined();
    // Najat may not be lifted while Abdu's compressor is still arriving.
    const najatRaises = s
      .commandsSince(restore!.at, "set_level")
      .filter((e) => e.cmd.deviceId === "najat" && e.at - restore!.at < 240_000);
    expect(najatRaises).toEqual([]);
  });

  it("never lets the house cross the breaker while a restore ramps in", () => {
    const s = trips();
    s.advance(20 * 60);
    expect(s.totalAmps()).toBeLessThanOrEqual(cfg.genLimitAmps);
    // …and it did not buy that by leaving a room off.
    expect(s.acsOn()).toEqual(["abdu", "najat"]);
  });

  it("floors every AC again when the gen recovers from a trip", () => {
    const s = trips();
    s.advance(5 * 60); // settle, Abdu restored and climbing
    s.sim("najat").level = 3;
    s.sim("najat").shadowLevel = 3;
    s.trip();
    s.advance(30);
    s.recoverLine();
    const t0 = s.now;
    s.advance(120);

    // Recovery must re-level, not resume: everyone driven back to their floor.
    const floored = s.commandsSince(t0, "set_level");
    expect(floored.length).toBeGreaterThan(0);
    expect(floored.every((e) => e.cmd.kind === "set_level" && e.cmd.level === 1)).toBe(true);
  });

  // Trip #3's shape: after the dust settles there IS room under the nameplate
  // limit for one more step (floors 12.5A vs a 14.6A resting ceiling → 2.1A
  // free, and Najat's step costs 1.6A), so the pre-fix controller raises — and
  // the hot breaker, which had just failed at 13.99A, goes again. Derated by
  // one trip the same ceiling is 13.6A → 1.1A free → the step is refused.
  const postTrip = (): Scenario =>
    new Scenario(
      cfg,
      [
        { ...ABDU, level: 1, demandAmps: 9.0, needDelta: 3, fan: 1, rampSeconds: 240 },
        { ...NAJAT, level: 1, demandAmps: 5.3, needDelta: 2.5, fan: 1, rampSeconds: 240 },
      ],
      { nonAcAmps: 6.2, source: "gen" },
    );

  it("stops spending into a gen that just tripped (trip #3's raise)", () => {
    const s = postTrip();
    s.advance(5 * 60);
    s.trip();
    s.advance(30);
    s.recoverLine();
    const t0 = s.now;
    s.advance(15 * 60);
    // Live 10:49:58: Abdu L1→L2 at 12.0A, every gate satisfied, gen gone at
    // 13.99A. Nothing may be lifted above its floor while the derate stands.
    const lifts = s
      .commandsSince(t0, "set_level")
      .filter((e) => e.cmd.kind === "set_level" && e.cmd.level > 1);
    expect(lifts).toEqual([]);
    expect(s.totalAmps()).toBeLessThanOrEqual(cfg.genLimitAmps - 1);
  });

  it("a second trip inside the window derates further", () => {
    // The live cascade: each trip left the breaker holding less than the last
    // (15.65 → 14.48 → 13.99). Two trips inside the window must compound, not
    // restart the ceiling at the nameplate rating.
    const s = postTrip();
    s.advance(5 * 60);
    for (let i = 0; i < 2; i++) {
      s.trip();
      s.advance(30);
      s.recoverLine();
      s.advance(3 * 60);
    }
    expect(meterView(s.meterState, s.now).derateAmps).toBe(2);
  });

  it("releases the derate once the window passes without another trip", () => {
    const s = postTrip();
    s.advance(5 * 60);
    s.trip();
    s.advance(30);
    s.recoverLine();
    s.advance(21 * 60); // past COLLAPSE_DERATE_MS
    expect(meterView(s.meterState, s.now).derateAmps).toBe(0);
  });
});

describe("the 2026-07-27 fan-restore stall", () => {
  // Live 16:49:41 → 16:53:06: the reducer trimmed Abdu 7→3 and Abdullah →1 while
  // Najat was 2 min into her turn-on ramp. Those same cuts dropped the house
  // 1.5A BELOW the baseline snapshotted when Najat started, so `smoothed −
  // rampBaseline` clamped to 0 and she was re-charged her WHOLE modeled draw for
  // the rest of her 240s window (journal 16:50:31: "0.1A available (+1.7A
  // ramping in)"). The fans could not come back until the ramp simply expired —
  // 3m14s / 3m25s after the cut, on a meter that had been calm and 1.5A under
  // the ceiling the whole time.
  //
  // Sized so the ONLY thing standing between the hold and its restore is that
  // stale absorption: while the ramp rises the budget is invariant (each amp the
  // meter absorbs is an amp the debit gives back), and after the peer drop the
  // ratcheted absorption is worth exactly the 0.5A the fan swing costs.
  const stall = (): Scenario => {
    const s = new Scenario(
      cfg,
      [
        { ...ABDU, level: 1, demandAmps: 6.0, needDelta: 0, fan: 1, rampSeconds: 240 },
        { ...ABDULLAH, level: 1, demandAmps: 3.5, needDelta: 0, fan: 1, rampSeconds: 240 },
        { ...NAJAT, on: false, level: 1, demandAmps: 3.0, needDelta: 0, fan: 1, rampSeconds: 240 },
      ],
      { nonAcAmps: 5.7, source: "gen" },
    );
    s.advance(60); // settle: house ≈ 12.0A, calm, nothing to raise
    return s;
  };

  /** Abdu comes out of an over-limit trim holding fan 1, owing a climb back to 7. */
  const holdAbduFan = (s: Scenario): void => {
    s.sim("abdu").fan = 1;
    s.fanHolds = {
      abdu: { deviceId: "abdu", originalFan: 7, lastSetFan: 1, heldAt: s.now },
    };
  };

  it("restores a held fan once a peer drop makes room, without waiting out the ramp", () => {
    const s = stall();
    holdAbduFan(s);
    s.turnOn("najat");
    const rampEndsAt = s.now + 240_000;
    s.advance(120); // Najat half-ramped: ~1.1A of her draw is on the meter

    // The cuts that caused the hold also take load off the house, landing it
    // BELOW the baseline Najat started against (the live shape).
    s.setNonAc(4.4);
    const dropAt = s.now;
    s.advance(90);

    const restore = s
      .commandsSince(dropAt, "set_fan")
      .find((e) => e.cmd.deviceId === "abdu" && e.cmd.kind === "set_fan" && e.cmd.fan === 7);
    expect(restore).toBeDefined();
    expect(restore!.at).toBeLessThan(rampEndsAt);
  });

  it("still refuses the fan while the ramping room's draw genuinely has not landed", () => {
    // Same house, no peer drop: every amp Najat has committed is still arriving,
    // so the fan stays held — the debit is doing its job (2026-07-26 trip #1).
    const s = stall();
    holdAbduFan(s);
    s.turnOn("najat");
    const t0 = s.now;
    s.advance(180);
    expect(s.commandsSince(t0, "set_fan")).toEqual([]);
  });
});
