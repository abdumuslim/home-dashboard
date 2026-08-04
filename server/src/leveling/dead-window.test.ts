import { describe, it, expect } from "vitest";
import {
  DEAD_WINDOW_GAP_AMPS,
  deviceIsDark,
  ENTRY_COLLAPSE_DWELL_MS,
  ENTRY_COLLAPSE_STALE_MS,
  entryCollapseEvidence,
  houseIsDead,
  meterIsSteady,
  modeledGapAmps,
  modeledRunningAmps,
  rampAbsorptionLanded,
  rampReleaseBarAmps,
  RESIDUAL_TRUST_GAP_AMPS,
  type ModeledAc,
} from "./dead-window.js";
import { DEFAULT_LEVELING_CONFIG_V2, type LevelingConfigV2 } from "./config.js";

const T = 1_800_000_000;

// The live gen models the morning of 2026-08-04.
const cfg: LevelingConfigV2 = {
  ...DEFAULT_LEVELING_CONFIG_V2,
  genLimitAmps: 15,
  genAmpModels: {
    abdullah: { baseAmps: 2.3, stepAmps: 2.5 },
    najat: { baseAmps: 2.3, stepAmps: 2.0 },
    abdu: { baseAmps: 4.3, stepAmps: 2.5 },
  },
};

const ac = (deviceId: string, currentLevel: number, extra: Partial<ModeledAc> = {}): ModeledAc => ({
  deviceId,
  on: true,
  managed: true,
  shed: false,
  currentLevel,
  maxLevel: 3,
  ...extra,
});

// {Abdullah L2 4.8, Najat L1 2.3, Abdu L1 4.3} — the 11:16 gen-entry floors.
const floored = () => [ac("abdullah", 2), ac("najat", 1), ac("abdu", 1)];

describe("modeledRunningAmps", () => {
  it("sums only the rooms we believe are drawing", () => {
    expect(modeledRunningAmps(floored(), cfg, "gen")).toBeCloseTo(11.4, 5);
  });

  it("ignores off, shed and unmanaged rooms — their draw is house, not AC", () => {
    const acs = [
      ac("abdullah", 2),
      ac("najat", 1, { on: false }),
      ac("abdu", 1, { shed: true }),
      ac("guest", 1, { managed: false }),
    ];
    expect(modeledRunningAmps(acs, cfg, "gen")).toBeCloseTo(4.8, 5);
  });
});

describe("the ramp release bar — did a compressor START?", () => {
  it("releases a compressor drawing well UNDER its model (Abdullah 1.8A vs 2.3 modeled)", () => {
    // The load-bearing case: this must NOT extend, or a healthy house whose
    // compressors simply run below their caps freezes its own raise path.
    expect(rampAbsorptionLanded(1.8, ac("abdullah", 1), cfg, "gen")).toBe(true);
  });

  it("does not release on a fan-only draw", () => {
    // ~0.1–0.3A is what a room draws while its compressor sits in restart
    // protection; the bar for Najat's 2.3A L1 model is 0.92A.
    expect(rampReleaseBarAmps(2.3)).toBeCloseTo(0.92, 5);
    expect(rampAbsorptionLanded(0.3, ac("najat", 1), cfg, "gen")).toBe(false);
  });

  it("caps the bar in absolute amps so a big compressor's is still reachable", () => {
    // 40% of Abdu's 9.3A L3 model is 3.7A — more than either 1-ton room draws
    // in total. The question is whether a compressor started, not whether it
    // finished.
    expect(rampReleaseBarAmps(9.3)).toBe(1.0);
    expect(rampAbsorptionLanded(1.0, ac("abdu", 3), cfg, "gen")).toBe(true);
    expect(rampAbsorptionLanded(0.9, ac("abdu", 3), cfg, "gen")).toBe(false);
  });
});

describe("whole-house dead-window evidence", () => {
  it("the ordinary case is NEGATIVE — the meter carries the house on top of the ACs", () => {
    expect(modeledGapAmps({ smoothedAmps: 13.9, acs: floored(), config: cfg, source: "gen" })).toBeCloseTo(
      -2.5,
      5,
    );
    expect(houseIsDead(-2.5)).toBe(false);
  });

  it("arms on the live 11:20 reading — 6.1A metered against an 11.4A model", () => {
    const gap = modeledGapAmps({ smoothedAmps: 6.1, acs: floored(), config: cfg, source: "gen" });
    expect(gap).toBeCloseTo(5.3, 5);
    expect(houseIsDead(gap)).toBe(true);
  });

  it("a reducing cut still in flight explains its own gap and does not arm it", () => {
    // The model drops at the shadow, the meter follows over minutes — invariant
    // 5's whole point. Those amps are late, not missing.
    const gap = modeledGapAmps({
      smoothedAmps: 9.0,
      acs: floored(),
      config: cfg,
      source: "gen",
      commandedCutCreditAmps: 2.5,
    });
    expect(houseIsDead(gap)).toBe(false);
  });

  it("a direct sample needs a STILL meter — a compressor engaging shows raw first", () => {
    // The other end of the median lag: on the tick a compressor engages the raw
    // reading is already up and the 4-wide mean is halfway there, so the gap has
    // not yet closed. The acceptance run booked a 6.5A "house" from a real 2.0A
    // exactly there, and that peak refused every raise for fifteen minutes.
    expect(meterIsSteady({ latestAmps: 3.81, smoothedAmps: 3.8 })).toBe(true);
    expect(meterIsSteady({ latestAmps: 5.2, smoothedAmps: 3.8 })).toBe(true); // supply flicker
    expect(meterIsSteady({ latestAmps: 10.9, smoothedAmps: 6.45 })).toBe(false);
    // A raw reading BELOW the mean only over-states the house, which over-blocks.
    expect(meterIsSteady({ latestAmps: 1.0, smoothedAmps: 3.8 })).toBe(true);
  });

  it("sits above the flicker cap and below the smallest whole compressor", () => {
    // Both halves of hard rule 5c: supply wobble (≤1.5A, sensing.ts) can never
    // arm it, and one dead 1-ton at L1 (2.3A modeled) still does.
    expect(DEAD_WINDOW_GAP_AMPS).toBeGreaterThan(1.5);
    expect(DEAD_WINDOW_GAP_AMPS).toBeLessThanOrEqual(2.3);
    expect(RESIDUAL_TRUST_GAP_AMPS).toBeLessThan(DEAD_WINDOW_GAP_AMPS);
  });
});

// ---------------------------------------------------------------------------
// Trip on ENTRY (2026-08-04, user-confirmed breaker trip and manual reset). The
// gen session STARTED with the AC circuit dead: the quiet ~6A window from 11:16
// to ~11:21 was an open breaker, and the four FLOORS resends went to devices
// that could not hear them. `ingestReading` judges FALLS inside a session, and
// a session that begins dead has no cliff — so the third real trip in ten days
// never latched, no derate armed, and the controller rode 14.3–14.8A on it.
// ---------------------------------------------------------------------------

describe("entry-collapse evidence", () => {
  const dark = { lastSeenAt: T - ENTRY_COLLAPSE_STALE_MS - 1_000 };
  const fresh = { lastSeenAt: T - 30_000 };
  /** 6.1A metered against the 11.4A floor set — the live 11:18 reading. */
  const deadGap = modeledGapAmps({ smoothedAmps: 6.1, acs: floored(), config: cfg, source: "gen" });

  it("latches when the model says we draw, the meter says nothing does, and every room is dark", () => {
    expect(entryCollapseEvidence({ gapAmps: deadGap, devices: [dark, dark, dark], now: T })).toBe(true);
  });

  it("ONE room still reporting is a cloud problem, not a breaker", () => {
    expect(entryCollapseEvidence({ gapAmps: deadGap, devices: [dark, dark, fresh], now: T })).toBe(false);
  });

  it("restart protection does not latch — the modules stay powered and keep reporting", () => {
    // The whole point of signal (b): a compressor that has not started looks
    // exactly like a dead circuit on the meter. The shadows are what differ.
    expect(entryCollapseEvidence({ gapAmps: deadGap, devices: [fresh, fresh, fresh], now: T })).toBe(false);
  });

  it("a house Wi-Fi outage cannot fake it — the ACs keep drawing, so the gap never holds", () => {
    const drawing = modeledGapAmps({ smoothedAmps: 13.9, acs: floored(), config: cfg, source: "gen" });
    expect(entryCollapseEvidence({ gapAmps: drawing, devices: [dark, dark, dark], now: T })).toBe(false);
  });

  it("with nothing running there is no claim to contradict", () => {
    expect(entryCollapseEvidence({ gapAmps: deadGap, devices: [], now: T })).toBe(false);
  });

  it("darkness is POSITIVE evidence only — unknown liveness never latches", () => {
    // Every test fixture and every pre-liveness code path leaves these unset.
    expect(deviceIsDark({}, T)).toBe(false);
    expect(deviceIsDark({ lastSeenAt: null }, T)).toBe(false);
    // …and either signal alone is enough once it IS known.
    expect(deviceIsDark({ isOnline: false }, T)).toBe(true);
    expect(deviceIsDark({ isOnline: true, lastSeenAt: T - ENTRY_COLLAPSE_STALE_MS - 1 }, T)).toBe(true);
    expect(deviceIsDark({ isOnline: true, lastSeenAt: T - 60_000 }, T)).toBe(false);
  });

  it("staleness plus dwell has to fit inside a real dead window", () => {
    // This morning's was ~6 minutes from changeover to manual reset, and the
    // two clocks are cumulative: darkness accrues from the last report, and
    // only then can the evidence start its dwell.
    expect(ENTRY_COLLAPSE_STALE_MS + ENTRY_COLLAPSE_DWELL_MS).toBeLessThan(6 * 60_000);
  });
});
