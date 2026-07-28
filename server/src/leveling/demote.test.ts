import { describe, it, expect } from "vitest";
import { DEMOTE_DWELL_MS, DEMOTE_RESEND_MS, planIdleDemotes, type DemoteInput } from "./demote.js";
import { DEFAULT_LEVELING_CONFIG_V2, type LevelingConfigV2 } from "./config.js";
import type { AcView } from "./types.js";

const T = 1_000_000;

const cfg: LevelingConfigV2 = {
  ...DEFAULT_LEVELING_CONFIG_V2,
  genLimitAmps: 15,
  nearTargetBandC: 0.5,
  genAmpModels: {
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
    currentLevel: 3,
    fanSpeed: 1,
    fanExempt: false,
    needDelta: 0.2,
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
    satisfiedForMs: DEMOTE_DWELL_MS,
    unmeteredJumpAmps: 0,
    ...overrides,
    envelopeLevel: overrides.envelopeLevel ?? overrides.currentLevel ?? 3,
  };
}

function demote(acs: AcView[], overrides: Partial<DemoteInput> = {}) {
  return planIdleDemotes({ acs, config: cfg, source: "gen", now: T, inFlight: () => [], ...overrides });
}

describe("loaded-spring demote", () => {
  it("walks a satisfied room straight to its need ceiling in ONE command", () => {
    const p = demote([ac("najat")]);
    expect(p.commands).toEqual([{ deviceId: "najat", kind: "set_level", level: 1 }]);
    // model L3 6.3 → L1 2.3
    expect(p.cutAmps).toBeCloseTo(4.0, 5);
  });

  it("does nothing until the dwell is served (one cool reading proves nothing)", () => {
    expect(demote([ac("najat", { satisfiedForMs: DEMOTE_DWELL_MS - 1 })]).commands).toHaveLength(0);
    expect(demote([ac("najat", { satisfiedForMs: DEMOTE_DWELL_MS })]).commands).toHaveLength(1);
  });

  it("leaves a room that still needs its level alone", () => {
    // needDelta above the band → ceilOf is maxLevel → nothing to reclaim.
    expect(demote([ac("najat", { needDelta: 1.9, satisfiedForMs: 0 })]).commands).toHaveLength(0);
  });

  it("never demotes a manually pinned room (manual wins)", () => {
    expect(demote([ac("najat", { manualTarget: 3 })]).commands).toHaveLength(0);
  });

  it("respects a boost floor — demotes to the floor, not past it", () => {
    const p = demote([ac("najat", { minLevel: 2 })]);
    expect(p.commands).toEqual([{ deviceId: "najat", kind: "set_level", level: 2 }]);
  });

  it("skips a ramping compressor (it has not reached the level it is heading for)", () => {
    expect(demote([ac("najat", { ramping: true })]).commands).toHaveLength(0);
  });

  it("skips off, shed and unmanaged ACs", () => {
    expect(demote([ac("najat", { on: false })]).commands).toHaveLength(0);
    expect(demote([ac("najat", { shed: true, on: false })]).commands).toHaveLength(0);
    expect(demote([ac("najat", { managed: false })]).commands).toHaveLength(0);
  });

  it("leaves an unrestricted (level 0) AC to the never-level-0 correction", () => {
    expect(demote([ac("najat", { currentLevel: 0 })]).commands).toHaveLength(0);
  });

  it("does not stack a second demote while its own target is unconfirmed", () => {
    const inFlight = () => [{ level: 1, sentAt: T - 10_000 }];
    const p = demote([ac("najat")], { inFlight });
    expect(p.commands).toHaveLength(0);
    expect(p.decisions[0]?.blockedBy).toBe("awaiting confirm");
  });

  it("re-sends once the confirm window lapses — slower than the 30s level spacing", () => {
    const stale = () => [{ level: 1, sentAt: T - DEMOTE_RESEND_MS }];
    expect(demote([ac("najat")], { inFlight: stale }).commands).toHaveLength(1);
    const fresh = () => [{ level: 1, sentAt: T - 30_000 }];
    expect(demote([ac("najat")], { inFlight: fresh }).commands).toHaveLength(0);
    expect(DEMOTE_RESEND_MS).toBeGreaterThan(30_000);
  });

  it("an unconfirmed RAISE does not block the demote that supersedes it", () => {
    // Only sends at or below the ceiling count as "this demote is already in
    // flight"; a stale L3 send is exactly what we are trying to undo.
    const inFlight = () => [{ level: 3, sentAt: T - 5_000 }];
    expect(demote([ac("najat")], { inFlight }).commands).toHaveLength(1);
  });

  it("demotes several satisfied rooms in one batch and prices them all", () => {
    const p = demote([ac("najat"), ac("abdu")]);
    expect(p.commands).toHaveLength(2);
    // najat 6.3→2.3 = 4.0, abdu 9.3→4.3 = 5.0
    expect(p.cutAmps).toBeCloseTo(9.0, 5);
  });
});
