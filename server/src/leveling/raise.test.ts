import { describe, it, expect } from "vitest";
import {
  envelopeTotalAmps,
  FLICKER_PATIENCE_MS,
  invariantCorrections,
  planRaise,
  rampDebitAmps,
  REBALANCE_NEED_GAP_C,
  swapDonorFor,
  SWAP_NEED_GAP_C,
  SWAP_QUIET_AFTER_OVER_MS,
  type RaiseInput,
} from "./raise.js";
import { SHED_NEED_GAP_C } from "./reduce.js";
import { PENDING_CUT_MS } from "./sensing.js";
import { initialPacingState, noteAttempt, noteFailure, probeRearmed } from "./pacing.js";
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
    recentlyExternalOn: false,
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

function raise(acs: AcView[], overrides: Partial<RaiseInput> = {}) {
  return planRaise({
    acs,
    headroomAmps: 2.6, // e.g. smoothed 12.1 vs resting ceiling 14.7
    smoothedAmps: 12.1,
    rampDebitAmps: 0,
    // The AC-only envelope these cases were written against; the house term
    // gets its own suite below.
    nonAcAmps: 0,
    // A quiet line by default: the flicker charge is a MARGIN, so 0 leaves
    // every case written before 2026-08-06 admitting exactly what it did.
    flickerMarginAmps: 0,
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

// ---------------------------------------------------------------------------
// R8b — raises admit in NEED order, and the order has to MEAN something.
//
// Orchestrator ruling, 2026-08-04, from the stage-2 reading of the 08-03
// journal: at 17:13:36 the MILDEST room (need 1.9) took 2.0A while the HOTTEST
// (need 8.0) was refused its step by 0.2A, and the funding swap then spent
// three commands undoing it. The list was already sorted hottest-first; what it
// lacked was any consequence for a refusal.
//
// The gap is `SHED_NEED_GAP_C`, the same constant the recovery admission uses
// for the same question in the other direction — one gap rule, not a second.
// ---------------------------------------------------------------------------
describe("a refused hot room keeps its amps unless the next room is clearly milder (R8b)", () => {
  // `a` is the 2-ton (3.0A a step), `b` a 1-ton (1.5A). Only ~2A of headroom
  // exists: enough for b's step, short of a's.
  const models = {
    ...cfg,
    ampModels: { a: { baseAmps: 4, stepAmps: 3 }, b: { baseAmps: 2, stepAmps: 1.5 } },
  };
  const pair = (coolNeed: number): AcView[] => [
    ac("a", { currentLevel: 2, needDelta: 8, rankNeedDelta: 8 }),
    ac("b", { currentLevel: 1, needDelta: coolNeed, rankNeedDelta: coolNeed }),
  ];

  it("a near-equal room waits — the amps stay with the hotter one", () => {
    const p = raise(pair(7.5), { headroomAmps: 2.0, smoothedAmps: 12.1, config: models });
    expect(p.commands).toHaveLength(0);
    expect(p.decisions).toContainEqual(
      expect.objectContaining({ deviceId: "a", blockedBy: "no headroom" }),
    );
    expect(p.decisions).toContainEqual(
      expect.objectContaining({ deviceId: "b", blockedBy: "needier room waiting" }),
    );
  });

  it("a clearly milder room still takes amps the hot room cannot use", () => {
    // Same arithmetic, but b is 6.5°C milder — well past the gap. Refusing it
    // would be pure waste: the amps help nobody while a waits for more.
    const p = raise(pair(1.5), { headroomAmps: 2.0, smoothedAmps: 12.1, config: models });
    expect(p.commands).toContainEqual({ deviceId: "b", kind: "set_level", level: 2 });
  });

  it("a room merely waiting out its own cooldown does not fence its peers", () => {
    // `a` is inside the victim cooldown — not competing for amps, serving a
    // sentence, and the gate expires on its own. A peer taking the headroom
    // meanwhile costs it nothing.
    const p = raise(pair(7.5), {
      headroomAmps: 2.0,
      smoothedAmps: 12.1,
      config: models,
      victimCooldown: (id) => id === "a",
    });
    expect(p.commands).toContainEqual({ deviceId: "b", kind: "set_level", level: 2 });
  });
});

// ---------------------------------------------------------------------------
// R9 — the trough a shed digs outlives the credit that explains it.
//
// Invariant 41 floors the committed meter at `cutAnchorAmps − commandedCutAmps`
// while a cut is in flight, and that claim dies with `PENDING_CUT_MS` (180 s) or
// with the absorption that spends it. Live 07:19→07:20 on 2026-08-04 a restore
// was admitted THIRTY-ONE SECONDS after the shed that caused it, and four times
// on 2026-08-02 — the credit had cleared early, the meter was sitting in the
// hole the room's own departure made, and the room looked affordable again.
//
// So the bar is also kept per ROOM, for one blame window from its own shed.
// ---------------------------------------------------------------------------
describe("a room's own shed leaves a bar its restore must clear (R9)", () => {
  const shedRoom = (): AcView[] => [
    ac("a", { needDelta: 2 }),
    ac("b", { on: false, shed: true, needDelta: 4 }),
  ];

  it("refuses the restore judged on the trough, once the credit has already cleared", () => {
    // No cut in flight at all — exactly the state 31 s after a shed whose credit
    // expired or was absorbed. The meter reads 9.5A; the house this room was
    // shed OUT OF was 12.9A, and its 2.0A return does not fit there.
    const p = raise(shedRoom(), {
      smoothedAmps: 9.5,
      headroomAmps: 5.2,
      cutAnchorAmps: 0,
      commandedCutAmps: 0,
      limitAmps: 13.0,
      shedBarAmps: (id) => (id === "b" ? 12.9 : 0),
    });
    expect(p.commands).not.toContainEqual(
      expect.objectContaining({ deviceId: "b", kind: "power_on" }),
    );
    expect(p.decisions).toContainEqual(
      expect.objectContaining({ deviceId: "b", blockedBy: "own shed trough" }),
    );
  });

  it("reserves those amps rather than handing them to a peer's raise", () => {
    // The bar is a claim about the HOUSE: if the shed room cannot be afforded at
    // that figure, nobody can. Skipping (reserving nothing) would let the raise
    // phase spend the very trough the bar exists to disbelieve.
    const p = raise(shedRoom(), {
      smoothedAmps: 9.5,
      headroomAmps: 5.2,
      cutAnchorAmps: 0,
      commandedCutAmps: 0,
      limitAmps: 13.0,
      shedBarAmps: (id) => (id === "b" ? 12.9 : 0),
    });
    expect(p.reservedAmps).toBeGreaterThan(0);
    expect(p.commands.filter((c) => c.kind === "set_level")).toHaveLength(0);
    expect(p.decisions).toContainEqual(
      expect.objectContaining({ action: "raises", blockedBy: "restore reservation" }),
    );
  });

  it("admits it once the bar has aged out — a bar is a window, not a verdict", () => {
    const p = raise(shedRoom(), {
      smoothedAmps: 9.5,
      headroomAmps: 5.2,
      limitAmps: 13.0,
      shedBarAmps: () => 0,
    });
    expect(p.commands).toContainEqual(
      expect.objectContaining({ deviceId: "b", kind: "power_on", reason: "restore" }),
    );
  });

  it("a bar BELOW the live meter changes nothing — the meter is the truth again", () => {
    // The house grew since the shed; judging on the older, lower figure would be
    // the mirror of the bug (admitting on a stale claim instead of a trough).
    const p = raise(shedRoom(), {
      smoothedAmps: 9.5,
      headroomAmps: 5.2,
      limitAmps: 13.0,
      shedBarAmps: (id) => (id === "b" ? 8.0 : 0),
    });
    expect(p.commands).toContainEqual(
      expect.objectContaining({ deviceId: "b", kind: "power_on", reason: "restore" }),
    );
  });
});

// ---------------------------------------------------------------------------
// 2026-08-07 bounce backoff — the bar release valves. A room the bar holds back
// against a low (trough) meter must let go the moment the arithmetic changes:
// the ceiling rises (a derate recovers) or the price genuinely fits. The bar is
// an absolute-amps claim about the house, so this falls out of keeping it a
// number — but it is pinned here because it is the "can never strand" half of
// the compounded bar persistence.
// ---------------------------------------------------------------------------
describe("2026-08-07 bounce backoff: the shed bar self-releases when the ceiling rises", () => {
  const shedRoom = (): AcView[] => [
    ac("a", { needDelta: 2 }),
    ac("b", { on: false, shed: true, needDelta: 4 }),
  ];

  it("ceiling 14.5 refuses on the bar; ceiling 15.0 admits (bar + price fits)", () => {
    // Bar 12.9, restore price 2.0 → 14.9A. The trough meter (11.0) plus the price
    // fits either ceiling, but the BAR does not fit 14.5 and does fit 15.0.
    const refused = raise(shedRoom(), {
      smoothedAmps: 11.0,
      headroomAmps: 3.4,
      limitAmps: 14.6, // restore ceiling 14.5
      shedBarAmps: (id) => (id === "b" ? 12.9 : 0),
    });
    expect(refused.commands.every((c) => c.kind !== "power_on")).toBe(true);
    expect(refused.decisions).toContainEqual(
      expect.objectContaining({ deviceId: "b", blockedBy: "own shed trough" }),
    );

    const admitted = raise(shedRoom(), {
      smoothedAmps: 11.0,
      headroomAmps: 3.9,
      limitAmps: 15.1, // restore ceiling 15.0 — the derate recovered
      shedBarAmps: (id) => (id === "b" ? 12.9 : 0),
    });
    expect(admitted.commands).toContainEqual(
      expect.objectContaining({ deviceId: "b", kind: "power_on", reason: "restore" }),
    );
  });

  it("the compounded bar OUTRANKS the probe re-arm — a bounce says 'we tried and failed'", () => {
    // The probe re-arm (invariant 22) would fire — the meter sits a full amp
    // below the failed attempt's anchor — but under bounce evidence the bar
    // still holds the trough, and the refusal is LOUD about it. The probe governs
    // the price once the bar releases; it may not spend the trough now.
    const bounced = noteFailure(
      noteAttempt(initialPacingState("gen"), "b", "restore", T - 95_000, 12.5),
      "b",
      "restore",
      T - 31_000, // its 30 s ladder rung has expired — canAttempt is not the gate here
    );
    expect(probeRearmed(bounced, "b", 11.0)).toBe(true); // the re-arm WOULD fire
    const p = raise(shedRoom(), {
      smoothedAmps: 11.0,
      headroomAmps: 3.4,
      limitAmps: 14.6, // restore ceiling 14.5 — bar 12.9 + 2.0 does not fit
      pacing: bounced,
      shedBarAmps: (id) => (id === "b" ? 12.9 : 0),
    });
    expect(p.commands.every((c) => c.kind !== "power_on")).toBe(true);
    const trough = p.decisions.find((d) => d.deviceId === "b" && d.blockedBy === "own shed trough");
    expect(trough?.detail).toContain("bounce backoff");
    expect(trough?.detail).toContain("1st bounce");
  });
});

// ---------------------------------------------------------------------------
// 2026-08-06 14:00–14:04Z — the restore that could not survive, and cost a
// second room its compressor. User: "why did it turn off both Najat and
// Abdullah, when Najat-only-off was fine?"
//
// A saturated generator house (≈5A heater, every level at its floor, fans
// already trimmed) shed Najat at 14:00:32 and settled at 11.6A. THIRTY-FOUR
// SECONDS later the restore path bought her straight back: committed 12.12A,
// probe cost 2.3A → 14.42A against a 14.9A ceiling. Admitted with 0.48A to
// spare, on a line whose measured flicker was ±0.4–0.8A. Her compressor and two
// held fans then took the smoothed meter to 15.3A, she was re-shed at 14:04:10
// — and because her own cut had not crossed the 8-wide median yet, Abdullah
// went off 14 seconds after that.
//
// The restore ceiling is deliberately exempt from `restingBufferAmps` ("a whole
// room off is worse than riding near the limit"). That trade is about a STEADY
// line: riding near the limit on a MEASURED-wobbly one is not a tight ride, it
// is a bounce with a delay, and a bounce costs the room an off/on cycle plus
// the backoff ladder. So the fixed buffer is replaced by a measured one.
// ---------------------------------------------------------------------------
describe("a restore may not spend the wobble of the supply itself (2026-08-06 double shed)", () => {
  const shedRoom = (): AcView[] => [
    ac("a", { needDelta: 2 }),
    ac("b", { on: false, shed: true, needDelta: 4 }),
  ];

  it("admits with margin on a quiet line and refuses the identical restore on a wobbly one", () => {
    // 12.6 + 2.0 = 14.6 against 14.9: the live 0.48A margin, near enough.
    const quiet = raise(shedRoom(), { smoothedAmps: 12.6, headroomAmps: 2.0 });
    expect(quiet.commands).toContainEqual({
      deviceId: "b",
      kind: "power_on",
      level: 1,
      reason: "restore",
      fan: 1,
    });
    const wobbly = raise(shedRoom(), { smoothedAmps: 12.6, headroomAmps: 2.0, flickerMarginAmps: 0.4 });
    expect(wobbly.commands.every((c) => c.kind !== "power_on")).toBe(true);
    // …and the journal says WHY, or the next forensic session re-derives it. It
    // is its own refusal tag now (invariant 58 follow-up): a room that fits the
    // bare ceiling is flicker-refused, not out of headroom, and the difference is
    // whether patience will eventually admit it.
    expect(wobbly.decisions).toContainEqual(
      expect.objectContaining({
        deviceId: "b",
        action: "restore",
        blockedBy: "flicker margin",
        detail: expect.stringContaining("flicker"),
      }),
    );
  });

  it("charges the PROBE price identically — a stale-high learned cost is no licence", () => {
    // The live admission was a probe (2.3A against a learned price that
    // blocked). The probe re-runs the same fit test, so it inherits the charge:
    // 12.5 + 2.0 = 14.5 fits the bare ceiling and not the charged one.
    const book = updateCost({}, "b", "gen", "on@L1", 4, T);
    const quiet = raise(shedRoom(), { smoothedAmps: 12.5, headroomAmps: 2.2, book });
    expect(quiet.probeRestoreIds).toEqual(["b"]);
    const wobbly = raise(shedRoom(), {
      smoothedAmps: 12.5,
      headroomAmps: 2.2,
      book,
      flickerMarginAmps: 0.5,
    });
    expect(wobbly.commands.every((c) => c.kind !== "power_on")).toBe(true);
    expect(wobbly.probeRestoreIds).toEqual([]);
  });

  it("a standing flicker-only refusal RESERVES its amps and reports itself to the shell", () => {
    // Invariant 58 follow-up (2026-08-08): the "ordinary skip" this used to be
    // stranded rooms that ultimately ran fine behind the wobble, and let a peer
    // raise spend the very amps they were waiting on (58's own open item). Once
    // the anchor stands, the amps are spoken for: the raise phase is PARKED, and
    // the room is reported in `flickerRefused` so the shell keeps its anchor.
    const p = raise(shedRoom(), {
      smoothedAmps: 12.6,
      headroomAmps: 2.0,
      flickerMarginAmps: 0.4,
      // An anchor already stands, well inside the patience window.
      flickerRefusedSince: () => T - 30_000,
    });
    expect(p.flickerRefused).toEqual(["b"]);
    // b returns at its 2.0A floor cost — reserved, not spent.
    expect(p.reservedAmps).toBeCloseTo(2.0, 1);
    // …which parks the raise phase, inverting the old assertion: `a` does NOT
    // take the amps b is waiting on.
    expect(p.commands).not.toContainEqual({ deviceId: "a", kind: "set_level", level: 2 });
    expect(p.decisions).toContainEqual(
      expect.objectContaining({ action: "raises", blockedBy: "restore reservation" }),
    );
  });

  it("on the FIRST refusal tick (no anchor yet) it reports itself but reserves nothing", () => {
    // The shell has not stamped an anchor yet, so there is nothing to reserve
    // against — report the room so the shell stamps `now`, and let the raise
    // phase run this one tick. From the next tick the anchor stands and the
    // reservation above kicks in.
    const p = raise(shedRoom(), { smoothedAmps: 12.6, headroomAmps: 2.0, flickerMarginAmps: 0.4 });
    expect(p.flickerRefused).toEqual(["b"]);
    expect(p.reservedAmps).toBe(0);
    expect(p.commands).toContainEqual({ deviceId: "a", kind: "set_level", level: 2 });
  });

  it("admits at the bare ceiling once patience expires, and says so in the journal", () => {
    // The wobble never settled, but the room fits the line — after
    // FLICKER_PATIENCE_MS of unbroken flicker-only refusal it comes back at the
    // bare ceiling rather than sitting off forever.
    const p = raise(shedRoom(), {
      smoothedAmps: 12.6,
      headroomAmps: 2.0,
      flickerMarginAmps: 0.4,
      flickerRefusedSince: () => T - (FLICKER_PATIENCE_MS + 1_000),
    });
    expect(p.commands).toContainEqual({
      deviceId: "b",
      kind: "power_on",
      level: 1,
      reason: "restore",
      fan: 1,
    });
    // It admitted, so it is no longer refused — the shell drops the anchor.
    expect(p.flickerRefused).toEqual([]);
    expect(p.decisions).toContainEqual(
      expect.objectContaining({
        deviceId: "b",
        action: "restore @L1",
        detail: expect.stringContaining("flicker patience"),
      }),
    );
  });

  it("a refusal that fails even at the bare ceiling is a plain no-headroom skip", () => {
    // committed 13.5 + 2.0 = 15.5 clears neither the 14.9A bare ceiling nor the
    // charged one — ordinary no-headroom, so flicker patience never engages: no
    // anchor is reported and nothing is reserved.
    const p = raise(shedRoom(), { smoothedAmps: 13.5, headroomAmps: 1.1, flickerMarginAmps: 0.4 });
    expect(p.flickerRefused).toEqual([]);
    expect(p.reservedAmps).toBe(0);
    expect(p.decisions).toContainEqual(
      expect.objectContaining({ deviceId: "b", action: "restore", blockedBy: "no headroom" }),
    );
  });

  // -------------------------------------------------------------------------
  // REGRESSION (review, 2026-08-06): the charge may only ever turn an ADMISSION
  // into a skip. It may not change which REFUSAL a room gets — and both of the
  // branches below hand a cool room's whole compressor to a margin, i.e. make
  // the controller MORE aggressive in exactly the corner the charge exists to
  // make it more conservative.
  // -------------------------------------------------------------------------
  const hot = (o: Partial<AcView> = {}): AcView =>
    ac("a", { name: "hot", on: false, shed: true, needDelta: 3, rankNeedDelta: 3.0, ...o });
  const mid = (o: Partial<AcView> = {}): AcView =>
    ac("b", { name: "mid", currentLevel: 1, needDelta: 2.5, rankNeedDelta: 2.5, ...o });
  const cool = (o: Partial<AcView> = {}): AcView =>
    ac("c", { name: "cool", currentLevel: 1, needDelta: 1.5, rankNeedDelta: 1.5, ...o });

  it("a room its own BAR blocks stays bar-blocked on a wobbly line — no trade, no lost reservation", () => {
    // House 12.6A, `hot` returns at 2.0A ⇒ 14.6A, inside the 14.9A bare ceiling
    // and outside the 14.5A charged one. Its own shed left a 13.5A bar, so at
    // EVERY flicker the bar is what refuses it: reserve and wait the bar out
    // (≤ one blame window), which is what a quiet line does.
    const scene = (): AcView[] => [hot(), mid(), cool()];
    const opts = {
      smoothedAmps: 12.6,
      headroomAmps: 1.2,
      swapAllowed: true,
      shedBarAmps: (id: string) => (id === "a" ? 13.5 : 0),
    };
    const quiet = raise(scene(), opts);
    expect(quiet.swap).toBeNull();
    expect(quiet.reservedAmps).toBeGreaterThan(0);
    expect(quiet.decisions).toContainEqual(
      expect.objectContaining({ deviceId: "a", blockedBy: "own shed trough" }),
    );

    const wobbly = raise(scene(), { ...opts, flickerMarginAmps: 0.4 });
    // The flicker must not buy `cool`'s room for a restore the bar — not the
    // wobble — is holding back.
    expect(wobbly.swap).toBeNull();
    expect(wobbly.commands.every((c) => c.kind !== "power_off")).toBe(true);
    // …nor lose the bar's reservation, which is the raise phase's only defence
    // against a peer spending the trough the bar exists to disbelieve.
    expect(wobbly.reservedAmps).toBeGreaterThan(0);
    expect(wobbly.decisions).toContainEqual(
      expect.objectContaining({ deviceId: "a", blockedBy: "own shed trough" }),
    );
  });

  it("a room the PROBE would have restored on a quiet line may not arm a trade instead", () => {
    // Learned 4.0A (stale-high), steady floor price 2.0A. At 12.9A committed the
    // probe lands exactly on the 14.9A bare ceiling and misses the 14.5A charged
    // one. The bare ceiling would have RESTORED this room for free; spending a
    // cool room's compressor because the wobble refused it is the trade the
    // charge's own contract rules out.
    const book = updateCost({}, "a", "gen", "on@L1", 4, T);
    const scene = (): AcView[] => [hot(), mid(), cool({ currentLevel: 2, minLevel: 2 })];
    const opts = { smoothedAmps: 12.9, headroomAmps: 1.2, swapAllowed: true, book };
    const quiet = raise(scene(), opts);
    expect(quiet.probeRestoreIds).toEqual(["a"]);
    expect(quiet.swap).toBeNull();

    const wobbly = raise(scene(), { ...opts, flickerMarginAmps: 0.4 });
    expect(wobbly.swap).toBeNull();
    expect(wobbly.commands).toEqual([]);
    // It is now tagged as the flicker-only refusal it is (invariant 58
    // follow-up) — still no trade, but the room is reported for the shell to
    // anchor rather than skipped as out of headroom.
    expect(wobbly.decisions).toContainEqual(
      expect.objectContaining({ deviceId: "a", action: "restore", blockedBy: "flicker margin" }),
    );
    expect(wobbly.flickerRefused).toEqual(["a"]);
  });
});

// ---------------------------------------------------------------------------
// R8 — the raise and the restore have to describe the same house.
// Live 2026-08-03 17:13:36 / 17:19:03 / 17:25:31, the same shape three times in
// twelve minutes: Abdu shed, his restore refused at "floors 16.5A vs 14.9A"
// with `savingsAtFloors` reading ZERO, and in the SAME batch Najat raised
// L1→L2. A minute later the funding swap pulled that level back for Abdullah,
// the meter went over, and Abdu stayed off.
// ---------------------------------------------------------------------------
describe("a peer's in-flight raise is recoverable, so it cannot refuse a restore", () => {
  const peerRaising = (envelopeLevel: number): AcView[] => [
    // Sent L1→L2; the shadow has not confirmed, so `currentLevel` is still 1
    // while `rampDebitAmps` is already charging the jump.
    ac("a", { currentLevel: 1, envelopeLevel, needDelta: 1 }),
    ac("b", { on: false, shed: true, needDelta: 4 }),
  ];

  it("admits the restore by pulling the peer's UNCONFIRMED level back down", () => {
    // committed = 12.6 smoothed + 2.0 in flight = 14.6; the restore costs 2.0,
    // so it only fits if the peer's un-landed level counts as recoverable.
    const p = raise(peerRaising(2), { smoothedAmps: 12.6, rampDebitAmps: 2.0, headroomAmps: 0 });
    expect(p.commands).toContainEqual({ deviceId: "a", kind: "set_level", level: 1 });
    expect(p.commands).toContainEqual({ deviceId: "b", kind: "power_on", level: 1, reason: "restore", fan: 1 });
  });

  it("still refuses when the peer really is at its floor and nothing is recoverable", () => {
    // Same meter, same cost — but no level in flight, so "floors" is where the
    // house already is and the room genuinely does not fit.
    const p = raise(peerRaising(1), { smoothedAmps: 14.6, rampDebitAmps: 0, headroomAmps: 0 });
    expect(p.commands).toHaveLength(0);
    expect(p.decisions.some((d) => d.blockedBy === "no headroom")).toBe(true);
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
      flickerMarginAmps: 0,
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
      flickerMarginAmps: 0,
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
      flickerMarginAmps: 0,
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
      flickerMarginAmps: 0,
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
      flickerMarginAmps: 0,
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
      flickerMarginAmps: 0,
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
      flickerMarginAmps: 0,
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
      flickerMarginAmps: 0,
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
      flickerMarginAmps: 0,
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

  // 2026-08-05. Absorption was read per AC — `max(0, smoothed − its own
  // baseline)` — and the leftovers summed, so two rooms ramping from one
  // baseline spent the SAME whole-house rise against both debits. Live during
  // the 2026-08-04 trip-on-entry recovery: both armed at 5.05A, the meter
  // reached 10.87A, and that 5.82A of rise cancelled Abdullah's 4.1A and Abdu's
  // 4.5A independently — 8.6A of committed compressor reported fully absorbed.
  // A restore was admitted into the hole and a peer's level paid for it 40s
  // later. The comment above this function called the double-count conservative;
  // it is the trip direction. The house rose once, so it can only pay once.
  describe("shared absorption pool (2026-08-05)", () => {
    it("two ramping rooms split ONE rise — sum(jumps) − rise, not sum(jumps) − 2×rise", () => {
      const acs = [
        ac("abdu", { currentLevel: 1, ramping: true, rampBaselineAmps: 5.05 }),
        ac("najat", { currentLevel: 1, ramping: true, rampBaselineAmps: 5.05 }),
      ];
      // Committed: Abdu 4.3 + Najat 2.3 = 6.6. The meter has risen 5.82A.
      const rise = 10.87 - 5.05;
      expect(rampDebitAmps(acs, 10.87, liveCfg, "gen")).toBeCloseTo(6.6 - rise, 5);
      // The pre-fix arithmetic — each cancelling the whole rise — reported zero.
      expect(rampDebitAmps(acs, 10.87, liveCfg, "gen")).toBeGreaterThan(0);
    });

    it("a single ramping room is unchanged — the pool is its own rise", () => {
      const acs = [ac("abdu", { currentLevel: 1, ramping: true, rampBaselineAmps: 10.5 })];
      expect(rampDebitAmps(acs, 10.5, liveCfg, "gen")).toBeCloseTo(4.3, 5);
      expect(rampDebitAmps(acs, 12.5, liveCfg, "gen")).toBeCloseTo(2.3, 5);
      expect(rampDebitAmps(acs, 14.8, liveCfg, "gen")).toBe(0);
    });

    it("stays monotonic when the meter dips — a peer leaving cannot un-absorb", () => {
      // Both ratcheted 2.0A each while the meter was up; the reducer then cuts a
      // peer and the house falls BELOW both baselines. The pool is taken from
      // the per-AC ratchets, so it survives the dip exactly as invariant
      // 2026-07-27 requires — and it is still ONE pool, not two.
      const acs = [
        ac("abdu", { currentLevel: 1, ramping: true, rampBaselineAmps: 14.3, rampAbsorbedAmps: 2.0 }),
        ac("najat", { currentLevel: 1, ramping: true, rampBaselineAmps: 14.3, rampAbsorbedAmps: 2.0 }),
      ];
      const dipped = rampDebitAmps(acs, 12.8, liveCfg, "gen");
      expect(dipped).toBeCloseTo(6.6 - 2.0, 5);
      // …and it never rises as the meter falls further.
      expect(rampDebitAmps(acs, 10.0, liveCfg, "gen")).toBeCloseTo(dipped, 5);
    });

    it("a ramp whose baseline postdates part of the rise claims only its own share", () => {
      // Abdu armed at 5.0 and Najat at 8.0 — by the time Najat started, 3.0A of
      // the rise had already happened and it was not hers. At a 10.0A meter the
      // pool is 5.0 (measured from the earliest baseline) but Najat's own cap is
      // 2.0, so she may credit at most that.
      const acs = [
        ac("abdu", { currentLevel: 1, ramping: true, rampBaselineAmps: 5.0 }),
        ac("najat", { currentLevel: 1, ramping: true, rampBaselineAmps: 8.0 }),
      ];
      // Shares of the 5.0 pool: Abdu 5×4.3/6.6 = 3.257, Najat 5×2.3/6.6 = 1.742
      // — under her 2.0 cap, so nobody is clamped and the pool is fully spent.
      expect(rampDebitAmps(acs, 10.0, liveCfg, "gen")).toBeCloseTo(6.6 - 5.0, 5);
      // Push the meter to 9.0: the pool is 4.0, Najat's own cap is 1.0, and her
      // proportional share (1.394) exceeds it — so she is clamped and the
      // leftover is deliberately NOT handed to Abdu (under-crediting is safe).
      const clamped = rampDebitAmps(acs, 9.0, liveCfg, "gen");
      expect(clamped).toBeCloseTo(6.6 - (4.0 * 4.3) / 6.6 - 1.0, 5);
      expect(clamped).toBeGreaterThan(6.6 - 4.0);
    });

    it("total absorption never exceeds the rise the house actually showed", () => {
      // The property the whole fix exists to hold, over the shapes above.
      const cases: Array<[number | null, number | null, number]> = [
        [5.05, 5.05, 10.87],
        [5.0, 8.0, 10.0],
        [14.3, 14.3, 12.8],
        [null, 10.5, 12.5],
      ];
      for (const [b1, b2, smoothed] of cases) {
        const acs = [
          ac("abdu", { currentLevel: 1, ramping: true, rampBaselineAmps: b1 }),
          ac("najat", { currentLevel: 1, ramping: true, rampBaselineAmps: b2 }),
        ];
        const rise = Math.max(
          0,
          ...[b1, b2].filter((b): b is number => b != null).map((b) => smoothed - b),
        );
        expect(rampDebitAmps(acs, smoothed, liveCfg, "gen")).toBeGreaterThanOrEqual(6.6 - rise - 1e-9);
      }
    });
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
      flickerMarginAmps: 0,
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
      flickerMarginAmps: 0,
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

  it("meter-short but the freed amps close the gap: demote and raise ship in ONE batch", () => {
    // User directive 2026-08-08: switch instantly. Only 1.0A of live headroom,
    // but Najat's L3→L1 frees 4.0A — far more than Abdu's 2.5A step needs — so
    // both ship together. The off-cliff reaches the meter in seconds while
    // Abdu's compressor engages minutes later, so they never overlap on the line
    // (the committed meter already prices exactly that gap).
    const p = swap({ headroomAmps: 1.0, smoothedAmps: 13.7 });
    expect(p.commands).toEqual([
      { deviceId: "najat", kind: "set_level", level: 1 },
      { deviceId: "abdu", kind: "set_level", level: 3 },
    ]);
    expect(p.decisions.some((d) => d.action.includes("funded by peer demote"))).toBe(true);
  });

  it("meter-short and the freed amps do NOT close the gap: the demote ships ALONE", () => {
    // The demote-alone fallback survives the instant-sequencing change. Najat
    // satisfied at L2 frees only 2.0A; Abdu's L2→L3 needs 2.5A against just 0.5A
    // of headroom — 0.5 + 2.0 − 0.5 margin < 2.5, so the trade cannot close the
    // gap this batch. The demote still ships (a satisfied level is not comfort)
    // and the raise follows once the meter has really fallen.
    const p = swap({
      acs: [ac("najat", { currentLevel: 2, needDelta: 0.3 }), ac("abdu", { currentLevel: 2, needDelta: 1.9 })],
      headroomAmps: 0.5,
      smoothedAmps: 14.2,
    });
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
      flickerMarginAmps: 0,
      limitAmps: 15,
      calmMs: 60_000,
      config: liveCfg,
      book: {},
      source: "gen",
      now: T,
      pacing: initialPacingState("gen"),
      ...overrides,
    });

  it("meter-short but the demote closes the gap: donor step and raise ship in ONE batch", () => {
    // Abdu's 2.5A step vs 1.9A available — deficit 0.6A, Najat's step frees 2.0A,
    // closing it with margin. User directive 2026-08-08: ship instantly rather
    // than wait a calm window for the saving to land.
    const p = rebal();
    expect(p.commands).toEqual([
      { deviceId: "najat", kind: "set_level", level: 1 },
      { deviceId: "abdu", kind: "set_level", level: 2 },
    ]);
    expect(p.cutAmps).toBeCloseTo(2.0, 5);
    expect(p.decisions.some((d) => d.action.includes("funded by peer demote"))).toBe(true);
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

  it("one step per swap — a donor two levels up still gives only one (now same-batch)", () => {
    // Najat at L3 gives exactly ONE level (L3→L2, never straight to L1), and
    // Abdu's raise now ships in the same batch once that one step closes the gap.
    const p = rebal({
      acs: [ac("najat", { currentLevel: 3, needDelta: 0.8 }), ac("abdu", { currentLevel: 1, needDelta: 2.4 })],
      headroomAmps: 1.0,
      smoothedAmps: 13.6,
    });
    expect(p.commands).toEqual([
      { deviceId: "najat", kind: "set_level", level: 2 },
      { deviceId: "abdu", kind: "set_level", level: 2 },
    ]);
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
      flickerMarginAmps: 0,
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

// ---------------------------------------------------------------------------
// The gated proactive shed (the swap) — un-parked 2026-08-06 on the user's own
// ask after the 02:21–02:49 heater episode: "after Najat on and be stable,
// there was enough budget to turn off Najat and bring Abdu back on."
// ---------------------------------------------------------------------------

describe("gated proactive shed: swapping a cool room's amps to a hot one", () => {
  // Ids stay a/b/c/d so the declared base-2/step-2 models apply (⇒ L1 = 2A,
  // L2 = 4A, L3 = 6A); the NAMES are what the journal prints.
  const swapCfg: LevelingConfigV2 = {
    ...cfg,
    ampModels: { ...cfg.ampModels, d: { baseAmps: 2, stepAmps: 2 } },
  };
  //  - `hot`  is the shed room we want back (rank 3.0), restore cost 2A at L1.
  //  - `cool` is the donor: running at ITS FLOOR (so no floor-down is available
  //    and `atFloors` cannot rescue the restore), 1.5°C milder than `hot`.
  //  - `mid`  keeps a second room running, so the donor is never the last one.
  const hot = (o: Partial<AcView> = {}): AcView =>
    ac("a", { name: "hot", on: false, shed: true, needDelta: 3, rankNeedDelta: 3.0, roomTempC: 28.0, ...o });
  const mid = (o: Partial<AcView> = {}): AcView =>
    ac("b", { name: "mid", currentLevel: 1, needDelta: 2.5, rankNeedDelta: 2.5, roomTempC: 27.0, ...o });
  const cool = (o: Partial<AcView> = {}): AcView =>
    ac("c", { name: "cool", currentLevel: 1, needDelta: 1.5, rankNeedDelta: 1.5, roomTempC: 26.5, ...o });
  const swapScene = (donorOverrides: Partial<AcView> = {}): AcView[] => [
    hot(),
    mid(),
    cool(donorOverrides),
  ];
  // 13.5 committed: `hot` needs 2A and the ceiling is 14.9, so plain (15.5A)
  // and at-floors (both peers already at their floor ⇒ nothing to give) both
  // refuse. Switching `cool` off frees 2A ⇒ 13.5 − 2 + 2 = 13.5, a full amp
  // inside the 0.5A funding margin.
  const swapRaise = (acs: AcView[], overrides: Partial<RaiseInput> = {}) =>
    raise(acs, {
      config: swapCfg,
      smoothedAmps: 13.5,
      headroomAmps: 1.2,
      swapAllowed: true,
      ...overrides,
    });

  it("sheds the coolest eligible donor and restores the receiver in ONE batch", () => {
    const p = swapRaise(swapScene());
    // User directive 2026-08-08: instant sequencing. The donor's off and the
    // receiver's gentle restore ship TOGETHER — the off-cliff reaches the meter
    // in seconds while the receiver's compressor engages minutes later, so they
    // never overlap on the line (the committed meter already prices the gap).
    expect(p.commands).toEqual([
      { deviceId: "c", kind: "power_off", reason: "shed" },
      { deviceId: "a", kind: "power_on", level: 1, reason: "restore", fan: 1 },
    ]);
    expect(p.swap).toEqual({ donorId: "c", receiverId: "a" });
    // It carries a power_on, so it wants the turn-on grade window.
    expect(p.isTurnOn).toBe(true);
    // The receiver is a restore ATTEMPT like any other (probe re-arm anchor).
    expect(p.attempts).toContainEqual(expect.objectContaining({ deviceId: "a", kind: "restore" }));
    // Admitted at the PLAIN price — never probe-priced (invariant 3/57), so its
    // recorded fan hold stays gentle=false.
    expect(p.probeRestoreIds).toEqual([]);
    // Belt reservation stands while the send is in flight.
    expect(p.reservedAmps).toBeGreaterThan(0);
    // The donor gave a whole room — invariant 30's cooldown applies to it.
    expect(p.fundingDonors).toEqual(["c"]);
    // The donor's freed draw is priced for the collapse detector at the model
    // steady draw (invariant 11); the receiver's power_on contributes 0.
    expect(p.cutAmps).toBeCloseTo(2, 5);
  });

  it("NEVER ships a donor's off without the receiver's on in the same batch", () => {
    // The whole point of the one-batch contract: no stranded-donor window. Any
    // proactive `power_off` this path emits is paired with the receiver's on.
    const p = swapRaise(swapScene());
    expect(p.commands.some((c) => c.kind === "power_off" && c.deviceId === "c")).toBe(true);
    expect(p.commands.some((c) => c.kind === "power_on" && c.deviceId === "a")).toBe(true);
    // …and a trade that cannot close the gap ships NOTHING — never a lone donor
    // off (14.5 committed: freeing 2A and spending 2A stays over the ceiling once
    // the 0.5A funding margin is charged).
    const refused = swapRaise(swapScene(), { smoothedAmps: 14.5, headroomAmps: 0.2 });
    expect(refused.commands).toEqual([]);
    expect(refused.swap).toBeNull();
  });

  it("journals the trade loudly, naming both rooms and both thermometers", () => {
    const d = swapRaise(swapScene()).decisions.find((x) => x.action === "proactive shed");
    expect(d?.deviceId).toBe("c");
    expect(d?.detail).toContain("cool → hot");
    expect(d?.detail).toContain("1.5°C real");
    expect(d?.detail).toContain("room 26.5°C");
    expect(d?.detail).toContain("3.0°C real");
    expect(d?.detail).toContain("room 28.0°C");
  });

  it("picks the COOLEST eligible donor, not the biggest saving", () => {
    // `mid` would free 4A at its L2 floor and `cool` only 2A — but 2A is
    // enough, and the thermometer decides who loses their room (2026-08-04).
    const p = swapRaise([
      hot(),
      mid({ currentLevel: 2, minLevel: 2, needDelta: 1.9, rankNeedDelta: 1.9 }),
      cool(),
    ]);
    expect(p.swap).toEqual({ donorId: "c", receiverId: "a" });
  });

  it("does NOT fire when the donor is inside the need gap (26.0 vs 25.3 rooms)", () => {
    // 0.7°C apart — the rebalance gap, deliberately NOT enough to take a whole
    // room away. Nothing happens; the shed room waits for honest headroom.
    const p = swapRaise([
      hot(),
      mid({ needDelta: 2.8, rankNeedDelta: 2.8 }),
      cool({ needDelta: 2.3, rankNeedDelta: 2.3 }),
    ]);
    expect(p.commands).toEqual([]);
    expect(p.swap).toBeNull();
    expect(p.decisions).toContainEqual(
      expect.objectContaining({ deviceId: "a", blockedBy: "no headroom" }),
    );
  });

  it("never touches a PINNED donor (manual wins), in either form", () => {
    expect(swapRaise(swapScene({ manualTarget: 1 })).swap).toBeNull();
    expect(swapRaise(swapScene({ manualCap: 1 })).swap).toBeNull();
  });

  it("never touches a RAMPING donor — its amps are not knowable yet", () => {
    expect(swapRaise(swapScene({ ramping: true })).swap).toBeNull();
  });

  it("never touches a donor serving a funding or victim cooldown", () => {
    expect(swapRaise(swapScene(), { fundingCooldown: (id) => id === "c" }).swap).toBeNull();
    expect(swapRaise(swapScene(), { victimCooldown: (id) => id === "c" }).swap).toBeNull();
  });

  it("never leaves the house with nothing running", () => {
    // Only `cool` is on. A swap re-arranges cooling; it may not empty the house
    // on the way through.
    const p = swapRaise([hot(), cool()]);
    expect(p.swap).toBeNull();
    expect(p.commands).toEqual([]);
  });

  it("refuses a trade that does not actually CLOSE the gap", () => {
    // 14.5 committed: freeing 2A and spending 2A leaves 14.5, and the 0.5A
    // funding margin puts it over the 14.9 ceiling. Spending a room's comfort
    // on a restore that would still be refused is the worst of both.
    const p = swapRaise(swapScene(), { smoothedAmps: 14.5, headroomAmps: 0.2 });
    expect(p.swap).toBeNull();
  });

  it("refuses a trade the PHYSICS ENVELOPE rejects even when the meter allows it", () => {
    // `mid` sits at its L3 boost floor (6A) and `hot` returns at 2A ⇒ an 8A
    // end-state against a 7.8A ceiling, while the meter (5.0A) says yes.
    const p = swapRaise([hot(), mid({ currentLevel: 3, minLevel: 3 }), cool()], {
      limitAmps: 7.9,
      smoothedAmps: 5.0,
      headroomAmps: 2.6,
    });
    expect(p.swap).toBeNull();
    expect(p.decisions).toContainEqual(
      expect.objectContaining({ deviceId: "a", blockedBy: "physics envelope" }),
    );
  });

  it("stands down entirely when the caller has not allowed it (the situational gate)", () => {
    expect(swapRaise(swapScene(), { swapAllowed: false }).swap).toBeNull();
    // …and the default is OFF: a caller that never thought about it never
    // trades a room away.
    expect(
      raise(swapScene(), { config: swapCfg, smoothedAmps: 13.5, headroomAmps: 1.2 }).swap,
    ).toBeNull();
  });

  it("waits for the same calm the restore it funds must clear", () => {
    expect(swapRaise(swapScene(), { calmMs: 1_000 }).swap).toBeNull();
  });

  it("allows only ONE swap in flight house-wide", () => {
    const p = swapRaise(swapScene(), { swapInFlight: { donorId: "x", receiverId: "y" } });
    expect(p.swap).toBeNull();
    expect(p.commands).toEqual([]);
  });

  it("only the HOTTEST shed room may buy itself back", () => {
    // `hotter` heads the queue and is waiting out a restore backoff, so no swap
    // may be armed FOR it (shedding a room to fund a restore that cannot ship
    // is pure loss). `hot` is second in the queue and must not reach for a
    // donor on its own behalf either: the gap that makes a trade honest is
    // measured from the top of the queue, and trading rooms sideways is not
    // what the user asked for. Both refusals, one scene.
    let pacing = initialPacingState("gen");
    pacing = noteAttempt(pacing, "d", "restore", T - 1_000);
    pacing = noteFailure(pacing, "d", "restore", T - 1_000);
    const p = swapRaise(
      [ac("d", { name: "hotter", on: false, shed: true, needDelta: 5, rankNeedDelta: 5.0 }), hot(), mid(), cool()],
      { pacing },
    );
    expect(p.swap).toBeNull();
    expect(p.commands).toEqual([]);
    expect(p.decisions).toContainEqual(
      expect.objectContaining({ deviceId: "a", action: "restore", blockedBy: "no headroom" }),
    );
  });

  it("RESERVES the receiver's amps across later ticks while the trade lands", () => {
    // The donor is already off; the meter has not shown the saving yet, so the
    // restore still does not fit. Nothing else may spend those amps.
    const p = swapRaise([hot(), mid(), cool({ on: false, shed: true })], {
      swapInFlight: { donorId: "c", receiverId: "a" },
    });
    expect(p.commands).toEqual([]);
    expect(p.reservedAmps).toBeCloseTo(2, 5);
    expect(p.decisions).toContainEqual(
      expect.objectContaining({ deviceId: "a", blockedBy: "swap landing" }),
    );
    // The raise phase is parked behind the reservation.
    expect(p.decisions).toContainEqual(
      expect.objectContaining({ action: "raises", blockedBy: "restore reservation" }),
    );
  });

  it("bars the DONOR from taking its donation back and RESERVES for the live trade", () => {
    // `cool` is shed and is the cheapest thing on the board — but it was
    // switched off to fund `hot`, which is still waiting for the saving to
    // reach the meter. Its amps are reserved, not spent (invariant 30, one rung
    // down).
    const p = swapRaise([hot(), cool({ on: false, shed: true }), mid()], {
      fundingCooldown: (id) => id === "c",
      swapInFlight: { donorId: "c", receiverId: "a" },
    });
    expect(p.commands).toEqual([]);
    expect(p.decisions).toContainEqual(
      expect.objectContaining({ deviceId: "c", blockedBy: "donation cooldown" }),
    );
    expect(p.reservedAmps).toBeGreaterThan(0);
  });

  it("REGRESSION 2026-08-06 (review): a LEVEL-funding donor's shed must not park the house", () => {
    // Same predicate, different donation. `cool` gave up a LEVEL to fund a peer
    // (invariant 30 proper) and was then shed for an unrelated overload — no
    // trade is waiting on its amps. It is still barred from restoring, but a
    // reservation would park the raise phase AND the fan restore house-wide for
    // two minutes over a claim nobody made: `mid` may still take its step.
    const p = swapRaise([cool({ on: false, shed: true }), mid()], {
      smoothedAmps: 8.0,
      headroomAmps: 6.7,
      fundingCooldown: (id) => id === "c",
      swapInFlight: null,
    });
    expect(p.decisions).toContainEqual(
      expect.objectContaining({ deviceId: "c", blockedBy: "donation cooldown" }),
    );
    // The bar holds — the donor itself is not restored…
    expect(p.commands.some((c) => c.deviceId === "c")).toBe(false);
    // …and nothing is held back from everyone else.
    expect(p.reservedAmps).toBe(0);
    expect(p.decisions).not.toContainEqual(
      expect.objectContaining({ action: "raises", blockedBy: "restore reservation" }),
    );
  });
});

describe("swapDonorFor: the gap constants must outrank each other (2026-07-31 lesson)", () => {
  it("a whole ROOM costs at least what a LEVEL costs", () => {
    // A swap takes a room away; a rebalance takes one level. The bar for the
    // bigger loss may never be the lower one.
    expect(SWAP_NEED_GAP_C).toBeGreaterThan(REBALANCE_NEED_GAP_C);
    // …and it IS the shed-side gap, the user's own calibration — not a copy of
    // its current value that could drift away from it.
    expect(SWAP_NEED_GAP_C).toBe(SHED_NEED_GAP_C);
  });

  it("the ladder's quiet window outlasts the credit that hides an episode", () => {
    // Every other swap gate reads the CURRENT tick, and the last of them to go
    // quiet is the commanded-cut credit — which the meter can absorb in well
    // under a minute. A quiet window shorter than the credit's own life would
    // let a trade fire inside an episode nothing else remembers.
    expect(SWAP_QUIET_AFTER_OVER_MS).toBeGreaterThanOrEqual(PENDING_CUT_MS);
  });

  it("the reverse trade needs the rooms to genuinely CROSS (anti-oscillation)", () => {
    const donor = ac("c", { currentLevel: 1, rankNeedDelta: 1.5 });
    const receiver = ac("a", { on: false, shed: true, rankNeedDelta: 3.0 });
    const bystander = ac("b", { rankNeedDelta: 2.5 });
    const args = {
      receiverCostAmps: 2,
      committedAmps: 13.5,
      ceilingAmps: 14.9,
      donorSavingsAmps: () => 2,
      envelopeAfter: null,
      blocked: () => false,
    };
    // Forward: the hot room may take the cool room's amps.
    expect(
      swapDonorFor({ ...args, receiver, running: [donor, bystander] })?.donor.deviceId,
    ).toBe("c");
    // Reverse, with the rooms as they stand right after the trade: the ex-donor
    // is 1.5°C cooler, so it needs ~2 × the gap of real thermometer movement to
    // win the room back. Noise cannot do it.
    expect(
      swapDonorFor({
        ...args,
        receiver: { ...donor, on: false, shed: true },
        running: [{ ...receiver, on: true, shed: false }, bystander],
      }),
    ).toBeNull();
    // Only once they have actually crossed by the full gap does it flip.
    expect(
      swapDonorFor({
        ...args,
        receiver: { ...donor, on: false, shed: true, rankNeedDelta: 3.6 },
        running: [
          { ...receiver, on: true, shed: false, rankNeedDelta: 2.5 },
          { ...bystander, rankNeedDelta: 2.9 },
        ],
      })?.donor.deviceId,
    ).toBe("a");
  });

  it("a donor a human just switched on is not traded away (#9224/#9228 2026-08-06)", () => {
    // The leveler shed the priority-#1 room; a household member turned it back
    // on; the swap re-selected THAT room as donor and shed it again. "Manual
    // wins" (invariant 42) covers the power button for the comfort tool — the
    // swap is a comfort optimisation, never an emergency, so it may not un-do a
    // human's explicit ON (invariant 57). An ordinary overload shed still can.
    //
    // Two eligible donors, both clear of the 1.0°C gap below the hot receiver:
    // `c` (coolest) and `b`. Without the shield the swap takes the coolest, `c`.
    const receiver = ac("recv", { on: false, shed: true, rankNeedDelta: 3.5 });
    const cool = ac("c", { rankNeedDelta: 1.5 });
    const warm = ac("b", { rankNeedDelta: 2.0 });
    const args = {
      receiver,
      receiverCostAmps: 2,
      committedAmps: 13.5,
      ceilingAmps: 14.9,
      donorSavingsAmps: () => 2,
      envelopeAfter: null,
      blocked: () => false,
    };
    // Baseline: the coolest running room is the donor (this is the "pin" that
    // the shield removes — field false selects exactly as before).
    expect(swapDonorFor({ ...args, running: [cool, warm] })?.donor.deviceId).toBe("c");
    // Mark the coolest room as freshly switched on by a human: the swap must
    // SKIP it and fall through to the next eligible donor.
    expect(
      swapDonorFor({
        ...args,
        running: [{ ...cool, recentlyExternalOn: true }, warm],
      })?.donor.deviceId,
    ).toBe("b");
    // And when it is the ONLY eligible donor, the swap arms nobody rather than
    // trading away the room a human just asked for.
    expect(
      swapDonorFor({ ...args, running: [{ ...cool, recentlyExternalOn: true }] }),
    ).toBeNull();
  });
});

// 2026-08-31 FUNDED SPEND. `spendableCreditAmps` is budget an off/demote/manual
// level-down has already freed that the meter has not shown yet. It reaches this
// planner in exactly two places: subtracted ONCE from the committed meter, and
// added ONCE to the raise phase's budget. It waives exactly one gate, the
// calm window, for a candidate whose whole cost it covers with
// REBALANCE_FUND_MARGIN_AMPS to spare.
describe("funded spend (2026-08-31)", () => {
  const shedRoom = (): AcView[] => [ac("a", { needDelta: 2 }), ac("b", { on: false, shed: true, needDelta: 4 })];

  it("a shed restore is judged on the meter the off is taking us to", () => {
    // 13.4A committed leaves no room for b's 2A return under the 14.9A ceiling.
    const refused = raise(shedRoom(), { headroomAmps: 1.3, smoothedAmps: 13.4 });
    expect(refused.commands).toEqual([]);
    // A 3A off is in flight: the same tick, the same meter, and now it fits.
    const funded = raise(shedRoom(), {
      headroomAmps: 1.3,
      smoothedAmps: 13.4,
      spendableCreditAmps: 3,
      cutAnchorAmps: 13.4,
      commandedCutAmps: 3,
    });
    expect(funded.commands).toEqual([
      { deviceId: "b", kind: "power_on", level: 1, reason: "restore", fan: 1 },
    ]);
    expect(funded.decisions.find((d) => d.deviceId === "b")?.detail).toContain("funded by in-flight cut");
  });

  it("…and never below `landingAmps`, so the room's own trough is still disbelieved", () => {
    // Invariant 41/54: the subtraction converges to the predicted post-cut meter
    // and `max()` cannot go under it, so a credit cannot buy a room back into
    // the hole its OWN shed dug. Anchor 16.0 less a 3A cut lands at 13.0; b's 2A
    // return would be 15.0, over the 14.9 ceiling.
    const p = raise(shedRoom(), {
      headroomAmps: 4.8,
      smoothedAmps: 9.9, // the trough: her draw gone, the survivors mid-cycle
      spendableCreditAmps: 3,
      cutAnchorAmps: 16.0,
      commandedCutAmps: 3,
    });
    expect(p.commands.filter((c) => c.kind === "power_on")).toEqual([]);
    expect(p.decisions.find((d) => d.deviceId === "b")?.blockedBy).toBe("no headroom");
  });

  it("waives the restore calm window for the candidate the credit covers", () => {
    const gated = raise(shedRoom(), { calmMs: 0 });
    expect(gated.commands).toEqual([]);
    expect(gated.decisions.find((d) => d.deviceId === "b")?.blockedBy).toBe("calm");
    const funded = raise(shedRoom(), {
      calmMs: 0,
      spendableCreditAmps: 3,
      cutAnchorAmps: 12.1,
      commandedCutAmps: 3,
    });
    expect(funded.commands.map((c) => c.kind)).toEqual(["power_on"]);
  });

  it("does NOT waive the calm window when the credit falls short of cost + margin", () => {
    // 2A restore against a 2.4A credit: 2.4 − 0.5 < 2.0, so this is an ordinary
    // calm-gated candidate and it reserves its amps like any other.
    const p = raise(shedRoom(), {
      calmMs: 0,
      spendableCreditAmps: 2.4,
      cutAnchorAmps: 12.1,
      commandedCutAmps: 2.4,
    });
    expect(p.commands).toEqual([]);
    expect(p.decisions.find((d) => d.deviceId === "b")?.blockedBy).toBe("calm");
    expect(p.reservedAmps).toBeGreaterThan(0);
  });

  it("a level raise spends the credit ONCE, not once per candidate", () => {
    // Two rooms, each a 2A step, and a 3A credit on a meter with no room of its
    // own. The first takes it; the second must not take it again.
    const two = [ac("a", { needDelta: 4 }), ac("b", { needDelta: 3 })];
    const p = raise(two, {
      headroomAmps: 0,
      smoothedAmps: 14.7,
      source: "grid", // gen ships one raise per batch anyway; grid is the honest test
      limitAmps: 27,
      spendableCreditAmps: 3,
      cutAnchorAmps: 14.7,
      commandedCutAmps: 3,
    });
    expect(p.commands).toEqual([{ deviceId: "a", kind: "set_level", level: 2 }]);
  });

  it("waives the raise calm window, and says so in the journal", () => {
    const gated = raise([ac("a", { needDelta: 4 })], { calmMs: 0 });
    expect(gated.decisions.find((d) => d.deviceId === "a")?.blockedBy).toBe("calm");
    const funded = raise([ac("a", { needDelta: 4 })], {
      calmMs: 0,
      spendableCreditAmps: 3,
      cutAnchorAmps: 12.1,
      commandedCutAmps: 3,
    });
    expect(funded.commands).toEqual([{ deviceId: "a", kind: "set_level", level: 2 }]);
    expect(funded.decisions.find((d) => d.deviceId === "a")?.detail).toContain("funded by in-flight cut");
  });

  it("the physics envelope still vetoes a funded raise (invariant 16 is the safety net)", () => {
    // Two rooms at L3 model 6A each on a 15A gen: the end-state is over the cap
    // ceiling whatever the meter or the credit says.
    const p = raise([ac("a", { currentLevel: 2, needDelta: 4 }), ac("b", { currentLevel: 3 })], {
      calmMs: 0,
      headroomAmps: 0,
      smoothedAmps: 14.7,
      spendableCreditAmps: 5,
      cutAnchorAmps: 14.7,
      commandedCutAmps: 5,
      nonAcAmps: 4,
    });
    expect(p.commands).toEqual([]);
    expect(p.decisions.some((d) => d.blockedBy === "physics envelope")).toBe(true);
  });

  it("fundedOnly (the SETTLING lane) ships ONLY what the credit covers", () => {
    // A wide-open budget and a fully calm line: the ordinary lane raises, the
    // funded lane refuses unless the credit itself pays for the step.
    const wide = { headroomAmps: 6, smoothedAmps: 8.7 } as const;
    expect(raise([ac("a", { needDelta: 4 })], wide).commands).toHaveLength(1);
    const blocked = raise([ac("a", { needDelta: 4 })], { ...wide, fundedOnly: true });
    expect(blocked.commands).toEqual([]);
    expect(blocked.decisions.find((d) => d.deviceId === "a")?.blockedBy).toBe("settle window");
    const funded = raise([ac("a", { needDelta: 4 })], {
      ...wide,
      fundedOnly: true,
      spendableCreditAmps: 3,
      cutAnchorAmps: 8.7,
      commandedCutAmps: 3,
    });
    expect(funded.commands).toEqual([{ deviceId: "a", kind: "set_level", level: 2 }]);
  });

  it("fundedOnly blocks an unfunded shed restore with the settle window, not the meter", () => {
    const wide = { headroomAmps: 6, smoothedAmps: 8.7, fundedOnly: true } as const;
    const p = raise(shedRoom(), wide);
    expect(p.commands).toEqual([]);
    expect(p.decisions.find((d) => d.deviceId === "b")?.blockedBy).toBe("settle window");
  });

  it("fundedOnly plans NO funding demote: the lane spends a credit, it does not make one", () => {
    // Independent review, 2026-08-31: the envelope-blocked trade (invariant 69)
    // runs BEFORE the lane's own guard and `continue`s past it, so a demote+raise
    // could ship inside a settle window, the lane's contract violated by the one
    // branch that plans a second cut.
    //
    // `a` is hot and wants L2 (2A); the meter has nothing (headroom 0) and the
    // credit covers only 1A, so the step is NOT funded. `b` is satisfied at L2
    // and would happily hand its level over.
    const hot = ac("a", { currentLevel: 1, needDelta: 6, rankNeedDelta: 6 });
    const satisfied = ac("b", { currentLevel: 2, needDelta: 0.1, rankNeedDelta: 0.1 });
    const tight = {
      headroomAmps: 0,
      smoothedAmps: 14.7,
      spendableCreditAmps: 1,
      cutAnchorAmps: 14.7,
      commandedCutAmps: 1,
    } as const;
    // Outside the lane the trade is exactly as it was: the peer is demoted.
    const trading = raise([hot, satisfied], tight);
    expect(trading.commands.some((c) => c.kind === "set_level" && c.deviceId === "b")).toBe(true);
    // Inside it, NOTHING ships.
    const lane = raise([hot, satisfied], { ...tight, fundedOnly: true });
    expect(lane.commands).toEqual([]);
    expect(lane.fundingDonors).toEqual([]);
    expect(lane.decisions.find((d) => d.deviceId === "a")?.blockedBy).toBe("settle window");
  });

  it("the floor-recovery YIELD sees the credit too, so a needier stranded room still outranks a restore", () => {
    // Independent review, 2026-08-31: `floorRecoveryFits` read the bare meter
    // while the restore admission read the credit-adjusted one, so a funded
    // budget could buy back a LESS needy shed room while a room stranded below
    // its active comfort floor (invariant 36) went on waiting: the yield test
    // and the admission asking two different questions about one house.
    //
    // `s` sits at L1 under an active L2 floor and is the needier room; `b` is
    // shed and milder. No visible headroom, 3A of freed-but-unmetered credit.
    const stranded = ac("s", { currentLevel: 1, minLevel: 2, needDelta: 6, rankNeedDelta: 6 });
    const milderShed = ac("b", { on: false, shed: true, needDelta: 3, rankNeedDelta: 3 });
    const p = raise([stranded, milderShed], {
      headroomAmps: 0,
      smoothedAmps: 14.7,
      spendableCreditAmps: 3,
      cutAnchorAmps: 14.7,
      commandedCutAmps: 3,
    });
    // The restore yields and reserves NOTHING, so the raise phase can buy the
    // floor back, the same ordering an unfunded house would have taken.
    expect(p.commands.some((c) => c.kind === "power_on")).toBe(false);
    expect(p.decisions.find((d) => d.deviceId === "b")?.blockedBy).toBe("floor recovery");
    expect(p.reservedAmps).toBe(0);
  });
});
