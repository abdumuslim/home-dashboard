import { describe, it, expect } from "vitest";
import { envelopeTotalAmps, invariantCorrections, planRaise, rampDebitAmps, type RaiseInput } from "./raise.js";
import { initialPacingState, noteAttempt, noteFailure } from "./pacing.js";
import { updateCost } from "./costs.js";
import { DEFAULT_LEVELING_CONFIG_V2, type LevelingConfigV2 } from "./config.js";
import type { AcView } from "./types.js";

const T = 1_000_000;

// base 2, step 2 → model jump 2A per step; turn-on at L1 = 2A.
const cfg: LevelingConfigV2 = {
  ...DEFAULT_LEVELING_CONFIG_V2,
  genLimitAmps: 15,
  marginAmps: 0.1,
  restingBufferAmps: 0.2,
  raiseCalmSeconds: 30,
  restoreCalmSeconds: 15,
  ampModels: {
    a: { baseAmps: 2, stepAmps: 2 },
    b: { baseAmps: 2, stepAmps: 2 },
    c: { baseAmps: 2, stepAmps: 2 },
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
    subFloorStalledMs: 0,
    unmeteredJumpAmps: 0,
    ...overrides,
    envelopeLevel: overrides.envelopeLevel ?? overrides.currentLevel ?? 1,
  };
}

function raise(acs: AcView[], overrides: Partial<RaiseInput> = {}) {
  return planRaise({
    acs,
    headroomAmps: 2.6, // e.g. smoothed 12.1 vs resting ceiling 14.7
    smoothedAmps: 12.1,
    rampDebitAmps: 0,
    // The AC-only envelope these cases were written against; the house term
    // gets its own suite below.
    nonAcAmps: 0,
    cutAnchorAmps: 0,
    commandedCutAmps: 0,
    limitAmps: 15,
    calmMs: 60_000,
    config: cfg,
    book: {},
    source: "gen",
    now: T,
    pacing: initialPacingState("gen"),
    ...overrides,
  });
}

describe("a restore is judged on where the meter is HEADING (2026-08-03 shed/restore cycle)", () => {
  // Najat was shed and restored FOUR times in 23 minutes. Each restore was
  // admitted against the instantaneous meter, which right after her shed read
  // 9.5–12.5A — her draw gone, the survivors mid-cycle — while the settled
  // three-room draw was ~15A. Always affordable at admission, never affordable
  // a minute later.
  const shedRoom = (): AcView[] => [
    ac("a", { needDelta: 2 }),
    ac("b", { on: false, shed: true, needDelta: 4 }),
  ];

  it("refuses while the fall from our own cut is still arriving", () => {
    // The meter reads 9.5, but we commanded 2.5A off from a house that was at
    // 14.0 — so it is heading for 11.5, and her ~2.3A restore does not fit
    // under the 14.9 ceiling once it lands there... plus her own draw.
    const p = raise(shedRoom(), {
      smoothedAmps: 9.5,
      headroomAmps: 5.2,
      cutAnchorAmps: 14.0,
      commandedCutAmps: 2.5,
      limitAmps: 13.0,
    });
    expect(p.commands).not.toContainEqual(
      expect.objectContaining({ deviceId: "b", kind: "power_on" }),
    );
    expect(p.decisions).toContainEqual(
      expect.objectContaining({ deviceId: "b", blockedBy: "no headroom" }),
    );
  });

  it("admits the same restore once no cut is in flight", () => {
    // Identical meter, no pending cut: the 9.5 is the house, not a trough, and
    // stranding a room off is the worse failure (invariant 16).
    const p = raise(shedRoom(), {
      smoothedAmps: 9.5,
      headroomAmps: 5.2,
      cutAnchorAmps: 0,
      commandedCutAmps: 0,
      limitAmps: 13.0,
    });
    expect(p.commands).toContainEqual(
      expect.objectContaining({ deviceId: "b", kind: "power_on", reason: "restore" }),
    );
  });
});

describe("restore outranks raises", () => {
  it("a feasible shed restore ships alone at its floor (gentle — fan pinned on gen)", () => {
    const p = raise([ac("a", { needDelta: 3 }), ac("b", { on: false, shed: true, needDelta: 4 })]);
    expect(p.commands).toEqual([{ deviceId: "b", kind: "power_on", level: 1, reason: "restore", fan: 1 }]);
    expect(p.isTurnOn).toBe(true);
  });

  it("gen restores ship gentle (fan 1); grid restores are plain", () => {
    const shed = ac("b", { on: false, shed: true, needDelta: 4 });
    const gen = raise([ac("a"), shed]);
    expect(gen.commands).toContainEqual({ deviceId: "b", kind: "power_on", level: 1, reason: "restore", fan: 1 });
    const gridCfg = { ...cfg, gridLimitAmps: 27 };
    const grid = raise([ac("a"), shed], { source: "grid", config: gridCfg, smoothedAmps: 10, headroomAmps: 10 });
    expect(grid.commands).toContainEqual({ deviceId: "b", kind: "power_on", level: 1, reason: "restore" });
    expect(grid.commands.find((c) => c.kind === "power_on" && "fan" in c && c.fan != null)).toBeUndefined();
  });

  it("probes a blocked restore at the steady price while there is zero bounce evidence (2026-07-24 phantom)", () => {
    // Learned on@L1 is 4A but may be stale-high (live 2026-07-24: a phantom
    // 3.7A stranded a room that really fit on ~2.3A). smoothed 12.5 + 4 = 16.5
    // blocks; with NO restore failures this source-session, ONE probe ships at
    // the 2A steady price (12.5 + 2 = 14.5 ≤ 14.9) — marked probe so the
    // freshly-on projection re-prices it identically.
    const book = updateCost({}, "b", "gen", "on@L1", 4, T);
    const p = raise([ac("a"), ac("b", { on: false, shed: true, needDelta: 4 })], {
      smoothedAmps: 12.5,
      headroomAmps: 2.2,
      book,
    });
    expect(p.commands).toContainEqual({ deviceId: "b", kind: "power_on", level: 1, reason: "restore", fan: 1 });
    expect(p.probeRestoreIds).toEqual(["b"]);
  });

  it("a restore that bounced re-admits ONLY at the learned price (2026-07-27 bounce loop)", () => {
    // Live 16:43–17:00: three restores admitted at Najat's steady 2.3A each
    // ramped +3.5–3.8A and bounced. After a bounce (failures > 0) the probe is
    // off the table: the learned 4A must fit or the room stays shed.
    const book = updateCost({}, "b", "gen", "on@L1", 4, T);
    // Failure recorded 31s ago — its 30s backoff rung has expired, so ONLY the
    // probe gate (failures > 0), not the backoff, blocks the cheap re-admission.
    const bounced = noteFailure(initialPacingState("gen"), "b", "restore", T - 31_000);
    const blocked = raise([ac("a"), ac("b", { on: false, shed: true, needDelta: 4 })], {
      smoothedAmps: 12.5,
      headroomAmps: 2.2,
      book,
      pacing: bounced,
    });
    expect(blocked.commands.every((c) => c.kind !== "power_on")).toBe(true);
    expect(blocked.decisions).toContainEqual(
      expect.objectContaining({ deviceId: "b", action: "restore", blockedBy: "no headroom" }),
    );
    // Once the house truly has room for the learned cost, the restore ships.
    const fits = raise([ac("a"), ac("b", { on: false, shed: true, needDelta: 4 })], {
      smoothedAmps: 10.8,
      headroomAmps: 3.9,
      book,
      pacing: bounced,
    });
    expect(fits.commands).toContainEqual({ deviceId: "b", kind: "power_on", level: 1, reason: "restore", fan: 1 });
    expect(fits.probeRestoreIds).toEqual([]);
  });

  it("a bounced probe re-arms once the meter sits a full amp below the failed attempt (2026-08-02 strand)", () => {
    // Live 11:27: Najat's probe was admitted at a committed 11.9A and bounced.
    // From 11:31 the meter sat at 10.8–11.2A — room for her REAL ~3.5A cost —
    // but failures > 0 kept the probe off and the learned 4.1A refused every
    // restore until the user turned her on by hand 17 minutes later. A meter
    // ≥ PROBE_REARM_DROP_AMPS below the failed attempt's own committed amps is
    // evidence the house materially changed: re-arm ONE probe. The new attempt
    // re-anchors lower, so a bounce loop needs the meter to keep falling.
    const book = updateCost({}, "b", "gen", "on@L1", 4.5, T);
    const bounced = noteFailure(
      noteAttempt(initialPacingState("gen"), "b", "restore", T - 95_000, 11.9),
      "b",
      "restore",
      T - 31_000,
    );
    const shed = ac("b", { on: false, shed: true, needDelta: 4 });
    // 11.2A: plain 15.7 > 14.9 blocks, and 11.2 > 11.9 − 1.0 — no re-arm.
    const still = raise([ac("a"), shed], { smoothedAmps: 11.2, headroomAmps: 3.5, book, pacing: bounced });
    expect(still.commands.every((c) => c.kind !== "power_on")).toBe(true);
    expect(still.decisions).toContainEqual(
      expect.objectContaining({ deviceId: "b", action: "restore", blockedBy: "no headroom" }),
    );
    // 10.8A ≤ 10.9: re-armed — the probe ships at the steady 2A price.
    const rearmed = raise([ac("a"), shed], { smoothedAmps: 10.8, headroomAmps: 3.9, book, pacing: bounced });
    expect(rearmed.commands).toContainEqual({ deviceId: "b", kind: "power_on", level: 1, reason: "restore", fan: 1 });
    expect(rearmed.probeRestoreIds).toEqual(["b"]);
  });

  it("a bounced attempt with no meter anchor never re-arms (pre-anchor pacing state)", () => {
    const book = updateCost({}, "b", "gen", "on@L1", 4.5, T);
    const bounced = noteFailure(initialPacingState("gen"), "b", "restore", T - 31_000);
    const p = raise([ac("a"), ac("b", { on: false, shed: true, needDelta: 4 })], {
      smoothedAmps: 10.8,
      headroomAmps: 3.9,
      book,
      pacing: bounced,
    });
    expect(p.commands.every((c) => c.kind !== "power_on")).toBe(true);
  });

  it("an in-flight restore (sent, shadow unconfirmed) reserves its amps and is not re-sent", () => {
    // Shed clears on shadow CONFIRM since 2026-07-27 (clearing at send let a
    // 5.8s shadow lag mint a bogus manual-off lock), so a just-sent restore is
    // still a shed candidate — the confirm window must park it AND the raises.
    const pacing = noteAttempt(initialPacingState("gen"), "b", "restore", T - 30_000);
    const p = raise([ac("a", { needDelta: 3 }), ac("b", { on: false, shed: true, needDelta: 4 })], {
      pacing,
    });
    expect(p.commands).toEqual([]);
    expect(p.decisions).toContainEqual(
      expect.objectContaining({ deviceId: "b", action: "restore", blockedBy: "awaiting confirm" }),
    );
    expect(p.reservedAmps).toBeGreaterThan(0);
    expect(p.decisions).toContainEqual(
      expect.objectContaining({ action: "raises", blockedBy: "restore reservation" }),
    );
    // Past the confirm window the same state re-sends (confirm-or-resend).
    const late = raise([ac("a", { needDelta: 3 }), ac("b", { on: false, shed: true, needDelta: 4 })], {
      pacing: noteAttempt(initialPacingState("gen"), "b", "restore", T - 61_000),
    });
    expect(late.commands).toContainEqual({ deviceId: "b", kind: "power_on", level: 1, reason: "restore", fan: 1 });
  });

  it("restores are exempt from the resting buffer (fit under limit − margin)", () => {
    // smoothed 13.2 + cost 2 = 15.2 > 14.9 → blocked; smoothed 12.8 + 2 = 14.8 ≤ 14.9 → fits,
    // even though the resting-ceiling headroom (14.7 − 12.8 = 1.9) is < cost.
    const shed = ac("b", { on: false, shed: true, needDelta: 4 });
    const blocked = raise([ac("a"), shed], { smoothedAmps: 13.2, headroomAmps: 1.5 });
    expect(blocked.commands.every((c) => c.kind !== "power_on")).toBe(true);
    const fits = raise([ac("a"), shed], { smoothedAmps: 12.8, headroomAmps: 1.9 });
    expect(fits.commands).toContainEqual({ deviceId: "b", kind: "power_on", level: 1, reason: "restore", fan: 1 });
  });

  it("a backoff-blocked candidate does not strand the next one (v1 49m strand)", () => {
    const pacing = noteFailure(initialPacingState("gen"), "b", "restore", T - 1_000);
    const p = raise(
      [ac("a"), ac("b", { on: false, shed: true, needDelta: 4 }), ac("c", { on: false, shed: true, needDelta: 2 })],
      { pacing },
    );
    expect(p.commands).toContainEqual({ deviceId: "c", kind: "power_on", level: 1, reason: "restore", fan: 1 });
  });

  it("a calm-gated feasible restore reserves its amps and parks the raise phase", () => {
    // Config with a restore gate ABOVE the raise gate (only reachable when
    // passed raw, not through mergeLevelingConfigV2's clamp): calm 35s unlocks
    // raises but not the restore. The restore is feasible → reserve + park the
    // whole raise phase, so a running AC can't steal the reserved headroom.
    const p = raise([ac("a", { needDelta: 3 }), ac("b", { on: false, shed: true, needDelta: 4 })], {
      calmMs: 35_000,
      config: { ...cfg, restoreCalmSeconds: 45 },
    });
    expect(p.commands).toHaveLength(0);
    expect(p.reservedAmps).toBeGreaterThan(0);
    expect(p.decisions.some((d) => d.deviceId === "b" && d.blockedBy === "calm")).toBe(true);
    expect(p.decisions.some((d) => d.action === "raises" && d.blockedBy === "restore reservation")).toBe(true);
  });

  it("reserves a backoff-blocked feasible restore's amps and parks the raise phase", () => {
    // b (shed, most-needy) is feasible but its restore backoff is cooling. The
    // raise phase must NOT hand a's headroom out while b waits for the ladder.
    const pacing = noteFailure(initialPacingState("gen"), "b", "restore", T - 1_000);
    const p = raise([ac("a", { needDelta: 3 }), ac("b", { on: false, shed: true, needDelta: 4 })], {
      headroomAmps: 5,
      pacing,
    });
    expect(p.commands).toHaveLength(0);
    expect(p.reservedAmps).toBeGreaterThan(0);
    expect(p.decisions.some((d) => d.deviceId === "b" && d.blockedBy === "backoff")).toBe(true);
    expect(p.decisions.some((d) => d.action === "raises" && d.blockedBy === "restore reservation")).toBe(true);
  });

  it("a shed room infeasible even at floors reserves nothing — raises proceed", () => {
    // b's turn-on can't fit even with a pulled to its floor (smoothed 14.8 + 2
    // = 16.8, and a is already at floor L1 so there's nothing to pull down).
    const p = raise([ac("a", { needDelta: 3 }), ac("b", { on: false, shed: true, needDelta: 4 })], {
      smoothedAmps: 14.8,
      headroomAmps: 5,
    });
    expect(p.reservedAmps).toBe(0);
    expect(p.commands).toEqual([{ deviceId: "a", kind: "set_level", level: 2 }]);
    expect(p.decisions.some((d) => d.deviceId === "b" && d.blockedBy === "no headroom")).toBe(true);
  });

  it("a calm-gated plain-feasible restore parks warm raises too", () => {
    // A warm raise is calm-exempt, so per-amp reservation alone wouldn't stop
    // it — the whole raise phase must park while the restore is reserved.
    const p = raise(
      [ac("a", { warmStartLevel: 3, currentLevel: 1 }), ac("b", { on: false, shed: true, needDelta: 4 })],
      { calmMs: 35_000, headroomAmps: 6, config: { ...cfg, restoreCalmSeconds: 45 } },
    );
    expect(p.commands).toHaveLength(0);
    expect(p.reservedAmps).toBeGreaterThan(0);
    expect(p.decisions.some((d) => d.action === "raises" && d.blockedBy === "restore reservation")).toBe(true);
  });

  it("restore-with-reduction pulls raised peers to floors in the same batch", () => {
    // smoothed 14.5: restore cost 2 → 16.5 > 14.9. Peer at L3 saves 4A at floors → fits.
    const p = raise([ac("a", { currentLevel: 3, needDelta: 0.6 }), ac("b", { on: false, shed: true, needDelta: 4 })], {
      smoothedAmps: 14.5,
      headroomAmps: 0.2,
    });
    expect(p.commands).toEqual([
      { deviceId: "a", kind: "set_level", level: 1 },
      { deviceId: "b", kind: "power_on", level: 1, reason: "restore", fan: 1 },
    ]);
  });
});

describe("one-step meter-anchored raises", () => {
  it("raises the most-needy AC one step on gen — one command per batch", () => {
    const p = raise([ac("a", { needDelta: 1 }), ac("b", { needDelta: 3 })], { headroomAmps: 5 });
    expect(p.commands).toEqual([{ deviceId: "b", kind: "set_level", level: 2 }]);
  });

  it("grid may raise several ACs one step each, admission-checked cumulatively", () => {
    const gridCfg = { ...cfg, gridLimitAmps: 27 };
    const p = raise([ac("a", { needDelta: 3 }), ac("b", { needDelta: 2 })], {
      source: "grid",
      config: gridCfg,
      headroomAmps: 5,
    });
    expect(p.commands).toEqual([
      { deviceId: "a", kind: "set_level", level: 2 },
      { deviceId: "b", kind: "set_level", level: 2 },
    ]);
    // headroom 3.5 fits only the first 2A jump.
    const tight = raise([ac("a", { needDelta: 3 }), ac("b", { needDelta: 2 })], {
      source: "grid",
      config: gridCfg,
      headroomAmps: 3.5,
    });
    expect(tight.commands).toEqual([{ deviceId: "a", kind: "set_level", level: 2 }]);
  });

  it("the learned hot-case jump blocks a raise the static model would admit", () => {
    const book = updateCost({}, "a", "gen", "level:1>2", 3.8, T);
    const p = raise([ac("a")], { book, headroomAmps: 2.5 });
    expect(p.commands).toHaveLength(0);
    expect(p.decisions.some((d) => d.blockedBy === "no headroom" && d.detail?.includes("3.8"))).toBe(true);
  });

  it("calm gate + ramping block ordinary raises", () => {
    expect(raise([ac("a")], { calmMs: 10_000 }).commands).toHaveLength(0);
    expect(raise([ac("a", { ramping: true })]).commands).toHaveLength(0);
  });

  it("near-target rooms are capped at L1; manualTarget overrides the cap", () => {
    expect(raise([ac("a", { needDelta: 0.3 })]).commands).toHaveLength(0);
    const p = raise([ac("a", { needDelta: 0.3, manualTarget: 3 })], { headroomAmps: 5 });
    expect(p.commands).toEqual([{ deviceId: "a", kind: "set_level", level: 2 }]);
  });
});

describe("warm restore", () => {
  it("jumps straight to the remembered level, exempt from the calm gate", () => {
    const p = raise([ac("a", { warmStartLevel: 3, ramping: true })], { calmMs: 0, headroomAmps: 5 });
    expect(p.commands).toEqual([{ deviceId: "a", kind: "set_level", level: 3 }]);
  });

  it("still admission-checked and ceiling-clamped", () => {
    const tight = raise([ac("a", { warmStartLevel: 3 })], { calmMs: 0, headroomAmps: 3 });
    expect(tight.commands).toHaveLength(0); // 2-step jump = 4A model > 3A headroom
    const capped = raise([ac("a", { warmStartLevel: 3, slotCap: 2 })], { calmMs: 0, headroomAmps: 5 });
    expect(capped.commands).toEqual([{ deviceId: "a", kind: "set_level", level: 2 }]);
  });
});

describe("physics-envelope veto (2026-07-23: double-L3 on gen predicted 16.9A > 15A, shipped, tripped)", () => {
  // Live-shaped gen models: Abdu (2-ton) 4.3+2.5 → 9.3 @L3; Najat (1-ton) 2.3+2 → 6.3 @L3.
  const liveCfg: LevelingConfigV2 = {
    ...cfg,
    genAmpModels: {
      abdu: { baseAmps: 4.3, stepAmps: 2.5 },
      najat: { baseAmps: 2.3, stepAmps: 2 },
    },
  };

  it("envelopeTotalAmps sums worst-case cap draws from the per-AC models", () => {
    const total = envelopeTotalAmps(
      [
        { deviceId: "abdu", level: 3, maxLevel: 3 },
        { deviceId: "najat", level: 3, maxLevel: 3 },
      ],
      liveCfg,
      "gen",
    );
    expect(total).toBeCloseTo(15.6, 5);
  });

  it("blocks the second L3 on gen even when the meter shows room (the incident)", () => {
    // Abdu already at L3, Najat at L2 wanting L3. The (lagging/frozen) meter
    // reads 10.4A — plenty of apparent headroom — but 9.3 + 6.3 = 15.6 > 14.9.
    const p = planRaise({
      acs: [ac("abdu", { currentLevel: 3, needDelta: 3 }), ac("najat", { currentLevel: 2, needDelta: 2.7 })],
      headroomAmps: 4.3, // 14.7 − 10.4
      smoothedAmps: 10.4,
      rampDebitAmps: 0,
      nonAcAmps: 0,
      limitAmps: 15,
      calmMs: 60_000,
      config: liveCfg,
      book: {},
      source: "gen",
      now: T,
      pacing: initialPacingState("gen"),
    });
    expect(p.commands).toHaveLength(0);
    expect(p.decisions.some((d) => d.deviceId === "najat" && d.blockedBy === "physics envelope")).toBe(true);
  });

  it("2026-07-28 15:55 blind raise: prices a peer at its UNCONFIRMED level, not its stale shadow", () => {
    // Live: Najat was sent L3 at 15:39:49; her shadow still said L2 at 15:55:36,
    // so the envelope summed 9.3 (Abdu@L3 wanted) + 4.3 (Najat@L2 believed) =
    // 13.6 ≤ 14.9 and ADMITTED the raise. By 16:06 her shadow flipped and the
    // identical end-state was vetoed at 15.6 — after the raise had landed and
    // produced an over_severe. envelopeLevel prices the worst case the firmware
    // could be in, so the veto now happens BEFORE the breach.
    // Najat is hot too, so there is nothing dormant to harvest from her — the
    // only question is what Abdu is allowed to do against her real level.
    const lagging = ac("najat", { currentLevel: 2, envelopeLevel: 3, needDelta: 2.7 });
    const p = planRaise({
      acs: [ac("abdu", { currentLevel: 2, needDelta: 3 }), lagging],
      headroomAmps: 4.3,
      smoothedAmps: 10.4,
      rampDebitAmps: 0,
      nonAcAmps: 0,
      limitAmps: 15,
      calmMs: 60_000,
      config: liveCfg,
      book: {},
      source: "gen",
      now: T,
      pacing: initialPacingState("gen"),
    });
    expect(p.commands.filter((c) => c.deviceId === "abdu")).toHaveLength(0);
    const veto = p.decisions.find((d) => d.deviceId === "abdu" && d.blockedBy === "physics envelope");
    expect(veto?.detail).toContain("15.6");
  });

  it("the same raise IS admitted when the peer's low level is genuinely confirmed", () => {
    // Control for the case above: identical numbers, nothing in flight —
    // 9.3 + 4.3 = 13.6, the exact envelope that admitted the live 15:55 raise.
    const p = planRaise({
      acs: [ac("abdu", { currentLevel: 2, needDelta: 3 }), ac("najat", { currentLevel: 2, needDelta: 0.3 })],
      headroomAmps: 4.3,
      smoothedAmps: 10.4,
      rampDebitAmps: 0,
      nonAcAmps: 0,
      limitAmps: 15,
      calmMs: 60_000,
      config: liveCfg,
      book: {},
      source: "gen",
      now: T,
      pacing: initialPacingState("gen"),
    });
    expect(p.commands).toEqual([{ deviceId: "abdu", kind: "set_level", level: 3 }]);
  });

  it("allows the same raise once a peer's cap comes down (end-state fits)", () => {
    // Abdu at L1: 4.3 + Najat L3 6.3 = 10.6 ≤ 14.9 → the raise may proceed.
    const p = planRaise({
      acs: [ac("abdu", { currentLevel: 1, needDelta: 1 }), ac("najat", { currentLevel: 2, needDelta: 2.7 })],
      headroomAmps: 4.3,
      smoothedAmps: 10.4,
      rampDebitAmps: 0,
      nonAcAmps: 0,
      limitAmps: 15,
      calmMs: 60_000,
      config: liveCfg,
      book: {},
      source: "gen",
      now: T,
      pacing: initialPacingState("gen"),
    });
    expect(p.commands).toEqual([{ deviceId: "najat", kind: "set_level", level: 3 }]);
  });

  it("grid raises are NOT envelope-guarded (grid starts full by directive)", () => {
    const gridCfg = { ...liveCfg, gridLimitAmps: 12 }; // absurdly tight to prove the guard is off
    const p = raise([ac("abdu", { currentLevel: 2, needDelta: 3, manualTarget: 3 })], {
      source: "grid",
      config: gridCfg,
      headroomAmps: 5,
      smoothedAmps: 5,
      limitAmps: 12,
    });
    expect(p.commands).toEqual([{ deviceId: "abdu", kind: "set_level", level: 3 }]);
  });

  it("a warm restore degrades to the highest envelope-safe level instead of stranding", () => {
    // Warm target L3 (6.3 + Abdu's 9.3 = 15.6 > 14.9) degrades to L2 (4.3 + 9.3 = 13.6 ✓).
    const p = planRaise({
      acs: [ac("abdu", { currentLevel: 3, needDelta: 1 }), ac("najat", { currentLevel: 1, needDelta: 2, warmStartLevel: 3 })],
      headroomAmps: 4.3,
      smoothedAmps: 10.4,
      rampDebitAmps: 0,
      nonAcAmps: 0,
      limitAmps: 15,
      calmMs: 60_000,
      config: liveCfg,
      book: {},
      source: "gen",
      now: T,
      pacing: initialPacingState("gen"),
    });
    expect(p.commands).toEqual([{ deviceId: "najat", kind: "set_level", level: 2 }]);
  });

  it("an envelope-breaking plain restore falls through to restore-with-peer-floor-downs", () => {
    // Peers' caps claim 9.3 + 6.3 = 15.6 > 14.9, so restoring c on TOP of them
    // is refused even with meter room — but pulling both peers to their floors
    // (4.3 + 2.3 + 2 = 8.6) makes the restore fit, so it ships as one batch.
    const p = planRaise({
      acs: [
        ac("abdu", { currentLevel: 3, needDelta: 1 }),
        ac("najat", { currentLevel: 3, needDelta: 1 }),
        ac("c", { on: false, shed: true, needDelta: 4 }),
      ],
      headroomAmps: 8,
      smoothedAmps: 6,
      rampDebitAmps: 0,
      nonAcAmps: 0,
      limitAmps: 15,
      calmMs: 60_000,
      config: liveCfg,
      book: {},
      source: "gen",
      now: T,
      pacing: initialPacingState("gen"),
    });
    expect(p.commands).toEqual([
      { deviceId: "abdu", kind: "set_level", level: 1 },
      { deviceId: "najat", kind: "set_level", level: 1 },
      { deviceId: "c", kind: "power_on", level: 1, reason: "restore", fan: 1 },
    ]);
  });

  it("a restore that breaks the envelope even at floors stays off, labeled 'physics envelope'", () => {
    // c's floor draw alone (9A base) + peers at floors (4.3 + 2.3) = 15.6 > 14.9.
    // Even everyone-at-floors is over the breaker model, so the blocker is
    // physics, not the meter — the journal must say so (was mislabeled "no
    // headroom" before the 2026-07-24 arbitration fix).
    const heavyCfg: LevelingConfigV2 = {
      ...liveCfg,
      genAmpModels: { ...liveCfg.genAmpModels, c: { baseAmps: 9, stepAmps: 1 } },
    };
    const p = planRaise({
      acs: [
        ac("abdu", { currentLevel: 3, needDelta: 1 }),
        ac("najat", { currentLevel: 3, needDelta: 1 }),
        ac("c", { on: false, shed: true, needDelta: 4 }),
      ],
      headroomAmps: 8,
      smoothedAmps: 6,
      rampDebitAmps: 0,
      nonAcAmps: 0,
      limitAmps: 15,
      calmMs: 60_000,
      config: heavyCfg,
      book: {},
      source: "gen",
      now: T,
      pacing: initialPacingState("gen"),
    });
    expect(p.commands.every((c) => c.kind !== "power_on")).toBe(true);
    expect(p.decisions.some((d) => d.deviceId === "c" && d.blockedBy === "physics envelope")).toBe(true);
  });
});

describe("funding cooldown — the donor must not take its donation back (2026-08-02)", () => {
  // Live 17:06–17:32: Najat was demoted to fund Abdu's raise, re-took the level
  // ~40s later before the saving had reached the meter, was demoted again, and
  // cycled L1↔L2 every ~45s while Abdu — the room the demote was paying for —
  // never climbed at all. The donor's step is cheaper AND higher in priority,
  // so it wins the freed amps every time.
  // A room that genuinely wants a level — otherwise there is no raise to block.
  const donor = () => ac("b", { currentLevel: 1, needDelta: 3 });

  it("blocks the donor's own raise while its cooldown is live", () => {
    expect(raise([donor()]).commands.some((c) => c.deviceId === "b")).toBe(true); // control
    const p = raise([donor()], { fundingCooldown: (id) => id === "b" });
    expect(p.commands.filter((c) => c.deviceId === "b")).toHaveLength(0);
    expect(p.decisions.some((d) => d.deviceId === "b" && d.blockedBy === "funding cooldown")).toBe(true);
  });

  it("does not block anyone else", () => {
    const p = raise([ac("a", { currentLevel: 1, needDelta: 3 })], { fundingCooldown: (id) => id === "b" });
    expect(p.commands.some((c) => c.deviceId === "a" && c.kind === "set_level")).toBe(true);
  });

  it("reports the donors it demoted so the shell can stamp them", () => {
    // A hot room at its floor, a cooler peer above its floor, and a meter too
    // tight for the raise → the funding swap fires.
    const hot = ac("a", { currentLevel: 1, needDelta: 4 });
    const cool = ac("b", { currentLevel: 3, needDelta: 0.2 });
    const p = raise([hot, cool], { headroomAmps: 0.2, smoothedAmps: 14.5 });
    if (p.fundingDonors.length > 0) {
      expect(p.fundingDonors).toContain("b");
      expect(p.commands.some((c) => c.deviceId === "b" && c.kind === "set_level")).toBe(true);
    }
  });
});

describe("invariant corrections", () => {
  it("re-caps a level-0 AC at its top commandable level", () => {
    const { commands } = invariantCorrections(
      [ac("a", { currentLevel: 0 }), ac("c", { currentLevel: 2 })],
      T,
      "gen",
    );
    expect(commands).toEqual([{ deviceId: "a", kind: "set_level", level: 3 }]);
  });

  it("leaves a below-floor room alone — buying its comfort floor back is SPENDING", () => {
    // The reducer parks a room below its boost floor as the last rung before
    // switching it off (2026-08-02). Lifting it back here — with no budget
    // check of any kind — is a limit cycle: the cut frees amps, the floor jumps
    // straight back, the meter goes over, and the reducer cuts again. Six times
    // in thirty minutes in the acceptance run. The raise path owns it instead.
    const { commands } = invariantCorrections([ac("b", { currentLevel: 1, minLevel: 2 })], T, "gen");
    expect(commands).toHaveLength(0);
  });

  it("…and the raise path buys it back once there is headroom for it", () => {
    const p = raise([ac("b", { currentLevel: 1, minLevel: 2, needDelta: 0.1 })]);
    expect(p.commands).toContainEqual({ deviceId: "b", kind: "set_level", level: 2 });
  });

  it("ignores off/unmanaged/shed ACs", () => {
    const { commands } = invariantCorrections(
      [ac("a", { currentLevel: 0, on: false }), ac("b", { currentLevel: 0, managed: false })],
      T,
      "gen",
    );
    expect(commands).toHaveLength(0);
  });
});

// Live 2026-07-30 05:51:07 Baghdad, 15A gen. Najat had been driven to L3 by the
// grid full start, turned off, and came back on 33 minutes into a gen session —
// long after FLOORS had ended. The TCL restored generatorMode 3, so 6.3A landed
// on a 15A line with nothing admitting it; the house rode 16.77A and the user
// hand-set both rooms to L1 two minutes later.
describe("gen turn-on floor clamp (2026-07-30: came back at L3 on a 15A gen)", () => {
  const startingAt = (level: number, overrides: Partial<AcView> = {}): AcView =>
    ac("a", { currentLevel: level, startBaselineAmps: 13.2, ...overrides });

  it("clamps an AC that came on above its floor down to the floor", () => {
    const { commands, decisions } = invariantCorrections([startingAt(3)], T, "gen");
    expect(commands).toEqual([{ deviceId: "a", kind: "set_level", level: 1 }]);
    expect(decisions[0]).toMatchObject({ deviceId: "a", action: "gen start L1" });
  });

  it("is silent once the AC is at or below its floor (self-cancels on confirm)", () => {
    expect(invariantCorrections([startingAt(1)], T, "gen").commands).toHaveLength(0);
  });

  it("never fires on grid — there the start window LIFTS instead", () => {
    expect(invariantCorrections([startingAt(3)], T, "grid").commands).toHaveLength(0);
  });

  it("is silent once the start window has closed", () => {
    const settled = ac("a", { currentLevel: 3, startBaselineAmps: null });
    expect(invariantCorrections([settled], T, "gen").commands).toHaveLength(0);
  });

  it("clamps to the BOOST floor, not L1, when an outdoor boost is active", () => {
    const { commands } = invariantCorrections([startingAt(3, { minLevel: 2 })], T, "gen");
    expect(commands).toEqual([{ deviceId: "a", kind: "set_level", level: 2 }]);
  });

  it("honours a manual cap below the boost floor (manual always wins)", () => {
    const { commands } = invariantCorrections([startingAt(3, { minLevel: 2, manualCap: 1 })], T, "gen");
    expect(commands).toEqual([{ deviceId: "a", kind: "set_level", level: 1 }]);
  });

  it("re-emits while unconfirmed — the clamp is its own confirm-or-resend", () => {
    const inFlight = startingAt(3, { envelopeLevel: 3 });
    expect(invariantCorrections([inFlight], T, "gen").commands).toHaveLength(1);
    expect(invariantCorrections([inFlight], T + 60_000, "gen").commands).toHaveLength(1);
  });
});

describe("grid turn-on full start (2026-07-25: L1 for 4m41s with 5A free)", () => {
  // Grid: limit 27, margin 0.1, resting buffer 0.2 → resting ceiling 26.7.
  // Model base 2 step 2 → steady draw L1 2A, L2 4A, L3 6A.
  const gridCfg: LevelingConfigV2 = { ...cfg, gridLimitAmps: 27 };
  const gridRaise = (acs: AcView[], overrides: Partial<RaiseInput> = {}) =>
    raise(acs, {
      source: "grid",
      config: gridCfg,
      limitAmps: 27,
      smoothedAmps: 18,
      headroomAmps: 8.7,
      pacing: initialPacingState("grid"),
      ...overrides,
    });

  it("lifts a fresh turn-on straight to its ceiling despite the ramp and no calm", () => {
    // The live incident: the AC restores its last gen level (L1) and the ordinary
    // raise path is blocked for the whole 4-min ramp, then creeps one step a batch.
    const p = gridRaise([ac("a", { currentLevel: 1, ramping: true, startBaselineAmps: 17 })], {
      calmMs: 0,
    });
    expect(p.commands).toEqual([{ deviceId: "a", kind: "set_level", level: 3 }]);
    expect(p.decisions.some((d) => d.action === "grid start L1→L3")).toBe(true);
  });

  it("degrades to the highest level the pre-start baseline affords", () => {
    // 21.5 + L3 6 = 27.5 > 26.7; 21.5 + L2 4 = 25.5 fits.
    const p = gridRaise([ac("a", { currentLevel: 1, ramping: true, startBaselineAmps: 21.5 })], {
      calmMs: 0,
    });
    expect(p.commands).toEqual([{ deviceId: "a", kind: "set_level", level: 2 }]);
  });

  it("prices the lift off the pre-start baseline, NOT the ramping meter", () => {
    // The meter still shows 18A because the new compressor's draw hasn't landed:
    // 8.7A of apparent headroom would admit L3 outright. The baseline knows the
    // house was already at 24A without this AC → nothing fits.
    const p = gridRaise([ac("a", { currentLevel: 1, ramping: true, startBaselineAmps: 24 })], {
      calmMs: 0,
    });
    expect(p.commands).toHaveLength(0);
    expect(p.decisions).toContainEqual(
      expect.objectContaining({ deviceId: "a", action: "grid start L3", blockedBy: "no headroom" }),
    );
  });

  it("charges each start its WHOLE draw so two simultaneous starts can't double-spend", () => {
    const p = gridRaise([
      ac("a", { currentLevel: 1, ramping: true, startBaselineAmps: 17, needDelta: 4 }),
      ac("b", { currentLevel: 1, ramping: true, startBaselineAmps: 17, needDelta: 3 }),
    ], { calmMs: 0 });
    // a: 17 + 6 = 23 ≤ 26.7 → L3, committing its whole 6A.
    // b: same baseline, but only 26.7 − 6 = 20.7 left → even L2 (17+4) misses.
    expect(p.commands).toEqual([{ deviceId: "a", kind: "set_level", level: 3 }]);
    expect(p.decisions.some((d) => d.deviceId === "b" && d.blockedBy === "no headroom")).toBe(true);
  });

  it("respects every ceiling: a manual cap clamps the start", () => {
    const p = gridRaise([ac("a", { currentLevel: 1, ramping: true, startBaselineAmps: 17, manualCap: 2 })], {
      calmMs: 0,
    });
    expect(p.commands).toEqual([{ deviceId: "a", kind: "set_level", level: 2 }]);
  });

  it("a near-target room is not full-started (its ceiling is L1)", () => {
    const p = gridRaise([ac("a", { currentLevel: 1, ramping: true, startBaselineAmps: 17, needDelta: 0.2 })], {
      calmMs: 0,
    });
    expect(p.commands).toHaveLength(0);
  });

  it("gen turn-ons keep the floors-first policy — no full start", () => {
    const p = raise([ac("a", { currentLevel: 1, ramping: true, startBaselineAmps: 5 })], { calmMs: 60_000 });
    expect(p.commands).toHaveLength(0);
    // Since 2026-07-30 the gen start window blocks the raise phase for this
    // device outright (it owns the entry policy), so it answers before the
    // ramping gate would have. Same outcome, more specific reason.
    expect(p.decisions.some((d) => d.deviceId === "a" && d.blockedBy === "gen start floor")).toBe(true);
  });

  it("a warm restore cannot jump a gen turn-on back above its floor", () => {
    // warmStartLevel is exempt from the calm AND ramping gates, so before the
    // entry-policy guard it was the one raise that could undo the clamp inside
    // the very batch that emitted it (dedupe keeps the last writer).
    const p = raise([ac("a", { currentLevel: 1, warmStartLevel: 3, startBaselineAmps: 5 })], { calmMs: 60_000 });
    expect(p.commands).toHaveLength(0);
    expect(p.decisions.some((d) => d.deviceId === "a" && d.blockedBy === "gen start floor")).toBe(true);
  });

  it("after the window closes the ordinary one-step meter-anchored path resumes", () => {
    const p = gridRaise([ac("a", { currentLevel: 1, startBaselineAmps: null })], { calmMs: 60_000 });
    expect(p.commands).toEqual([{ deviceId: "a", kind: "set_level", level: 2 }]);
  });
});

// The 2026-07-26 gen trip #1. `planRaise` refused to raise the AC that was
// ramping — and raised its NEIGHBOUR on the headroom that ramping AC was
// already committed to. The journal recorded both facts in the same row.
describe("ramp debit (committed-but-unmetered draw)", () => {
  // Abdu 2-ton: L1 4.3A. Najat 1-ton: L1 2.3, L2 4.3.
  const liveCfg: LevelingConfigV2 = {
    ...cfg,
    genAmpModels: {
      abdu: { baseAmps: 4.3, stepAmps: 2.5 },
      najat: { baseAmps: 2.3, stepAmps: 2 },
    },
  };

  it("charges the whole modeled draw the instant a compressor starts", () => {
    // Restored at L1 with the meter still reading its pre-start value → the
    // meter has absorbed none of the 4.3A.
    const acs = [ac("abdu", { currentLevel: 1, ramping: true, rampBaselineAmps: 10.5 })];
    expect(rampDebitAmps(acs, 10.5, liveCfg, "gen")).toBeCloseTo(4.3, 5);
  });

  it("decays to zero as the meter absorbs the ramp", () => {
    const acs = [ac("abdu", { currentLevel: 1, ramping: true, rampBaselineAmps: 10.5 })];
    expect(rampDebitAmps(acs, 12.5, liveCfg, "gen")).toBeCloseTo(2.3, 5); // 4.3 − 2.0 risen
    expect(rampDebitAmps(acs, 14.8, liveCfg, "gen")).toBe(0); // fully absorbed
    expect(rampDebitAmps(acs, 20, liveCfg, "gen")).toBe(0); // never goes negative
  });

  it("charges the full draw when the baseline is unknown (post-restart ramp)", () => {
    const acs = [ac("abdu", { currentLevel: 1, ramping: true, rampBaselineAmps: null })];
    expect(rampDebitAmps(acs, 99, liveCfg, "gen")).toBeCloseTo(4.3, 5);
  });

  it("ignores ACs that are off, shed, unmanaged or already settled", () => {
    const acs = [
      ac("abdu", { currentLevel: 1, ramping: false, rampBaselineAmps: 10.5 }),
      ac("najat", { on: false, shed: true, ramping: true, rampBaselineAmps: 10.5 }),
      ac("c", { managed: false, ramping: true, rampBaselineAmps: 10.5 }),
    ];
    expect(rampDebitAmps(acs, 10.5, liveCfg, "gen")).toBe(0);
  });

  it("blocks a PEER raise while a neighbour is still ramping in (the incident)", () => {
    // Live 10:26:22: Abdu restored 37s earlier at L1, meter 10.11A, resting
    // ceiling 14.7 → 4.6A of apparent headroom, and Najat L1→L2 costs 2.0A.
    // Charging Abdu's un-absorbed 4.3A leaves 0.3A and the raise is refused.
    const acs = [
      ac("abdu", { currentLevel: 1, needDelta: 3, ramping: true, rampBaselineAmps: 10.5 }),
      ac("najat", { currentLevel: 1, needDelta: 2.5 }),
    ];
    const p = planRaise({
      acs,
      headroomAmps: 4.59,
      smoothedAmps: 10.11,
      rampDebitAmps: rampDebitAmps(acs, 10.11, liveCfg, "gen"),
      nonAcAmps: 0,
      limitAmps: 15,
      calmMs: 60_000,
      config: liveCfg,
      book: {},
      source: "gen",
      now: T,
      pacing: initialPacingState("gen"),
    });
    expect(p.commands).toEqual([]);
    expect(p.decisions).toContainEqual(
      expect.objectContaining({ deviceId: "najat", blockedBy: "no headroom" }),
    );
  });

  it("lets the same peer raise through once the meter has caught up", () => {
    const acs = [
      ac("abdu", { currentLevel: 1, needDelta: 3, ramping: true, rampBaselineAmps: 10.5 }),
      ac("najat", { currentLevel: 1, needDelta: 2.5 }),
    ];
    const p = planRaise({
      acs,
      headroomAmps: 4.59,
      smoothedAmps: 14.8, // Abdu's 4.3A is fully on the meter now
      rampDebitAmps: rampDebitAmps(acs, 14.8, liveCfg, "gen"),
      nonAcAmps: 0,
      limitAmps: 15,
      calmMs: 60_000,
      config: liveCfg,
      book: {},
      source: "gen",
      now: T,
      pacing: initialPacingState("gen"),
    });
    expect(p.commands).toEqual([{ deviceId: "najat", kind: "set_level", level: 2 }]);
  });

  it("keeps the absorption a peer reduction later masked (2026-07-27 fan stall)", () => {
    // Live 16:47→16:53: Najat came on with the house at 14.3A and the meter had
    // risen ~1.0A into her ramp by 16:49:21. The reducer then cut ~2.5A off two
    // peers, landing the house 1.5A BELOW her baseline — instant absorption
    // clamps to 0 and re-charges her whole 2.3A for the rest of the 240s window,
    // which fenced the fan restore for 2 more minutes. The ratcheted peak keeps
    // what the meter already proved arrived.
    const acs = [
      ac("najat", {
        currentLevel: 1,
        ramping: true,
        rampBaselineAmps: 14.3,
        rampAbsorbedAmps: 1.0,
      }),
    ];
    expect(rampDebitAmps(acs, 12.8, liveCfg, "gen")).toBeCloseTo(1.3, 5);
  });

  it("uses the live rise while it is still climbing past the ratchet", () => {
    const acs = [
      ac("najat", { currentLevel: 1, ramping: true, rampBaselineAmps: 10.5, rampAbsorbedAmps: 0.4 }),
    ];
    expect(rampDebitAmps(acs, 12.0, liveCfg, "gen")).toBeCloseTo(0.8, 5); // 2.3 − 1.5 live
  });

  it("never lets a stale ratchet credit a baseline-less ramp", () => {
    const acs = [
      ac("najat", { currentLevel: 1, ramping: true, rampBaselineAmps: null, rampAbsorbedAmps: 2 }),
    ];
    expect(rampDebitAmps(acs, 99, liveCfg, "gen")).toBeCloseTo(2.3, 5);
  });

  it("a shed restore is charged the debit too, and says so", () => {
    const acs = [
      ac("abdu", { currentLevel: 1, needDelta: 1, ramping: true, rampBaselineAmps: 10.5 }),
      ac("najat", { on: false, shed: true, needDelta: 4 }),
    ];
    const p = planRaise({
      acs,
      headroomAmps: 4.59,
      smoothedAmps: 10.11,
      rampDebitAmps: rampDebitAmps(acs, 10.11, liveCfg, "gen"),
      nonAcAmps: 0,
      limitAmps: 15,
      calmMs: 60_000,
      config: liveCfg,
      book: {},
      source: "gen",
      now: T,
      pacing: initialPacingState("gen"),
    });
    expect(p.commands).toEqual([]);
    const blocked = p.decisions.find((d) => d.deviceId === "najat");
    expect(blocked?.blockedBy).toBe("no headroom");
    expect(blocked?.detail).toContain("ramping in");
  });
});

// The 2026-07-28 evening state: Najat satisfied and parked at L3 holding 6.3A
// of a 15A gen, Abdu's room 1.9°C hot and pinned at L1 because the envelope
// says 9.3 + 6.3 = 15.6 > 14.9. Nothing ever reclaimed her dormant levels.
describe("funding swap — dormant peer levels pay for a hot room", () => {
  const liveCfg: LevelingConfigV2 = {
    ...cfg,
    genLimitAmps: 15,
    genAmpModels: {
      abdu: { baseAmps: 4.3, stepAmps: 2.5 },
      najat: { baseAmps: 2.3, stepAmps: 2.0 },
    },
  };
  const swap = (overrides: Partial<RaiseInput> = {}) =>
    planRaise({
      acs: [ac("najat", { currentLevel: 3, needDelta: 0.3 }), ac("abdu", { currentLevel: 2, needDelta: 1.9 })],
      headroomAmps: 3.0,
      smoothedAmps: 11.7,
      rampDebitAmps: 0,
      nonAcAmps: 0,
      limitAmps: 15,
      calmMs: 60_000,
      config: liveCfg,
      book: {},
      source: "gen",
      now: T,
      pacing: initialPacingState("gen"),
      ...overrides,
    });

  it("envelope-blocked but meter-funded: demote and raise ship in ONE batch, cuts first", () => {
    const p = swap();
    expect(p.commands).toEqual([
      { deviceId: "najat", kind: "set_level", level: 1 },
      { deviceId: "abdu", kind: "set_level", level: 3 },
    ]);
    expect(p.cutAmps).toBeCloseTo(4.0, 5); // najat 6.3 → 2.3, model-priced
    expect(p.decisions.some((d) => d.action.includes("funded by peer demote"))).toBe(true);
  });

  it("meter-blocked: the demote ships ALONE — never spend savings that have not landed", () => {
    // Only 1.0A of real headroom; Abdu's L2→L3 needs 2.5A. Shipping both would
    // commit ~16A on a breaker that tripped at 15.65A on 2026-07-26 while the
    // satisfied compressor takes minutes to throttle down.
    const p = swap({ headroomAmps: 1.0, smoothedAmps: 13.7 });
    expect(p.commands).toEqual([{ deviceId: "najat", kind: "set_level", level: 1 }]);
    expect(p.decisions.some((d) => d.deviceId === "abdu" && d.blockedBy === "awaiting demote")).toBe(true);
  });

  it("never harvests a manually pinned peer", () => {
    const p = swap({
      acs: [
        ac("najat", { currentLevel: 3, needDelta: 0.3, manualTarget: 3 }),
        ac("abdu", { currentLevel: 2, needDelta: 1.9 }),
      ],
    });
    expect(p.commands.filter((c) => c.deviceId === "najat")).toHaveLength(0);
    expect(p.decisions.some((d) => d.deviceId === "abdu" && d.blockedBy === "physics envelope")).toBe(true);
  });

  it("never harvests a peer that still needs its level", () => {
    const p = swap({
      acs: [
        ac("najat", { currentLevel: 3, needDelta: 2.5 }),
        ac("abdu", { currentLevel: 2, needDelta: 1.9 }),
      ],
    });
    expect(p.commands.filter((c) => c.deviceId === "najat")).toHaveLength(0);
  });

  it("the swapped end-state is still envelope-checked", () => {
    // Boost floor pins Najat at L2 (4.3A), so the best swap is 9.3 + 4.3 = 13.6
    // ≤ 14.9 — allowed. Raise the floor to L3 and there is nothing to give.
    const pinnedHigh = swap({
      acs: [
        ac("najat", { currentLevel: 3, needDelta: 0.3, minLevel: 3 }),
        ac("abdu", { currentLevel: 2, needDelta: 1.9 }),
      ],
    });
    expect(pinnedHigh.commands).toHaveLength(0);
    expect(pinnedHigh.decisions.some((d) => d.blockedBy === "physics envelope")).toBe(true);
  });
});

// User request 2026-08-01: "when everything is stable and one AC runs on an
// extra level but the other is on base level and the room is HOTTER, switch
// the extra level to that one." The satisfied-harvest above cannot do this —
// a donor above the near-target band keeps ceilOf = max and is untouchable,
// so a warm-but-not-hot room held its level while a much hotter room sat at
// base forever. Comparative need arbitrates instead: a peer ≥ the need gap
// COOLER may donate ONE step (never past its floor, never a manual pin),
// coolest room first, only as many donors as the deficit needs.
describe("need rebalance — the extra level follows the hotter room", () => {
  const liveCfg: LevelingConfigV2 = {
    ...cfg,
    genLimitAmps: 15,
    genAmpModels: {
      abdu: { baseAmps: 4.3, stepAmps: 2.5 },
      najat: { baseAmps: 2.3, stepAmps: 2.0 },
    },
  };
  // Najat warm (0.8°C — above the band, so NOT satisfied) holding L2; Abdu's
  // 2-ton room 2.4°C hot at L1. The live 2026-08-01 evening shape.
  const rebal = (overrides: Partial<RaiseInput> = {}) =>
    planRaise({
      acs: [ac("najat", { currentLevel: 2, needDelta: 0.8 }), ac("abdu", { currentLevel: 1, needDelta: 2.4 })],
      headroomAmps: 1.9,
      smoothedAmps: 12.7,
      rampDebitAmps: 0,
      nonAcAmps: 0,
      limitAmps: 15,
      calmMs: 60_000,
      config: liveCfg,
      book: {},
      source: "gen",
      now: T,
      pacing: initialPacingState("gen"),
      ...overrides,
    });

  it("meter-blocked: the cooler room's step ships ALONE, the raise follows once it lands", () => {
    // Abdu's 2.5A step vs 1.9A available — deficit 0.6A, Najat's step frees 2.0A.
    const p = rebal();
    expect(p.commands).toEqual([{ deviceId: "najat", kind: "set_level", level: 1 }]);
    expect(p.cutAmps).toBeCloseTo(2.0, 5);
    expect(p.decisions.some((d) => d.deviceId === "abdu" && d.blockedBy === "awaiting demote")).toBe(true);
  });

  it("envelope-blocked but meter-funded: donor step and raise ship in ONE batch", () => {
    // House 4.0A breaks the envelope (11.1 + 4.0 = 15.1 > 14.9); with Najat at
    // L1 it is 9.1 + 4.0 = 13.1, and the meter already holds Abdu's 2.5A step.
    const p = rebal({ nonAcAmps: 4.0, headroomAmps: 3.0, smoothedAmps: 11.6 });
    expect(p.commands).toEqual([
      { deviceId: "najat", kind: "set_level", level: 1 },
      { deviceId: "abdu", kind: "set_level", level: 2 },
    ]);
    expect(p.decisions.some((d) => d.action.includes("funded by peer demote"))).toBe(true);
  });

  it("one step per swap — a donor two levels up still gives only one", () => {
    const p = rebal({
      acs: [ac("najat", { currentLevel: 3, needDelta: 0.8 }), ac("abdu", { currentLevel: 1, needDelta: 2.4 })],
      headroomAmps: 1.0,
      smoothedAmps: 13.6,
    });
    expect(p.commands).toEqual([{ deviceId: "najat", kind: "set_level", level: 2 }]);
  });

  it("inside the need gap nothing moves — near-equal rooms must not trade levels", () => {
    const p = rebal({
      acs: [ac("najat", { currentLevel: 2, needDelta: 1.9 }), ac("abdu", { currentLevel: 1, needDelta: 2.4 })],
    });
    expect(p.commands).toHaveLength(0);
    expect(p.decisions.some((d) => d.deviceId === "abdu" && d.blockedBy === "no headroom")).toBe(true);
  });

  it("a manual pin is never donated", () => {
    const p = rebal({
      acs: [
        ac("najat", { currentLevel: 2, needDelta: 0.8, manualTarget: 2 }),
        ac("abdu", { currentLevel: 1, needDelta: 2.4 }),
      ],
    });
    expect(p.commands).toHaveLength(0);
  });

  it("a boost floor is never donated", () => {
    const p = rebal({
      acs: [
        ac("najat", { currentLevel: 2, needDelta: 0.8, minLevel: 2 }),
        ac("abdu", { currentLevel: 1, needDelta: 2.4 }),
      ],
    });
    expect(p.commands).toHaveLength(0);
  });

  it("a receiver already above its floor does not trade — it competes through the budget", () => {
    // Abdu at L2 wanting L3: he already holds an extra level. Letting him milk
    // a milder peer for a step he cannot fund is the resting-point limit cycle.
    const p = rebal({
      acs: [ac("najat", { currentLevel: 2, needDelta: 0.8 }), ac("abdu", { currentLevel: 2, needDelta: 2.4 })],
    });
    expect(p.commands).toHaveLength(0);
  });

  it("a trade never arms on a noise dip — the raise must fit with margin after the cut", () => {
    // 0.9A available: Najat's 2.0A step leaves 2.9A < 2.5A + 0.5A margin.
    const p = rebal({ headroomAmps: 0.9, smoothedAmps: 13.7 });
    expect(p.commands).toHaveLength(0);
    expect(p.decisions.some((d) => d.deviceId === "abdu" && d.blockedBy === "no headroom")).toBe(true);
  });

  it("comfort is not spent for nothing — donors that cannot cover the deficit stay put", () => {
    // Zero headroom: Abdu needs the whole 2.5A step and Najat can free only
    // 2.0A. Demoting her would cool a warm room and still not fund the raise.
    const p = rebal({ headroomAmps: 0, smoothedAmps: 14.6 });
    expect(p.commands).toHaveLength(0);
    expect(p.decisions.some((d) => d.deviceId === "abdu" && d.blockedBy === "no headroom")).toBe(true);
  });
});

// 2026-07-26: Najat was raised L1→L2 and then L2→L3 just 35s apart, both
// admitted against a meter that had absorbed almost none of the first jump —
// a level raise never arms `ramping`, so nothing charged its committed draw.
// The physics envelope can't cover this: it excludes non-AC load by design.
describe("post-raise jump debit (2026-07-26 back-to-back raises)", () => {
  it("charges an unabsorbed jump against the next spender", () => {
    // The pipeline feeds rampDebitAmps() into planRaise, so compose them here
    // exactly as the calm branch does.
    const acs = [ac("a", { needDelta: 3, currentLevel: 2, unmeteredJumpAmps: 2.0 })];
    const debit = rampDebitAmps(acs, 12.1, cfg, "gen");
    expect(debit).toBeCloseTo(2.0, 5);
    const p = raise(acs, { headroomAmps: 2.6, rampDebitAmps: debit });
    expect(p.commands).toHaveLength(0);
    expect(p.decisions.some((d) => d.blockedBy === "no headroom")).toBe(true);
  });

  it("allows the next raise once the meter has absorbed the previous one", () => {
    const acs = [ac("a", { needDelta: 3, currentLevel: 2, unmeteredJumpAmps: 0 })];
    const p = raise(acs, { headroomAmps: 2.6, rampDebitAmps: rampDebitAmps(acs, 12.1, cfg, "gen") });
    expect(p.commands).toEqual([{ deviceId: "a", kind: "set_level", level: 3 }]);
  });

  it("does not double-charge an AC that is ALSO ramping (turn-on debit subsumes it)", () => {
    // Ramping AC at L1: the turn-on debit already charges its whole 2A steady
    // draw; adding the jump on top would charge the same amps twice.
    const ramping = ac("a", {
      needDelta: 3,
      currentLevel: 1,
      ramping: true,
      rampBaselineAmps: 10.0,
      rampAbsorbedAmps: 0,
      unmeteredJumpAmps: 1.5,
    });
    expect(rampDebitAmps([ramping], 10.0, cfg, "gen")).toBeCloseTo(2.0, 5);
  });

  it("charges the jump for a non-ramping AC", () => {
    const raised = ac("a", { currentLevel: 2, unmeteredJumpAmps: 1.5 });
    expect(rampDebitAmps([raised], 10.0, cfg, "gen")).toBeCloseTo(1.5, 5);
  });

  it("ignores the jump for an off or shed AC", () => {
    expect(rampDebitAmps([ac("a", { on: false, unmeteredJumpAmps: 1.5 })], 10.0, cfg, "gen")).toBe(0);
    expect(rampDebitAmps([ac("a", { shed: true, on: false, unmeteredJumpAmps: 1.5 })], 10.0, cfg, "gen")).toBe(0);
  });
});

// 2026-07-31, 15A gen. The envelope summed only the AC caps and admitted
// Abdullah L2→L3 at a modeled 13.9A against a 14.9A ceiling — twice. The
// journal then measured that exact end-state at 15.93–15.99A. The whole 2.0A
// gap was the house the guard had never counted, and the breaker went.
describe("house load in the raise envelope (2026-07-31 gen trip)", () => {
  const liveCfg: LevelingConfigV2 = {
    ...cfg,
    genLimitAmps: 15,
    genAmpModels: {
      abdullah: { baseAmps: 2.3, stepAmps: 2.5 }, // L2 4.8, L3 7.3
      najat: { baseAmps: 2.3, stepAmps: 2.0 },    // L1 2.3
      abdu: { baseAmps: 4.3, stepAmps: 2.5 },     // L1 4.3
    },
  };
  // The live state at 17:29:44: everyone at their floor except Abdullah, who
  // wants L3. Abdullah's boost floor is L2, so nothing here is harvestable.
  const incident = (overrides: Partial<RaiseInput> = {}) =>
    planRaise({
      acs: [
        ac("abdullah", { currentLevel: 2, minLevel: 2, needDelta: 7 }),
        ac("najat", { currentLevel: 1, needDelta: 1.1 }),
        ac("abdu", { currentLevel: 1, needDelta: 2.4 }),
      ],
      headroomAmps: 4.79, // resting ceiling 14.7 − the 9.91A trough it was admitted on
      smoothedAmps: 9.91,
      rampDebitAmps: 0,
      nonAcAmps: 0,
      limitAmps: 15,
      calmMs: 60_000,
      config: liveCfg,
      book: {},
      source: "gen",
      now: T,
      pacing: initialPacingState("gen"),
      ...overrides,
    });

  it("reproduces the bug: with no house term the raise is admitted", () => {
    expect(incident().commands).toEqual([{ deviceId: "abdullah", kind: "set_level", level: 3 }]);
  });

  it("vetoes the same raise once the measured house load is counted", () => {
    // 13.9 AC + 1.6 house = 15.5 > 14.9.
    const p = incident({ nonAcAmps: 1.6 });
    expect(p.commands).toHaveLength(0);
    const veto = p.decisions.find((d) => d.deviceId === "abdullah" && d.blockedBy === "physics envelope");
    expect(veto?.detail).toContain("15.5");
    expect(veto?.detail).toContain("1.6A house");
  });

  it("still admits it when the house is genuinely small", () => {
    // 13.9 + 0.5 = 14.4 ≤ 14.9 — the guard tightens, it does not blanket-refuse.
    expect(incident({ nonAcAmps: 0.5 }).commands).toEqual([
      { deviceId: "abdullah", kind: "set_level", level: 3 },
    ]);
  });

  it("degrades a multi-step target instead of stranding the room", () => {
    // A warm restore to L3 is envelope-blocked at 15.5, but L2 (11.4 + 1.6 =
    // 13.0) fits — the guard is monotonic in level, so it steps down.
    const p = incident({
      acs: [
        ac("abdullah", { currentLevel: 1, needDelta: 7, warmStartLevel: 3 }),
        ac("najat", { currentLevel: 1, needDelta: 1.1 }),
        ac("abdu", { currentLevel: 1, needDelta: 2.4 }),
      ],
      nonAcAmps: 1.6,
    });
    expect(p.commands).toEqual([{ deviceId: "abdullah", kind: "set_level", level: 2 }]);
  });

  it("leaves shed RESTORES on the AC-only envelope — a room off is worse than a tight ride", () => {
    // Abdullah shed. Peers at floors: 2.3 + 4.3 = 6.6, plus his floor 4.8 =
    // 11.4 AC-only ≤ 14.9 → he comes back. Adding a 4A house would have vetoed
    // it and stranded the room off entirely; the meter gate below is what keeps
    // a genuinely unaffordable restore out.
    const p = incident({
      acs: [
        ac("abdullah", { on: false, shed: true, minLevel: 2, needDelta: 7 }),
        ac("najat", { currentLevel: 1, needDelta: 1.1 }),
        ac("abdu", { currentLevel: 1, needDelta: 2.4 }),
      ],
      nonAcAmps: 4.0,
      smoothedAmps: 8.0,
      headroomAmps: 6.7,
    });
    expect(p.commands).toContainEqual(
      expect.objectContaining({ deviceId: "abdullah", kind: "power_on", reason: "restore" }),
    );
  });
});
