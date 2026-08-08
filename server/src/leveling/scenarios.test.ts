// Incident regressions for leveling v2, encoded against the scenario harness.
// Each block names the live incident (or chronic pattern) it pins down.

import { describe, it, expect } from "vitest";
import { Scenario, type SimAcSetup } from "./scenario.js";
import { meterView } from "./sensing.js";
import { DEFAULT_LEVELING_CONFIG_V2, type LevelingConfigV2 } from "./config.js";
import { FAN_BOUNCE_WINDOW_MS, FAN_RESTORE_AFTER_CUT_MS } from "./fan-trim.js";
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

describe("the two generator breaks of 2026-08-02 evening", () => {
  // Both breaks in one evening, both on the 15A house generator, both with the
  // flicker rework live. The controller reported healthy throughout.
  const TRIO = [
    { ...ABDULLAH, level: 2, demandAmps: 3.9, needDelta: 3 },
    { ...ABDU, level: 1, demandAmps: 4.1, needDelta: 2 },
    { ...NAJAT, level: 1, demandAmps: 2.2, needDelta: 1 },
  ];

  // BREAK #1's two mechanisms are pinned where they can be isolated, because a
  // scenario replay of that evening cannot separate them from the gen start
  // clamp that also fired: the blanking threshold in `pipeline.test.ts`
  // ("blanking ends the moment the MEAN crosses the limit"), and the
  // time-based severity tiers in `pressure.test.ts` ("a mean over the limit for
  // 45s is SEVERE" / "two minutes over is EXTREME"). What belongs here is the
  // end-to-end consequence: a ride the ladder cannot fix must END.
  it("a ride level cuts CANNOT fix ends with one room off, not with the breaker", () => {
    // 17:38-17:40Z, and again at 17:44. The mean sat 0.6-1.0A over a 15A gen for
    // two minutes with every room already at its floor. That is "mild" forever
    // under magnitude alone — and mild's whole repertoire is level cuts (there
    // were no levels left to cut) and fan trims (0.5A against a 0.7A deficit).
    // The controller kept issuing batches it had already issued while the
    // compressors wound down over minutes the breaker did not have.
    const floored = [
      { ...ABDULLAH, level: 1, demandAmps: 2.2, needDelta: 3 },
      { ...ABDU, level: 1, demandAmps: 4.1, needDelta: 2 },
      { ...NAJAT, level: 1, demandAmps: 2.2, needDelta: 1 },
    ];
    // 4.1 + 2.2 + 2.2 = 8.5A of AC at the floor, plus 7.0A of house ≈ 15.5A on a
    // 14.9A line. Nothing the level ladder can reach closes a 0.6A gap.
    const s = new Scenario(cfg, floored, { nonAcAmps: 7.0, source: "gen", seed: 20260802 });
    const t0 = s.now;
    s.advance(200);
    const off = s.commandsSince(t0, "power_off");
    // Exactly ONE room — invariant 26's ceiling is not relaxed by the new tier.
    expect(off, JSON.stringify(off.map((e) => e.cmd))).toHaveLength(1);
    // …and it happened inside the breaker's thermal budget, not after it.
    expect((off[0].at - t0) / 1000).toBeLessThan(180);
  });

  it("…but the same overshoot with levels still to cut spends those first", () => {
    // The guard on the rung above: the last resort must stay last. Same house,
    // same deficit, but the rooms have levels left — so nobody is switched off.
    const withLevels = [
      { ...ABDULLAH, level: 3, demandAmps: 5.3, needDelta: 3 },
      { ...ABDU, level: 2, demandAmps: 6.5, needDelta: 2 },
      { ...NAJAT, level: 1, demandAmps: 2.2, needDelta: 1 },
    ];
    const s = new Scenario(cfg, withLevels, { nonAcAmps: 2.0, source: "gen", seed: 20260802 });
    const t0 = s.now;
    s.advance(200);
    expect(s.commandsSince(t0, "power_off")).toHaveLength(0);
    expect(s.acsOn()).toEqual(["abdu", "abdullah", "najat"]);
  });

  it("BREAK #2: the trough after a break is not headroom — nothing may be raised into it", () => {
    // 17:40-17:45Z. The AC circuit died and the meter settled on ~6A of house
    // load — over the 5A absolute floor, so nothing latched. The trough then
    // read as perfect calm and the controller raised Abdu to L2, to L3, and
    // Najat to L2 in three minutes, all at a "pre" of ~6.4A. Every compressor
    // restarted together and the line went down again.
    // `residualAmps` is the whole point: the harness defaults to 4A, which is
    // UNDER the old absolute floor, so every trip it modelled latched and the
    // live failure was unreachable here. The AC circuit dying while the house
    // keeps drawing 6A is what actually happened, twice.
    const s = new Scenario(cfg, TRIO, {
      nonAcAmps: 6.0,
      residualAmps: 6.0,
      source: "gen",
      seed: 20260802,
    });
    // A live CT always micro-moves. Without this the flat post-trip meter reads
    // as a HUNG SENSOR, which kills calm for its own reasons and would let this
    // test pass no matter what the collapse detector did.
    s.setNoise(0.05);
    s.advance(240);
    const t0 = s.now;
    s.trip(); // AC circuits die; the 6A house residual stays on the line
    s.advance(300);
    // The latch fires on a residual the old absolute floor sailed over…
    expect(meterView(s.meterState, s.now).collapsed || meterView(s.meterState, s.now).calmMs === 0).toBe(true);
    // …and NOTHING is spent into the trough: no raises, no restores.
    const raises = setLevels(s, t0).filter((e) => e.cmd.level >= 2);
    expect(raises, JSON.stringify(raises)).toHaveLength(0);
    expect(s.commandsSince(t0, "power_on")).toHaveLength(0);
  });

  it("a turn-off by hand is still not a trip — no phantom collapse on an ordinary evening", () => {
    // The cost of the relative floor, and the guard that pays it: the biggest
    // room IS most of the load, so switching it off looks exactly like the AC
    // circuit dying. The commanded-cut credit is the only thing between the two.
    const s = new Scenario(cfg, TRIO, { nonAcAmps: 4.0, source: "gen", seed: 20260802 });
    s.advance(240);
    s.turnOff("abdu"); // the 2-ton room, ~4.1A of a ~14A house
    s.advance(180);
    expect(meterView(s.meterState, s.now).collapsed).toBe(false);
    expect(meterView(s.meterState, s.now).derateAmps).toBe(0);
  });
});

describe("changeover and churn (2026-08-03 overnight)", () => {
  const TRIO = [
    { ...ABDULLAH, level: 2, demandAmps: 3.9, needDelta: 3 },
    { ...ABDU, level: 1, demandAmps: 4.1, needDelta: 2 },
    { ...NAJAT, level: 1, demandAmps: 2.2, needDelta: 1 },
  ];

  it("a level sent on grid is still clamped after the changeover to gen", () => {
    // 00:11-00:41Z. Abdu was raised to L3 on grid; the grid ended two minutes
    // later. The changeover wiped the unconfirmed-send record, so the gen-entry
    // clamp compared a stale L1 shadow and skipped him entirely — he sat at L3
    // on a 15A generator for 27 minutes, invisible to the physics envelope,
    // while a peer was raised on top of him. When the shadow finally caught up
    // the meter hit 15.4A and it took five cut batches to unwind.
    // Abdu's shadow confirms 20 minutes late — the live lag runs 5.8s to 13min.
    const s = new Scenario(
      cfg,
      [
        { ...ABDULLAH, level: 2, demandAmps: 3.9, needDelta: 3 },
        { ...ABDU, level: 1, demandAmps: 9.0, needDelta: 3, confirmDelayMs: 20 * 60_000 },
        { ...NAJAT, level: 1, demandAmps: 2.2, needDelta: 1 },
      ],
      { nonAcAmps: 2.5, source: "grid", seed: 20260803 },
    );
    const t0 = s.now;
    s.advance(180);
    const raised = setLevels(s, t0).filter((e) => e.cmd.deviceId === "abdu" && e.cmd.level >= 2);
    expect(raised.length, "harness did not raise abdu on grid").toBeGreaterThan(0);
    const t1 = s.now;
    s.setSource("gen");
    s.advance(90);
    // The clamp must reach him even though his SHADOW still says L1.
    const clamped = setLevels(s, t1).filter((e) => e.cmd.deviceId === "abdu" && e.cmd.level <= 1);
    expect(clamped.length, "the in-flight L3 was never clamped on gen entry").toBeGreaterThan(0);
  });

  it("a room the reducer just cut does not climb straight back into the overload", () => {
    // 00:41:10Z cut Abdullah L2→L1; 00:42:44Z raised him L1→L2, 94 seconds
    // later, before the first cut had even reached the meter.
    const s = new Scenario(
      cfg,
      [
        { ...ABDULLAH, level: 2, demandAmps: 3.9, needDelta: 3 },
        { ...ABDU, level: 2, demandAmps: 6.5, needDelta: 3 },
        { ...NAJAT, level: 1, demandAmps: 2.2, needDelta: 1 },
      ],
      { nonAcAmps: 2.0, source: "gen", seed: 20260803 },
    );
    s.advance(180);
    const t0 = s.now;
    // Push the house over the limit so the reducer takes a level, then give it
    // back so the meter looks roomy again — the shape that invites the bounce.
    s.setNonAc(4.5);
    s.advance(120);
    const cuts = setLevels(s, t0);
    expect(cuts.length, "the reducer never cut a level").toBeGreaterThan(0);
    const { at: cutAt, cmd: cut } = cuts[0];
    s.setNonAc(2.0); // the meter looks roomy again long before the cut lands
    s.advance(90);
    const backUp = setLevels(s, cutAt).filter(
      (e) => e.cmd.deviceId === cut.deviceId && e.cmd.level > cut.level,
    );
    for (const e of backUp) {
      expect(
        (e.at - cutAt) / 1000,
        `${cut.deviceId} climbed back to L${e.cmd.level} after ${(e.at - cutAt) / 1000}s`,
      ).toBeGreaterThanOrEqual(120);
    }
  });
});

describe("gen flicker shed storm (2026-08-02)", () => {
  // The live household on a flickering 14.9A generator: Abdullah held at his L2
  // heat-boost floor, Abdu and Najat at L1, ~2.5A of house. The user's own
  // report is that this trio runs fine in the real world most of the time — so
  // any paper total that says otherwise is an artifact to fix, not a reason to
  // park a room. What the controller did instead was shed a room five times in
  // fifteen minutes at smoothed overshoots of 0.02–0.31A.
  const TRIO = [
    { ...ABDULLAH, minLevel: 2, level: 2, demandAmps: 3.9, needDelta: 3 },
    { ...ABDU, level: 1, demandAmps: 4.1, needDelta: 2 },
    { ...NAJAT, level: 1, demandAmps: 2.2, needDelta: 1 },
  ];
  // 3.9 + 4.1 + 2.2 = 10.2A of AC plus 4.0A of house ≈ a 14.2A mean on a 14.9A
  // line: the deliberate near-limit ride the controller exists to hold. Spikes
  // of ~0.9A cross the limit constantly while the mean never does — which is
  // precisely the live condition that used to shed a room.
  const trio = (): Scenario =>
    new Scenario(cfg, TRIO, { nonAcAmps: 4.0, source: "gen", seed: 20260802 });

  it("ACCEPTANCE: the trio holds through 30 minutes of flicker — no room is ever shed", () => {
    const s = trio();
    s.advance(120); // settle
    // One reading in four a full amp high: enough that every window carries a
    // spike, few enough that the 4-wide median still reports the honest mean.
    // (At a 1-in-3 duty two spikes share a window and genuinely lift the
    // smoothed meter — a real excursion, not the noise this models.)
    s.setFlicker({ baseAmps: 0.15, spikeAmps: 0.9, spikeEveryN: 4 });
    const t0 = s.now;
    s.advance(30 * 60);
    expect(s.commandsSince(t0, "power_off")).toHaveLength(0);
    expect(s.acsOn()).toEqual(["abdu", "abdullah", "najat"]);
    // And it SETTLES rather than trimming its way around the noise.
    const churn = s.commandsSince(t0).map((e) => `${(e.at - t0) / 1000}s ${JSON.stringify(e.cmd)}`);
    expect(churn.length, churn.join("\n")).toBeLessThanOrEqual(6);
  });

  it("does not act at all while the MEAN sits under the limit", () => {
    // The 17:59 shape: smoothed 14.215 against a 14.5 effective limit. Every
    // spike used to drain the bucket AND break the calm that refills it, so the
    // bucket could only ratchet down until something was shed.
    const s = trio();
    s.advance(120);
    s.setNonAc(4.4); // mean ≈ 14.6 — riding the limit, still under it
    s.advance(120);
    s.setFlicker({ baseAmps: 0.2, spikeAmps: 1.0, spikeEveryN: 4 });
    const t0 = s.now;
    s.advance(10 * 60);
    expect(s.commandsSince(t0, "power_off")).toHaveLength(0);
  });

  it("a genuine overload is still answered — flicker tolerance is not blindness", () => {
    const s = trio();
    s.advance(120);
    // One reading in four a full amp high: enough that every window carries a
    // spike, few enough that the 4-wide median still reports the honest mean.
    // (At a 1-in-3 duty two spikes share a window and genuinely lift the
    // smoothed meter — a real excursion, not the noise this models.)
    s.setFlicker({ baseAmps: 0.15, spikeAmps: 0.9, spikeEveryN: 4 });
    const t0 = s.now;
    s.setNonAc(7.5); // mean ≈ 17.7 on a 14.9A line — real, and well over
    s.advance(4 * 60);
    expect(s.commandsSince(t0).length).toBeGreaterThan(0);
    expect(s.totalAmps()).toBeLessThanOrEqual(cfg.genLimitAmps);
  });

  it("a room discovered already running does not book its compressor as house", () => {
    // Najat off, then switched on by hand with a 60s shadow lag. For that
    // minute the meter carries her draw while the model says she is off, and
    // every house sample taken then counted it as house — 6.0A observed against
    // a real ~2.7A, which then refused every raise for fifteen minutes.
    const s = new Scenario(cfg, [{ ...TRIO[0] }, { ...TRIO[1] }, { ...TRIO[2], on: false }], {
      nonAcAmps: 4.0,
      source: "gen",
      seed: 20260802,
    });
    s.advance(5 * 60); // plenty of honest samples for the two-room set
    s.externalTurnOn("najat", 60_000);
    s.advance(5 * 60); // through the lag, the confirm, and the ramp
    // The phantom would have been ~2.2A of Najat booked as house on top of the
    // real 2.5A; the void plus the pending-ON sampling guard keep it honest.
    const status = s.plans[s.plans.length - 1];
    expect(status).toBeDefined();
    expect(s.acsOn()).toContain("najat");
  });
});

describe("a level that does not cool is an off (2026-08-03)", () => {
  // 11:25:32 Baghdad: an extreme deficit shed Najat AND cut Abdullah from his
  // active L2 heat-boost floor to L1. Above the boost threshold his compressor
  // mostly will not engage at L1 (user, hardware truth), so that cut took the
  // top-priority room out of service — silently, since a level carries no shed
  // record. Najat's restore then took the amps that appeared three minutes
  // later, and Abdullah sat at 28°C against a setpoint of 20 for twenty minutes
  // until the user switched a room off by hand.
  const STRANDED = { ...ABDULLAH, minLevel: 2, level: 1, demandAmps: 3.9, needDelta: 3 };

  it("buys a stranded comfort floor back BEFORE restoring a less-needy shed room", () => {
    const s = new Scenario(
      cfg,
      [STRANDED, { ...ABDU, level: 1, demandAmps: 4.1, needDelta: 1.8 }, { ...NAJAT, shed: true, on: false, needDelta: 1.6 }],
      { nonAcAmps: 3.0, source: "gen", seed: 20260803 },
    );
    const t0 = s.now;
    s.advance(6 * 60);
    const cmds = s.commandsSince(t0);
    const floorBack = cmds.findIndex((e) => e.cmd.deviceId === "abdullah" && e.cmd.kind === "set_level");
    const restore = cmds.findIndex((e) => e.cmd.deviceId === "najat" && e.cmd.kind === "power_on");
    const trace = cmds.map((e) => `${(e.at - t0) / 1000}s ${JSON.stringify(e.cmd)}`).join("\n");
    expect(floorBack, trace).toBeGreaterThanOrEqual(0);
    expect(restore, trace).toBeGreaterThanOrEqual(0);
    // Both rooms get served — the fix is the ORDER, not a new strand.
    expect(floorBack, trace).toBeLessThan(restore);
  });

  it("does not yield to a stranded room that is LESS needy than the shed one", () => {
    // The shed room is fully off; a room merely below its floor outranks it
    // only while it is genuinely the hotter of the two. Both needs keep rising
    // while they wait, so the ordering self-corrects instead of latching.
    const s = new Scenario(
      cfg,
      [
        { ...STRANDED, needDelta: 1.0 },
        { ...ABDU, level: 1, demandAmps: 4.1, needDelta: 1.8 },
        { ...NAJAT, shed: true, on: false, needDelta: 3 },
      ],
      { nonAcAmps: 3.0, source: "gen", seed: 20260803 },
    );
    const t0 = s.now;
    s.advance(6 * 60);
    const cmds = s.commandsSince(t0);
    const floorBack = cmds.findIndex((e) => e.cmd.deviceId === "abdullah" && e.cmd.kind === "set_level");
    const restore = cmds.findIndex((e) => e.cmd.deviceId === "najat" && e.cmd.kind === "power_on");
    const trace = cmds.map((e) => `${(e.at - t0) / 1000}s ${JSON.stringify(e.cmd)}`).join("\n");
    expect(restore, trace).toBeGreaterThanOrEqual(0);
    expect(restore < floorBack || floorBack < 0, trace).toBe(true);
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
    // No raise before confirm (10s) + the ramp WINDOW + calm (30s). The window
    // is `AC_RAMP_MS` (240s), not the sim's 30s compressor curve — the harness
    // conflated the two until 2026-08-05 (see scenario.ts AC_RAMP_MS). Nothing
    // absorbs here either: a changeover FLOORS every room, so the meter falls
    // instead of rising and each ramp stays charged its whole modeled draw for
    // the full window, exactly as it does in production.
    s.advance(30);
    expect(setLevels(s, flip + 10_000).filter((c) => c.cmd.level > 1)).toHaveLength(0);
    // The climb resumes — one raise command per batch on gen, spaced by settle.
    s.advance(330);
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

  // 2026-07-28 07:18–07:23 Baghdad. Abdullah was manually off, so an over-limit
  // episode shed the only two ACs left. Their compressors stopped ~1 min after
  // the sends and gen fell 11.5A → 4.5A in one step — drop ≥6A landing under
  // the 5A floor, i.e. exactly a trip. COLLAPSED latched: every raise and
  // restore journaled "power collapse latched" for 5 minutes with ~9A of
  // headroom free, and the gen limit derated to 14A on top. The generator was
  // never in trouble; we had turned the load off ourselves.
  // Outdoor-heat boost floors pin both rooms at L3, and their offs travel for a
  // minute before the compressors actually stop.
  const PINNED_HOT = [
    { ...ABDU, minLevel: 3, level: 3, demandAmps: 9.0, needDelta: 1.5, offLagMs: 60_000 },
    { ...NAJAT, minLevel: 3, level: 3, demandAmps: 5.3, needDelta: 0.5, offLagMs: 60_000 },
  ];

  it("nothing the reducer commands is ever read as a trip", () => {
    // Base load alone sits under the 5A collapse floor, so whatever the reducer
    // takes off travels for a minute and then lands as one cliff.
    //
    // This used to assert a two-shed pair. Since 2026-08-02 a boost floor is a
    // preference the ladder drops BELOW before switching a room off, so these
    // rooms give levels instead and the pair no longer happens — which is the
    // point of that change. What must still hold, and is what this scenario
    // guards, is that our own commanded fall never latches a collapse. The
    // exact cliff physics is unit-covered in sensing.test.ts.
    const s = new Scenario(cfg, PINNED_HOT, { nonAcAmps: 4.3, source: "gen" });
    const t0 = s.now;
    s.advance(6 * 60);
    expect(s.commandsSince(t0).length).toBeGreaterThan(0);
    expect(s.events.some((e) => e.event.kind === "collapse")).toBe(false);
    expect(s.meterState.derate).toBeNull();
    // Not frozen: the controller is free to give the rooms back.
    expect(s.plans[s.plans.length - 1].reason).not.toBe("collapsed");
  });

  it("a real trip while a shed is in flight still latches — the credit is not a blank cheque", () => {
    const s = new Scenario(cfg, PINNED_HOT, { nonAcAmps: 4.3, source: "gen" });
    // One shed sent (≈5.9A priced, at 10s) and nowhere near landed — its
    // `offLagMs` is a full minute. The 45s is the SMOOTHING WINDOW seating, not
    // the shed: the collapse baseline is the prior median and there is no prior
    // median until the window is full, which at SMOOTH_WINDOW 8 takes eight
    // readings (2026-08-05; it was four). A session younger than that has no
    // fall to judge — which is exactly the hole `entryCollapseEvidence` covers.
    s.advance(45);
    // The breaker goes while that off is still travelling: far more load
    // vanishes than anything we commanded, so the remainder is unexplained.
    s.trip();
    s.advance(60);
    expect(s.events.some((e) => e.event.kind === "collapse")).toBe(true);
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
    // Peers pinned at floors with no fan slack; Najat's restore SETTLES over the
    // limit in the SMOOTHED mean, so re-shedding her is the only cover: the v1
    // bounce loop. Her L1 draw is capped at 3.3A while the model prices her at
    // 2.7A, so admission fits (committed ~12.0 + 2.7 = 14.7 < 14.9) but the
    // settled 12.0 + 3.3 = 15.3 crosses the mean → genuine re-shed every cycle.
    //
    // The fixture originally staged this as a startup SURGE (2× cap, 60s ramp).
    // F3 (2026-08-08) deliberately rides a startup surge through when the smoothed
    // mean stays under the limit (the mean is the truth about load; settle, don't
    // bounce) — so a surge-only breach now correctly produces `restores: 1,
    // sheds: 0` and no bounce at all. To still exercise the bounce ladder the
    // breach is staged in the MEAN, where F3 is inactive and the re-shed is real.
    const s = new Scenario(
      cfg,
      [
        { ...ABDU, level: 1, fan: 1, demandAmps: 6, needDelta: 2 },
        { ...ABDULLAH, level: 1, fan: 1, demandAmps: 3.5, needDelta: 1 },
        { ...NAJAT, shed: true, fan: 1, capAmps: [3.3, 3.9, 5.3], demandAmps: 4.5, needDelta: 0.8 },
      ],
      { nonAcAmps: 5.7, source: "gen" }, // total with Najat off ≈ 12.0
    );
    const t0 = s.now;
    // An hour. Since R9 a room's own shed leaves a meter BAR for one blame window,
    // and invariant 67 COMPOUNDS that bar's persistence per bounce (600s → 1200s →
    // 1800s cap), so the retry gaps grow toward the compounded cap rather than the
    // old flat 15-min blame window.
    s.advance(60 * 60);
    const restores = s.commandsSince(t0, "power_on");
    const sheds = s.commandsSince(t0, "power_off");
    // Retries keep happening (no strand)…
    expect(restores.length).toBeGreaterThanOrEqual(2);
    // …every failure is followed by a bounded wait (the bar's compounded cap
    // 1800s + slack; the fixture predates the bounce-compounded bar, which raised
    // the ceiling from the old 15-min blame window):
    for (let i = 1; i < restores.length; i++) {
      expect(restores[i].at - restores[i - 1].at).toBeLessThanOrEqual(31 * 60_000);
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
    // The freed headroom also lets a level raise land (~t+35s), and a raise now
    // arms the post-raise jump debit — committed amps the meter has not shown.
    // That fences EVERY other spender, the fan restore included: two fan
    // restores riding phantom budget behind fresh raises is exactly the
    // 2026-07-26 gen trip. So the fan climbs back only once that window clears.
    s.advance(300);
    expect(s.commandsSince(t1, "set_fan").length).toBeGreaterThanOrEqual(1);
    // …and it still never bounced inside the anti-bounce window, measured from
    // the CUT — which is what that window is anchored to. `t1` is the load drop,
    // and the old "> 60s after t1" reading of it was a proxy that the generous
    // -budget fast path (2026-08-06) breaks without breaking the guard: this
    // house frees ~1.8A, so the restore owes FAN_RESTORE_AFTER_CUT_FAST_MS from
    // the cut rather than the full 120s, and lands 55s after the drop.
    const cutAt = s.commandsSince(t0, "set_fan")[0].at;
    expect(s.commandsSince(t1, "set_fan")[0].at - cutAt).toBeGreaterThanOrEqual(60_000);
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

  it("a gentle restore holds the fan at 1 through its own ramp, then climbs back to auto", () => {
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
    // Fan stays pinned while the compressor is still ramping — NOT released by
    // the calm gate alone (2026-08-06 14:03:20Z: that release pushed a restored
    // room back over the limit and cost a second room its compressor). The
    // fan-restore self-skip (invariant 59) keys on `ramping`, so the pin holds
    // for as long as the room is inside its ramp.
    s.advance(40);
    expect(s.commandsSince(restore!.at, "set_fan")).toHaveLength(0);
    // …and climbs back toward auto once the ramp is PROVEN settled. Amp evidence
    // now retires the ramp window before its 240s clock (2026-08-08): this fast
    // 1-ton lands and plateaus in ~30s + the 45s stall, so the pin releases
    // ~95s after the restore rather than at four minutes — but only AFTER the
    // compressor has demonstrably landed, which is what preserves the 08-06
    // protection (the release is not mid-ramp, it is post-plateau).
    s.advance(90);
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

describe("the 2026-07-27 evening bounce loop (hot-room draw exceeds the steady model)", () => {
  // Live 16:43–17:15 on the 15A gen: Najat's restores were admitted at her
  // steady model 2.3A while her REAL hot-evening L1 draw was 3.5–3.8A (the
  // fan was pinned to 1 the whole time — the excess is compressor, not fan).
  // Three restore→shed bounces in 17 minutes wound the backoff ladder to
  // 15 min and the room read as "never turns on". Encoded here: her capAmps
  // (the physics) sit ABOVE the config model (the belief), and the learned
  // book already knows the honest 3.7A price.
  const book = {
    "najat|gen|on@L1": { ewmaAmps: 3.7, samples: 2, updatedAt: 1_000_000_000 },
  };
  const evening = (): Scenario =>
    new Scenario(
      cfg,
      [
        { ...ABDU, level: 1, fan: 6, demandAmps: 6, needDelta: 1.9 }, // 4.1A cap-bound at L1
        // Real L1 draw 3.7A vs the 2.7A gen-model belief — today's regime. The
        // live compressor took ~3 min to full draw (the meter crossed the limit
        // 2–3 min after each restore), so the over-limit lands mid-ramp and the
        // shed preference correctly undoes HER turn-on, not a peer's.
        { ...NAJAT, shed: true, capAmps: [3.7, 4.5, 5.5], demandAmps: 5, needDelta: 2, rampSeconds: 180, surgeFactor: 1.2 },
      ],
      { nonAcAmps: 7.5, source: "gen", book }, // ≈11.9A with Najat off
    );

  it("bounces at most once (the probe), then waits for real headroom instead of storming", () => {
    const s = evening();
    const t0 = s.now;
    s.advance(10 * 60);
    // The probe (admitted at the 2.7A steady price) may ship and bounce ONCE —
    // its failure disables further probes, and the learned 3.7A price does not
    // fit 11.9A committed (15.6 > 14.9), so she stays shed. No 17-minute storm.
    const restores = s.commandsSince(t0, "power_on").filter((c) => c.cmd.deviceId === "najat");
    expect(restores.length).toBeLessThanOrEqual(1);
    const sheds = s.commandsSince(t0, "power_off").filter((c) => c.cmd.deviceId === "najat");
    expect(sheds.length).toBeLessThanOrEqual(1);
    expect(s.sim("najat").on).toBe(false);
  });

  it("returns at the learned price — and stays — once the house frees real headroom", () => {
    const s = evening();
    s.advance(10 * 60);
    expect(s.sim("najat").on).toBe(false);
    const t1 = s.now;
    s.setNonAc(6.0); // ≈1.5A of non-AC load leaves
    s.advance(6 * 60);
    expect(s.sim("najat").on).toBe(true);
    expect(s.totalAmps()).toBeLessThanOrEqual(15);
    // No bounce after the honest-priced return.
    expect(s.commandsSince(t1, "power_off").filter((c) => c.cmd.deviceId === "najat")).toHaveLength(0);
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

  // 2026-07-30 09:25:06 / 09:51:40 Baghdad. The gen tripped at a sustained
  // 14.2A, derated to 14.0A — and the derate CLIFF-expired at 09:45:06, handing
  // back the full 15A rating in one jump. The leveler raised Abdu L1→L2 two
  // seconds later and the gen went again at 14.7A. Because the first derate had
  // already retired, that second trip re-armed at 1.0A instead of compounding:
  // the "walk the limit down on every collapse" design defeated by its own
  // expiry. The rating is now handed back one COLLAPSE_DERATE_RECOVERY_STEP per
  // quiet rung, so the ladder is still standing when the next trip lands.
  it("hands the rating back in steps, never in one jump", () => {
    const s = postTrip();
    s.advance(5 * 60);
    s.trip();
    s.advance(30);
    s.recoverLine();
    expect(meterView(s.meterState, s.now).derateAmps).toBe(1);
    s.advance(21 * 60); // one rung past COLLAPSE_DERATE_MS
    expect(meterView(s.meterState, s.now).derateAmps).toBe(0.5);
    s.advance(21 * 60); // and the next
    expect(meterView(s.meterState, s.now).derateAmps).toBe(0);
    expect(s.meterState.derate).toBeNull();
  });

  it("a trip part-way up the recovery ladder escalates from where the line was", () => {
    const s = postTrip();
    s.advance(5 * 60);
    s.trip();
    s.advance(30);
    s.recoverLine();
    s.advance(21 * 60); // decayed to 0.5A — the live 09:45 state
    expect(meterView(s.meterState, s.now).derateAmps).toBe(0.5);
    s.trip();
    s.advance(30);
    s.recoverLine();
    // Live it re-armed at 1.0A (limit back to 14.0) because `standing` had
    // retired to 0. Compounding from the standing rung tightens it further.
    expect(meterView(s.meterState, s.now).derateAmps).toBe(1.5);
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

  /**
   * Abdu comes out of an over-limit trim holding fan 1, owing a climb back to 7.
   * The cut is dated past FAN_RESTORE_AFTER_CUT_MS on purpose: this suite is
   * about the ramp-absorption ratchet, so the cut cooldown must not be what
   * decides the outcome.
   */
  const holdAbduFan = (s: Scenario): void => {
    s.sim("abdu").fan = 1;
    s.fanHolds = {
      abdu: {
        deviceId: "abdu",
        originalFan: 7,
        lastSetFan: 1,
        heldAt: s.now - FAN_RESTORE_AFTER_CUT_MS,
        fromCut: true,
        lastCutAt: s.now - FAN_RESTORE_AFTER_CUT_MS,
      },
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

    // The climb is bounded to a few gears per step since 2026-07-31, so the
    // regression is "it starts climbing before the ramp expires", not "it
    // reaches 7 in one command".
    const restore = s
      .commandsSince(dropAt, "set_fan")
      .find((e) => e.cmd.deviceId === "abdu" && e.cmd.kind === "set_fan" && e.cmd.fan > 1);
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

// ---------------------------------------------------------------------------
// 2026-07-28 evening, 15:35 → 16:40 Baghdad. Gen changeover at 15:35 with only
// Najat on; she climbed to L3 by 15:39 while she still needed it. Abdu came on
// at 15:49 into a hot room and climbed to L3 at 15:55 — admitted only because
// Najat's L3 (sent 15:39:49) had not confirmed yet, so the envelope priced her
// at L2. By 16:06 the house was over the limit, and the reducer took the amps
// out of ABDU (need 1.9°C) instead of Najat's dormant levels (need 0.5°C),
// because she inherited the +25 top-priority surcharge with Abdullah's AC off.
// Abdu then sat pinned at L1/L2 for 35 minutes while she held 6.3A she no
// longer needed.
// ---------------------------------------------------------------------------
describe("2026-07-28 evening budget hog (the loaded spring)", () => {
  const hog = () =>
    new Scenario(
      cfg,
      [
        // Najat satisfied and parked high; Abdu hot and pinned low.
        { ...NAJAT, level: 3, demandAmps: 2.4, needDelta: 0.2 },
        { ...ABDU, level: 1, demandAmps: 6.0, needDelta: 1.9 },
      ],
      { nonAcAmps: 2.0, source: "gen" },
    );

  it("reclaims the satisfied room's dormant levels and gives them to the hot room", () => {
    const s = hog();
    const t0 = s.now;
    s.advance(400);
    const levels = setLevels(s, t0);
    const najatDown = levels.find((l) => l.cmd.deviceId === "najat" && l.cmd.level < 3);
    const abduUp = levels.find((l) => l.cmd.deviceId === "abdu" && l.cmd.level > 1);
    expect(najatDown).toBeDefined();
    expect(abduUp).toBeDefined();
    // The hot room ends up above the satisfied one — the whole point.
    expect(s.sim("abdu").level).toBeGreaterThan(s.sim("najat").level);
  });

  it("never crosses the breaker while doing it", () => {
    const s = hog();
    s.advance(400);
    expect(s.events.some((e) => e.event.kind === "collapse")).toBe(false);
    // Our own demote is a commanded cut, not a trip.
    expect(s.plans.some((p) => p.reason === "collapsed")).toBe(false);
  });

  it("does not bounce the satisfied room back up while it stays satisfied", () => {
    const s = hog();
    const t0 = s.now;
    s.advance(600);
    const najatRaises = setLevels(s, t0).filter((l) => l.cmd.deviceId === "najat" && l.cmd.level > 1);
    expect(najatRaises).toHaveLength(0);
  });

  it("gives the levels back when the room needs them again", () => {
    const s = hog();
    s.advance(400);
    expect(s.sim("najat").level).toBe(1);
    // The room heats up past the band again.
    s.setDemand("najat", 3.0, 2.5);
    const t1 = s.now;
    s.advance(400);
    expect(setLevels(s, t1).some((l) => l.cmd.deviceId === "najat" && l.cmd.level > 1)).toBe(true);
  });

  it("a manually pinned room is never harvested, even parked above its need", () => {
    const s = new Scenario(
      cfg,
      [
        { ...NAJAT, level: 3, demandAmps: 2.4, needDelta: 0.2 },
        { ...ABDU, level: 1, demandAmps: 6.0, needDelta: 1.9 },
      ],
      { nonAcAmps: 2.0, source: "gen" },
    );
    s.pinLevel("najat", 3);
    const t0 = s.now;
    s.advance(400);
    expect(setLevels(s, t0).some((l) => l.cmd.deviceId === "najat")).toBe(false);
    expect(s.sim("najat").level).toBe(3);
  });
});

// Live 2026-07-30 05:51:07 Baghdad, 15A gen. The house had been on generator
// for 33 minutes — long past FLOORS — with Abdullah at L3 and Abdu at L1,
// ≈13.2A total. The user turned Najat on. Nothing admitted her: the grid full
// start had driven her to L3 before she was switched off, the TCL restored
// generatorMode 3, and 6.3A of modeled draw landed on the line.
//
// The reducer did fire — and asked for 1.2A. That figure came from the
// freshly-on projection pricing her at floorOf() (her on@L1 EWMA, 2.86A):
// 13.205 + 2.86 − 15 + 0.1 = 1.165A, the exact number in journal row for
// 05:51:15. Priced at the L3 she was actually at, the honest deficit was 4.6A —
// more than cutting Najat alone can cover, so a peer HAD to move. Instead the
// house rode 16.77A for two minutes and the user hand-set Abdullah → L1 and
// Najat → L1 at 05:53:07 / 05:53:15.
describe("the 2026-07-30 gen turn-on at L3 (nothing admitted the newcomer)", () => {
  const HOT_ABDULLAH: SimAcSetup = {
    deviceId: "abdullah",
    capAmps: [2.2, 3.9, 5.3],
    demandAmps: 5.5,
    needDelta: 1.5,
    level: 3,
    rampSeconds: 30,
  };
  const SETTLED_ABDU: SimAcSetup = {
    deviceId: "abdu",
    capAmps: [4.1, 6.5, 9.0],
    demandAmps: 6.0,
    needDelta: 1.6,
    level: 1,
    rampSeconds: 30,
  };
  // Off, and holding the L3 the grid full start left her at.
  const NAJAT_OFF: SimAcSetup = {
    deviceId: "najat",
    capAmps: [2.2, 3.9, 5.3],
    demandAmps: 5.5,
    needDelta: 0.9,
    level: 3,
    on: false,
    rampSeconds: 240,
  };

  const evening = (): Scenario =>
    new Scenario(cfg, [SETTLED_ABDU, HOT_ABDULLAH, NAJAT_OFF], { nonAcAmps: 3.5, source: "gen" });

  /** Advance in single steps, returning the highest total the line ever carried. */
  const peakOver = (s: Scenario, seconds: number): number => {
    let peak = s.totalAmps();
    for (let i = 0; i < seconds / 5; i++) {
      s.advance(5);
      peak = Math.max(peak, s.totalAmps());
    }
    return peak;
  };

  it("clamps the newcomer to its floor instead of adopting the level it came back at", () => {
    const s = evening();
    s.advance(120);
    const t0 = s.now;
    s.turnOn("najat", 3); // the TCL restores generatorMode 3
    s.advance(60);

    const clamp = s.commandsSince(t0, "set_level").filter((e) => e.cmd.deviceId === "najat");
    expect(clamp.length).toBeGreaterThan(0);
    expect(clamp[0].cmd).toMatchObject({ kind: "set_level", level: 1 });
    expect(s.plans.some((p) => p.decisions.some((d) => d.action === "gen start L1"))).toBe(true);
  });

  it("sizes the deficit off the level she is really at, not her floor", () => {
    const s = evening();
    s.advance(120);
    s.turnOn("najat", 3);
    s.advance(10);

    const over = s.plans.filter((p) => p.reason.startsWith("over"));
    expect(over.length).toBeGreaterThan(0);
    // The bug asked for ~1.2A — small enough that cutting the newcomer alone
    // covered it, which is exactly why Abdullah was never touched.
    expect(over[0].requiredAmps).toBeGreaterThan(2);
  });

  it("takes the amps from a peer too — the user should not have to do it by hand", () => {
    const s = evening();
    s.advance(120);
    const t0 = s.now;
    s.turnOn("najat", 3);
    s.advance(5 * 60);

    const peerCuts = s
      .commandsSince(t0, "set_level")
      .filter((e) => e.cmd.deviceId !== "najat" && e.cmd.kind === "set_level" && e.cmd.level < 3);
    expect(peerCuts.length).toBeGreaterThan(0);
    expect(s.sim("abdullah").level).toBeLessThan(3);
  });

  it("never rides the 16.8A the live house did, and keeps every room on", () => {
    const s = evening();
    s.advance(120);
    s.turnOn("najat", 3);
    expect(peakOver(s, 10 * 60)).toBeLessThan(16);
    expect(s.acsOn()).toEqual(["abdu", "abdullah", "najat"]);
    expect(s.totalAmps()).toBeLessThanOrEqual(cfg.genLimitAmps);
  });

  it("does not re-lift her while the start window is open", () => {
    const s = evening();
    s.advance(120);
    s.turnOn("najat", 3);
    s.advance(3 * 60);
    // The clamp and the raise phase both target this room; if the raise wins the
    // dedupe, the entry policy is decorative.
    expect(s.sim("najat").level).toBe(1);
    expect(
      s.plans.some((p) => p.decisions.some((d) => d.deviceId === "najat" && d.blockedBy === "gen start floor")),
    ).toBe(true);
  });

  it("grid is untouched — a turn-on there still starts FULL", () => {
    const s = new Scenario(cfg, [SETTLED_ABDU, HOT_ABDULLAH, NAJAT_OFF], { nonAcAmps: 3.5, source: "grid" });
    s.advance(120);
    const t0 = s.now;
    s.turnOn("najat", 1);
    s.advance(60);
    const lifts = s
      .commandsSince(t0, "set_level")
      .filter((e) => e.cmd.deviceId === "najat" && e.cmd.kind === "set_level" && e.cmd.level > 1);
    expect(lifts.length).toBeGreaterThan(0);
  });
});

// 2026-07-31 Baghdad, 15A gen. Everyone was already at their floor and the
// meter had ridden 12.4–15.4A for ten minutes — five over-limit episodes, four
// fan trims and a whole-AC shed. The controller nonetheless found budget for a
// level, twice, and the second one took the breaker:
//
//   17:29:32  Abdu fan 1→7   (fan restore — spends, and nothing charged it)
//   17:29:44  Abdullah L2→L3 (12s later, admitted on a 9.91A trough)
//   17:30:24  Abdu fan 7→1   17:30:30 Abdullah L3→L2   (both undone)
//   17:31:44  Abdu fan 1→7   17:32:01 Abdullah L2→L3   (both redone) → 15.93A
//   17:32:53  Abdu fan 7→4   (52s of overload later, and it picked a FAN)
//   17:33:31  Abdullah L3→L2 (90s in) — the gen was already gone
//
// Abdullah carries a live L2 boost floor, so the room the controller wanted to
// raise was also the one holding the most dormant amps.
describe("the 2026-07-31 gen trip", () => {
  // Model floors: abdullah L2 4.1, najat L1 2.7, abdu L1 4.5 → 11.3A modeled.
  // Sim floors: 3.9 + 2.2 + 4.1 = 10.2A actually drawn.
  const atFloors = (nonAcAmps: number): Scenario =>
    new Scenario(
      cfg,
      [
        { ...ABDULLAH, level: 2, minLevel: 2, demandAmps: 5.3, needDelta: 7 },
        { ...NAJAT, level: 1, demandAmps: 3.9, needDelta: 1.1 },
        { ...ABDU, level: 1, demandAmps: 9.0, needDelta: 2.4, fan: 7 },
      ],
      { nonAcAmps, source: "gen" },
    );

  it("refuses a raise on a TROUGH, because the envelope remembers the real house", () => {
    // Settled at 13.8A (house 3.6): measured non-AC residual ≈ 2.5A.
    const s = atFloors(3.6);
    s.advance(5 * 60);
    // Now the house dips — the live shape was a shed-and-restore leaving the
    // meter 2.5A below the steady state of this very configuration. Meter-side
    // admission alone sees 3.2A of headroom against a 1.6A step and says yes.
    s.setNonAc(1.2);
    const t0 = s.now;
    s.advance(3 * 60);
    // Envelope: 12.9A of caps + the 2.5A house peak = 15.4 > 14.8 → refused.
    expect(s.sim("abdullah").level).toBe(2);
    expect(setLevels(s, t0).filter((c) => c.cmd.level > 2)).toHaveLength(0);
    expect(
      s.plans.some((p) =>
        p.decisions.some((d) => d.deviceId === "abdullah" && d.blockedBy === "physics envelope"),
      ),
    ).toBe(true);
  });

  it("still raises when the house is genuinely, durably small", () => {
    // Same rooms, same trough mechanics — but the house has been 1.2A all along,
    // so there is no stale peak and the raise is honestly affordable.
    const s = atFloors(1.2);
    s.advance(8 * 60);
    expect(s.sim("abdullah").level).toBeGreaterThan(2);
    expect(s.totalAmps()).toBeLessThanOrEqual(cfg.genLimitAmps);
  });

  it("answers an over-limit with a LEVEL while one is available, never a fan", () => {
    const s = atFloors(3.0);
    s.advance(60);
    // Abdullah is above his floor and the house goes over: a 1.6A level cut is
    // on the table and Abdu is sitting at fan 7. Live, the reducer took the fan.
    s.sim("abdullah").level = 3;
    s.sim("abdullah").shadowLevel = 3;
    s.setNonAc(4.4);
    const t0 = s.now;
    s.advance(2 * 60);
    const first = s.commandsSince(t0).find((e) => e.cmd.kind === "set_fan" || e.cmd.kind === "set_level");
    expect(first?.cmd.kind).toBe("set_level");
  });

  it("acts within ~15s of a clear overload, not 52s", () => {
    const s = atFloors(3.0);
    s.advance(60);
    s.sim("abdullah").level = 3;
    s.sim("abdullah").shadowLevel = 3;
    s.setNonAc(4.4); // ≈ 15.6A — 0.7A over: past the moderate rung, under severe
    const t0 = s.now;
    s.advance(2 * 60);
    const first = s.commandsSince(t0, "set_level")[0];
    expect(first).toBeDefined();
    expect(first.at - t0).toBeLessThanOrEqual(20_000);
  });

  it("does not play the fan up and down (the 7→5→3→1→7→1→7→4 cascade)", () => {
    // Everyone pinned at their floor so fans are the ONLY lever, then a house
    // that keeps crossing and re-crossing the limit — the live 10-minute shape.
    const s = atFloors(3.0);
    s.advance(60);
    const t0 = s.now;
    for (let i = 0; i < 8; i++) {
      s.setNonAc(4.6); // over
      s.advance(75);
      s.setNonAc(2.6); // back under, calm rebuilds
      s.advance(75);
    }
    const fanCmds = s
      .commandsSince(t0, "set_fan")
      .filter((e) => e.cmd.deviceId === "abdu")
      .map((e) => ({ at: e.at, cmd: e.cmd as Extract<Command, { kind: "set_fan" }> }));
    const fans = fanCmds.map((e) => e.cmd.fan);
    // Direction reversals are the bounce; a staged climb is not.
    let reversals = 0;
    for (let i = 2; i < fans.length; i++) {
      const prev = Math.sign(fans[i - 1] - fans[i - 2]);
      const curr = Math.sign(fans[i] - fans[i - 1]);
      if (prev !== 0 && curr !== 0 && prev !== curr) reversals++;
    }
    expect(reversals).toBeLessThanOrEqual(3);
    // Every climb is ≤ 2 gears, EXCEPT at most ONE full swing that STICKS. The
    // oscillation now parks the fan at 1 via the bounce compounding (2026-08-08 —
    // reversals collapsed to 1), and the single post-storm recovery is invariant
    // 60's fast path (2026-08-06, user-approved): a one-command full climb when
    // spendable is wide. That is told from the 2026-07-31 disease — a full swing
    // that BOUNCES — by whether it STICKS: no further fan CUT within
    // FAN_BOUNCE_WINDOW_MS after it. Repeated full swings, or one followed by a
    // cut, still fail.
    let fullSwings = 0;
    for (let i = 1; i < fanCmds.length; i++) {
      if (fanCmds[i].cmd.fan - fanCmds[i - 1].cmd.fan <= 2) continue;
      fullSwings++;
      expect(fullSwings, "more than one full-swing restore").toBeLessThanOrEqual(1);
      const reCut = fanCmds
        .slice(i + 1)
        .some((e) => e.cmd.reason === "trim" && e.at - fanCmds[i].at < FAN_BOUNCE_WINDOW_MS);
      expect(reCut, "full-swing restore was re-cut within the bounce window").toBe(false);
    }
  });
});

// 2026-08-01 Baghdad, 15A gen. At 17:25 the envelope was honest ("incl. 2.6A
// house"); at ~17:27 Abdullah's AC went off, and the tick after read the
// smoothed meter — still carrying his dying compressor — against a model he
// had already left: 7.1A of "house" (real: ~4.1A). The only sample tagged
// with the new set, so it WAS the 15-minute peak: every raise refused at
// "worst case 16.2A > 14.9A" while the meter sat at 11–12A, until the user
// raised Abdu to L2 by hand at 17:44.
describe("the 2026-08-01 phantom house (a turn-off books its own decay)", () => {
  const genHouse = (): Scenario =>
    new Scenario(
      cfg,
      [
        { ...ABDULLAH, level: 2, minLevel: 2, demandAmps: 3.5, needDelta: 0.6 },
        { ...NAJAT, level: 1, demandAmps: 3.0, needDelta: 1.1 },
        { ...ABDU, level: 1, demandAmps: 9.0, needDelta: 2.4 },
      ],
      { nonAcAmps: 3.4, source: "gen" },
    );

  it("spends a turn-off's freed headroom on the hot room instead of fencing it behind the ghost", () => {
    const s = genHouse();
    s.advance(6 * 60); // honest same-set samples accumulate (~2.2A house)
    expect(s.sim("abdu").level).toBe(1); // nothing fits while all three run
    s.turnOff("abdullah");
    const t0 = s.now;
    s.advance(4 * 60);
    // ~3.6A really left the meter; the envelope must see the honest house and
    // hand the hot room its level — the live system sat blocked for 14 minutes.
    expect(s.sim("abdu").level).toBe(2);
    expect(s.totalAmps()).toBeLessThanOrEqual(cfg.genLimitAmps);
    // And nobody paid for it: the raise fit, so no reducer episode followed.
    expect(s.commandsSince(t0, "power_off")).toHaveLength(0);
  });
});

// User request 2026-08-01: with the house stable, an extra level parked on a
// warm room must migrate to a clearly hotter room at base level — donor steps
// down first (its saving must LAND before the raise spends it, invariant 9),
// the hot room climbs in the next calm window, and the trade never reverses
// while the need ordering holds.
describe("the 2026-08-01 level rebalance (the extra level follows the hotter room)", () => {
  it("hands Najat's extra level to a hotter 2-ton Abdu — demote and raise in one batch, no churn", () => {
    const s = new Scenario(
      cfg,
      [
        { ...NAJAT, level: 2, demandAmps: 4.2, needDelta: 0.8 },
        { ...ABDU, level: 1, demandAmps: 9.0, needDelta: 2.4 },
      ],
      { nonAcAmps: 4.4, source: "gen" },
    );
    const t0 = s.now;
    s.advance(8 * 60);
    expect(s.sim("najat").level).toBe(1);
    expect(s.sim("abdu").level).toBe(2);
    // One batch (2026-08-08 instant sequencing): the donor's demote and the raise
    // it funds ship TOGETHER, the demote's fall credited so the meter cannot read
    // it as a trip.
    const cmds = setLevels(s, t0);
    const demote = cmds.find((c) => c.cmd.deviceId === "najat" && c.cmd.level === 1);
    const raise = cmds.find((c) => c.cmd.deviceId === "abdu" && c.cmd.level === 2);
    expect(demote).toBeDefined();
    expect(raise).toBeDefined();
    expect(raise!.at).toBe(demote!.at);
    expect(s.totalAmps()).toBeLessThanOrEqual(cfg.genLimitAmps);
    // Settled: the needs still order the same way, so the trade must hold.
    const settled = s.commandsSince(t0, "set_level").length;
    s.advance(12 * 60);
    expect(s.commandsSince(t0, "set_level").length).toBe(settled);
  });

  it("near-equal rooms do not trade — the gap is the anti-bounce hysteresis", () => {
    // House heavy enough that neither raise fits the meter: the only way Abdu
    // could climb is by taking Najat's level — and at a 0.4°C gap he must not.
    const s = new Scenario(
      cfg,
      [
        { ...NAJAT, level: 2, demandAmps: 4.2, needDelta: 2.0 },
        { ...ABDU, level: 1, demandAmps: 9.0, needDelta: 2.4 },
      ],
      { nonAcAmps: 5.2, source: "gen" },
    );
    s.advance(10 * 60);
    expect(s.sim("najat").level).toBe(2);
    expect(s.sim("abdu").level).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The changeover dead window (2026-08-04, 11:16-11:23 Baghdad, 15A gen).
//
// The grid→gen changeover power-cycled all three ACs. FLOORS clamped Abdullah
// to his L2 boost floor and the others to L1 — correctly — and then TCL
// compressor restart protection kept every compressor OFF for about six
// minutes, each room drawing roughly its fan.
//
// `rearmRamp`'s 240s windows expired ON THE CLOCK at ~11:20:10 with nothing
// running. FLOORS cleared four seconds later (it waits for "nothing ramping"),
// the freed sampler booked `max(0, 6.1 − 10.4) = 0` as the house, and the raise
// path opened onto a 6.1A meter that was pure house load: Abdullah L2→L3 at
// 11:20:14 and Abdu L1→L2 at 11:20:49, both admitted "incl. 0.0A house". At
// 11:22:10-49 every compressor engaged together — 6.4 → 15.7 → 16.6A smoothed,
// two severe cuts, and the user switching a room off by hand.
//
// `restartDelayMs` is the harness debt this needed, exactly as `residualAmps`
// was for the 08-02 breaks: without it the sim's compressors always restart
// instantly and the failure is unreachable.
// ---------------------------------------------------------------------------

describe("the changeover dead window (2026-08-04)", () => {
  // Restart protection outlasts the ramp window by the same ratio it did live
  // (~6.5 min against a 4-min window); the harness's compressors ramp in 60s,
  // so 150s is the same shape at test speed — and still inside the 3-window cap.
  const DEAD_MS = 150_000;
  // Demands chosen so the FLOOR state fits the 14.9A gen (3.9 + 4.1 + 2.2 +
  // 3.5 house ≈ 14.0) while the two raises live admitted would not
  // (5.3 + 6.5 + 2.2 + 3.5 ≈ 17.8).
  const trio = (): SimAcSetup[] => [
    { ...ABDULLAH, level: 3, minLevel: 2, demandAmps: 5.3, needDelta: 3, restartDelayMs: DEAD_MS, rampSeconds: 60 },
    { ...ABDU, level: 3, demandAmps: 6.5, needDelta: 2.5, restartDelayMs: DEAD_MS, rampSeconds: 60 },
    { ...NAJAT, level: 3, demandAmps: 2.2, needDelta: 1, restartDelayMs: DEAD_MS, rampSeconds: 60 },
  ];
  const changeover = () => {
    const s = new Scenario(cfg, trio(), { nonAcAmps: 3.5, source: "grid", seed: 20260804 });
    s.advance(300); // a settled grid session, everyone at their ceiling
    s.setSource("gen");
    return s;
  };
  /** A command that raises a room above the level gen entry put it at. */
  const spends = (s: Scenario, since: number) =>
    setLevels(s, since).filter((e) => e.cmd.level > (e.cmd.deviceId === "abdullah" ? 2 : 1));

  it("still lands the gen-entry floors while every compressor is dead", () => {
    // The thing that must NOT regress: FLOORS is a source-entry batch, not a
    // spend, and it has to ship through the whole dead window.
    const s = changeover();
    const t0 = s.now;
    s.advance(60);
    const clamps = setLevels(s, t0);
    expect(clamps.some((e) => e.cmd.deviceId === "abdullah" && e.cmd.level === 2)).toBe(true);
    expect(clamps.some((e) => e.cmd.deviceId === "abdu" && e.cmd.level === 1)).toBe(true);
    expect(clamps.some((e) => e.cmd.deviceId === "najat" && e.cmd.level === 1)).toBe(true);
  });

  it("spends nothing for the whole dead window — a timer is not evidence of draw", () => {
    const s = changeover();
    const t0 = s.now;
    s.advance(150);
    const raised = spends(s, t0);
    expect(raised, JSON.stringify(raised.map((e) => e.cmd))).toHaveLength(0);
    expect(s.commandsSince(t0, "power_on")).toHaveLength(0);
  });

  it("feeds the envelope the house it can actually see, not a fictitious zero", () => {
    const s = changeover();
    s.advance(150);
    // 3.5A of house plus three fans, MEASURED off the meter — never handed to
    // the planner from the sim's ground truth.
    expect(s.measuredHouseAmps()).toBeGreaterThan(3);
    expect(s.measuredHouseAmps()).toBeLessThan(4.5);
  });

  it("rides the simultaneous restart without an overload, and the coolest room waits", () => {
    const s = changeover();
    const t0 = s.now;
    s.advance(150);
    let peak = 0;
    for (let i = 0; i < 60; i++) {
      s.step();
      peak = Math.max(peak, meterView(s.meterState, s.now).smoothedAmps);
    }
    // Every compressor engaged at once, and nothing extra was admitted while
    // they were dead — so what arrives is the floor state, and it stays under.
    expect(peak).toBeLessThanOrEqual(cfg.genLimitAmps);
    // R11b (user, 2026-08-04 17:22): this trio's floors are 11.3A modeled and
    // the carried house is ~4, which is over the 14.8A ceiling BEFORE the first
    // compressor starts. A changeover power-cycles every room exactly as a
    // collapse recovery does, so the entry admission decides it on the envelope
    // rather than letting the restart prove it — the coolest room waits while
    // the two hotter ones hold their floors through the restart.
    expect(s.commandsSince(t0, "power_off").map((e) => e.cmd.deviceId)).toEqual(["najat"]);
    expect(s.sim("abdullah").level).toBe(2);
    expect(s.sim("abdu").level).toBe(1);
    // …and she is on the ORDINARY restore queue, so once the restart has landed
    // and the meter shows the real draw she comes back on her own terms.
    expect(s.acsOn()).toContain("najat");
  });

  it("a changeover whose floors DO fit sheds nobody — the admission is free when it can be", () => {
    // The other half of R11b, and the reason it is safe to run on every entry:
    // the phase only removes rooms that Σ floor models + house cannot carry.
    // Same trio, same entry, a house small enough that 11.3A of floors fits
    // under the 14.8A ceiling → the batch is an ordinary FLOORS clamp.
    const s = new Scenario(cfg, trio(), { nonAcAmps: 1.0, source: "grid", seed: 20260804 });
    s.advance(300);
    const t0 = s.now;
    s.setSource("gen");
    s.advance(150);
    expect(s.commandsSince(t0, "power_off")).toHaveLength(0);
    expect(s.acsOn().sort()).toEqual(["abdu", "abdullah", "najat"]);
  });

  it("hands the raise path back once the compressors prove they are drawing", () => {
    // The other half: the hold must not become a freeze. Once the meter shows
    // the draw, the windows close on their ordinary terms.
    const s = changeover();
    s.advance(150 + 300);
    const t0 = s.now;
    s.advance(300);
    const stillRamping = s.plans
      .slice(-40)
      .some((p) => p.decisions.some((d) => d.blockedBy === "ramping"));
    expect(stillRamping).toBe(false);
    expect(s.commandsSince(t0, "power_off")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Trip on ENTRY, and the recovery that follows (2026-08-04, user-confirmed:
// the breaker physically tripped and he reset it by hand).
//
// The refined timeline. The gen session did not merely start with compressors
// in restart protection — it started with the AC CIRCUIT DEAD. 11:16 to ~11:21
// was an open breaker, the four FLOORS resends went to devices that could not
// hear them, and the reset brought all three rooms back AT ONCE with restart
// protection already served: 6.4 → 16.6A in ninety seconds.
//
// Two failures, one event. The collapse latch judges FALLS inside a session and
// a session that begins dead has no cliff, so a real trip went unlatched for
// the third time in ten days — no derate, and the controller then rode
// 14.3–14.8A on a breaker that had just opened. And the return itself was
// unmanageable by the meter: floors modeled 11.3A + a measured ~6A house is
// 17.3A on a 14.9A ceiling, decided before the first reading arrived.
//
// The same shape ran again in production at 12:39:57 the same day. That one
// latched correctly on the fall, derated to 14A, re-entered at FLOORS and shed
// a room at 12:43:49 — the right end-state, reached only after riding over the
// derated limit for minutes. Recovery admission is that end-state chosen up
// front.
// ---------------------------------------------------------------------------

describe("trip on entry, and the surge that follows (2026-08-04)", () => {
  // Floors: Abdullah L2 (boost) 4.1 + Abdu L1 4.5 + Najat L1 2.7 = 11.3A
  // modeled, against a 6A house and a 14.9A ceiling. Physically they draw
  // 3.9 + 4.1 + 2.2 = 10.2, so all three back at once is 16.2A on a 14.9A gen.
  const trio = (): SimAcSetup[] => [
    { ...ABDULLAH, level: 2, minLevel: 2, demandAmps: 3.9, needDelta: 3, rampSeconds: 60 },
    { ...ABDU, level: 1, demandAmps: 4.1, needDelta: 2.5, rampSeconds: 60 },
    { ...NAJAT, level: 1, demandAmps: 2.2, needDelta: 1, rampSeconds: 60 },
  ];
  /** Grid session, then the changeover, then the AC breaker opens. */
  const deadEntry = () => {
    const s = new Scenario(cfg, trio(), {
      // 5A of house, not the live ~6: the entry latch derates the gen by 1A
      // (invariants 2/15 — the breaker really did open), and the brief's
      // arithmetic was written against the nameplate 15A. Same shape, same
      // conclusion, judged against the ceiling the line has actually been
      // holding — which is the point of `effectiveLimit`.
      nonAcAmps: 5.0,
      residualAmps: 5.0, // the house keeps drawing — invariant 31's shape
      source: "grid",
      seed: 20260804,
    });
    // A live CT always micro-moves; a flat post-trip meter would otherwise read
    // as a HUNG SENSOR and kill calm for its own reasons.
    s.setNoise(0.05);
    s.advance(300);
    s.setSource("gen");
    s.trip(); // 11:16 — the AC circuit is dead as the generator takes over
    return s;
  };

  it("latches the collapse a session that BEGINS dead gives no cliff for", () => {
    const s = deadEntry();
    s.advance(6 * 60);
    const view = meterView(s.meterState, s.now);
    expect(view.collapsed).toBe(true);
    // …with the real machinery: the ceiling comes down while the breaker cools.
    expect(view.derateAmps).toBeGreaterThan(0);
  });

  it("does not latch while the rooms are merely slow to start", () => {
    // The discriminator. Same dead-looking meter, same gap — but the Wi-Fi
    // modules are powered, so the shadows keep reporting. Restart protection
    // must never read as a breaker trip.
    const s = new Scenario(
      cfg,
      trio().map((a) => ({ ...a, restartDelayMs: 6 * 60_000 })),
      { nonAcAmps: 5.0, source: "grid", seed: 20260804 },
    );
    s.setNoise(0.05);
    s.advance(300);
    s.setSource("gen");
    s.advance(6 * 60);
    expect(meterView(s.meterState, s.now).collapsed).toBe(false);
    expect(meterView(s.meterState, s.now).derateAmps).toBe(0);
  });

  it("admits the returning rooms hottest-first and sheds the one that does not fit", () => {
    const s = deadEntry();
    const t0 = s.now; // BEFORE the changeover — see R11b below
    s.advance(6 * 60);
    s.recoverLine(); // ~11:21 — the user resets the breaker
    s.advance(4 * 60);
    // ⚠ The window starts at the changeover, not at the reset. Since R11b the
    // admission runs on EVERY gen entry, so on a session that begins dead the
    // room that cannot fit is decided as the line comes up — before the breaker
    // is even known to be open. The end-state is what this pins; WHICH tick
    // reached it is not the guarantee.

    // 5A house + Abdullah's 4.1 + Abdu's 4.5 = 13.6 fits under the 13.8A
    // derated ceiling; Najat's 2.7 does not, and she is the coolest room
    // (need 1 against 3 and 2.5).
    const off = s.commandsSince(t0, "power_off");
    expect(off.map((e) => e.cmd.deviceId)).toEqual(["najat"]);
    expect(s.acsOn().sort()).toEqual(["abdu", "abdullah"]);
    // The hot rooms come back AT THEIR FLOORS, not at whatever the firmware
    // restored — and never at level 0.
    expect(s.sim("abdullah").level).toBe(2);
    expect(s.sim("abdu").level).toBe(1);
  });

  it("reaches that end-state BEFORE the meter has to prove it", () => {
    // The 12:39:57 production trip got here too, but only after riding over its
    // own derated limit for minutes while the reducer worked it out. The whole
    // point of admitting on the envelope is that the surge never happens.
    const s = deadEntry();
    const t0 = s.now; // before the changeover — the admission decides at entry (R11b)
    s.advance(6 * 60);
    s.recoverLine();
    let peak = 0;
    for (let i = 0; i < 60; i++) {
      s.step();
      peak = Math.max(peak, meterView(s.meterState, s.now).smoothedAmps);
    }
    expect(peak).toBeLessThanOrEqual(cfg.genLimitAmps);
    // One room off, once — not a shed, a restore and a re-shed.
    expect(s.commandsSince(t0, "power_off")).toHaveLength(1);
  });

  it("leaves the shed room on the ORDINARY restore queue, not a parallel one", () => {
    // Recovery admission sheds through the normal rows, so the normal
    // one-by-one restore brings the room back when real headroom appears.
    const s = deadEntry();
    s.advance(6 * 60);
    s.recoverLine();
    s.advance(4 * 60);
    expect(s.acsOn().sort()).toEqual(["abdu", "abdullah"]);
    const t1 = s.now;
    s.setNonAc(1.5); // the house load leaves; now she genuinely fits
    s.advance(10 * 60);
    expect(s.commandsSince(t1, "power_on").map((e) => e.cmd.deviceId)).toContain("najat");
  });

  it("respects a manual pin — recovery never sheds a room the user asked for", () => {
    // Being switched off is worse than any level (invariant 25), and a pin is
    // the clearest statement there is that this room is wanted. If the pinned
    // set alone cannot fit, the reducer answers it on the meter like any other
    // overload; this phase does not make that choice for the user.
    const s = deadEntry();
    s.pinLevel("najat", 1);
    s.advance(6 * 60);
    const t0 = s.now;
    s.recoverLine();
    s.advance(3 * 60);
    const off = s.commandsSince(t0, "power_off").map((e) => e.cmd.deviceId);
    expect(off).not.toContain("najat");
  });
});

describe("the 2026-08-06 heater episode — the gated proactive shed", () => {
  // 02:21Z grid→gen on a 15A generator. A heater put the non-AC house at 7.4A;
  // the extreme/severe rungs shed Najat and Abdu at 02:32. Najat's cheaper
  // 3.35A restore fitted at 02:33 and took the headroom — and Abdu, the HOTTER
  // room at 4.3A, then did not fit until 02:49, when the heater cycled off on
  // its own. Seventeen minutes with the amps sitting in a cooler room.
  //
  // The user's ask, verbatim: "after Najat on and be stable, there was enough
  // budget to turn off Najat and bring Abdu back on."
  const HOUSE_WITH_HEATER = 7.4;
  const HOUSE_HEATER_OFF = 4.0;
  // comfortTargetC is 26, so the room temperatures ARE the ranks: Abdullah 3.0,
  // Abdu 2.0, Najat 0.5. Abdu is 1.5°C hotter than Najat — clear of the 1.0°C
  // shed-side gap; Abdullah is hotter than both and can never be the donor.
  const scene = (): SimAcSetup[] => [
    { ...ABDULLAH, level: 1, demandAmps: 3.5, needDelta: 3, roomTempC: 29.0 },
    { ...NAJAT, level: 1, demandAmps: 3.0, needDelta: 0.5, roomTempC: 26.5 },
    { ...ABDU, level: 1, shed: true, demandAmps: 6.0, needDelta: 2, roomTempC: 28.0 },
  ];

  it("switches the COOLER running room off, alone, and gives its amps to the hotter shed room", () => {
    const s = new Scenario(cfg, scene(), { nonAcAmps: HOUSE_WITH_HEATER, source: "gen" });
    const t0 = s.now;
    // ~11.8A on the meter (7.4 house + two 1-ton floors). Abdu's 4.5A modeled
    // return is 16.3A against a 14.8A ceiling, and both peers are already at
    // their floors, so at-floors cannot rescue it either.
    s.advance(60);
    const offs = s.commandsSince(t0, "power_off");
    expect(offs).toHaveLength(1);
    expect(offs[0].cmd.deviceId).toBe("najat");
    // ONE batch (2026-08-08 instant sequencing): the donor's off and the
    // receiver's gentle restore ship TOGETHER — the off-cliff reaches the meter
    // in ~10-40s while the receiver's compressor engages minutes later, so the
    // two never overlap on the line, and the off's fall is credited so it cannot
    // latch a phantom collapse.
    const swapBatch = s.plans.find((p) => p.reason === "proactive_shed");
    expect(swapBatch?.commands).toEqual([
      { deviceId: "najat", kind: "power_off", reason: "shed" },
      { deviceId: "abdu", kind: "power_on", level: 1, reason: "restore", fan: 1 },
    ]);
    expect(swapBatch?.swap).toEqual({ donorId: "najat", receiverId: "abdu" });
    // …and it says so, in the journal the user reads.
    expect(swapBatch?.decisions).toContainEqual(
      expect.objectContaining({
        deviceId: "najat",
        action: "proactive shed",
        detail: expect.stringContaining("najat → abdu"),
      }),
    );
  });

  it("brings the hot room back in the SAME batch as the off, once the trade is priced", () => {
    const s = new Scenario(cfg, scene(), { nonAcAmps: HOUSE_WITH_HEATER, source: "gen" });
    const t0 = s.now;
    s.advance(5 * 60);
    const ons = s.commandsSince(t0, "power_on");
    expect(ons).toHaveLength(1);
    expect(ons[0].cmd.deviceId).toBe("abdu");
    const off = s.commandsSince(t0, "power_off")[0];
    // One batch (2026-08-08): the receiver returns TOGETHER with the donor's off,
    // sparing it the 17 minutes — and the 36s-plus committed-meter wait — the
    // live house sat out.
    expect(ons[0].at).toBe(off.at);
  });

  it("commits the freed amps to the receiver in one batch — no peer raise steals them", () => {
    const s = new Scenario(cfg, scene(), { nonAcAmps: HOUSE_WITH_HEATER, source: "gen" });
    const t0 = s.now;
    s.advance(5 * 60);
    // Abdullah is the HOTTEST room in the house and would happily take the 1.6A
    // the trade frees. The swap ships the off and the receiver's restore as one
    // batch and returns, so the raise phase never runs against those amps — the
    // receiver is committed, not stealable.
    const swapBatch = s.plans.find((p) => p.reason === "proactive_shed");
    expect(swapBatch?.commands.some((c) => c.deviceId === "abdullah")).toBe(false);
    // Abdullah never climbs off its floor onto the freed budget.
    expect(setLevels(s, t0).filter((e) => e.cmd.deviceId === "abdullah")).toEqual([]);
    expect(s.sim("abdullah").level).toBe(1);
  });

  it("holds the donor off until the heater releases — then restores it, with no oscillation", () => {
    const s = new Scenario(cfg, scene(), { nonAcAmps: HOUSE_WITH_HEATER, source: "gen" });
    const t0 = s.now;
    // Fifteen minutes of the heater still running: Najat stays off, because the
    // house genuinely cannot carry her on top of the room she paid for.
    s.advance(15 * 60);
    expect(s.commandsSince(t0, "power_on").map((e) => e.cmd.deviceId)).toEqual(["abdu"]);
    expect(s.commandsSince(t0, "power_off")).toHaveLength(1);
    // The heater cycles off — the real 02:49 event, this time with the hot room
    // already running.
    const t1 = s.now;
    s.setNonAc(HOUSE_HEATER_OFF);
    s.advance(15 * 60);
    expect(s.commandsSince(t1, "power_on").map((e) => e.cmd.deviceId)).toEqual(["najat"]);
    // Thirty minutes, three power commands, and nobody switched off twice. A
    // limit cycle here is a bug by the user's own definition.
    expect(s.commandsSince(t1, "power_off")).toEqual([]);
    expect(s.commandsSince(t0, "power_off")).toHaveLength(1);
    expect(s.commandsSince(t0, "power_on")).toHaveLength(2);
  });

  it("…and does the same under ±0.5A meter noise (the churn gate)", () => {
    // testing.md's standing rule: every new path that SPENDS or TRADES amps is
    // run under the noise scene before it ships. It is what caught both
    // load-bearing guards of the comparative-need rebalance — a deficit judged
    // off one noisy reading armed a trade on every dip, and the freed amps then
    // fit the DONOR's cheaper re-raise but not the receiver's, giving a 35s
    // donor↔receiver limit cycle while every targeted test stayed green. A trade
    // that costs a room its compressor has to be quieter than that, not louder.
    const s = new Scenario(cfg, scene(), { nonAcAmps: HOUSE_WITH_HEATER, source: "gen" });
    s.setNoise(0.5);
    const t0 = s.now;
    s.advance(15 * 60);
    // Exactly the same trade the quiet run makes — once.
    expect(s.commandsSince(t0, "power_off").map((e) => e.cmd.deviceId)).toEqual(["najat"]);
    expect(s.commandsSince(t0, "power_on").map((e) => e.cmd.deviceId)).toEqual(["abdu"]);

    const t1 = s.now;
    s.setNonAc(HOUSE_HEATER_OFF);
    s.advance(15 * 60);
    expect(s.commandsSince(t1, "power_on").map((e) => e.cmd.deviceId)).toEqual(["najat"]);

    // Thirty noisy minutes, three power commands, and no room switched off
    // twice: no shed→restore→shed of the same room, in either direction.
    expect(s.commandsSince(t0, "power_off")).toHaveLength(1);
    expect(s.commandsSince(t0, "power_on")).toHaveLength(2);
    expect(s.plans.filter((p) => p.reason === "proactive_shed")).toHaveLength(1);
  });

  it("does NOT fire when the two rooms are inside the gap (26.0 vs 25.3)", () => {
    // The same house, the same arithmetic, one difference: the running room is
    // only 0.7°C cooler than the shed one. That is the rebalance gap, not the
    // shed gap — a whole room is not traded on it. The shed room simply waits.
    const s = new Scenario(
      cfg,
      [
        { ...ABDULLAH, level: 1, demandAmps: 3.5, needDelta: 3, roomTempC: 29.0 },
        { ...NAJAT, level: 1, demandAmps: 3.0, needDelta: 0.5, roomTempC: 25.3 },
        { ...ABDU, level: 1, shed: true, demandAmps: 6.0, needDelta: 2, roomTempC: 26.0 },
      ],
      { nonAcAmps: HOUSE_WITH_HEATER, source: "gen" },
    );
    const t0 = s.now;
    s.advance(30 * 60);
    expect(s.commandsSince(t0, "power_off")).toEqual([]);
    expect(s.plans.some((p) => p.reason === "proactive_shed")).toBe(false);
  });

  it("stands down through the over-limit episode itself (02:32) — it is not an emergency tool", () => {
    // Both rooms at L2 with the heater on: ~15.2A on a 14.9A line. The reducer
    // cuts levels, the meter falls to ~11.8A, and the trade's arithmetic then
    // closes perfectly — Abdu is 2.5°C hotter than Najat, and her off buys his
    // return. It must NOT fire: a room is not traded away while a cut we
    // commanded is still landing and the bucket is still refilling. The
    // situational gate is what stops it, and it is load-bearing — forcing
    // `swapAllowed` true makes this scenario shed Najat inside the episode.
    const s = new Scenario(
      cfg,
      [
        { ...ABDULLAH, level: 2, demandAmps: 3.9, needDelta: 3, roomTempC: 28.0 },
        { ...NAJAT, level: 2, demandAmps: 3.9, needDelta: 2, roomTempC: 27.0 },
        { ...ABDU, level: 1, shed: true, demandAmps: 6.0, needDelta: 3, roomTempC: 29.5 },
      ],
      { nonAcAmps: HOUSE_WITH_HEATER, source: "gen" },
    );
    const t0 = s.now;
    s.advance(2 * 60);
    // The ladder did its job…
    expect(s.plans.some((p) => p.reason.startsWith("over_"))).toBe(true);
    // …and the comfort trade stayed out of it.
    expect(s.plans.some((p) => p.reason === "proactive_shed")).toBe(false);
    for (const e of s.commandsSince(t0, "power_off")) {
      const batch = s.plans.find((p) => p.commands.includes(e.cmd));
      expect(batch?.reason).toMatch(/^over_/);
    }
  });
});

// ---------------------------------------------------------------------------
// 2026-08-06 13:12-13:34Z, the user's own report: "the fan keeps bouncing".
// The house was saturated at the generator limit with a ~5A heater running:
// Abdullah at his L2 boost floor, Najat L1, Abdu L1 — ~10.2A modeled against a
// 14.9A ceiling — and the measured supply flicker was 0.96A. Every rung but the
// fan was already spent (invariant 17 satisfied), so the cycle ran roughly every
// five minutes: mean creeps over -> over_mild -> trim a fan -> meter dips ->
// calm -> `planFanRestore` hands the gear straight back at `cost <= headroom` ->
// mean back inside the flicker band of the limit -> the next compressor/house
// coincidence crosses -> trim again. Abdu's fan was commanded ten times in
// twenty-two minutes (7->6->7->2->3->5->7->5->1->3->4->6->7), Abdullah's five.
//
// Every individual rule behaved as specified; together they are a limit cycle,
// which is a bug by the user's standing rule (SETTLE, do not bounce). What
// nothing charged was the live flicker: handing 0.2-0.6A back into a mean
// sitting 0.7-1.1A under the ceiling, on a line that wobbles ±1A, guarantees
// the re-cross.
describe("2026-08-06 fan bounce: a restored fan may not re-enter the flicker band of the limit", () => {
  // Model floors: abdullah L2 4.1, najat L1 2.7, abdu L1 4.5. Sim floors:
  // 3.9 + 2.2 + 4.1 = 10.2A drawn, plus 0.7A of fan extras at 7/5/5.
  const HOUSE_HEATER = 3.0; // ≈ 13.9A total — 0.9A under the 14.8A ceiling
  const HOUSE_CROSSING = 4.1; // ≈ 15.0A — the coincidence that starts an episode
  const HOUSE_HEATER_OFF = 1.0; // ≈ 11.6A — genuine, durable room

  // What the meter actually taught the book that afternoon: the climb back to
  // the original gear graded +0.64A, i.e. a gear is ~0.2A, not the 0.1A seed
  // default. Load-bearing for this regression — at the seed price a gear costs
  // less than the flicker estimate's own tick-to-tick wobble, and the sim can
  // sneak a step through on a low tick that the live house never had.
  const fanBook = Object.fromEntries(
    ["abdu", "abdullah", "najat"].map((id) => [
      `${id}|gen|fan:step`,
      { ewmaAmps: 0.2, samples: 4, updatedAt: 1_000_000_000 },
    ]),
  );

  const saturated = (): Scenario =>
    new Scenario(
      cfg,
      [
        { ...ABDULLAH, level: 2, minLevel: 2, demandAmps: 3.9, needDelta: 3, fan: 5 },
        { ...NAJAT, level: 1, demandAmps: 2.2, needDelta: 1, fan: 5 },
        { ...ABDU, level: 1, demandAmps: 4.1, needDelta: 2, fan: 7 },
      ],
      { nonAcAmps: HOUSE_HEATER, source: "gen", seed: 20260806, book: { ...fanBook } },
    );

  const ROOMS = ["abdu", "abdullah", "najat"] as const;
  const fansOf = (s: Scenario): Record<string, number> =>
    Object.fromEntries(ROOMS.map((id) => [id, s.sim(id).fan]));

  /**
   * Settle on the flickering line, then drive ONE mild crossing so the reducer
   * — with every level already at its floor — takes the only rung it has left.
   * Returns the fans as they stood before the trim, so each assertion can name
   * the room the reducer actually chose rather than assuming one.
   */
  const trimAFan = (s: Scenario): { at: number; before: Record<string, number> } => {
    s.advance(120);
    // The live line: mostly quiet with a periodic reading a full amp high.
    s.setFlicker({ baseAmps: 0.15, spikeAmps: 0.9, spikeEveryN: 4 });
    s.advance(120);
    const at = s.now;
    const before = fansOf(s);
    s.setNonAc(HOUSE_CROSSING);
    s.advance(90);
    s.setNonAc(HOUSE_HEATER);
    return { at, before };
  };

  it("ACCEPTANCE: the trimmed fan stays down while the mean rides within flicker of the limit", () => {
    const s = saturated();
    const { at, before } = trimAFan(s);
    expect(s.commandsSince(at, "set_fan").length).toBeGreaterThanOrEqual(1);
    const trimmed = ROOMS.filter((id) => s.sim(id).fan < before[id]);
    expect(trimmed.length).toBeGreaterThanOrEqual(1);

    // Thirty minutes of exactly the house that produced the ten commands.
    const t1 = s.now;
    s.advance(30 * 60);
    const churn = s.commandsSince(t1, "set_fan").map((e) => `${(e.at - t1) / 1000}s ${JSON.stringify(e.cmd)}`);
    expect(churn, churn.join("\n")).toHaveLength(0);
    // …and nobody was switched off to buy the quiet, either.
    expect(s.commandsSince(t1, "power_off")).toEqual([]);
    for (const id of trimmed) expect(s.sim(id).fan).toBeLessThan(before[id]);
  });

  it("RECOVERY: the heater goes off and the trimmed fan climbs all the way back", () => {
    // The opposite bug is a fan stranded down forever. Once the house is
    // genuinely, durably small the flicker charge is small change against 3A of
    // room, and the bounded sweet-spot climb walks the gear back to original.
    const s = saturated();
    const { before } = trimAFan(s);
    s.advance(5 * 60);
    const trimmed = ROOMS.filter((id) => s.sim(id).fan < before[id]);
    expect(trimmed.length).toBeGreaterThanOrEqual(1);
    s.setNonAc(HOUSE_HEATER_OFF);
    const t1 = s.now;
    s.advance(8 * 60);
    expect(s.commandsSince(t1, "set_fan").length).toBeGreaterThanOrEqual(1);
    for (const id of trimmed) expect(s.sim(id).fan).toBe(before[id]);
  });

  it("FAST PATH: with the house genuinely small the whole swing comes back inside two minutes", () => {
    // The user, same afternoon: "there is enough budget but the fan speed is
    // taking too long … the fan speed is barely taking cost, so putting all at
    // speed 1 is only just a last emergency action". The RECOVERY test above
    // proves the fan comes home; this one prices how LONG that may take when
    // the budget covers the entire remaining swing with an amp to spare — one
    // batch, not the ~5 minutes of stacked time gates the bounded climb owes.
    // The ACCEPTANCE case is the proof this cannot resurrect the bounce: there
    // `spendable` never reaches swing + margin, so the fast path is unreachable
    // by arithmetic rather than by a gate.
    const s = saturated();
    const { at, before } = trimAFan(s);
    const cuts = s.commandsSince(at, "set_fan");
    expect(cuts.length).toBeGreaterThanOrEqual(1);
    const lastCut = cuts[cuts.length - 1].at;
    const trimmed = ROOMS.filter((id) => s.sim(id).fan < before[id]);
    expect(trimmed.length).toBeGreaterThanOrEqual(1);
    // The heater goes off for good — a real, durable room, not a dip. ~11.2A
    // against the 14.8A ceiling, so the 0.4A that is owed back is small change
    // even after the 0.9A flicker charge.
    s.setNonAc(HOUSE_HEATER_OFF);
    // 100s: short of the 120s the after-cut gate alone owes on the thin path
    // (live here it restored at exactly +120s), long enough for the 60s calm
    // gate the fast path still pays in full.
    while (s.now < lastCut + 100_000) s.advance(10);
    for (const id of trimmed) {
      expect(s.sim(id).fan, `${id} still short at +${(s.now - lastCut) / 1000}s`).toBe(before[id]);
    }
  });
});

// ---------------------------------------------------------------------------
// 2026-08-06 14:00-14:04Z, the user's question: "why did it turn off both Najat
// and Abdullah, when Najat-only-off was fine?"
//
// The same saturated generator afternoon, two hours after the fan bounce and on
// the same flickering line. Every level was at its floor and the fans were
// already trimmed, so the ladder's only remaining rung was a room:
//
//   14:00:32  mild overload -> Najat shed (coolest). Meter fell to 11.6A. This
//             state was STABLE - the end state proved Najat-only-off was enough.
//   14:01:06  34s later the restore path bought her straight back: committed
//             max(smoothed 11.63, cutAnchor 14.42 - cut 2.3) = 12.12, probe cost
//             2.3 -> 14.42A against a 14.9A ceiling. Admitted with 0.48A to
//             spare, on a line flickering +/-0.4-0.8A.
//   14:02:15  Abdullah's held fan restored to auto (+~0.6A).
//   14:03:20  Najat's own held fan restored to auto 134s into HER OWN ramp
//             (+~0.5A) - the hold whose doc comment already claimed to pin the
//             fan "while the compressor is still ramping".
//   14:04:10  smoothed 15.3 -> Najat re-shed (invariant 43, undo the turn-on).
//   14:04:24  still 15.5 and RISING - her own cut had not crossed the 8-wide
//             median, the commanded-cut credit was revoked by the rising meter
//             (invariant 38, correctly), and there was no sub-floor rung in that
//             heat (invariant 51) -> ABDULLAH shed too.
//
// Abdullah's off/on cycle was pure loss, and a single off/on cycle costs a room
// several degrees. A restore that cannot survive is strictly worse than a
// restore that waits, so the restore admission now charges the MEASURED flicker
// as margin - a quiet line charges nothing and stays exactly as aggressive.
// ---------------------------------------------------------------------------
describe("2026-08-06 double shed: a restore may not buy back the trough its own shed dug", () => {
  const HOUSE_HEATER = 5.4; // the ~5A heater of that afternoon
  const HOUSE_HEATER_OFF = 1.5; // it cycles off, and the room is real again

  /**
   * The house at 14:00: three rooms at L1 (their floor), fans already trimmed to
   * 1 by the earlier episode, and the heater on. 5.4 + 4.1 + 2.2 + 3.5 = 15.2A
   * against a 14.9A limit — an overload the level and fan rungs cannot touch.
   *
   * Two modelling notes, both live evidence rather than convenience:
   *
   *  - Najat's L1 cap is 3.5A here against her 2.7A gen model. That gap IS the
   *    incident (and invariant 3's own: "three fan-pinned restores of Najat
   *    admitted at her steady 2.3A each ramped the meter +3.5-3.8A"). Without
   *    it a restore priced at the model would settle exactly where admission
   *    said, and no bounce is possible in either direction.
   *  - Every room is at target (`needDelta` inside `nearTargetBandC`), so
   *    `ceilOf` caps them at L1 and nobody competes for a level. The restore is
   *    then the only spender in the house, which is what makes this regression
   *    about the restore admission and nothing else.
   */
  const saturated = (): Scenario =>
    new Scenario(
      cfg,
      [
        { ...ABDULLAH, level: 1, demandAmps: 3.5, needDelta: 0.4, roomTempC: 29.0, fan: 1 },
        { ...ABDU, level: 1, demandAmps: 6.0, needDelta: 0.4, roomTempC: 28.0, fan: 1 },
        {
          ...NAJAT,
          level: 1,
          capAmps: [3.5, 3.9, 5.3],
          demandAmps: 3.5,
          needDelta: 0.4,
          roomTempC: 26.5,
          fan: 1,
          rampSeconds: 120,
        },
      ],
      { nonAcAmps: HOUSE_HEATER, source: "gen", seed: 20260806 },
    );

  /** The live line: mostly quiet, with a periodic reading a full amp high. */
  const flickering = (s: Scenario): void =>
    s.setFlicker({ baseAmps: 0.15, spikeAmps: 0.9, spikeEveryN: 4 });

  /** Run until the ladder reaches its last rung and switches a room off. */
  const shedOne = (s: Scenario): { at: number; victim: string } => {
    flickering(s);
    const t0 = s.now;
    s.advance(6 * 60);
    const offs = s.commandsSince(t0, "power_off");
    expect(offs, JSON.stringify(offs.map((e) => e.cmd))).toHaveLength(1);
    return { at: offs[0].at, victim: offs[0].cmd.deviceId };
  };

  it("ACCEPTANCE: the shed room is not bought back into the flicker band, and no second room follows", () => {
    const s = saturated();
    const { at, victim } = shedOne(s);
    // The coolest room, as the user's own policy says (26.5°C vs 28.0 and 29.0).
    expect(victim).toBe("najat");

    // Fifteen minutes of exactly the house that produced the double shed.
    s.advance(15 * 60);
    const ons = s.commandsSince(at, "power_on");
    // …strictly AFTER the shed itself (`commandsSince` is inclusive).
    const offs = s.commandsSince(at + 1, "power_off");
    const churn = [...ons, ...offs]
      .sort((x, y) => x.at - y.at)
      .map((e) => `${(e.at - at) / 1000}s ${JSON.stringify(e.cmd)}`);
    // A restore is allowed — what is forbidden is one that cannot survive. If
    // the room came back, NOTHING may be switched off behind it.
    for (const on of ons) {
      expect(offs.filter((o) => o.at > on.at), churn.join("\n")).toEqual([]);
    }
    // …and the shape the user actually saw: two rooms off inside a minute.
    const allOffs = [{ at, cmd: { deviceId: victim } }, ...offs];
    const doubles = allOffs.filter((o, i) =>
      allOffs.some((p, j) => j > i && p.at - o.at < 60_000),
    );
    expect(doubles, churn.join("\n")).toEqual([]);
    // The end state the live house proved sufficient: one room off, two running.
    expect(s.acsOn()).toEqual(["abdu", "abdullah"]);
  });

  it("RECOVERY: the heater releases and the shed room comes back promptly", () => {
    // The opposite bug, and the user's primary complaint class: a room stranded
    // off. The charge is a margin against a MEASURED wobble, not a new gate —
    // once the house is genuinely small it is small change against 4A of room.
    const s = saturated();
    const { victim } = shedOne(s);
    // Still off six minutes on: the flicker charge holds while the house is
    // saturated. What follows is the other half of the bargain.
    expect(s.acsOn()).not.toContain(victim);
    s.setNonAc(HOUSE_HEATER_OFF);
    const t1 = s.now;
    s.advance(8 * 60);
    expect(s.commandsSince(t1, "power_on").map((e) => e.cmd.deviceId)).toEqual([victim]);
    expect(s.commandsSince(t1, "power_off")).toEqual([]);
    expect(s.acsOn()).toEqual(["abdu", "abdullah", "najat"]);
  });
});

describe("2026-08-06 14:38Z: decimals must not shed the top-priority room", () => {
  // Najat already shed from the earlier episode; Abdullah (priority #1) and Abdu
  // (priority #3) both at their L1 floor with their fans already trimmed, and a
  // heater holding the non-AC house near 10A. 2.2 + 4.1 + 9.8 = 16.1A on a 14.9A
  // gen — 1.2A over, with no level and no fan rung left on either room.
  //
  // Both rooms are hot to within a couple of tenths, and the thermometer-only
  // rule of 2026-08-04 answered that by shedding ABDULLAH, because Abdu ranked
  // 0.2°C higher and the comparator rounds shedNeed to a tenth. The user's rule
  // that afternoon: inside SHED_NEED_GAP_C the two are "equally hot" and the
  // priority list decides — the top-priority room survives.
  const HOUSE_WITH_HEATER = 9.8;
  const scene = (abdullahTempC: number, abduTempC: number): SimAcSetup[] => [
    {
      ...ABDULLAH,
      level: 1,
      fan: 1,
      demandAmps: 3.5,
      needDelta: abdullahTempC - cfg.comfortTargetC,
      roomTempC: abdullahTempC,
    },
    { ...NAJAT, level: 1, fan: 1, shed: true, demandAmps: 3.0, needDelta: 0.5, roomTempC: 26.5 },
    {
      ...ABDU,
      level: 1,
      fan: 1,
      demandAmps: 6.0,
      needDelta: abduTempC - cfg.comfortTargetC,
      roomTempC: abduTempC,
    },
  ];

  it("sheds Abdu, not Abdullah, when the two are a couple of tenths apart", () => {
    // 30.0 vs 30.2 — real needs 4.0 and 4.2, the live shape.
    const s = new Scenario(cfg, scene(30.0, 30.2), { nonAcAmps: HOUSE_WITH_HEATER, source: "gen" });
    const t0 = s.now;
    s.advance(200);
    const offs = s.commandsSince(t0, "power_off");
    expect(offs, JSON.stringify(offs.map((e) => e.cmd))).toHaveLength(1);
    expect(offs[0].cmd.deviceId).toBe("abdu");
    expect(s.acsOn()).toContain("abdullah");
    // …and the journal says WHY, or the next forensic pass has a mystery.
    const shedBatch = s.plans.find((p) => p.commands.some((c) => c.kind === "power_off"));
    expect(shedBatch?.decisions).toContainEqual(
      expect.objectContaining({
        deviceId: "abdu",
        action: "shed choice",
        detail: expect.stringContaining("priority decided"),
      }),
    );
  });

  it("…but a clearly cooler Abdullah still pays (2026-08-04 stands)", () => {
    // 30.0 vs 31.5 — 1.5°C apart, clear of the gap. The thermometer decides
    // absolutely, top priority included, exactly as it has since 2026-08-04.
    const s = new Scenario(cfg, scene(30.0, 31.5), { nonAcAmps: HOUSE_WITH_HEATER, source: "gen" });
    const t0 = s.now;
    s.advance(200);
    const offs = s.commandsSince(t0, "power_off");
    expect(offs, JSON.stringify(offs.map((e) => e.cmd))).toHaveLength(1);
    expect(offs[0].cmd.deviceId).toBe("abdullah");
    expect(s.acsOn()).toContain("abdu");
  });
});

describe("2026-08-06 15:48Z: the top room's turn-on exports to the cooler room", () => {
  // The third Abdullah cycle of that afternoon. He was switched on at 15:47:25
  // into a saturated house — the ~5A heater still running, both other rooms at
  // their L1 floor with their fans already trimmed to 1, and his own sub-floor
  // rung barred by the hard boost zone — and 82s later the smoothed meter sat
  // 0.28A over the 14.9A gen. Nothing was left on the ladder but a room off,
  // and the causer rule (invariant 43) named the room whose own click caused
  // it: Najat, 0.6°C cooler, sat inside SHED_NEED_GAP_C and kept running.
  //
  // The user's amendment that evening: for the TOP-PRIORITY room the export bar
  // is "strictly cooler", not a full degree. Najat pays instead — his own
  // stated trade, for the top room only.
  //
  // Every room's own need metric reads satisfied (`needDelta` inside
  // `nearTargetBandC`) so `ceilOf` caps them all at L1 and nobody competes for
  // a level: the only rung the reducer can reach is the shed, which is what the
  // live house had left. The thermometer still separates them — that split is
  // invariant 50's own, and `rankNeedDelta` is what shed choice reads.
  const HOUSE_WITH_HEATER = 6.7;
  const floored = (setup: SimAcSetup, roomTempC: number, on = true): SimAcSetup => ({
    ...setup,
    on,
    level: 1,
    fan: 1,
    needDelta: 0.4,
    roomTempC,
  });

  it("sheds Najat, not the top-priority room whose own turn-on caused it", () => {
    // 6.7 + 2.2 (Najat L1) + 4.1 (Abdu L1) = 13.0A, and Abdullah's own 2.2A
    // puts the house at 15.2A on a 14.9A gen — the live 0.3A overshoot.
    const s = new Scenario(
      cfg,
      [
        floored(ABDULLAH, 30.0, false), // priority #1, need 4.0 — the causer
        floored(NAJAT, 29.4), // 0.6°C cooler: inside the gap, strictly cooler
        floored(ABDU, 30.2), // hotter than the causer: never a target
      ],
      { nonAcAmps: HOUSE_WITH_HEATER, source: "gen" },
    );
    s.advance(120);
    const t0 = s.now;
    s.turnOn("abdullah", 1);
    s.advance(200);
    const offs = s.commandsSince(t0, "power_off");
    expect(offs, JSON.stringify(offs.map((e) => e.cmd))).toHaveLength(1);
    expect(offs[0].cmd.deviceId).toBe("najat");
    expect(s.acsOn()).toContain("abdullah");
  });

  it("…and any OTHER causer still undoes its own turn-on inside the gap (2026-08-03)", () => {
    // Same house, same arithmetic, but Najat (priority #2) is the newcomer and
    // Abdu is the room 0.6°C cooler than her. The amendment reaches the top
    // room only, so the full degree still stands here and Najat pays for her
    // own click.
    const s = new Scenario(
      cfg,
      [
        floored(ABDULLAH, 30.6), // hottest, and never the causer here
        floored(NAJAT, 30.0, false), // priority #2, need 4.0 — the causer
        floored(ABDU, 29.4), // 0.6°C cooler: inside the gap, and it holds
      ],
      { nonAcAmps: HOUSE_WITH_HEATER, source: "gen" },
    );
    s.advance(120);
    const t0 = s.now;
    s.turnOn("najat", 1);
    s.advance(200);
    const offs = s.commandsSince(t0, "power_off");
    expect(offs, JSON.stringify(offs.map((e) => e.cmd))).toHaveLength(1);
    expect(offs[0].cmd.deviceId).toBe("najat");
    expect(s.acsOn()).toContain("abdu");
  });
});

// ---------------------------------------------------------------------------
// 2026-08-07 14:08–14:31Z — the strain derate pulled the gen ceiling to
// 14.0–14.5A while the settled three-room house drew ~14.8–15.6A. Najat was shed
// FIVE times in 23 minutes: the restore path admitted her at the post-shed trough
// (~11A + her ~2.3A price fit under 14.5), her compressor ramped the house over,
// "its own turn-on caused this" shed her, and the trough re-formed. Each
// restore→re-shed gap was 52–69 s (inside the blame window), so `noteFailure`
// fired and `failures` climbed 1→4; each shed→restore gap was ~3–5.5 min, paced
// by the own-shed-trough bar's 300 s expiry ("own shed trough … judged at
// 12.4–12.6A, needs 2.3A vs 13.9–14.4A") plus the admission cadence.
//
// The backoff ladder never slowed the cycle because its early rungs (30/120/300 s
// for failures 1–3) are all ≤ the 300 s bar, so the BAR was the binding clock;
// the ladder only exceeds it at failures=4 (900 s), past the observed cycle. So
// the fix compounds the BINDING clock — the bar's persistence — past the ~5-min
// plateau (600 → 1200 → 1800 s), keyed on a consecutive-bounce COUNT, and a
// bouncing room is HELD rather than machine-gunned; the release valves (a rising
// ceiling, a peer leaving) let it out the instant the arithmetic changes.
//
// Staged with Najat's cap (3.5A) above her model (2.7A) — the same gap the
// 2026-08-06 double shed turns on — so her return is admitted at the model price
// and then overshoots at the cap, and the bar (pre-shed meter − model cut) sits
// ABOVE the settled two-room house, correctly disbelieving the trough. No flicker
// and no fan physics: the bounce is pure level/shed, meter-visible end to end.
// ---------------------------------------------------------------------------
describe("2026-08-07 bounce backoff: a bouncing restore is held, not machine-gunned", () => {
  const saturated = (): Scenario =>
    new Scenario(
      { ...cfg, genLimitAmps: 14.6 }, // restore ceiling 14.5 (own fresh config — mutated below)
      [
        { ...ABDU, level: 1, fan: 1, demandAmps: 4.1, needDelta: 0.4, roomTempC: 29.0 },
        { ...ABDULLAH, level: 1, fan: 1, demandAmps: 2.2, needDelta: 0.4, roomTempC: 28.0 },
        {
          ...NAJAT,
          level: 1,
          fan: 1,
          capAmps: [3.5, 3.9, 5.3], // draws 3.5A, priced at the 2.7A model
          demandAmps: 3.5,
          needDelta: 0.4,
          roomTempC: 26.5, // the coolest room — the shed target every round
          rampSeconds: 60,
        },
      ],
      { nonAcAmps: 5.1, source: "gen" }, // total ≈ 14.9 over 14.6 → shed Najat
    );

  /** Run to the FIRST bounce: the initial shed, the 300 s bar, the restore, and
   *  the re-shed that books bounce #1. Returns its timestamp. */
  const runToFirstBounce = (s: Scenario): number => {
    s.advance(12 * 60);
    const offs = s.commandsSince(s.now - 12 * 60_000, "power_off").filter((e) => e.cmd.deviceId === "najat");
    expect(offs.length, JSON.stringify(offs.map((e) => e.at))).toBeGreaterThanOrEqual(2);
    return offs[1].at; // [0] the initial shed, [1] the first bounce
  };

  it("ACCEPTANCE: after the first bounce the room stays OFF (≤2 commands / 25 min), then returns when the ceiling rises and STICKS", () => {
    const s = saturated();
    const firstBounceAt = runToFirstBounce(s);

    // 25 minutes of exactly the house that produced the five-shed machine-gun.
    s.advance(25 * 60);
    const churn = s
      .commandsSince(firstBounceAt + 1)
      .filter((e) => e.cmd.deviceId === "najat" && (e.cmd.kind === "power_on" || e.cmd.kind === "power_off"));
    // The whole point: the compounded wait bounds the cycle to at most ONE more
    // attempt — no second/third/fourth round. (v1 and the pre-fix v2 re-shed her
    // five times in this window.)
    expect(
      churn.length,
      churn.map((e) => `${((e.at - firstBounceAt) / 1000).toFixed(0)}s ${e.cmd.kind}`).join("\n"),
    ).toBeLessThanOrEqual(2);
    expect(s.acsOn()).toEqual(["abdu", "abdullah"]); // still off, held by the bar

    // The strain derate recovers — the ceiling rises. The bar self-releases
    // (12.2 + 2.7 = 14.9 ≤ 15.0) and she comes back and STICKS (two-room 11.4 +
    // her 3.5 = 14.9 ≤ the new limit).
    s.cfg.genLimitAmps = 15.1; // restore ceiling 15.0
    const t2 = s.now;
    s.advance(12 * 60);
    expect(s.acsOn()).toContain("najat");
    // …and no bounce this time — nothing switches off behind her.
    expect(
      s.commandsSince(t2 + 1, "power_off").filter((e) => e.cmd.deviceId === "najat"),
    ).toEqual([]);
    expect(s.totalAmps()).toBeLessThanOrEqual(15.05);
  });

  it("a peer leaving CREDITS the bounce bar — a house minus a room is not the house that bounced", () => {
    const s = saturated();
    runToFirstBounce(s);
    // Najat is in the bounce state now (bar active, bounces ≥ 1). Its value is
    // the pre-shed house less her own model cut.
    const before = s.effectiveShedBar("najat");
    expect(before).toBeGreaterThan(11.5);
    // A household member switches a PEER off. That removal shrinks the house the
    // bar describes, priced the way the meter credit prices it (~2.2A).
    s.turnOff("abdullah");
    const after = s.effectiveShedBar("najat");
    expect(after).toBeLessThan(before - 1.5); // ~2.2A of Abdullah credited off the bar
    expect(after).toBeGreaterThan(0);
  });
});
