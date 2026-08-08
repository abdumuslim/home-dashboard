// Direct tests for the decision pipeline. Most pipeline behaviour is pinned by
// scenarios.test.ts through the physics harness; these cover the emission-layer
// rules that a whole-house simulation makes awkward to isolate.

import { describe, it, expect } from "vitest";
import { plan, type PlanInput } from "./pipeline.js";
import { DEFAULT_LEVELING_CONFIG_V2, type LevelingConfigV2 } from "./config.js";
import { initialPacingState } from "./pacing.js";
import { updateCost } from "./costs.js";
import type { AcView, Command, MeterView } from "./types.js";

const T = 1_000_000;

const cfg: LevelingConfigV2 = {
  ...DEFAULT_LEVELING_CONFIG_V2,
  enabled: true,
  controller: "v2",
  genLimitAmps: 15,
  marginAmps: 0.1,
  fanTrimEnabled: true,
  ampModels: { a: { baseAmps: 2, stepAmps: 2 }, b: { baseAmps: 2, stepAmps: 2 } },
  genAmpModels: { a: { baseAmps: 2, stepAmps: 2 }, b: { baseAmps: 2, stepAmps: 2 } },
};

function ac(id: string, overrides: Partial<AcView> = {}): AcView {
  return {
    deviceId: id,
    name: id,
    on: true,
    managed: true,
    shed: false,
    maxLevel: 3,
    currentLevel: 2,
    fanSpeed: 1,
    fanExempt: false,
    needDelta: 1,
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
    envelopeLevel: overrides.envelopeLevel ?? overrides.currentLevel ?? 2,
    rankNeedDelta: overrides.rankNeedDelta ?? overrides.needDelta ?? 1,
  };
}

function meter(overrides: Partial<MeterView> = {}): MeterView {
  return {
    source: "gen",
    smoothedAmps: 12,
    latestAmps: 12,
    sampleCount: 4,
    calmMs: 0,
    smoothedOverMs: 0,
    overLimitBudget: 5,
    overLimitReadings: [],
    collapsed: false,
    frozen: false,
    flickerAmps: 0,
    flickerMarginAmps: 0,
    derateAmps: 0,
    commandedCutCreditAmps: 0,
    commandedCutAnchorAmps: 0,
    commandedCutTotalAmps: 0,
    commandedCutAgeMs: 0,
    ...overrides,
  };
}

/** Bucket empty with these over-limit readings → assessPressure returns "over". */
function overMeter(readings: number[], smoothedAmps = 12): MeterView {
  return meter({ smoothedAmps, overLimitBudget: 0, overLimitReadings: readings });
}

function run(acs: AcView[], m: MeterView, overrides: Partial<PlanInput> = {}) {
  return plan({
    now: T,
    config: cfg,
    mode: "NORMAL",
    meter: m,
    acs,
    book: {},
    pacing: initialPacingState("gen"),
    fanHolds: {},
    ...overrides,
  });
}

const levelsFor = (commands: Command[], deviceId: string) =>
  commands.filter((c): c is Extract<Command, { kind: "set_level" }> => c.kind === "set_level" && c.deviceId === deviceId);

describe("batch command dedupe (live journal row 2701, 2026-07-25 05:33)", () => {
  it("a level-0 AC in an over-limit batch gets ONE set_level, not one per producer", () => {
    // Both the never-level-0 correction and the reducer's re-entry target this
    // AC; the live batch shipped `set_level 3` twice for the same device.
    const out = run([ac("a", { currentLevel: 0 })], overMeter([15.5]));
    expect(out.reason).toBe("over_mild");
    expect(levelsFor(out.commands, "a")).toHaveLength(1);
  });

  it("dedupe keeps the LAST command, so the reducer wins over a correction", () => {
    const out = run([ac("a", { currentLevel: 0, reachableCap: 2 })], overMeter([15.5]));
    const levels = levelsFor(out.commands, "a");
    expect(levels).toHaveLength(1);
    expect(levels[0].level).toBe(2);
  });

  it("a single-actuator batch stays single-actuator (cost grading depends on it)", () => {
    const out = run([ac("a", { currentLevel: 0 })], overMeter([15.5]));
    expect(out.commands.filter((c) => c.kind !== "set_fan")).toHaveLength(1);
  });
});

describe("escalation settle (2026-08-02 trim → double shed in 7 seconds)", () => {
  const pinned = (): AcView[] => [
    ac("a", { currentLevel: 1, fanSpeed: 1, needDelta: 2 }),
    ac("b", { currentLevel: 1, fanSpeed: 1, needDelta: 0.3 }),
  ];

  it("holds the shed while a commanded cut is still landing", () => {
    // Live 16:55:29 a fan trim shipped; 16:55:34 and :35 two rooms went off for
    // the ~0.5A that trim had already covered.
    const out = run(pinned(), overMeter([15.3], 15.2), {
      mode: "SETTLING",
      meter: { ...overMeter([15.3], 15.2), commandedCutCreditAmps: 0.6 },
    });
    expect(out.severity).toBe("mild");
    expect(out.commands.filter((c) => c.kind === "power_off")).toHaveLength(0);
    expect(out.decisions.some((d) => d.blockedBy === "escalation settle")).toBe(true);
  });

  it("does NOT hold a severe breach", () => {
    // Re-staged 2026-08-07: the lone-spike median guard (OVER_MEDIAN_MIN_READINGS,
    // pressure.ts) now correctly refuses to size a shed from a single 16.5A raw
    // reading over a mean that is barely over (smoothed 15.2 sized required
    // below the shed threshold). Stage the breach honestly on the MEAN so the
    // test still exercises what it names — a severe reading with an
    // uninformative credit does not hold. Smoothed 16.5 lands required at
    // exactly the 1.0A the old fixture produced.
    const out = run(pinned(), overMeter([16.5], 16.5), {
      mode: "SETTLING",
      meter: { ...overMeter([16.5], 16.5), commandedCutCreditAmps: 0.6 },
    });
    expect(out.severity).toBe("severe");
    expect(out.commands.filter((c) => c.kind === "power_off")).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // R12b — the other face of "a credit that is not arriving is not protection".
  // Live 2026-08-04, journal rows 7569/7570, thirteen seconds apart:
  //
  //   12:56:26  over_severe  pre 16.565 → fan trim + shed Najat, 2.9A commanded
  //   12:56:39  over_severe  pre 14.240 → shed Abdu as well
  //
  // At the second row the meter was 2.3A BELOW that cut's own anchor and still
  // falling — the cut was working, visibly. What shed the second room was a
  // severity of `severe` carried by a banked 16.6A reading (sensing drops
  // banked readings only once the mean clears limit − margin, and 14.24 against
  // 13.9 just misses), and the escalation hold covered MILD only.
  // -------------------------------------------------------------------------
  describe("…and holds a SEVERE one too while the cut is visibly landing (2026-08-04 12:56)", () => {
    const live = (over: Partial<MeterView> = {}): MeterView => ({
      ...overMeter([16.0, 15.9], 14.24),
      derateAmps: 1.0, // the live effective limit was 14.0 on a 15A gen
      flickerAmps: 0.4,
      commandedCutCreditAmps: 0.575,
      commandedCutAnchorAmps: 16.565,
      commandedCutTotalAmps: 2.9,
      commandedCutAgeMs: 13_000,
      ...over,
    });

    it("does not shed a second room 13 seconds after the first", () => {
      const out = run(pinned(), live(), { mode: "SETTLING" });
      expect(out.severity).toBe("severe");
      expect(out.commands.filter((c) => c.kind === "power_off")).toHaveLength(0);
      expect(out.decisions.some((d) => d.blockedBy === "escalation settle")).toBe(true);
    });

    it("and sheds the moment that same cut stops arriving", () => {
      // Identical severity and credit; the meter has come down 0.4A of the 2.9
      // in 91 seconds. That is not lateness, it is a bet — and this is the
      // 12:39:57 shape, which must never be held.
      const stalled = live({ smoothedAmps: 16.165, commandedCutAgeMs: 91_000 });
      const out = run(pinned(), stalled, { mode: "SETTLING" });
      expect(out.commands.filter((c) => c.kind === "power_off")).toHaveLength(1);
    });

    it("an arriving cut never holds the EXTREME rung — it is the last one", () => {
      const extreme = live({ smoothedOverMs: 200_000 });
      const out = run(pinned(), extreme, { mode: "SETTLING" });
      expect(out.severity).toBe("extreme");
      expect(out.commands.filter((c) => c.kind === "power_off")).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // The third face of "a credit is not the whole gate" (2026-08-06). The outrun
  // void (invariant 38) zeroes `commandedCutCreditAmps` the INSTANT the smoothed
  // meter rises past the cut's send-time anchor — with no minimum age. A second
  // compressor ramping independently at the moment of a shed (a restore, or a
  // power-blink restart) does exactly that within a reading or two, so BOTH
  // holds — each gated on `credit > 0` — fell and a second room was shed
  // 2.5–5.5s after the first, four times in 24h (#8929→#8930, #9180→#9181,
  // #9213→#9214, #9369→#9370). That is physically impossible as a real breach:
  // the first shed's off cannot have reached the 8-wide smoothed median yet
  // (median lag alone is ~12–20s; a compressor wind-down is minutes). The holds
  // now also fire while the cut is `settling` (younger than the landing grace,
  // fall still short), whether or not the void has zeroed the credit.
  // -------------------------------------------------------------------------
  describe("…and holds when the outrun void has already zeroed the credit (2026-08-06)", () => {
    // The peer's ramp has already lifted the smoothed meter ABOVE the cut's
    // anchor, so sensing's outrun void has returned 0 credit — but the cut is
    // only seconds old. `overMeter` supplies the bucket_empty evidence; the
    // commandedCut fields are the post-revocation view the shell publishes.
    const outrun = (readings: number[], smoothed: number, over: Partial<MeterView> = {}): MeterView => ({
      ...overMeter(readings, smoothed),
      commandedCutCreditAmps: 0, // revoked: smoothed sits above the anchor
      commandedCutTotalAmps: 4.0, // a ~4A shed sent seconds ago
      commandedCutAnchorAmps: smoothed - 1.0, // the meter when that cut began; the peer lifted it ~1A
      commandedCutAgeMs: 4_000, // seconds — well under CREDIT_LANDING_GRACE_MS (60s)
      ...over,
    });

    it("a peer ramping past the anchor does not fell the escalation hold seconds after a shed (#9180→#9181)", () => {
      const m = outrun([15.4], 15.4);
      // Precondition: the void has zeroed the credit AND the meter sits above the
      // anchor — the exact state where both `credit > 0` holds used to fall.
      expect(m.commandedCutCreditAmps).toBe(0);
      expect(m.smoothedAmps).toBeGreaterThan(m.commandedCutAnchorAmps);
      const out = run(pinned(), m, { mode: "SETTLING" });
      expect(out.severity).toBe("mild");
      expect(out.commands.filter((c) => c.kind === "power_off")).toHaveLength(0);
      expect(out.decisions.some((d) => d.blockedBy === "escalation settle")).toBe(true);
    });

    it("holds a SEVERE breach the same way while the cut is young (#8929→#8930 shape)", () => {
      const m = outrun([16.5], 16.0);
      expect(m.commandedCutCreditAmps).toBe(0);
      const out = run(pinned(), m, { mode: "SETTLING" });
      expect(out.severity).toBe("severe");
      expect(out.commands.filter((c) => c.kind === "power_off")).toHaveLength(0);
      expect(out.decisions.some((d) => d.blockedBy === "escalation settle")).toBe(true);
    });

    it("…and sheds once that cut ages past the grace without landing (trend stalled)", () => {
      // Same outrun geometry, but the cut is now older than CREDIT_LANDING_GRACE_MS
      // with its fall still short → `cutTrendOf` reports "stalled". No permanent
      // freeze was introduced: the ladder acts the moment settling ends.
      const m = outrun([16.5], 16.0, { commandedCutAgeMs: 91_000 });
      const out = run(pinned(), m, { mode: "SETTLING" });
      expect(out.severity).toBe("severe");
      expect(out.commands.filter((c) => c.kind === "power_off")).toHaveLength(1);
    });

    it("never holds the EXTREME rung, even fresh in the settling window", () => {
      // The last rung before the breaker. Two full minutes of mean-over-limit
      // makes this `extreme` even with a small deficit and the credit voided;
      // settling must not hold it — the emergency escape stays open, and it
      // sheds exactly ONE room (invariant 26's one-shed ceiling is unchanged).
      const m = outrun([16.5], 16.0, { smoothedOverMs: 200_000 });
      const out = run(pinned(), m, { mode: "SETTLING" });
      expect(out.severity).toBe("extreme");
      expect(out.commands.filter((c) => c.kind === "power_off")).toHaveLength(1);
    });
  });

  it("a fan trim is credited what the planner claimed, not zero", () => {
    // The credit is what shrinks the next evaluation's demand; at zero the
    // reducer re-demanded amps that were already leaving.
    const out = run([ac("a", { currentLevel: 1, fanSpeed: 5, needDelta: 2 })], overMeter([15.2], 15.1));
    expect(out.commands.some((c) => c.kind === "set_fan" && c.reason === "trim")).toBe(true);
    expect(out.commandedCutAmps).toBeGreaterThan(0);
  });
});

describe("turn-on inrush blanking (2026-07-25 restore-bounce storm)", () => {
  // Both rooms pinned at their floor with no fan slack → a shed is the only
  // cover the reducer can find, exactly like the live 20:23 state.
  const pinned = (ramping: boolean): AcView[] => [
    ac("a", { currentLevel: 1, fanSpeed: 1, needDelta: 2 }),
    ac("b", { currentLevel: 1, fanSpeed: 1, needDelta: 0.3, ramping }),
  ];

  it("no shed while a compressor ramps and the smoothed meter is under the limit", () => {
    const out = run(pinned(true), overMeter([15.9], 12));
    expect(out.severity).toBe("mild");
    expect(out.commands.filter((c) => c.kind === "power_off")).toHaveLength(0);
    expect(out.decisions.some((d) => d.blockedBy === "turn-on inrush")).toBe(true);
  });

  it("the same overshoot DOES shed when nothing is ramping", () => {
    const out = run(pinned(false), overMeter([15.9], 12));
    expect(out.commands.filter((c) => c.kind === "power_off")).toHaveLength(1);
  });

  it("the same overshoot DOES shed once the smoothed meter clears the blanking band", () => {
    const out = run(pinned(true), overMeter([15.9], 15.6));
    expect(out.commands.filter((c) => c.kind === "power_off")).toHaveLength(1);
  });

  it("blanking ends the moment the MEAN crosses the limit — it is not widened by a slack band", () => {
    // This assertion is inverted from the day it shipped, deliberately and with
    // the user's sign-off (2026-08-03). The blanking band carried one moderate
    // rung of slack (limit + 0.5) so a turn-on would not be shed for smoothed
    // crossings of 0.02–0.31A. What that bought instead was the 17:40 break: a
    // room came on at L3 onto a 12.5A gen, the mean rode 15.0–15.5A for two
    // minutes — inside the slack the whole time — and the only actuator with
    // instant physics, undoing that very turn-on, stayed blocked while level
    // cuts wound down too slowly to matter.
    //
    // Noise-driven crossings are now stopped upstream, where they cost no
    // reaction time: the flicker-aware bucket and calm (invariant 24) keep them
    // out of this branch entirely, and the escalation settle holds the shed rung
    // while a cut we already sent is still landing.
    const out = run(pinned(true), overMeter([15.9], 15.3));
    expect(out.commands.filter((c) => c.kind === "power_off")).toHaveLength(1);
    expect(out.decisions.some((d) => d.blockedBy === "turn-on inrush")).toBe(false);
  });

  it("plans NOTHING new while what we already commanded covers the whole deficit", () => {
    // 2026-08-03 00:41Z: three reducing batches in 13 seconds, 12.9A commanded
    // off for a 0.4A deficit. Each pass re-planned from the level it had just
    // sent (SETTLING substitutes the pending level) while none of it had
    // reached the meter. The shed rung was already held here; the level and
    // fan rungs were not, and they are what escalated.
    // A room with a level still to give, so the difference between the two
    // halves is the settle hold alone — not the shed rung, which the older
    // escalation hold already covers.
    const cuttable = [ac("a", { currentLevel: 3, fanSpeed: 5, needDelta: 2 })];
    const base = overMeter([15.9], 15.2);
    const held = run(
      cuttable,
      { ...base, commandedCutCreditAmps: 2.0, commandedCutTotalAmps: 4.0 },
      { mode: "SETTLING" },
    );
    expect(held.commands.filter((c) => c.kind === "set_level" || c.kind === "set_fan")).toHaveLength(0);
    expect(held.decisions.some((d) => d.blockedBy === "escalation settle")).toBe(true);
    // …and it is not a gag: a deficit BIGGER than what is in flight still acts.
    const acted = run(
      cuttable,
      { ...base, commandedCutCreditAmps: 0.1, commandedCutTotalAmps: 0.1 },
      { mode: "SETTLING" },
    );
    expect(acted.commands.filter((c) => c.kind === "set_level")).toHaveLength(1);
  });

  it("…but a mean still UNDER the limit keeps the ramping room safe", () => {
    // The 2026-07-25 guard itself is untouched: while the mean has headroom, a
    // transient that is about to decay on its own may cut levels and trim fans,
    // never lose a whole room.
    const out = run(pinned(true), overMeter([15.9], 14.9));
    expect(out.commands.filter((c) => c.kind === "power_off")).toHaveLength(0);
    expect(out.decisions.some((d) => d.blockedBy === "turn-on inrush")).toBe(true);
  });

  it("a severe RAW reading mid-ramp with the mean UNDER the limit is now capped to mild (F3, 2026-08-08)", () => {
    // Inverted from the day it shipped, deliberately: until 2026-08-08 a raw
    // reading over the severe bar shed immediately even mid-ramp with the mean
    // far under the limit — the exact shape of journal 10375, where our own
    // restore's ~10s locked-rotor transient spanned consecutive samples and shed
    // a room restored 82s earlier. A compressor start does not revert, so it
    // mints no flicker to discount it, and the streak sizing never consults the
    // mean. While a room is ramping and the SMOOTHED meter is under the limit,
    // that raw-only evidence may no longer classify past mild or shed; the
    // sustained clock is the escape once the MEAN actually crosses (below).
    const out = run(pinned(true), overMeter([16.5], 12));
    expect(out.severity).toBe("mild");
    expect(out.commands.filter((c) => c.kind === "power_off")).toHaveLength(0);
    expect(out.decisions.some((d) => d.blockedBy === "turn-on inrush")).toBe(true);
  });

  it("when a shed IS taken, the lone ramping room is the one undone", () => {
    // `a` is the bystander and would otherwise be a candidate; `b`'s own
    // turn-on caused this, so `b` pays. Staged on the MEAN over the limit (15.6)
    // so a shed is genuinely taken — a mean-under-limit severe raw is now capped
    // (F3), and the preferShed logic only runs when the reducer must actually cut.
    const out = run(pinned(true), overMeter([16.5], 15.6));
    const offs = out.commands.filter((c) => c.kind === "power_off");
    expect(offs.map((c) => c.deviceId)).toEqual(["b"]);
    expect(out.decisions.some((d) => d.action === "shed preference" && d.deviceId === "b")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// F3 — our own restore's compressor-start inrush classifies and sizes a SEVERE
// episode while the smoothed mean is under the limit (2026-08-08, journal 10375,
// 14:45:16Z). power_on sent 82s earlier; a ~10s locked-rotor transient spanned
// TWO consecutive raw samples ≥16.2A on a 15A gen while the smoothed mean sat
// 13.7A — 1.3A UNDER the limit. Flicker read 0 (a compressor start does not
// revert, so it mints nothing), so the severe bar sat at its floor: the two raws
// classified severe AND the streak sized a 1.3A deficit that shed a room
// restored 82s earlier. While a room is inside its ramp AND the mean is under the
// limit, raw-banked evidence may neither classify nor size past mild.
// ---------------------------------------------------------------------------
describe("attributable inrush cap (2026-08-08 journal 10375)", () => {
  const pinned = (ramping: boolean): AcView[] => [
    ac("a", { currentLevel: 1, fanSpeed: 1, needDelta: 2 }),
    ac("b", { currentLevel: 1, fanSpeed: 1, needDelta: 0.3, ramping }),
  ];

  it("does not shed for two consecutive inrush raws while the mean is under the limit", () => {
    const out = run(pinned(true), overMeter([16.2, 16.4], 13.7));
    expect(out.severity).toBe("mild");
    expect(out.commands.filter((c) => c.kind === "power_off")).toHaveLength(0);
    expect(out.decisions.some((d) => d.blockedBy === "turn-on inrush")).toBe(true);
    // The streak sizing stands down to the honest smoothed floor: max(0.1, 13.7−15) + 0.1.
    expect(out.requiredAmps).toBeCloseTo(0.2);
  });

  it("the SAME raws with NO room ramping shed with the streak sizing (the branch survives)", () => {
    const out = run(pinned(false), overMeter([16.2, 16.4], 13.7));
    expect(out.severity).toBe("severe");
    expect(out.commands.filter((c) => c.kind === "power_off")).toHaveLength(1);
    // min(16.2, 16.4) − 15 + 0.1 — a genuine fast overload is still sized undiscounted.
    expect(out.requiredAmps).toBeCloseTo(1.3);
  });

  it("a real overload mid-ramp (mean ABOVE the limit) still sheds — the guard is guarded", () => {
    // The flag is only set with the mean at/under the limit, so a genuine
    // overload during a ramp is never blanked (invariant 33's history: the +0.5A
    // slack that once blocked the one instant actuator was reverted).
    const out = run(pinned(true), overMeter([16.2, 16.4], 15.4));
    expect(out.severity).toBe("severe");
    expect(out.commands.filter((c) => c.kind === "power_off")).toHaveLength(1);
  });
});

// The ramp debit is computed here (gen only) and fences every spender in the
// calm branch — including the fan restore, which has no cost model of its own.
describe("ramp debit fencing (2026-07-26 gen trip #1)", () => {
  const held = { a: { deviceId: "a", originalFan: 0, lastSetFan: 1, heldAt: T - 600_000 } };

  it("a held fan does not climb back into a ramping compressor's committed amps", () => {
    // b came on 10s ago at L1 (model draw 2A) with the meter still at its
    // pre-start 13.0A → 2A committed, 1.6A of resting headroom. Live: Najat's
    // fan went 1→7 and Abdu's →auto 12s apart, both mid-ramp, and the house
    // crossed the breaker 65s later.
    const acs = [
      ac("a", { currentLevel: 1, fanSpeed: 1, needDelta: 0 }),
      ac("b", { currentLevel: 1, needDelta: 0, ramping: true, rampBaselineAmps: 13.0 }),
    ];
    const blocked = run(acs, meter({ smoothedAmps: 13.0, calmMs: 300_000 }), { fanHolds: held });
    expect(blocked.commands).toEqual([]);

    // Once the meter has absorbed b's draw the same step is allowed.
    const absorbed = run(
      [acs[0], ac("b", { currentLevel: 1, needDelta: 0, ramping: true, rampBaselineAmps: 11.0 })],
      meter({ smoothedAmps: 13.0, calmMs: 300_000 }),
      { fanHolds: held },
    );
    expect(absorbed.reason).toBe("fan_restore");
    expect(absorbed.commands).toEqual([{ deviceId: "a", kind: "set_fan", fan: 0, reason: "trim_restore" }]);
  });

  it("grid is deliberately not ramp-debited (it starts every AC full by directive)", () => {
    const gridCfg = { ...cfg, gridLimitAmps: 27 };
    const out = run(
      [
        ac("a", { currentLevel: 1, fanSpeed: 1, needDelta: 0 }),
        ac("b", { currentLevel: 1, needDelta: 0, ramping: true, rampBaselineAmps: 13.0 }),
      ],
      meter({ source: "grid", smoothedAmps: 13.0, calmMs: 300_000 }),
      { fanHolds: held, config: gridCfg },
    );
    expect(out.commands).toEqual([{ deviceId: "a", kind: "set_fan", fan: 0, reason: "trim_restore" }]);
  });

  it("the derate lowers every ceiling the pipeline works against", () => {
    // 14.2A is calm under the 15A rating but over-limit against a 1A derate.
    const acs = [ac("a", { currentLevel: 2 }), ac("b", { currentLevel: 2 })];
    const calm = run(acs, meter({ smoothedAmps: 14.2, calmMs: 300_000 }));
    expect(calm.reason).not.toMatch(/^over/);
    const derated = run(
      acs,
      meter({ smoothedAmps: 14.2, calmMs: 300_000, derateAmps: 1, overLimitBudget: 0, overLimitReadings: [14.2, 14.3] }),
    );
    expect(derated.reason).toMatch(/^over/);
  });
});

describe("commandedCutAmps — the single collapse-credit source", () => {
  it("an over-limit batch reports its cuts at MODEL price, not the learned jump", () => {
    // a: base 2 step 2 → L3 6.0, L2 4.0. One step down = 2.0A of model.
    // The learned book says the 2>3 jump was 5.5A; crediting THAT would let a
    // real cliff hide behind our own cut.
    const book = updateCost({}, "a", "gen", "level:2>3", 5.5, T);
    const out = run([ac("a", { currentLevel: 3, needDelta: 2 })], overMeter([15.5]), { book });
    expect(levelsFor(out.commands, "a")).toEqual([{ deviceId: "a", kind: "set_level", level: 2 }]);
    expect(out.commandedCutAmps).toBeCloseTo(2.0, 5);
  });

  it("a shed is credited its whole modeled draw", () => {
    const out = run([ac("a", { currentLevel: 3, needDelta: 0 }), ac("b", { currentLevel: 1, needDelta: 4 })], overMeter([19, 19.5]));
    expect(out.commands.some((c) => c.kind === "power_off" && c.deviceId === "a")).toBe(true);
    expect(out.commandedCutAmps).toBeGreaterThanOrEqual(6.0);
  });

  it("a pure raise batch credits nothing (an up-move can never claim a cut)", () => {
    const out = run([ac("a", { currentLevel: 1, needDelta: 3 })], meter({ smoothedAmps: 4, calmMs: 300_000 }));
    expect(out.commands).toEqual([{ deviceId: "a", kind: "set_level", level: 2 }]);
    expect(out.commandedCutAmps).toBe(0);
  });

  it("a restore that pulls a peer to floors credits the peer's cut (was invisible before)", () => {
    // b is shed and can only return if a comes down; that batch reports a NET
    // delta of 0, so the old `expectedDeltaAmps < 0` credit never fired for it.
    const out = run(
      [ac("a", { currentLevel: 3, needDelta: 0.2 }), ac("b", { on: false, shed: true, currentLevel: 1, needDelta: 5 })],
      // 13.5 + b's 2.0 turn-on = 15.5 > the restore ceiling, so the restore is
      // only feasible if a comes down to its floor first.
      meter({ smoothedAmps: 13.5, calmMs: 300_000 }),
    );
    const cut = out.commands.find((c) => c.kind === "set_level" && c.deviceId === "a");
    const restore = out.commands.find((c) => c.kind === "power_on" && c.deviceId === "b");
    expect(cut).toBeDefined();
    expect(restore).toBeDefined();
    expect(out.expectedDeltaAmps).toBe(0); // net-zero on paper — the old blind spot
    expect(out.commandedCutAmps).toBeGreaterThan(0);
  });
});

describe("idle demote precedence in the calm branch", () => {
  const satisfied = (id: string, o: Partial<AcView> = {}) =>
    ac(id, { currentLevel: 3, needDelta: 0.2, satisfiedForMs: 300_000, fanSpeed: 1, ...o });

  it("reclaims a satisfied room's dormant levels when there is nothing to raise", () => {
    const out = run([satisfied("a")], meter({ smoothedAmps: 6, calmMs: 300_000 }));
    expect(out.reason).toBe("demote");
    expect(out.commands).toEqual([{ deviceId: "a", kind: "set_level", level: 1 }]);
    expect(out.commandedCutAmps).toBeGreaterThan(0);
  });

  it("a raise wins the batch — funding demotes ride with it, not against it", () => {
    const out = run(
      [satisfied("a"), ac("b", { currentLevel: 1, needDelta: 3 })],
      meter({ smoothedAmps: 6, calmMs: 300_000 }),
    );
    expect(out.reason).toBe("raise");
    expect(out.commands.some((c) => c.kind === "set_level" && c.deviceId === "b" && c.level === 2)).toBe(true);
  });

  it("PARKS under a restore reservation — a demote batch would rewind the shared calm clock", () => {
    // b is shed and its restore is gated by calm, so it reserves amps. Even
    // though demoting a would FREE amps, churning here re-arms the calm gate
    // the parked restore is counting down.
    const out = run(
      [satisfied("a"), ac("b", { on: false, shed: true, currentLevel: 1, needDelta: 5 })],
      meter({ smoothedAmps: 13.5, calmMs: 1_000 }),
    );
    expect(out.decisions.some((d) => d.blockedBy === "restore reservation")).toBe(true);
    expect(out.commands.filter((c) => c.kind === "set_level" && c.deviceId === "a")).toHaveLength(0);
    expect(out.reason).not.toBe("demote");
  });

  it("outranks a fan restore (dormant compressor levels are the cheaper amps)", () => {
    const held = { a: { deviceId: "a", originalFan: 0, lastSetFan: 1, heldAt: T - 600_000 } };
    const m = meter({ smoothedAmps: 6, calmMs: 600_000 });
    // Control: with nothing to demote, that same hold DOES produce a fan step —
    // so the assertion below is a real ordering, not an absent alternative.
    const fanOnly = run([ac("a", { currentLevel: 1, fanSpeed: 1, needDelta: 0 })], m, { fanHolds: held });
    expect(fanOnly.reason).toBe("fan_restore");
    // …and the step carries planFanRestore's own words into the journal. On a
    // 6A meter the whole swing fits with amps to spare, so this one took the
    // fast path — and "the fan came all the way back in one batch" is told
    // apart from "the fan bounced" ONLY by the budget printed beside it.
    expect(fanOnly.decisions.some((d) => d.action.includes("fast"))).toBe(true);

    const out = run([satisfied("a")], m, { fanHolds: held });
    expect(out.reason).toBe("demote");
  });
});

// The clamp lives in invariantCorrections, so it must reach the batch from
// every non-COLLAPSED branch — which is the whole point of putting it there.
// A gen turn-on is over-limit by definition on a 15A line, so the branch that
// matters most is the reducer's (live 2026-07-30 05:51: the only batches that
// ran for the next two minutes were `over_mild` and `over_severe`).
describe("gen start clamp reaches the batch (2026-07-30)", () => {
  const starting = (overrides: Partial<AcView> = {}) =>
    ac("a", { currentLevel: 3, startBaselineAmps: 13.2, ...overrides });

  it("ships inside an over-limit batch, and converges on the floor after it", () => {
    // The documented precedence stands: one command per device, and the
    // REDUCER's choice is the one that lands (dedupe keeps the last writer).
    // A shallower reducer cut is not a lost clamp — the window stays open, so
    // the very next non-over tick finishes the job.
    const over = run([starting(), ac("b", { currentLevel: 1 })], overMeter([15.5]));
    expect(over.reason).toBe("over_mild");
    const cut = levelsFor(over.commands, "a");
    expect(cut).toHaveLength(1);
    expect(cut[0].level).toBeLessThan(3);

    const after = run(
      [starting({ currentLevel: cut[0].level }), ac("b", { currentLevel: 1 })],
      meter({ smoothedAmps: 6, calmMs: 600_000 }),
    );
    expect(levelsFor(after.commands, "a")).toEqual([{ deviceId: "a", kind: "set_level", level: 1 }]);
  });

  it("ships on a calm tick, alongside the raise phase", () => {
    const out = run([starting(), ac("b", { currentLevel: 1 })], meter({ smoothedAmps: 6, calmMs: 600_000 }));
    expect(levelsFor(out.commands, "a")).toEqual([{ deviceId: "a", kind: "set_level", level: 1 }]);
  });

  it("ships while SETTLING, and credits the collapse detector for what it cut", () => {
    const out = run([starting()], meter(), { mode: "SETTLING" });
    expect(out.reason).toBe("settling");
    expect(levelsFor(out.commands, "a")).toEqual([{ deviceId: "a", kind: "set_level", level: 1 }]);
    // L3 → L1 on a base-2/step-2 model = 4A off the line. Uncredited, a fall
    // that size is what a phantom collapse latches on (invariant 11).
    expect(out.commandedCutAmps).toBeCloseTo(4, 5);
  });

  it("ships on a hold tick (the deliberate near-limit ride)", () => {
    const out = run([starting()], meter({ smoothedAmps: 14.95, calmMs: 0 }));
    expect(out.reason).toBe("hold");
    expect(levelsFor(out.commands, "a")).toHaveLength(1);
    expect(out.commandedCutAmps).toBeGreaterThan(0);
  });

  it("never fires into a collapsed line", () => {
    const out = run([starting()], meter(), { mode: "COLLAPSED" });
    expect(out.commands).toHaveLength(0);
  });

  it("loses the dedupe to a reducer that wants to cut deeper", () => {
    // Both producers target this AC; the executor sends in array order, so the
    // LAST command must be the reducer's — never the clamp re-lifting a room
    // the meter just objected to.
    const out = run([starting({ minLevel: 2, needDelta: 4 })], overMeter([18]));
    const levels = levelsFor(out.commands, "a");
    expect(levels).toHaveLength(1);
    expect(levels[0].level).toBeLessThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Cooldown wiring (2026-08-04). `PlanInput` declares both cooldown predicates,
// the controller shell and scenario.ts have supplied both since invariant 35
// shipped, and `planRaise` reads both — but `plan()` only ever forwarded the
// FUNDING one, so `RaiseInput.victimCooldown` was permanently undefined and a
// room the reducer had just cut could climb straight back into the overload
// that caused the cut (live 2026-08-03 00:41:10Z cut → 00:42:44 raise).
//
// The acceptance scenario for that bounce passes on the other gates (calm,
// settle window, envelope), which is exactly how a missing wire hides: nothing
// asserted that the predicate reached the planner at all. These do.
// ---------------------------------------------------------------------------

describe("raise cooldowns reach the planner", () => {
  const raiser = () => [ac("a", { currentLevel: 1, needDelta: 3 })];
  const calm = () => meter({ smoothedAmps: 4, calmMs: 300_000 });

  it("raises freely when neither cooldown is live (the control)", () => {
    expect(run(raiser(), calm()).commands).toEqual([{ deviceId: "a", kind: "set_level", level: 2 }]);
  });

  it("a room the REDUCER just cut may not climb back", () => {
    const out = run(raiser(), calm(), { victimCooldown: () => true });
    expect(out.commands).toHaveLength(0);
    expect(out.decisions).toContainEqual(
      expect.objectContaining({ deviceId: "a", blockedBy: "victim cooldown" }),
    );
  });

  it("…and neither may a room that just funded a peer's raise", () => {
    const out = run(raiser(), calm(), { fundingCooldown: () => true });
    expect(out.commands).toHaveLength(0);
    expect(out.decisions).toContainEqual(
      expect.objectContaining({ deviceId: "a", blockedBy: "funding cooldown" }),
    );
  });
});

// ---------------------------------------------------------------------------
// The gated proactive shed ships its donor's `power_off` and the receiver's
// gentle restore in ONE batch (user, 2026-08-08: instant sequencing — the
// off-cliff lands in seconds while the receiver's compressor engages minutes
// later, so they never overlap on the line). A `plan()` tick that also carries
// an `invariantCorrection` would put a THIRD command in that batch, so the
// `swapAllowed` gate still stands the trade down on a correction tick — the
// trade re-arms on the next clean calm tick. (The batch already forfeits cost
// learning by design: two meter commands, so `meterCmds.length === 1` is false
// and it journals but never learns.) Found on review, 2026-08-06; batch shape
// updated 2026-08-08.
// ---------------------------------------------------------------------------

describe("proactive shed: the donor's power_off ships with the receiver's on", () => {
  // The scene has to be built so the correction does NOT rescue the restore on
  // its own, or the swap never reaches its branch and the test proves nothing:
  //  - `hot` is shed and needs 5.0A; committed 12.5A against a 14.9A ceiling,
  //    so plain (17.5A) refuses;
  //  - `mid` is inside its gen turn-on window at L2, so the gen start clamp
  //    emits `set_level 1` for it — and that floor-down is worth only 2.0A,
  //    leaving the at-floors fit at 15.5A, still refused;
  //  - `cool` is at its floor and 2.0°C milder, and switching it off frees the
  //    4.0A that closes the gap.
  const swapCfg: LevelingConfigV2 = {
    ...cfg,
    ampModels: { a: { baseAmps: 5, stepAmps: 2 }, b: { baseAmps: 2, stepAmps: 2 }, c: { baseAmps: 4, stepAmps: 2 } },
    genAmpModels: { a: { baseAmps: 5, stepAmps: 2 }, b: { baseAmps: 2, stepAmps: 2 }, c: { baseAmps: 4, stepAmps: 2 } },
  };
  const hot = () => ac("a", { name: "hot", on: false, shed: true, currentLevel: 1, needDelta: 3, rankNeedDelta: 3.0 });
  const mid = (o: Partial<AcView> = {}) =>
    ac("b", { name: "mid", currentLevel: 2, needDelta: 2.5, rankNeedDelta: 2.5, ...o });
  const cool = () => ac("c", { name: "cool", currentLevel: 1, needDelta: 1.0, rankNeedDelta: 1.0 });
  const calm = () => meter({ smoothedAmps: 12.5, calmMs: 300_000 });

  it("arms the trade and ships both commands in ONE batch (the control)", () => {
    const out = run([hot(), mid(), cool()], calm(), { config: swapCfg });
    expect(out.swap).toEqual({ donorId: "c", receiverId: "a" });
    // ONE batch (user, 2026-08-08): donor off + receiver gentle restore together,
    // and NO invariant correction shares it (the gate the describe exists to keep).
    expect(out.commands).toEqual([
      { deviceId: "c", kind: "power_off", reason: "shed" },
      { deviceId: "a", kind: "power_on", level: 1, reason: "restore", fan: 1 },
    ]);
  });

  it("stands down on a tick where an invariant correction also ships", () => {
    // `mid` is inside its gen start window, so the L2→L1 clamp owns this tick.
    const out = run([hot(), mid({ startBaselineAmps: 5 }), cool()], calm(), { config: swapCfg });
    expect(out.swap).toBeNull();
    expect(out.commands.some((c) => c.kind === "power_off")).toBe(false);
    // The correction still ships — standing down costs the trade one tick, not
    // the hard invariant. It re-arms on the next calm tick.
    expect(out.commands).toContainEqual({ deviceId: "b", kind: "set_level", level: 1 });
    // ⚠ Deliberate and worth knowing: with no trade to reserve them, the freed
    // amps go to the ordinary raise phase (`cool` L1→L2 here). The trade is a
    // comfort optimisation and it waits; a batch that never grades would cost
    // the cost book and the compressor evidence permanently.
  });
});
